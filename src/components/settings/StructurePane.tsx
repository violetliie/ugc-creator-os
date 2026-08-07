'use client'

import { useState, useMemo } from 'react'
import { useCreators, usePaymentStructure, refreshAll } from '@/lib/hooks'
import { fmtMoney, compactNum } from '@/lib/fmt'
import type { Arm, PaymentStructureTier } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'
import Modal from '@/components/ui/Modal'

const ARMS: Arm[] = ['Arm A', 'Arm B']

export default function StructurePane() {
  const { data: tiers = [] } = usePaymentStructure()
  const { data: creators = [] } = useCreators()
  const [editingArm, setEditingArm] = useState<Arm | null>(null)

  const tiersByArm = useMemo(() => {
    const m: Record<Arm, PaymentStructureTier[]> = { 'Arm A': [], 'Arm B': [] }
    for (const t of tiers) m[t.arm].push(t)
    for (const arm of ARMS) m[arm].sort((a, b) => a.sort_order - b.sort_order)
    return m
  }, [tiers])

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {ARMS.map((arm) => {
          const team = creators.filter((c) => !c.deleted_at && c.arm === arm)
          const armTiers = tiersByArm[arm]
          if (armTiers.length === 0) return null
          return (
            <button
              key={arm}
              className="kpi clickable"
              style={{ alignItems: 'flex-start', border: '1px solid var(--line)' }}
              onClick={() => setEditingArm(arm)}
            >
              <div className="kpi-lbl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <span>{arm} arm</span>
                <Badge kind={`arm-${arm.toLowerCase()}`}>
                  {team.length}&nbsp;{team.length === 1 ? 'creator' : 'creators'}
                </Badge>
              </div>
              <div className="kpi-val" style={{ fontSize: 22 }}>{armTiers.length} tiers</div>
              <div className="kpi-foot">
                <span>From {fmtMoney(armTiers[0].amount)} to {fmtMoney(armTiers[armTiers.length - 1].amount)}+</span>
                <span>Edit</span>
              </div>
            </button>
          )
        })}
      </div>

      <div className="table-card" style={{ flex: 0, marginTop: 6 }}>
        <div className="table-head"><h3>About payment structures</h3></div>
        <div style={{ padding: 18, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.55 }}>
          Each arm has its own tiered payout schedule. A creator&apos;s payout for a video is determined by the{' '}
          <b>highest view count across TikTok, Instagram, YouTube, and Facebook</b>, mapped to the matching tier in their arm.
          Videos under 1,000 views on every platform earn $0.
          {/* SHELVED ROUND 15 (2026-05-21): cross-post rule removed from copy.
              Original sentence: "Per the cross post rule, videos that are not posted on both TikTok and Instagram earn $0 regardless of view count." */}
        </div>
      </div>

      {editingArm && (
        <StructureModal
          arm={editingArm}
          onClose={() => setEditingArm(null)}
        />
      )}
    </>
  )
}

interface StructureModalProps {
  arm: Arm
  onClose: () => void
}

function StructureModal({ arm, onClose }: StructureModalProps) {
  const { push } = useToast()
  const { data: tiers = [], mutate: mutateTiers } = usePaymentStructure()
  const { data: creators = [], mutate: mutateCreators } = useCreators()
  const [pickCreator, setPickCreator] = useState('')
  const [savingTier, setSavingTier] = useState<number | null>(null)

  const armTiers = useMemo(() =>
    [...tiers].filter((t) => t.arm === arm).sort((a, b) => a.sort_order - b.sort_order),
    [tiers, arm],
  )
  const team = creators.filter((c) => !c.deleted_at && c.arm === arm)
  const others = creators.filter((c) => !c.deleted_at && c.arm !== arm)

  async function updateTier(tier: PaymentStructureTier, patch: { amount?: number; per_million?: number | null }) {
    setSavingTier(tier.id)
    try {
      const r = await fetch('/api/payment-structure', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: tier.id, ...patch }),
      })
      const d = await r.json()
      if (r.ok) {
        refreshAll()
        push('Tier updated. Recalculating unpaid groups')
      } else {
        push(d.error || 'Failed')
      }
    } finally {
      setSavingTier(null)
    }
  }

  async function moveCreatorToArm(creatorId: string, newArm: Arm) {
    const r = await fetch('/api/creators', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: creatorId, arm: newArm }),
    })
    if (r.ok) {
      refreshAll()
      push(newArm === arm ? `Added to ${arm}` : `Removed from ${arm}`)
      setPickCreator('')
    }
  }

  return (
    <Modal
      size="lg"
      title={`${arm} payment structure`}
      sub={`${armTiers.length} tiers · ${team.length} creators`}
      onClose={onClose}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {/* Tiers (editable) */}
        <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 360 }}>
          <div className="table-head" style={{ padding: '10px 14px' }}>
            <h3 style={{ fontSize: 13 }}>Tiers</h3>
          </div>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Views from</th>
                  <th>Views to</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {armTiers.map((t) => (
                  <tr key={t.id}>
                    <td className="num">{compactNum(t.views_from)}</td>
                    <td className="num">
                      {t.per_million ? `${compactNum(t.views_from)}+` : t.views_to ? compactNum(t.views_to) : 'no cap'}
                    </td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 500 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ color: 'var(--ink-3)' }}>$</span>
                          <input
                            type="number"
                            className="input"
                            style={{ height: 26, width: 80, padding: '0 6px', textAlign: 'right', fontSize: 13, fontWeight: 500 }}
                            defaultValue={t.amount}
                            disabled={savingTier === t.id}
                            onBlur={(e) => {
                              const v = Number(e.target.value)
                              if (Number.isFinite(v) && v >= 0 && v !== t.amount) updateTier(t, { amount: v })
                            }}
                          />
                        </span>
                        {t.per_million != null && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--ink-3)', fontSize: 11 }}>
                            <span>+$</span>
                            <input
                              type="number"
                              className="input"
                              style={{ height: 24, width: 60, padding: '0 6px', textAlign: 'right', fontSize: 12, fontWeight: 500 }}
                              defaultValue={t.per_million}
                              disabled={savingTier === t.id}
                              onBlur={(e) => {
                                const v = Number(e.target.value)
                                if (Number.isFinite(v) && v >= 0 && v !== t.per_million) updateTier(t, { per_million: v })
                              }}
                            />
                            <span>/M</span>
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Creators on this arm */}
        <div className="table-card" style={{ border: '1px solid var(--line)', maxHeight: 360 }}>
          <div className="table-head" style={{ padding: '10px 14px' }}>
            <h3 style={{ fontSize: 13 }}>Creators on team</h3>
            <div className="right" style={{ gap: 6 }}>
              <select
                className="input"
                style={{ height: 28, fontSize: 12, padding: '0 8px' }}
                value={pickCreator}
                onChange={(e) => setPickCreator(e.target.value)}
              >
                <option value="">Add creator</option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                className="btn sm primary"
                onClick={() => pickCreator && moveCreatorToArm(pickCreator, arm)}
                disabled={!pickCreator}
              >
                Add
              </button>
            </div>
          </div>
          <div className="table-scroll">
            {team.length === 0 ? (
              <EmptyState label="No creators on this arm" />
            ) : (
              <table className="tbl">
                <tbody>
                  {team.map((c) => (
                    <tr key={c.id}>
                      <td><span style={{ fontWeight: 500 }}>{c.name}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn sm ghost"
                          onClick={() => moveCreatorToArm(c.id, arm === 'Arm A' ? 'Arm B' : 'Arm A')}
                          title="Move to other arm"
                        >
                          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                            <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
