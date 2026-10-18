import fs from 'fs';
import { buildGiftEmail } from '../lib/gift-email.js';

let failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// Resolve relative to this test file so it runs from any working directory.
const file = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const exists = (rel) => fs.existsSync(new URL(rel, import.meta.url));

const idx = file('../certificate-app.html');
const co  = file('../api/create-checkout.js');
const wh  = file('../api/stripe-webhook.js');
const trk = file('../api/track.js');
const legal = file('../legal.html');
const mig = file('../migrations/004_gift_email.sql');

// ===========================================================================
// 1. THE PRICE AGREES ACROSS CLIENT AND SERVER
//
// The gift fee is charged on the server and displayed on the client. If those
// two drift, the buyer is shown one number and billed another — the exact class
// of bug check-pricing.mjs exists for, so it is checked here for the same reason.
// ===========================================================================
const num = (src, re, label) => {
  const m = src.match(re);
  if (!m) { failures.push(`could not find ${label}`); return null; }
  return Number(m[1]);
};
const coGift  = num(co,  /const EMAIL_ADDON_PRICE = ([\d.]+)/, 'checkout EMAIL_ADDON_PRICE');
const idxGift = num(idx, /const EMAIL_ADDON_PRICE = ([\d.]+)/, 'index EMAIL_ADDON_PRICE');

ok(coGift === 4.99, `gift add-on is ${coGift}, expected 4.99`);
ok(idxGift === coGift, `EMAIL_ADDON_PRICE mismatch: index=${idxGift} checkout=${coGift}`);

// The gift fee must be an ADD-ON, not a bundle total. If it ever replaces the
// base instead of adding to it, a buyer on a printed tier would be charged LESS
// for the gift than a digital buyer — and the printed total would silently stop
// matching the advertised $19.99/$29.99.
ok(/\+ \(isEmailAddonSelected\(\) \? EMAIL_ADDON_PRICE : 0\)/.test(idx),
   'client total no longer ADDS the gift fee (it must be an add-on, not a replacement)');
// Both add-ons coexist: buying the gift must not drop the emoji charge.
ok(/\+ \(isEmojiAddonSelected\(\) \? EMOJI_ADDON_PRICE : 0\)/.test(idx),
   'client total no longer adds the emoji fee — the two add-ons must stack');

// ===========================================================================
// 2. THE SERVER REFUSES TO SELL A DELIVERY IT CANNOT MAKE
//
// The dangerous failure here is silent: accept the checkbox, ignore the bad
// address, keep the $4.99. So the server must 400 rather than downgrade — a
// rejection is visible and fixable, a quiet downgrade is just theft.
// ===========================================================================
ok(/wantsGiftEmail && \(rawRecipient\.length > 254 \|\| !RECIPIENT_RE\.test\(rawRecipient\)\)/.test(co),
   'server no longer rejects a gift purchase with a missing/invalid recipient');
ok(/status\(400\)\.json\(\{ error: 'Please enter a valid email address/.test(co),
   'server does not 400 on a bad gift recipient (it must not silently downgrade the order)');
ok(/const RECIPIENT_RE = /.test(co), 'server lost its recipient validation pattern');
ok(/const cleanRecipient = wantsGiftEmail \? rawRecipient : ''/.test(co),
   'recipient is no longer cleared when the add-on is not selected');

// The client mirrors the server rule so the buyer finds out before the redirect.
ok(/function isValidRecipient\(/.test(idx), 'client lost its recipient validation helper');
ok(/emailAddonSelected && !isValidRecipient\(recipientEmail\)/.test(idx),
   'client no longer blocks checkout on an invalid gift recipient');

// ===========================================================================
// 3. THE MONEY REACHES STRIPE, AND THE ADDRESS SURVIVES TO THE WEBHOOK
// ===========================================================================
ok(/unit_amount: Math\.round\(EMAIL_ADDON_PRICE \* 100\)/.test(co),
   'server no longer charges EMAIL_ADDON_PRICE as its own line item');
ok(/giftEmail: wantsGiftEmail \? 'true' : 'false'/.test(co),
   'checkout no longer records giftEmail in Stripe metadata');
ok(/recipientEmail: cleanRecipient/.test(co),
   'checkout no longer records the recipient in Stripe metadata');
// Duplicating the address into metadata is deliberate: if migration 004 is
// missing, the delivery can still be recovered from Stripe by hand. Losing the
// address would make a paid delivery permanently unmakeable.
ok(/recipientEmail/.test(wh), 'webhook cannot read the recipient — a paid delivery would be unrecoverable');

// ===========================================================================
// 4. ONE PURCHASE, ONE EMAIL — the anti-abuse core
//
// Stripe retries webhooks. The send happens BEFORE the result is recorded, so
// without a uniqueness constraint a retry lands between the two and a stranger
// gets a second unsolicited email. A uniqueness constraint is the only thing
// that actually prevents this; a "have we sent it?" read cannot.
// ===========================================================================
ok(/stripe_session_id TEXT NOT NULL UNIQUE/.test(mig),
   'migrations/004 lost UNIQUE(stripe_session_id) — a Stripe retry could send a DUPLICATE email to a stranger');
ok(/23505/.test(wh), 'webhook no longer treats a duplicate-key error as "already delivered"');

// The gift block must sit AFTER the paid check, or an unpaid session could send mail.
const paidCheckAt = wh.indexOf("session.payment_status !== 'paid'");
const giftSendAt  = wh.indexOf('buildGiftEmail(');
ok(paidCheckAt !== -1 && giftSendAt !== -1 && giftSendAt > paidCheckAt,
   'the gift email is sent BEFORE the payment_status check — mail could go out for an unpaid session');

// Only a transient failure may be retried. A permanent one (bad address, bad
// key) fails identically forever, so retrying it only makes noise.
ok(/if \(!result\.permanent\)/.test(wh),
   'webhook no longer distinguishes transient from permanent send failures');
ok(/return res\.status\(500\)\.json\(\{ error: 'Gift delivery failed, retry requested' \}\)/.test(wh),
   'a transient send failure is no longer handed back to Stripe to retry');

// ===========================================================================
// 5. THE EMAIL ITSELF — asserted against real rendered output, not greps
//
// The template is the one artifact here a human never sees before a stranger
// does, so it is imported and rendered rather than pattern-matched in source.
// ===========================================================================
const mail = buildGiftEmail({
  exName: 'JORDAN',
  debrisName: 'COSMOS 2251 DEB',
  noradId: '35786',
  customMessage: 'NICE KNOWING YOU',
});

const rendered = `${mail.subject}\n${mail.html}\n${mail.text}`;

// A price in this email turns a gag into a receipt. The recipient is the
// punchline, not the customer — they should never learn what their ex paid.
ok(!/\$\s?\d/.test(rendered),
   'the gift email contains a price — the recipient must never see what the buyer paid');
ok(!/\b(2\.99|4\.99|19\.99|29\.99)\b/.test(rendered),
   'the gift email contains a price-shaped number');

// Escaping. The ex's name is buyer-supplied; this is exactly where that becomes
// an injection into someone else's inbox.
const hostile = buildGiftEmail({
  exName: '<script>alert(1)</script>',
  debrisName: '<img src=x onerror=alert(1)>',
  noradId: '1',
  customMessage: '<b>hi</b>',
});
ok(!/<script/i.test(hostile.html), 'a <script> tag from the ex-name field reached the email HTML unescaped');
// Check for a RAW TAG, not the substring "onerror=". Escaping turns
// `<img src=x onerror=...>` into `&lt;img src=x onerror=...&gt;` — the words
// "onerror=" survive inside the escaped text, which is harmless and is exactly
// what correct escaping looks like. Asserting on the substring flagged good
// output as a failure. What matters is that no live tag survives.
ok(!/<img/i.test(hostile.html), 'a raw <img> tag from the debris name reached the email HTML unescaped');
ok(!/<[a-z]/i.test(hostile.html.replace(/<html|<head|<meta|<title|<body|<div|<p|<a |<hr|<span|<!DOCTYPE/gi, '')),
   'a raw HTML tag from user input survived into the email body');
ok(/&lt;script&gt;/.test(hostile.html), 'hostile input is not being escaped (expected entity-encoded output)');
ok(/&lt;img/.test(hostile.html), 'hostile debris name is not being escaped');

// An opt-out must exist, and it must be promised in BOTH parts — a text-only
// client sees only `text`, and this is the one message with a real legal edge.
ok(/opt-out|Do not want to hear from us again/i.test(mail.text),
   'the plain-text gift email lost its opt-out');
ok(/Do not want to hear from us again/i.test(mail.html),
   'the HTML gift email lost its opt-out');

// HTML-only mail is a spam signal and some clients refuse to render it.
ok(typeof mail.text === 'string' && mail.text.trim().length > 100,
   'the gift email has no usable plain-text alternative');
ok(/<html/i.test(mail.html), 'the gift email has no HTML body');

// The buyer must not be exposed to the recipient.
ok(!/JORDAN/.test(mail.text.split('Do not want')[0].replace(/Registered to: JORDAN/, '')),
   'sanity: the recipient sees only the dedication, never the buyer');

// The claim link must be absolute — a relative URL is dead in an inbox.
ok(/https:\/\/www\.exspacetrash\.com\/trash\/35786/.test(mail.text),
   'the gift email does not link to the claim with an absolute URL');

// The From header is split so an unquoted comma cannot inject a header.
ok(/function parseFrom\(/.test(file('../lib/gift-email.js')),
   'the From header is no longer parsed/quoted — an unquoted display name is a header-injection vector');

// ===========================================================================
// 6. lib/ MUST NOT BE ROUTABLE
//
// Everything under api/ becomes a public endpoint on Vercel. A module that only
// builds a string has no business being reachable, so it lives in lib/ — and if
// someone "helpfully" moves it into api/, this fails.
// ===========================================================================
ok(exists('../lib/gift-email.js'), 'lib/gift-email.js is missing');
ok(!exists('../api/gift-email.js'),
   'gift-email.js was moved into api/ — that makes the email template a public endpoint');

// lib/ is NOT a route, but it IS publicly readable: this project serves the repo
// root statically, and /lib/gift-email.js was verified live returning 200 with
// the real source. That is harmless while the file holds only `process.env`
// NAMES — but a literal credential pasted in "just to test" would be published
// to the open internet. Assert no secret VALUES, while allowing env var names.
const giftSrc = file('../lib/gift-email.js');
const SECRET_VALUE_PATTERNS = [
  [/re_[A-Za-z0-9]{16,}/, 'a literal Resend API key'],
  [/sk_live_[A-Za-z0-9]{10,}/, 'a literal Stripe live secret key'],
  [/sk_test_[A-Za-z0-9]{10,}/, 'a literal Stripe test secret key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'a literal JWT (e.g. a Supabase service-role key)'],
  [/whsec_[A-Za-z0-9]{10,}/, 'a literal Stripe webhook signing secret'],
];
for (const [re, label] of SECRET_VALUE_PATTERNS) {
  ok(!re.test(giftSrc),
     `lib/gift-email.js contains ${label} — lib/ is served publicly, so that credential is now on the open internet`);
}
// Guard the guard: the file must still reference the env var it needs, or the
// secret check above would pass simply because the file stopped reading config.
ok(/process\.env\.RESEND_API_KEY/.test(giftSrc),
   'lib/gift-email.js no longer reads RESEND_API_KEY from the environment');
ok(/process\.env\.GIFT_EMAIL_FROM/.test(giftSrc),
   'lib/gift-email.js no longer reads GIFT_EMAIL_FROM from the environment');

// ===========================================================================
// 7. THE SEND IS VISIBLE AFTERWARDS
//
// "The email never arrived" is otherwise unanswerable: nothing else records that
// a delivery was even attempted, and a buyer who paid $4.99 would be told to
// check their spam folder forever.
// ===========================================================================
ok(/CREATE TABLE IF NOT EXISTS gift_emails/.test(mig), 'migrations/004 no longer creates gift_emails');
ok(/ENABLE ROW LEVEL SECURITY/.test(mig), 'gift_emails is not RLS-enabled');
ok(/USING \(false\)/.test(mig), 'gift_emails has no explicit anon deny policy');
ok(/recipient_email\s+TEXT NOT NULL/.test(mig), 'gift_emails no longer stores the recipient');
ok(/error\s+TEXT/.test(mig), 'gift_emails no longer stores the provider error (failures become invisible)');

// A missing table must never cost the buyer their purchase.
ok(/giftTableMissing/.test(wh) && /migrations\/004 has not been applied/.test(wh),
   'webhook no longer degrades gracefully when migration 004 is missing');
ok(/Gift delivery threw \(sale is unaffected\)/.test(wh),
   'a thrown gift error is no longer contained — it could fail a completed purchase');

// ===========================================================================
// 8. THE FUNNEL CAN SEE IT
//
// /api/track silently 204s any event not on its allow-list, so a new event that
// is not registered is not an error — it is simply invisible.
// ===========================================================================
ok(/'email_addon_toggled'/.test(trk), 'email_addon_toggled is not allow-listed in /api/track');
ok(/track\('email_addon_toggled'/.test(idx), 'the client no longer emits email_addon_toggled');

// ===========================================================================
// 9. THE UI EXISTS AND IS WIRED
// ===========================================================================
ok(/id="enable-email-addon"/.test(idx), 'the gift checkbox is missing from the purchase modal');
ok(/id="gift-recipient-input"/.test(idx), 'the recipient input is missing from the purchase modal');
ok(/function toggleEmailAddon\(\)/.test(idx), 'toggleEmailAddon() is missing');
ok(/onchange="toggleEmailAddon\(\)"/.test(idx), 'the gift checkbox is not wired to toggleEmailAddon()');
ok(/id="success-gift-note"/.test(idx), 'the success modal has no gift confirmation');
ok(/emailGift: emailAddonSelected/.test(idx), 'the client does not send emailGift');
ok(/recipientEmail: recipientEmail/.test(idx), 'the client does not send recipientEmail');

// The success note must not overclaim. The email is sent by the webhook, which
// may still be in flight or may have failed — telling the buyer it "has been
// sent" would be a promise the site cannot keep.
const giftNote = (idx.match(/id="success-gift-note"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
ok(/on its way/i.test(giftNote),
   'the success note no longer says "on its way" — do not claim a delivery that has not been confirmed');

// ===========================================================================
// 10. THE LEGAL PAGE DISCLOSES IT
//
// This is the only feature that emails a third party, so the terms have to say
// so — and have to put the responsibility for the recipient on the buyer.
// ===========================================================================
ok(/gift|email/i.test(legal), 'legal.html does not mention the email delivery');
ok(/opt.out|unsubscribe|block/i.test(legal), 'legal.html does not mention the recipient opt-out');

if (failures.length) {
  console.error('\n❌ FAILURES:'); failures.forEach(f => console.error('  -', f));
  process.exit(1);
}
console.log('\n✅ gift email is priced, gated, idempotent, escaped, and recorded');
