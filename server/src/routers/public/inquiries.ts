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
    // Task 1A) — gated for both ContactSection request kinds, `contact` and
    // `transfer_custom`. `package` is DELIBERATELY excluded: it is submitted
    // by PackagesSection.tsx and PackageInquiryForm.tsx, neither of which
    // renders a TurnstileWidget or sends a token, so gating it here would
    // refuse every package inquiry outright the moment Turnstile is
    // switched on — a real regression of a working flow, not something the
    // owner asked for. The owner's "every type" instruction meant every
    // type the contact form itself submits, not literally every member of
    // `INQUIRY_TYPES`. This is a DENY-list (`!== 'package'`), not an
    // allow-list, and that is deliberate too: a future 4th inquiry type is
    // GATED BY DEFAULT (fail-closed), same as `contact`/`transfer_custom`
    // are today. Whoever adds one must either ship it with its own
    // TurnstileWidget/token, or make the conscious choice to add it to this
    // exclusion — it cannot silently land ungated the way `package` almost
    // did. Revisit the `package` exclusion itself only alongside a task
    // that adds a widget to the package form(s).
    if (input.type !== 'package') {
      if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
        throw turnstileRefusedError();
      }
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
