import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

/**
 * Admin-only CRUD over users. Passwords stored as bcrypt hashes.
 * Soft delete (Round 3 Q6).
 */

export async function GET() {
  const { error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { data, error: dbErr } = await supabaseAdmin
    .from('users')
    .select('id, email, role, creator_id, name, deleted_at, created_at')
    .order('email')
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const { session, error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { email, password, role, creator_id, name } = await req.json()
  if (!email || !password || !role) {
    return NextResponse.json({ error: 'Email, password, and role are required.' }, { status: 400 })
  }
  if (!['Admin', 'Creator'].includes(role)) {
    return NextResponse.json({ error: 'Role must be Admin or Creator.' }, { status: 400 })
  }
  if (String(password).length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  const password_hash = await bcrypt.hash(String(password), 12)

  const { data, error: dbErr } = await supabaseAdmin
    .from('users')
    .insert({
      email: String(email).trim().toLowerCase(),
      password_hash,
      role,
      creator_id: creator_id || null,
      name: name || null,
    })
    .select('id, email, role, creator_id, name, deleted_at, created_at')
    .single()
  if (dbErr) {
    if (dbErr.code === '23505') return NextResponse.json({ error: 'Email already exists.' }, { status: 409 })
    return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }
  recordAudit({ actor: session, action: 'user.create', target_kind: 'user', target_id: data.id, metadata: { email: data.email, role: data.role } })
  return NextResponse.json(data, { status: 201 })
}

export async function PUT(req: Request) {
  const { error, status, session } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id, email, password, role, creator_id, name } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (email !== undefined) patch.email = String(email).trim().toLowerCase()
  if (password) {
    if (String(password).length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }
    patch.password_hash = await bcrypt.hash(String(password), 12)
  }
  if (role !== undefined) {
    if (!['Admin', 'Creator'].includes(role)) {
      return NextResponse.json({ error: 'Role must be Admin or Creator.' }, { status: 400 })
    }
    patch.role = role
  }
  if (creator_id !== undefined) patch.creator_id = creator_id || null
  if (name !== undefined) patch.name = name || null

  // Defensive: don't let an admin demote/lock themselves out.
  if (id === session.id && patch.role === 'Creator') {
    return NextResponse.json({ error: 'You cannot change your own role.' }, { status: 400 })
  }

  const { data, error: dbErr } = await supabaseAdmin
    .from('users')
    .update(patch)
    .eq('id', id)
    .select('id, email, role, creator_id, name, deleted_at, created_at')
    .single()
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  recordAudit({
    actor: session,
    action: 'user.update',
    target_kind: 'user',
    target_id: id,
    metadata: { fields_changed: Object.keys(patch).filter((k) => k !== 'password_hash'), password_changed: 'password_hash' in patch },
  })
  return NextResponse.json(data)
}

export async function DELETE(req: Request) {
  const { error, status, session } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (id === session.id) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 })
  }

  // Soft delete
  const { error: dbErr } = await supabaseAdmin
    .from('users')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  recordAudit({ actor: session, action: 'user.delete', target_kind: 'user', target_id: id })
  return NextResponse.json({ ok: true })
}
