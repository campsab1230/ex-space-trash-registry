-- ============================================================================
-- ExSpaceTrash — migration 002
--   1. Fix the pending_claims column-name mismatch that would break checkout
--   2. Add the first-party analytics table behind /api/track
-- Run in Supabase → SQL Editor AFTER a backup. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. pending_claims column reconciliation
--
--    READ THIS BEFORE RUNNING — it is a real, silent bug.
--
--    api/create-checkout.js writes the lock with:
--        .upsert({ norad_id, session_id, created_at })
--    but migrations/001_hardening.sql declared the column as
--    `stripe_session_id`. Supabase/PostgREST answers an unknown column with an
--    error, and create-checkout only logs that error and continues — so TWO
--    people can start checkout on the SAME object at the same time. The last
--    webhook to land wins; the loser can be charged for an object that is
--    already claimed.
--
--    The code is the source of truth here (renaming the code would mean another
--    deploy, and `session_id` is what the live function already sends), so we
--    make the table match the code. Idempotent: only renames if the old column
--    is present and the new one is not.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'pending_claims'
       AND column_name  = 'stripe_session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'pending_claims'
       AND column_name  = 'session_id'
  ) THEN
    ALTER TABLE pending_claims RENAME COLUMN stripe_session_id TO session_id;
    RAISE NOTICE 'pending_claims.stripe_session_id -> session_id (renamed)';
  ELSE
    RAISE NOTICE 'pending_claims already uses the expected column name — no change';
  END IF;
END $$;

-- The lock is read by norad_id and aged out by created_at; both already have
-- indexes from migration 001. Nothing further needed.


-- ---------------------------------------------------------------------------
-- 1b. Certificate artwork choice
--
--     Customers now pick between two certificate designs. The value also
--     travels in Stripe metadata, so this column is purely for future
--     reporting / re-downloads — the webhook degrades gracefully (and still
--     records the sale) if this column does not exist yet.
--
--     NOTE: `stat` and `custom_quote` already exist on global_registry; only
--     `certificate_template` is new. Existing rows default to 'a', which is
--     the artwork they were originally issued under.
-- ---------------------------------------------------------------------------
ALTER TABLE global_registry
  ADD COLUMN IF NOT EXISTS certificate_template TEXT NOT NULL DEFAULT 'a';

-- Belt and braces: if the column was added by hand without a default, make
-- sure the older rows are not left NULL for the renderer.
UPDATE global_registry SET certificate_template = 'a' WHERE certificate_template IS NULL;


-- ---------------------------------------------------------------------------
-- 1c. Physical / mailed orders
--
--     Flagged so there is ONE query that lists every order still needing to be
--     printed and posted. Without this, physical orders are invisible until
--     someone remembers to check Stripe, and a paying customer waits forever.
--
--     The mailing ADDRESS is intentionally not stored here. Stripe collected it
--     and it lives on the payment in the Stripe dashboard.
--
--     Why the SALE still succeeds if this is missing: api/stripe-webhook.js
--     retries the insert without these optional columns rather than losing a
--     paid customer's claim.
-- ---------------------------------------------------------------------------
ALTER TABLE global_registry
  ADD COLUMN IF NOT EXISTS physical_mail BOOLEAN NOT NULL DEFAULT false;

-- If the column was added by hand without a default, normalise existing rows.
UPDATE global_registry SET physical_mail = false WHERE physical_mail IS NULL;


-- ---------------------------------------------------------------------------
-- 2. First-party analytics
--
--    WHY: the site has made ~$11 and there is no way to see WHERE people fall
--    out. Without that, every future change is a guess. This is deliberately
--    small, anonymous and aggregate — no cookies, no third parties, no PII.
--
--    A HUMAN SHOULD NEVER RUN SELECT * ON THIS. Read it with the query at the
--    bottom of this file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  event       TEXT        NOT NULL,
  norad_id    TEXT,
  path        TEXT,
  value       NUMERIC,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_event_created_idx
  ON analytics_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_norad_id_idx
  ON analytics_events (norad_id);

-- The funnel n.pages we care about all arrive through the same query, so one
-- composite index keeps that cheap even at a few hundred thousand rows.

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- No anon access at all. Every read and write goes through /api/track (write)
-- or the service-role key (read). RLS denies by default; this documents it.
DROP POLICY IF EXISTS "no anon read analytics" ON analytics_events;
CREATE POLICY "no anon read analytics"
  ON analytics_events FOR SELECT
  TO anon
  USING (false);

DROP POLICY IF EXISTS "no anon write analytics" ON analytics_events;
CREATE POLICY "no anon write analytics"
  ON analytics_events FOR INSERT
  TO anon
  WITH CHECK (false);


-- ---------------------------------------------------------------------------
-- 3. THE ONE QUERY YOU ACTUALLY WANT — the funnel, last 30 days.
--
--    Run this in the SQL editor. Read the drop between rows:
--      debris_loaded      -> did the catalog even reach the browser?
--      object_selected    -> did anyone interact with the 3D field?
--      checkout_started   -> did interaction turn into intent?
--      checkout_completed -> did intent turn into money?
--
--    The biggest fall-off is where the next fix should go.
-- ---------------------------------------------------------------------------
-- SELECT
--   count(*) FILTER (WHERE event = 'page_view')          AS page_views,
--   count(*) FILTER (WHERE event = 'debris_loaded')      AS debris_loaded,
--   count(*) FILTER (WHERE event = 'object_selected')    AS object_selected,
--   count(*) FILTER (WHERE event = 'checkout_started')   AS checkout_started,
--   count(*) FILTER (WHERE event = 'checkout_completed') AS checkout_completed
-- FROM analytics_events
-- WHERE created_at > now() - interval '30 days';
--
-- -- Which objects do people actually click? (tells you what to feature)
-- SELECT norad_id, count(*) AS clicks
--   FROM analytics_events
--  WHERE event = 'object_selected'
--    AND created_at > now() - interval '30 days'
--  GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
--
-- -- Where does the catalog fail? (if this is high, the API is flaky)
-- SELECT count(*) FILTER (WHERE event = 'debris_failed') AS failures,
--        count(*) FILTER (WHERE event = 'debris_loaded') AS loads
--   FROM analytics_events
--  WHERE created_at > now() - interval '30 days';
