"""Instagram cover-frame extractor via public Reel og:image meta tag.

Round 7 (2026-05-08): Instagram's bot-detection began flagging the
session-cookie + yt-dlp pipeline that was used through Round 6. Personal IG
accounts started getting "automated behavior" warnings, which over time
escalates to temp restrictions and permanent disable. This module replaces
the IG side of that pipeline with a no-cookie, no-login, no-yt-dlp flow:

  1. HTTP GET the public Reel/post URL with `facebookexternalhit/1.1`,
     Facebook's official link-preview crawler. Instagram MUST serve `og:*`
     meta tags for this UA so that pasting an IG link into Slack, iMessage,
     Twitter, etc. produces a preview card. Blocking this UA would break
     link previews across the entire internet, so it stays open.
  2. Parse the HTML for `<meta property="og:image" content="...">`. That URL
     points at the IG-served cover JPEG (which is frame 0 for auto-covers,
     or the creator-uploaded custom cover). For most reels it's frame 0,
     producing a phash within hamming-10 of the TikTok first frame extracted
     via yt-dlp. Custom covers are a known edge case: they fall through to
     single-platform groups, same as any other phash mismatch.
  3. Download the JPEG, compute `imagehash.phash`, return as hex string.

This produces a hex string compatible with `frame_extractor.hamming_distance`
and `imagehash.hex_to_hash` so `matcher.py` doesn't need any changes.

Round 21 (2026-06-07): Facebook Reels reuse this exact mechanism. FB is also
Meta, serves og:image to facebookexternalhit at the same ~10KB offset, and its
cover JPEG phashes match the same video's TT/IG/YT cover at Tier 1. So
`extract_phash_via_og` now takes optional timeout/proxy/label overrides;
`worker/facebook_cover.py` calls it with the FB_* config knobs. Defaults are
unchanged, so the Instagram path behaves identically to pre-Round-21.

Failure modes (all return None, matching the legacy yt-dlp contract):
  - 4xx/5xx from the Reel page (login wall, takedown, rate limit)
  - HTML present but no og:image meta (private/removed reel, IG schema change)
  - og:image URL fetch fails or returns non-image
  - PIL can't decode the bytes
"""
from __future__ import annotations
import html
import io
import logging
import re
import time
from typing import Optional

import httpx
from PIL import Image
import imagehash

from . import config
from ._http_retry import get_with_retry

log = logging.getLogger(__name__)


# Retry policy mirrors _http_retry's default. Two retries + initial = three
# total attempts with backoff 0.5s, 1.0s. Streaming GET cannot easily share
# get_with_retry so we inline a tiny retry loop below.
_STREAM_RETRIES = 2
_STREAM_BACKOFF_BASE = 0.5
_STREAM_RETRYABLE_STATUSES = {429, 500, 502, 503, 504}


# Facebook's link-preview crawler UA. IG serves og:* meta tags for this so
# Facebook/Slack/iMessage can render link previews. Treat as the primary path.
_PRIMARY_UA = (
    "facebookexternalhit/1.1 "
    "(+http://www.facebook.com/externalhit_uatext.php)"
)

# Backup UAs in case IG ever narrows facebookexternalhit access.
_FALLBACK_UAS = [
    # Twitter's link-preview crawler
    "Mozilla/5.0 (compatible; Twitterbot/1.0)",
    # Plain desktop Safari, last resort: looks like a human pasting a link
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/16.0 Safari/605.1.15",
]

_UAS = [_PRIMARY_UA, *_FALLBACK_UAS]


# og:image is preferred. og:video:thumbnail_url is a backup some Reels emit
# in addition. Both point at IG-CDN-hosted JPEGs of the cover frame.
_RE_OG_IMAGE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_RE_OG_VIDEO_THUMB = re.compile(
    r'<meta[^>]+property=["\']og:video:thumbnail_url["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)


def extract_phash_via_og(
    reel_url: str,
    *,
    timeout: float | None = None,
    proxy: str | None = None,
    label: str = "IG",
) -> Optional[str]:
    """Resolve a Meta (Instagram/Facebook) URL → cover JPEG → imagehash.phash hex.

    Returns the 16-char hex hash compatible with `imagehash.hex_to_hash`,
    or None on any failure. Callers treat None the same as the legacy
    yt-dlp failure case (matcher falls back to length-only, then to
    single-platform if length also doesn't match).

    No cookies. No login. No video download. One HTTP GET to the public
    Reel/Reel-video page (which Meta serves to link-preview crawlers), then a
    second GET for the cover JPEG.

    Round 21: `timeout`/`proxy` default to the Instagram config knobs when not
    supplied (preserving the pre-Round-21 IG behavior exactly). Facebook passes
    its own FB_* values via worker/facebook_cover.py. `label` only affects log
    lines so IG vs FB extractions are distinguishable in Render logs.
    """
    if not reel_url:
        return None

    timeout = timeout if timeout is not None else config.IG_OG_IMAGE_TIMEOUT
    proxy = proxy if proxy is not None else config.IG_PROXY_URL  # None -> Render IP

    client_kwargs: dict = {
        "timeout": timeout,
        "verify": False,           # mirror shortimize.py for Cloudflare friendliness
        "follow_redirects": True,  # IG often 301s share-URLs to canonical /reel/<sc>/
    }
    if proxy:
        client_kwargs["proxy"] = proxy

    last_status: Optional[int] = None
    for ua in _UAS:
        ua_label = _ua_short(ua)

        # --- Step 1: stream-fetch the Reel page HTML, search incrementally ---
        # Round 8 (2026-05-08): IG Reel pages are ~880KB but the og:image
        # meta tag lives in the first ~10KB of <head>. Reading the full page
        # holds ~858KB per video in Python's heap until GC; for 134 IG videos
        # that's ~112MB peak, enough to OOM Render's 512MB starter plan. We
        # stream the response in 16KB chunks, search after each chunk, and
        # close the connection the moment og:image is found. Typical memory
        # usage drops from 880KB to <30KB per video.
        #
        # Round 9 (2026-05-08): retry the streaming page fetch on transient
        # errors (network blips, 429 rate limits, 5xx). Without retry, a
        # single connection hiccup during the matcher burst left some IG
        # videos with NULL phash forever. Three total attempts with 0.5s/1s
        # backoff drops empirical NULL rate near zero.
        cover_url: Optional[str] = None
        buf = ""
        for attempt in range(_STREAM_RETRIES + 1):
            cover_url = None
            buf = ""
            try:
                with httpx.Client(**client_kwargs) as c:
                    with c.stream("GET", reel_url, headers={"User-Agent": ua}) as page:
                        last_status = page.status_code
                        if page.status_code in _STREAM_RETRYABLE_STATUSES:
                            if attempt < _STREAM_RETRIES:
                                sleep_s = _STREAM_BACKOFF_BASE * (2 ** attempt)
                                log.info(
                                    "og:image got %d, retry %d/%d for %s (UA=%s, sleep %.1fs)",
                                    page.status_code, attempt + 1, _STREAM_RETRIES,
                                    reel_url, ua_label, sleep_s,
                                )
                                time.sleep(sleep_s)
                                continue
                            log.warning("og:image got %d after retries for %s (UA=%s)",
                                        page.status_code, reel_url, ua_label)
                            break
                        if page.status_code == 403:
                            # Hard block on this UA; don't retry, try next UA
                            log.warning("og:image got 403 for %s (UA=%s)",
                                        reel_url, ua_label)
                            break
                        if page.status_code != 200:
                            log.info("og:image got %d for %s (UA=%s)",
                                     page.status_code, reel_url, ua_label)
                            break
                        # Cap the total bytes we accept to ~256KB. og:image lives
                        # in the first 10-20KB; if it's not there by 256KB, the
                        # page is something else (login wall, schema change).
                        max_bytes = 256 * 1024
                        for chunk in page.iter_text(chunk_size=16 * 1024):
                            buf += chunk
                            cover_url = _extract_cover_url(buf)
                            if cover_url is not None:
                                break  # connection closes via context manager
                            if len(buf) >= max_bytes:
                                break
                        break  # successful 200, exit retry loop
            except (httpx.RequestError, httpx.TimeoutException) as e:
                if attempt < _STREAM_RETRIES:
                    sleep_s = _STREAM_BACKOFF_BASE * (2 ** attempt)
                    log.info(
                        "og:image network error, retry %d/%d for %s (UA=%s, sleep %.1fs): %s",
                        attempt + 1, _STREAM_RETRIES, reel_url, ua_label, sleep_s, e,
                    )
                    time.sleep(sleep_s)
                    continue
                log.info("og:image page fetch error after retries for %s (UA=%s): %s",
                         reel_url, ua_label, e)
                break
            finally:
                buf = ""  # release the buffer immediately

        if not cover_url:
            log.info("og:image: no og:image meta found in first 256KB for %s (UA=%s)",
                     reel_url, ua_label)
            continue

        # --- Step 2: fetch the cover JPEG (with retry helper) ---
        with httpx.Client(**client_kwargs) as c:
            img_resp = get_with_retry(
                c, cover_url, headers={"User-Agent": ua}, label=f"{label} cover"
            )
        if img_resp is None:
            continue
        if img_resp.status_code != 200 or not img_resp.content:
            log.info("og:image cover got %d for %s",
                     img_resp.status_code, cover_url)
            continue

        # --- Step 3: decode + hash ---
        try:
            with Image.open(io.BytesIO(img_resp.content)) as img:
                phash = imagehash.phash(img)
            return str(phash)  # 16-char hex, same shape as yt-dlp path returns
        except Exception as e:
            log.warning("og:image phash decode failed for %s: %s", cover_url, e)
            continue

    if last_status is not None:
        log.info("og:image: all %d UAs exhausted for %s (last status=%s)",
                 len(_UAS), reel_url, last_status)
    return None


def _extract_cover_url(page_html: str) -> Optional[str]:
    """Pull og:image (preferred) or og:video:thumbnail_url from a Reel page."""
    m = _RE_OG_IMAGE.search(page_html)
    if not m:
        m = _RE_OG_VIDEO_THUMB.search(page_html)
    if not m:
        return None
    return html.unescape(m.group(1))


def _ua_short(ua: str) -> str:
    """Trimmed UA tag for log lines (avoids dumping the full UA string)."""
    return ua.split("/", 1)[0]
