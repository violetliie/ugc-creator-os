"""Shortimize API client.

Per the vendor API notes:
  - Bearer token auth
  - GET /videos: paginated, rate-limited 30 req/min
  - GET /accounts: returns linked accounts (handle validation cache)
  - SSL verify=False for Cloudflare compatibility
  - Retry on 429/5xx, fail on other 4xx, propagate after MAX_RETRIES
"""
from __future__ import annotations
import time
from typing import Iterator
import httpx
from . import config

MAX_LIMIT = 20000


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=config.SHORTIMIZE_BASE_URL,
        headers={"Authorization": f"Bearer {config.SHORTIMIZE_API_KEY}"},
        timeout=config.REQUEST_TIMEOUT,
        verify=False,
    )


def _request_with_retry(client: httpx.Client, method: str, path: str, **kw) -> dict:
    for attempt in range(1, config.MAX_RETRIES + 2):
        try:
            r = client.request(method, path, **kw)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429 or r.status_code >= 500:
                if attempt > config.MAX_RETRIES:
                    r.raise_for_status()
                time.sleep(2 * attempt)
                continue
            # 4xx other than 429 -> non-retryable
            r.raise_for_status()
        except httpx.RequestError:
            if attempt > config.MAX_RETRIES:
                raise
            time.sleep(2 * attempt)
    raise RuntimeError(f"Exhausted retries for {method} {path}")


def fetch_videos(
    *,
    username: str | None = None,
    uploaded_at_start: str | None = None,
    uploaded_at_end: str | None = None,
) -> Iterator[dict]:
    """Yields video objects, walking pages. We use created_at asc for stable sequence order."""
    with _client() as c:
        page = 1
        while True:
            params = {
                "order_by": "created_at",
                "order_direction": "asc",
                "has_metrics": "true",
                "limit": MAX_LIMIT,
                "page": page,
            }
            if username:
                # Shortimize's `username` filter is CASE-SENSITIVE and stores
                # handles normalized (lowercased, no leading @). A creator
                # handle entered with capitals — e.g. "JaneDoe", common for
                # YouTube — otherwise returns ZERO videos, silently dropping
                # that whole platform for the creator. Normalize to match how
                # Shortimize stores it. (Found 2026-06-12: 7 creators each
                # missing an entire platform's videos right before a payout;
                # all had a capitalized/@-prefixed handle. The per-video
                # username guard in scheduler already compares lowercased, so
                # this only ever fixes under-matching, never mis-attributes.)
                params["username"] = username.strip().lstrip("@").lower()
            if uploaded_at_start:
                params["uploaded_at_start"] = uploaded_at_start
            if uploaded_at_end:
                params["uploaded_at_end"] = uploaded_at_end

            data = _request_with_retry(c, "GET", "/videos", params=params)
            for v in data.get("data", []):
                yield v
            total_pages = data.get("pagination", {}).get("total_pages", 1)
            if page >= total_pages:
                break
            page += 1
            time.sleep(config.RATE_LIMIT_DELAY_SEC)


def fetch_accounts() -> list[dict]:
    """Returns all accounts linked to the org (handle validation cache source)."""
    with _client() as c:
        data = _request_with_retry(c, "GET", "/accounts", params={"limit": 5000, "paginated": "false"})
        return data.get("data", []) if isinstance(data, dict) else (data or [])
