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

console.log(fail ? `\n${fail} FAILED` : '\n✅ client/server contracts align');
process.exit(fail ? 1 : 0);
