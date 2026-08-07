import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'
import { checkReferralEligibility, pendingReason, REFERRAL_AMOUNT } from '@/lib/referrals'
import type { Referral, ReferralWithMeta } from '@/lib/types'

/**
 * Referral bonuses (Round 24, 2026-06-11). $75 to the referrer once the
 * referred creator hits 12 videos on their top platform (all-time in DB).
 *
 * GET    /api/referrals?creator_id=<uuid>   rows referred BY that creator,
 *        enriched with referred_name + pending progress. Creator role is
 *        always forced to their own creator_id.
 * GET    /api/referrals?cycle_id=<id>       admin only: all AWARDED rows whose
 *        awarded_cycle_id matches — the money surface used by the admin list,
 *        payment modal and mark-paid totals.
 * POST   /api/referrals { referred_creator_id, cycle_id }   Creator role only
 *        (referrals are creator input by spec). cycle_id = the DISPLAYED
 *        cycle ("this pay period"). Instant eligibility check: eligible ->
 *        status='awarded' landing in that same cycle; else 'pending'.
 * DELETE /api/referrals?id=<uuid>           creator (own rows) or admin.
 *        Sets status='removed' (kept for the admin's yellow "removed" row),
 *        frees the referred person for re-referral (partial unique index).
 *        Blocked once the awarded cycle is actually PAID (money already sent
 *        is never rewritten — same invariant as every other paid surface).
 */

async function enrich(rows: Referral[]): Promise<ReferralWithMeta[]> {
  if (!supabaseAdmin || rows.length === 0) return rows as ReferralWithMeta[]
  const ids = Array.from(new Set(rows.map((r) => r.referred_creator_id)))
  const { data: creators } = await supabaseAdmin
    .from('creators')
    .select('id, name')
    .in('id', ids)
  const nameById = new Map((creators ?? []).map((c) => [c.id, c.name]))

  const out: ReferralWithMeta[] = []
  for (const r of rows) {
    const referred_name = nameById.get(r.referred_creator_id) ?? 'Unknown creator'
    const row: ReferralWithMeta = { ...r, referred_name }
    if (r.status === 'pending') {
      try {
        const e = await checkReferralEligibility(supabaseAdmin, r.referred_creator_id)
        row.progress = { count: e.count, platform: e.platform, required: 12 }
      } catch {
        /* progress is best-effort; row still renders as pending */
      }
    }
    out.push(row)
  }
  return out
}

export async function GET(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const cycleId = searchParams.get('cycle_id')
  let creatorId = searchParams.get('creator_id')

  // Cycle-wide money view (all creators' awarded rows): admin only.
  if (cycleId && !creatorId) {
    if (session!.role !== 'Admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { data, error: dbErr } = await supabaseAdmin
      .from('referrals')
      .select('*')
      .eq('awarded_cycle_id', cycleId)
      .eq('status', 'awarded')
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
    return NextResponse.json(await enrich((data ?? []) as Referral[]))
  }

  // Per-referrer view. Creators may only read their own.
  if (session!.role === 'Creator') {
    if (!session!.creator_id) return NextResponse.json([])
    creatorId = session!.creator_id
  }
  if (!creatorId) {
    return NextResponse.json({ error: 'creator_id or cycle_id is required' }, { status: 400 })
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('referrals')
    .select('*')
    .eq('referrer_creator_id', creatorId)
    .order('created_at')
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(await enrich((data ?? []) as Referral[]))
}

export async function POST(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  // Referrals are creator input (the admin section is read/remove only).
  if (session!.role !== 'Creator' || !session!.creator_id) {
    return NextResponse.json({ error: 'Only creators can add referrals.' }, { status: 403 })
  }
  const referrerId = session!.creator_id

  const body = await req.json().catch(() => ({}))
  const referredId = body.referred_creator_id
  const cycleId = body.cycle_id
  if (!referredId || !cycleId) {
    return NextResponse.json({ error: 'referred_creator_id and cycle_id are required' }, { status: 400 })
  }
  if (referredId === referrerId) {
    return NextResponse.json({ error: 'You cannot refer yourself.' }, { status: 400 })
  }

  const { data: referred } = await supabaseAdmin
    .from('creators')
    .select('id, name, deleted_at')
    .eq('id', referredId)
    .maybeSingle()
  if (!referred || referred.deleted_at) {
    return NextResponse.json({ error: 'Referred creator not found.' }, { status: 404 })
  }

  const { data: cycle } = await supabaseAdmin
    .from('payment_cycles')
    .select('id')
    .eq('id', cycleId)
    .maybeSingle()
  if (!cycle) return NextResponse.json({ error: 'Unknown cycle.' }, { status: 400 })

  // One active referral per referred person, ever (first claim wins).
  const { data: existing } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .eq('referred_creator_id', referredId)
    .neq('status', 'removed')
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: `${referred.name} has already been referred by someone.` },
      { status: 409 },
    )
  }

  // Instant eligibility: >=12 videos on their top platform (all-time in DB).
  const elig = await checkReferralEligibility(supabaseAdmin, referredId)
  const now = new Date().toISOString()
  const insert: Record<string, unknown> = {
    referrer_creator_id: referrerId,
    referred_creator_id: referredId,
    referred_cycle_id: cycleId,
    amount: REFERRAL_AMOUNT,
    status: elig.eligible ? 'awarded' : 'pending',
  }
  if (elig.eligible) {
    // Instantly-eligible bonus lands in the entry ("this pay period") cycle.
    insert.awarded_cycle_id = cycleId
    insert.awarded_at = now
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('referrals')
    .insert(insert)
    .select()
    .single()
  if (dbErr) {
    // 23505 = the partial unique raced with a concurrent claim.
    if (dbErr.code === '23505') {
      return NextResponse.json(
        { error: `${referred.name} has already been referred by someone.` },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }

  recordAudit({
    actor: session,
    action: 'referral.create',
    target_kind: 'referral',
    target_id: data.id,
    metadata: {
      referrer_creator_id: referrerId,
      referred_creator_id: referredId,
      referred_cycle_id: cycleId,
      status: data.status,
      amount: REFERRAL_AMOUNT,
    },
  })

  const [row] = await enrich([data as Referral])
  if (row.status === 'pending') {
    return NextResponse.json(
      { ...row, pending_reason: pendingReason(referred.name, elig) },
      { status: 201 },
    )
  }
  return NextResponse.json(row, { status: 201 })
}

export async function DELETE(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: ref } = await supabaseAdmin
    .from('referrals')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 })

  const isAdmin = session!.role === 'Admin'
  if (!isAdmin && ref.referrer_creator_id !== session!.creator_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (ref.status === 'removed') {
    return NextResponse.json({ error: 'Already removed.' }, { status: 400 })
  }

  // Paid-cycle protection: once the awarded bonus was actually PAID OUT
  // (cycle marked paid, or the referrer individually paid for that cycle),
  // the money has left the building — removal is blocked, like every other
  // paid surface.
  if (ref.status === 'awarded' && ref.awarded_cycle_id) {
    const { data: cyc } = await supabaseAdmin
      .from('payment_cycles')
      .select('marked_paid_at')
      .eq('id', ref.awarded_cycle_id)
      .maybeSingle()
    const { data: snap } = await supabaseAdmin
      .from('payment_snapshots')
      .select('marked_paid_at')
      .eq('cycle_id', ref.awarded_cycle_id)
      .eq('creator_id', ref.referrer_creator_id)
      .maybeSingle()
    if (cyc?.marked_paid_at || snap?.marked_paid_at) {
      return NextResponse.json(
        { error: 'This referral bonus was already paid out; it can no longer be removed.' },
        { status: 400 },
      )
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from('referrals')
    .update({
      status: 'removed',
      removed_at: new Date().toISOString(),
      removed_by: isAdmin ? 'admin' : 'creator',
    })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  recordAudit({
    actor: session,
    action: 'referral.remove',
    target_kind: 'referral',
    target_id: id,
    metadata: {
      referrer_creator_id: ref.referrer_creator_id,
      referred_creator_id: ref.referred_creator_id,
      was_status: ref.status,
      removed_by: isAdmin ? 'admin' : 'creator',
    },
  })

  return NextResponse.json({ ok: true })
}
