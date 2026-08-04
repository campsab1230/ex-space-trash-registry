import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  const slug = req.url.split('/trash/')[1]?.split('?')[0];
  const { data: obj } = await supabase
    .from('claims')
    .select('*')
    .eq('slug', slug)
    .single();

  if (!obj) return res.redirect(302, '/');

  const title = `${obj.custom_name} — NORAD Object #${obj.norad_id}`;
  const desc = `Officially dedicated to ${obj.custom_name}. May they float uselessly in the void forever.`;
  const image = `https://exspacetrash.com/api/og-image?id=${obj.id}`; // see step 2

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${image}">
  <meta property="og:url" content="https://exspacetrash.com/trash/${slug}">
  <meta name="twitter:card" content="summary_large_image">
  <meta http-equiv="refresh" content="0;url=/?trash=${slug}">
</head>
<body>Redirecting...</body>
</html>`);
}
