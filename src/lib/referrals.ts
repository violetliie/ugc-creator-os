import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Referral bonus rules (Round 24, 2026-06-11). Mirrored in the worker's
 * promotion step (worker/scheduler.py promote_referrals) — keep in sync.
 *
 * A referral pays the REFERRER a flat $75 once the REFERRED creator has
 * posted at least 12 videos on the platform they post the most on —
 * counted ALL-TIME across everything in our videos table (the only "overall"
 * data we have; the program floor is Apr 16, 2026), excluding videos flagged
 * removed or private.
 */
export const REFERRAL_AMOUNT = 75
export const REFERRAL_MIN_VIDEOS = 12

export interface ReferralEligibility {
  eligible: boolean
  /** Video count on the referred creator's top platform (all-time in DB). */
  count: number
  /** The top platform, or null if they have no videos at all. */
  platform: string | null
}

/**
 * Compute eligibility for a referred creator: max per-platform video count
 * (excluding removed/private) >= REFERRAL_MIN_VIDEOS.
 *
 * Paginates the videos query to dodge PostgREST's 1000-row default cap
 * (high-volume creators exceed it).
 */
export async function checkReferralEligibility(
  db: SupabaseClient,
  referredCreatorId: string,
): Promise<ReferralEligibility> {
  const counts: Record<string, number> = {}
  const PAGE = 1000
  let from = 0
  for (let safety = 0; safety < 50; safety++) {
    const { data, error } = await db
      .from('videos')
      .select('platform')
      .eq('creator_id', referredCreatorId)
      .eq('removed', false)
      .eq('private', false)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    for (const v of data ?? []) {
      counts[v.platform] = (counts[v.platform] || 0) + 1
    }
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  let platform: string | null = null
  let count = 0
  for (const [p, n] of Object.entries(counts)) {
    if (n > count) { count = n; platform = p }
  }
  return { eligible: count >= REFERRAL_MIN_VIDEOS, count, platform }
}

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook',
}

/** Human-readable "Bonus pending" reason shown next to a pending referral. */
export function pendingReason(name: string, e: ReferralEligibility): string {
  if (e.count === 0) {
    return `${name} has 0/${REFERRAL_MIN_VIDEOS} videos posted`
  }
  const plat = e.platform ? (PLATFORM_LABEL[e.platform] ?? e.platform) : 'their top platform'
  return `${name} has ${e.count}/${REFERRAL_MIN_VIDEOS} videos on ${plat}`
}
