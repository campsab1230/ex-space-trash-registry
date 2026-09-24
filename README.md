# ExSpaceTrash.com

Pay **$7.99** to name a real, catalogued piece of orbital debris after your ex
and download a novelty certificate — or **$19.99 / $29.99** to also have it
printed and posted. Every orbit costs the same.

---

## Project Overview

- **Name**: ExSpaceTrash.com
- **Goal**: A novelty e-commerce site that turns real NORAD-tracked space debris
  into a shareable, permanent gag gift.
- **Stack**: Static `index.html` marketing homepage → `certificate-app.html` (existing Three.js r128 purchase/registry app) → Vercel serverless functions in `api/` → Supabase (Postgres + RLS) → Stripe Checkout.

### Main features

1. **Character-led homepage** — the home page introduces the supplied space crew illustration and a single **GET MY CERTIFICATE** call to action. The 3D purchase/registry app loads only after the visitor follows that action. The app retains the original auto-pick, certificate, and checkout flow. The homepage deliberately carries **no price** (see *Pricing is revealed in the funnel, not on the homepage*).
2. **3D debris field** — real objects fetched from CelesTrak, plotted by real altitude (LEO / MEO / GEO), clickable on desktop and mobile. Loaded on the certificate app page after the homepage action.
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

**Storage**: Supabase (Postgres), anon key public in `certificate-app.html`, RLS enforced.

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
certificate-app.html
  └─ POST /api/create-checkout  → validates the flat base price, derives the
     real total server-side, creates a Stripe session, writes a pending_claims lock
        └─ Stripe Checkout (hosted)
             └─ POST /api/stripe-webhook  → verifies signature, confirms
                payment_status === 'paid', writes the global_registry row
                   └─ certificate-app.html polls GET /api/verify-session → shows the
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
| `/api/og-image` | GET | 1200×630 PNG, `?id=<noradId>` — generic card if unclaimed |
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
├── index.html                 # character-led homepage and certificate CTA
├── certificate-app.html       # 3D scene, claim flow, certificates, post-checkout confirmation
├── legal.html                 # terms & novelty disclaimer
├── vercel.json                # rewrites: /trash/*, /wall, /sitemap.xml
├── package.json               # "type": "module" — all api/ files are ESM
├── api/                       # Vercel serverless functions
├── assets/certs/              # certificate artwork + the baked hero sample (1024×765)
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
- The anon key in `certificate-app.html` is intentionally public. Security relies on RLS,
  not on the key being secret. Never put a service-role key in the front end.

**Last updated**: 2026-09-22

---

## Tests

Nine zero-dependency guard checks live in `tests/`. Run them all with `npm test`,
or individually after any change to pricing, the checkout handoff, analytics,
the 3D scene, the certificate layout, or the sticker pack:

```bash
npm test                            # runs all nine, in order
node tests/check-contracts.mjs      # client/server key names match
node tests/check-cert-layout.mjs    # certificate stays structurally collision-proof
node tests/check-pricing.mjs        # prices agree across client, server, legal page
node tests/check-cleanref.mjs       # analytics input sanitiser resists hostile input
node tests/check-emoji-scene.mjs    # the $1.99 emoji add-on renders on the 3D object
node tests/check-og-image.mjs       # OG handler stays JSX-free + cache contract holds
node tests/check-discovery.mjs      # sitemap unshadowed, JSON-LD prices match checkout
node tests/check-entry-flow.mjs     # homepage → app → post-checkout is connected
node tests/check-sticker-pack.mjs   # pack exists, is linked, is tracked, is disclosed
```

They exist because the bugs that actually cost money here are **silent**:

- **`check-contracts.mjs`** is the important one. `api/verify-session.js` and
  `certificate-app.html` exchanges JSON with no schema, so a renamed or misspelled key
  fails at runtime as `undefined` with **no error anywhere**. That is exactly
  how the certificate bug happened: the server sent `certificateTemplate`, the
  client read `template`, the value was always `undefined`, and the renderer
  quietly fell back to the default design. This test parses both files and
  asserts every key the client reads is a key the server sends — so that
  failure mode cannot recur unnoticed.
- **`check-pricing.mjs`** prevents the advertised price drifting from the
  charged price. A receipt that disagrees with the page is a refund risk. It
  also **pins the price-free homepage** and asserts the entry price is still
  present on `certificate-app.html` — see *Pricing is revealed in the funnel,
  not on the homepage*.
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
  all three across both markup instances and both templates. It also guards the
  hero image (below).

- **The hero must NOT point at the template artwork.** `cert-a-orbital.png` and
  `cert-b-parchment.png` are deliberately word-free — every word on a real
  certificate is HTML overlaid at capture time. Pointing the landing-page hero
  `<img>` at that raw art therefore shows shoppers a **blank sheet**, which is
  exactly the bug that shipped: the markup was correct in the dev repo but the
  fix never reached `certificate-app.html` in the deploy repo, so production kept serving
  the old `src`. The hero uses `cert-sample-b.png` instead — a one-off render of
  the *finished* template-B certificate (placeholder name, quote, object ID)
  baked to a single flat image. If the certificate design changes, re-render
  that sample; do not repoint the hero at the raw art. `check-cert-layout.mjs`
  fails if the hero `src` resolves to a template artwork or the sample is
  missing.

- **A collapsed panel must hide something visible.** The mobile arrow only
  appeared to do nothing: its `.header-panel.collapsed` rules hid `.field-label`,
  `.search-row` and `#search-match-count`, all of which live inside *closed*
  `<details>` blocks, so the click flipped the glyph and nothing else. The rule
  set now hides the panel's actually-visible body (hero sub-head, certificate,
  price block, trust/proof rows) while keeping the brand line, the hook and the
  CTA — a collapsed panel stays a usable header rather than an empty bar.

- **`check-og-image.mjs`** guards the social-preview endpoint, which was
  *never working*. It returned `FUNCTION_INVOCATION_FAILED` (500) for every
  request — including one with no `id`, which skips the database entirely, and
  that is what proved the fault was in the module rather than in Supabase or the
  env vars. The cause: the render tree was written as **JSX inside a plain
  `.js` file**, and Vercel runs `api/*.js` with no build step, so nothing
  transpiled it and the file failed to parse before the handler body ran.
  (`@vercel/og` is also edge-oriented while the file pinned `runtime: 'nodejs'`.)
  The tree is now built with a tiny `el()` helper, which produces exactly the
  React-element shape satori consumes — `{ type, props }` — so no JSX, no
  transpile and no React dependency are needed. **Keep JSX out of `api/`.** The
  guard runs `node --check` over every `api/*.js` (which rejects JSX outright),
  and pins the data contract (`global_registry.dedication_name`, not the old
  nonexistent `claims.custom_name`) plus the two-tier caching rule: a real
  claim's card is immutable for a year, but a fallback card must expire in
  minutes or a link shared mid-purchase pins a blank preview on that object.

All nine exit non-zero on failure, so they can gate a deploy.

> **Why the og-image guard strips comments before asserting.** The file's own
> header comment names the old `claims` / `custom_name` bug, so a naive grep
> over the raw source reports a regression that does not exist — the first
> version of this test failed on its own documentation. It now strips comments
> (but keeps string contents, since the assertions look for quoted identifiers)
> before checking what the *code* does.


## Character-led homepage and post-checkout art

The root page uses the supplied crew illustration at `assets/characters/homepage-crew.jpg` and does not load the 3D scene. The **GET MY CERTIFICATE** button opens `certificate-app.html`, which retains the existing 3D registry and certificate/checkout behavior. Stripe success and cancel returns target that app page; after payment verification, the supplied mission-complete illustration appears in the success dialog from `assets/characters/post-checkout-mission-complete.jpg`.

---

## Pricing is revealed in the funnel, not on the homepage

The homepage is **top of funnel** and its job is to make a cold visitor want the
thing before they are asked to price it. It therefore carries **no price in any
form** — no visible figure in the markup, and no priced structured data either.

Two separate surfaces had to go, and the second is the one that is easy to miss:

- **Visible text.** The line under the CTA used to read `$7.99 digital
  certificate · Printed and posted options: $19.99 domestic / $29.99
  international`. It is now `.value-line`, which sells the *outcome* — a real
  certificate for a real piece of debris, printed and posted if you want it on a
  doormat — with no number in it.
- **JSON-LD.** The `Product` block carried an `AggregateOffer` with
  `lowPrice`/`highPrice` and three `Offer` entries. Nothing on the page showed
  those, but **Google reads them and can print the figure in a search snippet**,
  which is precisely the cold-traffic exposure this policy avoids. The `Product`
  block stays (name, description, image, url, brand) so the page is still
  eligible for rich treatment; only the offers are gone.

**The price must still exist somewhere crawlable.** It now lives only on
`certificate-app.html`, whose own JSON-LD carries the real `Product` +
`AggregateOffer` at `7.99 / 19.99 / 29.99`. That file is where a visitor has
engaged with the product and where the purchase decision actually happens —
hiding the number *at the decision point* is what makes people abandon. The
funnel keeps exactly one authoritative price, one page deeper.

**Guard.** `check-pricing.mjs` fails the build if the homepage regains a price.
It scans visible text with HTML comments stripped (`stripHtmlComments`), and
checks the JSON-LD keys (`lowPrice|highPrice|price`) separately, because a
structured price is invisible to a human and would otherwise slip through. It
also asserts the entry price is *still present* on `certificate-app.html`, so
the cheap "fix" of deleting pricing everywhere is caught too. `check-discovery.mjs`
reads the priced LD block from the app page rather than the homepage, so the
`check-pricing` agreement check between schema and checkout still has a subject.

**Shop window vs. shelf.** The analogy that keeps this from being reverted by
accident: the homepage is the shop window, `certificate-app.html` is the shelf.
You do not sticker the glass; you sticker the product.

---

## The sticker pack (free with every order)

Every order — digital-only and printed alike — includes a downloadable **sticker pack**, offered in the post-purchase success modal. It is a *keepsake at the delivery moment*, deliberately not a lead magnet: no hero badge, no "FREE BONUS!" shouting, and no third prominent CTA competing with `DOWNLOAD CERTIFICATE` and `SHARE`, because the share loop is what actually drives this site.

| Asset | Path |
| --- | --- |
| US Letter sheet | `assets/stickers/sticker-pack-letter.pdf` |
| A4 sheet | `assets/stickers/sticker-pack-a4.pdf` |
| Transparent PNGs | `assets/stickers/sticker-pack-png.zip` |

**Two sheet sizes, not one.** The site sells an international $29.99 tier, so a Letter-only pack is wrong for a whole class of paying buyers. `check-sticker-pack.mjs` fails if A4 disappears.

**Built from the supplied artwork.** The source images were 1024×1024 **JPEGs renamed `.png`** with the checkerboard baked into pixels — no alpha channel. `assets/stickers/` is generated from them by a structural cutout (greyscale-background detection keyed to the white die-cut outline, border-connected, hole-filled, edge-colour-extended so the feathered edge never blends into checkerboard grey). Print output is resampled to exactly **300 dpi at ~2.35 in** on the long edge, aspect-preserved to within 0.25% of source.

**Deliberately ungated.** The PDFs sit at permanent, predictable URLs. Gating a freebie protects zero revenue while adding a DB lookup, a token path, and a support surface the moment a buyer wants to re-download. There is no payment-verification dependency, and `check-sticker-pack.mjs` asserts there never is.

**Not shipped.** The pack is a digital bonus; the buyer prints it. `legal.html` §4b says so explicitly, so no one forms a delivery expectation — and it states that the pack does not increase the price and may be withdrawn as a free extra.

**If it breaks, nothing tells you.** It is a free extra, so no one emails; and `/api/track` silently `204`s any event not on its allow-list. `sticker_pack_downloaded` is on that list, and the guard fails if it is removed — otherwise the funnel would undercount clicks with no error anywhere.

**Coloring book (planned, not built).** A separate coloring book using the same characters is intended for a future *break-up package* — it is **not** part of this sticker pack and is not wired into the success modal. Do not fold it into the free pack without deciding the package structure first.

---

## The social card (`og-image.png`)

`og-image.png` is the **static** card every social platform unfurls when someone
links `exspacetrash.com` — X/Twitter, iMessage, Slack, Discord, LinkedIn,
Facebook. It is referenced from seven places: `index.html` (og:image,
twitter:image, JSON-LD `image`), `certificate-app.html` (og:image,
twitter:image, JSON-LD `image`) and `api/wall.js`.

It is **not** the same artifact as `api/og-image.js`. That handler renders a
*dynamic* per-claim card for `/trash/:slug` links and carries no price. The
plain-domain card is the static file, and for a long time nothing checked it.

**The bug this section exists for.** The card was produced from
`og-image.svg` — which **nothing rendered and nothing referenced**. No npm
script, no build step. That file hard-coded
`Permanently. For $1.99.` in it, so when the price moved, the card did not:
a stale price sat in every timeline preview for weeks. The SVG was never
regenerated after the price change, and no guard looked at it, because
`check-og-image.mjs` only watched the dynamic handler. It was also still
rendering the *retired* registry aesthetic (dark/cyan monospace,
`DEBRIS ENGAGED`, a `SEASHELL` placeholder) rather than the current brand.

**Now: one source, reproducible from the repo.** `og-image.svg` is **deleted**.
The card is built by `tools/build-og-image.py`, which composes real assets —
the current certificate artwork (`assets/certs/cert-sample-b.png`, cropped to
its light frame) centred, with the die-cut character stickers from
`assets/stickers/sticker-pack-png.zip` around it, overlapping its edges.

```bash
python3 tools/build-og-image.py            # writes og-image.png
python3 tools/build-og-image.py --preview  # also writes a 600px proof
```

Rendered with Pillow rather than SVG because the card is built from **real
raster assets**, and `rsvg-convert` cannot load a referenced `href` — a test
render came back as flat background. A base64 pool would work but would bloat
the source with binary. The generator reads the sticker PNGs straight out of
the committed zip, so the card is reproducible from the repository alone with
no untracked scratch files.

**Cold-traffic surface: no price.** The card follows the same rule as the
homepage — see *Pricing is revealed in the funnel, not on the homepage*. A
visitor meeting the product for the first time in a timeline has not been sold
yet, so the card is a shop window, not a shelf. The copy lives in
`tools/og-image-copy.json`, which both the generator and the guard read, so
they cannot drift apart.

**Size.** A straight RGB save is ~635 KB; crawlers fetch this on every unfurl.
The artwork is a flat illustration palette, so a 256-colour quantisation is
visually indistinguishable from the full-RGB render (checked at 2× on both the
certificate and the dark gradient) and lands at ~220 KB.

**Cache busting: the URL changes when the picture does.** Social platforms cache
a link preview against the **image URL**, not the page, and X holds one for
about a week. Vercel itself never caches the file (`public, max-age=0,
must-revalidate`), so the *only* way to make an updated card appear immediately
is to change the URL. That is why the card shipped as `og-image.png` looks
undone for a week after every change.

Every build therefore writes the card **twice**:

| File | Role |
| --- | --- |
| `og-image.png` | stable name, for anything that expects it |
| `og-image.v<hash>.png` | the URL the pages actually reference |
| `tools/og-image-names.json` | manifest naming the current card (and the previous one) |

`<hash>` is the first 12 hex of the PNG's own SHA-256, so the filename changes
**if and only if the picture changes**. Rendering is deterministic — fixed star
seed, LANCZOS resampling, a fixed quantiser — so a no-op rebuild produces the
same hash and does **not** churn the URL. Verified: two consecutive runs emitted
the same digest.

The generator also **rewrites the references itself** (`sync_references`), across
`index.html`, `certificate-app.html` and `api/wall.js`. This is the part that
matters: the pages are static HTML, so a hashed filename is useless unless
something updates the markup — and "someone remembers to bump the version" is
precisely the manual discipline that failed when the orphaned SVG was left
behind. It now happens as a side effect of building the card.

One previous version is **kept on purpose**. A platform still holding the old
URL must not start 404ing; older ones are pruned.

**A note on the pattern.** Both the generator's rewrite regex and the guard's
detector use `og-image(?:\.v[0-9a-f]+)?\.png`. The `v` is load-bearing: `v` is
not a hex digit, so a pattern of `(?:\.[0-9a-f]+)?` silently fails to match our
own output. That bug shipped in the first version of both files — the guard
reported every reference as missing, and worse, the generator could never
replace a hashed URL on a subsequent build, which would leave a stale reference
pointing at a deleted file.

**Guard.** `check-og-image.mjs` now covers the static card as well as the
handler: the copy file carries no currency symbol and no price-shaped number,
the rendered PNG is a real 1200×630 PNG in a sane size range, the generator
exists and reads the copy file, the dead SVG stays deleted, and the retired
strings cannot reappear in the card's sources.

It also asserts that **every referenced `og:image` URL resolves to a file we
actually ship**, and that the pages and the build manifest agree on one name.
Once the filename is content-hashed, a stale reference is worse than the
original bug: a mismatched hash does not serve an out-of-date card, it serves
*no card* — the URL 404s and the link unfurls bare. Nothing else in the suite
would notice.

The scope is deliberately narrow — it inspects only the files that *produce the
card*. `certificate-app.html` legitimately prices things (the `$1.99` emoji
add-on, the tier select) and legitimately shows `DEBRIS ENGAGED` as a live
status heading; scanning it here produced three false positives on the first
run, which is why `check-pricing.mjs` owns the homepage/decision-surface policy
instead.

**Last updated**: 2026-09-24

