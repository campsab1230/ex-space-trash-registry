import fs from 'fs';
import path from 'path';

// Guard the free sticker pack that ships with EVERY order.
//
// Why this needs a guard: a broken sticker pack is invisible. It is a free
// extra, so nobody emails about it, and /api/track silently 204s any event
// that is not on its allow-list. So if the button is renamed, or an asset is
// dropped during a refactor, or the tracking event is typo'd, the feature dies
// with no error anywhere — the buyer just sees nothing, or clicks a dead link.
//
// Four things must all hold, and losing any one restores that silent failure:
//   1. both PDF sheets and the PNG zip actually exist as real files
//   2. the success view links to exactly those paths (no drift, no 404s)
//   3. the site advertises an A4 sheet, not just US Letter — it sells
//      internationally ($29.99 tier), so a Letter-only pack is wrong for
//      a whole class of paying buyers
//   4. `sticker_pack_downloaded` is on the /api/track allow-list, or the
//      click is dropped server-side and the funnel silently undercounts

const root = p => new URL(p, import.meta.url);
const read = p => fs.readFileSync(root(p), 'utf8');
const exists = p => fs.existsSync(root(p));
const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL', msg); process.exitCode = 1; }
  else console.log('PASS', msg);
};

const app = read('../certificate-app.html');
const legal = read('../legal.html');
const track = read('../api/track.js');

const PDF_LETTER = '../assets/stickers/sticker-pack-letter.pdf';
const PDF_A4     = '../assets/stickers/sticker-pack-a4.pdf';
const PNG_ZIP    = '../assets/stickers/sticker-pack-png.zip';

// ---- 1. the assets are present and are real files, not 0-byte stubs ----
for (const [p, minBytes, label] of [
  [PDF_LETTER, 20000, 'US Letter PDF sheet'],
  [PDF_A4,     20000, 'A4 PDF sheet'],
  [PNG_ZIP,    20000, 'transparent PNG bundle'],
]) {
  const abs = root(p);
  if (!exists(p)) { ok(false, `${label} exists (${p})`); continue; }
  const size = fs.statSync(abs).size;
  ok(size > minBytes, `${label} exists and is non-trivial (${size.toLocaleString()} bytes)`);
  // magic bytes: catch an asset that got replaced by an HTML error page
  const head = fs.readFileSync(abs).subarray(0, 4).toString('latin1');
  if (p.endsWith('.pdf'))  ok(head.startsWith('%PDF'), `${label} is a real PDF (has %PDF header)`);
  if (p.endsWith('.zip'))  ok(head.startsWith('PK'),    `${label} is a real ZIP (has PK header)`);
}

// ---- 2. the success view links to exactly those paths ----
for (const [p, label] of [
  ['/assets/stickers/sticker-pack-letter.pdf', 'Letter PDF'],
  ['/assets/stickers/sticker-pack-a4.pdf',     'A4 PDF'],
  ['/assets/stickers/sticker-pack-png.zip',    'PNG zip'],
]) {
  ok(app.includes(p), `success view links the ${label} at ${p}`);
  ok(exists('../' + p.replace(/^\//, '')), `the linked ${label} path resolves to a real file`);
}

// every referenced sticker asset must exist on disk (guards a typo'd path)
const referenced = [...app.matchAll(/\/assets\/stickers\/[A-Za-z0-9._-]+/g)].map(m => m[0]);
ok(referenced.length >= 3, `success view references all three pack downloads (found ${referenced.length})`);
for (const r of new Set(referenced)) {
  ok(exists('../' + r.replace(/^\//, '')), `referenced asset exists: ${r}`);
}

// ---- 3. A4 is genuinely advertised, not just US Letter ----
ok(/sticker-pdf-a4-btn/.test(app), 'an A4 download control exists (international buyers are a paid tier)');
ok(/sticker-pdf-letter-btn/.test(app), 'a US Letter download control exists');
ok(/sticker-png-btn/.test(app), 'a transparent PNG download control exists');

// the pack must be offered at the success moment, not buried elsewhere
ok(/id="success-modal"[\s\S]*sticker-pack-block[\s\S]*id="sticker-pdf-letter-btn"/.test(app),
   'the sticker pack lives inside the post-purchase success modal');

// all tiers: confirm the pack is presented as included, i.e. NOT conditioned on
// the printed-mail tier. If it ever gets nested under the mail note, buyers who
// chose digital-only would lose it — that is a silent regression.
ok(!/success-mail-note[\s\S]{0,400}sticker-pdf-letter-btn/.test(app),
   'the sticker pack is NOT nested under the printed-mail-only note (digital tier keeps it)');

// ---- 4. the tracking event is allow-listed ----
ok(track.includes("'sticker_pack_downloaded'"),
   "api/track.js allow-lists sticker_pack_downloaded (or the click is dropped server-side)");
ok(app.includes("track('sticker_pack_downloaded'") || app.includes('track("sticker_pack_downloaded"'),
   'the client emits sticker_pack_downloaded');

// the allow-list entry must sit inside ALLOWED_EVENTS, not merely appear in a comment
const allowBlock = track.match(/const ALLOWED_EVENTS = new Set\(\[([\s\S]*?)\]\)/);
ok(!!allowBlock && allowBlock[1].includes("'sticker_pack_downloaded'"),
   'sticker_pack_downloaded is inside the ALLOWED_EVENTS set (not just mentioned in prose)');

// ---- 5. the legal page discloses it as a free, non-price-affecting digital bonus ----
ok(/sticker/i.test(legal), 'legal page mentions the sticker pack');
ok(/4b\.\s*The Sticker Pack/i.test(legal), 'legal page has a dedicated sticker-pack clause');
ok(/does not increase what you pay|doesn't increase what you pay/i.test(legal),
   'legal page states the pack does not change the price');
ok(/not a physical item we ship/i.test(legal),
   'legal page is explicit that the pack is digital, not shipped (avoiding a delivery expectation)');

// ---- 6. the pack must not be gated behind a token or DB check ----
// A freebie behind a gate buys no protection and adds a support surface.
ok(!/sticker[\s\S]{0,200}verify-session/i.test(app),
   'sticker download does not depend on payment verification (no needless gate)');

if (!process.exitCode) console.log('✅ sticker pack is present, advertised at all tiers, tracked, and disclosed');
