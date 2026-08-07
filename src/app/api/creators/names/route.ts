import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * GET /api/creators/names  (Round 24)
 *
 * Minimal id+name list of ACTIVE creators for the referral dropdown.
 * Deliberately separate from GET /api/creators, which restricts the Creator
 * role to its own row (correct for full records — paypal emails, handles).
 * Picking someone you referred requires seeing names, and ONLY names, so
 * this endpoint exposes nothing else.
 */
export async function GET() {
  const { error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { data, error: dbErr } = await supabaseAdmin
    .from('creators')
    .select('id, name')
    .is('deleted_at', null)
    .order('name')
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
