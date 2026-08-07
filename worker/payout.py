"""Payout computation. Mirrors src/lib/payout.ts.

Cross-post rule (Round 4 R1): a video_group's payout is $0 unless it has BOTH
a TikTok member AND an Instagram member. Admin can also set payable=False to
zero a cross-posted group; a non-cross-posted group is $0 regardless.

ROUND 15 (2026-05-21): cross_posted enforcement SHELVED per user request.
The matcher still computes/stores cross_posted accurately on each group; the
column remains source-of-truth so we can restore the gate any time. Only the
PAYOUT consequence is disabled — a non-cross-posted group now pays its full
tiered amount (still gated by `payable`). To restore: uncomment the
`cross_posted` check in `group_payout()` below and re-enable the UI filters
in src/components/{creators,overview}/* (search "SHELVED ROUND 15").
"""
from __future__ import annotations


def payout_for_views(views: int, arm: str, tiers: list[dict]) -> int:
    """tiers: list of dicts {arm, views_from, views_to, amount, per_million, sort_order}."""
    if views < 1000:
        return 0
    arm_tiers = sorted([t for t in tiers if t["arm"] == arm], key=lambda t: t["sort_order"])
    if not arm_tiers:
        return 0
    last = arm_tiers[-1]
    cap = last["views_to"] if (arm == "Arm A" and last.get("views_to")) else float("inf")
    eff = min(views, cap)
    for t in arm_tiers:
        lo = t["views_from"]
        hi = t["views_to"] if t.get("views_to") is not None else float("inf")
        if eff >= lo and eff <= hi:
            if t.get("per_million") is not None:
                extra = (int(eff - t["views_from"]) // 1_000_000) * t["per_million"]
                return t["amount"] + extra
            return t["amount"]
    return last["amount"]


def group_payout(views: int, arm: str, tiers: list[dict], cross_posted: bool, payable: bool) -> int:
    # SHELVED ROUND 15 (2026-05-21): cross_posted no longer gates payout.
    # Keep the param in the signature so callers don't break; column is still
    # populated accurately by the matcher. To restore the cross-post rule,
    # change the line below back to `if not cross_posted or not payable:`.
    # if not cross_posted or not payable:
    if not payable:
        return 0
    return payout_for_views(views, arm, tiers)
