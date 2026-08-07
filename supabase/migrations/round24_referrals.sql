-- Round 24 (2026-06-11): creator referral bonuses.
-- Apply in the Supabase SQL editor BEFORE deploying the Round 24 code, so
-- the API routes and worker promotion step find the table.
--
-- Idempotent: safe to re-run. All names schema-qualified to public.* —
-- some SQL-editor sessions resolve unqualified names against a different
-- search_path and fail with 42P01 even though the tables exist.
--
-- $75 flat bonus to the REFERRER once the REFERRED creator reaches >= 12
-- videos on their top platform (all-time in our DB). See schema.sql §15 for
-- the full lifecycle (pending / awarded / removed) and uniqueness rules.

CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  referred_creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  referred_cycle_id text NOT NULL REFERENCES public.payment_cycles(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awarded','removed')),
  awarded_cycle_id text REFERENCES public.payment_cycles(id),
  amount numeric(10,2) NOT NULL DEFAULT 75,
  created_at timestamptz NOT NULL DEFAULT now(),
  awarded_at timestamptz,
  removed_at timestamptz,
  removed_by text CHECK (removed_by IN ('creator','admin')),
  CHECK (referrer_creator_id <> referred_creator_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_referrals_referred_active
  ON public.referrals(referred_creator_id) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals(referrer_creator_id);
CREATE INDEX IF NOT EXISTS idx_referrals_pending ON public.referrals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_referrals_awarded_cycle ON public.referrals(awarded_cycle_id) WHERE status = 'awarded';
