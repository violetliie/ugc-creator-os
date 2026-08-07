import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { triggerWorkerSync } from '@/lib/worker'
import { normalizeTag, isValidTag } from '@/lib/hashtags'
import { recordAudit } from '@/lib/audit'
import type { Arm, HashtagWithAssignments } from '@/lib/types'

/**
 * GET    /api/hashtags                         list with assignments + effective creator counts
 * POST   /api/hashtags                         create + auto-sync
 *   body: { tag, arms: Arm[], creator_ids: string[] }   require >=1 of arms or creator_ids
 * DELETE /api/hashtags?id=<uuid>               hard delete + cascade + auto-sync
 */

interface AssignmentRow {
  hashtag_id: string
  arm?: Arm
  creator_id?: string
}

export async function GET() {
  const { error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { data: tags, error: dbErr } = await supabaseAdmin
    .from('hashtags')
    .select('*')
    .order('created_at', { ascending: false })
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  if (!tags || tags.length === 0) return NextResponse.json([])

  const ids = tags.map((t) => t.id)
  const { data: armRows } = await supabaseAdmin
    .from('hashtag_arm_assignments')
    .select('hashtag_id, arm')
    .in('hashtag_id', ids)
  const { data: creatorRows } = await supabaseAdmin
    .from('hashtag_creator_assignments')
    .select('hashtag_id, creator_id')
    .in('hashtag_id', ids)
  const { data: creators } = await supabaseAdmin
    .from('creators')
    .select('id, arm, deleted_at')
    .is('deleted_at', null)

  const armByTag = new Map<string, Arm[]>()
  for (const r of (armRows ?? []) as AssignmentRow[]) {
    if (!r.arm) continue
    if (!armByTag.has(r.hashtag_id)) armByTag.set(r.hashtag_id, [])
    armByTag.get(r.hashtag_id)!.push(r.arm)
  }
  const creatorByTag = new Map<string, string[]>()
  for (const r of (creatorRows ?? []) as AssignmentRow[]) {
    if (!r.creator_id) continue
    if (!creatorByTag.has(r.hashtag_id)) creatorByTag.set(r.hashtag_id, [])
    creatorByTag.get(r.hashtag_id)!.push(r.creator_id)
  }

  const result: HashtagWithAssignments[] = tags.map((t) => {
    const arms = armByTag.get(t.id) || []
    const direct = new Set(creatorByTag.get(t.id) || [])
    // Effective creator count: union of direct + creators in any assigned arm
    const effective = new Set<string>(direct)
    for (const c of creators ?? []) {
      if (arms.includes(c.arm)) effective.add(c.id)
    }
    return {
      ...t,
      arms,
      creator_ids: Array.from(direct),
      effective_creator_count: effective.size,
    }
  })
  return NextResponse.json(result)
}

export async function POST(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const body = await req.json()
  const tagInput = String(body?.tag ?? '')
  const arms: Arm[] = Array.isArray(body?.arms) ? body.arms.filter((a: string) => a === 'Arm A' || a === 'Arm B') : []
  const creator_ids: string[] = Array.isArray(body?.creator_ids) ? body.creator_ids.filter((x: string) => typeof x === 'string') : []

  const tag = normalizeTag(tagInput)
  if (!isValidTag(tag)) {
    return NextResponse.json({ error: 'Hashtag must be alphanumeric or underscores only.' }, { status: 400 })
  }
  if (arms.length === 0 && creator_ids.length === 0) {
    return NextResponse.json({ error: 'Assign at least one arm or one creator.' }, { status: 400 })
  }

  // Check duplicate
  const { data: existing } = await supabaseAdmin
    .from('hashtags')
    .select('id')
    .eq('tag', tag)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'This hashtag already exists.' }, { status: 409 })
  }

  // Insert hashtag
  const { data: ins, error: insErr } = await supabaseAdmin
    .from('hashtags')
    .insert({ tag, created_by: session.id })
    .select()
    .single()
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  // Insert assignments
  if (arms.length > 0) {
    await supabaseAdmin
      .from('hashtag_arm_assignments')
      .insert(arms.map((a) => ({ hashtag_id: ins.id, arm: a })))
  }
  if (creator_ids.length > 0) {
    await supabaseAdmin
      .from('hashtag_creator_assignments')
      .insert(creator_ids.map((cid) => ({ hashtag_id: ins.id, creator_id: cid })))
  }

  // Auto-sync (G5)
  triggerWorkerSync()
  recordAudit({ actor: session, action: 'hashtag.create', target_kind: 'hashtag', target_id: ins.id, metadata: { tag, arms, creator_ids } })

  return NextResponse.json(ins, { status: 201 })
}

export async function DELETE(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error: dbErr } = await supabaseAdmin.from('hashtags').delete().eq('id', id)
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  triggerWorkerSync()
  recordAudit({ actor: session, action: 'hashtag.delete', target_kind: 'hashtag', target_id: id })
  return NextResponse.json({ ok: true })
}
