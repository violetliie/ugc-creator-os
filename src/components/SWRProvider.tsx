'use client'

import { SWRConfig } from 'swr'

/**
 * Global SWR config: every fetch revalidates on window focus and on tab
 * reconnect, so multiple admins editing concurrently see each other's
 * changes when they tab back in. Combined with the explicit refreshAll()
 * after every mutation, this satisfies the "auto-trigger everywhere"
 * requirement.
 */
export default function SWRProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        dedupingInterval: 1500,
        focusThrottleInterval: 5000,
      }}
    >
      {children}
    </SWRConfig>
  )
}
