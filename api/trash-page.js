// api/trash-page.js
//
// Serves the shareable per-claim page at /trash/:noradId.
// Routed via vercel.json: { "source": "/trash/:slug", "destination": "/api/trash-page" }
//
// FIX: this previously queried a `claims` table with `slug` / `custom_name`
// columns. None of those exist. The real table is `global_registry` and the
// columns are `norad_id` / `dedication_name`. Because the query always 404'd,
// `obj` was always null and every share page redirected straight home — so a
// shared claim never showed a preview of the person's ex. Fixed to read the
// real table, and to key off the NORAD id (which is unique per claim).
//
// This page exists purely to give social platforms real OG tags. It does not
// need to render a full UI — it emits tags, then bounces the human to the 3D
// scene with ?focus=<noradId> so the object is highlighted on arrival.

import { createClient } from '@supabase/supabase-js';

const SITE = 'https://www.exspacetrash.com';

// Never interpolate untrusted DB text into HTML without escaping — a dedication
// name is user-supplied, so it must be treated as hostile in an attribute.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  // /trash/:id — accept the id from the path, or ?id= as a fallback
  let id = req.url.split('/trash/')[1]?.split('?')[0];
  if (!id || id === 'undefined') {
    id = new URL(req.url, SITE).searchParams.get('id');
  }
  id = (id || '').trim();

  let name = null;
  let debris = 'space debris';

  if (id) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      const { data } = await supabase
        .from('global_registry')
        .select('norad_id, dedication_name, debris_name')
        .eq('norad_id', String(id))
        .limit(1);
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        name = row.dedication_name;
        debris = row.debris_name || debris;
      }
    } catch (err) {
      console.error('trash-page lookup failed:', err);
    }
  }

  // Unknown id -> send them to the scene rather than 404, so a stale link
  // still converts instead of dead-ending.
  if (!name) return res.redirect(302, '/');

  const title = `${name} — NORAD Object #${id}`;
  const desc = `${name} has been permanently associated with a real piece of ${debris} in Earth orbit. Name your own ex's space trash.`;
  const img = `${SITE}/api/og-image?id=${encodeURIComponent(id)}`;
  const canonical = `${SITE}/trash/${encodeURIComponent(id)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="canonical" href="${canonical}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="ExSpaceTrash.com">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${canonical}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">

<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<meta name="theme-color" content="#020208">

<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'CreativeWork',
  name: title,
  description: desc,
  url: canonical,
  image: img,
  isPartOf: { '@type': 'WebSite', name: 'ExSpaceTrash.com', url: SITE },
})}
</script>

<!-- Humans get bounced into the 3D scene with their object highlighted. -->
<meta http-equiv="refresh" content="0;url=/?focus=${encodeURIComponent(id)}">
<script>location.replace('/?focus=' + encodeURIComponent(${JSON.stringify(String(id))}));</script>
</head>
<body style="background:#020208;color:#4ef2d2;font-family:monospace;padding:40px">
<p>Loading ${esc(name)}&rsquo;s space trash&hellip;</p>
<p><a href="/?focus=${encodeURIComponent(id)}" style="color:#efc84e">Continue to the registry &rarr;</a></p>
</body>
</html>`);
}
