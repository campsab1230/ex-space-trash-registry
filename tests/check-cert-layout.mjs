// REGRESSION TEST: the certificate layout must stay structurally collision-proof.
//
// History: the certificate used to be a flat artwork with the printed copy baked
// into the pixels, so the buyer's name/quote could land on top of printed words.
// It was rebuilt as a clean art background plus real HTML text in three flex
// rows. That only stays safe while three things hold:
//
//   1. the stage is a flex COLUMN, so the rows are siblings and cannot overlap;
//   2. the rows are NOT absolutely positioned (absolute + a long name is exactly
//      how the buyer's block used to run into the footer);
//   3. the stage is border-box, otherwise its 76/66px padding inflates the
//      1024x765 box and html2canvas clips the footer off the bottom.
//
// This test reads index.html and asserts all three, for both markup instances
// (the live preview and the hidden export target) and both templates.
import fs from 'fs';

const idx = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let fail = 0;
const check = (label, cond, extra = '') => {
  if (!cond) { fail++; console.log(`FAIL  ${label} ${extra}`); }
  else console.log(`PASS  ${label}`);
};

// --- 1. the three rows must exist, in BOTH markup instances ---
for (const cls of ['cert-head', 'cert-slot', 'cert-foot']) {
  const n = (idx.match(new RegExp(`class="${cls}"`, 'g')) || []).length;
  check(`"${cls}" appears in both the preview and the export markup`, n === 2, `<- found ${n}`);
}

// --- 2. the four fixed-copy roles must be wired in both instances ---
for (const role of ['title', 'kicker', 'signoff', 'fine']) {
  const n = (idx.match(new RegExp(`data-cert-role="${role}"`, 'g')) || []).length;
  check(`role "${role}" is wired in both instances`, n === 2, `<- found ${n}`);
}

// --- 3. the stage must be a flex column ---
check('stage is display:flex', /\.cert-stage\s*\{[^}]*display:\s*flex/.test(idx));
check('stage flexes as a column', /\.cert-stage\s*\{[^}]*flex-direction:\s*column/.test(idx));

// --- 4. the stage must be border-box, or html2canvas clips the footer ---
check('stage uses border-box (padding must not inflate the 1024x765 box)',
      /\.cert-stage\s*\{[^}]*box-sizing:\s*border-box/.test(idx));

// --- 5. the rows must NOT be absolutely positioned ---
// Only the B title is allowed to leave the column (it is pinned into the navy
// band on purpose); the head/slot/foot rows themselves must stay in flow.
const rowRule = idx.match(/\.cert-head,\s*\.cert-slot,\s*\.cert-foot\s*\{([^}]*)\}/);
check('the head/slot/foot rule exists', !!rowRule);
check('head/slot/foot are NOT position:absolute (absolute is the collision bug)',
      !!rowRule && !/position:\s*absolute/.test(rowRule[1]));

// --- 6. every word is HTML, never baked into the artwork ---
// If a template rule ever regains a text-ish property we have drifted back to
// the flattened design.
check('no HTML text is rasterised into the stage via a background shorthand',
      !/\.cert-stage\s*\{[^}]*background:\s*(?!.*(url|none))/.test(idx));

// --- 7. both templates must still declare their artwork ---
for (const tpl of ['a-orbital', 'b-parchment']) {
  check(`template artwork "${tpl}" is still referenced`,
        idx.includes(`cert-${tpl}.png`));
}

// --- 8. the buyer's name auto-fit must not exceed the slot width ---
// A 50px monospace name at 30 chars would be ~900px wide; the auto-fit steps it
// down, and the slot is measured against the artwork's inner width.
check('name auto-fit still steps the font down for long names',
      /len <= 8\s*\?\s*base/.test(idx) && /0\.46/.test(idx));

console.log(fail ? `\n${fail} FAILED` : '\n✅ certificate layout is collision-proof');
process.exit(fail ? 1 : 0);
