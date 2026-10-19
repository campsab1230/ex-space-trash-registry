import fs from 'fs';

// Guard the PAID breakup-survival manual ($4.99 add-on).
//
// This is the SECOND paid add-on, and it duplicates the coloring packet's
// failure modes rather than inventing new ones — which is exactly why it needs
// its own guard instead of a shared one. The two products are gated by two
// separate endpoints, two separate metadata flags and two separate DOM blocks.
// A single shared guard would let a change to one product's wiring satisfy the
// test while quietly breaking the other's.
//
// The failure modes, none of which throw:
//
//   * Success screen forgets to reveal the download -> a buyer pays $4.99 and
//     receives nothing. Money moves, no error is raised, the page looks normal.
//   * Block visible by default -> every $2.99 buyer gets a $4.99 book free,
//     invisibly.
//   * Client hardcodes the PDF path -> the payment gate is decorative, because
//     the URL is sitting in the page source.
//   * Price drifts between client and server -> the button advertises one
//     number and Stripe charges another.
//   * `manualAddon` returned as a real boolean instead of the string 'true' ->
//     the client's === 'true' check is silently false and the buyer gets
//     nothing. This bug class shipped once already with certificateTemplate.
//   * Track event not allow-listed -> /api/track silently 204s it and the
//     funnel undercounts the one number that says whether it sold.
//   * MANUAL_FILES filename not updated after a rebuild -> the paid download
//     404s for every buyer, because the PDFs are content-hash named.
//
// The last one is specific to this product's build: the PDFs are named by
// content hash, so regenerating them changes the filename. The guard reads the
// real filename out of the endpoint AND checks the file is actually there, so a
// mismatch fails here rather than at the buyer's expense.

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
const co = read('../api/create-checkout.js');
const vs = read('../api/verify-session.js');
const dl = read('../api/manual-download.js');

// ---- 1. the endpoint's allow-list points at files that actually exist ----
// Read the real paths OUT of the endpoint rather than hardcoding them here:
// hardcoding would make this guard pass against a stale filename, which is the
// precise failure it exists to catch.
const listed = [...dl.matchAll(/'(\/assets\/manual\/[^']+)'/g)].map(m => m[1]);
ok(listed.length === 2, `manual-download.js lists exactly 2 files (got ${listed.length})`);
for (const web of listed) {
  const rel = '..' + web; // '/assets/...' -> '../assets/...'
  ok(exists(rel), `allow-listed file exists on disk: ${web}`);
  if (exists(rel)) {
    const buf = fs.readFileSync(root(rel));
    ok(buf.length > 200000, `${web} is substantial (${buf.length} bytes)`);
    ok(buf.subarray(0, 5).toString('latin1') === '%PDF-', `${web} has a real %PDF- header`);
  }
}
ok(listed.some(p => /letter/.test(p)), 'allow-list has a US Letter edition');
ok(listed.some(p => /a4/.test(p)), 'allow-list has an A4 edition');
// Content-hash naming: a bare 'breakup-manual-letter.pdf' would mean a rebuild
// silently overwrote the file the endpoint still points at.
ok(listed.every(p => /\.v[0-9a-f]{10,}\.pdf$/.test(p)),
   'both editions are content-hash named (a rebuild cannot silently alias them)');

// ---- 2. the price is 4.99 on BOTH sides ----
const coPrice = (co.match(/const MANUAL_ADDON_PRICE = ([\d.]+);/) || [])[1];
const appPrice = (app.match(/const MANUAL_ADDON_PRICE = ([\d.]+);/) || [])[1];
ok(coPrice === '4.99', `server MANUAL_ADDON_PRICE is 4.99 (got ${coPrice})`);
ok(appPrice === '4.99', `client MANUAL_ADDON_PRICE is 4.99 (got ${appPrice})`);
ok(coPrice === appPrice, 'client and server manual prices agree');

// The add-on must actually be charged: a line item, not just a metadata flag.
ok(/if \(wantsManualAddon\) \{[\s\S]{0,500}?unit_amount: Math\.round\(MANUAL_ADDON_PRICE \* 100\)/.test(co),
   'create-checkout pushes a Stripe line item for the manual add-on');

// `wantsManualAddon` must be DECLARED. It was referenced-but-undeclared once,
// which is a ReferenceError at request time: it 500s checkout for EVERY
// customer, not just manual buyers. node --check does not catch this, because
// it is a scope error rather than a syntax error.
ok(/const wantsManualAddon = manualAddon === true;/.test(co),
   'wantsManualAddon is declared (undeclared would 500 checkout for everyone)');
ok((co.match(/wantsManualAddon/g) || []).length >= 3,
   'wantsManualAddon is declared AND used (guard is not vacuous)');

// ---- 3. the gate: the client must NOT know where the file lives ----
ok(!/breakup-manual-(letter|a4)\.v[0-9a-f]+\.pdf/.test(app),
   'client does NOT hardcode either manual PDF path (gate is real)');
ok(/api\/manual-download\?session_id=/.test(app),
   'client downloads via the gated /api/manual-download endpoint');

// ---- 4. the endpoint verifies BOTH payment and that the add-on was bought ----
ok(/payment_status !== 'paid'/.test(dl), 'download endpoint refuses unpaid sessions');
ok(/metadata\?\.manualAddon !== 'true'/.test(dl),
   'download endpoint refuses sessions that did not buy the add-on');
ok(/const MANUAL_FILES = \{/.test(dl), 'download endpoint uses an allow-list of formats');
ok(!/path\.join|\.\.\//.test(dl), 'download endpoint cannot be walked to another file');
// The two products must not share a gate: one flag controlling both would let a
// $3.99 buyer collect the $4.99 book.
ok(!/coloringAddon/.test(dl), 'the manual gate does NOT also accept the coloring flag');
ok(!/manualAddon/.test(read('../api/coloring-download.js')),
   'the coloring gate does NOT also accept the manual flag');

// ---- 5. reveal-on-purchase, and hidden by default ----
ok(/id="manual-pack-block" style="display:none/.test(app),
   'manual block is hidden by default (a $2.99 buyer must not see it)');
ok(/manualAddon === 'true' \? 'block' : 'none'/.test(app),
   'manual block is revealed only when the session says it was bought');
ok(/manualAddon: session\.metadata\?\.manualAddon === 'true' \? 'true' : 'false'/.test(vs),
   "verify-session returns manualAddon as a 'true'/'false' STRING, not a boolean");
ok(!/manualAddon: session\.metadata\?\.manualAddon,/.test(vs),
   'verify-session does NOT return the raw metadata value (the boolean bug)');

// ---- 6. tracking: both events must be allow-listed or they are silently dropped ----
for (const ev of ['breakup_manual_downloaded', 'manual_addon_toggled']) {
  const inSet = new RegExp(`ALLOWED_EVENTS = new Set\\(\\[[\\s\\S]*?'${ev}'[\\s\\S]*?\\]\\)`).test(track);
  ok(inSet, `${ev} is inside the ALLOWED_EVENTS set (not just mentioned in prose)`);
  ok(app.includes(ev), `the client emits ${ev}`);
}

// ---- 7. the total shown to the buyer includes the add-on ----
ok(/isManualAddonSelected\(\) \? MANUAL_ADDON_PRICE : 0/.test(app),
   'getCurrentTotal() includes the manual add-on (button total cannot understate)');
// Both add-ons on at once must be representable: $2.99 + $1.99 + $3.99 + $4.99.
ok(/isColoringAddonSelected\(\) \? COLORING_ADDON_PRICE : 0/.test(app),
   'getCurrentTotal() still includes the coloring add-on alongside the manual');

// ---- 8. every referenced client symbol must exist ----
// The Edit tool dropped a declaration once during development, leaving the
// client calling a function that did not exist: a ReferenceError that breaks
// the checkout button for everyone. node --check cannot see it.
for (const fn of ['isManualAddonSelected', 'toggleManualAddon', 'downloadBreakupManual']) {
  ok(new RegExp(`function ${fn}\\(`).test(app), `${fn}() is declared in the client`);
}
for (const id of ['enable-manual-addon', 'manual-addon-note', 'manual-pack-block',
                  'manual-letter-btn', 'manual-a4-btn']) {
  const n = (app.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  ok(n === 1, `id="${id}" exists exactly once in the markup (found ${n})`);
}
ok(/enable-manual-addon'\)\.checked = false/.test(app),
   'manual checkbox is reset when the checkout modal opens');
ok(/enable-manual-addon" onchange="toggleManualAddon\(\)"/.test(app),
   'the checkbox is wired to toggleManualAddon()');

// ---- 9. legal discloses it honestly ----
ok(/breakup survival manual/i.test(legal), 'legal page mentions the breakup survival manual');
ok(/4\.99/.test(legal), 'legal page states the $4.99 price');
ok(/digital download/i.test(legal) && /Nothing is posted|not a physical/i.test(legal),
   'legal page states the manual is a digital download, not a shipped item');

console.log('✅ breakup manual is paid-gated, priced consistently, revealed on purchase, tracked, and disclosed');
