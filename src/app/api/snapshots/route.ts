import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const cycleId = searchParams.get('cycle_id')
  const creatorId = searchParams.get('creator_id')

  let q = supabaseAdmin.from('payment_snapshots').select('*').order('generated_at', { ascending: false })
  if (cycleId) q = q.eq('cycle_id', cycleId)
  if (creatorId) q = q.eq('creator_id', creatorId)

  // Creator role: only their own snapshots
  if (session.role === 'Creator') {
    if (!session.creator_id) return NextResponse.json([])
    q = q.eq('creator_id', session.creator_id)
  }

  const { data, error: dbErr } = await q
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}
