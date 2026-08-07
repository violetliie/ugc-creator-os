"""Cross-platform first-frame perceptual hash extraction (cover-based).

Round 8 (2026-05-08): replaced the legacy yt-dlp + ffmpeg pipeline with
cover-frame fetching for ALL three platforms. Public API kept identical
(`extract_phash(ad_link, platform) -> str | None`) so `matcher.py` and
the `videos.phash` column don't need to know which method produced what.

Per-platform routing:

  instagram -> og_image.extract_phash_via_og(ad_link)
               GET https://www.instagram.com/reel/<sc>/  with facebookexternalhit UA
               parse <meta property="og:image">, fetch the cover JPEG, hash.

  tiktok    -> tiktok_cover.extract_phash_via_oembed(ad_link)
               GET https://www.tiktok.com/oembed?url=<TT_URL>
               JSON.thumbnail_url -> fetch JPEG, hash.

  youtube   -> youtube_cover.extract_phash_via_thumbnail(ad_link)
               GET https://i.ytimg.com/vi/<videoId>/oardefault.jpg
               hash directly.

  facebook  -> facebook_cover.extract_phash_via_og(ad_link)   (Round 21)
               Same Meta og:image flow as Instagram (delegates to og_image
               with FB_* config). GET https://www.facebook.com/reel/<id> with
               facebookexternalhit UA, parse og:image, fetch the cover JPEG.

Why we left frame-0-via-yt-dlp:

  Frame-0 produces tighter same-video phash distance (0-10) than cover-
  vs-frame-0 (16-25). But yt-dlp's full-video downloads:
    1) Required IG session cookies whose owner-account got bot-flagged
    2) Triggered Render container OOM-kills under matcher load
    3) Now require curl-cffi for TT and hit SABR streaming on YT

  The cover-based approach matches at distance ~2-10 across same-method
  pairs (we measured one creator's Apr 16 case at d=2 between TT oEmbed and
  IG og:image). The matcher's existing PHASH_HAMMING_THRESHOLD=10 holds.

Critical migration note: phashes produced by Round 8 are NOT comparable
to phashes from the pre-R8 yt-dlp+ffmpeg pipeline. Any existing
`videos.phash` column value must be NULL'd or re-extracted before
matcher runs, otherwise old-vs-new comparisons will all sit at d~16-25
and fail to pair. See design notes Section 24.J for the migration SQL.
"""
from __future__ import annotations
import logging

import imagehash

from . import og_image
from . import tiktok_cover
from . import youtube_cover
from . import facebook_cover


log = logging.getLogger(__name__)


def extract_phash(ad_link: str, platform: str) -> str | None:
    """Compute the cover-frame perceptual hash for a video.

    Returns a 16-char hex string compatible with `imagehash.hex_to_hash`,
    or None on any failure. matcher.can_pair() treats None as "no phash"
    and the pair drops to length-only fallback (then to single-platform
    if length also misses).

    Routing (Round 8): all platforms use cover-based extraction.
    """
    if not ad_link or not platform:
        return None
    if platform == "instagram":
        return og_image.extract_phash_via_og(ad_link)
    if platform == "tiktok":
        return tiktok_cover.extract_phash_via_oembed(ad_link)
    if platform == "youtube":
        return youtube_cover.extract_phash_via_thumbnail(ad_link)
    if platform == "facebook":
        return facebook_cover.extract_phash_via_og(ad_link)
    log.warning("extract_phash: unknown platform %s for %s", platform, ad_link)
    return None


def hamming_distance(a: str, b: str) -> int:
    """Hamming distance between two phash hex strings, 0 (identical) to 64.

    Returns 64 if either side is missing/empty.

    Multi-candidate support (Round 8 patch, 2026-05-08): YT videos store
    comma-separated phashes (one per cover variant: oardefault, oar1, oar2).
    See worker/youtube_cover.py for rationale. When either side contains a
    comma, we split on commas and compute the MINIMUM distance across all
    pairwise combinations. This way the matcher uses whichever YT cover
    variant best matches the other-platform phash for each comparison.

    Backward-compatible: a single hex string still works as before.
    """
    if not a or not b:
        return 64
    a_list = a.split(",") if "," in a else [a]
    b_list = b.split(",") if "," in b else [b]
    min_d = 64
    for ah in a_list:
        ha = imagehash.hex_to_hash(ah)
        for bh in b_list:
            hb = imagehash.hex_to_hash(bh)
            d = ha - hb
            if d < min_d:
                min_d = d
    return min_d
