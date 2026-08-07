'use client'

import { useMemo, useState } from 'react'
import { useCycleReferrals, useSnapshots, useVideoGroups, refreshAll } from '@/lib/hooks'
import { fmtCycle } from '@/lib/cycles'
import { fmtMoney } from '@/lib/fmt'
import type { Creator, PaymentCycle } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import Modal from '@/components/ui/Modal'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'
import Icon from '@/components/ui/Icon'

interface Props {
  cycle: PaymentCycle
  creators: Creator[]
  onClose: () => void
  onChanged: () => void
}

export default function PaymentDetailsModal({ cycle, creators, onClose, onChanged }: Props) {
  const { push } = useToast()
  const { data: groups = [] } = useVideoGroups(undefined, cycle.id)
  const { data: snapshots = [], mutate: mutateSnaps } = useSnapshots(cycle.id)
  const [marking, setMarking] = useState<string | null>(null)

  const isCyclePaid = !!cycle.marked_paid_at

  // ROUND 24: referral bonuses landing in this cycle. Live only for UNPAID
  // cycles — paid cycles read frozen snapshots, which already include them.
  const { data: cycleReferrals = [] } = useCycleReferrals(isCyclePaid ? null : cycle.id)

  // Build per-creator amounts.
  // - Paid cycle: read frozen snapshot.
  // - Unpaid cycle: compute live from video_groups (cross-post + payable rule).
  const rows = useMemo(() => {
    return creators
      .map((creator) => {
        let amount = 0
        if (isCyclePaid) {
          const snap = snapshots.find((s) => s.creator_id === creator.id)
          amount = snap ? Number(snap.amount) : 0
        } else {
          // SHELVED ROUND 15: cross_posted no longer gates payout.
          // Original: .filter((g) => g.creator_id === creator.id && g.payable && g.cross_posted)
          amount = groups
            .filter((g) => g.creator_id === creator.id && g.payable)
            .reduce((a, g) => a + Number(g.payout), 0)
          // ROUND 24: + referral bonuses landing in this cycle.
          amount += cycleReferrals
            .filter((r) => r.referrer_creator_id === creator.id)
            .reduce((a, r) => a + Number(r.amount), 0)
        }
        const snap = snapshots.find((s) => s.creator_id === creator.id)
        const paid = !!(snap && snap.marked_paid_at)
        return { creator, amount, paid }
      })
      .filter((r) => r.amount > 0)
  }, [creators, isCyclePaid, snapshots, groups])

  const pendingCount = rows.filter((r) => !r.paid).length
  const total = rows.reduce((a, r) => a + r.amount, 0)
  const pendingTotal = rows.filter((r) => !r.paid).reduce((a, r) => a + r.amount, 0)

  function exportCsv() {
    const lines = [['Creator', 'PayPal Email', 'Amount', 'Status'].join(',')]
    for (const r of rows) {
      lines.push([
        `"${r.creator.name.replace(/"/g, '""')}"`,
        r.creator.paypal_email,
        r.amount.toFixed(2),
        r.paid ? 'Paid' : 'Pending',
      ].join(','))
    }
    lines.push(['', '', total.toFixed(2), 'TOTAL'].join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `payouts-${cycle.id}.csv`
    a.click()
    URL.revokeObjectURL(url)
    push('Exported CSV')
  }

  async function markCreatorPaid(creatorId: string) {
    setMarking(creatorId)
    try {
      const r = await fetch(`/api/cycles/${cycle.id}/mark-creator-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ creator_id: creatorId }),
      })
      const d = await r.json()
      if (r.ok) {
        refreshAll()
        onChanged()
        push('Marked creator as paid')
      } else {
        push(d.error || 'Failed')
      }
    } finally {
      setMarking(null)
    }
  }

  return (
    <Modal
      size="md"
      title={`${isCyclePaid ? 'Paid:' : 'Current payment for'} ${fmtCycle(cycle)}`}
      sub={`${rows.length} creators · ${pendingCount} pending`}
      onClose={onClose}
      headerRight={
        <button className="btn" onClick={exportCsv}>
          <Icon name="arrow-up-right" size={14} />
          Export to CSV
        </button>
      }
      footer={
        <>
          <span className="muted" style={{ alignSelf: 'center', marginRight: 'auto', fontSize: 12 }}>
            Total of pending creators
          </span>
          <span className="mono" style={{ alignSelf: 'center', fontSize: 18, fontWeight: 500 }}>
            {fmtMoney(pendingTotal)}
          </span>
        </>
      }
    >
      <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 400 }}>
        <div className="table-scroll">
          {rows.length === 0 ? (
            <EmptyState label="No payouts in this cycle" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>PayPal email</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Status</th>
                  {!isCyclePaid && <th style={{ width: 110 }} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.creator.id}>
                    <td>
                      <div className="row">
                        <span style={{ fontWeight: 500 }}>{r.creator.name}</span>
                        <Badge kind={`arm-${r.creator.arm.toLowerCase()}`}>{r.creator.arm}</Badge>
                        {r.creator.deleted_at && <Badge kind="deleted">deleted</Badge>}
                      </div>
                    </td>
                    <td>
                      <a
                        className="paypal-link muted"
                        href={`https://www.paypal.com/myaccount/transfer/homepage/pay?contact=${encodeURIComponent(r.creator.paypal_email)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.creator.paypal_email}
                      </a>
                    </td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>
                      {fmtMoney(r.amount)}
                    </td>
                    <td>
                      {r.paid
                        ? <Badge kind="paid">Paid</Badge>
                        : <Badge kind="pending">Pending</Badge>}
                    </td>
                    {!isCyclePaid && (
                      <td style={{ textAlign: 'right' }}>
                        {!r.paid && (
                          <button
                            className="btn sm primary"
                            onClick={() => markCreatorPaid(r.creator.id)}
                            disabled={marking === r.creator.id}
                          >
                            {marking === r.creator.id ? '...' : 'Mark paid'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  )
}
