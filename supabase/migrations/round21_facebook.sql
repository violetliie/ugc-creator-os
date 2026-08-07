-- Round 21 (2026-06-07): add Facebook Reels as a 4th tracked platform.
-- Apply in the Supabase SQL editor BEFORE deploying the worker, so that
-- (a) inserting platform='facebook' videos doesn't violate the CHECK, and
-- (b) the shortimize_accounts cache can hold facebook rows.
--
-- Idempotent: safe to re-run.

-- 1. New optional creator handle for Facebook (mirrors the other *_handle cols).
ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS facebook_handle text;

-- 2. videos.platform CHECK must allow 'facebook'. A CHECK can't be altered in
--    place, so drop + recreate. The inline constraint Postgres auto-named is
--    videos_platform_check; DROP IF EXISTS keeps this safe if it was renamed.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_platform_check;
ALTER TABLE videos
  ADD CONSTRAINT videos_platform_check
  CHECK (platform IN ('tiktok','instagram','youtube','facebook'));

-- 3. shortimize_accounts.platform CHECK must allow 'facebook' (the handle-
--    validation cache stores fb accounts so the Add-Creator form can verify
--    a facebook_handle exists on Shortimize).
ALTER TABLE shortimize_accounts DROP CONSTRAINT IF EXISTS shortimize_accounts_platform_check;
ALTER TABLE shortimize_accounts
  ADD CONSTRAINT shortimize_accounts_platform_check
  CHECK (platform IN ('tiktok','instagram','youtube','facebook'));
