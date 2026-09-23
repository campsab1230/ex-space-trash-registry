import fs from 'fs';

// ---------------------------------------------------------------------------
// Guards search-engine discovery: the sitemap and the structured data.
//
// Two real bugs this exists for:
//
//  1. A static `sitemap.xml` at the repo root SHADOWED the Vercel rewrite
//     `/sitemap.xml -> /api/sitemap`. Vercel resolves the filesystem BEFORE
//     rewrites, so the dynamic function never ran in production and the site
//     served a 2-URL static file forever. The tell was the cache header:
//     the function sets `max-age=600`, but production returned `max-age=0,
//     must-revalidate` (Vercel's static default). Any static file whose path
//     collides with a rewrite in vercel.json silently wins.
//
//  2. There was no Product/Offer JSON-LD at all, so Google had no
//     machine-readable price and inferred one from prose — which is how a
//     stale "$1.99–$9.99" range ended up in the search snippet.
//
// Zero-dependency, so it runs without `npm install` like the other guards.
// ---------------------------------------------------------------------------

let failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

const file = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const exists = (rel) => fs.existsSync(new URL(rel, import.meta.url));
const idx = file('../certificate-app.html');
const home = file('../index.html');
const vercel = JSON.parse(file('../vercel.json'));

// --- 1. no static file may shadow a rewrite ---------------------------------
// The rewrite destination is an /api/* function; a real file at the same path
// as the rewrite SOURCE wins, so the function becomes dead code.
const rewrites = vercel.rewrites || [];
ok(rewrites.length > 0, 'vercel.json has no rewrites');

for (const r of rewrites) {
  const src = String(r.source || '').replace(/^\//, '');
  // Skip parameterised sources like /trash/:slug — they cannot collide with a
  // single concrete filename.
  if (src.includes(':')) continue;
  const shadow = new URL('../' + src, import.meta.url);
  ok(
    !fs.existsSync(shadow),
    `static file "${src}" shadows the rewrite to ${r.destination} — Vercel serves ` +
    `the file and the function never runs (delete the static file)`
  );
}

// Specifically: the sitemap must be dynamic.
ok(!exists('../sitemap.xml'),
   'a static sitemap.xml is back — it shadows the /sitemap.xml rewrite');
ok(exists('../api/sitemap.js'), 'api/sitemap.js is missing');
ok(rewrites.some((r) => r.source === '/sitemap.xml' && r.destination === '/api/sitemap'),
   'the /sitemap.xml -> /api/sitemap rewrite is gone');

// --- 2. the sitemap function must list claim pages, not just static ones ---
const sm = file('../api/sitemap.js');
ok(/from\('global_registry'\)/.test(sm), 'sitemap no longer reads global_registry');
ok(/norad_id/.test(sm), 'sitemap no longer selects norad_id (claim pages would vanish)');
ok(/lastmod/.test(sm), 'sitemap lost its lastmod output');
ok(/\/trash\//.test(sm), 'sitemap no longer emits /trash/ claim URLs');
ok(/application\/xml/.test(sm), 'sitemap lost its XML content-type');
// A swallowed error must not silently degrade to a 2-URL file again. The catch
// is intentional (a DB hiccup must not 500 the sitemap), but it must LOG.
ok(/console\.error/.test(sm), 'sitemap swallows registry errors without logging them');
ok(/max-age=600/.test(sm), 'sitemap lost its cache header (the tell for shadowing)');

// --- 3. structured data must exist and be valid JSON -----------------------
const ldMatch = home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
ok(!!ldMatch, 'certificate-app.html has no application/ld+json structured data block');

let ld = null;
if (ldMatch) {
  try {
    ld = JSON.parse(ldMatch[1]);
  } catch (e) {
    failures.push(`the JSON-LD block is not valid JSON: ${e.message}`);
  }
}

if (ld) {
  ok(ld['@context'] === 'https://schema.org', 'JSON-LD @context is not schema.org');
  ok(ld['@type'] === 'Product', `JSON-LD @type is "${ld['@type']}", expected "Product"`);
  ok(!!ld.name, 'JSON-LD is missing a name');
  ok(!!ld.description, 'JSON-LD is missing a description');
  ok(!!ld.image, 'JSON-LD is missing an image (no rich result without it)');

  const offers = ld.offers || {};
  ok(offers['@type'] === 'AggregateOffer',
     `JSON-LD offers @type is "${offers['@type']}", expected "AggregateOffer"`);
  ok(offers.priceCurrency === 'USD', 'JSON-LD offers are not priced in USD');

  const list = Array.isArray(offers.offers) ? offers.offers : [];
  ok(list.length === 3, `JSON-LD should carry 3 offers (digital + 2 printed), found ${list.length}`);
  ok(Number(offers.offerCount) === list.length,
     `offerCount (${offers.offerCount}) disagrees with the offers array (${list.length})`);

  // --- 4. every advertised price must match the code that takes the money ---
  const idxBase = Number((idx.match(/const BASE_PRICE = ([\d.]+)/) || [])[1]);
  const idxEmoji = Number((idx.match(/const EMOJI_ADDON_PRICE = ([\d.]+)/) || [])[1]);
  ok(Number.isFinite(idxBase), 'could not read BASE_PRICE from certificate-app.html');
  ok(Number.isFinite(idxEmoji), 'could not read EMOJI_ADDON_PRICE from certificate-app.html');

  const prices = list.map((o) => Number(o.price)).filter(Number.isFinite);
  ok(prices.length === list.length, 'a JSON-LD offer has a non-numeric price');

  // NOW THE POINT OF ALL THIS: the old snippet advertised "from $1.99" because
  // the $1.99 emoji add-on was treated as a buyable entry price. It is an
  // add-on — it cannot be bought alone — so it must never appear as an offer.
  ok(!prices.includes(idxEmoji),
     `the $${idxEmoji} emoji add-on is listed as an offer; it cannot be bought on its own ` +
     `and is what produced the misleading "from $1.99" search snippet`);

  ok(Number(offers.lowPrice) === Math.min(...prices),
     `lowPrice (${offers.lowPrice}) != cheapest offer (${Math.min(...prices)})`);
  ok(Number(offers.highPrice) === Math.max(...prices),
     `highPrice (${offers.highPrice}) != dearest offer (${Math.max(...prices)})`);
  ok(Number(offers.lowPrice) === idxBase,
     `lowPrice (${offers.lowPrice}) != BASE_PRICE in the page (${idxBase})`);

  const cur = (list[0] || {}).priceCurrency;
  ok(list.every((o) => o.priceCurrency === 'USD'),
     `every nested offer must declare priceCurrency USD (found ${cur})`);
  ok(list.every((o) => String(o.availability || '').includes('InStock')),
     'an offer is missing availability InStock');
}

// --- 5. Search Console hook (comment is fine; a broken tag is not) ---------
// We do not require the tag (DNS verification is the recommended route here),
// but if someone uncomments it, it must not ship with the placeholder token.
// Strip HTML comments first: the tag ships COMMENTED OUT (DNS verification is
// the recommended route here, and it needs no code change). Testing the raw
// source matches that commented example and reports a placeholder that is not
// actually live. Only a real, uncommented tag is worth checking.
const idxLive = home.replace(/<!--[\s\S]*?-->/g, ' ');
const gm = idxLive.match(/<meta name="google-site-verification" content="([^"]*)">/);
if (gm) {
  ok(!/PASTE_YOUR_TOKEN_HERE/i.test(gm[1]),
     'the google-site-verification tag still holds the placeholder token');
}

if (failures.length) {
  console.error('❌ discovery guard failed:');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('✅ sitemap is unshadowed + emits claims, and the Product JSON-LD prices match the checkout');
