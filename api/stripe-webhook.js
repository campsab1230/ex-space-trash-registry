// api/stripe-webhook.js
//
// This is the ONLY code that is allowed to write a row into
// `global_registry`. It only runs after Stripe has cryptographically
// verified (via the webhook signature) that a real payment completed.
// The browser can never trigger this directly — that's the whole point.
//
// You must register this URL in the Stripe Dashboard:
//   Developers -> Webhooks -> Add endpoint -> https://yourdomain.com/api/stripe-webhook
//   Event to send: checkout.session.completed
// Then copy the "Signing secret" it gives you into STRIPE_WEBHOOK_SECRET.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Vercel-specific: disable the default body parser so we can verify the
// raw request body against the Stripe signature (signature verification
// fails if the body has been touched/reserialized).
module.exports.config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { noradId, type, stat, exName } = session.metadata || {};

    if (!noradId || !exName) {
      console.error('Webhook missing expected metadata', session.id);
      return res.status(200).json({ received: true }); // ack so Stripe doesn't retry forever
    }

    try {
      const { error } = await supabase.from('global_registry').insert([{
        norad_id: noradId,
        debris_name: type,
        dedication_name: exName,
        stat: stat,
        stripe_session_id: session.id,
      }]);

      // 23505 = unique_violation — object was already claimed (shouldn't
      // normally happen thanks to the pending_claims lock, but this makes
      // the insert idempotent if Stripe retries the webhook).
      if (error && error.code !== '23505') {
        console.error('Failed to write registry row:', error);
      }

      await supabase.from('pending_claims').delete().eq('norad_id', noradId);
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
      // Return 500 so Stripe retries the webhook later
      return res.status(500).json({ error: 'Internal error processing webhook' });
    }
  }

  return res.status(200).json({ received: true });
};
