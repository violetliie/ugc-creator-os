'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'

/**
 * Login screen.
 * Round 4 R3: NO em-dashes/en-dashes.
 * Round 3 J4 / 17.J: NO demo-login click-to-fill block in production.
 */
export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [booting, setBooting] = useState(false)

  // If already authenticated, redirect.
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' }).then((r) => {
      if (r.ok) router.replace('/dashboard')
    })
  }, [router])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Invalid email or password.')
        setSubmitting(false)
        return
      }
      setBooting(true)
      setTimeout(() => router.push('/dashboard'), 2200)
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  if (booting) {
    return (
      <div className="boot">
        <Image className="boot-cube" src="/assets/logo-mark.svg" alt="" width={56} height={56} />
        <div className="boot-stack">
          <div className="boot-wordmark">Your Company</div>
          <div className="boot-tag">UGC CreatorOS</div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-wrap centered">
      <div className="login-form-wrap">
        <div className="login-brand">
          <Image src="/assets/logo-mark.svg" alt="" className="login-logo" width={64} height={64} />
          <div className="login-brand-text">
            <div className="login-brand-name">Your Company</div>
            <div className="login-brand-sub">UGC CreatorOS</div>
          </div>
        </div>

        <form className="login-card" onSubmit={submit}>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 22 }}>
            Sign in
          </div>

          <div className="field">
            <label>Email</label>
            <input
              className={`input${error ? ' invalid' : ''}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              className={`input${error ? ' invalid' : ''}`}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--negative)', marginBottom: 10 }}>{error}</div>
          )}

          <button type="submit" className="login-submit" disabled={submitting}>
            {submitting ? 'Signing in' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
