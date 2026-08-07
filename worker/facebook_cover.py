"""Facebook Reels cover-frame extractor.

Round 21 (2026-06-07): adds Facebook Reels as a 4th tracked platform.

Facebook is a Meta property and uses the SAME public link-preview mechanism as
Instagram: a GET with the `facebookexternalhit/1.1` crawler UA returns an HTML
page carrying `<meta property="og:image" content="...">` pointing at an
fbcdn.net-hosted cover JPEG. Empirically (verified against live FB reels during
the Round 21 spike):

  - All sampled FB reel URLs returned HTTP 200 to facebookexternalhit with an
    og:image present at byte offset ~10KB (well inside og_image's 256KB cap).
  - The FB cover JPEG phashes within hamming-20 (Tier 1) of the SAME video's
    TikTok/Instagram/YouTube cover. On 8/8 confirmed same-video test pairs
    the distance was 2-20 (median 11). So FB needs NO relaxed phash threshold
    and slots into the existing matcher unchanged.
  - FB returns REAL video_length values (unlike YouTube's bogus 60s), so no
    duration-override step is needed.

Because the extraction flow is byte-for-byte the Instagram flow, this module
delegates to `og_image.extract_phash_via_og`, passing the FB_* timeout/proxy
config knobs and a "FB" log label. Keeping a dedicated module (rather than
routing facebook straight to og_image in frame_extractor) mirrors the
one-module-per-platform pattern of tiktok_cover / youtube_cover and gives us a
clean seam if Facebook ever diverges from Instagram.

Shortimize always hands us canonical reel URLs of the form
`https://www.facebook.com/reel/<numeric_id>`; the og:image GET resolves those
directly, so no URL parsing is required here. (Other FB URL shapes —
/watch?v=, /<page>/videos/<id>, fb.watch/<code>, share/r/<code> — would also be
fetched as-is by the same GET if Shortimize ever emits them.)

Failure modes (all return None, same contract as the other extractors):
  - 4xx/5xx / login wall / takedown on the reel page
  - HTML present but no og:image meta (removed/private reel, FB schema change)
  - cover JPEG fetch fails or PIL can't decode it
"""
from __future__ import annotations
from typing import Optional

from . import config
from . import og_image


def extract_phash_via_og(ad_link: str) -> Optional[str]:
    """Resolve a Facebook reel URL -> cover JPEG -> imagehash.phash hex.

    Returns a 16-char hex string compatible with
    `frame_extractor.hamming_distance` / `imagehash.hex_to_hash`, or None on
    any failure. Delegates to the shared Instagram/Facebook og:image core with
    Facebook's timeout/proxy config and a "FB" log label.
    """
    return og_image.extract_phash_via_og(
        ad_link,
        timeout=config.FB_OG_IMAGE_TIMEOUT,
        proxy=config.FB_PROXY_URL,
        label="FB",
    )
