/**
 * Email templates (Week 4 plan, Task 4) — §11's "plain, branded HTML".
 *
 * Four events, which are the ones Phase 1's flows actually produce:
 * a confirmed booking, a receipt received, a payment rejected, and the
 * admin's "there is a receipt to verify". §11 lists three more — driver
 * assigned, the day-before reminder, and the review request — and they are
 * deliberately absent: the flows that would send them are Week 5's
 * dispatch and an unscheduled cron job (plan Q10), and a template with no
 * caller is a template nobody will keep accurate.
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
 */
import { formatPeso } from '@rg/shared';

/** The events Phase 1 sends. */
export const NOTIFY_EVENTS = [
  'booking_confirmed',
  'receipt_received',
  'payment_rejected',
  'admin_receipt_to_verify',
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
 * Renders one event. Pure: no clock, no database, no network — so every
 * template is testable without any of them, and the §11 "no red" and
 * "money via formatPeso" rules are checked on the real output.
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
  }
}
