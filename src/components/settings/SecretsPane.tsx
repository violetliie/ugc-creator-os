'use client'

import { useState } from 'react'
import { useSecrets, refreshAll } from '@/lib/hooks'
import { fmtDateTimeET } from '@/lib/fmt'
import { useToast } from '@/components/ui/Toast'
import Modal from '@/components/ui/Modal'

/**
 * Cookies & secrets pane (Round 4 R4 / Round 8 cleanup).
 * Per the design notes/§17.F, this is WRITE ONLY:
 *   - GET /api/secrets returns metadata only (key, last_updated_at, length, updater).
 *   - We never display or fetch the secret value.
 *   - "Replace" opens a modal with a textarea; on save it POSTs to /api/secrets.
 *
 * Round 8 (2026-05-08): the only entry was `instagram_cookies_txt`, used by
 * the legacy yt-dlp Instagram extractor. Round 8 replaced that with public
 * og:image scraping (no cookies). The entry is removed from this UI; the
 * /api/secrets POST endpoint also rejects the now-unknown key. The DB row
 * has been dropped (see design notes Section 24.K migration SQL).
 *
 * The pane is kept around with an empty SECRET_DEFINITIONS array so future
 * secrets can be added by appending a row to this array + adding the key to
 * the API's ALLOWED_KEYS set.
 */

const SECRET_DEFINITIONS: ReadonlyArray<{ key: string; label: string }> = []

export default function SecretsPane() {
  const { data: secrets = [], mutate } = useSecrets()
  const [editingKey, setEditingKey] = useState<string | null>(null)

  return (
    <>
      <div className="table-card">
        <div className="table-head">
          <h3>Cookies &amp; secrets</h3>
        </div>
        <div className="table-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Key</th>
                <th>Last updated</th>
                <th>Updated by</th>
                <th style={{ textAlign: 'right' }}>Length</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {SECRET_DEFINITIONS.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '24px 0' }}>
                    No managed secrets.
                  </td>
                </tr>
              )}
              {SECRET_DEFINITIONS.map((def) => {
                const meta = secrets.find((s) => s.key === def.key)
                return (
                  <tr key={def.key}>
                    <td>
                      <span style={{ fontWeight: 500 }}>{def.label}</span>
                    </td>
                    <td className="muted">{meta ? fmtDateTimeET(meta.updated_at) : 'never'}</td>
                    <td>{meta?.updated_by_name || <span className="muted">unknown</span>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {meta ? `${meta.char_length.toLocaleString()} chars` : <span className="muted">empty</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm primary" onClick={() => setEditingKey(def.key)}>Replace</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editingKey && (() => {
        const def = SECRET_DEFINITIONS.find((d) => d.key === editingKey)
        if (!def) return null
        return (
          <SecretEditorModal
            secretKey={editingKey}
            definition={def}
            onClose={() => setEditingKey(null)}
            onSaved={() => { refreshAll(); setEditingKey(null) }}
          />
        )
      })()}
    </>
  )
}

interface EditorProps {
  secretKey: string
  definition: { key: string; label: string }
  onClose: () => void
  onSaved: () => void
}

function SecretEditorModal({ secretKey, definition, onClose, onSaved }: EditorProps) {
  const { push } = useToast()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!value.trim()) {
      push('Cannot save an empty value.')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: secretKey, value }),
      })
      const d = await r.json()
      if (r.ok) {
        push('Cookies updated')
        onSaved()
      } else {
        push(d.error || 'Failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      size="md"
      title={`Replace: ${definition.label}`}
      sub="Paste the new content below. Existing value is not displayed for security."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || !value.trim()}>
            {saving ? '...' : 'Save'}
          </button>
        </>
      }
    >
      <textarea
        className="input"
        style={{ minHeight: 200, fontFamily: "'Geist Mono', monospace", fontSize: 12 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="# Netscape HTTP Cookie File..."
        spellCheck={false}
      />
    </Modal>
  )
}
