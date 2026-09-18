# ExSpaceTrash — Feature Roadmap

Written 2026-09-18, after the share-loop fix. Ordered by **expected revenue impact
per hour of work**, not by how interesting the feature is.

Context for the prioritisation: the site had made **$11** from three sales
(yourself, your mum, one friend) in about a month. That is not a pricing problem
and not a design problem — it is almost certainly a **traffic + trust problem**.
So the top of this list is deliberately unglamorous.

---

## Tier 0 — Already built in this pass

| Feature | Why it mattered |
| --- | --- |
| Share loop fixed | `og-image.js` + `trash-page.js` queried a `claims` table with `custom_name` — neither exists. Every shared link was a dead preview, so shares got zero clicks. |
| `/wall` registry page | Previously a claim appeared only as a 6-second ticker line. Cold visitors saw no evidence anyone had ever bought anything, and search engines had no page to index. |
| Dynamic `/sitemap.xml` | Only `/` and `/legal.html` were advertised. Every claim page is now indexable, and so is `/wall`. |
| `/api/track` analytics | You had **no** way to see where people drop off. Four events now cover the funnel. |
| Two certificate designs + live preview | You can now see your ex's name on the artwork **before** paying. This is the single biggest conversion lever in the purchase modal. |
| Template choice threaded end-to-end | Survives checkout → Stripe metadata → webhook → re-download, and degrades safely if the DB column is not there yet. |
| Share/copy-link bug fixed | X and WhatsApp received only the caption, with no clickable link. Copy-link copied a caption you couldn't click. Both now include a real `/trash/:noradId` URL. |
| `og-image` caching bug | The generic fallback card was cached `immutable` for a year — a link shared moments before a claim landed would show a blank card permanently. |

---

## Tier 1 — Do these next (highest impact, low effort)

### 1. A free "preview your certificate" entry point
**Problem**: the only way to see a certificate is to buy one. Cold visitors have
nothing to play with, so they bounce.
**Fix**: the live preview already exists in the purchase modal. Surface a
standalone "try it — see your ex's name on real space junk, free" path that
renders the certificate with a discreet watermark. Watermarked is fine; the
point is to let people experience the product before paying.
**Why it ranks first**: it converts curiosity into engagement, and a
watermarked certificate is itself a shareable ad.

### 2. Social proof on the landing screen
**Problem**: `/wall` exists, but the homepage still shows nothing but a ticker.
**Fix**: replace the ticker line with a small, always-visible counter —
*"N pieces of space trash currently named after someone's ex"* — linking to
`/wall`. With only a handful of claims this needs careful wording, but a real
number is far more convincing than an animation.
**Note**: with very low counts, honesty beats inflation. Never invent claims.

### 3. Chargeback / lost-purchase audit
**Problem**: `verify-session` was 500-ing for a period. Anyone who paid during
that window may have received a claim but **no certificate**, or nothing at all.
**Fix**: list every Stripe payment and confirm each has a matching
`global_registry.stripe_session_id`. Refund or honour any that don't.
**Why it's urgent**: an unfulfilled paid order is the fastest route to a
chargeback, and chargebacks can cost you your Stripe account.

### 4. Keep Supabase awake
**Problem**: the free tier pauses after ~7 days idle, and the project is
scheduled for removal in October unless upgraded.
**Fix (cheap)**: a daily scheduled request that touches the database. Since
Vercel cron needs a paid plan, use any external free pinger, or a GitHub Action
that curls a tiny endpoint once a day.
**Fix (proper)**: upgrade the Supabase plan. For a site taking real money, a
database that can silently disappear is the single largest business risk you
have.

---

## Tier 2 — Worth building once Tier 1 is done

### 5. "Claimed by" map / gallery of recent claims
The registry wall lists claims. A "recently claimed in the last 24h" strip on the
homepage gives returning visitors a reason to look again.

### 6. Gift mode (send to a friend)
*"Pay $5.99 and we'll email the certificate to your ex for you."* Turns a
private joke into a delivered surprise — and the delivery email is a built-in
viral loop. Needs an email provider (Resend has a usable free tier).

### 7. Certificate personalisation extras
- Upload a photo of the ex to appear on the certificate (needs R2/S3 storage).
- Choice of fonts / colours.
- A "burn after reading" video version.
Monetise as paid add-ons; the emoji add-on already proves this pattern works.

### 8. Real orbital data on the certificate
Attach the object's live TLE / altitude / orbit type from CelesTrak to each
certificate, so it reads as a genuine document rather than a joke.

### 9. Order lookup / re-download
*"Lost your certificate? Enter the email you used."* Turns one-off purchases into
a small accountless account, and gives people a reason to come back and share.

### 10. A referral code
Give the buyer a code; if a friend uses it, both get a discount. This is the
cheapest paid-adjacent growth loop and it needs no ad spend.

---

## Tier 3 — Marketing (explicitly deferred at your request)

Not started on purpose. When you pick this up, the order that tends to work for
a novelty product:

1. **Short-form video of the 3D scene + certificate reveal.** This product is
   visual; the scene sells itself in three seconds.
2. **Post the funniest genuine dedication names** — to `/wall` and to socials.
   Guaranteed-novelty content is the natural hook.
3. **Seasonal angle** — Valentine's, Mother's Day (the joke lands differently),
   and post-breakup spikes in January and early September.
4. **Get the free-preview path (Tier 1 #1) in place first**, or paid traffic
   will just bounce off a page with nothing to do.

---

## Deliberately NOT recommended

- **More 3D polish.** The scene is already the best part of the site.
- **Discounts.** At $1.99 the price is not the objection; traffic is.
- **Ad spend before the free-preview path exists.** You would be buying
  expensive bounces.
- **A customer accounts system.** Order lookup by email (Tier 2 #9) gives 90% of
  the benefit for a fraction of the work.

---

## Dependency notes

- Tier 1 #1 and Tier 2 #7 both need somewhere to put the free/watermarked
  render. Client-side rendering already covers the free-preview case; only photo
  uploads need real object storage.
- Tier 2 #6 needs an email provider and a verified sending domain.
- Tier 2 #8 depends on CelesTrak remaining available and free — it is not an SLA,
  so cache whatever you fetch.
