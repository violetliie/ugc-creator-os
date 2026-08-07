'use client'

import { useMemo, useState } from 'react'
import { useCreators, useCycles, useCycleReferrals, useSnapshots, useVideoGroups, refreshAll } from '@/lib/hooks'
import { getDisplayCycle, fmtCycleShort } from '@/lib/cycles'
import { fmtMoney } from '@/lib/fmt'
import type { SessionUser } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import EmptyState from '@/components/ui/EmptyState'
import Badge from '@/components/ui/Badge'
import SearchInput from '@/components/ui/SearchInput'
import Modal from '@/components/ui/Modal'
import SyncNowButton from '@/components/SyncNowButton'
import CreatorDetails from './CreatorDetails'

interface Props {
  session: SessionUser
}

export default function CreatorsTab({ session }: Props) {
  const { push } = useToast()
  const isCreator = session.role === 'Creator'
  const { data: creators = [] } = useCreators()
  const { data: cycles = [], mutate: mutateCycles } = useCycles()
  const { data: snapshots = [], mutate: mutateSnaps } = useSnapshots()
  const { data: allGroups = [] } = useVideoGroups()

  const [filterCreator, setFilterCreator] = useState('all')
  const [search, setSearch] = useState('')
  const [detailsCreatorId, setDetailsCreatorId] = useState<string | null>(null)
  const [marking, setMarking] = useState<string | null>(null)

  const display = getDisplayCycle(cycles)

  const myCreator = isCreator
    ? creators.find((c) => c.id === session.creator_id)
    : null

  // ROUND 24: awarded referral bonuses landing in the displayed cycle.
  // Admin-only endpoint; pass null for the creator role so SWR skips the
  // fetch (the self-view's totals come from CreatorDetails instead).
  const { data: cycleReferrals = [] } = useCycleReferrals(
    !isCreator && display ? display.cycle.id : null,
  )

  // Per-creator current cycle payout (live, payable only — SHELVED ROUND 15)
  // ROUND 24: + referral bonuses landing in this cycle.
  const currentPayouts = useMemo(() => {
    if (!display) return {} as Record<string, number>
    const map: Record<string, number> = {}
    for (const g of allGroups) {
      if (g.cycle_id !== display.cycle.id) continue
      // SHELVED ROUND 15: cross_posted no longer gates payout.
      // if (!g.payable || !g.cross_posted) continue
      if (!g.payable) continue
      map[g.creator_id] = (map[g.creator_id] || 0) + Number(g.payout)
    }
    for (const r of cycleReferrals) {
      map[r.referrer_creator_id] = (map[r.referrer_creator_id] || 0) + Number(r.amount)
    }
    return map
  }, [allGroups, display, cycleReferrals])

  // All-time = sum of paid snapshots
  const allTimePayouts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const s of snapshots) {
      const c = cycles.find((cy) => cy.id === s.cycle_id)
      if (!c?.marked_paid_at && !s.marked_paid_at) continue
      map[s.creator_id] = (map[s.creator_id] || 0) + Number(s.amount)
    }
    return map
  }, [snapshots, cycles])

  async function markCreatorPaid(creatorId: string) {
    if (!display) return
    setMarking(creatorId)
    try {
      const r = await fetch(`/api/cycles/${display.cycle.id}/mark-creator-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ creator_id: creatorId }),
      })
      const d = await r.json()
      if (r.ok) {
        refreshAll()
        push('Marked creator as paid')
      } else {
        push(d.error || 'Failed')
      }
    } finally {
      setMarking(null)
    }
  }

  // ---------------- Creator role view ----------------
  if (isCreator) {
    if (!myCreator) {
      return (
        <div className="main">
          <EmptyState label="Creator not linked" hint="Ask an admin to link your account." />
        </div>
      )
    }
    return (
      <div className="main">
        <div className="page-head">
          <div className="row" style={{ gap: 16, alignItems: 'center' }}>
            <div className="page-title">My profile</div>
            {display && (
              <div className={`pay-bar${display.mode === 'upcoming' ? ' upcoming' : ''}`} style={{ flex: 0, padding: '10px 14px' }}>
                <div>
                  <div className="label">
                    {display.mode === 'upcoming' ? 'Upcoming cycle' : 'Current payment for'}
                  </div>
                  <div className="range" style={{ fontSize: 14 }}>{fmtCycleShort(display.cycle)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        {display && (
          <CreatorDetails
            creator={myCreator}
            cycle={display.cycle}
            cycles={cycles}
            snapshots={snapshots.filter((s) => s.creator_id === myCreator.id)}
            embedded
            /* ROUND 20 (2026-05-22): creator now has full bidirectional toggle
               on own videos (was 'unselect' / one-way in Round 19). When they
               re-select, the row gets a yellow background to mark the active
               affirmation (see VideoRow's isCreatorSelected styling). API
               still enforces ownership via session.creator_id. */
            permission="full"
          />
        )}
      </div>
    )
  }

  // ---------------- Admin view ----------------
  const visibleCreators = creators.filter((c) => !c.deleted_at)
  const rows = visibleCreators
    .filter((c) => filterCreator === 'all' || c.id === filterCreator)
    .filter((c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.paypal_email.toLowerCase().includes(search.toLowerCase()),
    )

  return (
    <div className="main">
      <div className="page-head">
        <div className="row" style={{ gap: 16, alignItems: 'center' }}>
          <div className="page-title">Creators</div>
          {display && (
            <div className={`pay-bar${display.mode === 'upcoming' ? ' upcoming' : ''}`} style={{ flex: 0, padding: '10px 14px' }}>
              <div>
                <div className="label">
                  {display.mode === 'upcoming' ? 'Upcoming cycle' : 'Current payment for'}
                </div>
                <div className="range" style={{ fontSize: 14 }}>{fmtCycleShort(display.cycle)}</div>
              </div>
            </div>
          )}
        </div>
        <SyncNowButton />
      </div>

      <div className="filter-bar">
        <div className="filter">
          <span className="lbl">Creator</span>
          <select value={filterCreator} onChange={(e) => setFilterCreator(e.target.value)}>
            <option value="all">All creators</option>
            {visibleCreators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search creators or emails" />
      </div>

      <div className="table-card">
        <div className="table-head">
          <h3>All creators</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          </span>
        </div>
        <div className="table-scroll">
          {rows.length === 0 ? (
            <EmptyState label="No creators match your filters" hint="Try clearing the search or filter." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Arm</th>
                  <th style={{ textAlign: 'right' }}>
                    {display?.mode === 'upcoming' ? 'Upcoming amount' : 'Current period'}
                  </th>
                  <th style={{ textAlign: 'right' }}>All time</th>
                  <th style={{ width: 240, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((creator) => {
                  const cyclePayout = currentPayouts[creator.id] || 0
                  const allTime = allTimePayouts[creator.id] || 0
                  const paidThisCycle = display
                    ? snapshots.some((s) =>
                        s.cycle_id === display.cycle.id &&
                        s.creator_id === creator.id &&
                        s.marked_paid_at)
                    : false
                  const cycleFullyPaid = display?.cycle.marked_paid_at != null
                  return (
                    <tr key={creator.id}>
                      <td>
                        <div className="col" style={{ gap: 0 }}>
                          <span style={{ fontWeight: 500 }}>{creator.name}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{creator.paypal_email}</span>
                        </div>
                      </td>
                      <td>
                        <Badge kind={`arm-${creator.arm.toLowerCase()}`}>{creator.arm}</Badge>
                      </td>
                      <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>
                        {cyclePayout > 0 ? fmtMoney(cyclePayout) : <span className="muted">$0</span>}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {allTime > 0 ? fmtMoney(allTime) : <span className="muted">$0</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setDetailsCreatorId(creator.id)}>Details</button>
                          <button
                            className="btn sm primary"
                            disabled={paidThisCycle || cycleFullyPaid || marking === creator.id || cyclePayout === 0}
                            onClick={() => markCreatorPaid(creator.id)}
                            title={cyclePayout === 0 ? 'No amount to pay' : ''}
                          >
                            {paidThisCycle ? 'Paid' : marking === creator.id ? '...' : 'Mark paid'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detailsCreatorId && display && (() => {
        const c = creators.find((c) => c.id === detailsCreatorId)
        if (!c) return null
        return (
          <Modal size="lg" title="Creator details" onClose={() => setDetailsCreatorId(null)}>
            <CreatorDetails
              creator={c}
              cycle={display.cycle}
              cycles={cycles}
              snapshots={snapshots.filter((s) => s.creator_id === c.id)}
              /* permission defaults to 'full' (admin) — omit to use default */
            />
          </Modal>
        )
      })()}
    </div>
  )
}
