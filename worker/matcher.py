"""Cross-platform video matching (Round 9: tiered + union-find + YT bridge).

Algorithm overview (design notes Section 25):

  1. For each creator, load all their videos (excluding paid-cycle frozen ones).
  2. Enumerate every cross-platform candidate pair, computing pair_strength()
     which returns (matched, tier, distance):
       Tier 1: phash <= PHASH_HAMMING_THRESHOLD (20),
               length within +/-LENGTH_TOLERANCE_SEC,
               |day_diff in ET| <= TIER1_MAX_DAY_DIFF (Round 10)
       Tier 2: 20 < phash <= PHASH_HAMMING_THRESHOLD_TIER2 (28),
               length within +/-LENGTH_TOLERANCE_TIER2 (1s),
               title similarity (YT-suffix-stripped Jaccard) >=
                 TITLE_SIMILARITY_THRESHOLD (0.30, Round 10),
               same ET calendar day
       Tier 0: not a match
  3. Sort candidates by (tier asc, distance asc) - strongest pairs first.
  4. Build groups via union-find with the constraint that no two videos from the
     same platform end up in one component. Strongest pairs claim their videos
     first; weaker overlapping pairs get rejected.
     This naturally handles the YT-bridge case: TT spider (d=8 to YT) and
     IG spider (d=16 to YT) both Tier-1-pair with the SAME YT, so the union
     puts all three in one component even though TT-IG direct distance is 24.
  5. Cycle-id of each group = earliest member's cycle (in ET).
  6. cross_posted = (has TT) AND (has IG); column populated but SHELVED ROUND 15
     (no longer gates payout — see worker/payout.py).
  7. PAID-CYCLE PROTECTION: never modify groups in cycles where marked_paid_at
     is set OR per-creator snapshot is paid.

This replaces the pre-Round-9 sequence-based greedy matcher whose iteration
order could miss the spider-style trio when TT-IG direct distance exceeded
the threshold even though both paired with the same YT.
"""
from __future__ import annotations
from datetime import datetime, timedelta, date
from collections import defaultdict
import logging
import re
from .db import get_db
from .cycles import cycle_id_for_datetime, cycle_id_for_date, ET, utcnow_iso
from .payout import group_payout
from . import config
from . import frame_extractor as fe

log = logging.getLogger(__name__)


# ---- Title similarity helper -----------------------------------------------

# Tokens of >=3 word characters, case-insensitive. Strips emojis (not \w),
# punctuation, and very-short stopwords like "is", "a", "of".
_TITLE_TOKEN_RE = re.compile(r"\w{3,}", re.UNICODE)

# Round 10 (2026-05-10): Shortimize's YT scrape routinely appends
# " @username NN [seconds|minutes|hours|days|weeks|months|years] ago" to YT
# titles. Stripping this before Jaccard tokenization dramatically improves
# title_similarity for legitimate cross-posts where TT/IG titles are clean
# but YT titles carry this auto-generated suffix. Example before/after:
#   YT: "is this trend over?? @someuser 9 days ago"
#   TT: "is this trend over??"
#   sim WITHOUT strip = 4 / (4 + 4) = 0.43  -> rejected at threshold 0.5
#   sim WITH strip    = 3 / 3            = 1.00 -> passes
_YT_SUFFIX_RE = re.compile(
    r"\s+@\S+\s+\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\s*$",
    re.IGNORECASE,
)


def title_similarity(a: str | None, b: str | None) -> float:
    """Jaccard similarity over >=3-char word tokens, lowercased.

    Used as Tier 2 supporting evidence: when phash is borderline (20-32) the
    matcher requires title overlap >= TITLE_SIMILARITY_THRESHOLD before
    pairing. Cross-platform same-video posts almost always reuse caption text
    (often verbatim or near-verbatim), so this is a strong disambiguator
    against accidental phash collisions on different videos.

    Strips Shortimize's YT-scrape suffix (' @username NN days ago' etc.)
    before tokenizing so YT titles compare cleanly against TT/IG titles.

    Returns 0.0 if either side is empty.
    """
    if not a or not b:
        return 0.0
    a = _YT_SUFFIX_RE.sub("", a)
    b = _YT_SUFFIX_RE.sub("", b)
    tokens_a = {t.lower() for t in _TITLE_TOKEN_RE.findall(a)}
    tokens_b = {t.lower() for t in _TITLE_TOKEN_RE.findall(b)}
    if not tokens_a or not tokens_b:
        return 0.0
    return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)


# ---- Robust ISO 8601 parsing -----------------------------------------------

# Supabase returns timestamps with variable-length fractional seconds, e.g.
# "2026-04-17T17:20:06.73931+00:00" (5 digits) which Python's standard
# fromisoformat rejects on Python <3.11. Normalize to 6 digits before parsing.
_FRAC_FIX_RE = re.compile(r"\.(\d+)([+-]\d{2}:\d{2})$")


def _parse_dt(s: str) -> datetime:
    """Parse ISO 8601 datetime string robustly across Supabase timestamp forms."""
    if not s:
        raise ValueError("empty datetime string")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    s = _FRAC_FIX_RE.sub(
        lambda m: f".{m.group(1)[:6]:0<6}{m.group(2)}", s
    )
    return datetime.fromisoformat(s)


# ---- Phash extraction (lazy + cached) --------------------------------------


def _ensure_phash(db, video: dict) -> str | None:
    """Return cached phash from DB, or extract via frame_extractor and persist.

    BUG FIX (2026-05-08): persists to DB AND updates the in-memory dict so
    repeat can_pair calls on the same video short-circuit on the first line.
    Without the dict update, multiple length-matching candidates would each
    re-trigger the network extraction, multiplying total HTTP work 3-5x.

    RESILIENCE (2026-05-08): exceptions during extraction or DB update are
    caught so a single bad video URL or transient supabase blip cannot
    propagate up and kill the entire matcher run. The video stays NULL on
    this run and gets retried next sync (extractors now have built-in retry
    too, so transient blips are much rarer).
    """
    if video.get("phash"):
        return video["phash"]
    if video.get("removed") or video.get("private"):
        return None
    try:
        phash = fe.extract_phash(video["ad_link"], video["platform"])
    except Exception as e:
        log.warning("phash extraction raised for %s (%s): %s",
                    video.get("ad_link"), video.get("platform"), e)
        return None
    if not phash:
        return None
    try:
        db.table("videos").update({"phash": phash}).eq("id", video["id"]).execute()
    except Exception as e:
        log.warning("phash DB update failed for %s: %s", video.get("id"), e)
    video["phash"] = phash
    return phash


# ---- Pair strength (the heart of the tiered matcher) -----------------------


def pair_strength(a: dict, b: dict, db) -> tuple[bool, int, int]:
    """Compute the matching strength between two videos.

    Returns (matched, tier, distance):
      tier 1: phash <= PHASH_HAMMING_THRESHOLD, length within +/-LENGTH_TOLERANCE_SEC
      tier 2: phash 20-PHASH_HAMMING_THRESHOLD_TIER2, length +/-LENGTH_TOLERANCE_TIER2,
              title similarity >= TITLE_SIMILARITY_THRESHOLD, same ET calendar day
      tier 0: not a match (returned as (False, 0, dist))

    Cross-platform pairs only - same-platform pairs are never matched (we
    return tier 0 immediately to keep video_groups one-per-platform).

    Side effects: lazy-extracts phashes for both videos via _ensure_phash.
    """
    if a["id"] == b["id"]:
        return False, 0, 64
    if a["platform"] == b["platform"]:
        return False, 0, 64

    # ROUND 17 (2026-05-21): use `posted_date` (the actual user-posted date)
    # for ALL day-distance checks, NOT `created_at_remote`.
    #
    # `created_at_remote` is when Shortimize first INDEXED the video, which
    # can lag the real upload by 1-5+ days (especially for IG). Example:
    # one creator's Apr 22 cross-platform pair had TT created_at_remote=Apr 22
    # but IG created_at_remote=Apr 25 — same actual upload day, but the
    # matcher saw day_diff=2 and failed BOTH Tier 1 (cap=1) and Tier 2
    # (must be same day), leaving 4 singleton groups when there should
    # have been 2 cross-platform pairs.
    #
    # DB-wide audit found 313 videos with skew >=2 days (10% of total) and
    # ~3790 potential missed cross-platform pairs caused by this bug.
    # posted_date comes from Shortimize's `uploaded_at` field and reflects
    # the actual user-posted date in a stable, platform-agnostic way.
    try:
        pa = a["posted_date"] if isinstance(a["posted_date"], date) else date.fromisoformat(a["posted_date"])
        pb = b["posted_date"] if isinstance(b["posted_date"], date) else date.fromisoformat(b["posted_date"])
    except Exception as e:
        log.warning("pair_strength posted_date parse failed: %s", e)
        return False, 0, 64
    day_diff = abs((pa - pb).days)
    # Broad cross-cycle reachability cap. Cross-posts in practice happen
    # within 0-1 days; >MATCH_WINDOW_DAYS apart is almost certainly
    # different videos that happen to share visual features.
    if day_diff > config.MATCH_WINDOW_DAYS:
        return False, 0, 64

    la = a.get("video_length")
    lb = b.get("video_length")
    if la is None or lb is None:
        return False, 0, 64
    length_diff = abs(int(la) - int(lb))
    if length_diff > config.LENGTH_TOLERANCE_SEC:
        return False, 0, 64

    ha = _ensure_phash(db, a)
    hb = _ensure_phash(db, b)
    if not ha or not hb:
        return False, 0, 64

    # YT-relaxed threshold applies whenever a YT video is involved (covers
    # diverge more for YT). Tier-1 default is 20 for all platforms; we keep
    # the YT_THRESHOLD config in case future tuning wants to differentiate.
    if a["platform"] == "youtube" or b["platform"] == "youtube":
        tier1_threshold = config.PHASH_HAMMING_THRESHOLD_YT
    else:
        tier1_threshold = config.PHASH_HAMMING_THRESHOLD

    d = fe.hamming_distance(ha, hb)

    # Tier 1: strict phash threshold; phash alone is sufficient evidence IF
    # the videos are temporally close.
    #
    # Round 10 (2026-05-10): added the |day_diff in ET| <= TIER1_MAX_DAY_DIFF
    # gate. Pre-Round-10, Tier 1 had NO date proximity check (only the broad
    # +/-MATCH_WINDOW_DAYS=10 window), which let unrelated videos posted 5-9
    # days apart accidentally pair when their covers happened to have similar
    # phash (e.g., greenscreen-format creators reusing the same backdrop).
    # Empirically 343 of 756 Tier 1 candidate pairs across the DB were >=2
    # days apart, and a sample showed nearly all were sim=0.00 false positives.
    # Cross-posts in practice happen within 0-1 days; cross-cycle legitimate
    # matches at 2+ days are rare enough to delegate to Tier 2 (which requires
    # same ET day plus title overlap as supporting evidence).
    if d <= tier1_threshold:
        if day_diff > config.TIER1_MAX_DAY_DIFF:
            return False, 0, d
        return True, 1, d

    # Tier 2: borderline phash (above tier1, below tier2 cap) requires
    # supporting evidence: tighter length match, same-day posting (ET), and
    # similar caption tokens. This catches cross-platform same-video pairs
    # whose covers were picked at different timestamps within the video
    # (1-2 seconds apart -> phash distance 20-28) without enabling false
    # positives on different videos. Same-video pairs at d > 28 (rare;
    # mostly YT cover divergence) are handled via the admin Link Post UI.
    if d > config.PHASH_HAMMING_THRESHOLD_TIER2:
        return False, 0, d
    if length_diff > config.LENGTH_TOLERANCE_TIER2:
        return False, 0, d

    # Same calendar day in ET. Cross-posts almost always happen on the same
    # day (within hours), so a date mismatch is a strong negative signal.
    if day_diff != 0:
        return False, 0, d

    # Title similarity. Cross-platform same-video posts virtually always
    # reuse caption text. Different videos by the same creator often have
    # different captions. Jaccard >= TITLE_SIMILARITY_THRESHOLD (default
    # 0.30) means at least ~30% of the meaningful tokens overlap, which
    # cleanly separates legitimate cross-posts (0.31+ verified across DB)
    # from sports/topic-coincidence false positives (all <=0.27 in DB).
    ts = title_similarity(a.get("title"), b.get("title"))
    if ts < config.TITLE_SIMILARITY_THRESHOLD:
        return False, 0, d

    return True, 2, d


# ---- Union-find for group assembly -----------------------------------------


class _UnionFind:
    """Small union-find with platform-conflict rejection.

    Each video starts in its own component. We try to union components via
    candidate pairs sorted strongest-first. A union is REJECTED if it would
    merge two components that both contain a video of the same platform
    (we never want two TT or two IG in one group).
    """

    def __init__(self, videos: list[dict]):
        self.parent = {v["id"]: v["id"] for v in videos}
        self.platforms = {v["id"]: {v["platform"]} for v in videos}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def try_union(self, a_id: str, b_id: str) -> bool:
        ra, rb = self.find(a_id), self.find(b_id)
        if ra == rb:
            return False  # already same
        plats_a = self.platforms[ra]
        plats_b = self.platforms[rb]
        if plats_a & plats_b:
            return False  # would put two same-platform videos in one group
        self.parent[ra] = rb
        self.platforms[rb] = plats_a | plats_b
        return True

    def components(self, videos: list[dict]) -> list[list[dict]]:
        groups: dict[str, list[dict]] = defaultdict(list)
        for v in videos:
            groups[self.find(v["id"])].append(v)
        return list(groups.values())


# ---- Main per-creator matcher ----------------------------------------------


def _paid_cycles_for_creator(db, creator_id: str, all_cycle_ids: set[str]) -> set[str]:
    """Compute the set of cycle_ids where this creator's videos are frozen.

    Includes BOTH:
      - Cycles with a non-null `marked_paid_at` (whole cycle paid)
      - Per-creator snapshots with non-null `marked_paid_at` (only this creator paid)

    Pre-Round-9 used a (cycle, creator) cache populated lazily; this is more
    efficient because we issue one query per source instead of N (one per video).
    """
    if not all_cycle_ids:
        return set()
    paid: set[str] = set()
    rows = (db.table("payment_cycles")
            .select("id, marked_paid_at")
            .in_("id", list(all_cycle_ids))
            .execute().data or [])
    for r in rows:
        if r.get("marked_paid_at"):
            paid.add(r["id"])
    snaps = (db.table("payment_snapshots")
             .select("cycle_id, marked_paid_at")
             .eq("creator_id", creator_id)
             .execute().data or [])
    for s in snaps:
        if s.get("marked_paid_at"):
            paid.add(s["cycle_id"])
    return paid


def match_for_creator(creator_id: str, tiers: list[dict], arm: str) -> dict:
    """Run matching for one creator. Returns {groups_created, groups_updated, members_added}.

    Round 9 (2026-05-08): the previous "find existing group, update or create"
    approach had a real correctness bug. Two new groups could fight over the
    same `existing_id` (when videos that were previously paired now belong in
    different components), causing one group to lose members or worse, the
    second update would attempt to insert a video into a group while the same
    video was still a member of a DIFFERENT group, violating
    UNIQUE(video_id) on video_group_members and crashing the matcher.

    Fix: wipe-and-recreate per creator, scoped to UNPAID groups only. Paid
    cycle groups stay frozen (paid-cycle protection). New groups are created
    fresh each run from union-find components. Stable group_id is sacrificed
    (each sync gets new UUIDs) but the data is correct and the audit_log
    treats target_id as a journal pointer not a relational reference.
    """
    db = get_db()
    stats = {"groups_created": 0, "groups_updated": 0, "members_added": 0}

    vres = db.table("videos").select(
        "id,creator_id,platform,ad_link,ad_id,title,posted_date,created_at_remote,"
        "video_length,latest_views,phash,private,removed,cycle_id,views_frozen,"
        "creator_selected"  # Round 20: video-level flag drives group.creator_selected in Phase 3
    ).eq("creator_id", creator_id).order("created_at_remote").execute()
    videos = vres.data or []
    if not videos:
        return stats

    # Compute the set of cycles this creator is frozen in (full-paid OR
    # per-creator snapshot paid). One pair of queries instead of N.
    cycle_ids_in_play: set[str] = {v["cycle_id"] for v in videos if v.get("cycle_id")}
    paid_cycles = _paid_cycles_for_creator(db, creator_id, cycle_ids_in_play)

    # Skip removed/private and skip videos already in paid cycles.
    by_platform: dict[str, list[dict]] = defaultdict(list)
    workable: list[dict] = []
    for v in videos:
        if v["removed"] or v["private"]:
            continue
        if v.get("cycle_id") in paid_cycles:
            continue
        by_platform[v["platform"]].append(v)
        workable.append(v)
    for plat in by_platform:
        by_platform[plat].sort(key=lambda x: x["created_at_remote"])

    # ---- Phase 0a (NEW): identify manual_link groups + pinned video ids ----
    # Round 11 (2026-05-15) fix: admin Link Post overrides set
    # video_groups.manual_link=true so this pass preserves them across syncs.
    # Their member videos are excluded from `workable` (so they don't get
    # re-paired by the automatic matcher) and the groups themselves are NOT
    # wiped. We DO recompute their highest_views / cross_posted / payout at
    # the end of the run from current view counts.
    creator_groups = (db.table("video_groups")
                      .select("id, cycle_id, manual_link, creator_unselected")
                      .eq("creator_id", creator_id)
                      .execute().data or [])
    # Round 19 (2026-05-22): pin groups marked manual_link OR creator_unselected.
    # Both flags signal "a human took control of this group; matcher must
    # preserve membership + payable across syncs". The set of preserved groups
    # is the union — internally they're handled identically by the wipe-and-
    # recreate logic, but we track each flag separately for audit clarity.
    preserved_group_ids = {
        g["id"] for g in creator_groups
        if (g.get("manual_link") or g.get("creator_unselected"))
        and g["cycle_id"] not in paid_cycles
    }
    pinned_video_ids: set[str] = set()
    if preserved_group_ids:
        pinned_rows = (db.table("video_group_members")
                       .select("video_id")
                       .in_("group_id", list(preserved_group_ids))
                       .execute().data or [])
        pinned_video_ids = {r["video_id"] for r in pinned_rows}

    # Filter workable to exclude pinned (manually-locked OR creator-unselected)
    # videos - they keep their existing group; the automatic matcher must not
    # touch them.
    workable = [v for v in workable if v["id"] not in pinned_video_ids]
    by_platform = defaultdict(list)
    for v in workable:
        by_platform[v["platform"]].append(v)
    for plat in by_platform:
        by_platform[plat].sort(key=lambda x: x["created_at_remote"])

    # ---- Phase 0b: wipe NON-preserved UNPAID groups ----
    # Paid groups stay frozen. manual_link AND creator_unselected groups stay
    # frozen (admin or creator override). video_group_members.group_id has
    # ON DELETE CASCADE so deleting from video_groups also drops the
    # membership rows. Run BEFORE the early-return on empty workable so we
    # always clean up stale auto-managed groups (e.g., if all the creator's
    # auto-managed videos became private since the last sync).
    unpaid_auto_group_ids = [
        g["id"] for g in creator_groups
        if g["cycle_id"] not in paid_cycles and g["id"] not in preserved_group_ids
    ]
    if unpaid_auto_group_ids:
        # Delete in batches of 100 to avoid hitting Supabase's URL length cap
        # on large IN(...) lists; in practice we have <100 groups per creator.
        for i in range(0, len(unpaid_auto_group_ids), 100):
            chunk = unpaid_auto_group_ids[i:i + 100]
            db.table("video_groups").delete().in_("id", chunk).execute()

    # Even if workable is empty, still proceed to recompute preserved groups
    # (their view counts may have refreshed since last sync).
    if not workable and not preserved_group_ids:
        return stats

    # ---- Phase 0c (ROUND 18, 2026-05-21): proactive phash extraction ----
    # Pre-Round-18, `_ensure_phash` was only called INSIDE `pair_strength`,
    # AFTER the date and length filters passed. That means a NULL-phash video
    # with NO cross-platform partner within length tolerance would NEVER have
    # its phash extracted — singleton platforms (creator with only TT, no
    # IG/YT) and length-outlier videos accumulated NULL phashes forever.
    # DB audit found 86 of 181 NULL-phash videos in this state (41 YT, 34 IG,
    # 11 TT). Many of them have LIVE pages/thumbnails — the extractor would
    # work, it just was never called.
    # Fix: walk every workable NULL-phash video before pair enumeration and
    # try extraction. Videos that already have phash short-circuit in
    # _ensure_phash on the first line, so this is cheap for the steady state.
    null_phash_workable = [v for v in workable if not v.get("phash")]
    if null_phash_workable:
        log.info("creator %s: pre-extracting phash for %d NULL-phash videos",
                 creator_id, len(null_phash_workable))
        for v in null_phash_workable:
            _ensure_phash(db, v)  # updates v["phash"] in place if successful

    # ---- Phase 1: enumerate all cross-platform candidate pairs ----
    # Sort by (tier asc, distance asc) so the strongest evidence forms groups
    # first. This is the global-best ordering that makes union-find converge
    # to the highest-confidence assignment.
    candidates: list[tuple[int, int, dict, dict]] = []
    # Round 21: all 6 unordered cross-platform pairs across the 4 platforms.
    # Facebook joins via the same union-find + pair_strength path; verified
    # that FB covers phash-match TT/IG/YT at Tier 1 so no special threshold
    # is needed. The union-find still rejects same-platform members, so a
    # group never holds two TT (or two FB) videos.
    plat_pairs = [
        ("tiktok", "instagram"), ("tiktok", "youtube"), ("instagram", "youtube"),
        ("tiktok", "facebook"), ("instagram", "facebook"), ("youtube", "facebook"),
    ]
    for plat_a, plat_b in plat_pairs:
        for a in by_platform.get(plat_a, []):
            for b in by_platform.get(plat_b, []):
                matched, tier, dist = pair_strength(a, b, db)
                if matched:
                    candidates.append((tier, dist, a, b))
    candidates.sort(key=lambda x: (x[0], x[1]))

    # ---- Phase 2: build groups via union-find ----
    uf = _UnionFind(workable)
    for tier, dist, a, b in candidates:
        uf.try_union(a["id"], b["id"])
    matched_groups = uf.components(workable)

    # ---- Phase 3: persist NEW groups (creates fresh; no update path) ----
    for grp_videos in matched_groups:
        # ROUND 18 (2026-05-21): cycle = cycle of earliest member's posted_date
        # (NOT created_at_remote). Same root cause as Round 17 — using the
        # Shortimize index timestamp can lag the actual upload by 1-5 days,
        # which misattributed any group with at least one late-indexed member
        # near a cycle boundary. Sort by posted_date with created_at_remote
        # as a stable secondary key (deterministic ordering for ties).
        grp_videos.sort(key=lambda v: (v["posted_date"], v["created_at_remote"]))
        earliest = grp_videos[0]
        try:
            pd_obj = earliest["posted_date"] if isinstance(earliest["posted_date"], date) else date.fromisoformat(earliest["posted_date"][:10])
            cycle_id = cycle_id_for_date(pd_obj)
        except Exception as e:
            log.warning("cycle id parse failed for %s: %s", earliest.get("id"), e)
            continue

        # Cross-cycle match into a paid cycle: SKIP. The would-be members
        # become singletons in their own cycles on subsequent matcher runs
        # (because their cycle_id stays at their original ingest value).
        if cycle_id in paid_cycles:
            continue

        platforms = {v["platform"] for v in grp_videos}
        cross_posted = ("tiktok" in platforms) and ("instagram" in platforms)
        highest_views = max(int(v.get("latest_views") or 0) for v in grp_videos)
        # ROUND 20 (2026-05-22): derive `creator_selected` from member videos.
        # If ANY member has creator_selected=true, the new group inherits the
        # flag. This is how the yellow-highlight UX persists through matcher
        # restructuring: creator selects group → video flags set → next sync
        # wipes + recreates → new group derives creator_selected=true from
        # member videos → yellow highlight reappears on the (possibly
        # restructured) group. No pinning required, so cross-platform
        # auto-pairing still works after a creator selects a singleton.
        creator_selected = any(bool(v.get("creator_selected")) for v in grp_videos)
        payout = group_payout(highest_views, arm, tiers, cross_posted, payable=True)

        ins = db.table("video_groups").insert({
            "creator_id": creator_id,
            "cycle_id": cycle_id,
            "posted_date": earliest["posted_date"],
            "highest_views": highest_views,
            "cross_posted": cross_posted,
            "payout": payout,
            "payable": True,
            "creator_selected": creator_selected,
        }).execute()
        new_id = ins.data[0]["id"] if ins.data else None
        if not new_id:
            continue
        for v in grp_videos:
            db.table("video_group_members").insert(
                {"group_id": new_id, "video_id": v["id"]}
            ).execute()
            stats["members_added"] += 1
        stats["groups_created"] += 1

        # Update each video's cycle_id to match the group's cycle.
        for v in grp_videos:
            if v.get("cycle_id") != cycle_id:
                db.table("videos").update({"cycle_id": cycle_id}).eq("id", v["id"]).execute()

    # ---- Phase 4 (Round 11, extended Round 19): recompute stats for
    # preserved groups (manual_link OR creator_unselected). MEMBERSHIPS are
    # preserved as the human set them, but highest_views / cross_posted /
    # payout still need refresh because view counts change between syncs
    # (and a manual group might have had a video added/removed by a later
    # admin action). The existing `payable` value is also preserved so a
    # creator's unselect (payable=false) survives across syncs.
    for mg_id in preserved_group_ids:
        mems = (db.table("video_group_members")
                .select("video_id")
                .eq("group_id", mg_id)
                .execute().data or [])
        if not mems:
            # Manual group is now empty (e.g., its only video was deleted/
            # private-flagged). Clean it up.
            db.table("video_groups").delete().eq("id", mg_id).execute()
            continue
        mvids = (db.table("videos")
                 .select("id, platform, latest_views, posted_date, created_at_remote, cycle_id")
                 .in_("id", [m["video_id"] for m in mems])
                 .execute().data or [])
        if not mvids:
            continue
        plats = {v["platform"] for v in mvids}
        cross_posted = ("tiktok" in plats) and ("instagram" in plats)
        highest = max(int(v.get("latest_views") or 0) for v in mvids)
        # ROUND 18: sort manual groups by posted_date too (same fix as above).
        earliest = sorted(mvids, key=lambda v: (v["posted_date"], v["created_at_remote"]))[0]
        try:
            pd_obj = earliest["posted_date"] if isinstance(earliest["posted_date"], date) else date.fromisoformat(earliest["posted_date"][:10])
            new_cycle = cycle_id_for_date(pd_obj)
        except Exception as e:
            log.warning("manual group cycle parse failed for %s: %s", mg_id, e)
            continue
        # Do not mutate if the group's earliest member now lands in a paid
        # cycle (shouldn't normally happen for an existing group, but be safe).
        if new_cycle in paid_cycles:
            continue
        # Preserve admin-set `payable` toggle (read current value).
        cur = (db.table("video_groups").select("payable")
               .eq("id", mg_id).maybe_single().execute())
        payable = bool(cur.data["payable"]) if cur and cur.data else True
        payout = group_payout(highest, arm, tiers, cross_posted, payable)
        db.table("video_groups").update({
            "cycle_id": new_cycle,
            "posted_date": earliest["posted_date"],
            "highest_views": highest,
            "cross_posted": cross_posted,
            "payout": payout,
            "last_updated_at": utcnow_iso(),
        }).eq("id", mg_id).execute()
        # Sync each member's cycle_id to the group's cycle.
        for v in mvids:
            if v.get("cycle_id") != new_cycle:
                db.table("videos").update({"cycle_id": new_cycle}).eq("id", v["id"]).execute()

    return stats


def match_all_creators() -> dict:
    """Run matcher across all active creators. Returns aggregate stats.

    Per-creator gc.collect() releases the working set (videos list, candidates
    list, union-find state) before processing the next creator. Keeps peak
    memory bounded on Render's 512MB starter plan.

    Note: scheduler.run_pipeline now wraps each creator's match in its own
    try/except so a failure on one creator doesn't kill the whole run; this
    function is preserved for backward compatibility with any callers that
    still want the simple "match everyone" entry point.
    """
    import gc
    db = get_db()
    stats = {"groups_created": 0, "groups_updated": 0, "members_added": 0, "creators": 0}
    tiers = (db.table("payment_structure").select("*").execute().data or [])
    creators = db.table("creators").select("id, arm").is_("deleted_at", "null").execute().data or []
    for c in creators:
        try:
            s = match_for_creator(c["id"], tiers, c["arm"])
            for k in ("groups_created", "groups_updated", "members_added"):
                stats[k] += s[k]
            stats["creators"] += 1
        except Exception as e:
            log.exception("match_for_creator failed for %s: %s", c["id"], e)
        gc.collect()
    return stats
