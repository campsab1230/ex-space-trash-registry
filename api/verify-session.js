import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { session_id } = req.query;

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      const { noradId, type, stat, exName, userEmail } = session.metadata;

      // Insert record into Supabase with user email tracking
      await supabase.from('global_registry').insert([{
        norad_id: noradId,
        debris_name: type,
        dedication_name: exName,
        user_email: userEmail !== 'ANONYMOUS' ? userEmail : null,
        stripe_session_id: session_id
      }]);

      res.status(200).json({ paid: true, metadata: session.metadata });
    } else {
      res.status(200).json({ paid: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
