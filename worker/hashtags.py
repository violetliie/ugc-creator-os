"""Hashtag filter for video ingestion.

Per the design notes:
  - A creator's effective hashtag set = (hashtags assigned to creator's arm)
                                       UNION (hashtags assigned directly).
  - A hashtag only applies to videos posted ON OR AFTER its `starting_on` date.
  - For each video, compute applicable_hashtags
    (those whose starting_on <= video.created_at_remote AND in effective set).
  - If applicable_hashtags is EMPTY: ingest with no caption filter.
  - Else: ingest iff video.title (case-insensitive) contains '#' + tag for some tag.
"""
from __future__ import annotations
from datetime import datetime
from typing import Iterable


def caption_matches(title: str | None, applicable_tags: Iterable[str]) -> bool:
    """Case-insensitive `#tag` literal substring match (Round 5 G1)."""
    if not title:
        return False
    lower = title.lower()
    for t in applicable_tags:
        if not t:
            continue
        if f"#{t.lower()}" in lower:
            return True
    return False


def fetch_creator_hashtag_rules(db, creator_id: str, arm: str) -> list[dict]:
    """Return list of {tag, starting_on (datetime aware)} that apply to this creator.

    Combines arm-wide and direct creator assignments. Doesn't filter by date here
    (that's per-video). Sorted by starting_on so callers can early-out.
    """
    # We could call the SQL helper effective_hashtags_for_creator, but for the
    # filtering loop we want it pre-loaded in memory. Two queries is fine.
    rows: list[dict] = []
    direct = db.table("hashtag_creator_assignments").select(
        "hashtag_id, hashtags(tag, starting_on)"
    ).eq("creator_id", creator_id).execute().data or []
    arm_rows = db.table("hashtag_arm_assignments").select(
        "hashtag_id, hashtags(tag, starting_on)"
    ).eq("arm", arm).execute().data or []

    seen: set[str] = set()
    for src in (direct, arm_rows):
        for r in src:
            h = r.get("hashtags") or {}
            tag = (h.get("tag") or "").lower()
            so = h.get("starting_on")
            if not tag or not so:
                continue
            if tag in seen:
                continue
            seen.add(tag)
            try:
                so_dt = datetime.fromisoformat(so.replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            rows.append({"tag": tag, "starting_on": so_dt})
    rows.sort(key=lambda x: x["starting_on"])
    return rows


def video_passes_filter(video_created_at_remote: datetime, video_title: str | None,
                        rules: list[dict]) -> bool:
    """Apply the hashtag filter to a single video. Returns True iff we should ingest."""
    applicable_tags = [r["tag"] for r in rules if r["starting_on"] <= video_created_at_remote]
    if not applicable_tags:
        return True
    return caption_matches(video_title, applicable_tags)
