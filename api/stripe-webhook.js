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
//
// FIX #1 (the outage): this project is "type": "module" (ESM). This file used
//   require()/module.exports, which throws "require is not defined" at load
//   time — every request 500'd before any logic ran. Converted to ESM.
//   Note the ESM form of the body-parser opt-out is a named export:
//   `export const config = ...` (not `module.exports.config = ...`).
//
// FIX #2: the old version wrote the registry row without first checking
//   session.payment_status. A completed session is not always a paid one
//   (e.g. some delayed payment methods), so a claim could be granted for
//   money that never arrived.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Vercel-specific: disable the default body parser so we can verify the
// raw request body against the Stripe signature (signature verification
// fails if the body has been touched/reserialized).
export const config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

export default async function handler(req, res) {
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
    const { noradId, type, stat, exName, customMessage, emojiOverlay } = session.metadata || {};

    if (!noradId || !exName) {
      console.error('Webhook missing expected metadata', session.id);
      return res.status(200).json({ received: true }); // ack so Stripe doesn't retry forever
    }

    // Do not grant a claim for an unpaid session.
    if (session.payment_status !== 'paid') {
      console.log('Session not paid — ignoring', session.id, session.payment_status);
      return res.status(200).json({ received: true, ignored: 'unpaid' });
    }

    try {
      const baseRow = {
        norad_id: noradId,
        debris_name: type,
        dedication_name: exName,
        stat: stat,
        custom_message: customMessage || null,
        emoji_overlay: emojiOverlay || null,
        stripe_session_id: session.id,
      };

      // Which certificate artwork the buyer picked, validated against the two
      // templates that actually exist. Anything unexpected becomes 'a'.
      const template = (session.metadata && session.metadata.certificateTemplate === 'b') ? 'b' : 'a';

      // IMPORTANT — graceful degradation, do not remove this.
      // `certificate_template` arrives with migration 002. If that migration has
      // not been applied yet, PostgREST rejects the ENTIRE insert because of one
      // unknown column — and a customer who has already paid would end up with
      // no claim at all. A missing column must never cost someone their
      // purchase, so on that specific error we simply retry without the column.
      // The choice is not lost either: it is still readable from Stripe metadata.
      let { error } = await supabase
        .from('global_registry')
        .insert([Object.assign({ certificate_template: template }, baseRow)]);

      const msg = (error && error.message) || '';
      const missingColumn = !!error && (
        error.code === 'PGRST204' ||
        error.code === '42703' ||
        /could not find the 'certificate_template' column/i.test(msg) ||
        /column .*certificate_template.* does not exist/i.test(msg)
      );
      if (missingColumn) {
        console.warn('certificate_template column is missing — apply migrations/002. Recording the claim without it so the buyer is not lost.');
        ({ error } = await supabase.from('global_registry').insert([baseRow]));
      }

      // 23505 = unique_violation — object was already claimed (shouldn't
      // normally happen thanks to the pending_claims lock, but this makes
      // the insert idempotent if Stripe retries the webhook).
      if (error && error.code !== '23505') {
        console.error('Failed to write registry row:', error);
        // Do NOT clear the lock if we failed to record the sale.
        return res.status(500).json({ error: 'Internal error processing webhook' });
      }
      if (error && error.code === '23505') {
        console.warn('Duplicate webhook delivery for session', session.id, '— already recorded.');
      }

      await supabase.from('pending_claims').delete().eq('norad_id', noradId);
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
      // Return 500 so Stripe retries the webhook later
      return res.status(500).json({ error: 'Internal error processing webhook' });
    }
  }

  return res.status(200).json({ received: true });
}
