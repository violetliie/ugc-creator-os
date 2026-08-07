'use client'

import { useState } from 'react'
import { useUsers, useCreators, refreshAll } from '@/lib/hooks'
import type { User, UserRole } from '@/lib/types'
import { useToast } from '@/components/ui/Toast'
import SearchInput from '@/components/ui/SearchInput'
import Badge from '@/components/ui/Badge'
import EmptyState from '@/components/ui/EmptyState'
import Modal from '@/components/ui/Modal'
import Icon from '@/components/ui/Icon'

interface UserFormData {
  id?: string
  email: string
  password?: string
  role: UserRole
  creator_id: string | null
  name: string | null
}

export default function UsersPane() {
  const { push } = useToast()
  const { data: users = [], mutate } = useUsers()
  const { data: creators = [] } = useCreators()

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<User | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)

  const rows = users
    .filter((u) => !u.deleted_at) // hide soft-deleted by default
    .filter((u) => !search ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.name?.toLowerCase().includes(search.toLowerCase()) ?? false))

  async function save(data: UserFormData) {
    setSaving(true)
    try {
      const r = await fetch('/api/users', {
        method: data.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      })
      const d = await r.json()
      if (r.ok) {
        refreshAll()
        push(data.id ? 'User updated' : 'User added')
        setEditing(null); setAdding(false)
      } else {
        push(d.error || 'Failed')
      }
    } finally {
      setSaving(false)
    }
  }

  async function remove(u: User) {
    setSaving(true)
    try {
      const r = await fetch(`/api/users?id=${u.id}`, { method: 'DELETE', credentials: 'include' })
      if (r.ok) {
        refreshAll()
        push('User removed')
        setEditing(null)
      } else {
        const d = await r.json().catch(() => ({}))
        push(d.error || 'Failed')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="filter-bar" style={{ marginTop: 4 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search users" />
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} style={{ filter: 'invert(1)' }} />
          Add user
        </button>
      </div>

      <div className="table-card">
        <div className="table-head">
          <h3>All users</h3>
          <span className="muted" style={{ fontSize: 12 }}>{rows.length} users</span>
        </div>
        <div className="table-scroll">
          {rows.length === 0 ? (
            <EmptyState label="No users match your search" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Access</th>
                  <th>Linked creator</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const linked = u.creator_id ? creators.find((c) => c.id === u.creator_id) : null
                  return (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 500 }}>{u.name || <span className="muted">No name</span>}</td>
                      <td>{u.email}</td>
                      <td><Badge kind={u.role === 'Admin' ? 'role-admin' : 'role-creator'}>{u.role}</Badge></td>
                      <td>{linked ? linked.name : <span className="muted">none</span>}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn sm" onClick={() => setEditing(u)}>Edit</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {(editing || adding) && (
        <UserForm
          user={editing ?? undefined}
          creators={creators.filter((c) => !c.deleted_at)}
          saving={saving}
          onClose={() => { setEditing(null); setAdding(false) }}
          onSave={save}
          onDelete={editing ? () => remove(editing) : undefined}
        />
      )}
    </>
  )
}

interface UserFormProps {
  user?: User
  creators: { id: string; name: string }[]
  saving: boolean
  onClose: () => void
  onSave: (data: UserFormData) => void
  onDelete?: () => void
}

function UserForm({ user, creators, saving, onClose, onSave, onDelete }: UserFormProps) {
  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>(user?.role || 'Creator')
  const [isCreator, setIsCreator] = useState(!!user?.creator_id)
  const [creatorId, setCreatorId] = useState(user?.creator_id || '')
  const [err, setErr] = useState('')

  function submit() {
    if (!email || !role) return setErr('Email and role are required.')
    if (!user && !password) return setErr('Password is required for new users.')
    if (!user && password.length < 8) return setErr('Password must be at least 8 characters.')
    if (isCreator && !creatorId) return setErr('Select a linked creator.')
    onSave({
      id: user?.id,
      email,
      password: password || undefined,
      role,
      creator_id: isCreator ? creatorId : null,
      name: name || null,
    })
  }

  return (
    <Modal
      size="sm"
      title={user ? 'Edit user' : 'Add user'}
      onClose={onClose}
      footer={
        <>
          {onDelete && <button className="btn danger" onClick={onDelete} style={{ marginRight: 'auto' }} disabled={saving}>Delete</button>}
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? '...' : user ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      {err && <div style={{ fontSize: 12, color: 'var(--negative)', marginBottom: 10 }}>{err}</div>}
      <div className="field">
        <label>Display name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="(optional)" />
      </div>
      <div className="field">
        <label>Email *</label>
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
      </div>
      <div className="field">
        <label>{user ? 'New password' : 'Password *'}</label>
        <input
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="text"
          placeholder={user ? 'Leave blank to keep current' : 'At least 8 characters'}
        />
      </div>
      <div className="field">
        <label>Access *</label>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          <option value="Admin">Admin</option>
          <option value="Creator">Creator</option>
        </select>
      </div>
      <div className="field">
        <label className="row" style={{ gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--ink)' }}>
          <input type="checkbox" className="cb" checked={isCreator} onChange={(e) => setIsCreator(e.target.checked)} />
          Is creator? <span className="muted">Link this login to a creator profile</span>
        </label>
        {isCreator && (
          <select className="input" value={creatorId} onChange={(e) => setCreatorId(e.target.value)} style={{ marginTop: 8 }}>
            <option value="">Select creator</option>
            {creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>* Required.</div>
    </Modal>
  )
}
