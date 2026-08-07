import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

// Watchdog: how long after `started_at` we treat a still-'running' row as
// definitely-killed. Render web/cron processes can be OOM-killed mid-pipeline
// before scheduler.run_pipeline reaches its except handler, leaving the row
// stuck. Any new sync legitimately runs in well under an hour.
const STALE_RUN_AFTER_MIN = 60

export async function GET(req: Request) {
  const { error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  // Step 1: mark any stale-'running' rows as 'error' before reading.
  // Idempotent and cheap; runs every poll but only matches stuck rows.
  const cutoff = new Date(Date.now() - STALE_RUN_AFTER_MIN * 60 * 1000).toISOString()
  await supabaseAdmin
    .from('sync_runs')
    .update({
      status: 'error',
      completed_at: new Date().toISOString(),
      error_message: `Auto-marked: still 'running' >${STALE_RUN_AFTER_MIN} min after start (worker process likely killed mid-run)`,
    })
    .eq('status', 'running')
    .lt('started_at', cutoff)

  // Round 9: same watchdog for creator_runs. A stuck creator_runs row
  // (status='running', started_at >60min ago) usually means the worker
  // crashed mid-creator. Auto-mark as 'failed' so the next sync legitimately
  // re-attempts that creator without the dashboard showing a stale running.
  await supabaseAdmin
    .from('creator_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: `Auto-marked: still 'running' >${STALE_RUN_AFTER_MIN} min after start`,
    })
    .eq('status', 'running')
    .lt('started_at', cutoff)

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '10', 10) || 10, 200)

  const { data, error: dbErr } = await supabaseAdmin
    .from('sync_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(data)
}
