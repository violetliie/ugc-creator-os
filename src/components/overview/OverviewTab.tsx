'use client'

import { useMemo, useState } from 'react'
import { useCreators, useCycles, useSnapshots, useVideoGroups, refreshAll } from '@/lib/hooks'
import { getDisplayCycle, fmtCycle, fmtCycleShort } from '@/lib/cycles'
import { fmtMoney, compactNum, fmtDate } from '@/lib/fmt'
import { useToast } from '@/components/ui/Toast'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'
import Badge from '@/components/ui/Badge'
import SyncNowButton from '@/components/SyncNowButton'
import PaymentDetailsModal from './PaymentDetailsModal'

/**
 * Overview tab. Per design notes:
 *   - KPIs strictly count PAID cycles only.
 *   - Payment status bar shows current/upcoming based on getDisplayCycle.
 *   - Historical Payments shows only fully paid cycles, newest first.
 *   - Cross-post rule (R1) is enforced upstream by the worker; we just sum payouts here.
 */
export default function OverviewTab() {
  const { push } = useToast()
  const { data: creators = [] } = useCreators()
  const { data: cycles = [], mutate: mutateCycles } = useCycles()
  const { data: snapshots = [], mutate: mutateSnapshots } = useSnapshots()
  const { data: allGroups = [] } = useVideoGroups()

  const [filterCreator, setFilterCreator] = useState<string>('all')
  const [filterArm, setFilterArm] = useState<string>('all')
  const [filterStart, setFilterStart] = useState<string>('2026-04-16')
  const [filterEnd, setFilterEnd] = useState<string>('2026-12-31')
  const [showDetails, setShowDetails] = useState(false)
  const [marking, setMarking] = useState(false)

  const display = getDisplayCycle(cycles)

  /**
   * A cycle's content range is [period_start, period_end) in ET.
   * It overlaps with the user's [filterStart, filterEnd] iff:
   *   cycle_start_date <= filterEnd  AND  cycle_end_date_exclusive > filterStart
   * We compare 10-char date strings; cycle.period_start is ISO timestamptz
   * with midnight-ET wall-clock, so slicing first 10 chars gives the correct ET date.
   */
  function cycleInRange(cycleId: string): boolean {
    const cycle = cycles.find((c) => c.id === cycleId)
    if (!cycle) return false
    const startDate = cycle.period_start.slice(0, 10)
    const endExclusive = cycle.period_end.slice(0, 10)
    if (startDate > filterEnd) return false
    if (endExclusive <= filterStart) return false
    return true
  }

  // Filtered snapshots (KPI cost source)
  const filteredSnapshots = useMemo(() => {
    return snapshots.filter((s) => {
      const cycle = cycles.find((c) => c.id === s.cycle_id)
      if (!cycle?.marked_paid_at) return false
      if (!cycleInRange(s.cycle_id)) return false
      const creator = creators.find((c) => c.id === s.creator_id)
      if (!creator) return false
      if (filterCreator !== 'all' && s.creator_id !== filterCreator) return false
      if (filterArm !== 'all' && creator.arm !== filterArm) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots, cycles, creators, filterCreator, filterArm, filterStart, filterEnd])

  // Filtered groups for view counts (only paid cycles, payable only — SHELVED ROUND 15)
  const filteredGroups = useMemo(() => {
    return allGroups.filter((g) => {
      // SHELVED ROUND 15: cross_posted no longer gates payout.
      // if (!g.payable || !g.cross_posted) return false
      if (!g.payable) return false
      const cycle = cycles.find((c) => c.id === g.cycle_id)
      if (!cycle?.marked_paid_at) return false
      if (!cycleInRange(g.cycle_id)) return false
      if (filterCreator !== 'all' && g.creator_id !== filterCreator) return false
      const creator = creators.find((c) => c.id === g.creator_id)
      if (!creator) return false
      if (filterArm !== 'all' && creator.arm !== filterArm) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGroups, cycles, creators, filterCreator, filterArm, filterStart, filterEnd])

  const totalCost = filteredSnapshots.reduce((a, s) => a + Number(s.amount), 0)
  const totalViews = filteredGroups.reduce((a, g) => a + g.highest_views, 0)
  const cpm = totalViews > 0 ? (totalCost / totalViews) * 1000 : 0

  // Historical: only fully-paid cycles, newest first
  const historical = useMemo(() => {
    const out = cycles
      .filter((c) => c.marked_paid_at)
      .map((c) => {
        const total = snapshots
          .filter((s) => s.cycle_id === c.id)
          .reduce((a, s) => a + Number(s.amount), 0)
        return { cycle: c, paidOn: c.marked_paid_at!, total }
      })
      .sort((a, b) => b.cycle.period_start.localeCompare(a.cycle.period_start))
    return out
  }, [cycles, snapshots])

  async function handleMarkCyclePaid() {
    if (!display) return
    setMarking(true)
    try {
      const r = await fetch(`/api/cycles/${display.cycle.id}/mark-paid`, {
        method: 'POST',
        credentials: 'include',
      })
      const d = await r.json()
      if (r.ok) {
        refreshAll()
        push(`Marked ${fmtCycleShort(display.cycle)} as paid`)
      } else {
        push(d.error || 'Failed to mark as paid')
      }
    } finally {
      setMarking(false)
    }
  }

  function resetFilters() {
    setFilterCreator('all')
    setFilterArm('all')
    setFilterStart('2026-04-16')
    setFilterEnd('2026-12-31')
  }

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <div className="page-title">Overview</div>
        </div>
        <SyncNowButton />
      </div>

      {/* Filter bar */}
      <div className="filter-bar">
        <div className="filter">
          <span className="lbl">From</span>
          <input type="date" value={filterStart} onChange={(e) => setFilterStart(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" value={filterEnd} onChange={(e) => setFilterEnd(e.target.value)} />
        </div>
        <div className="filter">
          <span className="lbl">Creator</span>
          <select value={filterCreator} onChange={(e) => setFilterCreator(e.target.value)}>
            <option value="all">All creators</option>
            {creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.deleted_at ? ' (deleted)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="filter">
          <span className="lbl">Arm</span>
          <select value={filterArm} onChange={(e) => setFilterArm(e.target.value)}>
            <option value="all">All arms</option>
            <option value="Arm A">Arm A</option>
            <option value="Arm B">Arm B</option>
          </select>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={resetFilters}>Reset</button>
      </div>

      {/* KPI cards (paid-only) */}
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-lbl">Views</div>
          <div className="kpi-val">{compactNum(totalViews)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">Costs</div>
          <div className="kpi-val">{fmtMoney(totalCost)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-lbl">CPM</div>
          <div className="kpi-val">${cpm.toFixed(2)}</div>
        </div>
      </div>

      {/* Payment status bar */}
      {display && (
        <div className={`pay-bar${display.mode === 'upcoming' ? ' upcoming' : ''}`}>
          <div>
            <div className="label">
              {display.mode === 'upcoming' ? 'Upcoming payment cycle' : 'Current payment for'}
            </div>
            <div className="range">{fmtCycle(display.cycle)}</div>
          </div>
          {display.mode === 'upcoming' && (
            <span className="pill warn">Views lock {fmtDate(display.cycle.period_end)}</span>
          )}
          {display.mode === 'current' && (
            <span className="pill">Action required</span>
          )}
          <div className="right">
            <button className="btn" onClick={() => setShowDetails(true)}>
              <Icon name="info" size={14} />
              Payment details
            </button>
            {display.mode === 'current' && !display.cycle.marked_paid_at && (
              <button className="btn primary" onClick={handleMarkCyclePaid} disabled={marking}>
                <Icon name="check" size={14} style={{ filter: 'invert(1)' }} />
                {marking ? 'Marking' : 'Mark as paid'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Historical payments table */}
      <div className="table-card">
        <div className="table-head">
          <h3>Historical payments</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {historical.length} {historical.length === 1 ? 'cycle' : 'cycles'}
          </span>
        </div>
        <div className="table-scroll">
          {historical.length === 0 ? (
            <EmptyState label="No paid cycles yet" hint="Mark a current cycle as paid to populate history." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Payment cycle</th>
                  <th style={{ textAlign: 'right' }}>Total amount</th>
                  <th>Paid on</th>
                </tr>
              </thead>
              <tbody>
                {historical.map(({ cycle, paidOn, total }) => (
                  <tr key={cycle.id}>
                    <td>{fmtCycle(cycle)}</td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>
                      {fmtMoney(total)}
                    </td>
                    <td>
                      <Badge kind="paid">Paid · {fmtDate(paidOn)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showDetails && display && (
        <PaymentDetailsModal
          cycle={display.cycle}
          creators={creators}
          onClose={() => setShowDetails(false)}
          onChanged={() => refreshAll()}
        />
      )}
    </div>
  )
}
