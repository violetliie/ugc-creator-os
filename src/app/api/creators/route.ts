import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { triggerWorkerSync } from '@/lib/worker'
import { recordAudit } from '@/lib/audit'

/**
 * GET    /api/creators                  list active (default) or all (?include_deleted=true)
 * POST   /api/creators                  admin: add creator (TT+IG handles required)
 * PUT    /api/creators                  admin: update creator (partial)
 * DELETE /api/creators?id=<uuid>        admin: SOFT delete (sets deleted_at)
 */

const PLATFORM_FIELDS = ['tiktok_handle', 'instagram_handle', 'youtube_handle', 'facebook_handle'] as const

function normHandle(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = String(s).trim().replace(/^@/, '')
  return trimmed || null
}

export async function GET(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const includeDeleted = searchParams.get('include_deleted') === 'true'

  let q = supabaseAdmin.from('creators').select('*').order('name')
  if (!includeDeleted) q = q.is('deleted_at', null)

  // Creator role: only see themselves
  if (session.role === 'Creator') {
    if (!session.creator_id) return NextResponse.json([])
    q = q.eq('id', session.creator_id)
  }

  const { data, error: dbErr } = await q
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const body = await req.json()
  const { name, arm, paypal_email, tiktok_handle, instagram_handle, youtube_handle, facebook_handle } = body

  if (!name || !arm || !paypal_email) {
    return NextResponse.json({ error: 'Name, arm, and PayPal email are required.' }, { status: 400 })
  }
  // SHELVED ROUND 15 (2026-05-21): cross-post rule no longer applies, so the
  // TT-and-IG-both-required gate from Round 4 R2 is replaced with
  // at-least-one-platform-required. Mirrors the frontend change in
  // src/components/settings/CreatorsEditPane.tsx::submit.
  // ROUND 21: Facebook counts as a valid platform for this check.
  if (!tiktok_handle && !instagram_handle && !youtube_handle && !facebook_handle) {
    return NextResponse.json({ error: 'At least one platform handle (TikTok, Instagram, YouTube, or Facebook) is required.' }, { status: 400 })
  }
  if (!['Arm A', 'Arm B'].includes(arm)) {
    return NextResponse.json({ error: 'Arm must be Arm A or Arm B.' }, { status: 400 })
  }

  // Validate handles against shortimize_accounts cache (Round 3 D8 / Q14)
  const { data: cache } = await supabaseAdmin
    .from('shortimize_accounts')
    .select('username, platform, removed')
    .in('platform', ['tiktok', 'instagram', 'youtube', 'facebook'])
    .eq('removed', false)

  const cacheLower = (cache ?? []).map((r) => `${r.platform}:${r.username.toLowerCase()}`)
  const missing: string[] = []
  if (tiktok_handle && !cacheLower.includes(`tiktok:${normHandle(tiktok_handle)!.toLowerCase()}`)) {
    missing.push('TikTok')
  }
  if (instagram_handle && !cacheLower.includes(`instagram:${normHandle(instagram_handle)!.toLowerCase()}`)) {
    missing.push('Instagram')
  }
  if (youtube_handle && !cacheLower.includes(`youtube:${normHandle(youtube_handle)!.toLowerCase()}`)) {
    missing.push('YouTube')
  }
  if (facebook_handle && !cacheLower.includes(`facebook:${normHandle(facebook_handle)!.toLowerCase()}`)) {
    missing.push('Facebook')
  }
  if (missing.length > 0) {
    return NextResponse.json({
      error: `${missing.join(', ')} handle not found on Shortimize. Please make sure the handle is linked on Shortimize first.`,
    }, { status: 400 })
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('creators')
    .insert({
      name: String(name).trim(),
      arm,
      paypal_email: String(paypal_email).trim(),
      tiktok_handle: normHandle(tiktok_handle),
      instagram_handle: normHandle(instagram_handle),
      youtube_handle: normHandle(youtube_handle),
      facebook_handle: normHandle(facebook_handle),
    })
    .select()
    .single()
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  // Auto-sync (Round 5 G5)
  triggerWorkerSync()
  recordAudit({ actor: session, action: 'creator.create', target_kind: 'creator', target_id: data.id, metadata: { name: data.name, arm: data.arm } })
  return NextResponse.json(data, { status: 201 })
}

export async function PUT(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const body = await req.json()
  const { id, ...updates } = body
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Build patch with normalization. Allow partial.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.name !== undefined) patch.name = String(updates.name).trim()
  if (updates.arm !== undefined) {
    if (!['Arm A', 'Arm B'].includes(updates.arm)) {
      return NextResponse.json({ error: 'Arm must be Arm A or Arm B.' }, { status: 400 })
    }
    patch.arm = updates.arm
  }
  if (updates.paypal_email !== undefined) patch.paypal_email = String(updates.paypal_email).trim()
  for (const f of PLATFORM_FIELDS) {
    if (updates[f] !== undefined) patch[f] = normHandle(updates[f])
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('creators')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  // Auto-sync after creator edit (e.g. arm change affects effective hashtags + tier).
  triggerWorkerSync()
  recordAudit({ actor: session, action: 'creator.update', target_kind: 'creator', target_id: id, metadata: patch })
  return NextResponse.json(data)
}

export async function DELETE(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Soft delete (Round 3 Q6, Round 4 F4): preserve historical data.
  const { error: dbErr } = await supabaseAdmin
    .from('creators')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  triggerWorkerSync()
  recordAudit({ actor: session, action: 'creator.delete', target_kind: 'creator', target_id: id })
  return NextResponse.json({ ok: true })
}
