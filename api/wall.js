// api/wall.js
//
// The public registry wall at /wall.
//
// WHY THIS EXISTS — this is the cheapest growth fix on the site.
// Until now the only place a claim was visible was a 6-second ticker line.
// A visitor arriving cold saw the 3D scene and nothing else: no evidence that
// anyone had ever bought anything, and no page for a search engine to index.
//
// This page is server-rendered HTML (not JS), so it is crawlable, shareable,
// and gives every claim a real, linkable address. It doubles as social proof.
//
// One row per claim, most recent first. Reads with the anon key, which RLS
// already permits for SELECT.

import { createClient } from '@supabase/supabase-js';

const SITE = 'https://www.exspacetrash.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [
    ['year', 31536000], ['month', 2592000], ['day', 86400],
    ['hour', 3600], ['minute', 60],
  ];
  for (const [label, span] of units) {
    const n = Math.floor(secs / span);
    if (n >= 1) return `${n} ${label}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

export default async function handler(req, res) {
  let rows = [];
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await supabase
      .from('global_registry')
      .select('norad_id, dedication_name, debris_name, created_at, emoji_overlay')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    console.error('wall lookup failed:', err);
  }

  const count = rows.length;
  const title = count
    ? `${count} piece${count === 1 ? '' : 's'} of space trash named after someone's ex`
    : 'The Space Trash Registry';
  const desc = 'Every real orbital debris object that has been permanently named after someone\'s ex. Browse the registry, then name your own.';

  const cards = rows.map((r) => {
    const id = String(r.norad_id);
    const name = esc(r.dedication_name || 'UNKNOWN');
    const debris = esc(r.debris_name || 'space debris');
    const emoji = r.emoji_overlay ? esc(r.emoji_overlay) : '';
    return `
    <a class="card" href="/trash/${encodeURIComponent(id)}">
      <span class="eyebrow">NORAD #${esc(id)}</span>
      <span class="name">${name}${emoji ? ' ' + emoji : ''}</span>
      <span class="sub">${debris}</span>
      <span class="when">${esc(timeAgo(r.created_at))}</span>
    </a>`;
  }).join('');

  const empty = `
    <div class="empty">
      <p>No claims yet.</p>
      <p><a href="/">Be the first &rarr;</a></p>
    </div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description: desc,
    url: `${SITE}/wall`,
    numberOfItems: count,
    itemListElement: rows.slice(0, 100).map((r, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE}/trash/${encodeURIComponent(String(r.norad_id))}`,
      name: `${r.dedication_name} — NORAD Object #${r.norad_id}`,
    })),
  };

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} • ExSpaceTrash.com</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/wall">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:url" content="${SITE}/wall">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<meta name="theme-color" content="#020208">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; background: #020208; color: #d0d0d0;
         font-family: 'Share Tech Mono', ui-monospace, monospace; line-height: 1.6; }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 36px 20px 80px; }
  h1 { color: #fff; font-size: 1.7rem; margin: 0 0 4px; text-shadow: 0 0 12px #4ef2d2; }
  .lede { color: #8ab4f8; margin: 0 0 6px; }
  .count { color: #efc84e; }
  .back { display: inline-block; margin-bottom: 22px; color: #4ef2d2; text-decoration: none; font-size: .85rem; }
  .back:hover { text-decoration: underline; }
  .cta { display: inline-block; margin: 16px 0 28px; padding: 12px 20px; border: 1px solid #efc84e;
         color: #efc84e; text-decoration: none; border-radius: 4px; font-weight: bold; }
  .cta:hover { background: rgba(239,200,78,.12); box-shadow: 0 0 14px rgba(239,200,78,.4); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .card { display: flex; flex-direction: column; gap: 4px; padding: 16px; text-decoration: none;
          background: rgba(4,10,20,.85); border: 1px solid rgba(78,242,210,.28); border-radius: 6px;
          transition: all .18s; }
  .card:hover { border-color: #4ef2d2; box-shadow: 0 0 16px rgba(78,242,210,.25); transform: translateY(-2px); }
  .eyebrow { font-size: .68rem; color: #555; letter-spacing: 1px; }
  .name { font-size: 1.25rem; color: #efc84e; font-weight: bold; word-break: break-word; }
  .sub { font-size: .78rem; color: #8ab4f8; }
  .when { font-size: .7rem; color: #444; margin-top: 4px; }
  .empty { color: #666; padding: 40px 0; }
  .empty a { color: #4ef2d2; }
  footer { margin-top: 44px; font-size: .72rem; color: #444; border-top: 1px solid #1a1a1a; padding-top: 16px; }
  footer a { color: #555; }
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/">&larr; Back to the registry</a>
  <h1>THE SPACE TRASH WALL</h1>
  <p class="lede">Real orbital debris, permanently named after someone&rsquo;s ex.
    <span class="count">${count} claimed.</span></p>
  <a class="cta" href="/">Name your own &rarr;</a>
  ${count ? `<div class="grid">${cards}</div>` : empty}
  <footer>
    Orbital data courtesy of <a href="https://celestrak.org" target="_blank" rel="noopener noreferrer">CelesTrak</a>.
    Not affiliated with NASA, NORAD, or the U.S. Space Force.
    &middot; <a href="/legal.html">Terms &amp; Disclaimers</a>
  </footer>
</div>
</body>
</html>`);
}
