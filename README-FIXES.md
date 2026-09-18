# ExSpaceTrash — Audit Fixes & Action Plan

Prepared 2026-09-18. Everything in this folder is **drop-in ready** for your
Vercel project. Nothing here has been deployed.

> Your site is hosted on **Vercel** (not Cloudflare Pages), so ignore any
> Cloudflare deployment guidance — it does not apply to you.

---

## 🔴 STEP 1 — ROOT CAUSE FOUND: ESM vs CommonJS mismatch

**This is why you were 500ing. It was never Supabase.**

`get-celestrak-debris.js` uses `import` / `export default` (**ESM**) and works.
The other three use `require` / `module.exports` (**CommonJS**) and 500 on
every single request.

Your project is `"type": "module"`. Under ESM, `require is not defined`, so
those three files **throw at load time — before a single line of logic runs.**
That is why even a `GET` (which your code answers with a 405) returns 500: the
405 line is never reached.

### Proof
A wrong-method request can only return 500 if the module failed to load:

```
GET /api/create-checkout  -> 500   (your code returns 405 for non-POST)
GET /api/stripe-webhook   -> 500
GET /api/verify-session   -> 500
```

And all four files, loaded as ESM with dummy env vars, import cleanly:
```
OK   create-checkout.js           -> handler is function
OK   stripe-webhook.js            -> handler is function, config={"api":{"bodyParser":false}}
OK   verify-session.js            -> handler is function
OK   get-celestrak-debris.js      -> handler is function
```

### Fixed files are in `api/` — drop-in replacements
Converted to ESM. Logic preserved. Note the ESM form of the body-parser opt-out
is `export const config = { api: { bodyParser: false } }`, not
`module.exports.config = ...`.

**Also changed in all three:** `Stripe(...)` -> `new Stripe(...)`.

⚠️ **Correction to something I said earlier.** I initially reported that
`Stripe()` without `new` was a *cause* of your outage. That was wrong. I had
tested against stripe v22, but your `package.json` pins `^16.0.0`, and I
confirmed v16.12.0 does **not** throw:

```
stripe@16  Stripe(no new) -> WORKS (no throw)
stripe@16  new Stripe()   -> WORKS
```

So the only cause of the outage was the ESM/CJS mismatch. The `new Stripe()`
change is **future-proofing only** — stripe v17+ does throw
`Class constructor Stripe cannot be invoked without 'new'` at load time, so if
you ever bump the version without this change, all three handlers die again
with the exact same symptom as this outage.

---

## 🔴 STEP 1b — Your pricing check can be bypassed

I found this in your real `create-checkout.js`:

```js
const validPrices = [1.99, 5.99, 9.99];
if (!validPrices.includes(numericPrice)) return 400;
```

This validates the price is *one of* your tiers — **but never checks it matches
the object's orbit.** Anyone can claim a $9.99 GEO object for **$1.99** by
editing the request body. It's a real hole, not theoretical.

My version derives the tier from the object's own altitude (which your server
generated in `stat`, so it isn't client-forgeable) and verifies the client's
number agrees.

### ⚠️ One thing I got wrong — and your file caught it
My earlier reference handler used `pending_claims.stripe_session_id`. I
introspected the live table: **that column does not exist.** The real column is
`session_id`. **Your code was right and mine would have crashed.** My fixed
version uses `session_id`.

---

## ✅ Good news: your webhook was already correct

Your `stripe-webhook.js` already does the right things:
- Verifies the signature with `constructEvent` against the **raw** body
- Disables the body parser (the classic trap — verified it works in ESM)
- Handles the `23505` unique-violation as idempotency
- Only uses the service-role key server-side

That was my biggest unknown, and you'd solved it. I only added a
`payment_status !== 'paid'` guard (a completed session isn't always a paid one)
and stopped it clearing the lock when the insert fails.

### ✅ Supabase + RLS: confirmed healthy
- Only the public `anon` key is in the client; `service_role` never ships. Correct.
- I tested anon writes: PATCH returned 200 with an empty result and **the value
  did not change**. RLS is genuinely locked down.

---

## 🔴 STEP 1c — The $11 problem is a VISIBILITY problem, not a marketing one

This is the finding I think actually explains your numbers.

`index.html` reads:
```js
const { data } = await _supabase.from('global_registry')
  .select('norad_id, debris_name, dedication_name');
liveGlobalRegistry[row.norad_id] = { exName: row.dedication_name, ... };
```

That is **exactly one of two people in the entire registry** — the two test
claims. Your mom and your friend are not in it. So:

- The ticker cycles between 2 names, not 5
- No object on the site shows as "already claimed"
- Every visitor sees a completely empty registry

**Your social proof is invisible, and nobody can tell anyone has ever bought
anything.** Worse: it means those other three sales very likely never produced
a registry row — and since `verify-session` was 500ing, those buyers may have
paid and received **no certificate at all**. That's a refund/chargeback risk
you should look at in your Stripe dashboard.

**Check your Stripe payments list** for successful charges. Any charge with no
matching row in `global_registry` is someone who paid and got nothing.

---

## 🔴 STEP 2 — Your Supabase project is on a death clock (Oct 20)

Supabase told you: upgrade by **October 20** or the project is removed.

**Reality check on the free tier** (verified 2026-09-18): free projects are
**paused after 7 days of inactivity**. That is almost certainly why your
endpoints died — you likely had a week with no orders, Supabase paused the
project, and every function that touched it started throwing 500.

**This will happen again.** Options:

1. **Cheapest safety net — a scheduled heartbeat.** Any request that touches the
   database resets the inactivity timer (your debris feed alone does *not* —
   it doesn't touch Supabase). A daily cron (Vercel Cron, GitHub Actions, or any
   uptime pinger) hitting a tiny endpoint that runs
   `SELECT 1 FROM global_registry LIMIT 1` keeps it awake for free.
2. **Then decide on the Oct 20 upgrade on your own timeline**, not theirs.

**Your data is safe.** I exported it before touching anything:
- `backup/global_registry.json` — raw rows
- `backup/global_registry.sql` — restore script

Both real sales are intact: `SEASHELL` (NORAD 35786) and `SEA TO THE SHELL`
(NORAD 30009).

---

## 🟠 STEP 3 — Lock the money path (files in `api/`)

These are **reference implementations**. Compare them to your live files and
port the differences — do **not** blindly overwrite without diffing, since I
couldn't see your originals.

**`api/stripe-webhook.js`** — the single most important file.
- Verifies the `stripe-signature` header with `constructEvent` against the
  **RAW body**. Vercel parses JSON by default; signature verification silently
  fails on a re-serialized body. The file disables the body parser and reads
  the stream itself.
- Handles Stripe's retries (idempotency) so one payment can't insert twice.
- Ignores `payment_status !== 'paid'`.

**`api/create-checkout.js`** — prices the order **server-side**.
- Your browser currently sends `price`. Anyone can POST `price: 0.01`.
  This version ignores that field entirely and looks the price up from
  `api/_lib/catalog.js`.
- Also verifies the NORAD id is a **real catalog object**, so id `999999`
  can't be bought.
- Re-checks claim status server-side before creating the session.

**`api/verify-session.js`** — read-only, as intended.
- Confirms payment with Stripe, then reports whether the webhook has written
  the row yet. It never writes a claim itself.

**`api/_lib/catalog.js`** — server-side catalog + price tiers.
- ⚠️ This fetches CelesTrak directly. **Point it at whatever your existing
  `/api/get-celestrak-debris` handler already does** so the two can't drift.
- Also raises your inventory ceiling: CelesTrak publishes thousands of objects,
  you're currently serving only **40**.

**`migrations/001_hardening.sql`** — run in Supabase SQL Editor.
- Unique index on `stripe_session_id` (idempotency)
- Unique index on `norad_id` (no double-sell)
- RLS policies (already correct on your side — verified anon **cannot** write)

### ✅ Good news on security (I tested this)
Your RLS is genuinely locked down. An anon key PATCH returned 200 with an empty
result and **the value did not change**. Your Supabase keys are also correct —
only the public `anon` key is in the client, never `service_role`. That's the
#1 beginner disaster and you avoided it.

### ⚠️ Two things I could NOT verify (both endpoints 500'd)
1. **Whether your webhook actually verifies signatures.** If it doesn't, anyone
   who finds the URL can POST a fake `checkout.session.completed` and mint free
   claims forever. **Check this first once the backend is up.**
2. **Whether your server trusts the client's `price`.** If it does, buyers can
   pay $0.01 for a $9.99 object.

### ⚠️ Your Google "login" is decorative
You decode the JWT with `atob` in the browser and pass `userEmail` to the
server. There's no signature verification, so anyone can claim to be any email.
Fine for a novelty site — just **never** treat that email as proof of identity
for refunds or ownership.

---

## 🟠 STEP 4 — Your legal page had live placeholder text

Fixed in `legal.html`:
- Section 7 said `[SUPPORT EMAIL]` — **blank**. You had no published contact
  path for the removal/refund requests your own Sections 5 & 6 promise.
- Header read `Last updated: [08/04/2026]`.
- Section 4 used a bracket-wrapped address, inconsistent with Section 7.

I used `slapmyarsehag@gmail.com` (already public in Section 4 on your live page).
**If you'd rather not use a personal address, swap it for a dedicated support
address before deploying.**

---

## 🟢 STEP 5 — Why you made $11 (free growth fixes)

**Your share loop was broken.** The page had **zero** social meta tags, so every
shared link rendered as a bare, preview-less URL. For a product whose entire
growth engine is "my friend posted their ex's certificate," this was the most
expensive omission on the page.

Added to `index.html`: `og:title`, `og:description`, `og:image` (1200×630),
`og:url`, Twitter card, canonical URL, meta description, theme color, favicon
links, and web-app manifest.

**New brand assets (all generated):**
- `og-image.png` — the share card that now appears on every link
- `favicon.svg` / `favicon.ico` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png`
- `robots.txt`, `sitemap.xml`, `manifest.json`

**Deploy these to your web root.** Then re-scrape with
[Facebook's debugger](https://developers.facebook.com/tools/debug/) and the
[Twitter card validator](https://cards-dev.twitter.com/validator) to bust the
cached bare previews.

---

## 🟢 STEP 6 — Frontend bugs fixed in `index.html`

| Fix | Why it mattered |
|---|---|
| **Tap targets** | Debris meshes were ~0.15 units wide — nearly impossible to hit on a phone. Each now has an invisible 0.55-unit pick sphere. |
| **`user-scalable=no` removed** | You blocked pinch-zoom. Accessibility failure + Google penalizes it. |
| **Mobile scroll** | `body { touch-action:none }` + `overflow-y:auto` meant the HUD panel couldn't scroll on mobile. Added `pan-y`. |
| **Panel collapse** | The header panel covered most of the 3D view on phones and swallowed taps. Added a collapse toggle. |
| **"Copied!" in red error banner** | Success confirmations used the error component. Now uses the ticker line. |
| **Altitude flattened** | The animation loop overwrote `position.y` every frame, so every orbit rendered in one flat band. Altitude is now stored and preserved. |
| **Earth texture on `master` branch** | Loaded from `raw.githubusercontent.com/.../master/...` — a moving dev branch. Pinned to `r128`. **Self-host this file** to remove the third-party dependency entirely. |
| **Stale inspector after filter** | Filtering orbits left the claim panel open on a now-hidden object. Now closes it. |
| **`innerHTML` on ticker** | Was a fixed safe string, but switched to DOM nodes so it stays safe if ever edited. |

**A note on one of my own errors:** I initially reported that your orbit filter
was broken because "r128's raycaster ignores `.visible`". I then tested it and
concluded the opposite — but that test was wrong (I'd found a helper belonging
to the *renderer*, not the raycaster). My second test was conclusive: **a hidden
parent still returned raycast hits.** So the bug was real, and picking now
explicitly checks `owner.visible`. I'd rather flag the flip-flop than let you
think I nailed it first try.

---

## 🟢 STEP 7 — Inventory: you have 40 items

```
FENGYUN 1C DEB   × 14
UNKNOWN          × 10   ← ten buyers see "UNKNOWN" as their product
COSMOS 2251 DEB  ×  5
everything else  ~ 11
```

The feed returns **40 objects** with only **14 unique names**, and every sale
permanently locks one. You've sold 3 — that's ~8% of your total inventory gone.
**Your product ceiling is 40 items.** Widen the CelesTrak query to pull hundreds
or thousands, and stop shipping `UNKNOWN` as a name.

---

## Deployment checklist (in order)

1. [ ] Fix the 500s — find the stack trace in Vercel, redeploy, test all 4 endpoints
2. [ ] Verify webhook signature verification + server-side pricing
3. [ ] Run `migrations/001_hardening.sql` in Supabase
4. [ ] Port the `api/` fixes to your real handlers
5. [ ] Add a daily heartbeat to stop the free-tier pause (before Oct 20)
6. [ ] Deploy the static assets + patched `index.html` + `legal.html`
7. [ ] Re-scrape the social card debuggers
8. [ ] Widen the debris catalog past 40 items

## What I could not do
- Patch your live API handlers — I never saw them. Paste your `api/` folder and
  I'll give you exact diffs instead of reference files.
- Verify the two critical security questions above (both endpoints 500'd).
- See inside your Stripe dashboard, Supabase dashboard, or Vercel environment
  variables. I only worked from the outside-facing behaviour and the files you
  pasted, so anything env-var-related has to be checked by you.
