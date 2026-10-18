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
// PRICING (flat): every orbit costs the same $2.99. The old orbit-based tiers
//   (LEO/MEO/GEO = 1.99/5.99/9.99) averaged only $4.85 per sale and let the
//   FIXED part of the Stripe fee eat 18% of revenue; flattening removed that.
//
//   A note on the fee, because it is the real constraint here. Stripe charges
//   2.9% + $0.30, so the fixed $0.30 dominates small orders:
//       $7.99 -> ~$0.53 fee -> 6.7% of revenue
//       $2.99 -> ~$0.39 fee -> 12.9% of revenue
//   $2.99 is therefore a deliberate trade: a materially lower entry price in
//   exchange for a higher fee percentage. It is still well clear of the 18%
//   the old $1.99 tier suffered, because that tier also averaged down to $1.99
//   rather than being a flat $2.99. Do not drop below this without redoing the
//   arithmetic — every cent below $2.99 moves the percentage the wrong way.
//
//   PRINTED_PRICES below are UNCHANGED by this. They are set by what postage
//   actually costs, not by the digital price, so lowering the digital price does
//   not make an overseas parcel any cheaper to send.
//
//   The object's own `stat` altitude is still parsed, but only as a sanity
//   check on the object — it no longer determines the price, because every
//   orbit now costs the same. This removes a failure mode: a malformed stat
//   can no longer block a legitimate sale.
//
//   PRINTED is a BUNDLE total, not an add-on. It is the entire amount the
//   buyer pays for digital + a posted copy, so the customer never has to add
//   two numbers. The Stripe receipt still itemises the digital line so the
//   printed line's cost is visible.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PENDING_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes
const EMOJI_ADDON_PRICE = 1.99;

// Gift delivery. An ADD-ON, not a bundle total: the buyer always keeps their own
// digital certificate, and this buys the extra service of us emailing a copy to
// a recipient they name. Priced above the certificate itself because the work is
// real — deliverability, abuse handling and support — while the marginal cost of
// a single send is near zero. Must match EMAIL_ADDON_PRICE in certificate-app.html.
//
// This is the one part of the funnel that sends mail to someone who did not ask
// for it, so it is deliberately constrained: ONE email per purchase (enforced by
// a UNIQUE index on the session id), the named recipient is the only address we
// ever write to, the buyer cannot author the body, and every message carries an
// opt-out. See api/stripe-webhook.js for the send and migrations/004.
const EMAIL_ADDON_PRICE = 4.99;

// Flat digital price. Every orbit costs the same; the orbit no longer sets the
// price. Must match BASE_PRICE in certificate-app.html.
const BASE_PRICE = 2.99;

// PRINTED totals (digital + a posted copy), NOT add-ons:
//   domestic      $19.99 — flat + rigid mailer + first-class US postage is
//                           roughly $4, leaving a healthy margin.
//   international $29.99 — First-Class Package International STARTS near
//                           $19.40, so the US price would LOSE money on every
//                           overseas order. Charging the domestic rate abroad
//                           is the one mistake that costs real money here.
// Must match PRINTED_PRICES in certificate-app.html.
const PRINTED_PRICES = { none: 0, domestic: 19.99, international: 29.99 };
const VALID_TIERS = Object.keys(PRINTED_PRICES);

// These amounts are the source of truth. The client only sends the tier NAME;
// the server decides the money. A tampered tier falls back to 'none'.

// Stripe validates the address against this list, so only include what we will
// genuinely post to.
const DOMESTIC_COUNTRIES = ['US'];
const INTERNATIONAL_COUNTRIES = [
  'US', 'CA', 'GB', 'IE', 'AU', 'NZ',
  'DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'PT', 'AT', 'CH',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'GR',
  'JP', 'KR', 'SG', 'HK', 'MY', 'TH', 'PH', 'TW',
  'AE', 'IL', 'ZA', 'BR', 'MX', 'AR', 'CL', 'CO',
];

// Kept only to label the object in logs/receipts; no longer used for pricing.
const REGIME_LABEL = { LEO: 'low Earth orbit', MEO: 'medium Earth orbit', GEO: 'geostationary orbit' };

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
    const { noradId, type, stat, exName, customMessage, price, emojiAddon, emojiOverlay, certificateTemplate, mailTier, userEmail, emailGift, recipientEmail } = req.body || {};

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

    // Allow-list the tier. Anything unrecognised becomes 'none', so a tampered
    // or stale value can never buy a physical copy at the wrong price.
    const cleanTier = Object.prototype.hasOwnProperty.call(PRINTED_PRICES, mailTier) ? mailTier : 'none';
    const wantsMail = cleanTier !== 'none';
    const cleanEmoji = wantsEmojiAddon
      ? Array.from(String(emojiOverlay || '').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069<>&"']/gu, '')).slice(0, 4).join('')
      : '';

    // Gift delivery. The client sends a boolean and an address; neither is
    // trusted. If the add-on is selected we REQUIRE a plausible recipient and
    // refuse the sale without one, because the buyer would otherwise be charged
    // $4.99 for a send that can never happen. Rejecting is the honest failure
    // here — silently downgrading to a digital-only order would take the money
    // and keep the fee for a service we never rendered.
    const wantsGiftEmail = emailGift === true;
    const rawRecipient = String(recipientEmail || '').trim().toLowerCase();
    // Deliberately conservative: one @, a dot in the domain, no whitespace, and
    // no characters that matter for header injection. We do not try to be
    // RFC-complete — a wrong-but-syntactic address simply bounces at the
    // provider, which is a cheaper failure than a regex that rejects real ones.
    const RECIPIENT_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
    if (wantsGiftEmail && (rawRecipient.length > 254 || !RECIPIENT_RE.test(rawRecipient))) {
      return res.status(400).json({ error: 'Please enter a valid email address for the gift delivery.' });
    }
    const cleanRecipient = wantsGiftEmail ? rawRecipient : '';

    // The client's only job is to name the tier. It sends the flat base price
    // as a sanity signal; the real amount is derived below and never trusted
    // from the request.
    const numericPrice = Number(price);
    if (Math.abs(numericPrice - BASE_PRICE) > 0.001) {
      console.error('create-checkout: unexpected base price from client', { noradIdStr, sent: numericPrice });
      return res.status(400).json({ error: 'Invalid price' });
    }

    const tierTotal = cleanTier === 'none' ? BASE_PRICE : PRINTED_PRICES[cleanTier];
    if (!Number.isFinite(tierTotal) || tierTotal <= 0) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    // Informational only — a bad stat can no longer block a sale, it just
    // means the receipt won't name the orbit.
    const regime = regimeFromStat(cleanStat);
    if (!regime) {
      console.warn('create-checkout: could not derive regime from stat (non-fatal now)', { noradIdStr, stat: cleanStat });
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
    const lineItems = [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Space Trash Claim: NORAD #${noradIdStr}`,
          description: regime ? `Digital certificate — ${REGIME_LABEL[regime]}` : 'Digital certificate',
        },
        unit_amount: Math.round(BASE_PRICE * 100),
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
    if (wantsGiftEmail) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Gift delivery — we email the certificate for you',
            description: 'A one-off email sent on your behalf to the address you gave. Your own digital certificate is included separately.',
          },
          unit_amount: Math.round(EMAIL_ADDON_PRICE * 100),
        },
        quantity: 1,
      });
    }
    if (wantsMail) {
      const isIntl = cleanTier === 'international';
      // PRINTED_PRICES holds the BUNDLE TOTAL. Charge only the difference here,
      // on top of the digital line above, so the receipt adds up to exactly the
      // advertised $19.99 / $29.99 and the printed cost is still itemised.
      const printPortion = Math.round((PRINTED_PRICES[cleanTier] - BASE_PRICE) * 100);
      if (printPortion > 0) {
        lineItems.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: isIntl
                ? 'Printed certificate + international postage'
                : 'Printed certificate + postage (USA)',
              description: 'A printed copy of this certificate, posted to your chosen address.',
            },
            unit_amount: printPortion,
          },
          quantity: 1,
        });
      }
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
        // Tier name, not a boolean — Stripe metadata is string-only and we need
        // to know which postage class to use when packing the envelope.
        mailTier: cleanTier,
        purchaseType: wantsMail ? 'printed' : 'digital',
        basePrice: String(BASE_PRICE),
        // Gift delivery. `recipientEmail` is the address the BUYER typed for the
        // recipient — never the buyer's own, and never used as a login or an
        // identity. Duplicated here as well as in the DB so a missing migration
        // cannot lose a delivery already paid for: the webhook can still read
        // the address straight out of Stripe metadata.
        giftEmail: wantsGiftEmail ? 'true' : 'false',
        recipientEmail: cleanRecipient,
      },
      // Stripe collects and validates the postal address itself, and the
      // address arrives on the webhook as session.shipping_details. We never
      // ask for or store a mailing address in our own database.
      ...(wantsMail ? {
        shipping_address_collection: {
          allowed_countries: cleanTier === 'international'
            ? INTERNATIONAL_COUNTRIES
            : DOMESTIC_COUNTRIES,
        },
      } : {}),
      success_url: `${siteUrl}/certificate-app.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/certificate-app.html`,
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
