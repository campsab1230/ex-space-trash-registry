// api/og-image.js
//
// Generates the 1200x630 social preview card for a single claim.
//
// FIX (1): this previously queried a `claims` table with `custom_name`, neither
// of which exists in this database. The real table is `global_registry`, and the
// name column is `dedication_name`. Because the old query always 404'd, this
// endpoint never returned an image — so every shared link fell back to a bare
// URL preview. That is the single biggest reason shares got no clicks.
//
// FIX (2): the render tree used to be written as JSX inside this plain `.js`
// file. Vercel runs `api/*.js` through no build step, so nothing transpiles
// that JSX and every request died with FUNCTION_INVOCATION_FAILED (500) before
// the handler body ran — the endpoint returned no image for ANY input, not even
// the generic fallback card. The tree is now built with the tiny `el()` helper
// below, which produces exactly the React-element shape satori expects. Keep
// JSX out of `api/`; tests/check-og-image.mjs fails the build if it returns.
//
// The anon key is correct here: RLS grants public SELECT on global_registry,
// and this endpoint only ever reads.

import { ImageResponse } from '@vercel/og';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs' };

// Minimal element factory. `@vercel/og` renders the image with satori, which
// consumes the React-element shape: { type, props: { style, children } }.
// Building that object directly lets the handler stay a plain .js module —
// no JSX, no transpile, no React dependency.
function el(type, style, children) {
  const props = { style };
  if (children !== undefined) props.children = children;
  return { type, props };
}

export default async function handler(req, res) {
  const { searchParams } = new URL(req.url, 'https://exspacetrash.com');
  const noradId = searchParams.get('id');

  // Fall back to a generic card rather than erroring, so a bad/missing id
  // still yields a usable preview instead of a broken image.
  let name = 'SPACE TRASH';
  let objectId = '—';
  // Whether we rendered a REAL claim. Drives caching (below): a real claim's
  // card is immutable forever, but a fallback card must NOT be, or a link
  // shared before the webhook lands would pin a blank "SPACE TRASH" preview
  // for that object for a whole year.
  let found = false;

  try {
    // A bad id, a missing id, or a database that is unreachable must all still
    // render the generic card, so this lookup is best-effort by design.
    if (noradId && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        const { data } = await supabase
          .from('global_registry')
          .select('norad_id, dedication_name, debris_name')
          .eq('norad_id', String(noradId))
          .limit(1);
        const row = Array.isArray(data) ? data[0] : data;
        if (row) {
          name = row.dedication_name || name;
          objectId = row.norad_id || objectId;
          found = true;
        }
      } catch (lookupErr) {
        console.error('og-image lookup failed, using generic card:', lookupErr);
      }
    }

    const tree = el(
      'div',
      {
        height: '100%', width: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#020208', color: '#ffffff',
        border: '10px solid #4ef2d2', padding: '40px', textAlign: 'center',
      },
      [
        el('div', { fontSize: 30, color: '#8ab4f8', letterSpacing: 2 },
          'EXSPACETRASH.COM'),
        el('div', { fontSize: 26, color: '#888', marginTop: 26, letterSpacing: 1 },
          `NORAD OBJECT #${objectId}`),
        el('div', { fontSize: 92, fontWeight: 700, color: '#efc84e', marginTop: 10 },
          String(name).slice(0, 22)),
        el('div', { fontSize: 26, color: '#4ef2d2', marginTop: 28 },
          'officially associated with this space junk'),
      ]
    );

    const img = new ImageResponse(tree, { width: 1200, height: 630 });

    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    // A real claim's name never changes after purchase -> cache forever.
    // A fallback card is temporary by definition -> let it expire in minutes so
    // it can be replaced by the real card as soon as the claim exists.
    res.setHeader(
      'Cache-Control',
      found
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300, stale-while-revalidate=600'
    );
    return res.status(200).send(buf);
  } catch (err) {
    console.error('og-image error:', err);
    // Signal "no image" so platforms fall back instead of showing a broken one.
    // Never let an error page be cached.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).send('Image generation failed');
  }
}
