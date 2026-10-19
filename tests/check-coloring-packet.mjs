import fs from 'fs';

// Guard the PAID coloring packet ($3.99 add-on).
//
// Why this needs its own guard, and why it is stricter than the sticker-pack
// one: the sticker pack is a freebie, so its worst failure is a dead link. This
// one is a PAID product, and its failure modes are worse and quieter:
//
//   * If the success screen forgets to reveal the download, a buyer pays $3.99
//     and receives nothing. The money moves, the buyer is angry, and NO error
//     is raised anywhere — the page simply looks like the free flow.
//   * If the block is visible by default instead of hidden, every $2.99 buyer
//     gets the $3.99 product for free, and the leak is invisible in the logs.
//   * If the client hardcodes the PDF path, the payment gate is decorative —
//     the URL is in the page source and anyone can take it. That is exactly
//     the failure this design exists to avoid, so it is asserted against.
//   * If the price drifts between client and server, the button advertises one
//     number and Stripe charges another.
//   * If `coloringAddon` comes back as a real boolean instead of the string
//     'true', the client's === 'true' check is silently false and the buyer
//     again gets nothing. (This is the exact bug that shipped once already with
//     certificateTemplate, so it is pinned here.)
//   * If the track event is not allow-listed, /api/track silently 204s it and
//     the funnel undercounts — the one number that tells you if it sold.
//
// None of these throw. All of them are caught here instead.

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
const dl = read('../api/coloring-download.js');

const PDF_LETTER = '../assets/coloring/coloring-packet-letter.vd360da8682ff.pdf';
const PDF_A4     = '../assets/coloring/coloring-packet-a4.vee0c3a50ece3.pdf';

// ---- 1. both PDFs exist and are real PDFs, not stubs ----
for (const [p, label] of [[PDF_LETTER, 'US Letter'], [PDF_A4, 'A4']]) {
  ok(exists(p), `${label} coloring PDF exists`);
  if (exists(p)) {
    const buf = fs.readFileSync(root(p));
    ok(buf.length > 200000, `${label} PDF is substantial (${buf.length} bytes)`);
    ok(buf.subarray(0, 5).toString('latin1') === '%PDF-', `${label} PDF has a real %PDF- header`);
  }
}

// ---- 2. the price is 3.99 on BOTH sides (server decides, client advertises) ----
const coPrice = (co.match(/const COLORING_ADDON_PRICE = ([\d.]+);/) || [])[1];
const appPrice = (app.match(/const COLORING_ADDON_PRICE = ([\d.]+);/) || [])[1];
ok(coPrice === '3.99', `server COLORING_ADDON_PRICE is 3.99 (got ${coPrice})`);
ok(appPrice === '3.99', `client COLORING_ADDON_PRICE is 3.99 (got ${appPrice})`);
ok(coPrice === appPrice, 'client and server coloring prices agree');

// The add-on must actually be charged: a line item, not just a metadata flag.
ok(/if \(wantsColoringAddon\) \{[\s\S]{0,400}?unit_amount: Math\.round\(COLORING_ADDON_PRICE \* 100\)/.test(co),
   'create-checkout pushes a Stripe line item for the coloring add-on');

// ---- 3. the gate: the client must NOT know where the file lives ----
ok(!app.includes('coloring-packet-letter.v'), 'client does NOT hardcode the Letter PDF path (gate is real)');
ok(!app.includes('coloring-packet-a4.v'), 'client does NOT hardcode the A4 PDF path (gate is real)');
ok(/api\/coloring-download\?session_id=/.test(app),
   'client downloads via the gated /api/coloring-download endpoint');

// ---- 4. the endpoint verifies BOTH payment and that the add-on was bought ----
ok(/payment_status !== 'paid'/.test(dl), 'download endpoint refuses unpaid sessions');
ok(/metadata\?\.coloringAddon !== 'true'/.test(dl),
   'download endpoint refuses sessions that did not buy the add-on');
ok(/const PACKET_FILES = \{/.test(dl), 'download endpoint uses an allow-list of formats');
ok(!/path\.join|\.\.\//.test(dl), 'download endpoint cannot be walked to another file');

// ---- 5. reveal-on-purchase, and hidden by default ----
ok(/id="coloring-pack-block" style="display:none/.test(app),
   'coloring block is hidden by default (a $2.99 buyer must not see it)');
ok(/coloringAddon === 'true' \? 'block' : 'none'/.test(app),
   'coloring block is revealed only when the session says it was bought');
ok(/coloringAddon: session\.metadata\?\.coloringAddon === 'true' \? 'true' : 'false'/.test(vs),
   "verify-session returns coloringAddon as a 'true'/'false' STRING, not a boolean");

// ---- 6. tracking: both events must be allow-listed or they are silently dropped ----
for (const ev of ['coloring_packet_downloaded', 'coloring_addon_toggled']) {
  const inSet = new RegExp(`ALLOWED_EVENTS = new Set\\(\\[[\\s\\S]*?'${ev}'[\\s\\S]*?\\]\\)`).test(track);
  ok(inSet, `${ev} is inside the ALLOWED_EVENTS set (not just mentioned in prose)`);
  ok(app.includes(ev), `the client emits ${ev}`);
}

// ---- 7. the total shown to the buyer includes the add-on ----
ok(/isColoringAddonSelected\(\) \? COLORING_ADDON_PRICE : 0/.test(app),
   'getCurrentTotal() includes the coloring add-on (button total cannot understate)');

// ---- 8. the checkbox resets between openings, or a stale tick re-adds $3.99 ----
ok(/enable-coloring-addon'\)\.checked = false/.test(app),
   'coloring checkbox is reset when the checkout modal opens');

// ---- 9. legal discloses it honestly ----
ok(/coloring packet/i.test(legal), 'legal page mentions the coloring packet');
ok(/digital download/i.test(legal) && /Nothing is posted|not a physical/i.test(legal),
   'legal page states the coloring packet is a digital download, not a shipped item');
ok(/3\.99/.test(legal), 'legal page states the $3.99 price');

console.log('✅ coloring packet is paid-gated, priced consistently, revealed on purchase, tracked, and disclosed');
