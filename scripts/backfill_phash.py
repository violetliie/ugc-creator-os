"""Backfill currently-NULL phashes using the new retry-enabled extractors.

Round 9 (2026-05-08): one-off script to clean up stale NULL phashes left
by transient HTTP failures during pre-Round-9 syncs (when extractors had
no retry logic). Run AFTER deploying the Round 9 worker code.

Usage (from repo root):
  python -m scripts.backfill_phash

What it does:
  1. SELECT all videos where phash IS NULL AND not (private OR removed).
  2. For each, call frame_extractor.extract_phash(ad_link, platform) which
     now uses the retry-enabled cover extractors.
  3. UPDATE videos SET phash = <hex> WHERE id = X for each success.
  4. Print a per-platform success/failure summary at the end.

Idempotent: safe to run multiple times. Only touches NULL rows; never
overwrites an existing phash. Does NOT trigger matcher (so no group
churn). After backfill, run a regular /sync to rebuild groups with
the freshly-filled phashes.
"""
from __future__ import annotations
import os
import sys
import time
from collections import defaultdict

# Allow running both as `python -m scripts.backfill_phash` and as a script
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env.local"))

from supabase import create_client  # noqa: E402
from worker import frame_extractor as fe  # noqa: E402


def main() -> int:
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("Missing Supabase env vars", file=sys.stderr)
        return 2

    db = create_client(url, key)

    res = db.table("videos").select(
        "id, platform, ad_link, posted_date, video_length, latest_views, "
        "private, removed, phash"
    ).is_("phash", "null").execute()
    rows = res.data or []
    if not rows:
        print("No NULL-phash videos. Nothing to do.")
        return 0

    workable = [v for v in rows if not v.get("private") and not v.get("removed")]
    print(f"Found {len(rows)} NULL-phash videos ({len(workable)} workable, "
          f"{len(rows) - len(workable)} private/removed skipped)")

    summary: dict[str, dict[str, int]] = defaultdict(lambda: {"ok": 0, "fail": 0})
    started = time.monotonic()

    for i, v in enumerate(workable, 1):
        plat = v["platform"]
        try:
            phash = fe.extract_phash(v["ad_link"], plat)
        except Exception as e:
            print(f"  [{i}/{len(workable)}] {plat:<10} FAIL exception: {e}")
            summary[plat]["fail"] += 1
            continue

        if not phash:
            print(f"  [{i}/{len(workable)}] {plat:<10} FAIL no phash returned: {v['ad_link']}")
            summary[plat]["fail"] += 1
            continue

        try:
            db.table("videos").update({"phash": phash}).eq("id", v["id"]).execute()
            summary[plat]["ok"] += 1
            print(f"  [{i}/{len(workable)}] {plat:<10} OK   {phash[:24]:<25} {v['ad_link']}")
        except Exception as e:
            print(f"  [{i}/{len(workable)}] {plat:<10} FAIL db update: {e}")
            summary[plat]["fail"] += 1

    elapsed = time.monotonic() - started
    print(f"\nDone in {elapsed:.1f}s")
    print("Per-platform summary:")
    for plat, s in summary.items():
        total = s["ok"] + s["fail"]
        rate = (100.0 * s["ok"] / total) if total else 0
        print(f"  {plat:<10}: {s['ok']}/{total} succeeded ({rate:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
