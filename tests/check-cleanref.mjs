// Re-test cleanRef, extracted verbatim from api/track.js.
// Better approach: assert the SECURITY PROPERTY (output charset ⊆ allow-list)
// instead of hand-writing expected strings — my first attempt hand-wrote them
// and three "failures" were just wrong expectations (I forgot / and _ are allowed).
const MAX_REF_LEN = 60;
const ALLOWED = /^[a-z0-9._:\/-]*$/;
function cleanRef(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._:\/-]/g, '').slice(0, MAX_REF_LEN);
  return s || null;
}

const hostile = [
  '<script>alert(1)</script>',
  "'; DROP TABLE analytics_events;--",
  '"><img src=x onerror=alert(1)>',
  '{"json":"injection"}',
  'a'.repeat(500),
  '\u0000\u202Eevil\u202D',
  '../../etc/passwd',
  'ref=1&session_id=cs_test_SECRET',
  'üñíçøđé',
  '  spaced  ',
  '',
  '   ',
];

let fail = 0;
const check = (label, cond) => { if (!cond) { fail++; console.log('FAIL ' + label); } else console.log('PASS ' + label); };

for (const h of hostile) {
  const out = cleanRef(h);
  if (out === null) { console.log(`PASS null-out for ${JSON.stringify(h).slice(0,44)}`); continue; }
  check(`charset-safe: ${JSON.stringify(h).slice(0,44)} -> ${JSON.stringify(out)}`, ALLOWED.test(out));
  check(`  len<=60`, out.length <= MAX_REF_LEN);
  check(`  no uppercase`, out === out.toLowerCase());
  check(`  no angle brackets`, !/[<>"']/.test(out));
}

// Type safety
check('null -> null', cleanRef(null) === null);
check('number -> null', cleanRef(123) === null);
check('object -> null', cleanRef({}) === null);
check('empty -> null', cleanRef('') === null);
check('whitespace -> null', cleanRef('   ') === null);

// Readable tokens must survive intact (the whole point)
check('"ig:dm" survives', cleanRef('ig:dm') === 'ig:dm');
check('"tiktok" survives', cleanRef('tiktok') === 'tiktok');
check('lowercases', cleanRef('IG:DM') === 'ig:dm');
check('underscore kept', cleanRef('utm_source') === 'utm_source');

console.log(fail ? `\n${fail} FAILED` : '\n✅ all cleanRef properties hold');
process.exit(fail ? 1 : 0);
