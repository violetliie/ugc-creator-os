import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabase'
import { signToken, sessionCookieOptions } from '@/lib/auth'
import type { SessionUser } from '@/lib/types'

export const runtime = 'nodejs'   // bcrypt requires Node runtime

export async function POST(req: Request) {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, password_hash, role, creator_id, name, deleted_at')
      .ilike('email', String(email).trim())
      .is('deleted_at', null)
      .maybeSingle()

    if (error || !user) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
    }

    const valid = await bcrypt.compare(String(password), user.password_hash)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
    }

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      creator_id: user.creator_id,
      name: user.name,
    }

    const token = await signToken(sessionUser)
    const res = NextResponse.json({ ok: true, user: sessionUser })
    res.cookies.set(sessionCookieOptions(token))
    return res
  } catch (err) {
    console.error('[login]', err)
    return NextResponse.json({ error: 'Server error.' }, { status: 500 })
  }
}
