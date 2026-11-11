/**
 * Contact-form inquiry mail — office notification and guest acknowledgement
 * (owner decision 2026-11-11, Task 1C). `inquiries.create` sent neither
 * until this task; it only inserted a row.
 *
 * ## Why this is not `notify('some_inquiry_event', …)`
 *
 * `NotifyPayload` (`./templates.ts`) is booking-shaped: `ref`, `tourTitle`,
 * `tourDate`, `totalCentavos` and `paidCentavos` are all REQUIRED, because
 * every `NotifyEvent` is about a booking. An inquiry has none of those —
 * no ref, no tour, no money. Shoehorning it into that union would mean
 * either making four fields optional for every event that genuinely needs
 * them, or stuffing an inquiry mail with a fake ref and three zeros. So,
 * exactly like `./staff-password-reset.ts` (§12's own non-booking mail),
 * this gets its own render functions and its own sender functions — reusing
 * `mailDocument`/`mailLink` for the same visual shell every other mail
 * uses, and the SAME transport/mailFrom/cannot-throw/masked-logging
 * discipline `notify()` and `sendStaffPasswordResetEmail` both follow.
 *
 * ## The office mail has no cap; the guest acknowledgement does
 *
 * Every genuine inquiry must reach the office, so `sendInquiryOfficeMail`
 * is uncapped. The guest acknowledgement is capped at
 * `INQUIRY_ACK_MAX_PER_EMAIL` per `INQUIRY_ACK_WINDOW_MS`, for one reason
 * and one reason only: a guest could put an arbitrary third party's address
 * in the `email` field and submit repeatedly, turning this system's own
 * outbound mail into a bombing tool against that address. The fixed
 * sentence the ack sends is harmless on its own; being sent fifty times in
 * an hour is not. A capped request still writes its inquiry row and still
 * reaches the office — `sendInquiryAckMail`'s early return touches nothing
 * else.
 *
 * The throttle is an in-process `Map<string, …>` keyed by the lowercased
 * address, exactly like `services/password-reset.ts`'s own
 * `RESET_MAX_PER_EMAIL` cap — see that file's doc comment for the full
 * reasoning (PM2 fork mode, single instance) rather than repeating it here.
 *
 * ## Anti-spam-relay: the acknowledgement echoes NOTHING guest-supplied but
 * the first name
 *
 * `message`, `phone` and `routeDescription` are all guest-entered and all
 * admin-only. A guest could type a URL or spam text into `message` hoping
 * the acknowledgement mail echoes it back to the `email` address they
 * control (or to a third party they put there instead). So the
 * acknowledgement's body is the ONE fixed, owner-specified sentence plus
 * the guest's own first name — nothing else guest-supplied reaches it, and
 * nothing it carries is a link or a piece of text the guest chose.
 */
import type { InquiryType } from '@rg/shared';
import { env } from '../../env';
import { maskEmail } from '../password-reset';
import { mailDocument, mailLink } from './templates';
import { getTransport, mailFrom } from './transport';

export interface InquiryMailFields {
  type: InquiryType;
  name: string;
  email: string;
  phone?: string;
  /** `transfer_custom`-only fields — see `inquiryInput`'s own schema. */
  requestedDate?: string;
  pax?: number;
  routeDescription?: string;
  message: string;
}

/** Escapes the five characters that matter in HTML. Same set `templates.ts` escapes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INK = '#1e3a5f';
const MUTED = '#475569';

/**
 * Inquiries are managed inside `AdminPackagesPage.tsx`'s own "Inquiries"
 * section (`admin.inquiries.list`/`setStatus`) — there is no dedicated
 * `/admin/inquiries` route. Built from `PUBLIC_BASE_URL`, the same base-URL
 * setting `notify/templates.ts` and `services/password-reset.ts` both build
 * their own absolute links from. Never a hardcoded host, never a new env
 * var.
 */
function adminPackagesUrl(): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/admin/packages`;
}

/**
 * The office notification, rendered. Pure — no clock, no database, no
 * network — exactly as `renderTemplate` is.
 *
 * `requestedDate`/`pax`/`routeDescription` are OMITTED entirely when absent
 * rather than printed as an empty or "null" row — the same "no label is
 * better than a false one" convention `notify/templates.ts`'s `detailsHtml`
 * doc comment describes for a null `tourTitle`.
 */
export function renderInquiryOfficeMail(fields: InquiryMailFields): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    fields.type === 'transfer_custom'
      ? `New trip request from ${fields.name}`
      : `New message from ${fields.name}`;

  const rows: Array<[string, string]> = [
    ['Name', fields.name],
    ['Email', fields.email],
    ...(fields.phone === undefined ? [] : ([['Phone', fields.phone]] as Array<[string, string]>)),
    ['Type', fields.type],
    ...(fields.requestedDate === undefined
      ? []
      : ([['Trip date', fields.requestedDate]] as Array<[string, string]>)),
    ...(fields.pax === undefined ? [] : ([['Pax', String(fields.pax)]] as Array<[string, string]>)),
    ...(fields.routeDescription === undefined
      ? []
      : ([['Route', fields.routeDescription]] as Array<[string, string]>)),
  ];

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 0;color:${MUTED};width:30%;">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const rowsText = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  const url = adminPackagesUrl();
  const html = mailDocument(
    'New inquiry',
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;width:100%;font-size:15px;color:${INK};">` +
      rowsHtml +
      '</table>' +
      `<p style="margin:0 0 16px 0;white-space:pre-wrap;">${escapeHtml(fields.message)}</p>` +
      mailLink(url, 'Open inquiries'),
  );
  const text = `${rowsText}\n\n${fields.message}\n\nOpen inquiries: ${url}\n`;

  return { subject, html, text };
}

/**
 * The guest acknowledgement, rendered. Pure, same as above.
 *
 * `fullName` is split on whitespace and only the first token is used — a
 * simple `.trim().split(/\s+/)[0]`, not a name-parsing library; the point
 * of this mail is a warm, personal-feeling receipt, not a formal name parse.
 *
 * **Carries nothing guest-supplied except the first name** — see the module
 * note's anti-spam-relay walkthrough.
 */
export function renderInquiryAckMail(fullName: string): {
  subject: string;
  html: string;
  text: string;
} {
  const firstName = fullName.trim().split(/\s+/)[0] ?? '';
  // Owner-specified wording, verbatim. Do not editorialize this sentence.
  const sentence =
    `Thanks, ${firstName} — we got your message and will reply within business hours ` +
    `(Mon–Sun, 7:00 AM–9:00 PM PHT).`;
  return {
    subject: 'We got your message',
    html: mailDocument('We got your message', `<p style="margin:0;">${escapeHtml(sentence)}</p>`),
    text: `${sentence}\n`,
  };
}

/**
 * How many acknowledgement mails one address may receive within
 * `INQUIRY_ACK_WINDOW_MS` — see the module note on why this exists.
 */
export const INQUIRY_ACK_MAX_PER_EMAIL = 1;
export const INQUIRY_ACK_WINDOW_MS = 60 * 60_000;

interface Attempts {
  count: number;
  resetAt: number;
}

/**
 * In-process, not a table — PM2 runs fork mode with a single instance, the
 * same reasoning `services/password-reset.ts`'s own `byEmail` map gives at
 * length. **If PM2 is ever switched to cluster mode this cap becomes N
 * times weaker**, exactly as that file's own note warns for its map.
 */
const ackByEmail = new Map<string, Attempts>();

/** Lowercased and trimmed, matching `password-reset.ts`'s own `emailKey`. */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** True when this address has already received an acknowledgement this window. */
export function isInquiryAckThrottled(email: string, now: Date): boolean {
  const key = emailKey(email);
  const entry = ackByEmail.get(key);
  if (!entry) return false;
  if (entry.resetAt <= now.getTime()) {
    ackByEmail.delete(key);
    return false;
  }
  return entry.count >= INQUIRY_ACK_MAX_PER_EMAIL;
}

/** Counts one acknowledgement attempt against this address. */
export function recordInquiryAckSent(email: string, now: Date): void {
  const key = emailKey(email);
  const entry = ackByEmail.get(key);
  if (!entry || entry.resetAt <= now.getTime()) {
    ackByEmail.set(key, { count: 1, resetAt: now.getTime() + INQUIRY_ACK_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Test-only: the counter is process-global, so a suite must be able to reset it. */
export function resetInquiryAckThrottleForTests(): void {
  ackByEmail.clear();
}

/**
 * Sends the office notification, or logs why it could not. **Never throws,
 * never rejects** — see the module note and `sendStaffPasswordResetEmail`'s
 * own doc comment, which this mirrors exactly.
 *
 * Uncapped: every genuine inquiry must reach the office.
 */
export async function sendInquiryOfficeMail(to: string, fields: InquiryMailFields): Promise<void> {
  const transport = getTransport();
  const masked = maskEmail(to);

  if (!transport) {
    console.warn(`[notify] inquiry office mail queued for ${masked} — SMTP is not configured`);
    return;
  }

  try {
    const mail = renderInquiryOfficeMail(fields);
    await transport.sendMail({
      from: mailFrom(),
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // The error's TYPE, never its message — see the module note.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[notify] inquiry office mail for ${masked} failed to send (${kind})`);
  }
}

/**
 * Sends the guest acknowledgement, or says why it could not — including the
 * rate cap, which is enforced HERE so no caller needs its own throttle
 * check. **Never throws, never rejects.**
 *
 * `now` is read once at the request boundary by the caller and passed down,
 * never read inside this function — the same discipline every other
 * time-based decision in this codebase follows (`isResetThrottled` and
 * friends), so the window is assertable to the millisecond in a test.
 *
 * A capped request returns silently (one masked, non-sensitive log line)
 * without touching the transport at all — it must never throw, and it must
 * never prevent the office mail or the inquiry row, which this function has
 * no part in either way.
 */
export async function sendInquiryAckMail(to: string, fullName: string, now: Date): Promise<void> {
  const masked = maskEmail(to);

  if (isInquiryAckThrottled(to, now)) {
    console.log(`[notify] inquiry ack for ${masked} skipped — rate-capped`);
    return;
  }
  // Counted whether or not the send below actually reaches a configured
  // transport — the cap is about how many mails this address is OWED in a
  // window, not whether SMTP happened to be configured at the time.
  recordInquiryAckSent(to, now);

  const transport = getTransport();
  if (!transport) {
    console.warn(`[notify] inquiry ack queued for ${masked} — SMTP is not configured`);
    return;
  }

  try {
    const mail = renderInquiryAckMail(fullName);
    await transport.sendMail({
      from: mailFrom(),
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[notify] inquiry ack for ${masked} failed to send (${kind})`);
  }
}
