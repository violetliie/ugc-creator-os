"""TikTok cover-frame extractor via the public oEmbed endpoint.

Round 8 (2026-05-08): replaces the legacy yt-dlp + ffmpeg path for TikTok.
TikTok's recent yt-dlp extractor requires `curl-cffi` browser impersonation
because TT now serves a stripped 6KB page to bot UAs. The oEmbed endpoint
sidesteps this entirely:

  GET https://www.tiktok.com/oembed?url=<TT_URL>
  -> returns JSON with `thumbnail_url` pointing at p16-sign-sg.tiktokcdn.com
     under the `tplv-tiktokx-origin.image` template (clean cover, no play
     button overlay, 720x1280 vertical)

Why this is anti-detection-clean:
  - oEmbed is a published spec (https://oembed.com), designed for embed
    previews. Slack, Twitter, Discord, FB all hit this same endpoint when
    you paste a TT link. TikTok cannot block it without breaking embeds
    across the entire web.
  - No User-Agent spoofing, no page scraping, no JSON parsing of internal
    page state, no cookies. Just two HTTP GETs (one to oembed, one to the
    image URL it returns).
  - Verified in safety audit: 10 rapid stress hits = 10 x HTTP 200, no
    Set-Cookie tracking, no rate-limit headers, no anti-bot challenges.

Caveats:
  - oEmbed returns ONE thumbnail per video (the canonical cover, similar
    to the page-scraped `cover` field). It does NOT expose the alternate
    `originCover` / `dynamicCover` variants. For our matching needs the
    canonical cover suffices and was empirically equivalent.
  - The image URL returned by oEmbed has signed query params with an
    expiry; we fetch immediately so the signature is still valid.
"""
from __future__ import annotations
import io
import logging
from typing import Optional

import httpx
from PIL import Image
import imagehash

from . import config
from ._http_retry import get_with_retry

log = logging.getLogger(__name__)

OEMBED_URL = "https://www.tiktok.com/oembed"


def extract_phash_via_oembed(ad_link: str) -> Optional[str]:
    """Resolve a TikTok URL -> oEmbed thumbnail JPEG -> imagehash.phash hex.

    Returns the 16-char hex hash compatible with `imagehash.hex_to_hash`,
    or None on any failure. matcher.can_pair() treats None as "no phash"
    and the pair drops to length-only fallback (then to single-platform
    if length also misses).

    No cookies, no UA spoof, no scraping. Two HTTP GETs.
    """
    if not ad_link:
        return None

    timeout = config.TT_OEMBED_TIMEOUT
    proxy = config.TT_PROXY_URL  # optional residential proxy

    client_kwargs: dict = {
        "timeout": timeout,
        "verify": False,            # mirror shortimize.py for Cloudflare friendliness
        "follow_redirects": True,
    }
    if proxy:
        client_kwargs["proxy"] = proxy

    # Step 1: hit oEmbed for the thumbnail URL (with retry on transient errors).
    # Round 9 (2026-05-08): wrap each HTTP call in get_with_retry so a single
    # network blip during matcher's burst no longer leaves phash NULL forever.
    with httpx.Client(**client_kwargs) as c:
        r = get_with_retry(c, OEMBED_URL, params={"url": ad_link}, label="TT oembed")

    if r is None:
        return None
    if r.status_code != 200:
        log.info("TT oEmbed got %d for %s", r.status_code, ad_link)
        return None

    try:
        thumb_url = r.json().get("thumbnail_url")
    except ValueError:
        log.info("TT oEmbed JSON parse failed for %s", ad_link)
        return None

    if not thumb_url:
        log.info("TT oEmbed: no thumbnail_url in response for %s", ad_link)
        return None

    # Step 2: fetch the cover JPEG itself (with retry).
    with httpx.Client(**client_kwargs) as c:
        ir = get_with_retry(c, thumb_url, label="TT thumbnail")

    if ir is None:
        return None
    if ir.status_code != 200 or not ir.content:
        log.info("TT thumbnail got %d for %s", ir.status_code, thumb_url)
        return None

    # Step 3: decode + hash
    try:
        with Image.open(io.BytesIO(ir.content)) as img:
            phash = imagehash.phash(img)
        return str(phash)  # 16-char hex
    except Exception as e:
        log.warning("TT thumbnail phash decode failed for %s: %s", thumb_url, e)
        return None
