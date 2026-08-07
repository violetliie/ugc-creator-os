import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { triggerWorkerSync } from '@/lib/worker'
import { recordAudit } from '@/lib/audit'
import type { Arm } from '@/lib/types'

/**
 * PATCH /api/hashtags/{id}
 * Body: { add_arms?: Arm[], remove_arms?: Arm[], add_creator_ids?: string[], remove_creator_ids?: string[] }
 *
 * Edits assignments only. The tag string itself is immutable (delete and re-add to rename).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id } = await ctx.params
  const body = await req.json()

  const addArms: Arm[] = Array.isArray(body?.add_arms) ? body.add_arms.filter((a: string) => a === 'Arm A' || a === 'Arm B') : []
  const removeArms: Arm[] = Array.isArray(body?.remove_arms) ? body.remove_arms.filter((a: string) => a === 'Arm A' || a === 'Arm B') : []
  const addCreators: string[] = Array.isArray(body?.add_creator_ids) ? body.add_creator_ids : []
  const removeCreators: string[] = Array.isArray(body?.remove_creator_ids) ? body.remove_creator_ids : []

  if (addArms.length === 0 && removeArms.length === 0 && addCreators.length === 0 && removeCreators.length === 0) {
    return NextResponse.json({ error: 'No changes provided.' }, { status: 400 })
  }

  if (addArms.length > 0) {
    await supabaseAdmin
      .from('hashtag_arm_assignments')
      .upsert(addArms.map((a) => ({ hashtag_id: id, arm: a })), { onConflict: 'hashtag_id,arm' })
  }
  for (const a of removeArms) {
    await supabaseAdmin.from('hashtag_arm_assignments').delete().eq('hashtag_id', id).eq('arm', a)
  }
  if (addCreators.length > 0) {
    await supabaseAdmin
      .from('hashtag_creator_assignments')
      .upsert(addCreators.map((cid) => ({ hashtag_id: id, creator_id: cid })), { onConflict: 'hashtag_id,creator_id' })
  }
  if (removeCreators.length > 0) {
    await supabaseAdmin
      .from('hashtag_creator_assignments')
      .delete()
      .eq('hashtag_id', id)
      .in('creator_id', removeCreators)
  }

  triggerWorkerSync()
  recordAudit({
    actor: session,
    action: 'hashtag.update_assignments',
    target_kind: 'hashtag',
    target_id: id,
    metadata: { addArms, removeArms, addCreators, removeCreators },
  })

  // Validate that at least one assignment still exists. If both arms and
  // creators are now empty, we leave the hashtag (admin can re-assign or delete).
  return NextResponse.json({ ok: true })
}
