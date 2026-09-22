-- ============================================================================
-- ExSpaceTrash — migration 003
--   Campaign attribution for outreach links.
--
-- Run in Supabase → SQL Editor. Safe to run more than once (idempotent).
--
-- WHY THIS EXISTS
--   The site is about to be promoted by hand, one DM at a time. Until now the
--   only way to tell whether a DM link worked was to guess: /api/track stored
--   `path` with the query string deliberately stripped, so every UTM tag was
--   thrown away on arrival. "Clicks" — one of the five funnel numbers in
--   FUNNEL.md — was literally unmeasurable.
--
--   This column stores a SHORT, SANITISED campaign token, never the raw query
--   string. That distinction matters: a `session_id` can appear in the URL
--   after a completed purchase, and that is a payment identifier. Copying a
--   whole query string into an analytics table would put it there.
--
--   Nothing here is personal data. A token looks like "ig:dm" or "tiktok".
-- ============================================================================

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS ref TEXT;

-- The one query this column exists for: which channel actually produces
-- clicks, and which of those channels produce money.
CREATE INDEX IF NOT EXISTS analytics_events_ref_created_idx
  ON analytics_events (ref, created_at DESC);

-- ---------------------------------------------------------------------------
-- VERIFY the column landed (expect one row: ref | text)
-- ---------------------------------------------------------------------------
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_name = 'analytics_events'
--  ORDER BY ordinal_position;

-- ---------------------------------------------------------------------------
-- THE REPORT — where do your clicks actually come from?
--
-- Run this after you have sent some tagged DMs. Empty `ref` = direct/organic
-- traffic (someone typed the URL, or arrived from a link with no tag).
-- ---------------------------------------------------------------------------
-- SELECT
--   COALESCE(ref, '(no tag)')                                        AS channel,
--   count(*) FILTER (WHERE event = 'page_view')                      AS views,
--   count(*) FILTER (WHERE event = 'hero_cta_clicked')               AS cta_clicks,
--   count(*) FILTER (WHERE event = 'checkout_started')               AS checkouts,
--   count(*) FILTER (WHERE event = 'checkout_completed')             AS purchases
-- FROM analytics_events
-- WHERE created_at > now() - interval '30 days'
-- GROUP BY 1
-- ORDER BY views DESC;
