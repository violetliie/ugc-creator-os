"""Cron entrypoint. Render runs these via scheduled jobs.

Usage:
  python -m worker.cron_runner [morning|evening|daily|manual]
    morning  = view refresh + fetch + match (07:15 UTC cron)
    evening  = same                          (19:15 UTC cron)
    daily    = same + snapshot-lock check    (23:00 UTC cron)
    manual   = same as morning/evening, kind='manual' for sync_runs row
               (used by Round 13 fix A in worker/main.py /sync endpoint
               to run the pipeline in an isolated subprocess off the
               long-lived FastAPI parent)

We can also support `python -m worker.cron_runner` (no arg) -> daily.
"""
from __future__ import annotations
import sys
import logging
from .scheduler import run_pipeline


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")
log = logging.getLogger("cron")


def main():
    arg = (sys.argv[1] if len(sys.argv) > 1 else "daily").lower()

    # ROUND 15 follow-up (2026-05-21): clear any sync_runs left 'running' from
    # a previous worker incarnation killed by Render redeploy / SIGKILL.
    # Runs BEFORE run_pipeline inserts this run's row, so it never races with
    # this process's own state. See scheduler.clear_stale_running_runs.
    try:
        from .scheduler import clear_stale_running_runs
        result = clear_stale_running_runs(threshold_minutes=3)
        if result.get("cleared_runs", 0) > 0:
            log.info("Startup cleanup: cleared %s stale sync_runs + %s creator_runs",
                     result["cleared_runs"], result["cleared_creator_runs"])
    except Exception as e:
        log.warning("Startup cleanup failed (continuing): %s", e)

    if arg in ("morning", "evening"):
        result = run_pipeline(kind="cron", lock_check=False)
    elif arg in ("daily", "snapshot"):
        result = run_pipeline(kind="snapshot", lock_check=True)
    elif arg == "manual":
        # Round 13 fix A: /sync endpoint in worker/main.py spawns us with
        # 'manual' so the pipeline runs in a separate process from the
        # FastAPI parent. Same code path as cron, just tagged kind='manual'
        # on the sync_runs row.
        result = run_pipeline(kind="manual", lock_check=False)
    else:
        log.error("Unknown arg: %s", arg)
        sys.exit(2)
    log.info("Pipeline result: %s", result)


if __name__ == "__main__":
    main()
