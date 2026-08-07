"""FastAPI entrypoint for the Render worker.

Endpoints:
  GET  /health        liveness probe
  POST /sync          run full pipeline (auth: x-worker-secret)
  POST /recalc        trigger payout recalc for unpaid groups (auth: x-worker-secret)

The cron jobs (07:15 UTC, 19:15 UTC, 23:00 UTC) are wired by render.yaml to
invoke `python -m worker.cron_runner <kind>`. They share the same pipeline.
"""
from __future__ import annotations
import asyncio
import logging
import os
import subprocess
import sys
from datetime import datetime
from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from . import config
from .scheduler import run_pipeline
from .matcher import match_all_creators
from .cycles import utcnow, utcnow_iso
from .db import get_db


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")
log = logging.getLogger("worker")

app = FastAPI(title="UGC CreatorOS Worker", version="0.1.0")


@app.on_event("startup")
def _startup_cleanup() -> None:
    """Round 15 follow-up: on FastAPI boot, clear any sync_runs left 'running'.

    Render's auto-deploy SIGKILLs the previous container before starting the
    new one, which leaves any in-flight sync_run row stuck at status='running'.
    The dashboard's SWR poll then keeps showing "Syncing" until the 60-min
    API-route watchdog catches it. We catch it within seconds of boot instead.

    See `worker/scheduler.py::clear_stale_running_runs` for the 3-min threshold
    rationale (long enough to never race with a just-started sync from THIS
    process, short enough for fast self-heal after a deploy).
    """
    try:
        from .scheduler import clear_stale_running_runs
        result = clear_stale_running_runs(threshold_minutes=3)
        if result.get("cleared_runs", 0) > 0:
            log.info("Startup cleanup: cleared %s stale sync_runs + %s creator_runs",
                     result["cleared_runs"], result["cleared_creator_runs"])
    except Exception as e:
        # Never block startup on cleanup failure.
        log.warning("Startup cleanup failed (continuing): %s", e)


def _auth(x_worker_secret: str | None) -> None:
    if not x_worker_secret or x_worker_secret != config.WORKER_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health():
    return {"ok": True, "ts": utcnow_iso()}


@app.post("/sync")
def sync(
    x_worker_secret: str | None = Header(default=None),
):
    """Trigger a manual pipeline run.

    Round 13 (2026-05-21): spawn the pipeline in a fully separate process
    (via `python -m worker.cron_runner manual`) instead of running it
    inline as a FastAPI BackgroundTask. Rationale:

    Pre-Round-13, /sync ran `run_pipeline()` inside the FastAPI worker
    process. Each sync allocated DB query response buffers, candidate
    dicts, paid_cycles caches, etc. Round 11 isolated each creator's
    work in a subprocess, but the PARENT FastAPI process still held
    cumulative state across syncs. Over days of running with daily crons
    + manual syncs, the parent's RSS would climb monotonically from
    Python allocator fragmentation, eventually hitting Render's memory
    cap (regardless of plan size).

    Now /sync just forks `cron_runner manual` and returns. The cron_runner
    subprocess does the full pipeline (which internally spawns its own
    per-creator subprocesses), exits when done, and the OS reclaims ALL
    pipeline memory. FastAPI parent stays at ~30 MB forever.

    Side effect: we don't directly observe the cron_runner's progress
    here — the frontend already polls `sync_runs` for status, so this is
    fine. If the subprocess can't start (PYTHONPATH broken, etc.) the
    spawn raises and we return 500.
    """
    _auth(x_worker_secret)

    # ROUND 22 (2026-06-10): concurrency guard at the spawn point. Don't fork a
    # pipeline subprocess if one is already running — repeated Sync clicks (and
    # creator-edit auto-syncs) during the June 10 stuck window forked 7
    # overlapping pipelines that raced on the matcher and scrambled data.
    # run_pipeline ALSO guards itself (authoritative, covers cron jobs too);
    # this just avoids spawning a doomed subprocess for the common case.
    try:
        from datetime import datetime, timedelta
        db = get_db()
        active_cutoff = (utcnow() - timedelta(minutes=60)).isoformat()
        active = (db.table("sync_runs").select("id")
                  .eq("status", "running")
                  .gte("started_at", active_cutoff)
                  .limit(1).execute().data or [])
        if active:
            log.info("/sync: a sync (%s) is already running; not spawning another", active[0]["id"])
            return JSONResponse({"ok": True, "queued": False, "alreadyRunning": True})
    except Exception as e:
        # Never block a sync on the guard check failing; fall through to spawn.
        log.warning("/sync concurrency pre-check failed (continuing): %s", e)

    cmd = [sys.executable, "-m", "worker.cron_runner", "manual"]
    log.info("Forking pipeline subprocess: %s", " ".join(cmd))
    try:
        # Popen returns immediately. The cron_runner subprocess runs
        # independently and writes its sync_runs / creator_runs rows.
        # Stdout/stderr inherit the parent's fds → Render captures them
        # in the worker service's log stream.
        # start_new_session=True detaches the child from the parent's
        # process group, so a parent restart (or a /sync request handler
        # finishing) doesn't kill the child mid-run.
        subprocess.Popen(
            cmd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            start_new_session=True,
        )
    except Exception as e:
        log.exception("Failed to spawn pipeline subprocess")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    return JSONResponse({"ok": True, "queued": True})


@app.post("/recalc")
def recalc(
    x_worker_secret: str | None = Header(default=None),
    arm: str | None = None,
):
    """Recalculate payouts for unpaid video_groups (e.g., after a tier amount edit)."""
    _auth(x_worker_secret)
    db = get_db()
    tiers = db.table("payment_structure").select("*").execute().data or []
    creators = db.table("creators").select("id, arm").is_("deleted_at", "null").execute().data or []
    if arm:
        creators = [c for c in creators if c["arm"] == arm]

    updated = 0
    for c in creators:
        groups = db.table("video_groups").select(
            "id, cycle_id, highest_views, cross_posted, payable"
        ).eq("creator_id", c["id"]).execute().data or []
        # Skip groups in paid cycles
        cycle_ids = list({g["cycle_id"] for g in groups})
        if not cycle_ids:
            continue
        cycles = db.table("payment_cycles").select("id, marked_paid_at").in_("id", cycle_ids).execute().data or []
        paid = {x["id"] for x in cycles if x["marked_paid_at"]}
        for g in groups:
            if g["cycle_id"] in paid:
                continue
            from .payout import group_payout
            new_payout = group_payout(g["highest_views"], c["arm"], tiers, g["cross_posted"], g["payable"])
            db.table("video_groups").update({"payout": new_payout, "last_updated_at": utcnow_iso()}) \
                .eq("id", g["id"]).execute()
            updated += 1
    return {"ok": True, "groups_updated": updated, "arm": arm or "all"}
