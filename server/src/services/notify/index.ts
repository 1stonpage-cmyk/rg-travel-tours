/**
 * `notify(event, payload)` — the only way this system sends an email
 * (Week 4 plan, Task 4).
 *
 * ## §11's rule, and the whole design follows from it
 *
 * "Failures are logged and never block the booking flow." So this function
 * **cannot throw**. Not "should rarely throw" — cannot, for any event, for
 * any transport failure, configured or not. A guest must never lose a
 * booking because an SMTP server was unreachable, and an admin must never
 * find a receipt unverified because a notification raised.
 *
 * That is why every caller can write `await notify(...)` with no try/catch
 * and no `.catch(() => {})`: the swallow lives here, once, where it is
 * tested, rather than at each call site where one person will forget.
 *
 * ## What the failure log may contain
 *
 * The event and the booking ref. Nothing else — and specifically **not the
 * underlying error's message**, which for SMTP routinely quotes the
 * credential that failed to authenticate (`535 ... for user <api-key>`).
 * Logs are read by anyone with server access and are often shipped to a
 * third-party aggregator, so a layer that logged the raw error would be
 * exporting the mail password on every misconfiguration. The error's type
 * name is kept, which is enough to tell a connection refusal from an auth
 * rejection; anything more detailed belongs in a deliberate SMTP test from
 * the server itself, which `docs/LAUNCH_CHECKLIST.md` already requires.
 *
 * ## It does not retry
 *
 * Deliberately, and this is the honest trade: a transient failure means the
 * guest does not get that email. The booking is unaffected and visible in
 * the portal, which is why §11 can treat email as best-effort at all. A
 * retry queue is real work — persistence, backoff, deduplication — and
 * building half of one (a loop with a sleep) would hold a request open and
 * make the thing it is protecting slower.
 */
import { getTransport, mailFrom } from './transport';
import { renderTemplate, type NotifyEvent, type NotifyPayload } from './templates';

export { NOTIFY_EVENTS, renderTemplate } from './templates';
export type { NotifyEvent, NotifyPayload, RenderedMail } from './templates';
export { setTransportForTests, resetTransportForTests } from './transport';
export type { MailTransport } from './transport';
/*
 * §12's self-service password reset mail (task 1C). Its own sender rather
 * than another `NotifyEvent`, because `NotifyPayload` is booking-shaped —
 * see `./staff-password-reset.ts`. Re-exported here so a caller imports from
 * `services/notify` like everything else, and so the cannot-throw discipline
 * is advertised in one place.
 */
export { sendStaffPasswordResetEmail, renderStaffPasswordResetMail } from './staff-password-reset';
/*
 * §1C's contact-form inquiry mail (owner decision 2026-11-11, Task 3). Its
 * own senders rather than another `NotifyEvent`, for the same reason the
 * staff password reset mail above has its own — see `./inquiry.ts`.
 */
export {
  sendInquiryOfficeMail,
  sendInquiryAckMail,
  renderInquiryOfficeMail,
  renderInquiryAckMail,
  isInquiryAckThrottled,
  recordInquiryAckSent,
  resetInquiryAckThrottleForTests,
  INQUIRY_ACK_MAX_PER_EMAIL,
  INQUIRY_ACK_WINDOW_MS,
  type InquiryMailFields,
} from './inquiry';
/*
 * Sign-up coupons plan, Task 1B-ii. Its own sender rather than another
 * `NotifyEvent`, for the same reason the two senders above have their own —
 * see `./signup-coupon.ts`.
 */
export {
  sendSignupCouponEmail,
  renderSignupCouponMail,
  isSignupCouponResendThrottled,
  recordSignupCouponResendSent,
  resetSignupCouponResendThrottleForTests,
  SIGNUP_COUPON_RESEND_MAX_PER_EMAIL,
  SIGNUP_COUPON_RESEND_WINDOW_MS,
} from './signup-coupon';

/**
 * Sends one notification, or logs why it could not. Never throws, never
 * rejects.
 */
export async function notify(event: NotifyEvent, payload: NotifyPayload): Promise<void> {
  const transport = getTransport();

  if (!transport) {
    // Not an error: the app is expected to run without SMTP configured.
    console.warn(`[notify] ${event} for ${payload.ref} not sent — SMTP is not configured`);
    return;
  }

  try {
    const mail = renderTemplate(event, payload);
    await transport.sendMail({
      from: mailFrom(),
      to: payload.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    /*
     * The event, the ref, and the error's TYPE. Never its message — see the
     * module note: SMTP failures quote credentials.
     */
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[notify] ${event} for ${payload.ref} failed to send (${kind})`);
  }
}
