-- ============================================================================
-- ExSpaceTrash — security hardening migration
-- Run in Supabase → SQL Editor AFTER you have a backup.
-- Safe to run more than once (idempotent where PostgreSQL allows).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Idempotency: a Stripe session may only ever produce ONE registry row.
--    Stripe retries webhooks; without this, one payment could insert twice.
--    NOTE: this will fail if duplicate session ids already exist. Check first:
--      SELECT stripe_session_id, count(*) FROM global_registry
--      GROUP BY 1 HAVING count(*) > 1;
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS global_registry_stripe_session_id_key
  ON global_registry (stripe_session_id);

-- ---------------------------------------------------------------------------
-- 2. One live claim per object. The app checks this, but the database should
--    be the final authority — two concurrent buyers must not both win.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS global_registry_norad_id_key
  ON global_registry (norad_id);

-- ---------------------------------------------------------------------------
-- 3. Soft-lock table so two people can't start checkout on the same object.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_claims (
  id BIGSERIAL PRIMARY KEY,
  norad_id TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_claims_norad_id_idx ON pending_claims (norad_id);
CREATE INDEX IF NOT EXISTS pending_claims_created_at_idx ON pending_claims (created_at);

-- ---------------------------------------------------------------------------
-- 4. Row Level Security.
--    The anon key ships in index.html, so it is PUBLIC. RLS is what stops the
--    whole world from reading/writing your tables with it.
-- ---------------------------------------------------------------------------
ALTER TABLE global_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_claims  ENABLE ROW LEVEL SECURITY;

-- Public read of the registry ONLY. This powers the ticker and the
-- "already claimed" state. Never grant anon write.
DROP POLICY IF EXISTS "public can read registry" ON global_registry;
CREATE POLICY "public can read registry"
  ON global_registry FOR SELECT
  TO anon, authenticated
  USING (true);

-- Explicitly deny anon writes (defence in depth — RLS denies by default, this
-- documents the intent and survives a careless future grant).
DROP POLICY IF EXISTS "no anon writes to registry" ON global_registry;
CREATE POLICY "no anon writes to registry"
  ON global_registry FOR INSERT
  TO anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "no anon writes to pending_claims" ON pending_claims;
CREATE POLICY "no anon writes to pending_claims"
  ON pending_claims FOR INSERT
  TO anon
  WITH CHECK (false);

-- pending_claims is internal: no anon access at all.
DROP POLICY IF EXISTS "no anon read pending_claims" ON pending_claims;
CREATE POLICY "no anon read pending_claims"
  ON pending_claims FOR SELECT
  TO anon
  USING (false);

-- ---------------------------------------------------------------------------
-- 5. Moderation helper (your legal page promises removal on request).
--    Run manually when someone asks to be taken down:
--      UPDATE global_registry
--         SET dedication_name = 'REMOVED', custom_message = NULL
--       WHERE norad_id = '35786';
-- ---------------------------------------------------------------------------
