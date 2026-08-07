// =============================================
// UGC CreatorOS  Shared TypeScript types
// Mirrors the schema in supabase/schema.sql.
// =============================================

export type Arm = 'Arm A' | 'Arm B'
export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'facebook'
export type UserRole = 'Admin' | 'Creator'
export type SyncStatus = 'running' | 'success' | 'error'
export type SyncKind = 'cron' | 'manual' | 'snapshot'

// ---- Database row types ----

export interface Creator {
  id: string
  name: string
  arm: Arm
  paypal_email: string
  tiktok_handle: string | null
  instagram_handle: string | null
  youtube_handle: string | null
  facebook_handle: string | null   // Round 21: Facebook Reels; optional
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
  password_hash?: string // server-side only; never serialize to client
  role: UserRole
  creator_id: string | null
  name: string | null
  deleted_at: string | null
  created_at: string
}

export interface PaymentCycle {
  id: string                      // 'YYYY-M-H'
  period_start: string            // ISO timestamptz, ET-zoned
  period_end: string              // exclusive
  payment_due_at: string          // 6 PM ET on the snapshot day
  snapshot_generated_at: string | null
  marked_paid_at: string | null
}

export interface Video {
  id: string
  creator_id: string
  platform: Platform
  ad_link: string
  ad_id: string | null
  shortimize_account_id: string | null
  title: string | null
  posted_date: string             // 'YYYY-MM-DD'
  created_at_remote: string       // ISO with TZ
  video_length: number | null
  latest_views: number
  views_frozen: boolean
  phash: string | null
  private: boolean
  removed: boolean
  cycle_id: string | null
  first_fetched_at: string
  last_refreshed_at: string
  shortimize_updated_at: string | null
}

export interface VideoGroup {
  id: string
  creator_id: string
  cycle_id: string
  posted_date: string
  highest_views: number
  cross_posted: boolean           // has TT AND has IG (Round 4 R1; SHELVED Round 15)
  payout: number
  payable: boolean
  manual_link?: boolean           // Round 11: admin Link Post override; matcher preserves
  creator_unselected?: boolean    // Round 19: creator opted out; matcher preserves (pinned)
  creator_selected?: boolean      // Round 20: creator affirmed payout; UI yellow highlight; matcher derives from members
  matched_at: string
  last_updated_at: string
}

export interface VideoGroupMember {
  group_id: string
  video_id: string
}

export interface PaymentSnapshot {
  id: string
  cycle_id: string
  creator_id: string
  amount: number
  generated_at: string
  marked_paid_at: string | null
}

export interface PaymentStructureTier {
  id: number
  arm: Arm
  views_from: number
  views_to: number | null
  amount: number
  per_million: number | null
  sort_order: number
}

export interface SyncRun {
  id: string
  started_at: string
  completed_at: string | null
  status: SyncStatus
  kind: SyncKind
  creators_processed: number
  videos_fetched: number
  videos_matched: number
  error_message: string | null
}

export interface SecretMeta {
  key: string
  updated_at: string
  updated_by_name: string | null
  char_length: number
}

// ---- Hashtags (Round 5) ----

export interface Hashtag {
  id: string
  tag: string                    // normalized lowercase, no leading #
  starting_on: string            // ISO timestamptz; only filters videos posted >= this
  created_at: string
  created_by: string | null
}

export interface HashtagArmAssignment {
  hashtag_id: string
  arm: Arm
}

export interface HashtagCreatorAssignment {
  hashtag_id: string
  creator_id: string
}

/** Enriched hashtag for the API list endpoint. */
export interface HashtagWithAssignments extends Hashtag {
  arms: Arm[]
  creator_ids: string[]
  effective_creator_count: number
}

/** Effective hashtag for a creator (used on Creator Details). */
export interface EffectiveHashtag {
  tag: string
  starting_on: string
}

// ---- Audit log ----

export interface AuditLogEntry {
  id: string
  ts: string
  actor_id: string | null
  actor_email: string | null
  actor_name: string | null
  action: string
  target_kind: string
  target_id: string | null
  metadata: Record<string, unknown> | null
}

// ---- Session / auth ----

export interface SessionUser {
  id: string
  email: string
  role: UserRole
  creator_id: string | null
  name: string | null
}

// ---- Enriched / API view types ----

export interface VideoGroupWithVideos extends VideoGroup {
  videos: Video[]
}

export interface CreatorPayoutSummary {
  creator: Creator
  current_period_amount: number   // live, from unpaid video_groups
  all_time_amount: number         // sum of paid snapshots
  cycle_paid: boolean             // is THIS creator individually paid for current cycle
}

export interface PaymentDetailRow {
  creator: Creator
  amount: number
  paid: boolean                   // per-creator paid for this cycle
}

// ---- Referrals (Round 24) ----

export type ReferralStatus = 'pending' | 'awarded' | 'removed'

export interface Referral {
  id: string
  referrer_creator_id: string
  referred_creator_id: string
  referred_cycle_id: string          // "period referred at" (displayed cycle at entry)
  status: ReferralStatus
  awarded_cycle_id: string | null    // cycle the $75 lands in (null while pending)
  amount: number
  created_at: string
  awarded_at: string | null
  removed_at: string | null
  removed_by: 'creator' | 'admin' | null  // null = system (referred creator deleted)
}

/** GET /api/referrals enrichment: name + live eligibility progress for pending rows. */
export interface ReferralWithMeta extends Referral {
  referred_name: string
  /** Only set for pending rows: progress toward the 12-video requirement. */
  progress?: { count: number; platform: string | null; required: number }
}

/** GET /api/creators/names — minimal list for the referral dropdown. */
export interface CreatorName {
  id: string
  name: string
}
