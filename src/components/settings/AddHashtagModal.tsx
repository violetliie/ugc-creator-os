'use client'

import { useState } from 'react'
import { normalizeTag, isValidTag } from '@/lib/hashtags'
import type { Arm, Creator } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import Modal from '@/components/ui/Modal'
import Badge from '@/components/ui/Badge'

interface Props {
  existingTags: string[]              // already-normalized
  creators: Creator[]
  onClose: () => void
  onSaved: () => void
}

/**
 * Add hashtag form.
 * Per the design notes G1: input has a fixed `#` prefix to make clear that the
 * user shouldn't type it (we still strip it on save defensively).
 * Per G7: alphanumeric + underscore only, lowercase normalized, dup check.
 */
export default function AddHashtagModal({ existingTags, creators, onClose, onSaved }: Props) {
  const { push } = useToast()
  const [raw, setRaw] = useState('')
  const [armAChecked, setArmAChecked] = useState(false)
  const [armBChecked, setArmBChecked] = useState(false)
  const [creatorIds, setCreatorIds] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  // Group creators by arm for the picker
  const grouped: Record<Arm, Creator[]> = {
    'Arm A': creators.filter((c) => c.arm === 'Arm A'),
    'Arm B': creators.filter((c) => c.arm === 'Arm B'),
  }

  // A creator is "covered by arm" when the arm checkbox above is on. Such
  // creators are auto-checked and locked in the multi-select  the admin
  // doesn't need to also tick them individually (and unchecking would do
  // nothing since the arm assignment overrides).
  function isCoveredByArm(c: Creator): boolean {
    return (c.arm === 'Arm A' && armAChecked) || (c.arm === 'Arm B' && armBChecked)
  }
  function isCreatorChecked(c: Creator): boolean {
    return isCoveredByArm(c) || creatorIds.includes(c.id)
  }
  function toggleCreator(c: Creator) {
    if (isCoveredByArm(c)) return // locked
    setCreatorIds((cur) => cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id])
  }

  async function submit() {
    setErr('')
    const tag = normalizeTag(raw)
    if (!tag) return setErr('Enter a hashtag.')
    if (!isValidTag(tag)) return setErr('Hashtag must be alphanumeric or underscores only.')
    if (existingTags.includes(tag)) return setErr('This hashtag already exists.')

    const arms: Arm[] = []
    if (armAChecked) arms.push('Arm A')
    if (armBChecked) arms.push('Arm B')

    // Strip creators that are already covered by arm  storing both is
    // redundant and causes confusion in the details modal later.
    const directCreatorIds = creatorIds.filter((id) => {
      const c = creators.find((x) => x.id === id)
      if (!c) return false
      return !isCoveredByArm(c)
    })

    if (arms.length === 0 && directCreatorIds.length === 0) {
      return setErr('Assign at least one arm or one creator.')
    }

    setSaving(true)
    try {
      const r = await fetch('/api/hashtags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tag, arms, creator_ids: directCreatorIds }),
      })
      const d = await r.json()
      if (r.ok) {
        push(`Added #${tag}. Resyncing.`)
        onSaved()
      } else {
        setErr(d.error || 'Failed to save')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      size="md"
      title="Add hashtag"
      sub="Assign to one or both arms, and/or specific creators."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? '...' : 'Add'}
          </button>
        </>
      }
    >
      {err && <div style={{ fontSize: 12, color: 'var(--negative)', marginBottom: 10 }}>{err}</div>}

      <div className="field">
        <label>Hashtag *</label>
        <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--line)' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 12px', background: 'var(--bg-soft)', color: 'var(--ink-2)',
            fontFamily: "'Geist Mono', monospace", borderRight: '1px solid var(--line)',
            fontSize: 14,
          }}>#</span>
          <input
            className="input"
            style={{ border: 0, flex: 1 }}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="yourbrand"
            autoFocus
          />
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Lowercase letters, numbers, underscore only. We add the `#` for you.
        </div>
      </div>

      <div className="field">
        <label>Arm scope</label>
        <div className="row" style={{ gap: 14 }}>
          <label className="row" style={{ gap: 6, fontSize: 13, color: 'var(--ink)', textTransform: 'none', letterSpacing: 0 }}>
            <input type="checkbox" className="cb" checked={armAChecked} onChange={(e) => setArmAChecked(e.target.checked)} />
            Arm A (all current Arm A creators)
          </label>
          <label className="row" style={{ gap: 6, fontSize: 13, color: 'var(--ink)', textTransform: 'none', letterSpacing: 0 }}>
            <input type="checkbox" className="cb" checked={armBChecked} onChange={(e) => setArmBChecked(e.target.checked)} />
            Arm B (all current Arm B creators)
          </label>
        </div>
      </div>

      <div className="field">
        <label>Specific creators (multi-select)</label>
        <div style={{ border: '1px solid var(--line)', maxHeight: 220, overflow: 'auto' }}>
          {(['Arm A', 'Arm B'] as Arm[]).map((arm) => (
            <div key={arm}>
              <div style={{ padding: '8px 12px', background: 'var(--bg-soft)', fontSize: 11, color: 'var(--ink-3)' }}>
                <Badge kind={`arm-${arm.toLowerCase()}`}>{arm}</Badge>
              </div>
              {grouped[arm].length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--ink-3)' }}>No creators</div>
              ) : (
                grouped[arm].map((c) => {
                  const covered = isCoveredByArm(c)
                  return (
                    <label
                      key={c.id}
                      className="row"
                      style={{
                        padding: '8px 12px', borderTop: '1px solid var(--line)', gap: 8,
                        fontSize: 13, color: covered ? 'var(--ink-3)' : 'var(--ink)',
                        textTransform: 'none', letterSpacing: 0,
                        cursor: covered ? 'not-allowed' : 'pointer',
                        background: covered ? 'var(--bg-soft)' : 'transparent',
                      }}
                      title={covered ? `Covered by ${c.arm} arm above. Uncheck the arm to manage individually.` : ''}
                    >
                      <input
                        type="checkbox"
                        className="cb"
                        checked={isCreatorChecked(c)}
                        disabled={covered}
                        onChange={() => toggleCreator(c)}
                      />
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                      <span className="muted" style={{ fontSize: 11 }}>{c.paypal_email}</span>
                      {covered && <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>via {c.arm} arm</span>}
                    </label>
                  )
                })
              )}
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Required: at least one arm OR one creator.
        </div>
      </div>
    </Modal>
  )
}
