import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * GET /api/creator-runs
 *
 * Round 9: per-creator sync status visibility.
 *
 * Query params:
 *   - sync_run_id: filter to one sync (most common use case for the
 *     activity log "expand sync" view)
 *   - creator_id: filter to one creator's history (most recent N rows)
 *   - status: filter to a specific status ('pending'|'running'|'done'|'failed')
 *   - limit: cap result count (default 100, max 500)
 *
 * Always returns rows sorted newest first by created_at. Joins creator
 * name + arm so the frontend can display a friendly label without a
 * second round trip.
 */
export async function GET(req: Request) {
  const { error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const syncRunId = searchParams.get('sync_run_id')
  const creatorId = searchParams.get('creator_id')
  const filterStatus = searchParams.get('status')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 500)

  let q = supabaseAdmin
    .from('creator_runs')
    .select(`
      id, sync_run_id, creator_id, status, started_at, completed_at,
      videos_fetched, groups_created, groups_updated, error_message, attempts,
      created_at,
      creator:creators(id, name, arm)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (syncRunId) q = q.eq('sync_run_id', syncRunId)
  if (creatorId) q = q.eq('creator_id', creatorId)
  if (filterStatus) q = q.eq('status', filterStatus)

  const { data, error: dbErr } = await q
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}
