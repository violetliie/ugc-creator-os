'use client'

import { useMemo, useState } from 'react'
import { displayTag } from '@/lib/hashtags'
import { fmtDate } from '@/lib/fmt'
import type { Arm, Creator, HashtagWithAssignments } from '@/lib/types'
import { refreshAll } from '@/lib/hooks'
import { useToast } from '@/components/ui/Toast'
import Modal from '@/components/ui/Modal'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'

interface Props {
  hashtag: HashtagWithAssignments
  allCreators: Creator[]
  onClose: () => void
  onChanged: () => void
}

/**
 * Per the design notes G9:
 *  - Lists all creators effectively using this hashtag, sorted by Arm
 *  - X to remove a single creator (this only removes their direct assignment;
 *    if they're affected via arm-wide assignment, the X is disabled with a
 *    tooltip explaining)
 *  - "Add creator" top-right opens an inline picker
 */
export default function HashtagDetailsModal({ hashtag, allCreators, onClose, onChanged }: Props) {
  const { push } = useToast()
  const [adding, setAdding] = useState(false)
  const [busyCreator, setBusyCreator] = useState<string | null>(null)

  // Effective creators = direct assignments + creators in any assigned arm
  const directIds = new Set(hashtag.creator_ids)
  const effectiveCreators = useMemo(() => {
    const assignedArms = new Set<Arm>(hashtag.arms)
    return allCreators
      .filter((c) => directIds.has(c.id) || assignedArms.has(c.arm))
      .sort((a, b) => {
        if (a.arm !== b.arm) return a.arm.localeCompare(b.arm)
        return a.name.localeCompare(b.name)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCreators, hashtag])

  const armOnlyMessage = (creator: Creator) =>
    !directIds.has(creator.id) && hashtag.arms.includes(creator.arm)
      ? `This creator is included via the ${creator.arm} arm assignment. Remove the arm assignment or move them to the other arm.`
      : null

  async function removeCreator(creatorId: string) {
    setBusyCreator(creatorId)
    try {
      const r = await fetch(`/api/hashtags/${hashtag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ remove_creator_ids: [creatorId] }),
      })
      if (r.ok) {
        refreshAll()
        onChanged()
        push('Removed. Resyncing.')
      } else {
        const d = await r.json().catch(() => ({}))
        push(d.error || 'Failed')
      }
    } finally {
      setBusyCreator(null)
    }
  }

  async function addCreator(creatorId: string) {
    setBusyCreator(creatorId)
    try {
      const r = await fetch(`/api/hashtags/${hashtag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ add_creator_ids: [creatorId] }),
      })
      if (r.ok) {
        refreshAll()
        onChanged()
        push('Added. Resyncing.')
        setAdding(false)
      } else {
        const d = await r.json().catch(() => ({}))
        push(d.error || 'Failed')
      }
    } finally {
      setBusyCreator(null)
    }
  }

  // Candidate set for "Add creator": all creators NOT effectively assigned
  const effectiveIds = new Set(effectiveCreators.map((c) => c.id))
  const candidates = allCreators
    .filter((c) => !effectiveIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Modal
      size="md"
      title={`${displayTag(hashtag.tag)} details`}
      sub={`Starting on ${fmtDate(hashtag.starting_on)} · ${effectiveCreators.length} creators · ${hashtag.arms.length} arm${hashtag.arms.length === 1 ? '' : 's'}`}
      onClose={onClose}
      headerRight={
        <button className="btn primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add creator'}
        </button>
      }
    >
      {hashtag.arms.length > 0 && (
        <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>Arm scope:</span>
          {hashtag.arms.map((a) => (
            <Badge key={a} kind={`arm-${a.toLowerCase()}`}>{a}</Badge>
          ))}
        </div>
      )}

      {adding && (
        <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 220, marginBottom: 14 }}>
          <div className="table-head" style={{ padding: '10px 14px' }}>
            <h3 style={{ fontSize: 13 }}>Add creator</h3>
          </div>
          <div className="table-scroll">
            {candidates.length === 0 ? (
              <EmptyState label="All creators are already covered." />
            ) : (
              <table className="tbl">
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="row">
                          <span style={{ fontWeight: 500 }}>{c.name}</span>
                          <Badge kind={`arm-${c.arm.toLowerCase()}`}>{c.arm}</Badge>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm primary"
                          onClick={() => addCreator(c.id)}
                          disabled={busyCreator === c.id}
                        >
                          {busyCreator === c.id ? '...' : 'Add'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 360 }}>
        <div className="table-head" style={{ padding: '10px 14px' }}>
          <h3 style={{ fontSize: 13 }}>Creators using this hashtag</h3>
        </div>
        <div className="table-scroll">
          {effectiveCreators.length === 0 ? (
            <EmptyState label="No creators yet" hint="Use 'Add creator' or assign to an arm via the Add hashtag flow." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Arm</th>
                  <th>Source</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {effectiveCreators.map((c) => {
                  const armOnly = armOnlyMessage(c)
                  const direct = directIds.has(c.id)
                  return (
                    <tr key={c.id}>
                      <td><span style={{ fontWeight: 500 }}>{c.name}</span></td>
                      <td><Badge kind={`arm-${c.arm.toLowerCase()}`}>{c.arm}</Badge></td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {direct && armOnly ? 'Direct + arm' : direct ? 'Direct' : `${c.arm} arm`}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm ghost"
                          onClick={() => removeCreator(c.id)}
                          disabled={!direct || busyCreator === c.id}
                          title={!direct ? armOnly! : 'Remove this creator from the hashtag'}
                        >
                          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                            <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  )
}
