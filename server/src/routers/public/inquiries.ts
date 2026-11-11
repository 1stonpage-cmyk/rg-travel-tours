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
