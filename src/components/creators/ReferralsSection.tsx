'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCreatorNames, refreshAll } from '@/lib/hooks'
import { fmtCycleShort } from '@/lib/cycles'
import { fmtMoney } from '@/lib/fmt'
import type { Creator, PaymentCycle, ReferralWithMeta } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import Icon from '@/components/ui/Icon'
import SearchInput from '@/components/ui/SearchInput'

/**
 * ROUND 24 (2026-06-11): referral bonuses.
 *
 * Creator self-view (isCreatorView): rendered BELOW "Videos this cycle".
 *   Always visible — carries the add control ("Select the creator you
 *   referred during THIS PAY PERIOD" + searchable dropdown + [+]) plus the
 *   referral rows. Removed rows are hidden here.
 *
 * Admin view: rendered BETWEEN the KPI cards and "Videos this cycle".
 *   Read + remove only; renders null when there is nothing to show.
 *   Removed rows stay visible, labeled "Removed". Butter yellow ONLY when
 *   the CREATOR removed it — same rule as video rows, where yellow means
 *   "the creator did this"; admin/system removals stay uncolored.
 *
 * Row visibility for the displayed cycle C:
 *   - pending rows ALWAYS show (until awarded/removed), per policy
 *   - rows referred in C show
 *   - rows whose bonus LANDED in C (awarded_cycle === C) show
 *   - admin additionally sees removed rows tied to C
 * Only bonuses with awarded_cycle === C count toward this cycle's totals.
 *
 * Layout notes (2026-06-12 polish): the add picker (shared SearchInput with
 * the instruction sentence as its placeholder + [+]) sits on its own row
 * below the heading while the creator has NO referrals; once the first
 * referral lands it FOLDS to icon-only width and moves up into the header
 * row, between "x referrals" and the bonus total (closer to the count).
 * Width/placeholder fold animates via .referral-picker CSS; the hop between
 * the two spots is a FLIP transform (measure old rect -> invert -> release).
 * Focusing the folded icon expands it back to full width for adding more.
 * The suggestion list opens ABOVE the field in both spots (the section sits
 * at the bottom of the page). Rows live in a ~1.5-row scrollable card; the
 * bonus total stays in the header so it can never be cut off.
 */

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook',
}

interface Props {
  creator: Creator
  cycle: PaymentCycle
  isCreatorView: boolean
  referrals: ReferralWithMeta[]
  /** All cycles, to render "period referred at" labels. */
  cycles?: PaymentCycle[]
}

export default function ReferralsSection({ creator, cycle, isCreatorView, referrals, cycles = [] }: Props) {
  const { push } = useToast()
  const { data: names = [] } = useCreatorNames()

  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const visible = useMemo(() => {
    const tiedToCycle = (r: ReferralWithMeta) =>
      r.referred_cycle_id === cycle.id ||
      (r.status === 'awarded' && r.awarded_cycle_id === cycle.id)
    const live = referrals.filter(
      (r) => r.status !== 'removed' && (r.status === 'pending' || tiedToCycle(r)),
    )
    if (isCreatorView) return live
    const removed = referrals.filter((r) => r.status === 'removed' && tiedToCycle(r))
    return [...live, ...removed]
  }, [referrals, cycle.id, isCreatorView])

  // Bonuses actually landing in THIS cycle (drive the total line).
  const countingRows = visible.filter(
    (r) => r.status === 'awarded' && r.awarded_cycle_id === cycle.id,
  )
  const bonusTotal = countingRows.reduce((a, r) => a + Number(r.amount), 0)

  // Picker fold state: full-width on its own row while the list is empty;
  // icon-only up in the header once rows exist. Interacting (open dropdown,
  // text typed, suggestion picked but not yet added) keeps it expanded so
  // the selection never disappears mid-add.
  //
  // justAdded flips the fold the moment the POST succeeds instead of waiting
  // for the refetch to land (the lag read as "the old picker is stuck there
  // for a second"). It resets once the rows actually arrive, and also if the
  // refetch ends up empty, so a failed write can't strand the folded state.
  const [justAdded, setJustAdded] = useState(false)
  useEffect(() => {
    // Any fresh referrals payload settles the optimistic flag: real rows now
    // carry the fold, or (refetch came back empty) the picker unfolds again.
    if (justAdded) setJustAdded(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])
  const hasRows = visible.length > 0 || justAdded
  const expanded = !hasRows || open || selectedId !== null || query !== ''

  // FLIP: when the picker hops between its empty-state row and the header
  // slot (first referral added / last row gone), glide it instead of
  // teleporting — measure where it WAS, start it there, release to CSS.
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const lastPickerRect = useRef<DOMRect | null>(null)
  const prevHasRows = useRef(hasRows)
  useLayoutEffect(() => {
    const el = pickerRef.current
    const moved = prevHasRows.current !== hasRows
    prevHasRows.current = hasRows
    if (!el) { lastPickerRect.current = null; return }
    const rect = el.getBoundingClientRect()
    const prev = lastPickerRect.current
    lastPickerRect.current = rect
    if (!moved || !prev) return
    const dx = prev.left - rect.left
    const dy = prev.top - rect.top
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    if (Math.abs(prev.width - rect.width) > 2) el.style.width = `${prev.width}px`
    void el.offsetWidth // flush styles so the start position paints
    el.style.transition = ''
    el.style.transform = ''
    el.style.width = ''
  })

  // Admin: nothing to show -> no section at all (per spec).
  if (!isCreatorView && visible.length === 0) return null

  // Dropdown candidates: active creators, minus self, minus anyone this
  // creator already has a live (non-removed) referral for. (Someone else's
  // claim is caught server-side with a clear 409 message.)
  const alreadyMine = new Set(
    referrals.filter((r) => r.status !== 'removed').map((r) => r.referred_creator_id),
  )
  const candidates = names.filter(
    (n) =>
      n.id !== creator.id &&
      !alreadyMine.has(n.id) &&
      (!query || n.name.toLowerCase().includes(query.toLowerCase())),
  )

  function cycleLabel(cycleId: string | null): string {
    if (!cycleId) return ''
    const c = cycles.find((x) => x.id === cycleId)
    return c ? fmtCycleShort(c) : cycleId
  }

  async function addReferral() {
    if (!selectedId || busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ referred_creator_id: selectedId, cycle_id: cycle.id }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        push(d.status === 'awarded'
          ? `Referral added, ${fmtMoney(Number(d.amount) || 75)} bonus awarded`
          : 'Referral added, bonus pending eligibility')
        setQuery(''); setSelectedId(null); setOpen(false)
        setJustAdded(true) // fold + move NOW; the refetch fills the rows in
        refreshAll()
      } else {
        push(d.error || 'Failed to add referral')
      }
    } catch {
      push('Failed to add referral')
    } finally {
      setBusy(false)
    }
  }

  async function removeReferral(r: ReferralWithMeta) {
    try {
      const res = await fetch(`/api/referrals?id=${r.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        push(`Removed referral for ${r.referred_name}`)
        refreshAll()
      } else {
        push(d.error || 'Failed to remove referral')
      }
    } catch {
      push('Failed to remove referral')
    }
  }

  function statusCell(r: ReferralWithMeta) {
    if (r.status === 'removed') {
      return <span className="muted">Removed</span>
    }
    if (r.status === 'awarded') {
      if (r.awarded_cycle_id === cycle.id) {
        return <span className="muted">Awarded</span>
      }
      // Awarded, but the bonus landed in a different cycle than the one on
      // screen (late qualification) — say where it landed.
      return <span className="muted">Awarded in {cycleLabel(r.awarded_cycle_id)}</span>
    }
    // pending
    const p = r.progress
    const reason = p
      ? (p.count === 0
          ? `${r.referred_name} has 0/${p.required} videos posted`
          : `${r.referred_name} has ${p.count}/${p.required} videos on ${p.platform ? (PLATFORM_LABEL[p.platform] ?? p.platform) : 'their top platform'}`)
      : 'eligibility is re-checked every sync'
    return (
      <span>
        Bonus pending
        <span className="muted" style={{ fontSize: 12 }}>: {reason}</span>
      </span>
    )
  }

  // ONE picker element, rendered in one of two spots (own row while the
  // list is empty; header slot once rows exist). Same element + FLIP effect
  // = the move between spots glides. The dropdown opens ABOVE the field in
  // both spots (the section sits at the bottom of the page).
  const picker = isCreatorView ? (
    <div ref={pickerRef} className={`referral-picker${expanded ? '' : ' folded'}`}>
      <div
        style={{ position: 'relative', flex: 1, minWidth: 0 }}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current)
          setOpen(true)
        }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150) }}
      >
        {open && candidates.length > 0 && (
          <div
            style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 30,
              background: 'var(--bg-elevated, #fff)', border: '1px solid var(--line)',
              maxHeight: 200, overflowY: 'auto', marginBottom: 2,
              boxShadow: '0 -8px 20px rgba(20,17,10,0.08)',
            }}
          >
            {candidates.slice(0, 50).map((n) => (
              <button
                key={n.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (blurTimer.current) clearTimeout(blurTimer.current)
                  setSelectedId(n.id); setQuery(n.name); setOpen(false)
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '7px 12px', fontSize: 13, cursor: 'pointer',
                  background: selectedId === n.id ? 'var(--bg-soft, #f7f7f7)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--line)', color: 'var(--ink)',
                }}
              >
                {n.name}
              </button>
            ))}
          </div>
        )}
        <SearchInput
          value={query}
          onChange={(v) => { setQuery(v); setSelectedId(null); setOpen(true) }}
          placeholder="Select the creator you referred during this pay period"
        />
      </div>
      <button
        className="btn primary"
        onClick={addReferral}
        disabled={!selectedId || busy}
        title={selectedId ? 'Add this referral' : 'Pick a creator first'}
      >
        <Icon name="plus" size={14} style={{ filter: 'invert(1)' }} />
      </button>
    </div>
  ) : null

  return (
    <div style={{ margin: isCreatorView ? '14px 0 0' : '0 0 14px' }}>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15 }}>
          Referrals{' '}
          {visible.length > 0 && (
            <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
              {visible.length} {visible.length === 1 ? 'referral' : 'referrals'}
            </span>
          )}
        </h3>
        {/* Folded picker lands here, right next to the count. */}
        {hasRows && picker}
        {/* Bonus total lives in the header, not a footer under the rows, so
            it can never be cut off at the bottom of the page. */}
        {bonusTotal > 0 && (
          <span style={{ fontSize: 13, fontWeight: 500, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            Referral bonus <span className="num" style={{ marginLeft: 6 }}>{fmtMoney(bonusTotal)}</span>
          </span>
        )}
      </div>

      {/* Empty state: the picker gets its own full-width row below the
          heading, instruction sentence visible in the placeholder. */}
      {!hasRows && picker && (
        <div className="row" style={{ marginBottom: 8 }}>{picker}</div>
      )}

      {visible.length > 0 && (
        <div className="table-card" style={{ border: '1px solid var(--line)' }}>
          {/* Fixed-height box ~1.5 rows tall (row height is 52px) — keeps the
              section short; scroll inside for the rest. */}
          <div className="table-scroll" style={{ maxHeight: 78 }}>
            <table className="tbl">
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    style={r.status === 'removed'
                      // Yellow = "the creator did this" (same as video rows);
                      // admin/system removals just dim.
                      ? (r.removed_by === 'creator'
                          ? { backgroundColor: '#FFF4C2', opacity: 0.85 }
                          : { opacity: 0.85 })
                      : undefined}
                  >
                    <td style={{ fontWeight: 500 }}>{r.referred_name}</td>
                    <td className="num muted">referred {cycleLabel(r.referred_cycle_id)}</td>
                    <td>{statusCell(r)}</td>
                    <td style={{ width: 36, textAlign: 'right' }}>
                      {r.status !== 'removed' && (
                        <button
                          type="button"
                          onClick={() => removeReferral(r)}
                          title="Remove this referral"
                          aria-label={`Remove referral for ${r.referred_name}`}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--ink-3)', fontSize: 14, lineHeight: 1, padding: 4,
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
