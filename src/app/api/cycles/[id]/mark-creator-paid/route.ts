import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'

/**
 * POST /api/cycles/{cycle_id}/mark-creator-paid
 * Body: { creator_id: string }
 *
 * Per Round 3 Q8 + §16.I:
 *   1. Compute that creator's amount from current unpaid video_groups in cycle.
 *   2. Write payment_snapshots row with marked_paid_at = now().
 *   3. Freeze all of that creator's videos in this cycle (views_frozen=true).
 *   4. Auto-flip cycle to fully-paid if every creator with non-zero amount
 *      now has a marked_paid_at snapshot (Round 3 C5).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id: cycleId } = await ctx.params
  const { creator_id } = await req.json()
  if (!creator_id) return NextResponse.json({ error: 'creator_id is required' }, { status: 400 })

  // 1. Compute amount from current video_groups
  const { data: groups } = await supabaseAdmin
    .from('video_groups')
    .select('payout, payable, cross_posted')
    .eq('cycle_id', cycleId)
    .eq('creator_id', creator_id)

  let amount = 0
  for (const g of groups ?? []) {
    // SHELVED ROUND 15: cross_posted no longer gates payout.
    // if (!g.payable || !g.cross_posted) continue
    if (!g.payable) continue
    amount += Number(g.payout)
  }

  // ROUND 24: include this creator's referral bonuses landing in this cycle.
  const { data: myReferrals } = await supabaseAdmin
    .from('referrals')
    .select('amount')
    .eq('referrer_creator_id', creator_id)
    .eq('awarded_cycle_id', cycleId)
    .eq('status', 'awarded')
  for (const r of myReferrals ?? []) amount += Number(r.amount)

  const now = new Date().toISOString()

  // 2. Upsert snapshot
  const { error: upErr } = await supabaseAdmin
    .from('payment_snapshots')
    .upsert(
      { cycle_id: cycleId, creator_id, amount, generated_at: now, marked_paid_at: now },
      { onConflict: 'cycle_id,creator_id' },
    )
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  // 3. Freeze that creator's videos in this cycle
  await supabaseAdmin
    .from('videos')
    .update({ views_frozen: true })
    .eq('creator_id', creator_id)
    .eq('cycle_id', cycleId)

  // 4. Auto-flip cycle if every creator with non-zero amount is paid
  const { data: allGroups } = await supabaseAdmin
    .from('video_groups')
    .select('creator_id, payout, payable, cross_posted')
    .eq('cycle_id', cycleId)
  const totals: Record<string, number> = {}
  for (const g of allGroups ?? []) {
    // SHELVED ROUND 15: cross_posted no longer gates payout.
    // if (!g.payable || !g.cross_posted) continue
    if (!g.payable) continue
    totals[g.creator_id] = (totals[g.creator_id] || 0) + Number(g.payout)
  }
  // ROUND 24: referral bonuses count toward "who is owed money" for the
  // auto-flip check too (a referrer owed only a referral bonus must be paid
  // before the cycle flips to fully-paid).
  const { data: allCycleReferrals } = await supabaseAdmin
    .from('referrals')
    .select('referrer_creator_id, amount')
    .eq('awarded_cycle_id', cycleId)
    .eq('status', 'awarded')
  for (const r of allCycleReferrals ?? []) {
    totals[r.referrer_creator_id] = (totals[r.referrer_creator_id] || 0) + Number(r.amount)
  }
  const creatorsOwed = Object.keys(totals).filter((cid) => totals[cid] > 0)

  const { data: paidSnaps } = await supabaseAdmin
    .from('payment_snapshots')
    .select('creator_id, marked_paid_at')
    .eq('cycle_id', cycleId)
    .not('marked_paid_at', 'is', null)
  const paidIds = new Set((paidSnaps ?? []).map((s) => s.creator_id))

  const allDone = creatorsOwed.length > 0 && creatorsOwed.every((cid) => paidIds.has(cid))
  if (allDone) {
    await supabaseAdmin
      .from('payment_cycles')
      .update({ marked_paid_at: now, snapshot_generated_at: now })
      .eq('id', cycleId)
  }

  recordAudit({
    actor: session,
    action: 'creator.mark_paid',
    target_kind: 'creator',
    target_id: creator_id,
    metadata: { cycle_id: cycleId, amount, cycle_auto_flipped: allDone },
  })

  return NextResponse.json({ ok: true, cycle_paid_in_full: allDone, amount })
}
