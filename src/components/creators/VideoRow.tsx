'use client'

import type { CSSProperties } from 'react'
// SHELVED ROUND 15: NOT_CROSS_POSTED_MSG kept in @/lib/fmt for restoration.
import { fmtMoney, compactNum, fmtDate /* , NOT_CROSS_POSTED_MSG */ } from '@/lib/fmt'
import type { VideoGroupWithVideos, Platform } from '@/lib/types'

/**
 * ROUND 19 (2026-05-22): three-state permission model replaces the binary
 * `canEdit`. Lets the creator-self view enable a one-way unselect ratchet
 * (creator can untick payable but cannot re-tick) while admins keep full
 * bi-directional control.
 *
 * - 'none'     read-only. Checkbox disabled regardless of state. No Link Post.
 * - 'unselect' creator on own row. Checkbox enabled iff payable=true (so it
 *              CAN flip to false); disabled once payable=false (only admin
 *              can re-tick). Link Post button shown for singletons.
 * - 'full'     admin. Checkbox always enabled. Link Post button shown for
 *              singletons.
 */
type VideoRowPermission = 'none' | 'unselect' | 'full'

interface Props {
  group: VideoGroupWithVideos
  permission: VideoRowPermission
  /**
   * ROUND 22 (2026-06-10): which platform columns to render, in order. The
   * parent (CreatorDetails) computes this from the creator's handles (+ any
   * platform that actually has a video), so a creator without e.g. a Facebook
   * handle doesn't get an empty Facebook column. Must match the header set.
   */
  platforms: Platform[]
  onTogglePayable: (payable: boolean) => void
  /**
   * Round 10: "Link Post" handler. When the row is a singleton (1 video
   * member) and permission allows editing, a Link Post button appears next
   * to the Payable? checkbox. Clicking opens LinkPostModal so the user can
   * manually link the lone video into another group (handles d>32 same-video
   * pairs or empty-caption Tier-2 misses). Undefined → no button.
   * Round 19: now usable by creators on their own singletons.
   */
  onLinkPost?: () => void
}

/**
 * Per Round 4 R1, a video group's payout is $0 unless it has BOTH TikTok
 * AND Instagram members. The display shows the not-cross-posted message
 * in that case. Admin's "Payable?" toggle has no effect on non-cross-posted
 * groups (display still shows the message).
 *
 * SHELVED ROUND 15 (2026-05-21): cross_posted display + gate disabled.
 * `group.cross_posted` still populated by matcher but ignored by UI/payout.
 * To restore: revert this commit's changes (search "SHELVED ROUND 15").
 */
export default function VideoRow({ group, permission, platforms, onTogglePayable, onLinkPost }: Props) {
  // SHELVED ROUND 15: dim only on !payable now.
  // const dimmed = !group.payable || !group.cross_posted
  const dimmed = !group.payable
  const payoutCellColor = dimmed ? 'var(--ink-3)' : 'var(--ink)'

  // SHELVED ROUND 15: skip cross_posted branch.
  const payoutText = !group.payable ? '$0' : fmtMoney(group.payout)

  // Singleton = exactly 1 video member. Round 10: only singletons can be
  // re-linked manually (the per-platform conflict resolution on the API
  // side assumes you're moving ONE video, not splitting a pair).
  const isSingleton = (group.videos?.length ?? 0) === 1

  // ROUND 19 permission resolution:
  //   - 'full'     → checkbox always editable; Link Post if singleton
  //   - 'unselect' → checkbox editable ONLY when currently payable=true
  //                  (one-way ratchet to false; Round 20 superseded this for
  //                  creator self-view but the permission state is kept for
  //                  potential future read-only-but-allow-unselect use cases)
  //   - 'none'     → checkbox disabled; no Link Post
  const checkboxEnabled =
    permission === 'full' ||
    (permission === 'unselect' && group.payable === true)
  const showLinkBtn = permission !== 'none' && isSingleton && !!onLinkPost
  const checkboxTitle =
    permission === 'unselect' && group.payable === false
      ? 'Already unselected. Contact admin to re-enable.'
      : ''

  // ROUND 20 (2026-05-22): yellow highlight when the CREATOR explicitly
  // affirmed this group as payable. Distinct from default-state payable=true
  // (which the matcher sets and nobody has touched). API guarantees
  // creator_selected=true implies payable=true (mutually exclusive with
  // creator_unselected=true and cleared on admin override to false), so we
  // don't need to also check payable here.
  const isCreatorSelected = group.creator_selected === true
  const rowStyle: CSSProperties = {
    opacity: dimmed ? 0.7 : 1,
    ...(isCreatorSelected ? { backgroundColor: '#FFF4C2' } : {}),
  }

  return (
    <tr style={rowStyle}>
      <td>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            className="cb"
            checked={group.payable}
            onChange={(e) => onTogglePayable(e.target.checked)}
            disabled={!checkboxEnabled}
            title={checkboxTitle}
          />
          {showLinkBtn && (
            <button
              type="button"
              className="btn"
              onClick={onLinkPost}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}
              title="Manually link this post to another video group for this creator"
            >
              Link Post
            </button>
          )}
        </div>
      </td>
      <td className="num muted">{fmtDate(group.posted_date)}</td>
      {/* ROUND 22: one cell per active platform, in the order the header set them. */}
      {platforms.map((p) => {
        const v = group.videos?.find((vid) => vid.platform === p)
        return (
          <td key={p}>
            {v ? <PlatformLink url={v.ad_link} views={v.latest_views} /> : <span className="muted"></span>}
          </td>
        )
      })}
      <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>{compactNum(group.highest_views)}</td>
      <td
        className="num"
        style={{ textAlign: 'right', fontWeight: 500, color: payoutCellColor, whiteSpace: 'nowrap' }}
        // SHELVED ROUND 15: cross_posted tooltip removed.
        // title={!group.cross_posted ? NOT_CROSS_POSTED_MSG : ''}
        title=""
      >
        {payoutText}
      </td>
    </tr>
  )
}

function PlatformLink({ url, views }: { url: string; views: number }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="row" style={{ textDecoration: 'none', gap: 6 }}>
      <span className="num" style={{ fontWeight: 500, color: 'var(--ink)' }}>{compactNum(views)}</span>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.5 }}>
        <path d="M3 9L9 3M9 3H4M9 3V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    </a>
  )
}
