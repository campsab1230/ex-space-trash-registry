// lib/gift-email.js
//
// Builds the gift-delivery email. Kept OUT of api/ on purpose: everything in
// api/ becomes a public route, and a module that only exists to produce a string
// has no business being reachable over HTTP.
//
// This is the only message the site ever sends to someone who did not ask for
// it, so the rules it follows are deliberate:
//
//   * NO PRICE. The recipient is the punchline, not the customer. Showing what
//     their ex paid turns a gag into a receipt.
//   * The buyer cannot author the body. Only the ex's name, the object and an
//     optional short message reach the template — all of them escaped. There is
//     no free-text field, so this can never be used as an open relay to send
//     arbitrary text to a stranger.
//   * Every message carries an opt-out. Being named is the joke; being unable to
//     make it stop is not.
//   * Plain-text alternative is always sent. HTML-only mail is a spam signal and
//     some clients will not render it at all.

const SITE = 'https://www.exspacetrash.com';

// Escape anything that came from a human before it touches HTML. The ex's name
// is buyer-supplied and the debris name comes from our own catalogue, but both
// go through this — one of them will be untrusted one day, and this is the exact
// place where that becomes an injection.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A "From: Name <addr>" pair is split so the display name can be quoted safely.
// An unquoted comma in a display name is a header-injection vector.
function parseFrom(raw) {
  const fallback = { name: 'ExSpaceTrash', address: 'gifts@exspacetrash.com' };
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const m = s.match(/^(.*?)<([^>]+)>\s*$/);
  if (!m) {
    // Bare address, or something we do not understand — use it as the address
    // and keep the brand name.
    return /@/.test(s) ? { name: fallback.name, address: s } : fallback;
  }
  return { name: m[1].trim() || fallback.name, address: m[2].trim() };
}

export function buildGiftEmail({ exName, debrisName, noradId, customMessage } = {}) {
  const who = String(exName || 'SOMEONE').slice(0, 30);
  const what = String(debrisName || 'a piece of orbital debris').slice(0, 120);
  const id = String(noradId || '').slice(0, 20);
  const note = String(customMessage || '').slice(0, 25).trim();

  const claimUrl = id ? `${SITE}/trash/${encodeURIComponent(id)}` : SITE;

  const subject = `Someone named a real piece of space junk after you`;

  const lines = [
    `Someone has officially associated you with a real, publicly-tracked piece of orbital debris.`,
    ``,
    `The object: ${what}${id ? ` (NORAD #${id})` : ''}`,
    `Registered to: ${who}`,
  ];
  if (note) lines.push(`Their note: "${note}"`);
  lines.push(
    ``,
    `It is catalogued, it is in orbit right now, and it is not coming back.`,
    `See it here: ${claimUrl}`,
    ``,
    `We sent this on behalf of a customer who paid us to deliver it. We have not`,
    `shared their details with you, and we never will.`,
    ``,
    `Do not want to hear from us again? Reply to this message and we will block`,
    `this address from any future delivery.`,
    ``,
    `ExSpaceTrash — a novelty service. Not affiliated with NASA, NORAD, or any`,
    `space agency. The debris is real; the association is not official.`
  );

  const text = lines.join('\n');

  const row = (label, value) =>
    `<div style="margin:0 0 14px;">
      <div style="font:600 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#8ab4f8;">${esc(label)}</div>
      <div style="font:700 20px/1.35 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#efc84e;word-break:break-word;">${esc(value)}</div>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#020208;">
<div style="background:#020208;padding:28px 18px;">
  <div style="max-width:560px;margin:0 auto;border:2px solid #4ef2d2;border-radius:12px;background:#07070f;padding:26px 24px;">
    <div style="font:700 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.2em;color:#4ef2d2;margin-bottom:20px;">EXSPACETRASH.COM</div>
    <div style="font:800 26px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;margin-bottom:20px;">Someone named a real piece of space junk after you.</div>
    <p style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#c9c9d4;margin:0 0 20px;">It is catalogued, it is in orbit right now, and it is not coming back.</p>
    ${row('The object', `${what}${id ? ` — NORAD #${id}` : ''}`)}
    ${row('Registered to', who)}
    ${note ? row('Their note', `“${note}”`) : ''}
    <div style="margin:24px 0 6px;">
      <a href="${esc(claimUrl)}" style="display:inline-block;background:#efc84e;color:#000;font:700 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-decoration:none;padding:14px 22px;border-radius:6px;">SEE IT IN ORBIT</a>
    </div>
    <hr style="border:none;border-top:1px dashed #2a2a3a;margin:24px 0;">
    <p style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8a8a99;margin:0 0 10px;">We sent this on behalf of a customer who paid us to deliver it. We have not shared their details with you, and we never will.</p>
    <p style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8a8a99;margin:0 0 10px;">Do not want to hear from us again? Reply to this message and we will block this address from any future delivery.</p>
    <p style="font:400 11px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#5a5a68;margin:0;">ExSpaceTrash — a novelty service. Not affiliated with NASA, NORAD, or any space agency. The debris is real; the association is not official.</p>
  </div>
</div>
</body></html>`;

  return { subject, html, text, from: parseFrom(process.env.GIFT_EMAIL_FROM) };
}

// The provider call, isolated so the webhook reads as orchestration and so a
// failure can be classified (permanent vs transient) in exactly one place.
//
// Classifying matters: a bad address will fail identically forever, so retrying
// it only produces noise — but a network blip or a provider 5xx will succeed on
// a second attempt, and Stripe's webhook retries are a free retry queue. So the
// caller needs to know which one it got.
export async function sendGiftEmail({ to, mail, replyTo }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, permanent: false, error: 'RESEND_API_KEY is not set' };
  }

  const payload = {
    from: `${mail.from.name} <${mail.from.address}>`,
    to: [to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };
  if (replyTo) payload.reply_to = replyTo;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    let body = {};
    try { body = JSON.parse(bodyText); } catch { /* non-JSON error page */ }

    if (resp.ok) {
      return { ok: true, providerId: body && body.id ? String(body.id) : null };
    }

    // 4xx = the request itself is wrong (bad address, unverified domain, bad
    // key). Repeating it changes nothing. 5xx and 429 are worth another go.
    const permanent = resp.status >= 400 && resp.status < 500 && resp.status !== 429;
    return {
      ok: false,
      permanent,
      error: `provider ${resp.status}: ${String(bodyText || '').slice(0, 300)}`,
    };
  } catch (err) {
    // A throw here is a network/DNS failure — transient by definition.
    return { ok: false, permanent: false, error: `network: ${err && err.message}` };
  }
}
