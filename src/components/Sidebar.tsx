'use client'

import Image from 'next/image'
import type { SessionUser } from '@/lib/types'
import Icon from './ui/Icon'

export type Tab = 'overview' | 'creators' | 'tutorial' | 'settings'

const TABS: { id: Tab; label: string; icon: string; adminOnly: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: 'bar-chart', adminOnly: true },
  { id: 'creators', label: 'Creators', icon: 'user',      adminOnly: false },
  { id: 'tutorial', label: 'Tutorial', icon: 'info',      adminOnly: false },
  { id: 'settings', label: 'Settings', icon: 'settings',  adminOnly: true },
]

interface SidebarProps {
  tab: Tab
  setTab: (t: Tab) => void
  session: SessionUser
  onLogout: () => void
}

export default function Sidebar({ tab, setTab, session, onLogout }: SidebarProps) {
  const displayName = session.name || (session.role === 'Admin' ? 'Admin' : session.email.split('@')[0])

  return (
    <aside className="sidebar">
      <div className="brand">
        <Image src="/assets/logo-mark.svg" className="brand-cube" alt="" width={22} height={22} />
        <div>
          <div className="brand-name">Your Company</div>
          <div className="brand-sub">UGC CreatorOS</div>
        </div>
      </div>

      <div className="nav-section">Workspace</div>

      {TABS.map((t) => {
        const locked = t.adminOnly && session.role !== 'Admin'
        const active = tab === t.id
        return (
          <button
            key={t.id}
            className={`nav-item${active ? ' active' : ''}${locked ? ' locked' : ''}`}
            disabled={locked}
            onClick={() => !locked && setTab(t.id)}
            title={locked ? 'Admins only' : ''}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
            {locked && (
              <svg className="lock" viewBox="0 0 16 16" fill="none">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        )
      })}

      <div className="sidebar-foot">
        <div className="who">
          <div className="nm">{displayName}</div>
          <div className="em">{session.email}</div>
        </div>
        <button className="logout-btn" onClick={onLogout} title="Sign out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M9 11l3-3-3-3M12 8H5M5 3H3v10h2"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </aside>
  )
}
