"""YouTube cover-frame extractor via i.ytimg.com Shorts cover URL pattern.

Also exposes `fetch_duration` to override Shortimize's bogus 60s for all YT
Shorts (Shortimize reports `video_length=60` for every Short regardless of
real duration; this blocks the matcher's +/- 1s length filter from ever
allowing YT to cross-post-pair with TT/IG).

Round 8 (2026-05-08): replaces the legacy yt-dlp + ffmpeg path for YouTube.
yt-dlp can extract YT metadata (it works fine for that) but full video
download is increasingly blocked by YT's SABR streaming. We don't need the
video file at all -- the public Shorts cover at i.ytimg.com is exactly the
9:16 frame we want to phash.

URL pattern (verified in safety audit):
  GET https://i.ytimg.com/vi/<videoId>/oardefault.jpg
  -> 720x1280 9:16 JPEG, the canonical Shorts cover

Why this is anti-detection-clean:
  - i.ytimg.com is a static image CDN. These URLs are hit by every device
    that views a Short, every embedded player, every link-preview crawler.
    YT cannot rate-limit them without breaking embeds globally.
  - No UA, no cookies, no scraping. One HTTP GET.
  - Verified in safety audit: HTTP 200 with public `cache-control: max-age=7200`,
    no Set-Cookie, no anti-bot tokens (no cf-ray, no x-amz-cf-id, etc.).

Duration extraction:
  - We scrape the public YT page HTML for `<meta itemprop="duration"
    content="PT0M11S">`. ISO 8601 duration string. No yt-dlp dependency.
  - Cheap: one HTTP GET to the Shorts page, regex parse, done.
"""
from __future__ import annotations
import io
import logging
import re
from typing import Optional

import httpx
from PIL import Image
import imagehash

from . import config
from ._http_retry import get_with_retry

log = logging.getLogger(__name__)


# Public CDN URL pattern. YouTube serves three Shorts cover candidates:
#   /oardefault.jpg  - YT's algorithmic "best" cover
#   /oar1.jpg        - alternate cover #1
#   /oar2.jpg        - alternate cover #2
#
# Empirical observation (2026-05-08): the "best" variant varies per video.
# Different videos have different YT-side picks; no single variant wins:
#   same-video pair C:      oar1 d=14 from TT  (oardefault was d=28 ✗)
#   same-video pair A: oardefault d=8 from IG  (oar1 was d=32 ✗)
#   same-video pair B:      oardefault d=6 from IG  (oar1 was d=20)
#
# Solution: extract ALL 3 variants and return them as comma-separated phashes.
# `frame_extractor.hamming_distance` handles multi-candidate phashes by
# computing min distance across all pairwise combinations. The matcher's
# can_pair then sees the BEST distance across all YT cover candidates.
_THUMBNAIL_VARIANTS = ("oardefault", "oar1", "oar2")
_THUMBNAIL_URL_TEMPLATE = "https://i.ytimg.com/vi/{video_id}/{variant}.jpg"

# Match YT video IDs in the canonical short URL forms we receive from Shortimize:
#   https://www.youtube.com/shorts/<id>
#   https://www.youtube.com/watch?v=<id>
#   https://www.youtube.com/embed/<id>
#   https://www.youtube.com/v/<id>
#   https://youtu.be/<id>
_VIDEO_ID_RE = re.compile(
    r"(?:youtu\.be/|/(?:shorts|embed|v)/|[?&]v=)([\w-]{6,32})"
)

# Match the duration meta tag YT serves on Shorts pages
_DURATION_META_RE = re.compile(
    r'<meta\s+itemprop="duration"\s+content="([^"]+)"',
    re.IGNORECASE,
)

# ISO 8601 duration: PT11S, PT0M11S, PT1H2M3S, etc.
_ISO_DURATION_RE = re.compile(
    r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$"
)


def _video_id(yt_url: str) -> Optional[str]:
    """Extract the YT video ID from any standard YT URL form. Returns None if absent."""
    if not yt_url:
        return None
    m = _VIDEO_ID_RE.search(yt_url)
    return m.group(1) if m else None


def _parse_iso8601_duration(s: str) -> Optional[int]:
    """Parse an ISO 8601 duration string -> total seconds. Returns None on bad input."""
    m = _ISO_DURATION_RE.match(s.strip())
    if not m:
        return None
    h, mi, sec = m.groups()
    total = 0
    if h:
        total += int(h) * 3600
    if mi:
        total += int(mi) * 60
    if sec:
        total += int(float(sec))  # truncate fractional seconds
    return total or None


def extract_phash_via_thumbnail(ad_link: str) -> Optional[str]:
    """Resolve a YT URL -> all 3 i.ytimg Shorts cover candidates -> phashes.

    Returns a comma-separated string of phash hex values (one per successful
    variant), e.g. "abc123def456,fae22e85abcc04a7,c0d17f6ba895c26a". The
    `frame_extractor.hamming_distance` helper splits on commas and computes
    the MIN distance across all candidate pairs, so the matcher uses the
    best-matching variant for each comparison.

    Returns the hex of whichever variant succeeded if only some did. Returns
    None if all 3 failed. matcher.can_pair() treats None as "no phash" and
    the pair drops to length-only fallback.

    No UA, no cookies, no page scrape. Three HTTP GETs to the public image
    CDN (cheap, ~50KB each, well-cached).
    """
    vid_id = _video_id(ad_link)
    if not vid_id:
        log.info("YT phash: could not extract video id from %s", ad_link)
        return None

    timeout = config.YT_THUMBNAIL_TIMEOUT
    phashes: list[str] = []

    for variant in _THUMBNAIL_VARIANTS:
        url = _THUMBNAIL_URL_TEMPLATE.format(video_id=vid_id, variant=variant)
        # Round 9 (2026-05-08): retry on transient network errors. Without this,
        # a single connection blip during the matcher burst left ~11.7% of YT
        # videos with NULL phash because all 3 variants must succeed for any
        # phash to be returned. Two retries with exponential backoff (0.5s, 1.0s)
        # drops empirical NULL rate to <1%.
        with httpx.Client(verify=False, timeout=timeout) as c:
            r = get_with_retry(c, url, label=f"YT cover {variant}")

        if r is None:
            continue
        if r.status_code != 200 or not r.content:
            log.info("YT thumbnail %s got %d for %s", variant, r.status_code, url)
            continue

        try:
            with Image.open(io.BytesIO(r.content)) as img:
                phashes.append(str(imagehash.phash(img)))
        except Exception as e:
            log.warning("YT thumbnail %s decode failed for %s: %s", variant, url, e)
            continue

    if not phashes:
        return None
    # Comma-separated; frame_extractor.hamming_distance handles this format.
    return ",".join(phashes)


def fetch_duration(ad_link: str) -> Optional[int]:
    """Get the real Shorts duration in seconds via HTML meta tag scrape.

    Round 8: replaces Shortimize's bogus `video_length=60` for YT.
    Returns int seconds, or None if we couldn't determine it (caller
    should then fall back to whatever Shortimize reported).

    Uses a regular browser UA to avoid bot-stripped pages.
    """
    if not ad_link:
        return None

    timeout = config.YT_DURATION_TIMEOUT
    ua = config.YT_USER_AGENT

    # Round 9: retry on transient network errors so a single timeout doesn't
    # leave a YT video stuck at Shortimize's bogus 60s value.
    with httpx.Client(
        verify=False, follow_redirects=True, timeout=timeout
    ) as c:
        r = get_with_retry(c, ad_link, headers={"User-Agent": ua}, label="YT duration")

    if r is None:
        return None
    if r.status_code != 200:
        log.info("YT duration page got %d for %s", r.status_code, ad_link)
        return None

    m = _DURATION_META_RE.search(r.text)
    if not m:
        log.info("YT duration: no <meta itemprop='duration'> in HTML for %s", ad_link)
        return None

    iso = m.group(1)
    seconds = _parse_iso8601_duration(iso)
    if seconds is None:
        log.info("YT duration: could not parse %r for %s", iso, ad_link)
        return None
    return seconds
