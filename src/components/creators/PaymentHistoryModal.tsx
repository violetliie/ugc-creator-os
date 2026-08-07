'use client'

import { useMemo } from 'react'
import { useCycles } from '@/lib/hooks'
import { fmtCycle } from '@/lib/cycles'
import { fmtMoney, fmtDate } from '@/lib/fmt'
import type { Creator, PaymentSnapshot } from '@/lib/types'
import Modal from '@/components/ui/Modal'
import EmptyState from '@/components/ui/EmptyState'

/**
 * Per Round 4 Q11: clicking the "All-time earned" stat card opens this modal.
 * Shows the creator's payment history, one row per paid cycle, newest first.
 */
interface Props {
  creator: Creator
  snapshots: PaymentSnapshot[]
  onClose: () => void
}

export default function PaymentHistoryModal({ creator, snapshots, onClose }: Props) {
  const { data: cycles = [] } = useCycles()

  const rows = useMemo(() => {
    return snapshots
      .map((s) => {
        const cycle = cycles.find((c) => c.id === s.cycle_id)
        if (!cycle) return null
        // Only paid cycles (or per-creator paid)
        if (!cycle.marked_paid_at && !s.marked_paid_at) return null
        return { snap: s, cycle, paidOn: cycle.marked_paid_at || s.marked_paid_at! }
      })
      .filter((x): x is { snap: PaymentSnapshot; cycle: typeof cycles[number]; paidOn: string } => Boolean(x))
      .sort((a, b) => b.cycle.period_start.localeCompare(a.cycle.period_start))
  }, [snapshots, cycles])

  const total = rows.reduce((a, r) => a + Number(r.snap.amount), 0)

  return (
    <Modal
      size="md"
      title={`Payment history: ${creator.name}`}
      sub={`${rows.length} ${rows.length === 1 ? 'cycle' : 'cycles'} paid`}
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ alignSelf: 'center', marginRight: 'auto', fontSize: 12 }}>
            All time
          </span>
          <span className="mono" style={{ alignSelf: 'center', fontSize: 18, fontWeight: 500 }}>
            {fmtMoney(total)}
          </span>
        </>
      }
    >
      <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 420 }}>
        <div className="table-scroll">
          {rows.length === 0 ? (
            <EmptyState label="No paid cycles yet" hint="Past payments will appear here." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Payment cycle</th>
                  <th>Paid on</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ snap, cycle, paidOn }) => (
                  <tr key={snap.id}>
                    <td>{fmtCycle(cycle)}</td>
                    <td className="muted">{fmtDate(paidOn)}</td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>
                      {fmtMoney(Number(snap.amount))}
                    </td>
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
