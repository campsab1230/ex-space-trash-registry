// api/manual-download.js
//
// Gated download for the PAID breakup-survival manual ($4.99 add-on).
//
// WHY THIS EXISTS, when the free sticker pack is just a plain static URL:
//   The sticker pack is a freebie, so gating it would protect zero revenue
//   while adding a lookup and a support surface. This one is different — the
//   buyer paid $4.99 for it. So the bytes are only handed over after Stripe
//   confirms THIS session was actually paid AND actually contained the add-on.
//
//   Without this, the only thing standing between a buyer and a free copy for
//   everyone they know is an unguessable filename, which is obscurity rather
//   than a gate. The file still lives at a content-hashed static path (that is
//   the same publish model as every other asset in this repo), but the site
//   never links that path directly: the success screen asks this endpoint, and
//   this endpoint checks the money first.
//
//   Honest scope note: this prevents the *site* from handing the file to
//   someone who did not pay. It does not make the static path itself
//   unreachable by a determined person who already has the URL. Making the
//   path truly private needs the PDFs kept out of the deployed static tree
//   entirely (bundled into a function or moved to private storage), which is a
//   deployment-shape change and is deliberately NOT done here.
//
// SEPARATE FROM api/coloring-download.js ON PURPOSE
//   Two different products at two different prices with two different gates.
//   Merging them into one endpoint keyed by a `product` param would mean one
//   typo in that param could hand a $4.99 book to a $3.99 buyer. Two small
//   files that each check exactly one thing are easier to be sure about.
//
// Read-only and idempotent: it never writes, never mutates the session, and
// can be called repeatedly by the same buyer (they should always be able to
// re-download something they bought).

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// The only two shapes we will ever serve. An allow-list, not a path join —
// so a crafted `kind` can never be used to walk to another file.
const MANUAL_FILES = {
  letter: '/assets/manual/breakup-manual-letter.v07f67f240c301.pdf',
  a4: '/assets/manual/breakup-manual-a4.vc3c352981b151.pdf',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id, kind } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const file = MANUAL_FILES[kind];
  if (!file) return res.status(400).json({ error: 'Unknown format' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Both conditions matter. A paid session that never bought the add-on must
    // NOT get the book, or every $2.99 certificate buyer gets a $4.99 extra for
    // free — and the reverse (unpaid session) must not either.
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'not_paid' });
    }
    if (session.metadata?.manualAddon !== 'true') {
      return res.status(403).json({ error: 'addon_not_purchased' });
    }

    // 302 rather than streaming the bytes: Vercel does not bundle arbitrary
    // repo files into a function, so reading this from disk here would 500 in
    // production. A redirect keeps the check server-side and lets the static
    // handler do what it is good at.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', file);
    return res.status(302).end();
  } catch (err) {
    // Same taxonomy as api/verify-session.js, and for the same reason: a stale
    // or replayed link is not a broken server, and reporting it as 500 sends
    // the buyer to "contact support" over a link that simply no longer
    // resolves. Keep "that id isn't a session" separate from "we are broken".
    if (err && err.type === 'StripeInvalidRequestError' && err.code === 'resource_missing') {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err && ['StripeRateLimitError', 'StripeAPIError', 'StripeConnectionError'].includes(err.type)) {
      console.error('manual-download transient:', err.type, err.message);
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    console.error('manual-download error:', err && (err.type || err.name), err && err.message);
    return res.status(500).json({ error: 'Download failed' });
  }
}
