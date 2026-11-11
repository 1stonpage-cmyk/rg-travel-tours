import { inquiryInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { getDb } from '../../db/client';
import { inquiries } from '../../db/schema';
import { verifyTurnstile, turnstileRefusedError } from '../../services/turnstile';
import { publicProcedure, router } from '../../trpc';

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
    // Cloudflare Turnstile (Task 13) — ONLY the custom-trip request kind is
    // gated; a contact or package inquiry is unaffected. The owner's own
    // wording named "the public custom trip request form", not every
    // inquiry this one procedure happens to share a handler with.
    if (input.type === 'transfer_custom') {
      if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
        throw turnstileRefusedError();
      }
    }
    const db = getDb();
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
    return { ok: true as const };
  }),
});
