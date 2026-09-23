// REGRESSION TEST: the $1.99 emoji add-on must actually render ON the 3D
// debris object in the scene.
//
// The bug this guards: `emoji_overlay` was written to the DB by the Stripe
// webhook and shown on the certificate and /wall — but the 3D scene never
// fetched it, so the buyer paid $1.99 and their debris looked identical to
// everyone else's. Every link in the chain is asserted below, because a break
// in any ONE of them silently restores the original bug with no error output.
import fs from 'fs';

const idx = fs.readFileSync(new URL('../certificate-app.html', import.meta.url), 'utf8');

let fail = 0;
const check = (label, cond, extra = '') => {
  if (!cond) { fail++; console.log(`FAIL  ${label} ${extra}`); }
  else console.log(`PASS  ${label}`);
};

// --- 1. the registry must actually fetch the column -------------------------
// Without this, `row.emoji_overlay` is undefined and nothing downstream works.
check('loadRegistry() selects emoji_overlay',
      /from\('global_registry'\)\s*\.select\([^)]*emoji_overlay[^)]*\)/.test(idx));
check('liveGlobalRegistry stores an `emoji` field',
      /liveGlobalRegistry\[[^\]]+\]\s*=\s*\{[^}]*emoji\s*:/.test(idx));

// --- 2. a sprite/text system must exist (there was none) --------------------
check('makeEmojiSprite() is defined', /function makeEmojiSprite\s*\(/.test(idx));
check('sprite is built from a canvas texture',
      /new THREE\.CanvasTexture\(/.test(idx));
check('sprite uses SpriteMaterial', /new THREE\.SpriteMaterial\(/.test(idx));
check('canvas texture is actually drawn on',
      /getContext\('2d'\)/.test(idx) && /fillText\(/.test(idx));

// --- 3. the sprite must not steal taps from the object underneath ----------
// The picker raycasts trashPieces recursively; a Sprite IS hittable (unlike a
// Mesh with visible:false), so it would swallow clicks aimed at the debris.
check('sprite.raycast is neutralised so it cannot swallow picks',
      /\.raycast\s*=\s*function\s*\(\s*\)\s*\{\s*\}/.test(idx));
check('debris picking is still recursive (proxy spheres still work)',
      /raycaster\.intersectObjects\(trashPieces,\s*true\)/.test(idx));

// --- 4. it must only render a PAID emoji ------------------------------------
// The value must come from the registry row, never from local UI state.
check('applyRegistryEmoji() is defined', /function applyRegistryEmoji\s*\(/.test(idx));
check('emoji is gated on the registry row',
      /const emoji = \(row && row\.emoji\) \? row\.emoji : ''/.test(idx));
check('sprite is added to the object group',
      /group\.add\(sprite\)/.test(idx));

// --- 5. every path that can produce the badge must call the applier ---------
const callSites = [...idx.matchAll(/applyRegistryEmoji\(\);/g)].length;
check('applyRegistryEmoji() is called from 3+ paths (registry, feed, purchase)',
      callSites >= 3, `<- found ${callSites}`);

// --- 6. THE BADGE-ORBIT REGRESSION ------------------------------------------
// The animate loop used to do `t.rotation.x += 0.01` on the GROUP. The badge is
// an offset child of that group, so tumbling the group swings the badge around
// the debris and eventually hides it behind. Spin the mesh only.
check('animate loop spins the mesh, not the group (badge would orbit otherwise)',
      /if \(t\.userData\._spinTarget\) t\.userData\._spinTarget\.rotation\.x \+= 0\.01;/.test(idx));
check('debris items declare a _spinTarget',
      /_spinTarget:\s*mesh/.test(idx));
check('hearts still tumble (they have no _spinTarget)',
      /else t\.rotation\.x \+= 0\.01;/.test(idx));

// --- 7. post-purchase seed: webhook and redirect race ----------------------
check('post-purchase path seeds the registry so the badge shows immediately',
      /liveGlobalRegistry\[noradId\]\s*=\s*\{[\s\S]{0,200}emoji:\s*emojiOverlay/.test(idx));

// --- 8. resources must be released when the badge is replaced/removed ------
check('old sprite texture is disposed before replacement',
      /\.material\.map\.dispose\(\)/.test(idx));

console.log(fail ? `\n${fail} FAILED` : '\n✅ emoji add-on renders on the 3D object');
process.exit(fail ? 1 : 0);
