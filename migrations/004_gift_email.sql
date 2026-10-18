-- ============================================================================
-- ExSpaceTrash — migration 004
--   Gift delivery: "email it to them for me" (+$4.99)
-- Run in Supabase → SQL Editor AFTER a backup. Safe to run more than once.
--
-- WHY THIS TABLE EXISTS AT ALL
--
--   Every other part of this site writes to `global_registry` and is done. The
--   gift email is the one thing that reaches a person who did NOT ask for it, so
--   it needs a durable record of whether it actually went out. Without this,
--   a buyer pays $4.99, the provider hiccups, and nobody ever finds out — the
--   buyer assumes it was sent, and the recipient assumes nothing happened.
--
--   It also carries the anti-abuse constraint for the whole feature.
-- ============================================================================

CREATE TABLE IF NOT EXISTS gift_emails (
  id                BIGSERIAL PRIMARY KEY,

  -- The purchase this delivery belongs to. UNIQUE, and that is the single most
  -- important line in this file.
  --
  -- Stripe retries webhooks. It retries on a 500, on a timeout, and sometimes
  -- for no obvious reason at all. The webhook sends the email and THEN records
  -- the result, so without a uniqueness constraint a retry that lands between
  -- those two steps would put a SECOND email in a stranger's inbox. A stranger
  -- receiving one unsolicited email is a gag; receiving three is harassment,
  -- and it is the kind that gets a sending domain blacklisted.
  --
  -- The webhook INSERTs this row before sending and treats a 23505 as "already
  -- delivered, stand down". One session id can therefore ever produce one send.
  stripe_session_id TEXT NOT NULL UNIQUE,

  -- Which object was named. Kept for support ("my friend never got the email")
  -- and so a takedown request can find the delivery without touching Stripe.
  norad_id          TEXT,

  -- The RECIPIENT's address — the one the buyer typed. This is the only address
  -- this table ever holds. The buyer's own address is deliberately NOT stored:
  -- Stripe already has it, and copying a customer's email into a second table
  -- buys nothing and is one more thing to leak.
  recipient_email   TEXT NOT NULL,

  -- 'sending' | 'sent' | 'failed'
  --   sending — claimed, provider call in flight
  --   sent    — provider accepted it. TERMINAL: never re-sent.
  --   failed  — recorded for a human. May be retried by a later webhook retry.
  status            TEXT NOT NULL DEFAULT 'sending',

  -- How many times we have attempted this delivery. A number that climbs is the
  -- signal that a transient failure is not actually transient.
  attempts          INTEGER NOT NULL DEFAULT 0,

  -- Provider message id, for delivery disputes.
  provider_id       TEXT,

  -- Why it failed, verbatim from the provider, truncated. The whole point of
  -- storing this is that "the email didn't arrive" is otherwise unanswerable.
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

-- "What still needs attention?" — the only query that matters day to day.
-- Anything not 'sent' is a delivery a human should look at.
CREATE INDEX IF NOT EXISTS gift_emails_status_idx
  ON gift_emails (status, created_at DESC);

-- Support lookups: "did the email to this address go out?"
CREATE INDEX IF NOT EXISTS gift_emails_recipient_idx
  ON gift_emails (recipient_email);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- The anon key ships in the page source, so it is public. Every send happens
-- server-side with the service role key, and nothing here should ever be
-- readable from a browser: a recipient's address is exactly the kind of data
-- that must not be exposed, and this table is a list of them.
--
-- No anon policies at all — RLS denies by default, and these two statements
-- document that the omission is intentional rather than an oversight.
-- ---------------------------------------------------------------------------
ALTER TABLE gift_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no anon read gift_emails" ON gift_emails;
CREATE POLICY "no anon read gift_emails"
  ON gift_emails FOR SELECT
  TO anon
  USING (false);

DROP POLICY IF EXISTS "no anon write gift_emails" ON gift_emails;
CREATE POLICY "no anon write gift_emails"
  ON gift_emails FOR INSERT
  TO anon
  WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- THE ONE QUERY YOU ACTUALLY WANT — deliveries needing attention.
--
--   Run this whenever someone says "the email never arrived". Anything not
--   'sent' is a real, paid-for delivery that did not go out.
-- ---------------------------------------------------------------------------
-- SELECT id, created_at, norad_id, recipient_email, status, attempts, error
--   FROM gift_emails
--  WHERE status <> 'sent'
--  ORDER BY created_at DESC;
--
-- -- Delivery health, last 30 days:
-- SELECT status, count(*) FROM gift_emails
--  WHERE created_at > now() - interval '30 days'
--  GROUP BY 1;
--
-- -- Anti-abuse: is one person using this to send a lot of mail at one target?
-- SELECT recipient_email, count(*) AS sends
--   FROM gift_emails
--  WHERE created_at > now() - interval '30 days'
--  GROUP BY 1 HAVING count(*) > 3 ORDER BY 2 DESC;
