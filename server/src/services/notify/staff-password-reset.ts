/**
 * The one mail this system sends that is not a `NotifyEvent` — §12's
 * self-service staff password reset (owner decision 2026-11-06, task 1C).
 *
 * ## Why it is not `notify('staff_password_reset', …)`
 *
 * `NotifyPayload` is booking-shaped: `ref`, `tourDate`, `totalCentavos` and
 * `paidCentavos` are all REQUIRED, because every `NotifyEvent` is about a
 * booking. A password reset is about an account. Adding it to that union
 * would mean either making four fields optional for every event that
 * genuinely needs them, or stuffing this one with a fake ref and three
 * zeros — an email one line away from telling a staff member their booking
 * total is ₱0.00. So it gets its own sender, five lines of its own payload,
 * and the SAME transport and the SAME visual shell as every other event.
 *
 * ## It cannot throw, exactly as `notify()` cannot
 *
 * §11's rule ("failures are logged and never block the booking flow") is
 * about not losing the thing the mail was reporting, and it applies with
 * more force here, not less: the reset token is already committed by the
 * time this runs, so a thrown SMTP error would turn a working reset link
 * into a 500 the staff member reads as "it did not work" — and they would
 * ask for a second one while the first sits valid in their inbox.
 *
 * ## What may go in a log line, and what may not
 *
 * **Never the token and never the link.** Not on the success path, not on
 * the failure path, not on the SMTP-unconfigured path. A reset link in a log
 * is a live credential in a file that gets shipped to an aggregator, and it
 * would make every developer with log access a password-reset oracle for
 * every staff account.
 *
 * The recipient is logged MASKED (`maskEmail`), and the error's TYPE name
 * only — never its message, which for SMTP routinely quotes the credential
 * that failed to authenticate (`535 … for user <api-key>`). Both rules are
 * `notify()`'s own, for its own reasons; see `./index.ts`.
 */
import { maskEmail } from '../password-reset';
import { mailDocument, mailLink } from './templates';
import { getTransport, mailFrom } from './transport';

/**
 * Rendered here rather than in `renderTemplate`'s switch, because it is not
 * one of its events — but through `mailDocument` and `mailLink`, so it is
 * visually the same mail as the other seven. Pure: no clock, no database, no
 * network.
 *
 * The copy says the link expires, says that ignoring it changes nothing, and
 * names no account details beyond the address it was sent to. A reset mail
 * can land in the wrong inbox (a mistyped address at the form, a shared
 * mailbox), so it must be readable by a stranger without telling them
 * anything — which is why it does not name the staff member, their role, or
 * whether this is their first reset.
 */
export function renderStaffPasswordResetMail(resetUrl: string): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: 'Reset your TravelSugbo staff password',
    html: mailDocument(
      'Reset your staff password',
      '<p style="margin:0;">Someone asked to reset the password for this staff account. ' +
        'Use the button below to choose a new one.</p>' +
        mailLink(resetUrl, 'Choose a new password') +
        '<p style="margin:20px 0 0 0;">This link works once and expires in 30 minutes. ' +
        'If you did not ask for it you can ignore this email — nothing has changed, and ' +
        'your current password still works.</p>',
    ),
    text:
      'Someone asked to reset the password for this staff account.\n\n' +
      `Choose a new password:\n${resetUrl}\n\n` +
      'This link works once and expires in 30 minutes. If you did not ask for it you can ' +
      'ignore this email — nothing has changed, and your current password still works.\n',
  };
}

/**
 * Sends one reset mail, or says why it could not. **Never throws, never
 * rejects** — see the module note.
 *
 * `resetUrl` carries the raw token, so this function is one of exactly two
 * places it exists outside the resolver (`passwordResetUrl` is the other).
 * It reaches `sendMail` and nothing else.
 */
export async function sendStaffPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const transport = getTransport();
  const masked = maskEmail(to);

  if (!transport) {
    /*
     * The NORMAL local state, and not an error: the app runs with no SMTP
     * credentials during content work. One line, masked recipient, and
     * deliberately NO link — a developer who needs the link reads it out of
     * the database with `dev:reset-password` (task 1A) rather than out of a
     * log everyone can see.
     */
    console.warn(`[notify] reset email queued for ${masked} — SMTP is not configured`);
    return;
  }

  try {
    const mail = renderStaffPasswordResetMail(resetUrl);
    await transport.sendMail({
      from: mailFrom(),
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // The error's TYPE, never its message. See the module note.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[notify] reset email for ${masked} failed to send (${kind})`);
  }
}
