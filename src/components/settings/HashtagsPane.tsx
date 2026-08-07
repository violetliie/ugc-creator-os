'use client'

import { useState } from 'react'
import { useHashtags, useCreators, refreshAll } from '@/lib/hooks'
import { displayTag } from '@/lib/hashtags'
import type { HashtagWithAssignments } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import EmptyState from '@/components/ui/EmptyState'
import Badge from '@/components/ui/Badge'
import Icon from '@/components/ui/Icon'
import { fmtDate } from '@/lib/fmt'
import AddHashtagModal from './AddHashtagModal'
import HashtagDetailsModal from './HashtagDetailsModal'

export default function HashtagsPane() {
  const { push } = useToast()
  const { data: hashtags = [], mutate } = useHashtags()
  const { data: creators = [] } = useCreators()

  const [adding, setAdding] = useState(false)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function deleteHashtag(h: HashtagWithAssignments) {
    if (!confirm(`Delete hashtag ${displayTag(h.tag)}? This cannot be undone.`)) return
    setDeletingId(h.id)
    try {
      const r = await fetch(`/api/hashtags?id=${h.id}`, { method: 'DELETE', credentials: 'include' })
      if (r.ok) {
        refreshAll()
        push(`Deleted ${displayTag(h.tag)}. Resyncing.`)
      } else {
        const d = await r.json().catch(() => ({}))
        push(d.error || 'Failed to delete')
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="filter-bar" style={{ marginTop: 4 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Hashtags filter which branded videos we ingest. A creator without any hashtags assigned has all their videos pulled.
        </span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} style={{ filter: 'invert(1)' }} />
          Add hashtag
        </button>
      </div>

      <div className="table-card">
        <div className="table-head">
          <h3>All hashtags</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {hashtags.length} {hashtags.length === 1 ? 'hashtag' : 'hashtags'}
          </span>
        </div>
        <div className="table-scroll">
          {hashtags.length === 0 ? (
            <EmptyState label="No hashtags yet" hint="Add a hashtag to start filtering creator content." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Hashtag</th>
                  <th>Arms</th>
                  <th>Creators</th>
                  <th>Starting on</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {hashtags.map((h) => (
                  <tr key={h.id}>
                    <td><span className="num" style={{ fontWeight: 500 }}>{displayTag(h.tag)}</span></td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {h.arms.length === 0 ? (
                          <span className="muted">none</span>
                        ) : (
                          h.arms.map((a) => (
                            <Badge key={a} kind={`arm-${a.toLowerCase()}`}>{a}</Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="muted">
                        {h.effective_creator_count} {h.effective_creator_count === 1 ? 'creator' : 'creators'}
                      </span>
                    </td>
                    <td className="muted">{fmtDate(h.starting_on)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        <button className="btn sm" onClick={() => setDetailsId(h.id)}>Show details</button>
                        <button
                          className="btn sm danger"
                          onClick={() => deleteHashtag(h)}
                          disabled={deletingId === h.id}
                        >
                          {deletingId === h.id ? '...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {adding && (
        <AddHashtagModal
          existingTags={hashtags.map((h) => h.tag)}
          creators={creators.filter((c) => !c.deleted_at)}
          onClose={() => setAdding(false)}
          onSaved={() => { refreshAll(); setAdding(false) }}
        />
      )}

      {detailsId && (() => {
        const h = hashtags.find((x) => x.id === detailsId)
        if (!h) return null
        return (
          <HashtagDetailsModal
            hashtag={h}
            allCreators={creators.filter((c) => !c.deleted_at)}
            onClose={() => setDetailsId(null)}
            onChanged={() => refreshAll()}
          />
        )
      })()}
    </>
  )
}
