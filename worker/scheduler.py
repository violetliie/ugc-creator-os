"""Scheduler: ingest, match, snapshot-lock, prune.

Pipeline (the design notes, §19.D):
  1. Refresh shortimize_accounts cache (daily, but cheap to run every cron).
  2. For each active creator, fetch new videos (uploaded_at_start = max(last_seen-1d, 2026-04-16)).
     Upsert into `videos` table. Compute cycle_id in ET. Reject pre-Apr-16.
  3. Refresh latest_views for non-frozen videos.
  4. Run matcher across all creators (cross-cycle, cross-post).
  5. If today is a snapshot-lock day at 6 PM ET, lock the relevant cycle.
  6. Prune sync_runs older than 90 days.
"""
from __future__ import annotations
from datetime import datetime, timedelta, date
import logging
import subprocess
import sys
from typing import Optional
from .db import get_db
from . import shortimize, matcher, config, youtube_cover
from .cycles import (
    ET, cycle_id_for_datetime, cycle_id_for_date, ensure_cycles_through, is_snapshot_day, parse_cycle_id,
    utcnow, utcnow_iso,
)
from .hashtags import fetch_creator_hashtag_rules, video_passes_filter

log = logging.getLogger(__name__)


# Round 11 (2026-05-18): per-creator subprocess timeout. If a single creator's
# fetch+match exceeds this, the parent kills the subprocess and marks the
# creator_runs row as failed with a timeout message. 20 minutes is generous
# (typical creator: 30s-2min); set high enough that legit slow runs (huge
# new ingest, many cover extractions) succeed but a true infinite-loop or
# network-stall is caught.
PER_CREATOR_TIMEOUT_SEC = 20 * 60


def refresh_accounts_cache() -> int:
    db = get_db()
    accounts = shortimize.fetch_accounts()
    n = 0
    for a in accounts:
        plat = (a.get("platform") or "").lower()
        if plat not in ("tiktok", "instagram", "youtube", "facebook"):
            continue
        username = (a.get("username") or "").strip().lstrip("@").lower()
        if not username:
            continue
        db.table("shortimize_accounts").upsert({
            "account_id": a.get("account_id"),
            "username": username,
            "platform": plat,
            "checked_at": a.get("checked_at"),
            "removed": bool(a.get("removed")),
            "private": bool(a.get("private")),
            "last_uploaded_at": a.get("last_uploaded_at"),
            "our_last_synced_at": utcnow_iso(),
        }, on_conflict="account_id").execute()
        n += 1
    return n


def _ingest_video(db, creator: dict, v: dict, hashtag_rules: list[dict] | None = None) -> bool:
    """Upsert one Shortimize video. Returns True if new (inserted).

    `hashtag_rules` is the pre-fetched list of {tag, starting_on} for this creator.
    When non-empty AND the video is posted on/after at least one rule's start date,
    the video must include '#tag' in its caption (Round 5 R1).
    """
    plat = (v.get("platform") or "").lower()
    if plat not in ("tiktok", "instagram", "youtube", "facebook"):
        return False
    if v.get("private") or v.get("removed"):
        return False
    ad_link = v.get("ad_link")
    if not ad_link:
        return False

    # ROUND 16 (2026-05-21): Shortimize's `username` query filter is unreliable
    # for YouTube. Specifically, handles containing characters like dashes
    # (e.g. a handle like @some-name8kt) cause Shortimize to return a flood of
    # videos from UNRELATED YT channels (whose names merely
    # happen to match the query). Our pre-Round-16 code blindly trusted the response
    # and ingested those into the queried creator's account — 473 of 944 YT
    # videos in DB were misattributed to one creator. Defense: verify the
    # response video's username matches THIS creator's handle for THIS
    # platform before ingesting. If not, skip — the video isn't ours.
    # Compares lowercased, leading-@ stripped. Empty handles fail closed.
    v_username = (v.get("username") or "").lower().lstrip("@")
    handle_field = {
        "tiktok": "tiktok_handle",
        "instagram": "instagram_handle",
        "youtube": "youtube_handle",
        "facebook": "facebook_handle",  # Round 21
    }[plat]
    expected_handle = (creator.get(handle_field) or "").lower().lstrip("@")
    if not expected_handle or not v_username or v_username != expected_handle:
        return False
    created_at_remote = v.get("created_at")
    if not created_at_remote:
        return False
    try:
        crt = datetime.fromisoformat(created_at_remote.replace("Z", "+00:00"))
    except Exception:
        return False

    # Round 18 (2026-05-21): use posted_date (Shortimize's uploaded_at) as
    # source of truth for cutoff + cycle assignment. created_at_remote is the
    # Shortimize INDEX timestamp, which can lag the actual upload by 1-5+
    # days for some platforms (especially IG). Same root cause as Round 17:
    # using index-time instead of post-time misattributes cycle for any
    # video posted near a cycle boundary (e.g., Apr 30 video indexed May 2
    # was wrongly assigned to 2026-5-1 instead of 2026-4-2).
    posted_date_str = v.get("uploaded_at")
    if not posted_date_str:
        return False
    try:
        posted_date_obj = date.fromisoformat(posted_date_str[:10])
    except Exception:
        return False

    # Hard cutoff: reject anything posted before Apr 16, 2026 (Round 4 F10).
    if posted_date_obj < date(2026, 4, 16):
        return False

    # Round 5 hashtag filter (per-video): if any rule applies, the caption
    # must include at least one applicable tag. The filter compares against
    # `starting_on` (datetime). We pass `crt` here because it's still the
    # closest approximation to a real posted timestamp we have; switching to
    # posted_date would lose the time-of-day component the filter relies on
    # for boundary cases.
    if hashtag_rules:
        if not video_passes_filter(crt, v.get("title"), hashtag_rules):
            return False

    # Cycle id from posted_date (NOT created_at_remote — see Round 18 note above).
    cycle_id = cycle_id_for_date(posted_date_obj)
    posted_date = posted_date_str
    video_length = v.get("video_length")
    try:
        video_length = int(video_length) if video_length is not None else None
    except (TypeError, ValueError):
        video_length = None

    # Look up existing video FIRST so we can decide whether the expensive
    # YT-duration fetch is actually needed (Round 13 optimization).
    # Round 22: also fetch creator_id so we can auto-heal misattribution on a
    # handle rename (see the reassignment block in the update branch below).
    # Round 23: also fetch shortimize_account_id for the auto-heal legitimacy
    # check (collab posts are linked to BOTH creators' accounts on Shortimize).
    existing = db.table("videos").select("id, views_frozen, video_length, creator_id, shortimize_account_id").eq("platform", plat).eq("ad_link", ad_link) \
        .maybe_single().execute()
    existing_data = existing.data if existing else None

    # Round 8: Shortimize reports video_length=60 for ALL YouTube Shorts (data
    # bug). That nukes the matcher's +/- 1s length filter for any TT/IG <-> YT
    # cross-post pairing. Override with the real duration scraped from YT's
    # public <meta itemprop="duration"> tag (no yt-dlp, no SABR streaming, no
    # cookies; see worker/youtube_cover.py).
    #
    # Round 13 (2026-05-21) optimization: only call fetch_duration when we
    # actually NEED the real value. Pre-R13 we called it for EVERY YT video
    # on EVERY sync, even when the existing DB row already had a correct
    # non-60 length. For high-YT-count creators (a creator with ~130 YT shorts)
    # that was ~130 redundant HTTP scrapes × 1-2s each = 2-4 wasted minutes
    # per sync, which was pushing per-creator subprocess time past the
    # 20-min PER_CREATOR_TIMEOUT_SEC cap. Now we skip it when:
    #   - The video already exists in DB AND its stored length is not 60
    #     (i.e., we already have a real value, video duration never changes
    #     after upload so no need to re-fetch).
    # We still call it when:
    #   - New video (no existing row) → need the real length on INSERT
    #   - Existing row has video_length=60 → bogus default needs healing
    #   - Existing row has video_length IS NULL → never got a value
    if plat == "youtube":
        needs_real_duration = (
            existing_data is None
            or existing_data.get("video_length") in (None, 60)
        )
        if needs_real_duration:
            real_dur = youtube_cover.fetch_duration(ad_link)
            if real_dur is not None:
                video_length = real_dur
        else:
            # Reuse the already-correct length from DB; skip the HTTP call.
            video_length = existing_data.get("video_length")

    # Find shortimize_account_id from cache. (Per-video lookup; future
    # optimization could pre-load once per creator-fetch, but DB hit is small.)
    sa = db.table("shortimize_accounts").select("account_id") \
        .eq("platform", plat).eq("username", (v.get("username") or "").lower().lstrip("@")) \
        .maybe_single().execute()
    shortimize_account_id = sa.data["account_id"] if sa and sa.data else None

    # Upsert (platform, ad_link) unique
    if existing_data:
        if existing_data.get("views_frozen"):
            return False  # frozen: don't refresh (also protects paid-cycle rows)
        update_payload = {
            "latest_views": int(v.get("latest_views") or 0),
            "last_refreshed_at": utcnow_iso(),
            "shortimize_updated_at": v.get("latest_updated_at"),
            "title": v.get("title"),
        }
        # ROUND 22 (2026-06-10): AUTO-HEAL creator reassignment on handle rename.
        # We only reach here AFTER the Round 16 guard verified that the video's
        # Shortimize `username` equals THIS creator's handle for this platform —
        # i.e., this creator is the rightful owner of the channel. If the
        # existing row is currently under a DIFFERENT creator, the channel must
        # have moved (e.g., a creator renames their YouTube @oldhandle -> @newhandle;
        # once the Shortimize account is renamed, the new-handle creator's fetch
        # returns these videos and we move them here). Reassign creator_id and
        # FREE the video from its old group membership so the matcher regroups it
        # under the correct creator (otherwise UNIQUE(video_id) on
        # video_group_members would collide). Frozen/paid rows already returned
        # above, so paid snapshots are never disturbed.
        existing_owner = existing_data.get("creator_id")
        if existing_owner and existing_owner != creator["id"]:
            # ROUND 23 (2026-06-11): LEGITIMACY CHECK before stealing.
            # Instagram COLLAB posts are linked to BOTH collaborators' accounts
            # on Shortimize (verified: a two-creator collab reel returns
            # under BOTH accounts). Pre-R23, the R22 auto-heal would
            # PING-PONG such a video between the two creators every sync (both
            # pass the username guard), destroying its group each flip. Rule:
            # only steal when the EXISTING owner is no longer legitimate —
            # i.e. the stored row's Shortimize account username no longer
            # matches the existing owner's handle (a true rename, e.g.
            # @oldhandle -> @newhandle after the Shortimize account rename),
            # or the existing owner was soft-deleted. For collabs both owners
            # stay legitimate -> first claim wins, stable forever (user policy
            # 2026-06-11: collab payout credits the canonical/first owner).
            steal = False
            old_acct_id = existing_data.get("shortimize_account_id")
            try:
                owner_row = (db.table("creators")
                             .select(f"{handle_field}, deleted_at")
                             .eq("id", existing_owner)
                             .maybe_single().execute())
                owner_data = owner_row.data if owner_row else None
                owner_handle = ((owner_data or {}).get(handle_field) or "").lower().lstrip("@")
                owner_deleted = bool((owner_data or {}).get("deleted_at"))
                acct_username = ""
                if old_acct_id:
                    acct_row = (db.table("shortimize_accounts")
                                .select("username")
                                .eq("account_id", old_acct_id)
                                .maybe_single().execute())
                    acct_username = (((acct_row.data if acct_row else None) or {}).get("username") or "").lower().lstrip("@")
                if owner_deleted or not owner_handle:
                    steal = True  # old owner gone or has no handle on this platform
                elif acct_username and acct_username != owner_handle:
                    steal = True  # account renamed away from old owner's handle
                # else: old owner still matches the stored account -> collab/
                # legitimate dual-link -> keep first claim. (Also the
                # no-stored-account case stays conservative: no steal.)
            except Exception as e:
                log.warning("auto-heal legitimacy check failed for %s: %s (keeping current owner)",
                            ad_link, e)

            if steal:
                update_payload["creator_id"] = creator["id"]
                update_payload["cycle_id"] = cycle_id  # keep cycle consistent w/ posted_date
                try:
                    db.table("video_group_members").delete().eq("video_id", existing_data["id"]).execute()
                except Exception as e:
                    log.warning("auto-heal: failed to free old group membership for %s: %s",
                                existing_data["id"], e)
                log.info("auto-heal: reassigned %s (%s) from creator %s -> %s (username=%s matches handle; old owner no longer legitimate)",
                         ad_link, plat, existing_owner, creator["id"], v_username)
            else:
                log.info("auto-heal: %s (%s) also matches creator %s but existing owner %s is still legitimate (collab/dual-link); keeping first claim",
                         ad_link, plat, creator["id"], existing_owner)
        # Round 8 patch (2026-05-08): also retry the YT length override for
        # existing rows whose first ingest hit a transient HTTP failure in
        # fetch_duration. With Round 13's skip-when-already-correct, this
        # branch now only fires when (a) needs_real_duration was true AND
        # (b) fetch returned a different value. Self-healing for bogus 60s.
        if plat == "youtube" and video_length is not None and video_length != existing_data.get("video_length"):
            update_payload["video_length"] = video_length
        db.table("videos").update(update_payload).eq("id", existing_data["id"]).execute()
        return False
    db.table("videos").insert({
        "creator_id": creator["id"],
        "platform": plat,
        "ad_link": ad_link,
        "ad_id": v.get("ad_id"),
        "shortimize_account_id": shortimize_account_id,
        "title": v.get("title"),
        "posted_date": posted_date,
        "created_at_remote": created_at_remote,
        "video_length": video_length,
        "latest_views": int(v.get("latest_views") or 0),
        "private": bool(v.get("private")),
        "removed": bool(v.get("removed")),
        "cycle_id": cycle_id,
        "shortimize_updated_at": v.get("latest_updated_at"),
    }).execute()
    return True


_PROGRAM_FLOOR_DATE = datetime(2026, 4, 16).date()
# Module-level cache for the earliest-unpaid-cycle floor: computed once per
# pipeline run (the cache lives for the lifetime of the worker subprocess so
# subsequent _fetch_window_start calls within the same sync reuse it). Reset
# explicitly via _reset_window_cache() before each pipeline if needed.
_UNPAID_CYCLE_FLOOR_CACHE: dict = {}


def _reset_window_cache() -> None:
    """Clear the unpaid-cycle floor cache. Call at the start of run_pipeline."""
    _UNPAID_CYCLE_FLOOR_CACHE.clear()


def _earliest_unpaid_cycle_floor(db) -> date:
    """Return the period_start (ET date) of the earliest unpaid past cycle.

    Round 14 (2026-05-21): the fetch window floor used to be a hardcoded
    Apr 16, 2026 (program start). Once `today - 30d` crossed past Apr 16
    (i.e., after May 16), creators-with-existing-videos started fetching
    from the rolling 30-day window instead, MISSING any Apr 16-21 videos
    that weren't already in DB (e.g., creators imported May 12 from the
    CSV who only got partial backfill due to OOM-killed syncs).

    Fix: anchor the floor on the earliest UNPAID past cycle's period_start.
    While cycle 2026-4-2 (Apr 16-30) is unpaid, the floor stays at Apr 16
    for ALL creators regardless of rolling window. Once an admin clicks
    "Mark paid" on that cycle, the floor naturally slides to the next
    unpaid cycle. Self-healing for any future delayed-payment scenarios.

    Returns a date object. Falls back to the program floor if no unpaid
    cycle exists or the query fails.
    """
    if "floor" in _UNPAID_CYCLE_FLOOR_CACHE:
        return _UNPAID_CYCLE_FLOOR_CACHE["floor"]

    try:
        # Earliest cycle whose period_end is in the past AND not marked_paid.
        # `period_start` is timestamptz in ET; we want the date portion.
        now_iso = utcnow_iso()
        rows = (db.table("payment_cycles")
                .select("id, period_start, period_end, marked_paid_at")
                .is_("marked_paid_at", "null")
                .lt("period_end", now_iso)
                .order("period_start")
                .limit(1).execute().data or [])
    except Exception:
        rows = []

    if rows:
        # period_start is e.g. "2026-04-16T00:00:00-04:00"; extract the date.
        try:
            ps = rows[0]["period_start"]
            cycle_floor = datetime.fromisoformat(ps.replace("Z", "+00:00")).date()
        except Exception:
            cycle_floor = _PROGRAM_FLOOR_DATE
    else:
        cycle_floor = _PROGRAM_FLOOR_DATE

    # Never go BEFORE the absolute program start.
    floor = max(cycle_floor, _PROGRAM_FLOOR_DATE)
    _UNPAID_CYCLE_FLOOR_CACHE["floor"] = floor
    return floor


def _fetch_window_start(db, creator_id: str) -> str:
    """Decide the Shortimize fetch window's start date for a creator.

    Semantics (Round 14): the returned date is the EARLIEST date to fetch
    from. Earlier = more API work but full coverage of any unpaid cycle.
    Later = efficient steady-state but might miss old unpaid cycle videos.

    Resolution:
      - `unpaid_floor` = earliest unpaid past cycle's period_start
        (defaults to program start Apr 16, 2026)
      - `rolling` = today - 30 days (steady-state window)
      - `program_floor` = Apr 16, 2026 (absolute minimum, never go earlier)

      Final:  max(program_floor, min(rolling, unpaid_floor))

      - When unpaid_floor < rolling (unpaid cycle is older than 30 days):
        fetch from unpaid_floor to ensure cycle coverage
      - When rolling < unpaid_floor (all unpaid cycles are recent):
        fetch from rolling (efficient steady-state)
      - Always clamped to program_floor so we never fetch pre-launch data

    First-sync creators (no videos in DB): fetch from unpaid_floor
    unconditionally — guarantees no missed videos even on delayed
    deployments or late creator additions.
    """
    has_videos = db.table("videos").select("id").eq("creator_id", creator_id).limit(1).execute().data
    unpaid_floor = _earliest_unpaid_cycle_floor(db)
    if not has_videos:
        # New creator: fetch as far back as needed to cover any unpaid cycle.
        return max(unpaid_floor, _PROGRAM_FLOOR_DATE).isoformat()
    rolling = (utcnow() - timedelta(days=30)).date()
    # Pick the EARLIER of (rolling, unpaid_floor) so we always cover any
    # still-unpaid cycle older than 30 days. Clamp to program_floor.
    window_start = max(_PROGRAM_FLOOR_DATE, min(rolling, unpaid_floor))
    return window_start.isoformat()


def _probe_video_alive(ad_link: str, platform: str):
    """Ask the PLATFORM ITSELF whether a video still exists.

    Round 23 (2026-06-11): the authoritative stage-2 verdict for the ghost
    sweep. Shortimize's `removed` field is proven unreliable (still False on
    confirmed-404 videos), so deletion is only ever concluded from the
    platform's own response. Signals calibrated on the Round 18 + Round 23
    live probes:

      youtube   oEmbed 200 -> alive; 404 -> DELETED; 401 = embedding disabled
                but video exists -> alive; anything else -> unknown.
      tiktok    oEmbed 200 -> alive (even with empty thumbnail — Round 18
                showed live videos can return a hollow 200); 400/404 ->
                DELETED; anything else -> unknown.
      instagram GET with the facebookexternalhit UA, redirects NOT followed:
                200 -> alive; redirect to another /reel|/p|/tv path -> alive
                (canonical slash redirect); redirect to login -> unknown;
                redirect to the profile root -> DELETED (verified pattern);
                anything else -> unknown.
      facebook  og:image present in the first 256KB -> alive; everything
                else -> unknown (FB "unavailable" pages are ambiguous; we
                never auto-remove FB on weak evidence).

    Returns True (alive), False (confirmed deleted), or None (unknown —
    caller leaves the row untouched and re-checks next sync). All network
    errors return None: a probe can never remove a video by accident.
    """
    import httpx
    UA = ("facebookexternalhit/1.1 "
          "(+http://www.facebook.com/externalhit_uatext.php)")
    try:
        if platform == "youtube":
            r = httpx.get("https://www.youtube.com/oembed",
                          params={"url": ad_link, "format": "json"},
                          timeout=10.0, verify=False)
            if r.status_code == 200:
                return True
            if r.status_code == 404:
                return False
            if r.status_code == 401:  # embeds disabled; video exists
                return True
            return None
        if platform == "tiktok":
            r = httpx.get("https://www.tiktok.com/oembed",
                          params={"url": ad_link},
                          timeout=10.0, verify=False)
            if r.status_code == 200:
                return True
            if r.status_code in (400, 404):
                return False
            return None
        if platform == "instagram":
            r = httpx.get(ad_link, headers={"User-Agent": UA},
                          timeout=10.0, verify=False, follow_redirects=False)
            if r.status_code == 200:
                return True
            if r.status_code in (301, 302):
                loc = r.headers.get("location", "")
                if any(p in loc for p in ("/reel/", "/p/", "/tv/")):
                    return True
                if "login" in loc or "accounts" in loc:
                    return None
                return False  # redirect to profile root = deleted reel
            return None
        if platform == "facebook":
            with httpx.Client(timeout=10.0, verify=False,
                              follow_redirects=True) as c:
                with c.stream("GET", ad_link,
                              headers={"User-Agent": UA}) as resp:
                    if resp.status_code != 200:
                        return None
                    buf = ""
                    for chunk in resp.iter_text(chunk_size=16 * 1024):
                        buf += chunk
                        if "og:image" in buf:
                            return True
                        if len(buf) >= 256 * 1024:
                            break
            return None
    except Exception:
        return None
    return None


def fetch_creator_videos(creator: dict) -> int:
    """Fetch videos for each of the creator's handles. Returns count of new+updated."""
    db = get_db()
    # Pre-load this creator's hashtag rules ONCE (Round 5 R1 + G2 + G4).
    hashtag_rules = fetch_creator_hashtag_rules(db, creator["id"], creator["arm"])

    handles = [
        ("tiktok", creator.get("tiktok_handle")),
        ("instagram", creator.get("instagram_handle")),
        ("youtube", creator.get("youtube_handle")),
        ("facebook", creator.get("facebook_handle")),  # Round 21
    ]
    count = 0
    for platform, handle in handles:
        if not handle:
            continue
        # First sync for this creator: fetch from program start.
        # Steady state: rolling 30 days (with Apr 16 floor).
        start_date = _fetch_window_start(db, creator["id"])
        end_date = utcnow().date().isoformat()
        try:
            for v in shortimize.fetch_videos(
                username=handle, uploaded_at_start=start_date, uploaded_at_end=end_date,
            ):
                if (v.get("platform") or "").lower() != platform:
                    continue
                if _ingest_video(db, creator, v, hashtag_rules):
                    count += 1
                else:
                    # Counts include filtered-out + updated. Updates increment too.
                    count += 1
        except Exception as e:
            log.warning("Fetch failed for %s/%s: %s", platform, handle, e)

    # ROUND 23 (2026-06-11): GHOST SWEEP — detect deleted videos, two-stage.
    # When a video is deleted from its platform, Shortimize silently STOPS
    # returning it in the creator's username query, and Shortimize's own
    # `removed` field CANNOT be trusted (verified on one creator's 3 deleted
    # YT shorts: YouTube 404s them, the username query drops them, yet a
    # window query still returns them with removed=False). Pre-R23 such
    # ghosts lingered forever as matchable+payable and could steal cross-post
    # twins from live videos (template-creator covers).
    #
    # Stage 1 — TRIGGER (cheap, no HTTP, user-specified): a video posted
    # within the last 14 days (active tracking window — Shortimize returns
    # active-window videos on every fetch, bumping last_refreshed_at) that
    # has NOT been refreshed for >= 4 days is a deletion CANDIDATE. Downtime
    # guard: only consider candidates if >= 4 successful syncs completed
    # since the staleness cutoff (a dead worker refreshes nothing — never
    # mass-flag on recovery).
    #
    # Stage 2 — VERDICT (authoritative): ask the PLATFORM ITSELF via
    # _probe_video_alive. Only a confirmed-deleted probe (YT oEmbed 404,
    # TT oEmbed 400, IG redirect-to-profile) marks removed=true — exactly
    # how those 3 ghost videos were verified by hand. Alive or ambiguous
    # probes leave the row untouched (re-checked next sync). This makes
    # false-removal of a merely-stale live video impossible.
    #
    # Frozen (paid) and already-removed rows are excluded. Matcher Phase 0
    # skips removed=true, so confirmed ghosts drop out of grouping on this
    # same pipeline run and their stolen twins re-pair automatically.
    _GHOST_PROBES_PER_RUN = 15  # bound per-creator HTTP work; rest next sync
    try:
        active_floor = (utcnow().date() - timedelta(days=14)).isoformat()
        stale_cutoff = (utcnow() - timedelta(days=4)).isoformat()
        ok_syncs = (db.table("sync_runs").select("id")
                    .eq("status", "success")
                    .gte("started_at", stale_cutoff)
                    .limit(4).execute().data or [])
        if len(ok_syncs) >= 4:
            stale = (db.table("videos")
                     .select("id, ad_link, platform")
                     .eq("creator_id", creator["id"])
                     .eq("views_frozen", False)
                     .eq("removed", False)
                     .gte("posted_date", active_floor)
                     .lt("last_refreshed_at", stale_cutoff)
                     .limit(_GHOST_PROBES_PER_RUN)
                     .execute().data or [])
            for s in stale:
                alive = _probe_video_alive(s["ad_link"], s["platform"])
                if alive is False:
                    db.table("videos").update({"removed": True}).eq("id", s["id"]).execute()
                    log.info("ghost-sweep: platform CONFIRMED deleted -> removed=true %s (%s)",
                             s["ad_link"], s["platform"])
                elif alive is True:
                    log.info("ghost-sweep: %s (%s) stale in Shortimize but ALIVE on platform; keeping",
                             s["ad_link"], s["platform"])
                else:
                    log.info("ghost-sweep: %s (%s) probe inconclusive; will re-check next sync",
                             s["ad_link"], s["platform"])
    except Exception as e:
        log.warning("ghost-sweep failed for creator %s: %s", creator["id"], e)

    return count


def lock_snapshot_for_cycle(cycle_id: str) -> dict:
    """Take a final snapshot for the cycle: build per-creator amounts, freeze videos.

    Does NOT set marked_paid_at; admin still needs to click Mark as paid.
    """
    db = get_db()
    now = utcnow_iso()
    # Compute totals from current video_groups (payable only; SHELVED ROUND 15)
    res = db.table("video_groups").select("creator_id, payout, payable, cross_posted") \
        .eq("cycle_id", cycle_id).execute()
    totals: dict[str, float] = {}
    for g in (res.data or []):
        # SHELVED ROUND 15 (2026-05-21): cross_posted no longer gates snapshot.
        # Keep field in SELECT for parity with restoration path.
        # if not g["payable"] or not g["cross_posted"]:
        if not g["payable"]:
            continue
        totals[g["creator_id"]] = totals.get(g["creator_id"], 0.0) + float(g["payout"])

    # ROUND 24 (2026-06-11): referral bonuses landing in this cycle are part
    # of the referrer's snapshot amount (mirrors the mark-paid API routes).
    refs = (db.table("referrals")
            .select("referrer_creator_id, amount")
            .eq("awarded_cycle_id", cycle_id)
            .eq("status", "awarded")
            .execute().data or [])
    for r in refs:
        totals[r["referrer_creator_id"]] = totals.get(r["referrer_creator_id"], 0.0) + float(r["amount"])

    snaps_written = 0
    for creator_id, amount in totals.items():
        if amount <= 0:
            continue
        # Upsert snapshot (do not set marked_paid_at; that's admin's manual action)
        db.table("payment_snapshots").upsert(
            {
                "cycle_id": cycle_id,
                "creator_id": creator_id,
                "amount": amount,
                "generated_at": now,
            },
            on_conflict="cycle_id,creator_id",
        ).execute()
        snaps_written += 1
    # Freeze all videos in this cycle
    db.table("videos").update({"views_frozen": True}).eq("cycle_id", cycle_id).execute()
    # Mark snapshot_generated_at on cycle
    db.table("payment_cycles").update({"snapshot_generated_at": now}).eq("id", cycle_id).execute()
    return {"cycle_id": cycle_id, "snapshots_written": snaps_written, "total": sum(totals.values())}


# ROUND 24 (2026-06-11): referral bonus rules. Mirrors src/lib/referrals.ts —
# keep the two in sync. $75 to the referrer once the referred creator has
# >= 12 videos on their top platform, counted all-time across our videos
# table (excluding removed/private).
REFERRAL_MIN_VIDEOS = 12


def promote_referrals(db) -> dict:
    """Re-check every pending referral; runs each pipeline.

    - Referred creator soft-deleted -> auto-remove the referral ("fired",
      never pays; removed_by stays NULL = system). Admin still sees the
      yellow removed row.
    - Referred creator has >= REFERRAL_MIN_VIDEOS on their top platform ->
      award: the $75 lands in the CALENDAR cycle at the moment of
      qualification (user policy 2026-06-11), and the row keeps its original
      referred_cycle_id for the "period referred at" label.
    - Otherwise stays pending; tried again next pipeline.
    """
    from collections import Counter

    pending = (db.table("referrals")
               .select("id, referred_creator_id")
               .eq("status", "pending")
               .execute().data or [])
    out = {"checked": len(pending), "awarded": 0, "auto_removed": 0}
    if not pending:
        return out

    now_iso = utcnow_iso()
    landing_cycle = cycle_id_for_datetime(datetime.now(ET))

    for r in pending:
        cr = (db.table("creators")
              .select("deleted_at")
              .eq("id", r["referred_creator_id"])
              .maybe_single().execute())
        crd = cr.data if cr else None
        if not crd or crd.get("deleted_at"):
            db.table("referrals").update({
                "status": "removed",
                "removed_at": now_iso,
                # removed_by stays NULL -> system removal (referred deleted)
            }).eq("id", r["id"]).execute()
            out["auto_removed"] += 1
            continue

        # All-time per-platform counts (paginate past the 1000-row cap).
        counts: Counter = Counter()
        fr = 0
        while True:
            page = (db.table("videos")
                    .select("platform")
                    .eq("creator_id", r["referred_creator_id"])
                    .eq("removed", False)
                    .eq("private", False)
                    .range(fr, fr + 999)
                    .execute().data or [])
            for v in page:
                counts[v["platform"]] += 1
            if len(page) < 1000:
                break
            fr += 1000

        top = max(counts.values()) if counts else 0
        if top >= REFERRAL_MIN_VIDEOS:
            db.table("referrals").update({
                "status": "awarded",
                "awarded_cycle_id": landing_cycle,
                "awarded_at": now_iso,
            }).eq("id", r["id"]).execute()
            out["awarded"] += 1
            log.info("referral %s awarded: referred %s hit %d videos (lands in %s)",
                     r["id"], r["referred_creator_id"], top, landing_cycle)

    return out


def prune_sync_runs(days: int = 90) -> int:
    db = get_db()
    cutoff = (utcnow() - timedelta(days=days)).isoformat()
    res = db.table("sync_runs").delete().lt("started_at", cutoff).execute()
    return len(res.data or [])


def clear_stale_running_runs(threshold_minutes: int = 3) -> dict:
    """Auto-clear any sync_runs left in 'running' state from a dead process.

    ROUND 15 follow-up (2026-05-21). Called at worker startup (both FastAPI
    parent via lifespan/on_event, AND cron_runner.main() before run_pipeline).
    Recovers from Render redeploys that SIGKILL the worker container mid-sync.

    Before this hook: a killed sync would leave its sync_runs row stuck at
    status='running' with no completed_at. The dashboard's SWR poll keeps
    showing "Syncing" until the 60-min API-route watchdog catches it.
    Round 15 fix: at worker boot, mark any 'running' rows older than
    `threshold_minutes` (default 3 min) as error. The new process is a fresh
    incarnation; any pre-existing running row from before this boot is dead.

    Threshold rationale: 3 min is short enough for fast dashboard self-heal
    after a deploy, long enough to never race with a sync that THIS process
    just started (run_pipeline inserts the row before any subprocess work,
    so the row is <1s old at insert time; 3 min is comfortable buffer).

    Also fails dangling creator_runs (status pending/running) under each
    cleared sync_run so per-creator UI status doesn't lag.

    Returns: {"cleared_runs": int, "cleared_creator_runs": int}
    """
    db = get_db()
    cutoff = (utcnow() - timedelta(minutes=threshold_minutes)).isoformat()
    stale = (db.table("sync_runs").select("id, started_at")
             .eq("status", "running")
             .lt("started_at", cutoff)
             .execute().data or [])
    if not stale:
        return {"cleared_runs": 0, "cleared_creator_runs": 0}

    now_iso = utcnow_iso()
    sync_msg = (
        f"Auto-cleared at worker startup: row was 'running' but worker "
        f"process is starting fresh (likely killed by Render redeploy "
        f"or container restart). >{threshold_minutes} min old."
    )
    cr_msg = "Cleared with parent sync_run at worker startup"

    cleared_crs = 0
    for r in stale:
        # Fail dangling creator_runs first so they don't briefly appear
        # orphaned (status running/pending with a parent sync_run=error).
        cr_rows = (db.table("creator_runs").select("id")
                   .eq("sync_run_id", r["id"])
                   .in_("status", ["pending", "running"])
                   .execute().data or [])
        for cr in cr_rows:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": now_iso,
                "error_message": cr_msg,
            }).eq("id", cr["id"]).execute()
            cleared_crs += 1

        # Now mark the parent.
        db.table("sync_runs").update({
            "status": "error",
            "completed_at": now_iso,
            "error_message": sync_msg,
        }).eq("id", r["id"]).execute()

    return {"cleared_runs": len(stale), "cleared_creator_runs": cleared_crs}


def _process_one_creator(
    db,
    creator: dict,
    tiers: list[dict],          # Round 11: unused here; subprocess fetches its own
    creator_run_id: str,
) -> dict:
    """Run one creator's fetch + match in an ISOLATED Python subprocess.

    Round 11 (2026-05-18): subprocess isolation for hard memory bounding.
    Each creator gets its own Python interpreter (~70 MB baseline + ~50 MB
    working set = ~120 MB peak per subprocess). When the subprocess exits,
    the OS reclaims all heap memory. Across 49 creators sequentially, the
    parent process's RSS never grows beyond the single-subprocess peak.

    Solves the slow allocator-watermark growth that caused OOMs at ~42
    creators even on a 2 GB Render plan: Python's allocator does not
    actually return memory to the OS even after `gc.collect()` releases
    references, so a long-running 30-minute sync over 49 creators
    accumulates allocator state in the process's RSS until something
    gets killed.

    The subprocess itself writes the creator_runs status:
      - exit 0   = success;  row already updated to 'done' by subprocess
      - exit 1   = caught Python exception; row already 'failed' by subprocess
      - exit 2   = bad args / missing row (no work done)
      - timeout  = parent killed it; THIS function updates row to 'failed'
      - signal   = OOM-kill (-9) or segfault; THIS function updates row

    Returns a small dict describing the outcome for the parent's log line;
    the actual per-creator stats are persisted in creator_runs by the
    subprocess and re-read by run_pipeline below.
    """
    # `tiers` intentionally unused here; the subprocess does its own
    # `select * from payment_structure` (cheap query). Kept in the signature
    # for backward compat with the pre-Round-11 in-process call site.
    del tiers  # documentation-as-code

    cmd = [
        sys.executable,
        "-m", "worker.process_one_creator",
        creator["id"],
        creator_run_id,
    ]
    log.info("Spawning subprocess for creator %s (%s)",
             creator.get("name"), creator["id"][:8])

    try:
        # Round 12 patch (2026-05-22): stream subprocess stdout/stderr DIRECTLY
        # to the parent's file descriptors instead of capturing into memory.
        # Pre-patch, `capture_output=True` accumulated the full subprocess
        # output in parent's RSS until the subprocess exited. For chatty
        # creators (one creator's 170 videos × matcher candidate logs + cover-
        # fetch chatter), that buffer could reach 50-100MB per subprocess.
        # Across 49 sequential subprocesses with Python's allocator
        # fragmentation, parent RSS climbed monotonically until Render's
        # OOM-killer fired on the PARENT. Round 11's subprocess isolation
        # only protected the matcher's memory; this patch protects the
        # parent's. Render captures stdout/stderr natively from the parent's
        # process fds, so no log loss.
        result = subprocess.run(
            cmd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            timeout=PER_CREATOR_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        # Subprocess exceeded the 20-min wall-clock cap; Python's subprocess
        # module already killed it (SIGKILL after the timeout). The
        # subprocess did NOT reach its except handler, so we update the
        # creator_runs row here. (With streaming stdio there's no captured
        # stderr to attach; the actual stderr already went to Render logs.)
        msg = f"timeout after {PER_CREATOR_TIMEOUT_SEC}s"
        log.warning("Creator %s subprocess timed out", creator.get("id"))
        try:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": utcnow_iso(),
                "error_message": msg,
            }).eq("id", creator_run_id).execute()
        except Exception as db_err:
            log.warning("Failed to mark timeout in creator_runs: %s", db_err)
        return {"status": "failed", "reason": "timeout"}
    except FileNotFoundError as e:
        # sys.executable somehow points at a missing python binary - should
        # only happen in unusual container setups.
        msg = f"subprocess spawn failed (no python at {sys.executable}): {e}"
        log.exception(msg)
        try:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": utcnow_iso(),
                "error_message": msg[:2000],
            }).eq("id", creator_run_id).execute()
        except Exception:
            pass
        return {"status": "failed", "reason": "spawn_failed"}
    except Exception as e:
        # Catch-all so a parent-side problem doesn't kill the whole pipeline.
        log.exception("Subprocess spawn raised for creator %s", creator.get("id"))
        try:
            db.table("creator_runs").update({
                "status": "failed",
                "completed_at": utcnow_iso(),
                "error_message": f"parent spawn error: {str(e)[:1800]}",
            }).eq("id", creator_run_id).execute()
        except Exception:
            pass
        return {"status": "failed", "reason": "spawn_exception"}

    # NOTE: with streaming stdio (Round 12 patch), result.stdout/stderr are
    # both None - the subprocess wrote directly to the parent's fds, which
    # Render captures into its log dashboard. We rely on creator_runs rows
    # for structured outcome info; Render logs for free-form stderr details.

    if result.returncode == 0:
        return {"status": "done"}

    if result.returncode == 1:
        # Subprocess hit a Python exception, handled it, and wrote 'failed'
        # to creator_runs already. No additional DB update needed here.
        log.info("Creator %s subprocess exited 1 (handled exception)",
                 creator.get("id"))
        return {"status": "failed", "reason": "handled_exception"}

    if result.returncode == 2:
        # Bad args / missing row. Either the row doesn't exist or the
        # subprocess updated it before exiting. Don't override.
        log.warning("Creator %s subprocess exited 2 (bad args / missing)",
                    creator.get("id"))
        return {"status": "failed", "reason": "bad_args"}

    # Any other exit code (including negative = killed by signal). The
    # subprocess did NOT reach its except handler, so we update the row.
    # (No stderr tail to attach since stderr streamed directly to Render
    # without parent-side buffering. Check Render logs for the actual
    # failure detail at the timestamp around this row's completed_at.)
    if result.returncode < 0:
        sig = -result.returncode
        msg = f"subprocess killed by signal {sig}"
        if sig == 9:
            msg += " (likely OOM-killed; see Render logs for context)"
    else:
        msg = f"subprocess exited with code {result.returncode}"
    log.warning("Creator %s subprocess died: %s",
                creator.get("id"), msg)
    try:
        db.table("creator_runs").update({
            "status": "failed",
            "completed_at": utcnow_iso(),
            "error_message": msg[:2000],
        }).eq("id", creator_run_id).execute()
    except Exception as db_err:
        log.warning("Failed to mark crash in creator_runs: %s", db_err)
    return {"status": "failed", "reason": "crashed"}


def run_pipeline(kind: str = "cron", lock_check: bool = False) -> dict:
    """Full pipeline: refresh accounts cache, fetch + match per creator, snapshot, prune.

    Round 9 (2026-05-08): per-creator try/except isolation via creator_runs.
    Each creator gets its own row in creator_runs (pending -> running -> done/failed).
    A single creator's failure no longer kills the entire sync. Failed
    creators stay isolated; the next sync re-queues every active creator
    (including those that failed last time) so retries happen automatically.
    """
    db = get_db()
    started_at = utcnow_iso()

    # ---- ROUND 22 (2026-06-10): CONCURRENCY GUARD ----------------------------
    # Root cause of the June 10 data scramble: /sync (and creator-edit
    # auto-syncs) spawned a detached `cron_runner manual` subprocess on every
    # call with NO lock. Repeated clicks during a stuck window launched 7
    # pipelines that ran concurrently and raced on the per-creator
    # wipe-and-recreate matcher -> 14-17 creators failed per run from UNIQUE
    # collisions, groups churned, ingestion left half-done. This guard makes
    # run_pipeline single-flight across ALL entry points (manual /sync,
    # creator-edit auto-sync, AND the cron jobs, since they all land here).
    #
    # "Active" = a sync_runs row still 'running' that started within the
    # watchdog window. Genuinely-dead runs are cleared by the API-route
    # watchdog (60 min) and the worker-startup cleanup (3 min), after which
    # new runs proceed normally.
    _PIPELINE_ACTIVE_WINDOW_MIN = 60
    active_cutoff = (utcnow() - timedelta(minutes=_PIPELINE_ACTIVE_WINDOW_MIN)).isoformat()

    # (a) Fast path: if a non-stale run is already going, skip WITHOUT inserting
    # a row (no junk / no false "failed" in the dashboard).
    active = (db.table("sync_runs").select("id")
              .eq("status", "running")
              .gte("started_at", active_cutoff)
              .limit(1).execute().data or [])
    if active:
        log.warning("run_pipeline: a sync (%s) is already running; skipping this run (kind=%s)",
                    active[0]["id"], kind)
        return {"skipped": True, "reason": "another sync already running"}

    # Open sync_runs row
    sr = db.table("sync_runs").insert({
        "started_at": started_at,
        "status": "running",
        "kind": kind,
    }).execute()
    run_id = sr.data[0]["id"] if sr.data else None

    # (b) Race resolver for near-simultaneous starts (the storm spawned several
    # within the same second). After inserting, ask Postgres for the EARLIEST
    # still-running non-stale row (ordered by started_at, then id as a stable
    # tiebreak). If that winner isn't me, I lost the race -> delete my row and
    # bail. Exactly one run survives even if N start at once.
    winner = (db.table("sync_runs").select("id")
              .eq("status", "running")
              .gte("started_at", active_cutoff)
              .order("started_at").order("id")
              .limit(1).execute().data or [])
    if winner and run_id and winner[0]["id"] != run_id:
        # Lost the race. Remove my bare row (no creator_runs exist yet -> safe).
        db.table("sync_runs").delete().eq("id", run_id).execute()
        log.warning("run_pipeline: lost concurrency race to %s; aborting my run %s (kind=%s)",
                    winner[0]["id"], run_id, kind)
        return {"skipped": True, "reason": "lost concurrency race", "winner": winner[0]["id"]}
    # ---- end concurrency guard ----------------------------------------------

    stats = {
        "creators": 0, "videos": 0, "groups_created": 0, "groups_updated": 0,
        "snapshot_locked": None,
        "creators_failed": 0,
    }
    try:
        # Round 14 (2026-05-21): clear the unpaid-cycle floor cache so each
        # pipeline run recomputes the floor. Cheap: one query per sync.
        _reset_window_cache()

        # 1. Accounts cache
        try:
            refresh_accounts_cache()
        except Exception as e:
            log.warning("Accounts cache refresh failed: %s", e)

        # 2. Ensure cycles up to next month
        now_et = datetime.now(ET)
        target_y, target_m = now_et.year, now_et.month + 1
        if target_m > 12:
            target_y, target_m = target_y + 1, 1
        ensure_cycles_through(db, target_y, target_m)

        # 3. Enumerate active creators and queue creator_runs rows
        # Round 13: include 'name' in select so log lines show creator name
        # instead of 'None'. fetch_creator_videos also uses name for logs.
        creators = (db.table("creators")
                    .select("id, name, tiktok_handle, instagram_handle, youtube_handle, facebook_handle, arm")
                    .is_("deleted_at", "null").execute().data or [])

        creator_run_ids: dict[str, str] = {}
        for c in creators:
            cr = db.table("creator_runs").insert({
                "sync_run_id": run_id,
                "creator_id": c["id"],
                "status": "pending",
            }).execute()
            if cr.data:
                creator_run_ids[c["id"]] = cr.data[0]["id"]

        # Pre-load tiers once (used by matcher per creator). Cheap query.
        tiers = (db.table("payment_structure").select("*").execute().data or [])

        # 4. Process each creator sequentially in its own subprocess.
        # Round 11 (2026-05-18): each creator gets a fresh Python interpreter
        # via _process_one_creator → subprocess.run. The subprocess writes
        # status + stats to creator_runs itself; we re-read that row after
        # the subprocess returns to accumulate into the sync_runs aggregate.
        # Memory: bounded per-subprocess (~150 MB peak), reclaimed by OS on
        # subprocess exit. Parent process RSS stays small.
        for c in creators:
            cr_id = creator_run_ids.get(c["id"])
            if not cr_id:
                continue  # couldn't insert creator_runs row; skip safely

            # Spawn + wait. The function returns an outcome dict for logging;
            # actual per-creator counters were written to DB by the subprocess.
            _process_one_creator(db, c, tiers, cr_id)
            stats["creators"] += 1

            # Re-read the row to pick up whatever the subprocess (or our
            # crash-handler above) recorded. Single small query.
            row = (db.table("creator_runs")
                   .select("status, videos_fetched, groups_created, groups_updated")
                   .eq("id", cr_id)
                   .maybe_single()
                   .execute())
            if row and row.data:
                stats["videos"] += row.data.get("videos_fetched") or 0
                stats["groups_created"] += row.data.get("groups_created") or 0
                stats["groups_updated"] += row.data.get("groups_updated") or 0
                if row.data.get("status") == "failed":
                    stats["creators_failed"] += 1

        # 4b. ROUND 24 (2026-06-11): promote pending referrals. Runs every
        # pipeline (the practical superset of "at every generation of the
        # payment cycle") and BEFORE the snapshot-lock step so a bonus that
        # qualifies today is included if the cycle locks today.
        try:
            ref_stats = promote_referrals(db)
            if ref_stats.get("awarded") or ref_stats.get("auto_removed"):
                log.info("Referrals: %s", ref_stats)
        except Exception as e:
            log.warning("Referral promotion failed: %s", e)

        # 5. Snapshot-lock check
        if lock_check:
            now_et = datetime.now(ET)
            should, cycle_id = is_snapshot_day(now_et)
            if should and now_et.hour >= config.CRON_HOUR_DAILY_ET:
                lock_result = lock_snapshot_for_cycle(cycle_id)
                stats["snapshot_locked"] = lock_result

        # 6. Prune sync_runs once a day (we'll run it anytime; it's cheap)
        prune_sync_runs(90)

        # The sync as a whole succeeds even if some creators failed - the
        # frontend reads creator_runs to surface per-creator status. Only
        # truly catastrophic errors (db down, etc.) trip the outer except.
        if run_id:
            db.table("sync_runs").update({
                "completed_at": utcnow_iso(),
                "status": "success",
                "creators_processed": stats["creators"],
                "videos_fetched": stats["videos"],
                "videos_matched": stats["groups_created"] + stats["groups_updated"],
                "error_message": (
                    f"{stats['creators_failed']} creator(s) failed; see creator_runs"
                    if stats["creators_failed"] else None
                ),
            }).eq("id", run_id).execute()
    except Exception as e:
        error_message = str(e)
        log.exception("Pipeline failed")
        if run_id:
            db.table("sync_runs").update({
                "completed_at": utcnow_iso(),
                "status": "error",
                "error_message": error_message,
            }).eq("id", run_id).execute()
        raise

    return {"sync_run_id": run_id, **stats}
