import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { triggerWorkerRecalc, triggerWorkerSync } from '@/lib/worker'
import { recordAudit } from '@/lib/audit'

/**
 * GET    /api/payment-structure        all tiers (auth required)
 * PUT    /api/payment-structure        admin: { id, amount }  update one tier amount
 *
 * On PUT, we trigger a recalculation of unpaid video_groups for that arm:
 * SQL that sets payout = computed_amount based on highest_views.
 * We do this in a single SQL via RPC OR re-fetch tiers and update each group.
 * For simplicity here we rely on the worker's next pipeline run to recalc;
 * for immediate UI feedback we trigger an inline recalc via a single update.
 */

export async function GET() {
  const { error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { data, error: dbErr } = await supabaseAdmin
    .from('payment_structure')
    .select('*')
    .order('arm')
    .order('sort_order')
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PUT(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id, amount, per_million } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (amount !== undefined) {
    const a = Number(amount)
    if (!Number.isFinite(a) || a < 0) {
      return NextResponse.json({ error: 'amount must be a non-negative number.' }, { status: 400 })
    }
    patch.amount = Math.round(a)
  }
  if (per_million !== undefined) {
    if (per_million === null) {
      patch.per_million = null
    } else {
      const p = Number(per_million)
      if (!Number.isFinite(p) || p < 0) {
        return NextResponse.json({ error: 'per_million must be a non-negative number or null.' }, { status: 400 })
      }
      patch.per_million = Math.round(p)
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update.' }, { status: 400 })
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('payment_structure')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  // Recalc unpaid groups for this arm + run a background sync so any UI
  // showing live amounts catches up. (Round 5 G5: every edit auto-syncs.)
  triggerWorkerRecalc(data.arm)
  triggerWorkerSync()

  recordAudit({
    actor: session,
    action: 'tier.update',
    target_kind: 'tier',
    target_id: String(id),
    metadata: { arm: data.arm, sort_order: data.sort_order, ...patch },
  })

  return NextResponse.json(data)
}
