import { inquiryInput, type InquiryInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { readSettingBlock } from '../../content/settings';
import { getDb } from '../../db/client';
import { inquiries } from '../../db/schema';
import { sendInquiryAckMail, sendInquiryOfficeMail } from '../../services/notify';
import { verifyTurnstile, turnstileRefusedError } from '../../services/turnstile';
import { publicProcedure, router } from '../../trpc';

/**
 * Office notification + guest acknowledgement (owner decision 2026-11-11,
 * Task 1C). Called AFTER the insert above has already committed, never
 * before and never if it threw — a mail failure must not retroactively
 * undo a row that is already written.
 *
 * Wrapped in its own try/catch even though both senders below cannot throw
 * — `readSettingBlock('contact')` can, and a settings read going bad must
 * not turn an already-stored inquiry into a 500 for the guest. Mirrors
 * `routers/receipts.ts`'s own `sendReceiptNotices` for the identical
 * reason.
 */
async function sendInquiryNotices(input: InquiryInput, now: Date): Promise<void> {
  try {
    const contact = await readSettingBlock('contact');
    // Office notification: uncapped, sent on every inquiry. Defensive
    // check on `contact.email`, same as `receipts.ts`'s own.
    if (contact.email) {
      await sendInquiryOfficeMail(contact.email, {
        type: input.type,
        name: input.name,
        email: input.email,
        phone: input.phone,
        requestedDate: input.requestedDate,
        pax: input.pax,
        routeDescription: input.routeDescription,
        message: input.message,
      });
    }
    // Guest acknowledgement: rate-capped inside `sendInquiryAckMail` itself
    // (one per email per hour) — a capped request still reaches here having
    // already sent the office mail above, and returns without sending a
    // second ack.
    await sendInquiryAckMail(input.email, input.name, now);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[inquiries] could not send the inquiry notices (${kind})`);
  }
}

export const inquiriesRouter = router({
  /**
   * Contact / package inquiry form. `inquiryInput`'s `consent` field
   * (RA 10173) rejects anything but `true` before this ever runs — a
   * non-consenting submission fails validation and never reaches the
   * database. Never log `input` here: name/email/phone/message are
   * personal data under the Data Privacy Act and the spec restricts
   * personal data to admin-only access.
   */
  create: publicProcedure.input(inquiryInput).mutation(async ({ input, ctx }) => {
    // Cloudflare Turnstile (Task 13; widened by owner decision 2026-11-11,
    // Task 1A, to `contact`+`transfer_custom`; widened AGAIN by owner
    // decision 2026-11-11, follow-up, to EVERY inquiry type). 1A had
    // deliberately excluded `package` because neither of its two forms
    // (PackagesSection.tsx, PackageInquiryForm.tsx) rendered a
    // TurnstileWidget yet — gating it then would have refused every package
    // inquiry outright. The owner has since reviewed that exclusion and
    // overridden it directly: both package forms now carry their own
    // widget, so there is no longer a reason for `package` to be the one
    // type this check skips. The gate is unconditional again, exactly as it
    // was right after the first widening and before the `package`
    // exclusion existed — every `input.type` is checked, with no deny-list
    // left to maintain. A future 4th inquiry type is gated by default
    // (fail-closed) the same way; it needs its own widget before launch,
    // not an exclusion here.
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw turnstileRefusedError();
    }
    const db = getDb();
    // One clock read at the request boundary, passed down to the ack mail's
    // rate cap — never read inside that layer. See `sendInquiryNotices`.
    const now = new Date();
    try {
      await db.insert(inquiries).values({
        type: input.type,
        packageId: input.packageId,
        requestedDate: input.requestedDate,
        pax: input.pax,
        routeDescription: input.routeDescription,
        name: input.name,
        email: input.email,
        phone: input.phone,
        message: input.message,
        status: 'new',
      });
    } catch (err) {
      // Round 1 review (I3): an unrecognized insert failure must not
      // rethrow raw driver detail to a public caller. `cause` is attached
      // for server-side debugging only — tRPC's default error formatter
      // does not include it in the response.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not complete the request.',
        cause: err,
      });
    }

    // Task 1C: office notification + guest acknowledgement, AFTER the
    // insert above has committed — never before, never on a thrown insert.
    await sendInquiryNotices(input, now);

    return { ok: true as const };
  }),
});
