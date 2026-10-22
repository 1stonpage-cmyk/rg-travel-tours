import { newsletterInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { newsletterSubscribers } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';

/**
 * Anything that isn't a recognized duplicate-key error is a server fault,
 * not something to describe to the visitor. MySQL's own duplicate-entry
 * message embeds the submitted value verbatim (e.g.
 * `Duplicate entry '<email>' for key '...'`), and tRPC's default error
 * shape puts `error.message` in the response body — so if this ever stops
 * recognizing the wrapping shape, the fallback must not be "rethrow and let
 * the raw MySQL text reach the client" (round 1 review, I3). `cause` is
 * attached for server-side debugging only; tRPC's default error formatter
 * does not include it in the response sent to the caller.
 */
function toInternalError(err: unknown): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not complete the request.',
    cause: err,
  });
}

export const newsletterRouter = router({
  /**
   * Newsletter signup. A duplicate address is a *success* from the
   * visitor's point of view — re-submitting the same email must not look
   * like an error, and the response reveals nothing about the existing
   * subscriber beyond the `alreadySubscribed` flag (no row contents, no
   * timestamps). Never log `input.email`: subscriber addresses are
   * personal data under RA 10173.
   */
  subscribe: publicProcedure.input(newsletterInput).mutation(async ({ input }) => {
    const db = getDb();
    try {
      await db.insert(newsletterSubscribers).values({ email: input.email });
      return { ok: true as const, alreadySubscribed: false };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return { ok: true as const, alreadySubscribed: true };
      }
      throw toInternalError(err);
    }
  }),
});
