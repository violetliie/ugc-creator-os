import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'

/**
 * POST /api/cycles/{id}/mark-paid
 * Admin: marks the entire cycle as paid. Side effects:
 *   1. Set marked_paid_at = now() on the cycle.
 *   2. Freeze all videos in that cycle (views_frozen=true) to stop view refreshes.
 *   3. Ensure a payment_snapshots row exists for every creator with non-zero
 *      amount (the worker normally writes these at snapshot lock; if a manual
 *      mark-paid happens before the lock, we write them here from current
 *      live video_groups).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id: cycleId } = await ctx.params

  // 1. Mark cycle paid
  const now = new Date().toISOString()
  const { data: cycle, error: cycleErr } = await supabaseAdmin
    .from('payment_cycles')
    .update({ marked_paid_at: now, snapshot_generated_at: now })
    .eq('id', cycleId)
    .select()
    .single()
  if (cycleErr) return NextResponse.json({ error: cycleErr.message }, { status: 500 })

  // 2. Build per-creator payouts from current video_groups for this cycle
  const { data: groups } = await supabaseAdmin
    .from('video_groups')
    .select('creator_id, payout, payable, cross_posted')
    .eq('cycle_id', cycleId)

  const totals: Record<string, number> = {}
  for (const g of groups ?? []) {
    // SHELVED ROUND 15: cross_posted no longer gates payout.
    // if (!g.payable || !g.cross_posted) continue
    if (!g.payable) continue
    totals[g.creator_id] = (totals[g.creator_id] || 0) + Number(g.payout)
  }

  // ROUND 24: referral bonuses landing in this cycle count toward the
  // referrer's snapshot amount (so the actual PayPal payment includes them).
  const { data: cycleReferrals } = await supabaseAdmin
    .from('referrals')
    .select('referrer_creator_id, amount')
    .eq('awarded_cycle_id', cycleId)
    .eq('status', 'awarded')
  for (const r of cycleReferrals ?? []) {
    totals[r.referrer_creator_id] = (totals[r.referrer_creator_id] || 0) + Number(r.amount)
  }

  // 3. Upsert payment_snapshots
  const rows = Object.entries(totals)
    .filter(([, amt]) => amt > 0)
    .map(([creator_id, amount]) => ({
      cycle_id: cycleId,
      creator_id,
      amount,
      generated_at: now,
      marked_paid_at: now,
    }))

  if (rows.length > 0) {
    const { error: upErr } = await supabaseAdmin
      .from('payment_snapshots')
      .upsert(rows, { onConflict: 'cycle_id,creator_id' })
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  // 4. Freeze all videos in this cycle
  await supabaseAdmin
    .from('videos')
    .update({ views_frozen: true })
    .eq('cycle_id', cycleId)

  recordAudit({
    actor: session,
    action: 'cycle.mark_paid',
    target_kind: 'cycle',
    target_id: cycleId,
    metadata: { snapshots_written: rows.length, total_amount: rows.reduce((a, r) => a + Number(r.amount), 0) },
  })

  return NextResponse.json({ ok: true, cycle })
}
