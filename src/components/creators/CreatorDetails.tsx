'use client'

import { useMemo, useState } from 'react'
import { useVideoGroups, useEffectiveHashtags, useReferrals, refreshAll } from '@/lib/hooks'
import { fmtCycleShort } from '@/lib/cycles'
import { fmtMoney } from '@/lib/fmt'
import { displayTag } from '@/lib/hashtags'
import type { Creator, PaymentCycle, PaymentSnapshot, Platform } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'
import VideoRow from './VideoRow'
import PaymentHistoryModal from './PaymentHistoryModal'
import LinkPostModal from './LinkPostModal'
import ReferralsSection from './ReferralsSection'

interface Props {
  creator: Creator
  cycle: PaymentCycle
  snapshots: PaymentSnapshot[]   // pre-fetched all snapshots for this creator
  cycles: PaymentCycle[]
  embedded?: boolean             // true = creator-role view (full page), false = admin modal
  /**
   * ROUND 19: replaces the boolean `canEdit`. Determines what the viewing
   * user can do with each row. See VideoRow's permission prop for semantics.
   *   - 'full'     admin (default). Toggle either way, Link Post enabled.
   *   - 'unselect' creator viewing own profile. One-way unselect ratchet,
   *                Link Post enabled on own singletons.
   *   - 'none'     read-only (e.g., embedded view of another creator).
   * Back-compat: omitting it defaults to 'full' so existing admin callsites
   * keep working without changes.
   */
  permission?: 'none' | 'unselect' | 'full'
}

export default function CreatorDetails({ creator, cycle, snapshots, cycles, embedded, permission = 'full' }: Props) {
  const { push } = useToast()
  const { data: groups = [], mutate } = useVideoGroups(creator.id, cycle.id)
  const { data: effectiveHashtags = [] } = useEffectiveHashtags(creator.id)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [historyOpen, setHistoryOpen] = useState(false)
  // Round 10: id of the singleton group whose video is being manually linked.
  // null = no modal open.
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null)

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) =>
      sortDir === 'desc'
        ? b.posted_date.localeCompare(a.posted_date)
        : a.posted_date.localeCompare(b.posted_date),
    ),
    [groups, sortDir],
  )

  // ROUND 22 (2026-06-10): only render platform columns the creator actually
  // uses. A column shows if the creator has that handle OR any group has a
  // video on it (so an anomalous video is never hidden). Fixes "everyone has
  // a Facebook column even without an FB handle."
  const activePlatforms = useMemo(() => {
    const meta: { key: Platform; label: string; handle: keyof Creator }[] = [
      { key: 'tiktok', label: 'TikTok', handle: 'tiktok_handle' },
      { key: 'instagram', label: 'Instagram', handle: 'instagram_handle' },
      { key: 'youtube', label: 'YouTube', handle: 'youtube_handle' },
      { key: 'facebook', label: 'Facebook', handle: 'facebook_handle' },
    ]
    return meta.filter(
      (m) => !!creator[m.handle] || groups.some((g) => g.videos?.some((v) => v.platform === m.key)),
    )
  }, [creator, groups])

  // ROUND 24: this creator's referrals (for the Referrals section + the
  // referral bonus share of the Current period total).
  const { data: referrals = [] } = useReferrals(creator.id)
  const referralAmt = useMemo(
    () => referrals
      .filter((r) => r.status === 'awarded' && r.awarded_cycle_id === cycle.id)
      .reduce((a, r) => a + Number(r.amount), 0),
    [referrals, cycle.id],
  )

  // SHELVED ROUND 15: cross_posted no longer gates payout.
  // Original: .filter((g) => g.payable && g.cross_posted)
  // ROUND 24: + referral bonuses landing in this cycle.
  const cycleAmt = groups
    .filter((g) => g.payable)
    .reduce((a, g) => a + Number(g.payout), 0) + referralAmt

  // All time = sum of paid snapshots
  const allTime = useMemo(() => {
    return snapshots
      .filter((s) => {
        const c = cycles.find((cy) => cy.id === s.cycle_id)
        return !!(c?.marked_paid_at || s.marked_paid_at)
      })
      .reduce((a, s) => a + Number(s.amount), 0)
  }, [snapshots, cycles])

  const paidCycleCount = snapshots.filter((s) => {
    const c = cycles.find((cy) => cy.id === s.cycle_id)
    return !!(c?.marked_paid_at || s.marked_paid_at)
  }).length

  async function handleTogglePayable(groupId: string, payable: boolean) {
    const r = await fetch(`/api/videos/${groupId}/payable`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ payable }),
    })
    const d = await r.json()
    if (r.ok) {
      refreshAll()
      push(payable ? 'Marked as payable' : 'Marked as not payable')
    } else {
      push(d.error || 'Failed')
    }
  }

  const tiktokUrl = creator.tiktok_handle ? `https://www.tiktok.com/@${creator.tiktok_handle}` : null
  const instagramUrl = creator.instagram_handle ? `https://www.instagram.com/${creator.instagram_handle}/reels/` : null
  const youtubeUrl = creator.youtube_handle
    ? `https://www.youtube.com/${creator.youtube_handle.startsWith('@') ? creator.youtube_handle : '@' + creator.youtube_handle}`
    : null
  // Round 21: FB handle is the Shortimize username slug (e.g. bri-lately) or a
  // numeric profile id; both resolve as a path on facebook.com. Best-effort link.
  const facebookUrl = creator.facebook_handle
    ? `https://www.facebook.com/${creator.facebook_handle.replace(/^@/, '')}`
    : null

  return (
    // Embedded (creator self-view) fills the page column so the videos card
    // can absorb leftover viewport height instead of leaving a dead band of
    // whitespace under the referrals box. The admin modal keeps block flow.
    <div style={embedded ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
      <div className="cd-head">
        <div className="cd-head-top">
          {!embedded && <div className="cd-name">{creator.name}{creator.deleted_at ? ' (deleted)' : ''}</div>}
          <div className="cd-handles">
            <Badge kind={`arm-${creator.arm.toLowerCase()}`}>{creator.arm}</Badge>

            {tiktokUrl && (
              <a href={tiktokUrl} target="_blank" rel="noreferrer" className="handle-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z"/>
                </svg>
                <span>@{creator.tiktok_handle}</span>
              </a>
            )}
            {instagramUrl && (
              <a href={instagramUrl} target="_blank" rel="noreferrer" className="handle-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="2.5" y="2.5" width="19" height="19" rx="5"/>
                  <circle cx="12" cy="12" r="4.2"/>
                  <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none"/>
                </svg>
                <span>@{creator.instagram_handle}</span>
              </a>
            )}
            {youtubeUrl && (
              <a href={youtubeUrl} target="_blank" rel="noreferrer" className="handle-link">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.4 19.6C5.12 20 12 20 12 20s6.88 0 8.6-.4a2.78 2.78 0 0 0 1.94-2A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58zM9.75 15.5v-7l5.75 3.5z"/>
                </svg>
                <span>@{creator.youtube_handle}</span>
              </a>
            )}
            {facebookUrl && (
              <a href={facebookUrl} target="_blank" rel="noreferrer" className="handle-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.88v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.1 24 18.1 24 12.07z"/>
                </svg>
                <span>@{creator.facebook_handle}</span>
              </a>
            )}
            {effectiveHashtags.length > 0 && (
              <>
                <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} aria-hidden />
                {effectiveHashtags.map((h) => (
                  <Badge
                    key={h.tag}
                    title={`Tracked from ${new Date(h.starting_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} onward`}
                  >
                    {displayTag(h.tag)}
                  </Badge>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="cd-stats">
          <div className="cd-stat">
            <div className="lbl">Current period</div>
            <div className="val">{fmtMoney(cycleAmt)}</div>
            <div className="sub">{fmtCycleShort(cycle)}</div>
          </div>
          <button
            type="button"
            className="cd-stat clickable"
            onClick={() => setHistoryOpen(true)}
            aria-label="View payment history"
          >
            <div className="lbl">All time earned</div>
            <div className="val">{fmtMoney(allTime)}</div>
            <div className="sub">across {paidCycleCount} {paidCycleCount === 1 ? 'cycle' : 'cycles'}</div>
          </button>
          <div className="cd-stat">
            <div className="lbl">PayPal</div>
            <a
              className="val paypal-val paypal-link"
              href={`https://www.paypal.com/myaccount/transfer/homepage/pay?contact=${encodeURIComponent(creator.paypal_email)}`}
              target="_blank"
              rel="noreferrer"
            >
              {creator.paypal_email}
            </a>
          </div>
        </div>
      </div>

      {/* ROUND 24: admin placement — between the KPI cards and the videos
          table. The section renders null when this creator has no visible
          referrals. Creator self-view renders it BELOW the videos instead. */}
      {!embedded && (
        <ReferralsSection
          creator={creator}
          cycle={cycle}
          cycles={cycles}
          isCreatorView={false}
          referrals={referrals}
        />
      )}

      <div className="row" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 15 }}>
          Videos this cycle{' '}
          <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            {sortedGroups.length} videos
          </span>
        </h3>
      </div>

      <div
        className="table-card"
        // Embedded: natural height, shrink-to-fit the viewport (scroll inside)
        // so the page bottom has no dead whitespace. Modal: fixed 360 cap.
        style={embedded
          ? { border: '1px solid var(--line)', flex: '0 1 auto', minHeight: 0 }
          : { border: '1px solid var(--line)', maxHeight: 360 }}
      >
        <div className="table-scroll">
          {sortedGroups.length === 0 ? (
            <EmptyState label="No videos in this cycle yet" hint="Posted videos will appear here as they are scraped." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Payable?</th>
                  <th
                    className="sortable"
                    onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
                  >
                    Posted {sortDir === 'desc' ? '↓' : '↑'}
                  </th>
                  {/* ROUND 22: only the creator's active platform columns */}
                  {activePlatforms.map((m) => <th key={m.key}>{m.label}</th>)}
                  <th style={{ textAlign: 'right' }}>Highest views</th>
                  <th style={{ textAlign: 'right' }}>Payout</th>
                </tr>
              </thead>
              <tbody>
                {sortedGroups.map((g) => (
                  <VideoRow
                    key={g.id}
                    group={g}
                    permission={permission}
                    platforms={activePlatforms.map((m) => m.key)}
                    onTogglePayable={(p) => handleTogglePayable(g.id, p)}
                    onLinkPost={permission !== 'none' ? () => setLinkSourceId(g.id) : undefined}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ROUND 24: creator placement — below the videos table, with the
          add-referral control ("Select the creator you referred during this
          pay period"). */}
      {embedded && (
        <ReferralsSection
          creator={creator}
          cycle={cycle}
          cycles={cycles}
          isCreatorView
          referrals={referrals}
        />
      )}

      {historyOpen && (
        <PaymentHistoryModal
          creator={creator}
          snapshots={snapshots}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {linkSourceId && (() => {
        const source = groups.find((g) => g.id === linkSourceId)
        if (!source) return null
        const candidates = groups.filter((g) => g.id !== linkSourceId)
        return (
          <LinkPostModal
            sourceGroup={source}
            candidateGroups={candidates}
            onClose={() => {
              setLinkSourceId(null)
              mutate()
            }}
          />
        )
      })()}
    </div>
  )
}
