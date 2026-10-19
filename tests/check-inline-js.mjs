import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// Guard the INLINE JAVASCRIPT inside the HTML pages.
//
// Why this is needed: certificate-app.html carries ~66 KB of inline <script>
// — the entire client app: the 3D scene, the checkout handoff, the success
// reveal. Nothing in this suite parses it. Every other guard reads the file as
// TEXT and greps it, so a syntax error is invisible to all of them, and the
// two places it could surface are both bad:
//
//   * Vercel has no build step and never runs `npm test`, so a broken script
//     deploys straight to production.
//   * The failure is silent in the worst way: the browser throws at parse time
//     and NOTHING runs. The page renders, the buttons are inert, and the only
//     sign is a console error no one is watching.
//
// A real example of this class, from this project's own history: an edit that
// referenced an undefined function. It parsed fine and only failed at click
// time. That specific bug is a runtime error this guard cannot see — but a
// stray brace, an unclosed template literal, or a botched merge is caught here
// before it ships.
//
// Note on `type="application/ld+json"`: the pages also contain JSON-LD script
// blocks. Those are JSON, not JavaScript, and `node --check` rejects them
// outright (it reported `Unexpected token ':'` on a perfectly valid block).
// So they must be excluded, and the non-vacuity assertion below is what keeps
// that exclusion honest — without it, a regex that matched nothing at all
// would "pass" this guard while checking absolutely nothing.

const root = p => new URL(p, import.meta.url);
const read = p => fs.readFileSync(root(p), 'utf8');
const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL', msg); process.exitCode = 1; }
  else console.log('PASS', msg);
};

const PAGES = [
  ['../certificate-app.html', 'certificate app'],
  ['../index.html', 'homepage'],
  ['../legal.html', 'legal page'],
];

// Inline JS only: no src= include, and not a JSON-LD data block.
const INLINE_JS = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
const JSONLD = /<script[^>]*application\/ld\+json[^>]*>/gi;

let totalBlocks = 0;
let appBlocks = 0;

for (const [rel, label] of PAGES) {
  const html = read(rel);
  const blocks = [...html.matchAll(INLINE_JS)].map(m => m[1]);
  totalBlocks += blocks.length;
  if (rel.includes('certificate-app')) appBlocks = blocks.length;

  if (!blocks.length) {
    console.log(`PASS ${label}: no inline JS to check`);
    continue;
  }

  // Join with a statement separator so a block ending in a comment cannot
  // swallow the start of the next one and invent a fake syntax error.
  const src = blocks.join('\n;\n');
  const tmp = path.join(os.tmpdir(), `inline-${path.basename(rel)}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
    ok(true, `${label}: ${blocks.length} inline JS block(s), ${src.length} bytes — parses clean`);
  } catch (err) {
    const detail = (err.stderr || '').toString().split('\n').slice(0, 6).join('\n');
    ok(false, `${label}: inline JS FAILED to parse\n${detail}`);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Non-vacuity. If the regex silently stopped matching (a refactor renames the
// tag, the file moves, the JSON-LD filter over-matches), every page above would
// report "no inline JS to check" and this guard would pass while checking
// nothing. That is the same trap the contracts guard documents.
ok(totalBlocks > 0, `found inline JS to check at all (${totalBlocks} block(s) total)`);
ok(appBlocks > 0, `the certificate app's inline JS is actually covered (${appBlocks} block(s))`);

// The JSON-LD blocks must still BE there — this guard's exclusion must not
// quietly become "we deleted the structured data".
const app = read('../certificate-app.html');
const ld = (app.match(JSONLD) || []).length;
ok(ld > 0, `certificate app still carries its JSON-LD block(s) (${ld}) — excluded from the check, not removed`);

console.log('✅ inline JavaScript parses on every page (and the guard is not vacuous)');
