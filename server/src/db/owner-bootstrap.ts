/**
 * `OWNER_PASSWORD` is a ONE-TIME bootstrap credential, and this module is how
 * the server says so out loud (Task 1D).
 *
 * `seedFirstOwner()` in `./seed.ts` has been create-only since the owner
 * decision of 2026-10-23: once an active owner exists it returns immediately
 * and touches nothing, so re-seeding can never reset a password a person
 * chose. That half is built, tested (`__tests__/owner-seed.test.ts`) and not
 * changed here.
 *
 * What was missing is the other half: nothing ever TOLD the deployer that the
 * plaintext in their `.env` had stopped doing anything. The hash is in the
 * database from the first seed onward, the variable has no further use, and a
 * credential sitting in a file for no benefit is exactly the habit the
 * decision exists to kill. Staff passwords are managed in the app from that
 * point (change-your-own, the owner's reset, forgot-password) plus the
 * local-only `pnpm --filter @rg/server dev:reset-password` CLI.
 *
 * ## "An owner exists" means an ACTIVE owner, matching `seedFirstOwner`
 *
 * `seedFirstOwner` keys on `role = 'owner' AND is_active = true`, so this does
 * too. One definition of "bootstrapped" rather than two that can disagree: a
 * database whose only owner row is deactivated is still a database where the
 * bootstrap would legitimately run, and warning "remove it from .env" there
 * would be advice that locks the deployer out.
 *
 * ## The check FAILS OPEN, deliberately
 *
 * This is the one place in this codebase where failing open is right. The
 * check is advisory configuration hygiene; the alternative is a server that
 * refuses to boot because a `SELECT` hiccuped. A thrown or rejected query
 * therefore produces a debug line and boot continues. Every other guard in
 * this tree (the database-name guard, the demo-seed guard, the placeholder
 * build guard) fails closed, and must keep doing so — the difference is that
 * each of those protects data or a credential, and this one protects a
 * deployer's tidiness.
 *
 * ## It never prints the password
 *
 * Not the value, not its length, not a hash, not a masked form. One fixed
 * line and nothing else.
 *
 * ## No PRODUCTION module imports this except `src/index.ts`
 *
 * The same discipline `startScheduledJobs()` keeps, and the same limit: the
 * only production caller of `warnIfOwnerPasswordUnused()` is the startup
 * entry, which no test imports — so the boot wiring is pinned by reading
 * `src/index.ts` as TEXT (`__tests__/owner-password-warning.test.ts`, review
 * fix I2) rather than by running it, the same trick the client's contrast and
 * no-red guards use on real source.
 *
 * The wrapper itself IS exercised directly, by that file and by
 * `owner-seed.test.ts`; the suite stays quiet because every one of those
 * callers spies on `console.warn` / `console.debug` and restores it.
 * Importing this module still runs nothing at all — no top-level side effect,
 * and the decision below is a pure function the tests drive directly.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from './client';
import * as schema from './schema';
import { env } from '../env';

/**
 * The exact line logged at boot, specified word for word by the owner's
 * instruction. Exported so the test pins the wording rather than a paraphrase
 * — a reader greps for this sentence.
 */
export const UNUSED_OWNER_PASSWORD_WARNING =
  'OWNER_PASSWORD is set but unused — remove it from .env';

/**
 * The whole decision, pure: warn only when the plaintext is still configured
 * AND the bootstrap it exists for has already happened.
 *
 * Set + no owner is the LEGITIMATE case — that is a deployer about to run
 * `db:seed` for the first time, and warning there would be wrong.
 */
export function shouldWarnUnusedOwnerPassword(input: {
  ownerPasswordSet: boolean;
  ownerExists: boolean;
}): boolean {
  return input.ownerPasswordSet && input.ownerExists;
}

/**
 * Boot-time wrapper: reads the environment, asks the database, logs at most
 * one line. Called once from `src/index.ts`, after its database checks have
 * passed, and never per request.
 */
export async function warnIfOwnerPasswordUnused(): Promise<void> {
  try {
    const ownerPasswordSet = Boolean(env.OWNER_PASSWORD);
    // No plaintext configured — nothing to advise about, and no reason to
    // spend a query at boot asking a question whose answer cannot matter.
    if (!ownerPasswordSet) return;

    const [activeOwner] = await getDb()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'owner'), eq(schema.users.isActive, true)))
      .limit(1);

    if (shouldWarnUnusedOwnerPassword({ ownerPasswordSet, ownerExists: Boolean(activeOwner) })) {
      console.warn(UNUSED_OWNER_PASSWORD_WARNING);
    }
  } catch (error) {
    /*
     * Fail OPEN — see the module docblock. A hygiene reminder must never
     * become an outage, so the worst a broken check can do is this line.
     *
     * It carries the driver's fixed error CODE and never the raw message
     * (review note): `db/guard.ts` discards raw errors for exactly this
     * reason, since a thrown database error can carry a credentialed URL or a
     * username in its text, and a debug line is still a log line. The code
     * (`ER_LOCK_WAIT_TIMEOUT`, say) is the useful half and is non-secret by
     * construction.
     */
    const code = (error as { code?: unknown }).code;
    console.debug(
      '[rg-travel-tours] owner-password hygiene check skipped' +
        (typeof code === 'string' ? ` (${code})` : ''),
    );
  }
}
