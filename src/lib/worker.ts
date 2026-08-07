/**
 * Server-side helper for triggering the worker /sync endpoint.
 * Used after every admin mutation that affects payouts or what gets ingested
 * (per the design notes G5: "every edit triggers auto apply/refresh").
 *
 * Fire-and-forget: we don't await long-running work. The worker writes a
 * sync_runs row that the UI polls via useSyncRuns().
 */

export async function triggerWorkerSync(): Promise<void> {
  const url = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET
  if (!url || !secret) {
    console.warn('[triggerWorkerSync] WORKER_URL or WORKER_SECRET missing; skipping')
    return
  }
  try {
    // Don't await; just kick it off.
    fetch(`${url}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
      body: JSON.stringify({ kind: 'manual' }),
    }).catch((err) => console.warn('[triggerWorkerSync] fire-and-forget failed:', err))
  } catch (err) {
    console.warn('[triggerWorkerSync]', err)
  }
}

export async function triggerWorkerRecalc(arm?: string): Promise<void> {
  const url = process.env.WORKER_URL
  const secret = process.env.WORKER_SECRET
  if (!url || !secret) return
  try {
    fetch(`${url}/recalc${arm ? `?arm=${encodeURIComponent(arm)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
    }).catch(() => {})
  } catch {}
}
