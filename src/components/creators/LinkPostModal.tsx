'use client'

import { useMemo, useState } from 'react'
import Modal from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { compactNum, fmtDate } from '@/lib/fmt'
import { refreshAll } from '@/lib/hooks'
import type { VideoGroupWithVideos, Video, Platform } from '@/lib/types'

interface Props {
  /** The unmatched singleton group whose lone video needs to be linked */
  sourceGroup: VideoGroupWithVideos
  /** All other groups for this creator in this cycle (already filtered by caller) */
  candidateGroups: VideoGroupWithVideos[]
  onClose: () => void
}

/**
 * Round 10 admin "Link Post" modal.
 *
 * Shows the source video (alone in its own group) and lets the admin pick
 * a target group to link it into. Same-platform conflicts in the target are
 * resolved server-side by ejecting the conflicting video to its own new
 * singleton group; this preserves UNIQUE(video_id) on video_group_members
 * and gives the admin a clean swap.
 *
 * Columns mirror the Creator Details videos table MINUS Payable? / Highest
 * views / Payout (per user spec).
 */
export default function LinkPostModal({ sourceGroup, candidateGroups, onClose }: Props) {
  const { push } = useToast()
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const sourceVideo = sourceGroup.videos?.[0]
  const sourcePlatform = sourceVideo?.platform

  // Sort candidates newest first by posted_date (matches main table default)
  const sortedCandidates = useMemo(
    () => [...candidateGroups].sort((a, b) =>
      b.posted_date.localeCompare(a.posted_date),
    ),
    [candidateGroups],
  )

  // ROUND 22: only show platform columns that actually appear among the source
  // + candidate groups (this creator's platforms), in canonical order.
  const platforms = useMemo<{ key: Platform; label: string }[]>(() => {
    const present = new Set<Platform>()
    for (const g of [sourceGroup, ...candidateGroups]) {
      for (const v of g.videos ?? []) present.add(v.platform)
    }
    const meta: { key: Platform; label: string }[] = [
      { key: 'tiktok', label: 'TikTok' },
      { key: 'instagram', label: 'Instagram' },
      { key: 'youtube', label: 'YouTube' },
      { key: 'facebook', label: 'Facebook' },
    ]
    return meta.filter((m) => present.has(m.key))
  }, [sourceGroup, candidateGroups])

  // For the selected group, identify which (if any) video on source's platform
  // will get ejected. Shown in the footer as a warning before confirm.
  const selectedGroup = sortedCandidates.find((g) => g.id === selectedGroupId)
  const conflictingVideo = selectedGroup && sourcePlatform
    ? selectedGroup.videos?.find((v) => v.platform === sourcePlatform)
    : undefined

  async function handleConfirm() {
    if (!sourceVideo || !selectedGroupId) return
    setSubmitting(true)
    try {
      const r = await fetch('/api/video-groups/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          source_video_id: sourceVideo.id,
          target_group_id: selectedGroupId,
        }),
      })
      const d = await r.json()
      if (r.ok) {
        push(
          conflictingVideo
            ? `Linked; replaced existing ${sourcePlatform} post`
            : 'Posts linked',
        )
        refreshAll()
        onClose()
      } else {
        push(d.error || 'Failed to link posts')
      }
    } catch {
      push('Link request failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!sourceVideo) {
    return (
      <Modal title="Link Post" onClose={onClose}>
        <div className="muted" style={{ padding: 12 }}>Source video data missing.</div>
      </Modal>
    )
  }

  // Maps the source video's platform to a display label. The trailing '' keeps
  // TS happy and the JSX safe if sourcePlatform is somehow undefined.
  const platformLabel =
    sourcePlatform === 'tiktok' ? 'TikTok'
    : sourcePlatform === 'instagram' ? 'Instagram'
    : sourcePlatform === 'youtube' ? 'YouTube'
    : sourcePlatform === 'facebook' ? 'Facebook'
    : ''

  return (
    <Modal
      size="lg"
      title="Link Post"
      sub={`Pick a video to pair this ${platformLabel} post with`}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 12, justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {conflictingVideo ? (
              <span>
                Note: the existing {platformLabel} post in the target ({compactNum(conflictingVideo.latest_views)}v) will be unlinked and become its own singleton.
              </span>
            ) : selectedGroup ? (
              <span>Ready to link.</span>
            ) : (
              <span>Select a row above to enable Confirm.</span>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
            <button
              className="btn primary"
              onClick={handleConfirm}
              disabled={!selectedGroupId || submitting}
            >
              {submitting ? 'Linking...' : 'Confirm'}
            </button>
          </div>
        </div>
      }
    >
      {/* Source preview */}
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--bg-soft, #f7f7f7)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          marginBottom: 14,
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4 }}>
          Source post
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{platformLabel}</strong>
          <span className="num muted">{fmtDate(sourceVideo.posted_date)}</span>
          <span className="num" style={{ fontWeight: 500 }}>{compactNum(sourceVideo.latest_views)} views</span>
          {sourceVideo.video_length != null && (
            <span className="muted">{sourceVideo.video_length}s</span>
          )}
          <a href={sourceVideo.ad_link} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>
            Open original
          </a>
        </div>
        {sourceVideo.title && (
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            {sourceVideo.title.length > 120 ? sourceVideo.title.slice(0, 120) + '...' : sourceVideo.title}
          </div>
        )}
      </div>

      {/* Candidate list */}
      <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 340 }}>
        <div className="table-scroll">
          {sortedCandidates.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--ink-3)', textAlign: 'center', fontSize: 13 }}>
              No other posts in this cycle to link with.
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 36 }}></th>
                  <th>Posted</th>
                  {platforms.map((m) => <th key={m.key}>{m.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {sortedCandidates.map((g) => (
                  <CandidateRow
                    key={g.id}
                    group={g}
                    platforms={platforms.map((m) => m.key)}
                    sourcePlatform={sourcePlatform}
                    selected={selectedGroupId === g.id}
                    onSelect={() => setSelectedGroupId(g.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  )
}

function CandidateRow({
  group,
  platforms,
  sourcePlatform,
  selected,
  onSelect,
}: {
  group: VideoGroupWithVideos
  platforms: Platform[]
  sourcePlatform: string | undefined
  selected: boolean
  onSelect: () => void
}) {
  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        background: selected ? 'var(--bg-selected, rgba(0,0,0,0.04))' : undefined,
      }}
    >
      <td style={{ textAlign: 'center' }}>
        <input
          type="radio"
          name="link-target"
          checked={selected}
          onChange={onSelect}
          aria-label="Select this group"
        />
      </td>
      <td className="num muted">{fmtDate(group.posted_date)}</td>
      {/* ROUND 22: one cell per active platform, matching the header set */}
      {platforms.map((p) => {
        const v = group.videos?.find((vid) => vid.platform === p)
        return (
          <td key={p}>
            {v ? <PostCell v={v} willReplace={sourcePlatform === p} /> : <span className="muted"></span>}
          </td>
        )
      })}
    </tr>
  )
}

function PostCell({ v, willReplace }: { v: Video; willReplace: boolean }) {
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <a
        href={v.ad_link}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ textDecoration: 'none', display: 'inline-flex', gap: 4, alignItems: 'center' }}
      >
        <span className="num" style={{ fontWeight: 500, color: 'var(--ink)' }}>{compactNum(v.latest_views)}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.5 }}>
          <path d="M3 9L9 3M9 3H4M9 3V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </a>
      {willReplace && (
        <span
          style={{
            fontSize: 10,
            color: 'var(--ink-3)',
            background: 'var(--bg-soft, #f0f0f0)',
            padding: '1px 5px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
          title="This existing post on the source platform will be unlinked and become its own singleton"
        >
          will be replaced
        </span>
      )}
    </div>
  )
}
