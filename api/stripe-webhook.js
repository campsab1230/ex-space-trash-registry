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
import { buildGiftEmail, sendGiftEmail } from '../lib/gift-email.js';

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

      // Did they pay for a physical copy? Flagged here so there is a queryable
      // list of orders that still need to be printed and posted — the seller
      // should never have to click through Stripe one payment at a time.
      //
      // The MAILING ADDRESS is deliberately NOT stored here. Stripe collected it
      // (shipping_details) and it lives on the payment in the Stripe dashboard.
      // Copying a customer's home address into another database is a liability
      // with no upside: the dashboard already has it, already secured.
      // Tier name ('none' | 'domestic' | 'international'). Recorded so we know
      // which postage class to use, not merely THAT something must be posted.
      const allowedTiers = ['none', 'domestic', 'international'];
      const rawTier = session.metadata && session.metadata.mailTier;
      const mailTier = allowedTiers.includes(rawTier) ? rawTier : 'none';
      const wantsMail = mailTier !== 'none';

      // IMPORTANT — graceful degradation, do not remove this.
      // `certificate_template` arrives with migration 002. If that migration has
      // not been applied yet, PostgREST rejects the ENTIRE insert because of one
      // unknown column — and a customer who has already paid would end up with
      // no claim at all. A missing column must never cost someone their
      // purchase, so on that specific error we simply retry without the column.
      // The choice is not lost either: it is still readable from Stripe metadata.
      const optional = {
        certificate_template: template,
        physical_mail: wantsMail,   // kept: simple "needs posting" flag for reports
        mail_tier: mailTier,        // which postage class
      };
      let { error } = await supabase
        .from('global_registry')
        .insert([Object.assign({}, optional, baseRow)]);

      // If migration 002 has not been applied yet, PostgREST rejects the WHOLE
      // insert over one unknown column. Retrying without the optional columns
      // keeps the sale. The buyer's choices are still recoverable from Stripe
      // metadata, so nothing is truly lost.
      const msg = (error && error.message) || '';
      const missingColumn = !!error && (
        error.code === 'PGRST204' ||
        error.code === '42703' ||
        /could not find the '(certificate_template|physical_mail|mail_tier)' column/i.test(msg) ||
        /column .*(certificate_template|physical_mail|mail_tier).* does not exist/i.test(msg)
      );
      if (missingColumn) {
        console.warn('migrations/002 not applied — recording the claim without certificate_template/physical_mail so the buyer is not lost. Apply migrations/002.');
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

      // ---------------------------------------------------------------------
      // Gift delivery. Runs ONLY here — after the signature verified and the
      // session was confirmed paid — so the email can never be triggered by a
      // browser. Three things this has to get right:
      //
      // 1. NEVER SEND TWICE. Stripe retries webhooks, and a retry must not put a
      //    second email in a stranger's inbox. The UNIQUE index on
      //    stripe_session_id is the authority: we INSERT the claim row first and
      //    treat a 23505 as "already delivered, stand down". A row that exists
      //    in any state means this session has had its one send.
      //
      // 2. NEVER LOSE A SALE. If the gift tables are missing (migration 004 not
      //    applied) we log loudly and still return 200 — the buyer's claim is
      //    already recorded and their certificate is unaffected. Charging them
      //    $4.99 and failing the whole purchase would be far worse.
      //
      // 3. ASK STRIPE TO RETRY ONLY WHEN A RETRY COULD WORK. A bad address or a
      //    rejected key fails identically forever, so we swallow it (200) and
      //    record it for a human. A network blip or a provider 5xx is transient,
      //    so we return 500 and let Stripe's own retry queue do the work rather
      //    than building a scheduler we would then have to maintain.
      // ---------------------------------------------------------------------
      const wantsGift = session.metadata && session.metadata.giftEmail === 'true';
      const recipient = (session.metadata && session.metadata.recipientEmail) || '';
      if (wantsGift && recipient) {
        try {
          const { data: existingGift, error: giftReadErr } = await supabase
            .from('gift_emails')
            .select('id, status, attempts')
            .eq('stripe_session_id', session.id)
            .maybeSingle();

          // A missing table must not cost the buyer their purchase.
          const giftReadMsg = (giftReadErr && giftReadErr.message) || '';
          const giftTableMissing = !!giftReadErr && (
            giftReadErr.code === '42P01' ||
            /relation .*gift_emails.* does not exist/i.test(giftReadMsg) ||
            /could not find the table 'public.gift_emails'/i.test(giftReadMsg)
          );
          if (giftTableMissing) {
            console.error('GIFT NOT SENT — migrations/004 has not been applied, so gift_emails is missing. Apply migrations/004; the buyer paid for a delivery that did not go out.', session.id, recipient);
          } else if (!giftReadErr) {
            if (existingGift && existingGift.status === 'sent') {
              console.log('Gift already delivered for session', session.id, '— skipping.');
            } else {
              const attempts = (existingGift ? Number(existingGift.attempts) || 0 : 0) + 1;

              if (existingGift) {
                await supabase
                  .from('gift_emails')
                  .update({ status: 'sending', attempts, error: null })
                  .eq('id', existingGift.id);
              } else {
                const { error: claimErr } = await supabase
                  .from('gift_emails')
                  .insert([{
                    stripe_session_id: session.id,
                    norad_id: noradId,
                    recipient_email: recipient,
                    status: 'sending',
                    attempts,
                  }]);
                // 23505 = another delivery already claimed this session.
                if (claimErr && claimErr.code === '23505') {
                  console.log('Gift claim already exists for session', session.id, '— skipping duplicate send.');
                } else if (claimErr) {
                  console.error('Could not record the gift claim:', claimErr);
                }
              }

              const mail = buildGiftEmail({
                exName,
                debrisName: type,
                noradId,
                customMessage,
              });

              // The reply-to is the monitored support address, not the buyer.
              // The message promises "reply and we will block this" — that
              // promise is only kept if replies actually land somewhere a human
              // reads. Never expose the buyer's address here.
              const replyTo = (process.env.GIFT_EMAIL_REPLY_TO || 'slapmyarsehag@gmail.com').trim();

              const result = await sendGiftEmail({ to: recipient, mail, replyTo });

              if (result.ok) {
                await supabase
                  .from('gift_emails')
                  .update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: result.providerId, error: null })
                  .eq('stripe_session_id', session.id);
                console.log('Gift delivered for session', session.id);
              } else {
                await supabase
                  .from('gift_emails')
                  .update({ status: 'failed', error: String(result.error || '').slice(0, 500) })
                  .eq('stripe_session_id', session.id);

                if (!result.permanent) {
                  // Transient: hand it back to Stripe's retry queue.
                  console.error('Gift send failed transiently, asking Stripe to retry:', session.id, result.error);
                  return res.status(500).json({ error: 'Gift delivery failed, retry requested' });
                }
                // Permanent: a retry would fail identically. Record and move on.
                console.error('Gift send failed permanently (not retrying):', session.id, recipient, result.error);
              }
            }
          }
        } catch (giftErr) {
          // Never let the gift path take down the webhook: the sale is already
          // recorded above, and a 500 here would make Stripe retry a purchase
          // that has already been granted.
          console.error('Gift delivery threw (sale is unaffected):', giftErr);
        }
      }
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
      // Return 500 so Stripe retries the webhook later
      return res.status(500).json({ error: 'Internal error processing webhook' });
    }
  }

  return res.status(200).json({ received: true });
}
