// REGRESSION TEST: the client must read exactly the keys the server sends.
// This is the bug class that silently broke the certificate: the handoff is
// untyped, so a renamed/misspelled key fails at runtime as `undefined` with no
// error anywhere. Parse both files and assert the contracts line up.
import fs from 'fs';

const idx  = fs.readFileSync(new URL('../certificate-app.html', import.meta.url),'utf8');
const vses = fs.readFileSync(new URL('../api/verify-session.js', import.meta.url),'utf8');

let fail = 0;
const check = (label, cond, extra='') => {
  if (!cond) { fail++; console.log(`FAIL  ${label} ${extra}`); }
  else console.log(`PASS  ${label}`);
};

// --- keys the SERVER returns under `metadata` ---
const metaBlock = vses.slice(vses.indexOf('metadata: {'), vses.indexOf('});', vses.indexOf('metadata: {')));
const serverKeys = [...metaBlock.matchAll(/^\s{6,}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m=>m[1]);
console.log('server metadata keys:', serverKeys.join(', '));

// --- keys the CLIENT destructures from result.metadata ---
const destr = idx.match(/const \{([^}]*)\} = result\.metadata;/);
check('client destructures result.metadata', !!destr);
const clientKeys = destr ? destr[1].split(',').map(s=>s.trim()).filter(Boolean) : [];
console.log('client destructured keys:', clientKeys.join(', '));

// --- 1. every client key must exist on the server ---
for (const k of clientKeys) {
  check(`client reads "${k}" and server provides it`, serverKeys.includes(k),
        `<- server has: ${serverKeys.join(', ')}`);
}

// --- 2. the specific historical bug must not return ---
check('client no longer destructures the non-existent `template` key',
      !clientKeys.includes('template'));
check('client reads `certificateTemplate` (the real key name)',
      clientKeys.includes('certificateTemplate'));

// --- 2b. property ACCESS, not just destructuring ---
//
// THE GAP THIS CLOSES. Everything above only inspects keys the client pulls out
// via `const { ... } = result.metadata`. But the client can just as easily read
// `result.metadata.giftEmail` — and that form was completely unchecked, so when
// verify-session.js forgot to return `giftEmail`, the success screen's
// `result.metadata.giftEmail === 'true'` was permanently `undefined`, the gift
// confirmation never rendered, and a buyer who paid $4.99 for the add-on was
// shown no acknowledgement of it at all. No error. No failing test.
//
// An untyped JSON handoff does not care HOW the client reads a key. So collect
// every `result.metadata.<key>` access and require the server to provide each.
const accessedKeys = [...idx.matchAll(/result\.metadata\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(m=>m[1]);
console.log('client accesses metadata.', [...new Set(accessedKeys)].join(', ') || '(none)');
for (const k of new Set(accessedKeys)) {
  check(`client accesses metadata.${k} and server provides it`, serverKeys.includes(k),
        `<- server has: ${serverKeys.join(', ')}`);
}
// Guard the guard: if the client stops reading metadata by property access at
// all, this section silently stops testing anything.
check('at least one metadata property access is checked (guard is not vacuous)',
      new Set(accessedKeys).size > 0);

// --- 2c. every gift key the success screen needs must survive the handoff ---
// Named explicitly because this is the exact pair that broke: the add-on is
// recorded at checkout, sent by the webhook, and confirmed via verify-session —
// three separate files, and the confirmation only works if this one key is
// echoed back.
check('verify-session returns giftEmail (or the gift confirmation silently never shows)',
      serverKeys.includes('giftEmail'));
check('giftEmail is normalised to the string the client compares against',
      /giftEmail:\s*session\.metadata\?\.giftEmail === 'true' \? 'true' : 'false'/.test(vses));
check('verify-session does NOT echo the recipient address back to the browser',
      !/recipientEmail:\s*session\.metadata/.test(vses));

// --- 3. top-level keys ---
for (const k of ['paid','registered','amountTotal']) {
  check(`server returns top-level "${k}"`,
        new RegExp(`\\b${k}\\b\\s*:`).test(vses) || new RegExp(`^\\s*${k},`, 'm').test(vses));
}
const clientTop = [...idx.matchAll(/result\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(m=>m[1]);
console.log('client reads top-level:', [...new Set(clientTop)].join(', '));
for (const k of new Set(clientTop)) {
  check(`top-level "${k}" is provided by server`,
        new RegExp(`\\b${k}\\b`).test(vses));
}

// --- 4. the renderer must not silently fall back to a default ---
check('template is normalised before use (not left undefined)',
      /const template = certificateTemplate === 'b' \? 'b' : 'a';/.test(idx));

// --- 5. verify-session must not flatten every failure into a blanket 500 ---
// The status code IS part of the handoff, so this is a contracts concern. A
// blanket 500 made an unresolvable session id look like a server outage, told
// the buyer to "contact support" over a dead link, and buried real incidents in
// noise. These four states must stay distinguishable.
check('server maps an unknown/unresolvable session to 404 (not 500)',
      /StripeInvalidRequestError[\s\S]{0,400}status\(404\)/.test(vses));
check('server maps transient Stripe errors to 503 so the client can retry',
      /StripeRateLimitError[\s\S]{0,400}status\(503\)/.test(vses));
check('server still returns 500 for genuine faults (not over-caught)',
      /status\(500\)/.test(vses));
check('client distinguishes 404 from 503 before deciding what to say',
      /res\.status === 404/.test(idx) && /res\.status === 503/.test(idx));
check('client no longer blanket-throws on any non-200 response',
      !/if \(!res\.ok\) throw new Error\('Verification request failed'\);/.test(idx));
check('client reads the error body instead of guessing from status alone',
      /const body = await res\.json\(\)/.test(idx));

console.log(fail ? `\n${fail} FAILED` : '\n✅ client/server contracts align');
process.exit(fail ? 1 : 0);
