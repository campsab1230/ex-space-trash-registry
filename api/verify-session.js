// Vercel serverless function: GET /api/verify-session?session_id=cs_test_...
// Asks Stripe directly whether this session was actually paid. This is the
// step that a URL query param like ?paid=true can never substitute for —
// only Stripe's own API can confirm a real payment happened.
//
// Env vars needed:
// STRIPE_SECRET_KEY

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const paid = session.payment_status === 'paid';

    return res.status(200).json({
      paid,
      metadata: paid ? session.metadata : null,
    });
  } catch (err) {
    console.error('verify-session error:', err);
    return res.status(500).json({ error: 'Failed to verify session' });
  }
};
