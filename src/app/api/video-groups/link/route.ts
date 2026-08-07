import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'
import { cycleIdForDate } from '@/lib/cycles'
import { groupPayout } from '@/lib/payout'
import type { Arm, PaymentStructureTier } from '@/lib/types'

/**
 * POST /api/video-groups/link   admin-only
 * Body: { source_video_id, target_group_id }
 *
 * Round 10 (2026-05-10): manual cross-platform linking. Lets an admin
 * override the automatic matcher by moving a singleton video into an
 * existing group (typically to fix a same-video pair the matcher missed
 * due to phash divergence > Tier 2 cap, or where titles diverge too much
 * for Tier 2 to confirm).
 *
 * Behavior:
 *   - Validates both belong to the same creator
 *   - Rejects if either side is in a paid/frozen cycle
 *   - If target group already has a video with source's platform, that
 *     conflicting video is EJECTED to its own new singleton group (so
 *     UNIQUE(video_id) on video_group_members is preserved)
 *   - Removes source from its current group; deletes that group if now empty
 *   - Inserts source into target group; recomputes target's cycle_id /
 *     highest_views / cross_posted / payout from the new member set
 *   - Writes a 'video_group.manual_link' audit log entry
 */

interface GroupMember {
  video_id: string
  platform: string
  latest_views: number
  posted_date: string
  created_at_remote: string
  cycle_id: string
}

async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
  if (!supabaseAdmin) return []
  const { data: members } = await supabaseAdmin
    .from('video_group_members')
    .select('video_id')
    .eq('group_id', groupId)
  if (!members || members.length === 0) return []
  const { data: videos } = await supabaseAdmin
    .from('videos')
    .select('id, platform, latest_views, posted_date, created_at_remote, cycle_id')
    .in('id', members.map((m) => m.video_id))
  return (videos || []).map((v) => ({
    video_id: v.id,
    platform: v.platform,
    latest_views: v.latest_views ?? 0,
    posted_date: v.posted_date,
    created_at_remote: v.created_at_remote,
    cycle_id: v.cycle_id,
  }))
}

async function recomputeGroupStats(
  groupId: string,
  arm: Arm,
  tiers: PaymentStructureTier[],
): Promise<void> {
  if (!supabaseAdmin) return
  const members = await fetchGroupMembers(groupId)
  if (members.length === 0) {
    // Group has no remaining members; delete it. Caller should usually
    // detect this case BEFORE calling recompute, but we handle it defensively.
    await supabaseAdmin.from('video_groups').delete().eq('id', groupId)
    return
  }
  const plats = new Set(members.map((m) => m.platform))
  const crossPosted = plats.has('tiktok') && plats.has('instagram')
  const highestViews = Math.max(...members.map((m) => m.latest_views))
  // Earliest member by created_at_remote = group's cycle/posted_date.
  const earliest = [...members].sort((a, b) =>
    a.created_at_remote.localeCompare(b.created_at_remote),
  )[0]
  const newCycleId = cycleIdForDate(earliest.created_at_remote)

  // Read current `payable` (admin may have toggled it; preserve)
  const { data: cur } = await supabaseAdmin
    .from('video_groups')
    .select('payable')
    .eq('id', groupId)
    .single()
  const payable = cur?.payable ?? true
  const payout = groupPayout(highestViews, arm, tiers, crossPosted, payable)

  await supabaseAdmin
    .from('video_groups')
    .update({
      cycle_id: newCycleId,
      posted_date: earliest.posted_date,
      highest_views: highestViews,
      cross_posted: crossPosted,
      payout,
      last_updated_at: new Date().toISOString(),
    })
    .eq('id', groupId)

  // Sync each member's cycle_id to the group's cycle.
  for (const m of members) {
    if (m.cycle_id !== newCycleId) {
      await supabaseAdmin
        .from('videos')
        .update({ cycle_id: newCycleId })
        .eq('id', m.video_id)
    }
  }
}

export async function POST(req: Request) {
  // ROUND 19 (2026-05-22): allow Creator role IF the source video belongs
  // to session.creator_id. Admin can link for any creator. The existing
  // same-creator check below already prevents cross-creator linking.
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const body = await req.json().catch(() => ({}))
  const sourceVideoId = body.source_video_id
  const targetGroupId = body.target_group_id
  if (!sourceVideoId || !targetGroupId) {
    return NextResponse.json(
      { error: 'source_video_id and target_group_id are required' },
      { status: 400 },
    )
  }

  // 1. Fetch source video
  const { data: source } = await supabaseAdmin
    .from('videos')
    .select('id, creator_id, platform, cycle_id, posted_date, latest_views, created_at_remote')
    .eq('id', sourceVideoId)
    .maybeSingle()
  if (!source) return NextResponse.json({ error: 'Source video not found' }, { status: 404 })

  // 2. Fetch target group
  const { data: targetGroup } = await supabaseAdmin
    .from('video_groups')
    .select('id, creator_id, cycle_id, payable')
    .eq('id', targetGroupId)
    .maybeSingle()
  if (!targetGroup) return NextResponse.json({ error: 'Target group not found' }, { status: 404 })

  // 3. Same creator?
  if (source.creator_id !== targetGroup.creator_id) {
    return NextResponse.json(
      { error: 'Source and target must belong to the same creator' },
      { status: 400 },
    )
  }

  // ROUND 19: ownership check for Creator role. Admin bypasses.
  if (session!.role !== 'Admin') {
    if (session!.role !== 'Creator' || source.creator_id !== session!.creator_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // 4. Paid-cycle protection — neither side may be in a paid/frozen cycle.
  const involvedCycleIds = Array.from(new Set([source.cycle_id, targetGroup.cycle_id]))
  const { data: cycles } = await supabaseAdmin
    .from('payment_cycles')
    .select('id, marked_paid_at')
    .in('id', involvedCycleIds)
  const paidCycle = cycles?.find((c) => c.marked_paid_at)
  if (paidCycle) {
    return NextResponse.json(
      { error: `Cycle ${paidCycle.id} is already paid; cannot link.` },
      { status: 400 },
    )
  }
  const { data: snaps } = await supabaseAdmin
    .from('payment_snapshots')
    .select('cycle_id, marked_paid_at')
    .eq('creator_id', source.creator_id)
    .in('cycle_id', involvedCycleIds)
  if (snaps?.some((s) => s.marked_paid_at)) {
    return NextResponse.json(
      { error: 'Creator already paid for one of these cycles; cannot link.' },
      { status: 400 },
    )
  }

  // 5. Find source's current group
  const { data: sourceMember } = await supabaseAdmin
    .from('video_group_members')
    .select('group_id')
    .eq('video_id', sourceVideoId)
    .maybeSingle()
  const sourceGroupId: string | null = sourceMember?.group_id ?? null

  if (sourceGroupId === targetGroupId) {
    return NextResponse.json({ error: 'Video is already in the target group' }, { status: 400 })
  }

  // 6. Check target group for platform conflict
  const targetMembers = await fetchGroupMembers(targetGroupId)
  const conflicting = targetMembers.find((m) => m.platform === source.platform)
  let ejectedGroupId: string | null = null

  // Pre-load arm + tiers (used by all recomputes below)
  const { data: creator } = await supabaseAdmin
    .from('creators')
    .select('arm')
    .eq('id', source.creator_id)
    .single()
  const arm: Arm = (creator?.arm ?? 'Arm A') as Arm
  const { data: tiers } = await supabaseAdmin
    .from('payment_structure')
    .select('*')
    .order('sort_order')

  // 7. Eject conflicting video to its own new singleton group
  if (conflicting) {
    const { data: newGroup, error: insErr } = await supabaseAdmin
      .from('video_groups')
      .insert({
        creator_id: source.creator_id,
        cycle_id: conflicting.cycle_id,
        posted_date: conflicting.posted_date,
        highest_views: conflicting.latest_views,
        cross_posted: false,
        payable: true,
        payout: 0,
      })
      .select('id')
      .single()
    if (insErr || !newGroup) {
      return NextResponse.json(
        { error: `Failed to create ejection group: ${insErr?.message}` },
        { status: 500 },
      )
    }
    ejectedGroupId = newGroup.id
    await supabaseAdmin
      .from('video_group_members')
      .delete()
      .eq('group_id', targetGroupId)
      .eq('video_id', conflicting.video_id)
    await supabaseAdmin
      .from('video_group_members')
      .insert({ group_id: ejectedGroupId, video_id: conflicting.video_id })
  }

  // 8. Remove source from its current group (if any)
  let sourceGroupDeleted = false
  if (sourceGroupId) {
    await supabaseAdmin
      .from('video_group_members')
      .delete()
      .eq('group_id', sourceGroupId)
      .eq('video_id', sourceVideoId)
    const { data: remaining } = await supabaseAdmin
      .from('video_group_members')
      .select('video_id')
      .eq('group_id', sourceGroupId)
    if (!remaining || remaining.length === 0) {
      await supabaseAdmin.from('video_groups').delete().eq('id', sourceGroupId)
      sourceGroupDeleted = true
    }
  }

  // 9. Add source to target group
  await supabaseAdmin
    .from('video_group_members')
    .insert({ group_id: targetGroupId, video_id: sourceVideoId })

  // 9b. Mark target group as manual_link=true so the matcher's
  //     wipe-and-recreate pass on the next sync preserves this association
  //     instead of reverting to its automatic match result.
  //     The source's old group (already deleted if empty) and the ejected
  //     singleton group are LEFT as manual_link=false because they're
  //     automatically-managed; matcher should be free to re-pair the
  //     ejected video if it finds a better match later.
  await supabaseAdmin
    .from('video_groups')
    .update({ manual_link: true })
    .eq('id', targetGroupId)

  // 10. Recompute stats for affected groups
  await recomputeGroupStats(targetGroupId, arm, tiers || [])
  if (!sourceGroupDeleted && sourceGroupId) {
    await recomputeGroupStats(sourceGroupId, arm, tiers || [])
  }
  if (ejectedGroupId) {
    await recomputeGroupStats(ejectedGroupId, arm, tiers || [])
  }

  // 11. Audit log
  recordAudit({
    actor: session,
    action: 'video_group.manual_link',
    target_kind: 'video_group',
    target_id: targetGroupId,
    metadata: {
      source_video_id: sourceVideoId,
      source_platform: source.platform,
      source_group_id: sourceGroupId,
      source_group_deleted: sourceGroupDeleted,
      ejected_video_id: conflicting?.video_id ?? null,
      ejected_group_id: ejectedGroupId,
      creator_id: source.creator_id,
    },
  })

  return NextResponse.json({
    ok: true,
    target_group_id: targetGroupId,
    ejected_video_id: conflicting?.video_id ?? null,
    source_group_deleted: sourceGroupDeleted,
  })
}
