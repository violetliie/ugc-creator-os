import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import type { Video, VideoGroup, VideoGroupWithVideos } from '@/lib/types'

/**
 * GET /api/videos?creator_id=&cycle_id=
 * Returns video_groups with their member videos joined inline.
 *
 * Creator role: can only see groups belonging to their own creator_id.
 *
 * Round 10 patch (2026-05-15): paginate to avoid Supabase PostgREST's
 * default 1000-row limit. At 49 creators we have 1400+ groups in DB; the
 * un-paginated default query was returning only the most-recent 1000 by
 * posted_date, causing the Creators list "Current period" totals to be
 * silently understated for any creator whose older-cycle groups got
 * truncated. The details modal worked because it filters by cycle_id
 * up-front and returns small result sets.
 */
const PAGE_SIZE = 1000

export async function GET(req: Request) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { searchParams } = new URL(req.url)
  const creatorId = searchParams.get('creator_id')
  const cycleId = searchParams.get('cycle_id')

  // Short-circuit for Creator-role with no linked creator_id.
  if (session.role === 'Creator' && !session.creator_id) {
    return NextResponse.json([])
  }

  // Paginate to avoid Supabase PostgREST's default 1000-row limit. Hard
  // safety ceiling at 50,000 rows in case of a query bug.
  const groups: VideoGroup[] = []
  for (let safety = 0; safety < 50; safety++) {
    let q = supabaseAdmin
      .from('video_groups')
      .select('*')
      .order('posted_date', { ascending: false })
      .range(groups.length, groups.length + PAGE_SIZE - 1)
    if (cycleId) q = q.eq('cycle_id', cycleId)
    if (session.role === 'Creator') {
      q = q.eq('creator_id', session.creator_id as string)
    } else if (creatorId) {
      q = q.eq('creator_id', creatorId)
    }
    const { data, error: dbErr } = await q
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
    if (!data || data.length === 0) break
    groups.push(...(data as VideoGroup[]))
    if (data.length < PAGE_SIZE) break
  }
  if (groups.length === 0) return NextResponse.json([])

  // Bulk-fetch member videos for these groups. Round 10 patch: also paginate
  // these to dodge the 1000-row limit. At ~2 members per group and 1400+
  // groups in DB we'd otherwise truncate to the first 1000 members and lose
  // ~1900 member rows, leaving most groups display-empty in the UI.
  const groupIds = groups.map((g) => g.id)
  // Supabase's PostgREST `.in()` has its own URL length cap (~2KB); chunk the
  // groupIds list into batches of 200 to stay well under it.
  const ID_CHUNK = 200
  const members: { group_id: string; video_id: string }[] = []
  for (let i = 0; i < groupIds.length; i += ID_CHUNK) {
    const chunk = groupIds.slice(i, i + ID_CHUNK)
    let from = 0
    for (let safety = 0; safety < 50; safety++) {
      const { data, error: mErr } = await supabaseAdmin
        .from('video_group_members')
        .select('group_id, video_id')
        .in('group_id', chunk)
        .range(from, from + PAGE_SIZE - 1)
      if (mErr) {
        return NextResponse.json({ error: mErr.message }, { status: 500 })
      }
      if (!data || data.length === 0) break
      members.push(...data)
      if (data.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }

  // Same pagination treatment for the actual videos fetch.
  const videoIds = members.map((m) => m.video_id)
  const videos: Video[] = []
  for (let i = 0; i < videoIds.length; i += ID_CHUNK) {
    const chunk = videoIds.slice(i, i + ID_CHUNK)
    let from = 0
    for (let safety = 0; safety < 50; safety++) {
      const { data, error: vErr } = await supabaseAdmin
        .from('videos')
        .select('*')
        .in('id', chunk)
        .range(from, from + PAGE_SIZE - 1)
      if (vErr) {
        return NextResponse.json({ error: vErr.message }, { status: 500 })
      }
      if (!data || data.length === 0) break
      videos.push(...(data as Video[]))
      if (data.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }

  const videoById = new Map(videos.map((v) => [v.id, v]))
  const videosByGroup = new Map<string, Video[]>()
  for (const m of members) {
    const v = videoById.get(m.video_id)
    if (!v) continue
    if (!videosByGroup.has(m.group_id)) videosByGroup.set(m.group_id, [])
    videosByGroup.get(m.group_id)!.push(v)
  }

  const result: VideoGroupWithVideos[] = groups.map((g) => ({
    ...g,
    videos: videosByGroup.get(g.id) || [],
  }))
  return NextResponse.json(result)
}
