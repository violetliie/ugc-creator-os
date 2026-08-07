'use client'

import { useEffect, useRef, useState } from 'react'
import { useSyncRuns, refreshAll } from '@/lib/hooks'
import { fmtDateTimeET } from '@/lib/fmt'
import { useToast } from './ui/Toast'
import Icon from './ui/Icon'

/**
 * SyncNowButton renders the manual sync trigger PLUS a small status caption
 * showing last successful sync time (or live "Syncing..." when running, or
 * "Last sync failed" when errored). Used in Overview, Creators, Settings
 * (admin only).
 *
 * Design notes:
 *   - Caption sits to the LEFT of the button, single-line, muted small text.
 *   - When a sync is running we show a pulsing dot.
 *   - When the most recent run completes (status flips running -> success/error)
 *     we call refreshAll() so every SWR cache on the page revalidates and the
 *     dashboard reflects the new data without a manual reload (per user's
 *     "auto-trigger everywhere" requirement).
 */
export default function SyncNowButton() {
  const { push } = useToast()
  const { data: runs = [], mutate } = useSyncRuns(20)
  // `pendingSince` is the timestamp at which the user clicked Sync now. We
  // hold the button in "Syncing" state from this moment until either
  //   (a) SWR sees an actual `running` row appear (worker confirmed it inserted
  //       a sync_runs row), or
  //   (b) 30 seconds have elapsed (worker is unreachable / something failed).
  // Without this, the button briefly shows "Syncing" only while the fetch
  // promise is in-flight (~1s) and then flips back to "Sync now" because the
  // SWR cache hasn't yet seen the row the worker inserts in its background
  // task. The 5s SWR poll eventually catches up, but that gap looked like the
  // click did nothing.
  const [pendingSince, setPendingSince] = useState<number | null>(null)
  const prevRunningId = useRef<string | null>(null)

  // A row is treated as actually-running only if it started in the last hour.
  // If it's been 'running' >1h, the worker was almost certainly killed mid-pipeline
  // (Render OOM, container restart, etc.) and the row never got finalized. The
  // /api/sync-runs route also auto-cleans these server-side; this is a defense-
  // in-depth backstop so the UI doesn't get stuck even if the server cleanup
  // hasn't fired yet.
  const STALE_RUN_MS = 60 * 60 * 1000
  const PENDING_TIMEOUT_MS = 30_000
  const now = Date.now()
  const isRunning = runs.some(
    (r) => r.status === 'running' && now - new Date(r.started_at).getTime() < STALE_RUN_MS,
  )
  const isPending = pendingSince !== null && now - pendingSince < PENDING_TIMEOUT_MS
  const showSyncing = isRunning || isPending
  const lastSuccess = runs.find((r) => r.status === 'success')
  const mostRecent = runs[0]

  // When SWR catches up and sees the actual running row, clear pending so the
  // caption switches to driving from real data.
  useEffect(() => {
    if (pendingSince !== null && isRunning) {
      setPendingSince(null)
    }
  }, [isRunning, pendingSince])

  // While pending, mutate() repeatedly so SWR picks up the new sync_runs row
  // sooner than the 5s default poll. Stops once isRunning becomes true OR the
  // pending window expires.
  useEffect(() => {
    if (pendingSince === null) return
    const elapsed = Date.now() - pendingSince
    if (elapsed >= PENDING_TIMEOUT_MS) {
      setPendingSince(null)
      return
    }
    const t = setTimeout(() => mutate(), 1000)
    return () => clearTimeout(t)
  }, [pendingSince, runs, mutate])

  // When a previously-running run finishes (its id is no longer in 'running'
  // state), revalidate every SWR cache so the dashboard updates everywhere.
  useEffect(() => {
    const runningRow = runs.find((r) => r.status === 'running')
    if (runningRow) {
      prevRunningId.current = runningRow.id
      return
    }
    if (prevRunningId.current) {
      // We had a running row before, now no running row -> sync just finished.
      prevRunningId.current = null
      refreshAll()
    }
  }, [runs])

  let caption: { text: string; color: string; pulsing?: boolean }
  if (showSyncing) {
    caption = { text: 'Syncing', color: 'var(--warn)', pulsing: true }
  } else if (mostRecent && mostRecent.status === 'error') {
    caption = { text: 'Last sync failed', color: 'var(--negative)' }
  } else if (lastSuccess) {
    const ts = lastSuccess.completed_at || lastSuccess.started_at
    caption = { text: `Last synced ${fmtDateTimeET(ts)}`, color: 'var(--ink-3)' }
  } else {
    caption = { text: 'Never synced', color: 'var(--ink-3)' }
  }

  async function handleSync() {
    // Set pending IMMEDIATELY so the button visually flips to "Syncing" before
    // the network round-trip even completes. We keep it set until either SWR
    // shows a real running row (handled by useEffect) or the timeout fires.
    setPendingSince(Date.now())
    try {
      const r = await fetch('/api/sync', { method: 'POST', credentials: 'include' })
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        push('Sync started')
        mutate()
      } else {
        push(d.error || 'Failed to start sync')
        setPendingSince(null) // failed; don't pretend it's syncing
      }
    } catch {
      push('Sync request failed')
      setPendingSince(null)
    }
  }

  return (
    <div className="row" style={{ gap: 12, alignItems: 'center' }}>
      {/* ROUND 15: hide the caption while syncing — the button already shows
          "Syncing" with a lightning icon, so the orange dot+text on the left
          was redundant. Keep the caption for other states ("Last synced X",
          "Last sync failed", "Never synced") which are informational. */}
      {!showSyncing && (
        <span
          className="sync-caption"
          style={{ fontSize: 12, color: caption.color, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title={mostRecent?.error_message || ''}
        >
          {mostRecent?.status === 'error' && <span className="sync-dot" style={{ background: 'var(--negative)' }} />}
          {caption.text}
        </span>
      )}
      <button
        className="btn primary"
        onClick={handleSync}
        disabled={showSyncing}
        title={showSyncing ? 'A sync is already running' : 'Run the worker pipeline now'}
      >
        {/* ROUND 22: icon + label slow-blink together while syncing. */}
        <span
          className={showSyncing ? 'syncing-blink' : undefined}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Icon name="lightning" size={14} style={{ filter: 'invert(1)' }} />
          {showSyncing ? 'Syncing' : 'Sync now'}
        </span>
      </button>
    </div>
  )
}
