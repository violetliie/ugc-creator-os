-- ============================================================
-- UGC CreatorOS — Supabase Schema
-- Source of truth: ../design notes  (sections 9, 16, 17, 19)
--
-- Apply via Supabase SQL Editor (one shot) or psql:
--   psql "$DATABASE_URL" -f supabase/schema.sql
--
-- This script is IDEMPOTENT: re-running drops nothing important;
-- IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
-- ============================================================

-- Required extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. CREATORS
-- ============================================================
CREATE TABLE IF NOT EXISTS creators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  arm text NOT NULL CHECK (arm IN ('Arm A','Arm B')),
  paypal_email text NOT NULL,
  tiktok_handle text,            -- normalized: lowercase, no leading @
  instagram_handle text,
  youtube_handle text,
  facebook_handle text,          -- Round 21: Facebook Reels (Shortimize username slug or numeric id); optional, not mandatory
  deleted_at timestamptz,        -- soft delete (Round 3 Q6, Round 4 F4)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creators_deleted_at ON creators(deleted_at);
CREATE INDEX IF NOT EXISTS idx_creators_arm ON creators(arm);

-- ============================================================
-- 2. USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,           -- bcrypt cost 12 (Round 3 B5)
  role text NOT NULL CHECK (role IN ('Admin','Creator')),
  creator_id uuid REFERENCES creators(id) ON DELETE SET NULL,
  name text,                              -- display name (Round 3 Q9)
  deleted_at timestamptz,                 -- soft delete (Round 3 Q6)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_creator_id ON users(creator_id);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- ============================================================
-- 3. PAYMENT CYCLES
-- ET-zoned timestamptz boundaries; precise hard cutoffs (Round 3 Q13, §16.I).
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_cycles (
  id text PRIMARY KEY,                              -- e.g. '2026-4-2'
  period_start timestamptz NOT NULL,                -- inclusive, ET-zoned
  period_end timestamptz NOT NULL,                  -- exclusive, ET-zoned
  payment_due_at timestamptz NOT NULL,              -- 6 PM ET on the snapshot day
  snapshot_generated_at timestamptz,                -- null = not yet locked
  marked_paid_at timestamptz                        -- null = not yet paid
);

CREATE INDEX IF NOT EXISTS idx_cycles_period ON payment_cycles(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_cycles_marked_paid ON payment_cycles(marked_paid_at);

-- ============================================================
-- 4. PAYMENT STRUCTURE (tiers)
-- Editable from UI per Round 3 Q4.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_structure (
  id serial PRIMARY KEY,
  arm text NOT NULL CHECK (arm IN ('Arm A','Arm B')),
  views_from integer NOT NULL,
  views_to integer,                       -- null = open-ended last tier
  amount integer NOT NULL,
  per_million integer,                    -- null except Arm A 6M+ tier
  sort_order integer NOT NULL,
  UNIQUE (arm, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_structure_arm_order ON payment_structure(arm, sort_order);

-- ============================================================
-- 5. SHORTIMIZE ACCOUNTS CACHE
-- Daily refresh from GET /accounts (Round 3 Q14).
-- ============================================================
CREATE TABLE IF NOT EXISTS shortimize_accounts (
  account_id text PRIMARY KEY,
  username text NOT NULL,                 -- normalized lowercase, no leading @
  platform text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube','facebook')),
  checked_at timestamptz,                 -- Shortimize's last refresh of this account
  removed boolean NOT NULL DEFAULT false,
  private boolean NOT NULL DEFAULT false,
  last_uploaded_at date,
  our_last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (username, platform)
);

CREATE INDEX IF NOT EXISTS idx_shortimize_accounts_lookup
  ON shortimize_accounts(platform, username);

-- ============================================================
-- 6. VIDEOS
-- One row per platform-video. Cycle assigned via created_at_remote in ET.
-- ============================================================
CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube','facebook')),
  ad_link text NOT NULL,                  -- primary dedup key
  ad_id text,                             -- shortimize fallback dedup
  shortimize_account_id text REFERENCES shortimize_accounts(account_id),
  title text,
  posted_date date NOT NULL,              -- from uploaded_at (display)
  created_at_remote timestamptz NOT NULL, -- full ISO+TZ from Shortimize, used for cycle assignment
  video_length integer,                   -- seconds
  latest_views integer NOT NULL DEFAULT 0,
  views_frozen boolean NOT NULL DEFAULT false,
  phash text,                             -- 64-bit perceptual hash
  private boolean NOT NULL DEFAULT false,
  removed boolean NOT NULL DEFAULT false,
  cycle_id text REFERENCES payment_cycles(id),
  first_fetched_at timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  shortimize_updated_at timestamptz,
  creator_selected boolean NOT NULL DEFAULT false, -- Round 20: persists creator's affirm-payout intent across matcher restructure; group-level flag is DERIVED from members via OR-aggregation
  UNIQUE (platform, ad_link)
);

CREATE INDEX IF NOT EXISTS idx_videos_creator ON videos(creator_id);
CREATE INDEX IF NOT EXISTS idx_videos_cycle ON videos(cycle_id);
CREATE INDEX IF NOT EXISTS idx_videos_posted ON videos(posted_date);
CREATE INDEX IF NOT EXISTS idx_videos_frozen ON videos(views_frozen);
CREATE INDEX IF NOT EXISTS idx_videos_creator_cycle ON videos(creator_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_videos_creator_selected ON videos(creator_selected) WHERE creator_selected = true;

-- ============================================================
-- 7. VIDEO GROUPS  (cross-platform identity for payout)
-- cross_posted = has TT AND has IG (Round 4 R1).
-- ============================================================
CREATE TABLE IF NOT EXISTS video_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  cycle_id text NOT NULL REFERENCES payment_cycles(id),
  posted_date date NOT NULL,              -- earliest member's posted_date
  highest_views integer NOT NULL DEFAULT 0,
  cross_posted boolean NOT NULL DEFAULT false,
  payout numeric(10,2) NOT NULL DEFAULT 0,
  payable boolean NOT NULL DEFAULT true,  -- admin override (no effect if cross_posted=false)
  manual_link boolean NOT NULL DEFAULT false, -- Round 11: admin Link Post override; matcher preserves these
  creator_unselected boolean NOT NULL DEFAULT false, -- Round 19: creator opted out of this group's payout; matcher preserves these (pinned)
  creator_selected boolean NOT NULL DEFAULT false, -- Round 20: creator explicitly affirmed payout; UI yellow highlight; matcher DERIVES from member videos (not pinned)
  matched_at timestamptz NOT NULL DEFAULT now(),
  last_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_groups_creator ON video_groups(creator_id);
CREATE INDEX IF NOT EXISTS idx_groups_cycle ON video_groups(cycle_id);
CREATE INDEX IF NOT EXISTS idx_groups_creator_cycle ON video_groups(creator_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_groups_manual_link ON video_groups(manual_link) WHERE manual_link = true;
CREATE INDEX IF NOT EXISTS idx_groups_creator_unselected ON video_groups(creator_unselected) WHERE creator_unselected = true;
CREATE INDEX IF NOT EXISTS idx_groups_creator_selected ON video_groups(creator_selected) WHERE creator_selected = true;

CREATE TABLE IF NOT EXISTS video_group_members (
  group_id uuid NOT NULL REFERENCES video_groups(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, video_id),
  UNIQUE (video_id)                       -- a video can be in at most one group
);

-- ============================================================
-- 8. PAYMENT SNAPSHOTS  (frozen amounts at lock time)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id text NOT NULL REFERENCES payment_cycles(id),
  creator_id uuid NOT NULL REFERENCES creators(id),
  amount numeric(10,2) NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  marked_paid_at timestamptz,             -- per-creator paid (Round 3 C5/C6)
  UNIQUE (cycle_id, creator_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_cycle ON payment_snapshots(cycle_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_creator ON payment_snapshots(creator_id);

-- ============================================================
-- 9. SECRETS  (admin-editable, write-only over HTTP, Round 4 R4)
-- ============================================================
CREATE TABLE IF NOT EXISTS secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- 10. SYNC RUNS  (audit trail for cron + manual sync, Round 3 Q10)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','success','error')),
  kind text NOT NULL CHECK (kind IN ('cron','manual','snapshot')),
  creators_processed integer NOT NULL DEFAULT 0,
  videos_fetched integer NOT NULL DEFAULT 0,
  videos_matched integer NOT NULL DEFAULT 0,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status);

-- ============================================================
-- 10a. CREATOR RUNS  (Round 9: per-creator sync status)
-- One row per creator per sync_run. Allows: (1) per-creator failure
-- isolation (one creator's exception doesn't kill the whole sync),
-- (2) automatic retry of failed creators on the NEXT sync,
-- (3) memory-safe sequential processing as we add more creators.
-- ============================================================
CREATE TABLE IF NOT EXISTS creator_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  started_at timestamptz,
  completed_at timestamptz,
  videos_fetched integer NOT NULL DEFAULT 0,
  groups_created integer NOT NULL DEFAULT 0,
  groups_updated integer NOT NULL DEFAULT 0,
  error_message text,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creator_runs_sync ON creator_runs(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_creator_runs_creator ON creator_runs(creator_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_runs_status ON creator_runs(status, started_at DESC);

-- ============================================================
-- 10b. AUDIT LOG  (Round 5: who did what + when)
-- Captures every meaningful admin action so we can later answer
-- "who marked X paid?" "who unchecked this video?" "who changed the tiers?"
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,                                     -- denormalized at write time so deleted users still resolve
  actor_name text,
  action text NOT NULL,                                 -- e.g. 'cycle.mark_paid', 'video.toggle_payable'
  target_kind text NOT NULL,                            -- 'cycle','creator','video_group','user','hashtag','tier','secret'
  target_id text,                                       -- text so it covers uuid + cycle id strings
  metadata jsonb                                        -- before/after, amount, etc.
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- ============================================================
-- 11. HASHTAGS  (Round 5: track brand-tagged videos vs organic content)
-- A creator's effective hashtag set = (hashtags assigned to creator's arm)
-- UNION (hashtags assigned to creator directly). A hashtag only applies to
-- videos posted ON OR AFTER its `starting_on` (per the design notes G4).
-- ============================================================
CREATE TABLE IF NOT EXISTS hashtags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag text NOT NULL UNIQUE,                       -- normalized: lowercase, no leading #, alphanumeric + underscore
  starting_on timestamptz NOT NULL DEFAULT now(), -- filter applies to videos posted >= this
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_hashtags_starting_on ON hashtags(starting_on);

CREATE TABLE IF NOT EXISTS hashtag_arm_assignments (
  hashtag_id uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  arm text NOT NULL CHECK (arm IN ('Arm A','Arm B')),
  PRIMARY KEY (hashtag_id, arm)
);
CREATE INDEX IF NOT EXISTS idx_hashtag_arm_arm ON hashtag_arm_assignments(arm);

CREATE TABLE IF NOT EXISTS hashtag_creator_assignments (
  hashtag_id uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  PRIMARY KEY (hashtag_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_hashtag_creator_creator ON hashtag_creator_assignments(creator_id);

-- Convenience function: effective hashtags for a creator (used by worker + APIs).
-- Returns rows of (tag, starting_on); filtered by creator's current arm + direct assignments.
CREATE OR REPLACE FUNCTION effective_hashtags_for_creator(p_creator_id uuid)
RETURNS TABLE (tag text, starting_on timestamptz) AS $$
DECLARE
  c_arm text;
BEGIN
  SELECT arm INTO c_arm FROM creators WHERE id = p_creator_id AND deleted_at IS NULL;
  IF c_arm IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT h.tag, h.starting_on
  FROM hashtags h
  WHERE h.id IN (
    SELECT hashtag_id FROM hashtag_creator_assignments WHERE creator_id = p_creator_id
    UNION
    SELECT hashtag_id FROM hashtag_arm_assignments WHERE arm = c_arm
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- 12. PAYMENT CYCLE GENERATOR
-- ET-zoned hard timestamp boundaries. Cycle A = days 1 to 15;
-- Cycle B = days 16 to EOM. Pay 6 PM ET on EOM (A) or 15th of next month (B).
-- ============================================================
CREATE OR REPLACE FUNCTION generate_payment_cycles(
  p_start_year int,
  p_start_month int,
  p_start_half int,                       -- 1 or 2
  p_end_year int,
  p_end_month int,
  p_end_half int
) RETURNS integer AS $$
DECLARE
  y int := p_start_year;
  m int := p_start_month;
  h int := p_start_half;
  start_ts timestamptz;
  end_ts timestamptz;
  due_ts timestamptz;
  next_y int;
  next_m int;
  cycle_id text;
  inserted_count int := 0;
BEGIN
  WHILE (y < p_end_year)
        OR (y = p_end_year AND m < p_end_month)
        OR (y = p_end_year AND m = p_end_month AND h <= p_end_half) LOOP

    cycle_id := y::text || '-' || m::text || '-' || h::text;

    -- Compute next month/year
    IF m = 12 THEN
      next_y := y + 1; next_m := 1;
    ELSE
      next_y := y; next_m := m + 1;
    END IF;

    IF h = 1 THEN
      -- Cycle A: [day 1 00:00 ET, day 16 00:00 ET)
      start_ts := (y::text || '-' || lpad(m::text,2,'0') || '-01 00:00:00')::timestamp
                  AT TIME ZONE 'America/New_York';
      end_ts   := (y::text || '-' || lpad(m::text,2,'0') || '-16 00:00:00')::timestamp
                  AT TIME ZONE 'America/New_York';
      -- Pay at 6 PM ET on EOM = (1st of next month - 1 day) at 18:00 ET
      due_ts := ((next_y::text || '-' || lpad(next_m::text,2,'0') || '-01')::date
                 - INTERVAL '1 day' + INTERVAL '18 hours')::timestamp
                AT TIME ZONE 'America/New_York';
    ELSE
      -- Cycle B: [day 16 00:00 ET, 1st of next month 00:00 ET)
      start_ts := (y::text || '-' || lpad(m::text,2,'0') || '-16 00:00:00')::timestamp
                  AT TIME ZONE 'America/New_York';
      end_ts   := (next_y::text || '-' || lpad(next_m::text,2,'0') || '-01 00:00:00')::timestamp
                  AT TIME ZONE 'America/New_York';
      -- Pay at 6 PM ET on the 15th of next month
      due_ts := (next_y::text || '-' || lpad(next_m::text,2,'0') || '-15 18:00:00')::timestamp
                AT TIME ZONE 'America/New_York';
    END IF;

    INSERT INTO payment_cycles (id, period_start, period_end, payment_due_at)
    VALUES (cycle_id, start_ts, end_ts, due_ts)
    ON CONFLICT (id) DO NOTHING;

    IF FOUND THEN inserted_count := inserted_count + 1; END IF;

    -- Advance to next cycle
    IF h = 1 THEN
      h := 2;
    ELSE
      h := 1;
      m := next_m;
      y := next_y;
    END IF;
  END LOOP;
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 12. SEED — payment cycles from 2026-4-2 (Apr 16 to 30, 2026) through Dec 2026
-- First cycle is Apr 16-30 per Round 3 Q13 / Round 4 F9.
-- ============================================================
SELECT generate_payment_cycles(2026, 4, 2, 2026, 12, 2);

-- ============================================================
-- 13. SEED — payment structure tiers
-- Source: the design notes
-- ============================================================
-- Arm A
INSERT INTO payment_structure (arm, views_from, views_to, amount, per_million, sort_order) VALUES
  ('Arm A', 1000,    9999,    10,   NULL, 1),
  ('Arm A', 10000,   49999,   30,   NULL, 2),
  ('Arm A', 50000,   99999,   60,   NULL, 3),
  ('Arm A', 100000,  249999,  120,  NULL, 4),
  ('Arm A', 250000,  499999,  250,  NULL, 5),
  ('Arm A', 500000,  999999,  400,  NULL, 6),
  ('Arm A', 1000000, 1999999, 600,  NULL, 7),
  ('Arm A', 2000000, 2999999, 800,  NULL, 8),
  ('Arm A', 3000000, 3999999, 1000, NULL, 9),
  ('Arm A', 4000000, 4999999, 1250, NULL, 10),
  ('Arm A', 5000000, 5999999, 1600, NULL, 11),
  ('Arm A', 6000000, 10000000, 1600, 200, 12)   -- caps at 10M = $2,400
ON CONFLICT (arm, sort_order) DO NOTHING;

-- Arm B
INSERT INTO payment_structure (arm, views_from, views_to, amount, per_million, sort_order) VALUES
  ('Arm B', 1000,    9999,   10,   NULL, 1),
  ('Arm B', 10000,   49999,  25,   NULL, 2),
  ('Arm B', 50000,   99999,  50,   NULL, 3),
  ('Arm B', 100000,  249999, 100,  NULL, 4),
  ('Arm B', 250000,  499999, 200,  NULL, 5),
  ('Arm B', 500000,  999999, 350,  NULL, 6),
  ('Arm B', 1000000, 4999999, 500, NULL, 7),
  ('Arm B', 5000000, NULL,   1200, NULL, 8)   -- 5M+ flat
ON CONFLICT (arm, sort_order) DO NOTHING;

-- ============================================================
-- 14. SEED — demo creators (FICTIONAL — replace with your own roster)
-- ============================================================
INSERT INTO creators (id, name, arm, paypal_email, tiktok_handle, instagram_handle, youtube_handle) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'Alex Carter',  'Arm A',   'alex@example.com',   'alexcarter.clips',  'alexcarter.clips',  'alexcarterclips'),
  ('c1000000-0000-0000-0000-000000000002', 'Jamie Park',   'Arm A',   'jamie@example.com',  'jamiepark.daily',   'jamiepark.daily',   'jamieparkdaily'),
  ('c1000000-0000-0000-0000-000000000003', 'Riley Chen',   'Arm A',   'riley@example.com',  'rileyreels',        'rileyreels',        'rileyreels'),
  ('c1000000-0000-0000-0000-000000000004', 'Sam Rivera',   'Arm B', 'sam@example.com',    'samrivera.clips',   'samrivera.clips',   'samriveraclips'),
  ('c1000000-0000-0000-0000-000000000005', 'Morgan Lee',   'Arm B', 'morgan@example.com', 'morganlee.posts',   'morganlee.posts',   'morganleeposts')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 15. REFERRALS (Round 24, 2026-06-11)
-- A creator claims they referred another creator during a pay period.
-- $75 flat bonus per referral, paid to the REFERRER once the REFERRED
-- creator has >= 12 videos on their top platform (all-time, in our DB).
--
-- Lifecycle:
--   pending  -> claimed but referred creator not yet at 12 videos on their
--               top platform. Re-checked every pipeline run; stays visible
--               in the UI every cycle until resolved.
--   awarded  -> eligibility met. awarded_cycle_id = the cycle the $75
--               lands in (instant-eligible: the cycle the referral was
--               entered under; late-qualifying: the calendar cycle at the
--               moment of qualification). Counts toward the referrer's
--               cycle total + payment snapshot.
--   removed  -> creator or admin clicked the x (or the referred creator was
--               soft-deleted -> auto-removed by the worker, removed_by NULL).
--               Never pays; admin view still lists it (yellow); frees the
--               referred person to be claimed again (partial unique below).
--
-- One referral per referred person EVER while not removed (first claim
-- wins, fraud-resistant). Self-referrals blocked by CHECK.
-- ============================================================
CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  referred_creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  referred_cycle_id text NOT NULL REFERENCES payment_cycles(id),  -- "period referred at" (the displayed cycle at entry)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awarded','removed')),
  awarded_cycle_id text REFERENCES payment_cycles(id),            -- cycle the $75 lands in (null while pending)
  amount numeric(10,2) NOT NULL DEFAULT 75,
  created_at timestamptz NOT NULL DEFAULT now(),
  awarded_at timestamptz,
  removed_at timestamptz,
  removed_by text CHECK (removed_by IN ('creator','admin')),      -- NULL = system (referred creator deleted)
  CHECK (referrer_creator_id <> referred_creator_id)
);

-- A person can only be actively claimed once; removing frees them up.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_referrals_referred_active
  ON referrals(referred_creator_id) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_creator_id);
CREATE INDEX IF NOT EXISTS idx_referrals_pending ON referrals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_referrals_awarded_cycle ON referrals(awarded_cycle_id) WHERE status = 'awarded';

-- ============================================================
-- 16. NOTES
--
-- Users (admins + creator logins) are seeded by the Python worker's
-- seed_users.py script, which bcrypt-hashes passwords. NEVER store
-- plaintext passwords in this file.
--
-- Round 8 (2026-05-08): the 'instagram_cookies_txt' row in `secrets` is
-- no longer used by the worker. IG phash extraction now goes through
-- public og:image scraping with the facebookexternalhit UA (no cookies,
-- no account login). The row is removed during the Round 8 data
-- migration; see design notes Section 24.K. The `secrets` table itself is
-- kept for future write-only secrets.
--
-- Row Level Security (RLS):
-- We use the SUPABASE_SERVICE_ROLE_KEY exclusively from server-side
-- (Next.js API routes + Python worker), and do NOT expose anon-key
-- table access to the client. Therefore RLS is left disabled here
-- and access control is enforced at the API layer (getSession +
-- role/creator_id checks). If we ever expose direct anon access,
-- enable RLS with strict policies.
-- ============================================================
