'use client'

import { useMemo, useState } from 'react'
import { useAuditLog } from '@/lib/hooks'
import { fmtDateTimeET } from '@/lib/fmt'
import EmptyState from '@/components/ui/EmptyState'
import Badge from '@/components/ui/Badge'
import SearchInput from '@/components/ui/SearchInput'

/**
 * Activity log: who did what + when. Polls every 10s; admin-only.
 * Shows up to 100 most-recent entries.
 */
export default function ActivityLogPane() {
  const { data: entries = [] } = useAuditLog(200)
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter) return entries
    const f = filter.toLowerCase()
    return entries.filter((e) =>
      (e.actor_name?.toLowerCase().includes(f)) ||
      (e.actor_email?.toLowerCase().includes(f)) ||
      e.action.toLowerCase().includes(f) ||
      e.target_kind.toLowerCase().includes(f) ||
      (e.target_id?.toLowerCase().includes(f)) ||
      (e.metadata && JSON.stringify(e.metadata).toLowerCase().includes(f)),
    )
  }, [entries, filter])

  return (
    <>
      <div className="filter-bar" style={{ marginTop: 4 }}>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by actor, action, target, payload" />
        <span className="muted" style={{ fontSize: 12 }}>
          Polls every 10s. Last 200 entries.
        </span>
      </div>

      <div className="table-card">
        <div className="table-head">
          <h3>Activity log</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <div className="table-scroll">
          {filtered.length === 0 ? (
            <EmptyState label="No entries" hint="Audit log captures every admin mutation." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTimeET(e.ts)}</td>
                    <td>
                      <div className="col" style={{ gap: 0 }}>
                        <span style={{ fontWeight: 500 }}>{e.actor_name || 'unknown'}</span>
                        <span className="muted" style={{ fontSize: 11 }}>{e.actor_email || ''}</span>
                      </div>
                    </td>
                    <td><Badge>{e.action}</Badge></td>
                    <td className="muted">
                      <span>{e.target_kind}</span>
                      {e.target_id && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-4)' }}>{e.target_id.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 11, fontFamily: "'Geist Mono', monospace", maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.metadata ? JSON.stringify(e.metadata) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}
