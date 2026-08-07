import { supabaseAdmin } from './supabase'
import type { SessionUser } from './types'

/**
 * Audit log writer. Server-side only. Fire-and-forget; do NOT block the
 * mutation API on the audit row succeeding.
 *
 * Conventions:
 *   action       = '{kind}.{verb}' lowercase, dotted, e.g. 'cycle.mark_paid'
 *   target_kind  = 'cycle' | 'creator' | 'user' | 'video_group' | 'hashtag'
 *                  | 'tier' | 'secret'
 *   target_id    = canonical id of the affected row (uuid or cycle id string)
 *   metadata     = anything contextual (before/after, amount, etc.)
 */
export async function recordAudit(opts: {
  actor: SessionUser
  action: string
  target_kind: string
  target_id?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  if (!supabaseAdmin) return
  try {
    await supabaseAdmin.from('audit_log').insert({
      actor_id: opts.actor.id,
      actor_email: opts.actor.email,
      actor_name: opts.actor.name,
      action: opts.action,
      target_kind: opts.target_kind,
      target_id: opts.target_id ?? null,
      metadata: opts.metadata ?? null,
    })
  } catch (err) {
    // Don't propagate; audit failure must not break the mutation.
    console.warn('[audit]', opts.action, err)
  }
}
