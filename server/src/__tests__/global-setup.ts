/**
 * Vitest `globalSetup` (task 1.4b). Runs once, before any test file loads,
 * in the same process Vitest sets `process.env.VITEST` in — which is what
 * `server/src/db/client.ts` branches on to resolve TEST_DATABASE_URL
 * instead of DATABASE_URL. In order:
 *
 *  1. Assert the live connection is actually `rg_travel_test` ('test'
 *     context) — never assume the env var is right, prove it with a real
 *     `SELECT DATABASE()` query. Aborts the whole run otherwise: a test
 *     suite silently running against `rg_travel` is the exact failure this
 *     task exists to prevent.
 *  2. Run the Drizzle migrations against that same connection — explicitly
 *     against TEST_DATABASE_URL, never relying on drizzle.config.ts (which
 *     always reads DATABASE_URL and has no notion of a test database).
 *  3. Seed it once with the canonical seed data, so every suite starts from
 *     the same baseline (`resetTestDb()` re-applies this between suites
 *     that need a clean slate) — through `seedTestBaseline()`, which is
 *     `seed('test')` plus the harness's `show_tours: true` flip (Task T15).
 *  4. Record that baseline's row counts, and return a TEARDOWN that fails
 *     the run if the suite ends with more rows than it started with — see
 *     `LEAK_TABLES` below.
 *
 * Never logs DATABASE_URL, TEST_DATABASE_URL, or any password.
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  bookings,
  couponRedemptions,
  coupons,
  drivers,
  fleetDateSlots,
  payments,
  reviewHelpfulVotes,
  reviews,
  sessions,
  tripCheckpoints,
  users,
  vans,
} from '../db/schema';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { assertConnectedDatabase, assertDatabaseName, databaseNameFromUrl } from '../db/guard';
import { closeDb, getDb } from '../db/client';
import { env } from '../env';
import { seedTestBaseline } from './helpers/test-db';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../db/migrations', import.meta.url));

/**
 * The tables a leaked fixture row does the most damage in (owner
 * instruction, 2026-10-14).
 *
 * These are the ones other suites COUNT rather than look up by id, so one
 * stray row changes another file's answer instead of merely sitting there.
 * It is not a hypothetical: mutation-proving a role gate on
 * `admin.drivers.create` let a refused call succeed, which wrote one
 * untracked driver row — and that single row cascaded into 32 failures
 * across `capacity.test.ts` and others, whose whole job is counting free
 * vans and drivers. The 32 looked like the mutation's doing and were not.
 *
 * `audit_log` is deliberately absent: it is append-only by design, dozens
 * of tests write to it legitimately, and nothing counts it to make a
 * decision.
 *
 * `sessions` is absent for the same reason, and the teardown below EMPTIES it
 * instead (Task 10 / C3). Dozens of tests create sessions legitimately within
 * a run, so a detector on this table would fire on every run, which is the
 * opposite of what this check is for: it exists for rows that change another
 * file's answer, and nothing counts sessions to make a decision. What the
 * table needed was a reset, not a tripwire.
 */
const LEAK_TABLES = [
  ['bookings', bookings],
  ['drivers', drivers],
  ['vans', vans],
  ['payments', payments],
  ['users', users],
  /*
   * Added in Week 6 Task 5, the task whose code first WRITES this table
   * (round-1 review). It belongs here on the same test as the others: a
   * leaked row changes another file's answer rather than merely sitting
   * there — `tripProgress` counts a booking's checkpoints to decide how far
   * along a trip is, and the check-in service counts them to decide whether
   * a trip is finished and a van should be freed. The rows are also
   * invisible to the per-suite cleanups that key on a booking id they no
   * longer have.
   */
  ['trip_checkpoints', tripCheckpoints],
  /*
   * Added by owner decision 2026-10-16 (C5). `fleet_date_slots` rows are
   * lock anchors — `takeSlotLocks()` creates one per date so that two
   * bookings racing for the last van serialise against a real row — so a
   * leaked one changes no count and breaks no test today. It is listed
   * anyway, because the twelve suites that hand-delete these rows in
   * `afterAll` are currently the only thing keeping the table tidy, and a
   * thirteenth suite that forgets would leave rows nobody notices for
   * weeks. The detector is how "somebody forgot" becomes a named failure
   * in the run that caused it.
   */
  ['fleet_date_slots', fleetDateSlots],
  /*
   * Added by owner decision 2026-10-27 (Week 7 batch-3 answer 2). `coupons`
   * and `coupon_redemptions` are counted by `admin.coupons.*` the same way
   * `used_count` and the redemption log count each other — a leaked row
   * changes "3 of 50 used" for every other suite that lists coupons, the
   * same hazard `fleet_date_slots` was added for.
   */
  ['coupons', coupons],
  ['coupon_redemptions', couponRedemptions],
  /*
   * Added 7N (Task 10), same precedent as `coupons`/`coupon_redemptions`
   * above. `reviews.forTour` counts `review_helpful_votes` per review to
   * compute `helpfulCount`, and the public catalog's `realAggregate()`
   * counts `reviews` rows to compute a tour's rating and review count — a
   * leaked row in either table changes an answer another suite asserts,
   * the same hazard `fleet_date_slots` was added for.
   */
  ['reviews', reviews],
  ['review_helpful_votes', reviewHelpfulVotes],
] as const;

/**
 * Counted AFTER seeding, never assumed to be zero.
 *
 * `seed('test')` populates this database, and Task 15 adds vans and drivers
 * to that seed — so a check asserting these tables are EMPTY would be wrong
 * today for `users` and wrong next week for the rest. The baseline is
 * whatever the seed produced; the assertion is that the suite gave it back
 * unchanged.
 */
async function countRows(): Promise<Record<string, number>> {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const [name, table] of LEAK_TABLES) {
    // The typed query builder, not `sql.raw` with an interpolated
    // identifier: no table name is ever assembled as a string here.
    const [row] = await db.select({ n: sql<number>`COUNT(*)` }).from(table);
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

/**
 * Fails LOUDLY if `users` already holds rows before THIS run has inserted
 * anything — called between `migrate()` and `seedTestBaseline()`, never
 * before `migrate()` (a brand-new `rg_travel_test` has no `users` table yet)
 * and never from inside `seedTestBaseline()`/`resetTestDb()` (those run
 * mid-suite too, by which point tests legitimately hold user rows —
 * `password-reset.test.ts` is one).
 *
 * This exists because `countRows()` above captures the leak detector's
 * BASELINE, and it only ever runs AFTER seeding — so a stray row already
 * sitting in `users` before a run starts gets silently adopted as "expected"
 * for every run from then on, and the detector can never see it again. Four
 * rows named "Reset Fixture"/"Reset Inactive Fixture" sat in `rg_travel_test`
 * undetected for days this way (found 2026-11-09, predating this check).
 * `users` IS in `LEAK_TABLES`, which only ever catches a row ADDED during a
 * run — it was never positioned to catch one already there when the run
 * began.
 *
 * `seed('test')` leaves `users` empty whenever `OWNER_EMAIL`/`OWNER_PASSWORD`
 * are unset (the normal case: `server/src/db/seed.ts`'s `seedOwner` skips
 * entirely). The one allowed exception is a single row that matches
 * `OWNER_EMAIL` (case-insensitively) AND is a genuine owner row (`role ===
 * 'owner'`, `isActive === true`) when that var IS set: a dev who points
 * `OWNER_EMAIL` at a real account to exercise `seedBase` against
 * `rg_travel_test` too gets a legitimately-reseeded owner row that survives
 * between runs (seeding there is insert/update-if-missing by email, and
 * nothing deletes it), and that one row must not be mistaken for a leak.
 *
 * **Matching by email alone would be a hole, not a convenience** (review
 * finding, fix round 2026-11-09): the exact stray fixture this check exists
 * to catch (`password-reset.test.ts`'s "Reset Fixture", `role: 'owner'`) is
 * the same shape a coincidental email collision would let through silently.
 * Requiring `role`/`isActive` too costs nothing against the legitimate case
 * (`seedOwner` only ever writes `role: 'owner', isActive: true`) and closes
 * that collision. The exemption also always logs when it actually fires —
 * silent is how a real leak hides behind this escape hatch.
 *
 * Every other row still throws, OWNER_EMAIL-set or not.
 */
export async function assertNoPreExistingUsers(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users);

  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  const isAllowedOwnerRow = (row: (typeof rows)[number]) =>
    ownerEmail !== undefined &&
    row.email.toLowerCase() === ownerEmail &&
    row.role === 'owner' &&
    row.isActive === true;

  const unexpected = rows.filter((row) => !isAllowedOwnerRow(row));
  if (unexpected.length === 0) {
    if (rows.length > 0) {
      // Deliberate console.warn: a silent exemption is how a real leak hides behind this escape hatch.
      console.warn(
        `[global-setup] rg_travel_test.users: allowing ${rows.length} pre-existing OWNER_EMAIL-matched owner row(s) through assertNoPreExistingUsers (` +
          rows.map((row) => `#${row.id} <${row.email}>`).join(', ') +
          ').',
      );
    }
    return;
  }

  const described = unexpected.map((row) => `#${row.id} "${row.name}" <${row.email}>`).join(', ');
  throw new Error(
    `rg_travel_test.users has ${unexpected.length} row(s) before this run even started ` +
      `seeding — a previous run left stray data. Delete them before trusting this run: ` +
      described,
  );
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The test suite refuses to run with no dedicated ' +
        'test database configured (see .env.example).',
    );
  }

  assertDatabaseName(databaseNameFromUrl(env.TEST_DATABASE_URL), 'test');
  await assertConnectedDatabase('test');

  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
  // BEFORE seeding, after migrating — see the function's own note on why
  // here and nowhere else.
  await assertNoPreExistingUsers();
  // Not a bare `seed('test')`: the harness's baseline flips `show_tours` on
  // (Task T15). See `seedTestBaseline`'s own note on why that is one shared
  // function rather than a flip here.
  await seedTestBaseline();

  const baseline = await countRows();
  await closeDb();

  /**
   * Fails the run when the suite ends holding rows it did not start with.
   *
   * Loudly and BY NAME: the message says which table, how many were
   * expected, how many are there, and what the surplus is — because the
   * symptom of a leak is never the leak itself. It is 32 unrelated failures
   * in files that count rows, several suites later, which is how an hour
   * gets spent reading the wrong diff.
   *
   * It compares against the post-seed baseline rather than zero, so it
   * stays correct when Task 15 adds vans and drivers to the seed.
   *
   * FEWER rows than the baseline is not failed here: suites legitimately
   * truncate and re-seed through `resetTestDb()`, and a deficit is that
   * working, not a leak.
   */
  return async function teardown(): Promise<void> {
    await assertConnectedDatabase('test');
    const after = await countRows();
    /*
     * Task 10 (C3): return `sessions` to its baseline. Nothing in the suite
     * expires these rows and `rg_travel_test` had grown to 678 of them. The
     * post-seed baseline is ZERO (`seed()` creates an owner user, not a
     * session; measured with COUNT(*) straight after `seed('test')`), so this
     * restores the starting state rather than an arbitrary one. The connection
     * was proven to be `rg_travel_test` by `assertConnectedDatabase` above, and
     * this runs before the leak check can throw so a failing run still cleans up.
     */
    await getDb().delete(sessions);
    const leaks = LEAK_TABLES.map(([name]) => name)
      .filter((name) => (after[name] ?? 0) > (baseline[name] ?? 0))
      .map(
        (name) =>
          `${name}: expected ${baseline[name] ?? 0}, found ${after[name] ?? 0} (+${(after[name] ?? 0) - (baseline[name] ?? 0)})`,
      );
    await closeDb();

    if (leaks.length > 0) {
      throw new Error(
        'rg_travel_test has rows no test cleaned up:\n  ' +
          leaks.join('\n  ') +
          '\n\nEvery suite must remove what it created. If this appeared while ' +
          'mutation-proving a refusal test, that is expected: the mutation let a ' +
          'call that should have been refused SUCCEED, so it wrote rows the test ' +
          'never tracked for teardown. Delete them before trusting the next run — ' +
          'a stray row in these tables changes what other suites count.',
      );
    }
  };
}
