import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { noradId, type, stat, exName, price } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `ExSpaceTrash Claim: NORAD #${noradId}`,
            description: `Permanent assignment to: ${exName}`,
          },
          unit_amount: Math.round((price || 1.99) * 100), // Price in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { noradId, type, stat, exName },
      success_url: `${req.headers.origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
