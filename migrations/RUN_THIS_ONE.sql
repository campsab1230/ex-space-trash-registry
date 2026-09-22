-- ============================================================================
-- ExSpaceTrash — COMBINED MIGRATION  (001 + 002 + 003, one paste)
--
-- HOW TO RUN
--   1. Supabase dashboard -> SQL Editor -> New query
--   2. Paste this whole file
--   3. Click RUN, then scroll the output and check the VERIFY section at the end
--
-- Safe to run twice. Nothing is deleted. Re-running changes nothing.
--
-- WHY
--   Your database is HALF-migrated, which is worse than not migrated at all
--   because it fails silently. Measured against the live project:
--
--     global_registry.certificate_template   EXISTS
--     global_registry.physical_mail          EXISTS
--     global_registry.mail_tier              MISSING   <-- the bug
--     pending_claims.session_id              EXISTS (rename already done)
--     analytics_events                       EXISTS
--     analytics_events.ref                   MISSING   <-- campaign tags
--
--   mail_tier is missing, so PostgREST rejects the webhook's whole insert.
--   The webhook then falls back to writing ONLY the basic columns — so every
--   sale silently loses certificate_template and physical_mail too. That is
--   why a customer picks one certificate design and gets the other.
--
-- WHAT IT TOUCHES
--   Creates: 3 tables-or-none, 7 indexes, 4 columns, 12 RLS policies.
--   Modifies data ONLY to fill NULLs on existing rows:
--     certificate_template NULL -> 'a'; physical_mail NULL -> false;
--     mail_tier NULL -> 'none'. Rows already true+none -> 'domestic' (a
--     deliberately over-cautious guess: flag the order for posting rather
--     than hide a paid physical order).
--   Deletes: nothing. No DROP TABLE / COLUMN / DELETE / TRUNCATE anywhere.
-- ============================================================================


-- ==== PART 1/3 : integrity + row-level security =============================

-- One Stripe session can only ever produce ONE registry row (Stripe retries
-- webhooks; without this a single payment could insert twice).
CREATE UNIQUE INDEX IF NOT EXISTS global_registry_stripe_session_id_key
  ON global_registry (stripe_session_id);

-- One object, one owner. The DB is the final authority, not the app check —
-- two simultaneous buyers must not both win.
CREATE UNIQUE INDEX IF NOT EXISTS global_registry_norad_id_key
  ON global_registry (norad_id);

-- Soft lock: stops two people starting checkout on the same object at once.
CREATE TABLE IF NOT EXISTS pending_claims (
  id BIGSERIAL PRIMARY KEY,
  norad_id TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_claims_norad_id_idx ON pending_claims (norad_id);
CREATE INDEX IF NOT EXISTS pending_claims_created_at_idx ON pending_claims (created_at);

-- The anon key ships in index.html, so it is PUBLIC. RLS is the only thing
-- stopping the world writing to your registry with it.
ALTER TABLE global_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_claims  ENABLE ROW LEVEL SECURITY;

-- Public may READ the registry (this powers the ticker and "already claimed").
DROP POLICY IF EXISTS "public can read registry" ON global_registry;
CREATE POLICY "public can read registry"
  ON global_registry FOR SELECT TO anon, authenticated USING (true);

-- ...and may never write. RLS already denies by default; this states it, so a
-- careless future GRANT cannot quietly reopen it.
DROP POLICY IF EXISTS "no anon writes to registry" ON global_registry;
CREATE POLICY "no anon writes to registry"
  ON global_registry FOR INSERT TO anon WITH CHECK (false);

DROP POLICY IF EXISTS "no anon writes to pending_claims" ON pending_claims;
CREATE POLICY "no anon writes to pending_claims"
  ON pending_claims FOR INSERT TO anon WITH CHECK (false);

DROP POLICY IF EXISTS "no anon read pending_claims" ON pending_claims;
CREATE POLICY "no anon read pending_claims"
  ON pending_claims FOR SELECT TO anon USING (false);


-- ==== PART 2/3 : the column rename, certificate + mailing, analytics ========

-- RENAME. api/create-checkout.js writes `session_id`, but the table was
-- created with `stripe_session_id`, and create-checkout only LOGS a failed
-- lock — so two people could start checkout on the same object and the loser
-- could still be charged. Code is the source of truth, so we make the table
-- match it. Guarded, so it no-ops on your DB (already renamed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pending_claims'
       AND column_name = 'stripe_session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pending_claims'
       AND column_name = 'session_id'
  ) THEN
    ALTER TABLE pending_claims RENAME COLUMN stripe_session_id TO session_id;
    RAISE NOTICE 'pending_claims.stripe_session_id -> session_id (renamed)';
  ELSE
    RAISE NOTICE 'pending_claims already uses session_id - no change needed';
  END IF;
END $$;

-- Which certificate artwork the buyer chose. THIS IS THE BLACK-BOX FIX: with
-- mail_tier missing, PostgREST was rejecting the insert that carried this, so
-- the choice never persisted.
ALTER TABLE global_registry
  ADD COLUMN IF NOT EXISTS certificate_template TEXT NOT NULL DEFAULT 'a';
UPDATE global_registry SET certificate_template = 'a' WHERE certificate_template IS NULL;

-- Flags a paid order that still needs printing and posting, so there is ONE
-- query that lists them instead of clicking through Stripe payments.
ALTER TABLE global_registry
  ADD COLUMN IF NOT EXISTS physical_mail BOOLEAN NOT NULL DEFAULT false;
-- Which postage class: 'none' | 'domestic' | 'international'.
ALTER TABLE global_registry
  ADD COLUMN IF NOT EXISTS mail_tier TEXT NOT NULL DEFAULT 'none';

UPDATE global_registry SET physical_mail = false WHERE physical_mail IS NULL;
UPDATE global_registry SET mail_tier = 'none'  WHERE mail_tier IS NULL;

-- Consistency: cannot need posting with no tier, and cannot have a tier while
-- claiming nothing needs posting.
UPDATE global_registry SET mail_tier = 'domestic'
 WHERE physical_mail = true AND mail_tier = 'none';

-- First-party, cookie-free funnel analytics. No PII, no third parties.
CREATE TABLE IF NOT EXISTS analytics_events (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,
  norad_id   TEXT,
  path       TEXT,
  value      NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_event_created_idx
  ON analytics_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_norad_id_idx
  ON analytics_events (norad_id);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- No anon access at all: writes go through /api/track (service role), reads
-- through the dashboard only.
DROP POLICY IF EXISTS "no anon read analytics" ON analytics_events;
CREATE POLICY "no anon read analytics"
  ON analytics_events FOR SELECT TO anon USING (false);

DROP POLICY IF EXISTS "no anon write analytics" ON analytics_events;
CREATE POLICY "no anon write analytics"
  ON analytics_events FOR INSERT TO anon WITH CHECK (false);


-- ==== PART 3/3 : campaign attribution for outreach links ====================

-- Stores a SHORT token like 'ig:dm' so a DM link can be told apart from
-- organic traffic. Deliberately NOT the raw query string: a session_id can
-- appear in the URL after a Stripe redirect and that is a payment identifier.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS ref TEXT;
CREATE INDEX IF NOT EXISTS analytics_events_ref_created_idx
  ON analytics_events (ref, created_at DESC);


-- ============================================================================
-- VERIFY — check these results before closing the tab
-- ============================================================================

-- Expect 3 rows: certificate_template, mail_tier, physical_mail
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'global_registry'
   AND column_name IN ('certificate_template', 'physical_mail', 'mail_tier')
 ORDER BY column_name;

-- Expect 1 row: ref | text
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'analytics_events'
   AND column_name = 'ref';

-- Expect session_id present, stripe_session_id absent
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'pending_claims'
 ORDER BY ordinal_position;

-- Expect 3 rows, rowsecurity = true for all
SELECT tablename, rowsecurity FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('global_registry', 'pending_claims', 'analytics_events')
 ORDER BY tablename;
