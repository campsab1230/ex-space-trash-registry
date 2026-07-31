import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      return res.status(200).json({
        paid: true,
        metadata: session.metadata,
      });
    }
    return res.status(200).json({ paid: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
