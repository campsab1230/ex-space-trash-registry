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
- **Site clicks** — they opened the link. **Tag the link** (below) so this is
  measurable per channel instead of guessed.
- **Started checkout** — `checkout_started` in `analytics_events` (or count
  Stripe Checkout sessions opened).
- **Purchased** — `checkout_completed` / paid sessions.

---

## Tag your DM links (do this — it's the whole point)

The site now reads a campaign tag off the URL and stores it on every event.
Append **one** of these to the link you paste into DMs:

| Where you posted it | Link to paste |
| --- | --- |
| Instagram DM | `https://www.exspacetrash.com/?utm_source=ig&utm_medium=dm` |
| Reddit comment | `https://www.exspacetrash.com/?utm_source=reddit&utm_medium=comment` |
| TikTok bio / caption | `https://www.exspacetrash.com/?utm_source=tiktok&utm_medium=bio` |
| X / Twitter | `https://www.exspacetrash.com/?utm_source=x&utm_medium=dm` |
| Any other | `https://www.exspacetrash.com/?ref=<channel>` |

Rules that matter:

- **Use a different `utm_source` per channel.** Same tag everywhere = you learn
  nothing. That's the only discipline required.
- **`ref=` alone works too** and is the shortest option when a platform mangles
  long URLs.
- The tag is remembered for the visit (`sessionStorage`), so it still counts if
  they browse before buying — not just on the very first page load.
- **Never put `session_id` in a shared link.** That's a payment identifier from
  your own Stripe redirect. The site strips query strings before storing paths
  for exactly this reason.
- Link shorteners still work — just make sure the tag survives the shortening
  (add it to the destination URL, not the shortener's page).

---

## Analytics health check (run this first, once)

Your site's analytics can fail **silently** — `/api/track` always returns
`204`, even when it recorded nothing. So check the table directly before
trusting any other number here. Supabase → SQL Editor:

```sql
-- Expect a growing count. If this stays 0 while you have visitors,
-- SUPABASE_SERVICE_ROLE_KEY is missing in Vercel (Vercel → Settings →
-- Environment Variables), which is the usual cause.
SELECT count(*) FROM analytics_events;
```

```sql
-- What actually landed, newest first
SELECT event, ref, path, created_at
  FROM analytics_events
 ORDER BY created_at DESC
 LIMIT 25;
```

Then the funnel itself:

```sql
-- Funnel counts, last 30 days
SELECT event, count(*)
  FROM analytics_events
 WHERE created_at > now() - interval '30 days'
 GROUP BY event
 ORDER BY count(*) DESC;
```

```sql
-- WHICH CHANNEL ACTUALLY WORKS — the report the tags exist for.
-- Requires migrations/003_campaign_ref.sql to have been run.
SELECT
  COALESCE(ref, '(no tag)')                            AS channel,
  count(*) FILTER (WHERE event = 'page_view')          AS views,
  count(*) FILTER (WHERE event = 'hero_cta_clicked')   AS cta_clicks,
  count(*) FILTER (WHERE event = 'checkout_started')   AS checkouts,
  count(*) FILTER (WHERE event = 'checkout_completed') AS purchases
FROM analytics_events
WHERE created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY views DESC;
```

Read it like this: **views** says whether the DM earned a tap at all;
**cta_clicks** says whether the page made sense when they arrived; **checkouts**
says whether the price landed; **purchases** says whether the whole thing works.

A channel with views but no purchases is a *pitch* problem. Zero views is an
*outreach* problem. Those are different days' work.

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
