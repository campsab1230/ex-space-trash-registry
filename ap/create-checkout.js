// Vercel serverless function: POST /api/create-checkout
// Creates a dynamic Stripe Checkout Session (not a static Payment Link) so we
// can attach metadata (which debris, which name) and get a real session_id
// back on redirect that we can verify server-side.
//
// Env vars needed (set in Vercel project settings):
// STRIPE_SECRET_KEY - your Stripe secret key (sk_live_... or sk_test_...)
// SITE_URL - e.g. https://exspacetrash.com

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { noradId, type, stat, exName } = req.body;

    if (!noradId || !exName) {
      return res.status(400).json({ error: 'Missing noradId or exName' });
    }

    // Basic server-side sanitization/limits — never trust the client.
    const safeExName = String(exName).replace(/[^a-zA-Z0-9 .'-]/g, '').slice(0, 30) || 'UNKNOWN';
    const safeType = String(type || '').slice(0, 100);
    const safeStat = String(stat || '').slice(0, 200);
    const safeNoradId = String(noradId).slice(0, 20);

    const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Space Trash Claim — NORAD #${safeNoradId}`,
            description: `Dedicated to ${safeExName}`,
          },
          unit_amount: 199, // $1.99
        },
        quantity: 1,
      }],
      metadata: {
        noradId: safeNoradId,
        type: safeType,
        stat: safeStat,
        exName: safeExName,
      },
      success_url: `${siteUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
