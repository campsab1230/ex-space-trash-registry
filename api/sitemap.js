// api/sitemap.js
//
// Dynamic sitemap at /sitemap.xml (routed via vercel.json).
//
// WHY: the static sitemap.xml only listed `/` and `/legal.html`. Every claim
// page (`/trash/:noradId`) is a real, indexable URL with unique content, and
// none of them were being advertised to search engines. This endpoint emits
// the whole set, regenerating as the registry grows.
//
// Reads with the anon key. RLS allows SELECT on global_registry.

import { createClient } from '@supabase/supabase-js';

const SITE = 'https://www.exspacetrash.com';

// XML text nodes and attribute values share the same five escapes.
function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoDate(value) {
  const d = new Date(value || Date.now());
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export default async function handler(req, res) {
  let rows = [];
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await supabase
      .from('global_registry')
      .select('norad_id, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    // A registry hiccup must not take the sitemap down — the static pages are
    // still worth serving.
    console.error('sitemap registry lookup failed:', err);
  }

  const urls = [];

  // Home is the money page — highest priority and changes daily (ticker).
  urls.push(`  <url>
    <loc>${SITE}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`);

  // The registry wall. Only list it once there is something on it, so we never
  // point crawlers at an empty page.
  if (rows.length > 0) {
    urls.push(`  <url>
    <loc>${SITE}/wall</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`);
  }

  for (const r of rows) {
    const lastmod = isoDate(r.created_at);
    urls.push(`  <url>
    <loc>${SITE}/trash/${encodeURIComponent(String(r.norad_id))}</loc>${lastmod ? `
    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`);
  }

  urls.push(`  <url>
    <loc>${SITE}/legal.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>`);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // Short cache: new claims should show up in search results quickly, but we
  // still do not want to hit the database on every crawler request.
  res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=3600');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`);
}
