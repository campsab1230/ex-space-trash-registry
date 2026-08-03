// api/verify-session.js
//
// Read-only. Lets the frontend check "did this Stripe session actually get
// paid, and has the webhook finished writing the registry row yet?" without
// being able to fake either answer itself. Uses the anon key since it only
// reads public data.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

module.exports = async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === 'paid';

    const { data } = await supabase
      .from('global_registry')
      .select('norad_id, debris_name, dedication_name, stat')
      .eq('stripe_session_id', session_id)
      .maybeSingle();

    return res.status(200).json({
      paid,
      registered: !!data,
      metadata: {
        noradId: session.metadata?.noradId,
        type: session.metadata?.type,
        stat: session.metadata?.stat,
        exName: session.metadata?.exName,
        customMessage: session.metadata?.customMessage,
      },
    });
  } catch (err) {
    console.error('verify-session error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
