// api/create-checkout.js
//
// This is the ONLY place a Stripe Checkout Session should be created.
// It uses the Supabase SERVICE ROLE key (server-only, never shipped to the
// browser) so it can check/lock rows the public anon key isn't allowed to
// touch. It never writes the "sold" record itself — that happens in
// api/stripe-webhook.js, only after Stripe confirms the money actually moved.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PENDING_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { noradId, type, stat, exName, customMessage, price, userEmail } = req.body || {};

    if (!noradId || !type || !exName || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Re-sanitize server-side. Never trust the client's cleanup alone.
    const cleanName = String(exName).replace(/[^a-zA-Z0-9 .'-]/g, '').slice(0, 30) || 'UNKNOWN';
    const cleanType = String(type).slice(0, 120);
    const cleanStat = String(stat || '').slice(0, 200);
    const cleanMessage = String(customMessage || '').replace(/[^a-zA-Z0-9 .,'!?-]/g, '').slice(0, 25);
    const noradIdStr = String(noradId).slice(0, 20);

    // Reject a price that doesn't match a real tier — a tampered client
    // request shouldn't be able to buy a $9.99 GEO object for a penny.
    const validPrices = [1.99, 5.99, 9.99];
    const numericPrice = Number(price);
    if (!validPrices.includes(numericPrice)) {
      return res.status(400).json({ error: 'Invalid price' });
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
    const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Space Trash Claim: NORAD #${noradIdStr}` },
          unit_amount: priceInCents,
        },
        quantity: 1,
      }],
      metadata: {
        noradId: noradIdStr,
        type: cleanType,
        stat: cleanStat,
        exName: cleanName,
        customMessage: cleanMessage,
      },
      success_url: `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,
      customer_email: (userEmail && String(userEmail).includes('@')) ? userEmail : undefined,
      expires_at: Math.floor((Date.now() + 30 * 60 * 1000) / 1000), // Stripe requires at least 30 min
    });

    // 4. Lock the object while checkout is in progress
    const { error: lockErr } = await supabase
      .from('pending_claims')
      .upsert({ norad_id: noradIdStr, session_id: session.id, created_at: new Date().toISOString() });
    if (lockErr) console.error('Failed to write pending claim lock:', lockErr);

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
