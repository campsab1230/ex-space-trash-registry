// api/verify-session.js
//
// Read-only. Lets the frontend check "did this Stripe session actually get
// paid, and has the webhook finished writing the registry row yet?" without
// being able to fake either answer itself. Uses the anon key since it only
// reads public data.
//
// FIX: this project is "type": "module" (ESM). This file previously used
// require()/module.exports, which throws "require is not defined" at load
// time — before a single line of logic ran — producing a blanket 500 on
// every request. Converted to ESM. Logic is otherwise unchanged.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
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
        emojiOverlay: session.metadata?.emojiOverlay,
        certificateTemplate: session.metadata?.certificateTemplate,
      },
    });
  } catch (err) {
    console.error('verify-session error:', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
}
