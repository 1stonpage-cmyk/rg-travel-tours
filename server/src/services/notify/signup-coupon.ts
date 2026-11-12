/**
 * Sign-up coupon mail (sign-up coupons plan, Task 1B-ii) — sent after
 * `newsletter.subscribe` mints or resends a `WELCOME-` code.
 *
 * ## Why this is not `notify('some_signup_event', …)`
 *
 * `NotifyPayload` (`./templates.ts`) is booking-shaped: `ref`, `tourTitle`,
 * `tourDate`, `totalCentavos` and `paidCentavos` are all REQUIRED, because
 * every `NotifyEvent` is about a booking. A sign-up coupon mail is about
 * neither a booking nor an account — exactly the reasoning
 * `./staff-password-reset.ts` and `./inquiry.ts` each give for their own
 * sender functions. So this gets its own render/send functions, built on
 * the shared `mailDocument`/`mailLink` shell every other mail in this
 * directory uses, and the SAME transport/`mailFrom`/cannot-throw/masked-
 * logging discipline.
 *
 * ## The per-email resend throttle
 *
 * Governs ONLY the repeat-signup "resend my existing code" branch in
 * `newsletter.subscribe` — a brand-new subscriber's first mail is never
 * throttled by it. Same shape as `./inquiry.ts`'s own
 * `isInquiryAckThrottled`/`recordInquiryAckSent`: an in-process
 * `Map<string, Attempts>` keyed by the lowercased, trimmed address, for the
 * identical reason — the newsletter form is a public text box, and without a
 * per-address cap it is a tool for bombing a third party's inbox with repeat
 * "here is your code" mail. See that file's own doc comment for the PM2
 * fork-mode caveat (this cap is N times weaker under cluster mode) rather
 * than repeating it here.
 */
import { mailDocument, mailLink } from './templates';
import { getTransport, mailFrom } from './transport';
import { env } from '../../env';
import { maskEmail } from '../password-reset';

/** Escapes the five characters that matter in HTML. Same set every sender in this directory escapes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Built from `PUBLIC_BASE_URL`, same as every other absolute link this system sends. */
function homeUrl(): string {
  return env.PUBLIC_BASE_URL.replace(/\/+$/, '') || '/';
}

/**
 * Rendered here, pure — no clock, no database, no network, exactly like
 * `renderTemplate` and every other render function in this directory.
 *
 * Says what the code is, that it is worth `discountPercent`% off, that it is
 * good for one booking, and that it expires. **Deliberately does not compute
 * or print an absolute date** — this function has no `now` to compute one
 * from truthfully (it is called from two different commit points, hours or
 * weeks apart in the resend case), so the copy says "within `expiryDays`
 * days of this email" instead, which is true either way it is sent.
 */
export function renderSignupCouponMail(
  code: string,
  discountPercent: number,
  expiryDays: number,
): { subject: string; html: string; text: string } {
  const subject = `Your ${discountPercent}% off code`;
  const url = homeUrl();
  const sentence =
    `It's worth ${discountPercent}% off one booking, and it's good for ${expiryDays} days ` +
    'from this email.';

  const html = mailDocument(
    `Your ${discountPercent}% off code`,
    '<p style="margin:0 0 16px 0;">Thanks for signing up. Here is your code:</p>' +
      `<p style="margin:0 0 16px 0;font-size:22px;font-weight:bold;letter-spacing:0.04em;">${escapeHtml(code)}</p>` +
      `<p style="margin:0;">${escapeHtml(sentence)}</p>` +
      mailLink(url, 'Start a booking'),
  );
  const text =
    `Thanks for signing up. Here is your code:\n\n${code}\n\n${sentence}\n\n` +
    `Start a booking: ${url}\n`;

  return { subject, html, text };
}

/** How many resend mails one address may receive within {@link SIGNUP_COUPON_RESEND_WINDOW_MS}. */
export const SIGNUP_COUPON_RESEND_MAX_PER_EMAIL = 1;
export const SIGNUP_COUPON_RESEND_WINDOW_MS = 60 * 60_000;

interface Attempts {
  count: number;
  resetAt: number;
}

/**
 * In-process, not a table — PM2 runs fork mode with a single instance, same
 * reasoning `services/password-reset.ts`'s own `byEmail` map and
 * `./inquiry.ts`'s `ackByEmail` map both give at length.
 */
const resendByEmail = new Map<string, Attempts>();

/** Lowercased and trimmed, matching `password-reset.ts`'s and `inquiry.ts`'s own `emailKey`. */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** True when this address has already received a resend this window. */
export function isSignupCouponResendThrottled(email: string, now: Date): boolean {
  const key = emailKey(email);
  const entry = resendByEmail.get(key);
  if (!entry) return false;
  if (entry.resetAt <= now.getTime()) {
    resendByEmail.delete(key);
    return false;
  }
  return entry.count >= SIGNUP_COUPON_RESEND_MAX_PER_EMAIL;
}

/** Counts one resend attempt against this address. */
export function recordSignupCouponResendSent(email: string, now: Date): void {
  const key = emailKey(email);
  const entry = resendByEmail.get(key);
  if (!entry || entry.resetAt <= now.getTime()) {
    resendByEmail.set(key, { count: 1, resetAt: now.getTime() + SIGNUP_COUPON_RESEND_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Test-only: the counter is process-global, so a suite must be able to reset it. */
export function resetSignupCouponResendThrottleForTests(): void {
  resendByEmail.clear();
}

/**
 * Sends one sign-up coupon mail, or logs why it could not. **Never throws,
 * never rejects** — same discipline as `sendStaffPasswordResetEmail` and
 * `sendInquiryAckMail`, and the same doc comment's reasoning: a mail failure
 * must never roll back or fail the request it is reporting, and this is
 * always called AFTER that request's own transaction has already committed.
 *
 * The resend throttle is enforced by the CALLER (`newsletter.subscribe`),
 * not here — unlike `sendInquiryAckMail`, which owns its own cap, this
 * function is also the one used for the FIRST mail a brand-new subscriber
 * ever gets, which must never be throttled.
 */
export async function sendSignupCouponEmail(
  to: string,
  code: string,
  discountPercent: number,
  expiryDays: number,
): Promise<void> {
  const transport = getTransport();
  const masked = maskEmail(to);

  if (!transport) {
    console.warn(`[notify] signup coupon mail queued for ${masked} — SMTP is not configured`);
    return;
  }

  try {
    const mail = renderSignupCouponMail(code, discountPercent, expiryDays);
    await transport.sendMail({
      from: mailFrom(),
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // The error's TYPE, never its message — see `./index.ts`'s module note.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[notify] signup coupon mail for ${masked} failed to send (${kind})`);
  }
}
