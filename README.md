# ExSpaceTrash.com

Pay **$7.99** to name a real, catalogued piece of orbital debris after your ex
and download a novelty certificate — or **$19.99 / $29.99** to also have it
printed and posted. Every orbit costs the same.

---

## Project Overview

- **Name**: ExSpaceTrash.com
- **Goal**: A novelty e-commerce site that turns real NORAD-tracked space debris
  into a shareable, permanent gag gift.
- **Stack**: Static `index.html` + Three.js r128 (CDN) → Vercel serverless
  functions in `api/` → Supabase (Postgres + RLS) for the registry → Stripe
  Checkout for payment.

### Main features

1. **Cold-traffic hero** — the landing panel leads with the hook
   (*"YOUR EX WANTED SPACE."*), the price, a single **START MY CERTIFICATE**
   button, and the certificate artwork itself. The button auto-picks an
   unclaimed object and opens the personalisation form, so a visitor from a DM
   never has to find the 3D field. Catalogue search and the "is this real?"
   explainer are demoted into collapsed `<details>` so they cannot compete with
   the one call to action.
2. **3D debris field** — real objects fetched from CelesTrak, plotted by real
   altitude (LEO / MEO / GEO), clickable on desktop and mobile. Still available
   behind *"Prefer to browse the catalogue yourself?"*.
3. **Claim flow** — pick an object, type your ex's name, choose a certificate
   design, pay via Stripe.
4. **Certificates** — two artwork templates (Orbital / Parchment), downloadable
   as high-resolution PNG. The artwork carries **no printed words at all**:
   every word — the fixed title, kicker, sign-off and fine print *and* the
   buyer's name, quote, emoji and meta line — is real HTML laid over the art.
   The stage is a **flex column** of three rows (`cert-head` / `cert-slot` /
   `cert-foot`), so the buyer's block and the printed copy are siblings that
   structurally cannot overlap, however long the name is. See *Certificate
   layout* below.
5. **Physical mail option** — **$19.99** domestic / **$29.99** international is
   the *whole order total* (digital + a printed copy posted to the buyer), not
   an add-on. The server charges the digital line plus the printed difference,
   so the receipt still itemises the print and adds up to exactly the
   advertised number. Stripe collects the address; it is never stored in our
   database.
6. **Public registry wall** (`/wall`) — every claim, server-rendered and
   crawlable. Doubles as social proof.
7. **Per-claim share pages** (`/trash/:noradId`) — real OG tags + generated
   preview image, so shared links show a card.
8. **First-party analytics** — cookie-free funnel tracking, with campaign
   attribution for outreach links (append `?ref=<channel>` or
   `?utm_source=<channel>` to a DM link and events are tagged with it; the
   table stores a short sanitised token, **never** the raw query string).

---

## URLs

| What | URL |
| --- | --- |
| Production | https://www.exspacetrash.com |
| Registry wall | https://www.exspacetrash.com/wall |
| Share page (example) | https://www.exspacetrash.com/trash/35786 |
| Dynamic sitemap | https://www.exspacetrash.com/sitemap.xml |
| OG image generator | `https://www.exspacetrash.com/api/og-image?id=<noradId>` |
| GitHub | https://github.com/campsab1230/ex-space-trash-registry |

---

## Data Architecture

**Storage**: Supabase (Postgres), anon key public in `index.html`, RLS enforced.

### Tables

| Table | Purpose | Notes |
| --- | --- | --- |
| `global_registry` | One row per completed claim | Public `SELECT` only; **no** anon writes |
| `pending_claims` | Soft-lock during checkout | No anon access at all |
| `analytics_events` | Funnel events | No anon access; written via service role |

### Orders needing a physical mailing

One query lists everything that still needs printing and posting:

```sql
SELECT norad_id, dedication_name, created_at
  FROM global_registry
 WHERE physical_mail = true
 ORDER BY created_at;
```

The mailing **address** is not in this table by design — Stripe collected it and
it lives on the payment in the Stripe dashboard.

### `global_registry` columns (verified against the live table)

`id`, `created_at`, `norad_id`, `debris_name`, `dedication_name`,
`stripe_session_id`, `owner_email`, `user_email`, `google_user_id`,
`custom_quote`, `custom_message`, `stat`, `emoji_overlay`, `has_broken_heart`,
`certificate_template`, `physical_mail`

### Data flow

```
index.html
  └─ POST /api/create-checkout  → validates the flat base price, derives the
     real total server-side, creates a Stripe session, writes a pending_claims lock
        └─ Stripe Checkout (hosted)
             └─ POST /api/stripe-webhook  → verifies signature, confirms
                payment_status === 'paid', writes the global_registry row
                   └─ index.html polls GET /api/verify-session → shows the
                      certificate and enables download
```

---

## API reference

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/get-celestrak-debris` | GET | Debris list, Fisher-Yates shuffled |
| `/api/create-checkout` | POST | Flat price; server derives the total |
| `/api/stripe-webhook` | POST | Stripe-only writer to the registry |
| `/api/verify-session` | GET | Read-only, `?session_id=` |
| `/api/og-image` | GET | 1200×630 PNG, `?id=<noradId>` |
| `/api/trash-page` | GET | Share page (routed from `/trash/:slug`) |
| `/api/wall` | GET | Registry wall (routed from `/wall`) |
| `/api/sitemap` | GET | Dynamic XML (routed from `/sitemap.xml`) |
| `/api/track` | POST | Allow-listed funnel events, always 204 |

### Required environment variables (Vercel → Settings → Environment Variables)

| Variable | Used by |
| --- | --- |
| `SUPABASE_URL` | all DB handlers |
| `SUPABASE_ANON_KEY` | read-only handlers |
| `SUPABASE_SERVICE_ROLE_KEY` | `stripe-webhook`, `track` |
| `STRIPE_SECRET_KEY` | `create-checkout`, `verify-session`, `stripe-webhook` |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` |
| `SITE_URL` | `create-checkout` |

---

## Deployment

- **Platform**: Vercel, auto-deploying from GitHub `main`
- **Status**: ✅ Active
- **Migrations**: run manually in Supabase → SQL Editor

### Applying migrations

Run in order, once each:

1. `migrations/001_hardening.sql`
2. `migrations/002_analytics_and_fixes.sql`
3. `migrations/003_campaign_ref.sql` — campaign attribution (the `ref` column)

Migration 002 also renames `pending_claims.stripe_session_id` → `session_id` if
the old name is present, which matches what `create-checkout.js` writes.

Migration 003 is **optional but recommended**: it adds `analytics_events.ref`,
which is what lets a tagged outreach link be told apart from organic traffic.
Until it runs, `/api/track` still records every event — it detects the missing
column, logs a warning, and retries the insert without `ref` rather than losing
the event. So the funnel keeps working either way; you just lose attribution.

**Verify after running all three:**

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('global_registry','pending_claims','analytics_events')
 ORDER BY table_name, ordinal_position;
```

**Then confirm analytics is actually recording** (it fails silently by design —
`/api/track` returns `204` even when it stored nothing):

```sql
SELECT count(*) FROM analytics_events;
```

If that stays `0` while the site has visitors, `SUPABASE_SERVICE_ROLE_KEY` is
missing in Vercel → Settings → Environment Variables. That is the single most
common cause.

---

## User Guide

**Fastest path (what most cold traffic should do):**

1. Open the site.
2. Tap **START MY CERTIFICATE** — an unclaimed object is chosen automatically.
3. Type the ex's name, optionally add a message and an emoji. The **emoji is a
   $1.99 add-on** and it is painted onto the actual piece of debris in the 3D
   scene — once claimed, that object floats through the field wearing the emoji,
   so the badge is visible to everyone, not just on your certificate.
4. Pick a certificate design — the live preview updates as you type.
5. Pay via Stripe. You land back on the site, which verifies the payment and
   shows the certificate.
6. **Download** the PNG or **Share** the claim link.

**Browse-it-yourself path:**

1. Expand *"Prefer to browse the catalogue yourself?"* inside the hero.
2. Filter by orbit or search by NORAD ID / name, or tap an object in the debris
   field behind the panel.
3. Hit **CLAIM THIS TRASH** and continue from step 3 above.

To browse other people's claims, visit [`/wall`](https://www.exspacetrash.com/wall).

---

## Repository layout

```
.
├── index.html                 # entire front end (3D scene, claim flow, certificates)
├── legal.html                 # terms & novelty disclaimer
├── vercel.json                # rewrites: /trash/*, /wall, /sitemap.xml
├── package.json               # "type": "module" — all api/ files are ESM
├── api/                       # Vercel serverless functions
├── assets/certs/              # certificate artwork (1024×765)
├── migrations/                # SQL to run in Supabase
├── public/                    # static passthrough
└── {favicon, icon-*, og-image, manifest, robots, sitemap}.*  # brand + SEO assets
```

---

## Known constraints

- **`SUPABASE_SERVICE_ROLE_KEY` must be set in Vercel for analytics to record
  anything.** `/api/track` deliberately swallows all errors and always returns
  `204`, so if that variable is missing every event is silently discarded and
  `analytics_events` stays empty while the endpoint still looks healthy. Verify
  with `SELECT count(*) FROM analytics_events;` after visiting the site.
- **Supabase free tier pauses after ~7 days of inactivity.** Restore it from the
  dashboard, or the site silently loses its database.
- `api/og-image.js` contains JSX and **cannot** be validated with `node --check`;
  Vercel's build transform handles it.
- The anon key in `index.html` is intentionally public. Security relies on RLS,
  not on the key being secret. Never put a service-role key in the front end.

**Last updated**: 2026-09-22

---

## Tests

Five zero-dependency guard checks live in `tests/`. Run them all with `npm test`,
or individually after any change to pricing, the checkout handoff, analytics,
the 3D scene, or the certificate layout:

```bash
npm test                          # runs all five, in order
node tests/check-contracts.mjs    # client/server key names match
node tests/check-cert-layout.mjs  # certificate stays structurally collision-proof
node tests/check-pricing.mjs      # prices agree across client, server, legal page
node tests/check-cleanref.mjs     # analytics input sanitiser resists hostile input
node tests/check-emoji-scene.mjs  # the $1.99 emoji add-on renders on the 3D object
```

They exist because the bugs that actually cost money here are **silent**:

- **`check-contracts.mjs`** is the important one. `api/verify-session.js` and
  `index.html` exchange JSON with no schema, so a renamed or misspelled key
  fails at runtime as `undefined` with **no error anywhere**. That is exactly
  how the certificate bug happened: the server sent `certificateTemplate`, the
  client read `template`, the value was always `undefined`, and the renderer
  quietly fell back to the default design. This test parses both files and
  asserts every key the client reads is a key the server sends — so that
  failure mode cannot recur unnoticed.
- **`check-pricing.mjs`** prevents the advertised price drifting from the
  charged price. A receipt that disagrees with the page is a refund risk.
- **`check-cleanref.mjs`** asserts the analytics sanitiser's security
  properties (output charset is allow-listed, length capped, non-strings
  rejected) rather than hand-written expected strings.
- **`check-emoji-scene.mjs`** guards the $1.99 add-on end to end. The add-on
  used to be collected, stored, and drawn on the certificate — but never
  rendered in the 3D scene, so buyers paid $1.99 and saw no difference. The
  chain has several links (`loadRegistry` select → registry field → sprite
  factory → applier → call sites), and breaking any **one** silently restores
  the original bug with no error output. It also locks the badge-orbit fix: the
  animation loop must spin the debris **mesh**, not the owning `Group`, because
  the badge is an offset child of that group and would swing away from the
  object (and behind it) if the group were rotated.

- **`check-cert-layout.mjs`** guards the certificate rebuild described under
  *Certificate layout* above. The old design baked the printed copy into the
  artwork's pixels, so a long buyer name ran across printed words; the fix moved
  every word into HTML in a flex column. Three properties keep that safe, and
  losing any one silently restores the collision: the stage must stay
  `display:flex; flex-direction:column` (siblings cannot overlap), the rows must
  stay **out of** `position:absolute` (absolute + a long name is precisely how
  the block used to reach the footer), and the stage must stay `border-box`
  (otherwise its 76/66px padding inflates the 1024×765 box and html2canvas
  clips the footer off the bottom — which is exactly what happened). It asserts
  all three across both markup instances and both templates.

All five exit non-zero on failure, so they can gate a deploy.
