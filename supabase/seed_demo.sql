-- ============================================================
-- UGC CreatorOS: OPTIONAL demo data (all fictional)
-- Run AFTER schema.sql. Gives the dashboard a populated look without
-- any tracking vendor connected: fake videos, cross-post groups, and a
-- referral for the demo creators seeded by schema.sql.
--
-- Everything lands in the CURRENT pay period at the time you run it,
-- so the dashboard shows live-looking rows on first login.
-- Safe to re-run (fixed UUIDs + ON CONFLICT DO NOTHING).
-- Demo groups are marked manual_link=true so the matcher preserves them.
-- ============================================================

DO $$
DECLARE
  y int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/New_York'))::int;
  m int := EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/New_York'))::int;
  d int := EXTRACT(DAY FROM (now() AT TIME ZONE 'America/New_York'))::int;
  h int;
  cyc text;
  d1 date; d2 date; d3 date;
BEGIN
  -- Make sure cycles exist through the end of the current year.
  PERFORM generate_payment_cycles(2026, 4, 2, y, 12, 2);

  h := CASE WHEN d <= 15 THEN 1 ELSE 2 END;
  cyc := y::text || '-' || m::text || '-' || h::text;
  d1 := (now() AT TIME ZONE 'America/New_York')::date - 1;
  d2 := (now() AT TIME ZONE 'America/New_York')::date - 2;
  d3 := (now() AT TIME ZONE 'America/New_York')::date - 3;
  -- Keep demo dates inside the current half-month window.
  IF h = 2 AND EXTRACT(DAY FROM d3)::int < 16 THEN d3 := d1; d2 := d1; END IF;
  IF h = 1 AND EXTRACT(DAY FROM d3)::int > 15 THEN d3 := d1; d2 := d1; END IF;

  -- ---- videos (fictional links; phash left NULL) ----
  INSERT INTO videos (id, creator_id, platform, ad_link, title, posted_date, created_at_remote, video_length, latest_views, cycle_id) VALUES
    ('d1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'tiktok',    'https://www.tiktok.com/@alexcarter.clips/video/7000000000000000001', 'this trend but make it finance', d1, now(), 14, 82400, cyc),
    ('d1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'instagram', 'https://www.instagram.com/reel/DEMO0000001',                          'this trend but make it finance', d1, now(), 14, 30100, cyc),
    ('d1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'youtube',   'https://www.youtube.com/shorts/DEMO0000001',                          'this trend but make it finance', d1, now(), 14, 12800, cyc),
    ('d1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000002', 'tiktok',    'https://www.tiktok.com/@jamiepark.daily/video/7000000000000000002',   'day 12 of posting until it works', d2, now(), 21, 51200, cyc),
    ('d1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000002', 'instagram', 'https://www.instagram.com/reel/DEMO0000002',                          'day 12 of posting until it works', d2, now(), 21, 6300, cyc),
    ('d1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000003', 'instagram', 'https://www.instagram.com/reel/DEMO0000003',                          'POV: your first viral clip', d3, now(), 9, 9200, cyc),
    ('d1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000003', 'tiktok',    'https://www.tiktok.com/@rileyreels/video/7000000000000000003',        'POV: your first viral clip', d3, now(), 9, 7500, cyc),
    ('d1000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000004', 'tiktok',    'https://www.tiktok.com/@samrivera.clips/video/7000000000000000004',   'rating this week''s top plays', d2, now(), 17, 14600, cyc)
  ON CONFLICT (platform, ad_link) DO NOTHING;

  -- ---- cross-post groups (manual_link=true so the matcher keeps them) ----
  INSERT INTO video_groups (id, creator_id, cycle_id, posted_date, highest_views, cross_posted, payout, payable, manual_link) VALUES
    ('e1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', cyc, d1, 82400, true,  60, true, true),
    ('e1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', cyc, d2, 51200, true,  60, true, true),
    ('e1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', cyc, d3, 9200,  true,  10,  true, true),
    ('e1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', cyc, d2, 14600, false, 25,  true, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO video_group_members (group_id, video_id) VALUES
    ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001'),
    ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002'),
    ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003'),
    ('e1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000004'),
    ('e1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000005'),
    ('e1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000006'),
    ('e1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000007'),
    ('e1000000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000008')
  ON CONFLICT DO NOTHING;

  -- ---- one awarded referral (Alex referred Riley) ----
  INSERT INTO referrals (id, referrer_creator_id, referred_creator_id, referred_cycle_id, status, awarded_cycle_id, amount, awarded_at)
  VALUES ('f1000000-0000-0000-0000-000000000001',
          'c1000000-0000-0000-0000-000000000001',
          'c1000000-0000-0000-0000-000000000003',
          cyc, 'awarded', cyc, 75, now())
  ON CONFLICT (id) DO NOTHING;
END $$;
