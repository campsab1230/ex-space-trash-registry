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

// --- report --------------------------------------------------------------
if (failures.length) {
  console.error('❌ og-image guard failed:');
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
console.log('✅ og-image handler is JSX-free, parses cleanly, and keeps its data + cache contract');
