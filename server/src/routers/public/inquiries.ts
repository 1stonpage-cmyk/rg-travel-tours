import { inquiryInput } from '@rg/shared';
import { getDb } from '../../db/client';
import { inquiries } from '../../db/schema';
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
  create: publicProcedure.input(inquiryInput).mutation(async ({ input }) => {
    const db = getDb();
    await db.insert(inquiries).values({
      type: input.type,
      packageId: input.packageId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      status: 'new',
    });
    return { ok: true as const };
  }),
});
