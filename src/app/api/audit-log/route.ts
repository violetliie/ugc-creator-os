import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * GET /api/audit-log?limit=N
 * Admin-only. Most recent first. No PII pruning needed (already authorized).
 */
export async function GET(req: Request) {
  const { error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 500)

  const { data, error: dbErr } = await supabaseAdmin
    .from('audit_log')
    .select('*')
    .order('ts', { ascending: false })
    .limit(limit)
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}
