import type { Arm, PaymentStructureTier } from './types'

/**
 * Compute payout for a given view count and arm using the supplied tier list.
 *
 * Tiers MUST be sorted by sort_order ascending. The `views_to=null` tier is
 * treated as open-ended (Arm B 5M+). The Arm A 6M to 10M tier carries
 * `per_million=150` and is also implicitly capped at 10M = $2,400.
 *
 * Returns 0 for views < 1000 (per the design notes).
 */
export function payoutForViews(
  views: number,
  arm: Arm,
  tiers: PaymentStructureTier[],
): number {
  if (views < 1000) return 0
  const armTiers = tiers.filter((t) => t.arm === arm).sort((a, b) => a.sort_order - b.sort_order)
  if (armTiers.length === 0) return 0

  // Arm A: cap at 10M views (the design notes)
  const lastTier = armTiers[armTiers.length - 1]
  const cap = arm === 'Arm A' && lastTier.views_to ? lastTier.views_to : Infinity
  const effectiveViews = Math.min(views, cap)

  for (const t of armTiers) {
    const lo = t.views_from
    const hi = t.views_to ?? Infinity
    if (effectiveViews >= lo && effectiveViews <= hi) {
      if (t.per_million != null) {
        const extra = Math.floor((effectiveViews - t.views_from) / 1_000_000) * t.per_million
        return t.amount + extra
      }
      return t.amount
    }
  }
  // Above all tier ranges: use last tier's amount.
  return lastTier.amount
}

/**
 * Final group payout — SHELVED ROUND 15 (2026-05-21):
 *
 * Original rule (Round 4 R1):
 *   payable AND cross_posted -> tiered amount
 *   otherwise                 -> $0
 *
 * Cross-posted enforcement is shelved per user request. The matcher still
 * accurately populates `cross_posted` on each group, so this can be restored
 * by un-commenting the cross_posted clause below. The column remains
 * source-of-truth in DB; only payout consequence is disabled.
 */
export function groupPayout(
  views: number,
  arm: Arm,
  tiers: PaymentStructureTier[],
  cross_posted: boolean,
  payable: boolean,
): number {
  // SHELVED ROUND 15: cross_posted no longer gates payout.
  // if (!cross_posted || !payable) return 0
  if (!payable) return 0
  return payoutForViews(views, arm, tiers)
}

/**
 * Static fallback tiers. Used only as a last resort when the API
 * cannot be reached. The DB is the source of truth (Round 3 Q4).
 */
export const FALLBACK_TIERS: PaymentStructureTier[] = [
  // Arm A
  { id: 1,  arm: 'Arm A',   views_from: 1000,    views_to: 9999,    amount: 10,   per_million: null, sort_order: 1 },
  { id: 2,  arm: 'Arm A',   views_from: 10000,   views_to: 49999,   amount: 30,   per_million: null, sort_order: 2 },
  { id: 3,  arm: 'Arm A',   views_from: 50000,   views_to: 99999,   amount: 60,  per_million: null, sort_order: 3 },
  { id: 4,  arm: 'Arm A',   views_from: 100000,  views_to: 249999,  amount: 120,  per_million: null, sort_order: 4 },
  { id: 5,  arm: 'Arm A',   views_from: 250000,  views_to: 499999,  amount: 250,  per_million: null, sort_order: 5 },
  { id: 6,  arm: 'Arm A',   views_from: 500000,  views_to: 999999,  amount: 400,  per_million: null, sort_order: 6 },
  { id: 7,  arm: 'Arm A',   views_from: 1000000, views_to: 1999999, amount: 600,  per_million: null, sort_order: 7 },
  { id: 8,  arm: 'Arm A',   views_from: 2000000, views_to: 2999999, amount: 800,  per_million: null, sort_order: 8 },
  { id: 9,  arm: 'Arm A',   views_from: 3000000, views_to: 3999999, amount: 1000, per_million: null, sort_order: 9 },
  { id: 10, arm: 'Arm A',   views_from: 4000000, views_to: 4999999, amount: 1250, per_million: null, sort_order: 10 },
  { id: 11, arm: 'Arm A',   views_from: 5000000, views_to: 5999999, amount: 1600, per_million: null, sort_order: 11 },
  { id: 12, arm: 'Arm A',   views_from: 6000000, views_to: 10000000, amount: 1600, per_million: 200, sort_order: 12 },
  // Arm B
  { id: 13, arm: 'Arm B', views_from: 1000,    views_to: 9999,    amount: 10,   per_million: null, sort_order: 1 },
  { id: 14, arm: 'Arm B', views_from: 10000,   views_to: 49999,   amount: 25,   per_million: null, sort_order: 2 },
  { id: 15, arm: 'Arm B', views_from: 50000,   views_to: 99999,   amount: 50,   per_million: null, sort_order: 3 },
  { id: 16, arm: 'Arm B', views_from: 100000,  views_to: 249999,  amount: 100,  per_million: null, sort_order: 4 },
  { id: 17, arm: 'Arm B', views_from: 250000,  views_to: 499999,  amount: 200,  per_million: null, sort_order: 5 },
  { id: 18, arm: 'Arm B', views_from: 500000,  views_to: 999999,  amount: 350,  per_million: null, sort_order: 6 },
  { id: 19, arm: 'Arm B', views_from: 1000000, views_to: 4999999, amount: 500,  per_million: null, sort_order: 7 },
  { id: 20, arm: 'Arm B', views_from: 5000000, views_to: null,    amount: 1200, per_million: null, sort_order: 8 },
]
