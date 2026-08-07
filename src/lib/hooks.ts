import useSWR, { mutate as globalMutate, type SWRResponse } from 'swr'
import type {
  AuditLogEntry,
  Creator,
  CreatorName,
  EffectiveHashtag,
  HashtagWithAssignments,
  User,
  PaymentCycle,
  PaymentSnapshot,
  PaymentStructureTier,
  ReferralWithMeta,
  SecretMeta,
  SessionUser,
  SyncRun,
  VideoGroupWithVideos,
} from './types'

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.error || `Request failed with ${res.status}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  return res.json()
}

export function useSession(): SWRResponse<SessionUser> {
  return useSWR<SessionUser>('/api/me', fetcher, { revalidateOnFocus: false })
}

export function useCreators(): SWRResponse<Creator[]> {
  return useSWR<Creator[]>('/api/creators', fetcher)
}

export function useUsers(): SWRResponse<User[]> {
  return useSWR<User[]>('/api/users', fetcher)
}

export function useCycles(): SWRResponse<PaymentCycle[]> {
  return useSWR<PaymentCycle[]>('/api/cycles', fetcher)
}

export function useSnapshots(cycleId?: string): SWRResponse<PaymentSnapshot[]> {
  const key = cycleId ? `/api/snapshots?cycle_id=${cycleId}` : '/api/snapshots'
  return useSWR<PaymentSnapshot[]>(key, fetcher)
}

export function useVideoGroups(
  creatorId?: string,
  cycleId?: string,
): SWRResponse<VideoGroupWithVideos[]> {
  const params = new URLSearchParams()
  if (creatorId) params.set('creator_id', creatorId)
  if (cycleId) params.set('cycle_id', cycleId)
  const qs = params.toString()
  const key = qs ? `/api/videos?${qs}` : '/api/videos'
  return useSWR<VideoGroupWithVideos[]>(key, fetcher)
}

export function usePaymentStructure(): SWRResponse<PaymentStructureTier[]> {
  return useSWR<PaymentStructureTier[]>('/api/payment-structure', fetcher)
}

export function useSyncRuns(limit = 10): SWRResponse<SyncRun[]> {
  return useSWR<SyncRun[]>(`/api/sync-runs?limit=${limit}`, fetcher, {
    refreshInterval: 5_000, // poll every 5s for live "Last synced" / running status
  })
}

export function useSecrets(): SWRResponse<SecretMeta[]> {
  return useSWR<SecretMeta[]>('/api/secrets', fetcher)
}

export function useHashtags(): SWRResponse<HashtagWithAssignments[]> {
  return useSWR<HashtagWithAssignments[]>('/api/hashtags', fetcher)
}

export function useEffectiveHashtags(creatorId: string | null | undefined): SWRResponse<EffectiveHashtag[]> {
  const key = creatorId ? `/api/creators/${creatorId}/effective-hashtags` : null
  return useSWR<EffectiveHashtag[]>(key, fetcher)
}

export function useAuditLog(limit = 100): SWRResponse<AuditLogEntry[]> {
  return useSWR<AuditLogEntry[]>(`/api/audit-log?limit=${limit}`, fetcher, {
    refreshInterval: 10_000, // refresh every 10s for near-live activity
  })
}

/** Round 24: referrals made BY a creator (enriched with names + progress). */
export function useReferrals(creatorId: string | null | undefined): SWRResponse<ReferralWithMeta[]> {
  const key = creatorId ? `/api/referrals?creator_id=${creatorId}` : null
  return useSWR<ReferralWithMeta[]>(key, fetcher)
}

/** Round 24: ALL awarded referrals landing in a cycle (admin money surfaces).
 * Pass null/undefined to skip fetching (e.g. creator-role views). */
export function useCycleReferrals(cycleId: string | null | undefined): SWRResponse<ReferralWithMeta[]> {
  const key = cycleId ? `/api/referrals?cycle_id=${cycleId}` : null
  return useSWR<ReferralWithMeta[]>(key, fetcher)
}

/** Round 24: minimal id+name list for the referral dropdown (all roles). */
export function useCreatorNames(): SWRResponse<CreatorName[]> {
  return useSWR<CreatorName[]>('/api/creators/names', fetcher)
}

/** Force-refresh every API endpoint we care about.
 *
 * Important: we revalidate WITHOUT clearing the existing cache. Passing
 * `undefined` as the data argument (or omitting it without `populateCache: false`)
 * makes SWR briefly set `data: undefined` until new data arrives, which
 * causes downstream components to render with default fallbacks (e.g. empty
 * arrays) and modals/popups that depend on a row being found in those arrays
 * unmount mid-edit. Calling `globalMutate(filter)` with no data argument
 * triggers revalidation while keeping the existing cached data visible until
 * the fresh data arrives.
 */
export function refreshAll() {
  globalMutate((key) => typeof key === 'string' && key.startsWith('/api/'))
}
