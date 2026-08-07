"""Centralized configuration for the worker. Reads from env vars only.

All secrets come from Render env vars (production) or .env.local (local dev).
Never hardcode secrets here.
"""
from __future__ import annotations
import os
from dotenv import load_dotenv

# Allow local dev to load .env.local from the repo root
_repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(_repo_root, ".env.local"))


def _required(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise RuntimeError(f"Required env var {key} is not set")
    return v


# Supabase
SUPABASE_URL = _required("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = _required("SUPABASE_SERVICE_ROLE_KEY")

# Shortimize
SHORTIMIZE_API_KEY = _required("SHORTIMIZE_API_KEY")
SHORTIMIZE_BASE_URL = os.environ.get("SHORTIMIZE_BASE_URL", "https://api.shortimize.com")

# Worker bridge
WORKER_SECRET = _required("WORKER_SECRET")

# Cron timing
CRON_HOUR_1_UTC = int(os.environ.get("CRON_HOUR_1_UTC", "7"))
CRON_HOUR_2_UTC = int(os.environ.get("CRON_HOUR_2_UTC", "19"))
CRON_HOUR_DAILY_ET = int(os.environ.get("CRON_HOUR_DAILY_ET", "18"))

# ----------------------------------------------------------------------
# Cover-frame extraction (Round 8: cover-based across all 3 platforms).
# All values are seconds for httpx timeouts. UAs default to a real Safari.
# ----------------------------------------------------------------------

# Instagram: og:image scrape with facebookexternalhit UA. See worker/og_image.py.
IG_OG_IMAGE_TIMEOUT = float(os.environ.get("IG_OG_IMAGE_TIMEOUT", "10.0"))
# Optional residential proxy for IG only. Format: "http://user:pass@host:port".
# Leave unset to use Render's IP. Mostly a future-proof escape hatch.
IG_PROXY_URL = (os.environ.get("IG_PROXY_URL", "") or "").strip() or None

# TikTok: oEmbed -> thumbnail_url. See worker/tiktok_cover.py.
TT_OEMBED_TIMEOUT = float(os.environ.get("TT_OEMBED_TIMEOUT", "15.0"))
TT_PROXY_URL = (os.environ.get("TT_PROXY_URL", "") or "").strip() or None

# YouTube: i.ytimg cover + HTML duration. See worker/youtube_cover.py.
YT_THUMBNAIL_TIMEOUT = float(os.environ.get("YT_THUMBNAIL_TIMEOUT", "10.0"))
YT_DURATION_TIMEOUT = float(os.environ.get("YT_DURATION_TIMEOUT", "15.0"))
YT_USER_AGENT = os.environ.get(
    "YT_USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
)

# Facebook Reels (Round 21): same Meta og:image link-preview mechanism as
# Instagram (facebookexternalhit UA -> og:image -> fbcdn JPEG -> phash).
# worker/facebook_cover.py delegates to the shared og_image core with these
# FB-specific timeout/proxy knobs. Verified: FB reel pages serve og:image at
# ~10KB offset and FB cover phash matches the same video's TT/IG/YT cover at
# Tier 1 (hamming <= 20), so no relaxed threshold is needed.
FB_OG_IMAGE_TIMEOUT = float(os.environ.get("FB_OG_IMAGE_TIMEOUT", "10.0"))
# Optional residential proxy for FB only (future-proof escape hatch, like IG).
FB_PROXY_URL = (os.environ.get("FB_PROXY_URL", "") or "").strip() or None

# Constants
RATE_LIMIT_DELAY_SEC = 2.1
MAX_RETRIES = 3
REQUEST_TIMEOUT = 60.0
# Round 8 patch (2026-05-08): bumped 10 → 16 → 20 after empirical verification
# (user visually confirmed each pair).
#
# Same-video TT-IG cover pairs span d=2-20 with cover-based extraction
# (vs the tighter 0-10 the earlier empirical data suggested for yt-dlp+ffmpeg
# frame 0). Confirmed same-video distances:
#   Creator A Apr 30 12s clip:                            TT-IG d=12
#   Creator A Apr 30 18s clip:                            TT-IG d=12
#   Creator A Apr 30 8s clip:                             TT-IG d=20
#   Creator B Apr 22 29s pair:                              TT-IG d=16
#                                                        IG-YT d=14
# Confirmed DIFFERENT-video distance (correctly rejected):
#   Creator A Apr 30 8s YT (random unrelated YT short):     YT-anything d=30
#
# Threshold 20 catches all confirmed same-video pairs while still rejecting
# the d=30+ different-video floor with a 10-bit safety margin. Plus the
# constraints (same creator + same date +/-10 day + length +/-2s) are strong
# enough that false matches at d=21-30 are extremely rare in practice.
#
# Known unmatchable case: when YT picks a vastly different cover frame than
# TT/IG (mid-video saliency-pick), pairs land at d=30+ even though same video.
# Example: Creator A's 12s clip had YT at d=32-38 from TT/IG. These need
# manual force-link admin UI (Round 9 candidate); phash alone can't bridge.
PHASH_HAMMING_THRESHOLD = 20
# Kept for now in case we want to differentiate YT-side later; currently
# equal to the global threshold so matcher.can_pair behavior is uniform.
PHASH_HAMMING_THRESHOLD_YT = 20
# Round 8 patch (2026-05-08): bumped from 1 to 2 because YT Shorts often
# re-encode with +/-1-2s drift from the TT/IG source. Example:
#   Creator A Apr 30 12s "comment what i should trade on" → YT version is 14s
# Strict +/-1s misses the YT side. Relaxing to +/-2s catches it.
# False-positive risk: low; same creator + same date + same phash within 20
# already strongly identifies the pair.
LENGTH_TOLERANCE_SEC = 2
MATCH_WINDOW_DAYS = 10

# Round 9 (2026-05-08): tiered matcher for d=20-28 borderline cases.
# Round 10 (2026-05-10): threshold lowered 0.5->0.30 after verification scan
# across the full DB (252 candidate pairs analyzed). Cap STAYS at 28 — see
# rationale below.
#
# Empirical observation: cross-platform covers can be picked from frames
# 1-2 seconds apart in the same video, producing phash distances of 20-28
# even though they're the same content. We saw this with a creator's Apr 23
# Spiderman trio: TT-IG d=24 (covers ~1s apart), TT-YT d=8, IG-YT d=16.
# Creator C PSG-bayern TT-IG: d=28 sim=0.31.
#
# Phash alone above d=20 is ambiguous: same-video-different-frame and
# different-video-similar-structure both land in d=20-30+. To disambiguate
# without false positives, Tier 2 requires SUPPORTING EVIDENCE:
#   - phash 20 < d <= PHASH_HAMMING_THRESHOLD_TIER2 (28)
#   - length within +/-LENGTH_TOLERANCE_TIER2 (1s, stricter than tier 1)
#   - title similarity (Jaccard on >=3-char tokens, YT-suffix-stripped)
#     >= TITLE_SIMILARITY_THRESHOLD (0.30)
#   - posted on the same calendar day in ET
#
# Why cap stays at 28 (not 32):
#   - d=30+ is the empirical "different video" floor per the earlier calibration.
#   - Lowering sim 0.5->0.30 already gives more flexibility; adding cap
#     relaxation on top is double-loosening with overlapping risk.
#   - Same-video pairs at d=30-32 (a few Creator A YT cross-posts where the
#     YT cover frame diverges more) are real but rare; they get matched
#     via the admin Link Post UI (Round 10 feature) one click at a time
#     instead of widening the automatic-match band.
#
# Threshold 0.30 verification (Round 10):
# Verified safe across all 252 candidate Tier 2 pairs in the DB.
#   - All 127 sim=0.00 pairs: confirmed-different topics (sports/cricket).
#   - All 39 sim=0.01-0.09 pairs: confirmed-different.
#   - 17 of 17 in sim=0.10-0.19: confirmed-different (incl. Creator C bayern-cricket).
#   - 21 of 21 in sim=0.20-0.29: confirmed-different (sports commentary
#     sharing hashtags but different actual content).
#   - 1 of 3 in sim=0.30-0.39: ambiguous (Creator D May 6 one-word titles,
#     remediable via admin Link Post UI).
#   - 2 of 3 in sim=0.30-0.39: same-video (Creator C PSG-bayern @0.308 rounded
#     to 0.31; Creator D Apr 21 three-clip batch @0.38).
#   - 2 of 2 in sim=0.40-0.49: confirmed same-video.
# Threshold 0.31 would miss Creator C PSG-bayern at 0.308 (0.308 < 0.31), so
# 0.30 is the correct anchor.
PHASH_HAMMING_THRESHOLD_TIER2 = 28
LENGTH_TOLERANCE_TIER2 = 1
TITLE_SIMILARITY_THRESHOLD = 0.30

# Round 10 (2026-05-10): Tier 1 date proximity gate.
# Pre-Round-10, Tier 1 had no date check (only the broad +/-MATCH_WINDOW_DAYS).
# Empirically 343 of 756 Tier 1 candidate pairs across the DB were >=2 days
# apart, virtually all false positives (different videos with coincidentally
# similar phash for greenscreen-format creators). +/-1 day captures realistic
# cross-post timing (0-1 day batch posts) and rejects the 9-day-gap false
# positives like Creator C's bayern TT being grouped with cricket IG/YT.
TIER1_MAX_DAY_DIFF = 1
