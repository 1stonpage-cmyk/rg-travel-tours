/**
 * Email templates (Week 4 plan, Task 4; completed Week 7 Task 14) — §11's
 * "plain, branded HTML".
 *
 * **All seven §11 events, and every one of them has a caller.** Four came
 * from Phase 1's flows: a confirmed booking, a receipt received, a payment
 * rejected, and the admin's "there is a receipt to verify". The remaining
 * three were deliberately absent until their callers existed, on the rule
 * that a template with no caller is a template nobody keeps accurate — Week 7
 * Task 14 built those callers, so the templates landed with them:
 *
 *  - `driver_assigned` — `admin.dispatch.assign`, after its transaction
 *    commits (`routers/admin/dispatch.ts`).
 *  - `trip_reminder` — `jobs/trip-reminders.ts`, 16:00 Manila the day before.
 *  - `review_request` — `jobs/review-requests.ts`, 07:00 Manila the morning
 *    after (owner decision 2026-10-23, Q5).
 *
 * ## Plain HTML, inline styles, tables
 *
 * Not a taste choice. Email clients strip `<style>` blocks, ignore
 * stylesheets, and Outlook's renderer predates flexbox — so a branded email
 * is inline styles on tables or it is a broken email. Every template is
 * also a complete document rather than a fragment, because a mail client is
 * not a browser and will not repair one.
 *
 * ## The brand rules apply here too
 *
 * Blue ink, gold accent, **no red anywhere** — including the rejection
 * email, which is the one place the temptation is strongest. A rejected
 * receipt is a warning, so it is amber, exactly as the site's own copy
 * would be. `client/src/__tests__/no-red.test.ts` cannot see this file, so
 * `notify.test.ts` carries the check.
 *
 * ## Money comes from `formatPeso`
 *
 * Never a division or a `toFixed` here. One formatter for the whole system,
 * so an email and the page it links to can never disagree about what a
 * guest owes.
 *
 * ## The one link, and why it points at the SIGN-IN screen
 *
 * `trip_reminder` and `review_request` both send a guest to
 * `/portal/login?ref=…`, never to `/portal/booking?ref=…`.
 * `PortalBookingPage` reads its booking from an active SESSION and takes no
 * `ref` parameter at all, so the second URL shows a signed-out guest nothing.
 * `PortalLoginPage` reads `?ref=` to prefill the reference, the guest still
 * proves ref + email (owner decision 2026-10-23, Q5 — no new auth path), and
 * its own `safeNext()` lands them on My Booking afterwards.
 */
import { formatPeso } from '@rg/shared';
import { env } from '../../env';

/** The events Phase 1 sends. */
export const NOTIFY_EVENTS = [
  'booking_confirmed',
  'receipt_received',
  'payment_rejected',
  'admin_receipt_to_verify',
  'driver_assigned',
  'trip_reminder',
  'review_request',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface NotifyPayload {
  /** The recipient. The guest for three of these; the admin for the fourth. */
  to: string;
  ref: string;
  tourTitle: string;
  /** A civil date, `YYYY-MM-DD`, as every tour date is. */
  tourDate: string;
  totalCentavos: number;
  paidCentavos: number;
  /** Only `payment_rejected` carries one, and for that event it is required. */
  reason?: string;
  /**
   * Only `driver_assigned` carries these, and for that event both are
   * required — the same arrangement `reason` has above, which is the pattern
   * this interface already set.
   *
   * Optional on the type rather than modelled as a per-event payload union:
   * one flat interface is what lets `notify()`, the transport and this
   * switch stay one code path for seven events. The cost is that "required
   * for one event" is a convention the template enforces rather than the
   * compiler, so `driver_assigned`'s case falls back to wording that is true
   * with either value missing instead of printing `undefined` at a guest.
   */
  driverName?: string;
  vanPlate?: string;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Escapes the five characters that matter in HTML.
 *
 * Applied to EVERY interpolated value, not only the ones that look risky.
 * `reason` is typed by an admin and is the obvious injection route, but a
 * tour title is admin-editable too, and "this field could never contain a
 * bracket" is the assumption that makes the next template the vulnerable
 * one.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Brand ink and accents. No red, by rule — amber carries every warning. */
const INK = '#1e3a5f';
const MUTED = '#475569';
const AMBER = '#b45309';
const RULE = '#e2e8f0';

/** One shell for every email, so they cannot drift apart visually. */
function document_(heading: string, bodyHtml: string): string {
  return [
    '<!doctype html><html><body style="margin:0;padding:0;background:#f8fafc;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 12px;">`,
    '<tr><td align="center">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${RULE};border-radius:8px;">`,
    `<tr><td style="padding:24px 24px 8px 24px;font-family:Arial,Helvetica,sans-serif;">`,
    `<div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">TravelSugbo</div>`,
    `<h1 style="margin:8px 0 0 0;font-size:20px;line-height:1.3;color:${INK};">${heading}</h1>`,
    '</td></tr>',
    `<tr><td style="padding:8px 24px 24px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:${INK};">`,
    bodyHtml,
    '</td></tr>',
    `<tr><td style="padding:16px 24px;border-top:1px solid ${RULE};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${MUTED};">`,
    'Operated by R&amp;G Travel &amp; Tours, Cebu, Philippines.',
    '</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

/** The booking facts every email repeats, as a small table. */
function detailsHtml(payload: NotifyPayload): string {
  const rows: Array<[string, string]> = [
    ['Reference', payload.ref],
    ['Tour', payload.tourTitle],
    ['Date', payload.tourDate],
    ['Total', formatPeso(payload.totalCentavos)],
  ];
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;width:100%;font-size:15px;color:${INK};">`,
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="padding:4px 0;color:${MUTED};width:40%;">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
  ].join('');
}

function detailsText(payload: NotifyPayload): string {
  return [
    `Reference: ${payload.ref}`,
    `Tour: ${payload.tourTitle}`,
    `Date: ${payload.tourDate}`,
    `Total: ${formatPeso(payload.totalCentavos)}`,
  ].join('\n');
}

/**
 * The absolute sign-in URL for one booking ref — see the module note on why
 * this is the sign-in screen and not My Booking itself.
 *
 * Built here rather than imported from `seo/resolvers.ts`'s `absoluteUrl()`:
 * that module is the SEO resolver and reaches the database, and a template
 * must stay free of both. `PUBLIC_BASE_URL` is this project's one base-URL
 * setting — `checkout.startPayment` builds the gateway return URLs from the
 * same value.
 *
 * Absolute, not relative: a mail client resolves a relative href against
 * nothing at all.
 */
function portalLoginUrl(ref: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/portal/login?ref=${encodeURIComponent(ref)}`;
}

/** One call-to-action button. Brand ink with the white glyph — never red. */
function linkHtml(url: string, label: string): string {
  return (
    '<p style="margin:20px 0 0 0;">' +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;` +
    `background:${INK};color:#ffffff;text-decoration:none;border-radius:6px;` +
    `font-weight:bold;font-size:15px;">${escapeHtml(label)}</a></p>`
  );
}

/**
 * Renders one event. Pure: no clock, no database, no network — so every
 * template is testable without any of them, and the §11 "no red" and
 * "money via formatPeso" rules are checked on the real output.
 *
 * (`PUBLIC_BASE_URL` is read from the parsed environment, which is a constant
 * for the life of the process. Still no clock, no query and no socket.)
 */
export function renderTemplate(event: NotifyEvent, payload: NotifyPayload): RenderedMail {
  const details = detailsHtml(payload);
  const detailsPlain = detailsText(payload);

  switch (event) {
    case 'booking_confirmed': {
      const paid = formatPeso(payload.paidCentavos);
      const balance = formatPeso(payload.totalCentavos - payload.paidCentavos);
      return {
        subject: `Your booking is confirmed — ${payload.ref}`,
        html: document_(
          'Your booking is confirmed',
          `<p style="margin:0;">Thank you — we have your payment and your trip is booked.</p>${details}` +
            `<p style="margin:0;">Paid: <strong>${escapeHtml(paid)}</strong>. ` +
            `Balance on tour day: <strong>${escapeHtml(balance)}</strong>.</p>`,
        ),
        text: `Your booking is confirmed.\n\n${detailsPlain}\nPaid: ${paid}\nBalance on tour day: ${balance}\n`,
      };
    }

    case 'receipt_received': {
      return {
        subject: `We received your receipt — ${payload.ref}`,
        html: document_(
          'We received your receipt',
          `<p style="margin:0;">Thanks — your transfer is with our team for checking. ` +
            `We will email you as soon as it is confirmed, usually within a few hours.</p>${details}`,
        ),
        text: `We received your receipt and it is being checked.\n\n${detailsPlain}\n`,
      };
    }

    case 'payment_rejected': {
      const reason = payload.reason ?? 'We could not match your transfer to this booking.';
      return {
        subject: `Action needed on your payment — ${payload.ref}`,
        html: document_(
          'We could not confirm your payment',
          // AMBER, not red. A rejected receipt is a "please try again",
          // not a failure state, and the brand forbids red regardless.
          `<p style="margin:0 0 12px 0;padding:12px;border-left:4px solid ${AMBER};background:#fffbeb;">` +
            `${escapeHtml(reason)}</p>` +
            `<p style="margin:0;">Your booking is still held. Please upload a clearer receipt from ` +
            `your booking page and we will check it again.</p>${details}`,
        ),
        text: `We could not confirm your payment.\n\n${reason}\n\nYour booking is still held — please upload a clearer receipt from your booking page.\n\n${detailsPlain}\n`,
      };
    }

    case 'admin_receipt_to_verify': {
      /*
       * Internal. It names the booking so a verifier can find it and
       * carries NO guest contact details: an admin clicks through to the
       * queue, where access is logged and role-gated, rather than reading a
       * guest's email address out of an inbox that is not.
       */
      return {
        subject: `Receipt to verify — ${payload.ref}`,
        html: document_(
          'A receipt is waiting for verification',
          `<p style="margin:0;">A guest has uploaded a transfer receipt. ` +
            `Open the bookings queue to approve or reject it.</p>${details}`,
        ),
        text: `A receipt is waiting for verification.\n\n${detailsPlain}\n`,
      };
    }

    case 'driver_assigned': {
      /*
       * `driverName` / `vanPlate` are optional on the payload and required
       * here — see the interface note. The fallbacks are wording that stays
       * TRUE with a value missing ("to be confirmed") rather than the string
       * "undefined" in front of a guest; the caller
       * (`routers/admin/dispatch.ts`) reads both from the just-committed
       * assignment, so in practice they are always present.
       */
      const driver = payload.driverName ?? 'to be confirmed';
      const plate = payload.vanPlate ?? 'to be confirmed';
      const balance = formatPeso(payload.totalCentavos - payload.paidCentavos);
      return {
        subject: `Your driver and van for ${payload.ref}`,
        html: document_(
          'Your driver and van are set',
          '<p style="margin:0;">Your trip is scheduled with the driver and van below. ' +
            'They will meet you at your pickup point.</p>' +
            details +
            `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;width:100%;font-size:15px;color:${INK};">` +
            `<tr><td style="padding:4px 0;color:${MUTED};width:40%;">Driver</td>` +
            `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(driver)}</td></tr>` +
            `<tr><td style="padding:4px 0;color:${MUTED};">Van plate</td>` +
            `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(plate)}</td></tr>` +
            '</table>' +
            `<p style="margin:12px 0 0 0;">Balance on tour day: <strong>${escapeHtml(balance)}</strong>.</p>`,
        ),
        text:
          `Your driver and van are set.\n\n${detailsPlain}\n` +
          `Driver: ${driver}\nVan plate: ${plate}\n` +
          `Balance on tour day: ${balance}\n`,
      };
    }

    case 'trip_reminder': {
      /*
       * Sent the afternoon before the tour. The balance is the one number a
       * guest has to act on — a deposit booking settles the rest with the
       * driver, so it belongs in the email they read the night before rather
       * than only on a page they may not open.
       */
      const outstanding = payload.totalCentavos - payload.paidCentavos;
      const balance = formatPeso(outstanding);
      const url = portalLoginUrl(payload.ref);
      const moneyLine =
        outstanding > 0
          ? `Please have <strong>${escapeHtml(balance)}</strong> ready for your driver.`
          : 'Your trip is fully paid — nothing to settle on the day.';
      const moneyPlain =
        outstanding > 0
          ? `Please have ${balance} ready for your driver.`
          : 'Your trip is fully paid — nothing to settle on the day.';
      return {
        subject: `Your tour is tomorrow — ${payload.ref}`,
        html: document_(
          'Your tour is tomorrow',
          '<p style="margin:0;">We are looking forward to it. Here are your details.</p>' +
            details +
            `<p style="margin:0;">${moneyLine}</p>` +
            linkHtml(url, 'View my booking'),
        ),
        text:
          `Your tour is tomorrow.\n\n${detailsPlain}\n${moneyPlain}\n\n` +
          `View my booking: ${url}\n`,
      };
    }

    case 'review_request': {
      /*
       * One per booking, ever (owner decision 2026-10-23, Q5), sent the
       * morning after the trip by `jobs/review-requests.ts` — which is what
       * makes this the one email in the file a guest can receive without
       * having done anything, and the reason it links the sign-in screen
       * rather than a prefilled form: the review is written inside My
       * Booking, behind ref + email, so a forwarded email cannot leave one.
       */
      const url = portalLoginUrl(payload.ref);
      return {
        subject: `How was your trip? — ${payload.ref}`,
        html: document_(
          'How was your trip?',
          '<p style="margin:0;">Thank you for travelling with us. If you have a minute, ' +
            'a short review helps other guests decide — and tells us how our team did.</p>' +
            details +
            linkHtml(url, 'Leave a review'),
        ),
        text:
          `Thank you for travelling with us.\n\n${detailsPlain}\n` +
          `If you have a minute, you can leave a review from your booking page:\n${url}\n`,
      };
    }
  }
}
