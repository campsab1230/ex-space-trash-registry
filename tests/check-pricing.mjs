import fs from 'fs';

let failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// Resolve relative to this test file so it runs from any working directory.
const file = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const idx = file('../index.html');
const co  = file('../api/create-checkout.js');
const legal = file('../legal.html');

// --- extract constants from both files ---
const num = (src, re, label) => {
  const m = src.match(re);
  if (!m) { failures.push(`could not find ${label}`); return null; }
  return Number(m[1]);
};

const idxBase = num(idx, /const BASE_PRICE = ([\d.]+)/, 'index BASE_PRICE');
const coBase  = num(co,  /const BASE_PRICE = ([\d.]+)/, 'checkout BASE_PRICE');
const idxEmoji = num(idx, /const EMOJI_ADDON_PRICE = ([\d.]+)/, 'index EMOJI_ADDON_PRICE');
const coEmoji  = num(co,  /const EMOJI_ADDON_PRICE = ([\d.]+)/, 'checkout EMOJI_ADDON_PRICE');

const printed = (src, label) => {
  const m = src.match(/PRINTED_PRICES = \{([^}]*)\}/);
  if (!m) { failures.push(`no PRINTED_PRICES in ${label}`); return null; }
  const o = {};
  for (const part of m[1].split(',')) {
    const kv = part.split(':').map(s => s.trim());
    if (kv.length === 2) o[kv[0]] = Number(kv[1]);
  }
  return o;
};
const idxPrinted = printed(idx, 'index');
const coPrinted  = printed(co,  'checkout');

console.log('index   BASE_PRICE =', idxBase, ' PRINTED =', idxPrinted);
console.log('checkout BASE_PRICE =', coBase, ' PRINTED =', coPrinted);

// --- 1. constants agree across client and server ---
ok(idxBase === coBase, `BASE_PRICE mismatch: index=${idxBase} checkout=${coBase}`);
ok(idxEmoji === coEmoji, `EMOJI_ADDON_PRICE mismatch: ${idxEmoji} vs ${coEmoji}`);
ok(JSON.stringify(idxPrinted) === JSON.stringify(coPrinted),
   `PRINTED_PRICES mismatch: ${JSON.stringify(idxPrinted)} vs ${JSON.stringify(coPrinted)}`);

// --- 2. advertised price == what the server actually charges ---
// Server charges BASE_PRICE line + (tierTotal - BASE_PRICE) print line.
const serverTotal = (tier) => tier === 'none' ? coBase : coPrinted[tier];
for (const tier of ['domestic', 'international']) {
  ok(Math.abs(serverTotal(tier) - coPrinted[tier]) < 1e-9,
     `server total for ${tier} (${serverTotal(tier)}) != advertised (${coPrinted[tier]})`);
}
ok(Math.abs(serverTotal('none') - 7.99) < 1e-9, `digital total is ${serverTotal('none')}, expected 7.99`);

// --- 3. no stale price strings anywhere user-facing ---
// "User-facing" is the operative word: index.html legitimately DOCUMENTs the
// old "$1.99–$9.99" range in the comment explaining the JSON-LD fix, so testing
// the raw source reports a stale price that no visitor can ever see. Strip HTML
// comments first — a commented-out price is not an advertised price.
// (Same trap as tests/check-og-image.mjs.)
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');
const idxVisible = stripHtmlComments(idx);
const legalVisible = stripHtmlComments(legal);

const stalePatterns = [
  [/\$1\.99\s*[–-]\s*\$9\.99/, 'old $1.99–$9.99 range still advertised'],
  [/Certificate[s]? <strong>\$/i, 'old hero price line still present'],
  [/\$5\.00/, 'old $5.00 mailing fee still present'],
  [/\$18\.00/, 'old $18.00 mailing fee still present'],
];
for (const [re, msg] of stalePatterns) {
  ok(!re.test(idxVisible) && !re.test(legalVisible), `${msg} (index/legal)`);
}

// --- 4. the three numbers a cold visitor must see ---
for (const [needle, label] of [['$7.99','base price'], ['$19.99','domestic printed'], ['$29.99','international printed']]) {
  ok(idx.includes(needle), `hero/modal is missing ${label} (${needle})`);
}

// --- 5. server ignores a client-sent MOBILE/printed price (tamper guard) ---
ok(/Math\.abs\(numericPrice - BASE_PRICE\)/.test(co), 'server no longer rejects a non-base client price');
ok(/Math\.round\(BASE_PRICE \* 100\)/.test(co), 'server no longer derives the base line from its own constant');
ok(/printPortion/.test(co), 'print line no longer computed server-side');

// --- 6. the ReferenceError that would 500 every checkout ---
ok(!/MAIL_PRICES/.test(co), 'stale MAIL_PRICES reference reintroduced (ReferenceError on every checkout)');

// --- 7. margin sanity: international must not lose money ---
const intlTotal = coPrinted.international;
ok(intlTotal >= 24, `international bundle $${intlTotal} is below ~$19.40 postage + margin`);

if (failures.length) {
  console.error('\n❌ FAILURES:'); failures.forEach(f => console.error('  -', f));
  process.exit(1);
}
console.log('\n✅ all pricing assertions passed');
