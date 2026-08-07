import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'

// Round 9: don't start a new sync if one is already running. Two concurrent
// syncs would race on creator_runs row inserts and matcher's group rebuild,
// potentially producing duplicate or inconsistent state. Match the watchdog
// cutoff in /api/sync-runs (60min) so a stuck-running row eventually clears
// and unblocks new syncs.
const RUNNING_SYNC_CUTOFF_MIN = 60

/**
 * POST /api/sync   admin-only
 * Forwards a manual sync request to the Render worker. Returns immediately;
 * the worker writes a sync_runs row with kind='manual' that the UI polls
 * via /api/sync-runs.
 *
 * Returns 409 Conflict if another sync is already running (cron, or another
 * admin clicked at the same time). The frontend SyncNowButton already
 * disables itself in this case; this is the backend backstop.
 */
export async function POST() {
  const { error, status } = await requireSession({ adminOnly: true })
  if (error) return NextResponse.json({ error }, { status })

  const url = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET
  if (!url || !secret) {
    return NextResponse.json(
      { error: 'Worker is not configured (missing WORKER_URL or WORKER_SECRET).' },
      { status: 500 },
    )
  }

  // Concurrent sync prevention: check for an in-flight sync_runs row that
  // started within the watchdog window. Anything older is treated as stale
  // (the /api/sync-runs poll will auto-fail it on the next dashboard load).
  if (supabaseAdmin) {
    const cutoff = new Date(Date.now() - RUNNING_SYNC_CUTOFF_MIN * 60 * 1000).toISOString()
    const { data: running } = await supabaseAdmin
      .from('sync_runs')
      .select('id, started_at')
      .eq('status', 'running')
      .gte('started_at', cutoff)
      .limit(1)
    if (running && running.length > 0) {
      return NextResponse.json(
        {
          error: 'A sync is already in progress. Please wait for it to finish.',
          running_sync_id: running[0].id,
          running_since: running[0].started_at,
        },
        { status: 409 },
      )
    }
  }

  try {
    const r = await fetch(`${url}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
      body: JSON.stringify({ kind: 'manual' }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      return NextResponse.json({ error: data.error || `Worker returned ${r.status}` }, { status: 502 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[sync forward]', err)
    return NextResponse.json({ error: 'Worker is unreachable.' }, { status: 502 })
  }
}
