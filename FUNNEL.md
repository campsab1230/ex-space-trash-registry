# Outreach Funnel — tally sheet

Fill this in as you DM. Five numbers, one row per day (or per batch of DMs).
The point is **not** the totals — it is that each drop-off points at exactly one
thing to fix. Do not change the site because of a feeling; change it because a
row below says so.

---

## The tally

| Date | Accounts contacted | Replies | Site clicks | Started checkout | Purchased |
| --- | --- | --- | --- | --- | --- |
| 2026-09-22 | | | | | |
|  | | | | | |
|  | | | | | |

- **Accounts contacted** — DMs actually sent. Not "planned".
- **Replies** — any reply. "lol no" counts.
- **Site clicks** — they opened the link. Shortened links / UTM tags make this
  measurable; without them you are guessing.
- **Started checkout** — `checkout_started` in `analytics_events` (or count
  Stripe Checkout sessions opened).
- **Purchased** — `checkout_completed` / paid sessions.

Query the site's own numbers (Supabase → SQL Editor):

```sql
-- Funnel counts, last 30 days
SELECT event, count(*)
  FROM analytics_events
 WHERE created_at > now() - interval '30 days'
 GROUP BY event
 ORDER BY count(*) DESC;
```

```sql
-- The real money: one row per completed purchase
SELECT created_at, norad_id, dedication_name
  FROM global_registry
 ORDER BY created_at DESC;
```

---

## Where it broke → what to fix

Read the **first** place a number collapses to near-zero. That is the only thing
worth working on that day.

| Symptom | Diagnosis | Fix |
| --- | --- | --- |
| **No replies** | Outreach problem — the DM itself isn't earning a response. | Change the DM, not the website. Short, specific, funny. No paragraph. |
| **Replies, but no clicks** | Pitch problem — the reply is happening but the link isn't tempting enough to tap. | Make the one-line pitch carry the joke *and* the payoff. The DM should end on the link, not on a question. |
| **Clicks, but no checkout** | Landing page / understanding — they arrived and didn't see the point or the price. | This is what the cold-traffic hero fixes: hook → what it is → certificate → price, no hunting. If it's still stalling, watch one person use it. |
| **Checkout started, but no purchase** | Price / trust / payment friction. | Check the Stripe receipt matches the advertised total, and that the page doesn't look broken on a phone. Look at Stripe → Payments → incomplete sessions for the abandonment reason. |
| **Purchases, but nobody shares** | Product / shareability — the thing isn't fun enough to show off. | Makes the certificate itself more shareable (the share link and OG card already exist). This is the *good* problem to have. |

---

## The one rule

**Don't change more than one thing at a time.** Right now the site is live and
already has a working checkout. The measurements only mean something if the page
stays still while you test the outreach.

---

## What good looks like at this stage

You are looking for **any** non-zero row past "replies". One click is data.
One completed checkout from a stranger — not yourself, not your mum — is the
signal that the whole chain works end to end. Everything before that is
noise-tolerance.
