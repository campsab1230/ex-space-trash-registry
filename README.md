# ExSpaceTrash.com

Pay $1.99–$9.99 to permanently name a real, catalogued piece of orbital debris
after your ex, and download a novelty certificate to prove it.

---

## Project Overview

- **Name**: ExSpaceTrash.com
- **Goal**: A novelty e-commerce site that turns real NORAD-tracked space debris
  into a shareable, permanent gag gift.
- **Stack**: Static `index.html` + Three.js r128 (CDN) → Vercel serverless
  functions in `api/` → Supabase (Postgres + RLS) for the registry → Stripe
  Checkout for payment.

### Main features

1. **3D debris field** — real objects fetched from CelesTrak, plotted by real
   altitude (LEO / MEO / GEO), clickable on desktop and mobile.
2. **Claim flow** — pick an object, type your ex's name, choose a certificate
   design, pay via Stripe.
3. **Certificates** — two artwork templates (Orbital / Parchment) with the
   buyer's text rendered on top, downloadable as high-resolution PNG.
4. **Public registry wall** (`/wall`) — every claim, server-rendered and
   crawlable.
5. **Per-claim share pages** (`/trash/:noradId`) — real OG tags + generated
   preview image, so shared links show a card.
6. **First-party analytics** — cookie-free funnel tracking.

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

### `global_registry` columns (verified against the live table)

`id`, `created_at`, `norad_id`, `debris_name`, `dedication_name`,
`stripe_session_id`, `owner_email`, `user_email`, `google_user_id`,
`custom_quote`, `custom_message`, `stat`, `emoji_overlay`, `has_broken_heart`,
`certificate_template`

### Data flow

```
index.html
  └─ POST /api/create-checkout  → validates price against the object's orbit,
     creates a Stripe session, writes a pending_claims lock
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
| `/api/create-checkout` | POST | Enforces price ↔ orbit match |
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

Migration 002 also renames `pending_claims.stripe_session_id` → `session_id` if
the old name is present, which matches what `create-checkout.js` writes.

**Verify after running 002:**

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('global_registry','pending_claims','analytics_events')
 ORDER BY table_name, ordinal_position;
```

---

## User Guide

1. Open the site and wait for the debris field to load.
2. Click a piece of debris (or search for one) to open the telemetry panel.
3. Hit **CLAIM THIS TRASH**, type the ex's name, optionally add a message and an
   emoji.
4. Pick a certificate design — the live preview updates as you type.
5. Pay via Stripe. You land back on the site, which verifies the payment and
   shows the certificate.
6. **Download** the PNG or **Share** the claim link.

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

- **Supabase free tier pauses after ~7 days of inactivity.** Restore it from the
  dashboard, or the site silently loses its database.
- `api/og-image.js` contains JSX and **cannot** be validated with `node --check`;
  Vercel's build transform handles it.
- The anon key in `index.html` is intentionally public. Security relies on RLS,
  not on the key being secret. Never put a service-role key in the front end.

**Last updated**: 2026-09-18
