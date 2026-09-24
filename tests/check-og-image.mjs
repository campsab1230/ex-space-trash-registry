import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Guards the social-preview endpoint (api/og-image.js).
//
// The bug this exists for: the render tree was written as JSX inside a plain
// `.js` file. Vercel runs `api/*.js` with no build step, so nothing transpiles
// that JSX and EVERY request died with FUNCTION_INVOCATION_FAILED (500) before
// the handler body ran — no image for any input, not even the generic fallback.
// A syntax check catches that class of failure instantly and cheaply.
//
// This test is deliberately zero-dependency (no imports of @vercel/og or
// supabase) so it runs without `npm install`, matching the other guards.
// ---------------------------------------------------------------------------

let failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

const apiDir = new URL('../api/', import.meta.url);
const files = fs.readdirSync(apiDir).filter((f) => f.endsWith('.js'));

// --- 1. every API handler must PARSE as plain ES module ---------------------
// This is the assertion that would have caught the shipped bug.
ok(files.length > 0, 'no api/*.js files found');

for (const name of files) {
  const abs = new URL(name, apiDir).pathname;
  try {
    // `node --check` is the authoritative syntax gate: it rejects JSX outright.
    execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').split('\n').slice(0, 3).join(' ').trim();
    failures.push(`api/${name} does not parse as plain JS (JSX or bad syntax?): ${detail}`);
  }
}

// --- 2. the JSX must not come back ----------------------------------------
const ogPath = new URL('og-image.js', apiDir);
ok(fs.existsSync(ogPath), 'api/og-image.js is missing');
const og = fs.readFileSync(ogPath, 'utf8');

// Prose must not trip the code checks. This file's own header comment explains
// the old `claims` / `custom_name` bug, so a naive grep on the raw source reports
// a regression that isn't there. Strip COMMENTS only — string contents must
// stay, because the assertions below look for quoted identifiers such as
// from('global_registry'). The line-comment pattern leaves `https://` intact.
const ogCode = og
  .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (URLs survive)

// A JSX tag looks like `<div`, `<div>`, `</div>`, or a fragment `<>`.
// HTML inside a template literal (as wall.js legitimately does) is fine, which
// is why the real gate is the parse check above — these are belt-and-braces.
const jsxTag = /(^|[\s(=,:?])(<\/?[A-Za-z][A-Za-z0-9.]*(\s|>|\/)|<>)/;
ok(!jsxTag.test(ogCode), 'api/og-image.js appears to contain JSX again — use the el() helper');
ok(!/from\s+['"]react['"]/.test(ogCode), 'api/og-image.js imports react; @vercel/og renders from plain objects');
ok(/function el\(/.test(og), 'api/og-image.js lost its el() element helper');
ok(/ImageResponse/.test(og), 'api/og-image.js no longer uses ImageResponse');

// --- 3. the data contract that was fixed once already ---------------------
// The original bug: it read a nonexistent `claims` table / `custom_name`.
// Golden rule: if you edit this query, keep it pointed at real columns.
ok(/from\(['"]global_registry['"]\)/.test(ogCode),
   'api/og-image.js no longer reads the global_registry table');
ok(/dedication_name/.test(ogCode),
   'api/og-image.js no longer selects dedication_name');
ok(!/from\(['"]claims['"]\)/.test(ogCode), 'api/og-image.js regressed to the nonexistent "claims" table');
ok(!/custom_name/.test(ogCode), 'api/og-image.js regressed to the nonexistent "custom_name" column');

// --- 4. the card must actually say something ------------------------------
for (const str of ['EXSPACETRASH.COM', 'NORAD OBJECT #', 'space junk']) {
  ok(og.includes(str), `og-image card lost its "${str}" line`);
}

// --- 5. caching must distinguish a real claim from the fallback -----------
// A fallback card that gets cached for a year pins a blank preview on an
// object forever, so this distinction is load-bearing, not cosmetic.
ok(/max-age=31536000/.test(ogCode), 'og-image lost the immutable cache for real claims');
ok(/max-age=300/.test(ogCode), 'og-image lost the short cache for fallback cards');
ok(/found\s*\?/.test(ogCode), 'og-image no longer branches its cache on whether a claim was found');

// --- 6. the fallback must survive a broken database ----------------------
// A bad id / missing id / unreachable DB must still render the generic card.
ok(/let name = 'SPACE TRASH'/.test(ogCode), 'og-image lost its generic fallback name');
ok(/catch \(lookupErr\)/.test(ogCode), 'og-image no longer survives a failed database lookup');

// --- 7. the STATIC card must never carry a price ---------------------------
// This is the guard gap that let the last bug ship. Section 1-6 watch the
// DYNAMIC per-claim endpoint; the card X/Twitter actually unfurls for a plain
// link to exspacetrash.com is the STATIC og-image.png, and nothing looked at
// it. Its orphaned SVG source hard-coded "Permanently. For $1.99." — when the
// price changed, the source didn't, and a stale price sat in every timeline
// preview. The card is cold-traffic surface: it must carry NO price at all.
const root = new URL('../', import.meta.url);

const copyPath = new URL('tools/og-image-copy.json', root);
ok(fs.existsSync(copyPath), 'tools/og-image-copy.json is missing (the card copy source of truth)');

let copy = {};
if (fs.existsSync(copyPath)) {
  const raw = fs.readFileSync(copyPath, 'utf8');
  try {
    copy = JSON.parse(raw);
  } catch (err) {
    failures.push(`tools/og-image-copy.json is not valid JSON: ${err.message}`);
  }
  // The whole point. No currency symbol, no price-shaped token.
  ok(!/[$£€]/.test(raw), 'og-image copy contains a currency symbol — the card is a shop window, not a shelf');
  ok(!/\d+\.\d{2}\b/.test(raw.replace(/"(_comment|_note)"\s*:\s*"[^"]*"/g, '')),
     'og-image copy contains a price-shaped number (e.g. 7.99)');
}

// The strings the renderer bakes in, mirrored here so renderer and guard agree.
for (const key of ['brand', 'headline', 'subline']) {
  ok(typeof copy[key] === 'string' && copy[key].length > 0,
     `og-image copy is missing its "${key}" line`);
}

// --- 8. the rendered card exists, is a real PNG, and is the right shape ----
const pngPath = new URL('og-image.png', root);
ok(fs.existsSync(pngPath), 'og-image.png is missing — run: python3 tools/build-og-image.py');

let pngSize = [0, 0];
if (fs.existsSync(pngPath)) {
  const buf = fs.readFileSync(pngPath);
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  ok(isPng, 'og-image.png is not a PNG (stale or truncated file?)');
  if (isPng) {
    // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
    pngSize = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    ok(pngSize[0] === 1200 && pngSize[1] === 630,
       `og-image.png is ${pngSize[0]}x${pngSize[1]}, expected 1200x630 (X's large-card ratio)`);
    // A card that is suspiciously small means the artwork silently failed to
    // draw (the assets are hundreds of KB); one that is huge punishes crawlers.
    const kb = buf.length / 1024;
    ok(kb > 80 && kb < 900, `og-image.png is ${kb.toFixed(0)} KB — outside the sane range (assets may not have rendered)`);
  }
}

// --- 9. the renderer must exist and stay price-free ------------------------
const genPath = new URL('tools/build-og-image.py', root);
ok(fs.existsSync(genPath), 'the og-image generator is missing — the card must be reproducible from the repo');

// Strip the Python docstring and # comments so this file's own prose about the
// old bug (which quotes the stale price) cannot trip the check below. Only
// executable code matters here.
const stripPy = (src) =>
  src.replace(/^\s*#!.*$/m, ' ')
     .replace(/"""[\s\S]*?"""/g, ' ')
     .replace(/'''[\s\S]*?'''/g, ' ')
     .replace(/(^|[^:])(#[^\n]*)/g, '$1');

if (fs.existsSync(genPath)) {
  const genCode = stripPy(fs.readFileSync(genPath, 'utf8'));
  ok(!/[$£€]\s*\d/.test(genCode), 'the og-image generator hard-codes a price');
  ok(/og-image-copy\.json/.test(genCode), 'the generator no longer reads tools/og-image-copy.json');
}

// --- 10. the dead SVG source must stay dead -------------------------------
// It was the actual carrier of the stale price, and nothing rendered it. A
// second, unrendered source of the same card is how this drifted apart the
// first time.
const svgPath = new URL('og-image.svg', root);
ok(!fs.existsSync(svgPath),
   'og-image.svg is back — it is an orphaned second source of the same card; the generator is the single source');

// --- 11. the retired card must not reappear in the card's own sources ------
// Scope note: this deliberately inspects ONLY the files that produce the
// static card. The app page legitimately prices things (the $1.99 emoji
// add-on, the tier select) and legitimately shows "DEBRIS ENGAGED" as a live
// status heading — those are not regressions, and check-pricing.mjs owns the
// homepage/decision-surface policy. Scanning them here produced three
// false positives on the first run of this guard, which is exactly why the
// scope is narrow.
const CARD_SOURCES = [
  // [path, strip-comments?]
  ['tools/og-image-copy.json', false],
  ['tools/build-og-image.py', true],
];

for (const [needle, why] of [
  ['$1.99', 'the old stale price'],
  ['Permanently. For', 'the old price sentence'],
  ['DEBRIS ENGAGED', 'the retired registry-aesthetic card'],
  ['SEASHELL', 'the retired placeholder certificate name'],
  ['for all eternity', 'the retired registry-aesthetic card line'],
]) {
  const hits = [];
  for (const [rel, strip] of CARD_SOURCES) {
    const p = new URL(rel, root);
    if (!fs.existsSync(p)) continue;
    let body = fs.readFileSync(p, 'utf8');
    if (strip) body = stripPy(body);
    if (body.includes(needle)) hits.push(rel);
  }
  ok(hits.length === 0, `${why} ("${needle}") is back in the card source: ${hits.join(', ')}`);
}

// --- report --------------------------------------------------------------
if (failures.length) {
  console.error('❌ og-image guard failed:');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('✅ og-image handler is JSX-free, parses cleanly, and keeps its data + cache contract');
console.log('✅ static social card is price-free, correctly sized, and reproducible from the repo');
