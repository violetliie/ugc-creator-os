import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase'
import type { EffectiveHashtag } from '@/lib/types'

/**
 * GET /api/creators/{id}/effective-hashtags
 * Returns effective hashtags for a creator (union of arm + direct assignments).
 * A creator-role user can only fetch their own.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { session, error, status } = await requireSession()
  if (error) return NextResponse.json({ error }, { status })
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })

  const { id } = await ctx.params

  // Authz: creator role can only read their own
  if (session.role === 'Creator' && session.creator_id !== id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Use the SQL helper function for correctness
  const { data, error: dbErr } = await supabaseAdmin.rpc('effective_hashtags_for_creator', { p_creator_id: id })
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

  const result: EffectiveHashtag[] = (data || []).map((r: { tag: string; starting_on: string }) => ({
    tag: r.tag,
    starting_on: r.starting_on,
  }))
  return NextResponse.json(result)
}
