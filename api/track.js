// api/track.js
//
// First-party, cookie-free funnel analytics. The site currently has no idea
// where visitors fall out, so every change is a guess. This is the smallest
// thing that fixes that.
//
// DESIGN DECISIONS (deliberate, do not "improve" these casually):
//   * No cookies, no fingerprinting, no IP stored, no third-party script. The
//     site sells a novelty certificate to people who give us their ex's name —
//     it should not also ship them to an ad network.
//   * The endpoint ALWAYS returns 204, even on bad input or a database error.
//     Analytics must never be able to break a page or surface an error to a
//     visitor or a crawler.
//   * Events are allow-listed. Without that, this is an open write endpoint
//     into the user's database (the anon key is public, so anything the client
//     can send, a stranger can send).
//   * Writes go through the SERVICE ROLE key server-side, never the anon key.
//     RLS on analytics_events denies anon writes by design.

import { createClient } from '@supabase/supabase-js';

const ALLOWED_EVENTS = new Set([
  'page_view',
  'debris_loaded',
  'debris_failed',
  'object_selected',
  'checkout_started',
  'checkout_completed',
  'certificate_downloaded',
  'share_opened',
  'wall_viewed',
]);

const MAX_PATH_LEN = 200;

// Best-effort, in-process limiter. Vercel may run several instances and cold
// starts reset it, so this is a speed bump, not a wall — it is here to stop a
// single client hammering the endpoint, not to enforce a hard quota.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (hits.size > 5000) hits.clear(); // crude memory guard
  return entry.count > RATE_MAX;
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function cleanPath(p) {
  if (typeof p !== 'string') return null;
  // Keep only the pathname — never store query strings (a session_id could be
  // in there, and that is a payment identifier).
  const pathname = p.split('?')[0].split('#')[0];
  if (!pathname || pathname.length > MAX_PATH_LEN) return null;
  return pathname;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  if (rateLimited(clientKey(req))) {
    return res.status(204).end();
  }

  let body = req.body;
  // If a body parser is not active for some reason, read the stream ourselves.
  if (body == null || (typeof body === 'string' && body.length === 0)) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks).toString('utf8');
    } catch {
      return res.status(204).end();
    }
  }

  try {
    if (typeof body === 'string') body = JSON.parse(body);
    if (typeof body !== 'object' || body === null) return res.status(204).end();

    const event = String(body.event || '');
    if (!ALLOWED_EVENTS.has(event)) return res.status(204).end();

    let noradId = body.noradId == null ? null : String(body.noradId).trim();
    if (noradId && !/^[0-9A-Za-z_-]{1,32}$/.test(noradId)) noradId = null;

    let value = Number(body.value);
    if (!Number.isFinite(value)) value = null;
    // Round to 2dp so a hostile client cannot stuff a giant float in.
    if (value !== null) value = Math.round(value * 100) / 100;

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { error } = await supabase.from('analytics_events').insert([{
      event,
      norad_id: noradId,
      path: cleanPath(body.path),
      value,
    }]);

    if (error) console.error('track insert failed:', error.message);
  } catch (err) {
    console.error('track error:', err && err.message);
  }

  // Always 204 — no body, nothing for the client to interpret or leak.
  return res.status(204).end();
}
