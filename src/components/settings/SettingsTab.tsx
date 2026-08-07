'use client'

import { useState } from 'react'
import SyncNowButton from '@/components/SyncNowButton'
import UsersPane from './UsersPane'
import CreatorsEditPane from './CreatorsEditPane'
import StructurePane from './StructurePane'
import SecretsPane from './SecretsPane'
import HashtagsPane from './HashtagsPane'
import ActivityLogPane from './ActivityLogPane'

type SubTab = 'users' | 'creators' | 'structure' | 'hashtags' | 'secrets' | 'activity'

export default function SettingsTab() {
  const [sub, setSub] = useState<SubTab>('users')

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <div className="page-title">Settings</div>
        </div>
        <SyncNowButton />
      </div>

      <div className="tabs">
        <button className={`tab${sub === 'users' ? ' active' : ''}`} onClick={() => setSub('users')}>Users</button>
        <button className={`tab${sub === 'creators' ? ' active' : ''}`} onClick={() => setSub('creators')}>Edit creator</button>
        <button className={`tab${sub === 'structure' ? ' active' : ''}`} onClick={() => setSub('structure')}>Payment structure</button>
        <button className={`tab${sub === 'hashtags' ? ' active' : ''}`} onClick={() => setSub('hashtags')}>Hashtag tracking</button>
        <button className={`tab${sub === 'secrets' ? ' active' : ''}`} onClick={() => setSub('secrets')}>Cookies &amp; secrets</button>
        <button className={`tab${sub === 'activity' ? ' active' : ''}`} onClick={() => setSub('activity')}>Activity log</button>
      </div>

      {sub === 'users' && <UsersPane />}
      {sub === 'creators' && <CreatorsEditPane />}
      {sub === 'structure' && <StructurePane />}
      {sub === 'hashtags' && <HashtagsPane />}
      {sub === 'secrets' && <SecretsPane />}
      {sub === 'activity' && <ActivityLogPane />}
    </div>
  )
}
