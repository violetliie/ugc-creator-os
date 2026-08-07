'use client'

import { useEffect, useState } from 'react'
import { useCreators, useHashtags, refreshAll } from '@/lib/hooks'
import { displayTag } from '@/lib/hashtags'
import type { Creator, Arm } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import SearchInput from '@/components/ui/SearchInput'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'
import Modal from '@/components/ui/Modal'
import Icon from '@/components/ui/Icon'

interface CreatorFormData {
  id?: string
  name: string
  arm: Arm
  paypal_email: string
  tiktok_handle: string
  instagram_handle: string
  youtube_handle: string
  facebook_handle: string                // Round 21: Facebook Reels (optional)
  hashtag_ids?: string[]                 // direct creator->hashtag assignments to apply
}

export default function CreatorsEditPane() {
  const { push } = useToast()
  const { data: creators = [], mutate } = useCreators()

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Creator | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)

  const rows = creators
    .filter((c) => !c.deleted_at)
    .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()))

  async function save(data: CreatorFormData) {
    setSaving(true)
    try {
      // 1. Save creator
      const r = await fetch('/api/creators', {
        method: data.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      })
      const d = await r.json()
      if (!r.ok) {
        push(d.error || 'Failed')
        return
      }

      // 2. Apply hashtag assignments if provided. We patch each hashtag
      //    individually (add this creator to add_creator_ids).
      // For an EDIT, we need to compute diff (added + removed) compared to
      // current state. For a NEW creator, we just add to each selected.
      if (data.hashtag_ids !== undefined) {
        const creatorId = (d as Creator).id
        const newSet = new Set(data.hashtag_ids)

        // Determine current set: for existing creator, fetch from /api/hashtags
        // For new creator, current set is empty.
        let currentSet = new Set<string>()
        if (data.id) {
          const r2 = await fetch('/api/hashtags', { credentials: 'include' })
          const list = await r2.json().catch(() => [])
          currentSet = new Set(
            (Array.isArray(list) ? list : [])
              .filter((h: { creator_ids: string[] }) => h.creator_ids.includes(creatorId))
              .map((h: { id: string }) => h.id),
          )
        }

        const toAdd = [...newSet].filter((id) => !currentSet.has(id))
        const toRemove = [...currentSet].filter((id) => !newSet.has(id))
        await Promise.all([
          ...toAdd.map((hid) => fetch(`/api/hashtags/${hid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ add_creator_ids: [creatorId] }),
          })),
          ...toRemove.map((hid) => fetch(`/api/hashtags/${hid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ remove_creator_ids: [creatorId] }),
          })),
        ])
      }

      refreshAll()
      push(data.id ? 'Creator updated' : 'Creator added')
      setEditing(null); setAdding(false)
    } finally {
      setSaving(false)
    }
  }

  async function remove(c: Creator) {
    setSaving(true)
    try {
      const r = await fetch(`/api/creators?id=${c.id}`, { method: 'DELETE', credentials: 'include' })
      if (r.ok) {
        refreshAll()
        push('Creator deleted')
        setEditing(null)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="filter-bar" style={{ marginTop: 4 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search creators" />
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} style={{ filter: 'invert(1)' }} />
          Add creator
        </button>
      </div>

      <div className="table-card">
        <div className="table-head">
          <h3>All creators</h3>
          <span className="muted" style={{ fontSize: 12 }}>{rows.length}</span>
        </div>
        <div className="table-scroll">
          {rows.length === 0 ? (
            <EmptyState label="No creators" hint="Add a creator to get started." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Arm</th>
                  <th>TikTok</th>
                  <th>Instagram</th>
                  <th>YouTube</th>
                  <th>Facebook</th>
                  <th>PayPal</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><span style={{ fontWeight: 500 }}>{c.name}</span></td>
                    <td><Badge kind={`arm-${c.arm.toLowerCase()}`}>{c.arm}</Badge></td>
                    <td className="muted">{c.tiktok_handle ? '@' + c.tiktok_handle : ''}</td>
                    <td className="muted">{c.instagram_handle ? '@' + c.instagram_handle : ''}</td>
                    <td className="muted">{c.youtube_handle ? '@' + c.youtube_handle : ''}</td>
                    <td className="muted">{c.facebook_handle ? '@' + c.facebook_handle : ''}</td>
                    <td className="muted">{c.paypal_email}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => setEditing(c)}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {(editing || adding) && (
        <CreatorForm
          creator={editing ?? undefined}
          saving={saving}
          onClose={() => { setEditing(null); setAdding(false) }}
          onSave={save}
          onDelete={editing ? () => remove(editing) : undefined}
        />
      )}
    </>
  )
}

interface CreatorFormProps {
  creator?: Creator
  saving: boolean
  onClose: () => void
  onSave: (data: CreatorFormData) => void
  onDelete?: () => void
}

function CreatorForm({ creator, saving, onClose, onSave, onDelete }: CreatorFormProps) {
  const [name, setName] = useState(creator?.name || '')
  const [arm, setArm] = useState<Arm>(creator?.arm || 'Arm A')
  const [paypal, setPaypal] = useState(creator?.paypal_email || '')
  const [tt, setTt] = useState(creator?.tiktok_handle || '')
  const [ig, setIg] = useState(creator?.instagram_handle || '')
  const [yt, setYt] = useState(creator?.youtube_handle || '')
  const [fb, setFb] = useState(creator?.facebook_handle || '')
  const [hashtagIds, setHashtagIds] = useState<string[]>([])
  const [err, setErr] = useState('')

  // Load existing hashtags for the dropdown + pre-fill assigned ones for an edit.
  const { data: hashtags = [] } = useHashtags()
  useEffect(() => {
    if (!creator) {
      setHashtagIds([])
      return
    }
    const assigned = hashtags.filter((h) => h.creator_ids.includes(creator.id)).map((h) => h.id)
    setHashtagIds(assigned)
  }, [creator, hashtags])

  function toggleHashtag(id: string) {
    setHashtagIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }

  function submit() {
    if (!name || !arm || !paypal) return setErr('Name, arm, and PayPal email are required.')
    // SHELVED ROUND 15 (2026-05-21): cross-post rule no longer applies, so the
    // TT-and-IG-both-required gate from Round 4 R2 is replaced with
    // at-least-one-platform-required. To restore the original Round 4 R2
    // rule alongside cross_posted, revert this and the matching change in
    // src/app/api/creators/route.ts back to `if (!tt || !ig)`.
    // ROUND 21: Facebook counts toward the at-least-one-platform requirement.
    if (!tt && !ig && !yt && !fb) return setErr('At least one platform handle (TikTok, Instagram, YouTube, or Facebook) is required.')
    setErr('')
    onSave({
      id: creator?.id,
      name,
      arm,
      paypal_email: paypal,
      tiktok_handle: tt.replace(/^@/, ''),
      instagram_handle: ig.replace(/^@/, ''),
      youtube_handle: yt.replace(/^@/, ''),
      facebook_handle: fb.replace(/^@/, ''),
      hashtag_ids: hashtagIds,
    })
  }

  return (
    <Modal
      size="sm"
      title={creator ? 'Edit creator' : 'Add creator'}
      onClose={onClose}
      footer={
        <>
          {onDelete && <button className="btn danger" onClick={onDelete} style={{ marginRight: 'auto' }} disabled={saving}>Delete</button>}
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? '...' : creator ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      {err && <div style={{ fontSize: 12, color: 'var(--negative)', marginBottom: 10 }}>{err}</div>}
      <div className="field"><label>Name *</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field">
        <label>Arm *</label>
        <select className="input" value={arm} onChange={(e) => setArm(e.target.value as Arm)}>
          <option value="Arm A">Arm A</option>
          <option value="Arm B">Arm B</option>
        </select>
      </div>
      <div className="field"><label>PayPal email *</label><input className="input" value={paypal} onChange={(e) => setPaypal(e.target.value)} type="email" /></div>
      {/* SHELVED ROUND 15: per-platform required-asterisks removed; the
          form-level rule is now "at least one platform handle required". */}
      <div className="field"><label>TikTok handle</label><input className="input" value={tt} onChange={(e) => setTt(e.target.value)} placeholder="@handle" /></div>
      <div className="field"><label>Instagram handle</label><input className="input" value={ig} onChange={(e) => setIg(e.target.value)} placeholder="@handle" /></div>
      <div className="field"><label>YouTube handle</label><input className="input" value={yt} onChange={(e) => setYt(e.target.value)} placeholder="@handle" /></div>
      {/* ROUND 21: Facebook Reels handle (optional). Use the Shortimize username
          slug (e.g. bri-lately) or numeric profile id, matching how the handle
          appears on Shortimize. */}
      <div className="field"><label>Facebook handle</label><input className="input" value={fb} onChange={(e) => setFb(e.target.value)} placeholder="@handle" /></div>

      <div className="field">
        <label>Hashtags (direct assignments)</label>
        {hashtags.length === 0 ? (
          <input
            className="input"
            disabled
            value=""
            placeholder="No existing hashtags. Go to Settings -> Hashtag tracking to add one."
          />
        ) : (
          <div style={{ border: '1px solid var(--line)', maxHeight: 160, overflow: 'auto' }}>
            {hashtags.map((h) => (
              <label
                key={h.id}
                className="row"
                style={{
                  padding: '8px 12px', borderBottom: '1px solid var(--line)', gap: 8,
                  fontSize: 13, color: 'var(--ink)', textTransform: 'none', letterSpacing: 0, cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  className="cb"
                  checked={hashtagIds.includes(h.id)}
                  onChange={() => toggleHashtag(h.id)}
                />
                <span className="num" style={{ fontWeight: 500 }}>{displayTag(h.tag)}</span>
                {h.arms.length > 0 && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    (also assigned to {h.arms.join(', ')} arm{h.arms.length > 1 ? 's' : ''})
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Direct assignments only. Arm-wide hashtags apply automatically based on the arm above.
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11 }}>* Required.</div>
    </Modal>
  )
}
