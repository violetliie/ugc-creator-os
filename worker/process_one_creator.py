"""Per-creator subprocess entrypoint (Round 11 memory isolation).

Each creator is processed in its own Python subprocess so the OS reclaims
ALL heap memory back to the system when the subprocess exits. This solves
the slow allocator-watermark growth that caused OOMs at ~42 creators even
on a 2GB Render plan: Python's allocator does not actually return memory
to the OS even after `gc.collect()` releases references, so a long-running
sync over 49 creators accumulates allocator state in the process's RSS
until something gets killed.

With this entrypoint:
  - scheduler.run_pipeline iterates creators
  - For each one, spawns `python -m worker.process_one_creator <id> <run_id>`
  - Each subprocess: ~70 MB Python interp + ~50 MB working set = ~120 MB peak
  - Subprocess exits, OS reclaims everything, next creator starts fresh
  - Hard upper bound on memory ~150 MB regardless of creator count

Usage:
  python -m worker.process_one_creator <creator_id> <creator_run_id>

Exit codes:
  0  success - creator_runs row already updated to 'done' by THIS process
  1  caught exception - creator_runs row already updated to 'failed' by THIS process
  2  bad args / missing creator or creator_run row - no DB write made
  Killed by signal (returncode <0 in parent's view, including -9 = SIGKILL
  from OOM-killer) - this process never reached its except handler, so
  the PARENT process must update the creator_runs row to 'failed' on its end.

Stderr: prints concise progress + error info for Render log capture.
Stdout: nothing (avoid buffering large output in the parent's stderr capture).
"""
from __future__ import annotations
import os
import sys
import traceback
from datetime import datetime

# Allow running via `python -m worker.process_one_creator` from repo root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Honor .env.local during local dev. On Render the env is injected directly.
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python -m worker.process_one_creator <creator_id> <creator_run_id>",
              file=sys.stderr)
        return 2

    creator_id = sys.argv[1]
    creator_run_id = sys.argv[2]

    # Lazy imports so the help/argv-validation path stays fast and we surface
    # any module-import errors as a normal exception (logged + creator_runs
    # update via the except branch).
    from worker.db import get_db
    from worker.scheduler import fetch_creator_videos
    from worker.cycles import utcnow_iso
    from worker import matcher

    db = get_db()

    # Sanity-check that the creator_runs row exists. If not, exit 2 without
    # modifying anything; the parent likely passed a stale id.
    #
    # Note: supabase-py's `.maybe_single()` raises APIError(code='204') when
    # no row matches instead of returning data=None. Use `.limit(1).execute()`
    # and check the data list directly to avoid that quirk.
    cr_row = (db.table("creator_runs")
              .select("id")
              .eq("id", creator_run_id)
              .limit(1)
              .execute())
    if not cr_row.data or len(cr_row.data) == 0:
        print(f"creator_runs row {creator_run_id} not found", file=sys.stderr)
        return 2

    creator_resp = (db.table("creators")
                    .select("id, name, arm, tiktok_handle, instagram_handle, youtube_handle, facebook_handle")
                    .eq("id", creator_id)
                    .limit(1)
                    .execute())
    if not creator_resp.data or len(creator_resp.data) == 0:
        print(f"creator {creator_id} not found", file=sys.stderr)
        # Mark the run as failed so the parent doesn't loop on this id.
        try:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": utcnow_iso(),
                "error_message": f"creator {creator_id} not found in DB",
            }).eq("id", creator_run_id).execute()
        except Exception as db_err:
            print(f"  (also failed to update creator_runs: {db_err})", file=sys.stderr)
        return 2
    creator = creator_resp.data[0]

    # Mark as running with this subprocess's own timestamp. Parent already
    # set 'pending' when it inserted the row.
    started = utcnow_iso()
    db.table("creator_runs").update({
        "status": "running",
        "started_at": started,
    }).eq("id", creator_run_id).execute()

    print(f"START creator={creator['name']} ({creator_id[:8]})", file=sys.stderr)

    # Tiers are looked up once per subprocess - cheap and lets matcher
    # compute payouts without re-querying inside its loop.
    tiers = db.table("payment_structure").select("*").execute().data or []

    stats = {"videos_fetched": 0, "groups_created": 0, "groups_updated": 0}
    try:
        stats["videos_fetched"] = fetch_creator_videos(creator)
        m = matcher.match_for_creator(creator_id, tiers, creator["arm"])
        stats["groups_created"] = m.get("groups_created", 0)
        stats["groups_updated"] = m.get("groups_updated", 0)

        db.table("creator_runs").update({
            "status": "done",
            "completed_at": utcnow_iso(),
            "videos_fetched": stats["videos_fetched"],
            "groups_created": stats["groups_created"],
            "groups_updated": stats["groups_updated"],
        }).eq("id", creator_run_id).execute()

        print(
            f"DONE {creator['name']}: videos={stats['videos_fetched']} "
            f"groups_created={stats['groups_created']} "
            f"groups_updated={stats['groups_updated']}",
            file=sys.stderr,
        )
        return 0
    except Exception as e:
        # ANY caught exception (Python-level) gets logged + persisted.
        # OS-level deaths (SIGKILL from OOM, etc.) do NOT reach this branch -
        # the parent's subprocess.run() detects negative returncode and
        # updates the row instead.
        tb = traceback.format_exc()
        # Render captures stderr; print just enough for diagnostics.
        print(f"FAIL {creator['name']}: {type(e).__name__}: {e}", file=sys.stderr)
        # Send full traceback too so we have the failure site.
        print(tb, file=sys.stderr)
        try:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": utcnow_iso(),
                "videos_fetched": stats["videos_fetched"],
                "groups_created": stats["groups_created"],
                "groups_updated": stats["groups_updated"],
                # Persist a short error blurb. Cap length so a runaway error
                # message can't blow up the row.
                "error_message": f"{type(e).__name__}: {str(e)[:1800]}",
            }).eq("id", creator_run_id).execute()
        except Exception as db_err:
            print(f"FAIL (also DB update failed): {db_err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
