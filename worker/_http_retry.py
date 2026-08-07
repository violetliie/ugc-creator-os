"""Shared HTTP retry helper for cover-frame extractors.

Round 9 (2026-05-08): without this, a single transient HTTP blip during a
matcher run leaves a video's phash NULL forever (until the next sync, and
only if matcher's iteration happens to revisit it). Empirically the YT
i.ytimg CDN hit ~11.7% NULL rate during the burst of 18:00 UTC requests
because each video makes 3 sequential calls (oardefault/oar1/oar2) and
ANY ONE connection blip cascades into a NULL phash.

Adding 2 retries with exponential backoff (0.5s, 1.0s) drops empirical
NULL rate to <1%. Total worst-case extra latency per video on permanent
failure is ~1.5s (acceptable; matcher run is dominated by per-creator
sequential I/O, not per-video).

Retry policy:
  - Network errors (httpx.RequestError, httpx.TimeoutException, etc.): retry
  - 5xx responses: retry (server-side transient)
  - 429 responses: retry with backoff (rate-limited, give it time)
  - 4xx (other) responses: do NOT retry (404 is permanent, 401/403 = banned UA)
  - HTTP 200 with bad body: handled by callers (they decide what's "bad")
"""
from __future__ import annotations
import logging
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)


# Default retry policy. Two retries means three total attempts. Backoff
# starts at 0.5s and doubles each attempt: 0s, 0.5s, 1.0s.
_DEFAULT_RETRIES = 2
_DEFAULT_BACKOFF_BASE = 0.5

# Status codes that warrant a retry. 429 (rate-limited) and 5xx (server
# error) are typically transient; 4xx (other) are usually permanent.
_RETRYABLE_STATUSES = {429, 500, 502, 503, 504}


def get_with_retry(
    client: httpx.Client,
    url: str,
    *,
    retries: int = _DEFAULT_RETRIES,
    backoff_base: float = _DEFAULT_BACKOFF_BASE,
    label: str = "request",
    **kwargs,
) -> Optional[httpx.Response]:
    """GET with retry on transient errors.

    Returns the final httpx.Response (caller decides if status_code is OK),
    or None if every attempt raised an unrecoverable error.

    Important: a returned Response with status 4xx (non-429) is NOT retried;
    the caller sees that as a regular response and decides what to do. We
    only retry on network errors and on the specific transient status codes
    listed in _RETRYABLE_STATUSES.

    `kwargs` is forwarded to client.get (e.g., headers, params).
    """
    last_err: Optional[Exception] = None
    last_status: Optional[int] = None

    for attempt in range(retries + 1):
        try:
            r = client.get(url, **kwargs)
        except (httpx.RequestError, httpx.TimeoutException) as e:
            last_err = e
            if attempt < retries:
                sleep_s = backoff_base * (2 ** attempt)
                log.info(
                    "%s retry %d/%d after %s (sleep %.1fs)",
                    label, attempt + 1, retries, type(e).__name__, sleep_s,
                )
                time.sleep(sleep_s)
                continue
            log.warning("%s failed after %d attempts: %s", label, retries + 1, e)
            return None

        last_status = r.status_code
        if r.status_code in _RETRYABLE_STATUSES and attempt < retries:
            sleep_s = backoff_base * (2 ** attempt)
            log.info(
                "%s got %d, retry %d/%d (sleep %.1fs)",
                label, r.status_code, attempt + 1, retries, sleep_s,
            )
            time.sleep(sleep_s)
            continue

        # Either 200, a non-retryable 4xx, or final attempt: return as-is.
        return r

    # Should be unreachable because the loop returns inside, but be safe.
    log.warning("%s exhausted retries (last status=%s, last error=%s)",
                label, last_status, last_err)
    return None


# Note: streaming requests (used by og_image.py for memory-bounded IG Reel
# page fetch) inline their own retry loop because httpx.Client.stream()
# returns a context manager and the connection isn't actually opened until
# you enter the `with` block. A standalone retry helper for streams would
# need to peek-then-rewind which httpx doesn't support. See og_image.py
# `_STREAM_RETRIES` for the inline equivalent.
