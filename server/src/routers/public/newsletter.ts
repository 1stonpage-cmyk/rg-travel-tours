import { newsletterInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { getDb } from '../../db/client';
import { newsletterSubscribers } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';

/**
 * How many `.cause` links to walk looking for a MySQL error code. mysql2
 * sets `.code` on the error it throws, but Drizzle wraps that in its own
 * `DrizzleQueryError` and moves the original onto `.cause` — verified
 * against the actual error shape raised by a real duplicate insert in this
 * codebase (see task-1.7-report.md). Round 1 review (I3): that wrapping
 * shape already changed once under this codebase, so this walks a bounded
 * chain of `.cause`s instead of checking exactly one level — if some future
 * version wraps twice, this still finds the code; if nothing matches within
 * the bound, it's treated as unrecognized (see the `catch` below) rather
 * than looping forever on a malicious or cyclic `.cause` chain.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * True for a MySQL duplicate-key error anywhere in the first
 * `MAX_CAUSE_DEPTH` links of `err`'s `.cause` chain. Narrowed by hand
 * rather than `instanceof`: neither mysql2 nor Drizzle exports a class for
 * this, just a `.code`-decorated Error.
 */
function isDuplicateEntryError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current !== 'object') break;
    if ((current as { code?: unknown }).code === 'ER_DUP_ENTRY') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
      if (isDuplicateEntryError(err)) {
        return { ok: true as const, alreadySubscribed: true };
      }
      throw toInternalError(err);
    }
  }),
});
