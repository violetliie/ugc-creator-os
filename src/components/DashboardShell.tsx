'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import type { SessionUser } from '@/lib/types'
import Sidebar, { type Tab } from './Sidebar'
import { ToastProvider } from './ui/Toast'
import SWRProvider from './SWRProvider'
import OverviewTab from './overview/OverviewTab'
import CreatorsTab from './creators/CreatorsTab'
import SettingsTab from './settings/SettingsTab'
import TutorialTab from './tutorial/TutorialTab'

/**
 * The dashboard shell: sidebar + tab routing. Per Round 4 + §17.J,
 * NO floating "Demo · Admin/Creator" tip box, NO tweaks panel.
 */
interface Props {
  session: SessionUser
  children?: React.ReactNode
}

export default function DashboardShell({ session }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(session.role === 'Admin' ? 'overview' : 'creators')
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 800)
    return () => clearTimeout(t)
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  if (booting) {
    return (
      <div className="boot">
        <Image className="boot-cube" src="/assets/logo-mark.svg" alt="" width={48} height={48} />
        <div className="boot-stack">
          <div className="boot-wordmark">Your Company</div>
          <div className="boot-tag">UGC CreatorOS</div>
        </div>
      </div>
    )
  }

  return (
    <SWRProvider>
      <ToastProvider>
        <div className="app-root">
          <Sidebar tab={tab} setTab={setTab} session={session} onLogout={handleLogout} />

          {tab === 'overview' && session.role === 'Admin' && <OverviewTab />}
          {tab === 'creators' && <CreatorsTab session={session} />}
          {tab === 'tutorial' && <TutorialTab session={session} />}
          {tab === 'settings' && session.role === 'Admin' && <SettingsTab />}
        </div>
      </ToastProvider>
    </SWRProvider>
  )
}
