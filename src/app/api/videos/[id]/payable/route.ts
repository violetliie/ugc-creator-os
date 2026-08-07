import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import { recordAudit } from '@/lib/audit'

/**
 * PATCH /api/videos/{group_id}/payable
 * Body: { payable: boolean }
 *
 * Permission matrix (ROUND 20, 2026-05-22 — supersedes Round 19's one-way ratchet):
 *   - Admin:   can toggle payable either direction on any group.
 *   - Creator: can toggle payable either direction on their OWN group only.
 *              (Up from Round 19 which restricted creators to payable=false.)
 *
 * Flag bookkeeping (the part that matters):
 *   - Creator sets payable=false → set group.creator_unselected=true,
 *     creator_selected=false, AND clear videos.creator_selected for all
 *     members. The matcher's Phase 0a pins creator_unselected groups so the
 *     unselect persists across syncs (Round 19 mechanism).
 *   - Creator sets payable=true  → set group.creator_selected=true,
 *     creator_unselected=false, AND set videos.creator_selected=true for all
 *     members. The matcher's Phase 3 derives the group flag from videos on
 *     each re-creation, so the yellow-highlight UX persists through matcher
 *     restructuring (e.g., a singleton later auto-paired with a cross-post
 *     keeps its yellow because the member video carries the flag).
 *   - Admin sets payable=true on creator_unselected=true group: clear
 *     creator_unselected (admin override; creator may unselect again later).
 *     Don't touch creator_selected — admin is not the creator.
 *   - Admin sets payable=false on creator_selected=true group: clear
 *     creator_selected AND clear videos.creator_selected for all members
 *     (admin authority wins; the yellow highlight goes away, symmetric with
 *     the unselect side).
 *   - Admin toggles on a default group: no flag changes.
 *
 * Recomputes payout immediately.
 * SHELVED ROUND 15 (2026-05-21): cross_posted no longer gates payout
 * (original Round 4 R1 rule was: payout=0 if cross_posted=false).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id: groupId } = await ctx.params
  const { payable } = await req.json()
  if (typeof payable !== 'boolean') {
    return NextResponse.json({ error: 'payable must be boolean' }, { status: 400 })
  }

  // Block edits to groups in fully-paid cycles (frozen)
  const { data: group } = await supabaseAdmin
    .from('video_groups')
    .select('cycle_id, creator_id, highest_views, cross_posted, payout, creator_unselected, creator_selected')
    .eq('id', groupId)
    .single()
  if (!group) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  // ROUND 20: ownership enforcement only — direction restriction removed.
  // Creators can now toggle either direction on their OWN groups; admin
  // can toggle anything. Anything else → 403.
  if (session!.role !== 'Admin') {
    if (session!.role !== 'Creator' || group.creator_id !== session!.creator_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const { data: cycle } = await supabaseAdmin
    .from('payment_cycles')
    .select('marked_paid_at')
    .eq('id', group.cycle_id)
    .single()
  if (cycle?.marked_paid_at) {
    return NextResponse.json({ error: 'Cycle is already paid; cannot edit.' }, { status: 400 })
  }

  const { data: snap } = await supabaseAdmin
    .from('payment_snapshots')
    .select('marked_paid_at')
    .eq('cycle_id', group.cycle_id)
    .eq('creator_id', group.creator_id)
    .maybeSingle()
  if (snap?.marked_paid_at) {
    return NextResponse.json({ error: 'Creator already paid for this cycle; cannot edit.' }, { status: 400 })
  }

  // Fetch arm + tiers to recompute payout
  const { data: creator } = await supabaseAdmin
    .from('creators')
    .select('arm')
    .eq('id', group.creator_id)
    .single()
  const arm = creator?.arm
  if (!arm) return NextResponse.json({ error: 'Creator arm missing' }, { status: 500 })

  const { data: tiers } = await supabaseAdmin
    .from('payment_structure')
    .select('*')
    .eq('arm', arm)
    .order('sort_order')

  const computeTiered = (views: number): number => {
    if (views < 1000 || !tiers) return 0
    const armTiers = tiers.sort((a, b) => a.sort_order - b.sort_order)
    const last = armTiers[armTiers.length - 1]
    const cap = arm === 'Arm A' && last.views_to ? last.views_to : Number.POSITIVE_INFINITY
    const eff = Math.min(views, cap)
    for (const t of armTiers) {
      const lo = t.views_from
      const hi = t.views_to ?? Number.POSITIVE_INFINITY
      if (eff >= lo && eff <= hi) {
        if (t.per_million != null) {
          const extra = Math.floor((eff - t.views_from) / 1_000_000) * t.per_million
          return t.amount + extra
        }
        return t.amount
      }
    }
    return last.amount
  }

  // SHELVED ROUND 15 (2026-05-21): cross_posted no longer gates payout.
  // Original: const finalPayout = (payable && group.cross_posted) ? computeTiered(group.highest_views) : 0
  const finalPayout = payable ? computeTiered(group.highest_views) : 0

  // ROUND 20 flag state machine. `videoCreatorSelected` is what we'll write
  // to every member video's creator_selected (if non-null); undefined =
  // don't touch the video rows. Group-level flags are written via
  // updatePayload below.
  const updatePayload: Record<string, unknown> = {
    payable,
    payout: finalPayout,
    last_updated_at: new Date().toISOString(),
  }
  let videoCreatorSelected: boolean | undefined = undefined

  if (session!.role === 'Creator') {
    if (payable === false) {
      // Creator unselect: set unselected flag (pinned by matcher), drop selected.
      updatePayload.creator_unselected = true
      updatePayload.creator_selected = false
      videoCreatorSelected = false  // clear video-level flag too
    } else {
      // Creator select: set selected flag (UI highlight), drop unselected.
      updatePayload.creator_selected = true
      if (group.creator_unselected) updatePayload.creator_unselected = false
      videoCreatorSelected = true   // propagate to videos so matcher Phase 3 re-derives
    }
  } else {
    // Admin role.
    if (payable === true && group.creator_unselected) {
      // Admin re-enables a creator-unselected group (Round 19 behavior).
      updatePayload.creator_unselected = false
    }
    if (payable === false && group.creator_selected) {
      // Admin overrides creator's selection. Symmetric with Round 19.
      // Clear group flag AND video flags so the highlight doesn't return on
      // next sync (Phase 3 would otherwise rebuild it from member videos).
      updatePayload.creator_selected = false
      videoCreatorSelected = false
    }
  }

  const { data, error: updErr } = await supabaseAdmin
    .from('video_groups')
    .update(updatePayload)
    .eq('id', groupId)
    .select()
    .single()
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  // Propagate the creator_selected flag to every member video so the matcher
  // can re-derive the group-level flag after future restructuring (Phase 3).
  // Only runs when a creator action OR an admin-override-of-creator-selected
  // sets `videoCreatorSelected` above.
  if (videoCreatorSelected !== undefined) {
    const { data: members } = await supabaseAdmin
      .from('video_group_members')
      .select('video_id')
      .eq('group_id', groupId)
    const memberIds = (members ?? []).map((m) => m.video_id)
    if (memberIds.length > 0) {
      await supabaseAdmin
        .from('videos')
        .update({ creator_selected: videoCreatorSelected })
        .in('id', memberIds)
    }
  }

  recordAudit({
    actor: session,
    action: 'video_group.toggle_payable',
    target_kind: 'video_group',
    target_id: groupId,
    metadata: {
      payable,
      cycle_id: group.cycle_id,
      creator_id: group.creator_id,
      payout_before: Number(group.payout),
      payout_after: finalPayout,
      actor_role: session!.role,
      creator_unselected_after: updatePayload.creator_unselected ?? group.creator_unselected,
      creator_selected_after: updatePayload.creator_selected ?? group.creator_selected,
      videos_creator_selected_propagated: videoCreatorSelected,
    },
  })

  return NextResponse.json(data)
}
