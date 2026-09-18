// api/create-checkout.js
//
// This is the ONLY place a Stripe Checkout Session should be created.
// It uses the Supabase SERVICE ROLE key (server-only, never shipped to the
// browser) so it can check/lock rows the public anon key isn't allowed to
// touch. It never writes the "sold" record itself — that happens in
// api/stripe-webhook.js, only after Stripe confirms the money actually moved.
//
// FIX #1 (the outage): this project is "type": "module" (ESM). This file used
//   require()/module.exports, which throws "require is not defined" at load
//   time — so every request 500'd before any logic ran. Converted to ESM.
//
// FIX #2 (a real hole): the old code validated that the price was *one of*
//   [1.99, 5.99, 9.99], then charged it. It never checked the price matched
//   the object's orbit. Anyone could claim a $9.99 GEO object for $1.99 by
//   editing the request. The price tier is now derived from the object's own
//   `stat` altitude (which you generate server-side), and the client's
//   number is only used to verify the two agree.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PENDING_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes
const EMOJI_ADDON_PRICE = 1.99;

// Tier prices. Must match the client's tiers in index.html.
const PRICE_BY_REGIME = { LEO: 1.99, MEO: 5.99, GEO: 9.99 };

/**
 * Derive the regime (and therefore the price) from the object's altitude.
 * The altitude lives in the `stat` string your own server wrote, e.g.
 * "FENGYUN 1C DEBRIS • Alt: 882 km" — so it is not client-forgeable.
 * Returns null if we can't read a real altitude, in which case we refuse
 * the sale rather than guess a price.
 */
function regimeFromStat(stat) {
  const m = String(stat || '').match(/Alt:\s*([\d,]+)\s*km/i);
  if (!m) return null;
  const altKm = parseInt(m[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(altKm)) return null;
  if (altKm > 35000) return 'GEO';
  if (altKm > 2000) return 'MEO';
  return 'LEO';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { noradId, type, stat, exName, customMessage, price, emojiAddon, emojiOverlay, certificateTemplate, userEmail } = req.body || {};

    if (!noradId || !type || !exName || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Re-sanitize server-side. Never trust the client's cleanup alone.
    const cleanName = String(exName).replace(/[^a-zA-Z0-9 .'-]/g, '').slice(0, 30) || 'UNKNOWN';
    const cleanType = String(type).slice(0, 120);
    const cleanStat = String(stat || '').slice(0, 200);
    const cleanMessage = String(customMessage || '').replace(/[^a-zA-Z0-9 .,'!?-]/g, '').slice(0, 25);
    const noradIdStr = String(noradId).slice(0, 20);

    // Certificate artwork choice. Allow-list: anything that is not exactly
    // 'b' falls back to 'a', so a malformed value can never reach Stripe
    // metadata and then the renderer as an unexpected template.
    const cleanTemplate = (certificateTemplate === 'b') ? 'b' : 'a';

    const wantsEmojiAddon = emojiAddon === true;
    const cleanEmoji = wantsEmojiAddon
      ? Array.from(String(emojiOverlay || '').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069<>&"']/gu, '')).slice(0, 4).join('')
      : '';

    const numericPrice = Number(price);
    if (![1.99, 5.99, 9.99].includes(numericPrice)) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    // ---- Price must MATCH the object's orbit, not merely be a valid tier. ----
    const regime = regimeFromStat(cleanStat);
    if (!regime) {
      // No trustworthy altitude -> we cannot verify the price. Refuse.
      console.error('create-checkout: could not derive regime from stat', { noradIdStr, stat: cleanStat });
      return res.status(400).json({ error: 'Could not verify this object. Please reload and try again.' });
    }
    const expectedBase = PRICE_BY_REGIME[regime];
    if (Math.abs(numericPrice - expectedBase) > 0.001) {
      console.error('create-checkout: price/regime mismatch', { noradIdStr, regime, sent: numericPrice, expected: expectedBase });
      return res.status(400).json({ error: 'Price does not match this object.' });
    }

    // 1. Already sold?
    const { data: existing, error: existingErr } = await supabase
      .from('global_registry')
      .select('norad_id')
      .eq('norad_id', noradIdStr)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      return res.status(409).json({ error: 'This debris has already been claimed.' });
    }

    // 2. Someone else mid-checkout on the same object?
    const { data: pending, error: pendingErr } = await supabase
      .from('pending_claims')
      .select('*')
      .eq('norad_id', noradIdStr)
      .maybeSingle();
    if (pendingErr) throw pendingErr;
    if (pending && (Date.now() - new Date(pending.created_at).getTime()) < PENDING_CLAIM_TTL_MS) {
      return res.status(409).json({ error: 'Someone else is currently checking out with this object. Try again in a few minutes.' });
    }

    // 3. Create the Stripe session
    const priceInCents = Math.round(numericPrice * 100);
    const lineItems = [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Space Trash Claim: NORAD #${noradIdStr}` },
        unit_amount: priceInCents,
      },
      quantity: 1,
    }];
    if (wantsEmojiAddon) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Custom Emoji Overlay Add-on' },
          unit_amount: Math.round(EMOJI_ADDON_PRICE * 100),
        },
        quantity: 1,
      });
    }

    // Build the site URL defensively — this must NEVER produce "https://undefined".
    const HARDCODED_FALLBACK = 'https://www.exspacetrash.com';
    let siteUrl = (process.env.SITE_URL || '').trim();
    if (!siteUrl && req.headers.host) {
      siteUrl = `https://${req.headers.host}`;
    }
    if (!siteUrl || !/^https?:\/\/.+/.test(siteUrl)) {
      console.warn(`create-checkout: SITE_URL/host was missing or invalid ("${siteUrl}") — using hardcoded fallback.`);
      siteUrl = HARDCODED_FALLBACK;
    }
    siteUrl = siteUrl.replace(/\/+$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: {
        noradId: noradIdStr,
        type: cleanType,
        stat: cleanStat,
        exName: cleanName,
        customMessage: cleanMessage,
        emojiOverlay: cleanEmoji,
        certificateTemplate: cleanTemplate,
      },
      success_url: `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,
      customer_email: (userEmail && String(userEmail).includes('@')) ? userEmail : undefined,
      expires_at: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
    });

    // 4. Lock the object while checkout is in progress.
    // NOTE: the column is `session_id` (confirmed against the live table —
    // there is no `stripe_session_id` column here).
    const { error: lockErr } = await supabase
      .from('pending_claims')
      .upsert({ norad_id: noradIdStr, session_id: session.id, created_at: new Date().toISOString() });
    if (lockErr) console.error('Failed to write pending claim lock:', lockErr);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
