import { newsletterInput } from '@rg/shared';
import { getDb } from '../../db/client';
import { newsletterSubscribers } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';

/**
 * True for a MySQL duplicate-key error. mysql2 sets `.code` on the error it
 * throws, but Drizzle wraps that in its own `DrizzleQueryError` and moves
 * the original onto `.cause` (verified against the actual error shape
 * raised by a real duplicate insert in this codebase — see
 * task-1.7-report.md) — so both the error and its `cause` are checked.
 * Narrowed by hand rather than `instanceof`: neither class is exported for
 * this purpose, just a `.code`-decorated Error.
 */
function isDuplicateEntryError(err: unknown): boolean {
  const code = (candidate: unknown): unknown =>
    typeof candidate === 'object' && candidate !== null
      ? (candidate as { code?: unknown }).code
      : undefined;
  const cause = (candidate: unknown): unknown =>
    typeof candidate === 'object' && candidate !== null
      ? (candidate as { cause?: unknown }).cause
      : undefined;
  return code(err) === 'ER_DUP_ENTRY' || code(cause(err)) === 'ER_DUP_ENTRY';
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
      throw err;
    }
  }),
});
