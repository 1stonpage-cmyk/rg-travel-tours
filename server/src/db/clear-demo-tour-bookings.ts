/**
 * CLI entry point: deletes ONLY the seed's two demo TOUR bookings — ref
 * `RG-SEED23` (`kawasan-falls-canyoneering`) and ref `RG-SEED24`
 * (`oslob-whale-shark-tumalog-falls`), from `SEED_UNASSIGNED_TRIPS` in
 * `server/src/db/seed-data.ts` — so a future reseed, or a demo that has
 * drifted away from today's actual date, can be given a clean pair of rows
 * again. Sibling to `clear-demo-transfer-bookings.ts` (Task 1E), built for
 * Task 4 / owner's own label "1D" of the Demo Polish Round 2 batch, with
 * the SAME tier of care — same two env guards, same payment-taint refusal,
 * same one-transaction shape. See that file's own module doc comment for
 * the full reasoning; this comment only restates what differs.
 *
 * **Scope ruling (owner decision 2026-11-11, stated here on purpose):** this
 * script does the ONE thing the task actually asked for — clear the two
 * existing demo tour bookings. It does **not** touch `seed.ts`'s
 * `upsertFleet()` / `SEED_UNASSIGNED_TRIPS` creation logic, which has no
 * `show_tours` gate of its own. The existing transfer script set that exact
 * precedent: it is a manual, opt-in cleanup tool, run after the fact, not
 * paired with a seed-time gate that would stop a future reseed from
 * recreating the rows. A seed-time gate, if ever wanted, is a separate,
 * different kind of change (prevention, not cleanup) and a follow-up task.
 *
 * **Simpler than the transfer script in one real way:** these two rows have
 * no `booking_transfer_details` row (tours do not have that table) and no
 * `fleet_date_slots` / `tour_date_slots` row to worry about — `seed.ts`
 * writes them with a raw `db.insert(schema.bookings)`, bypassing the real
 * hold/capacity path entirely. So the delete order is simply `payments` (if
 * any exist — checked, never assumed absent) -> `audit_log` where
 * `entity='bookings'` and `entity_id` matches -> `bookings`. No slot-table
 * cleanup needed.
 *
 * **Match key is `bookings.ref`, not an email** — unlike the transfer
 * script. `seed.ts`'s own comment on `SEED_UNASSIGNED_TRIPS` documents a
 * past bug where email/name matching double-created or suppressed rows;
 * `ref` is `bookings`' real, UNIQUE identity, and is the deliberate,
 * already-chosen match key for these two rows specifically.
 *
 * Guards, in order, each before any query:
 *
 *  1. `env.ALLOW_DEMO_SEED !== '1'` -> throw.
 *  2. `env.NODE_ENV === 'production'` -> throw.
 *  3. A payment-taint check — read each matched booking's `payments` rows,
 *     then the `audit_log` rows for `entity='payments'` with those payment
 *     ids, and refuse the WHOLE run, deleting nothing, if any payment's own
 *     audit row was not written by the seed itself (`actor_type =
 *     'system'` — see `DEMO_PAYMENT_ACTOR_TYPE`'s own doc comment below,
 *     identical reasoning to the transfer script's). This is a POSITIVE
 *     check: it never reasons from a payment's date, amount or status, only
 *     from who the audit trail says created it. The read-and-verify phase
 *     runs fully before any delete, so a refusal here leaves every matched
 *     booking — tainted or not — exactly as it found it.
 *  4. Runs in one `db.transaction()`: every read and every delete share it,
 *     so a refusal partway through, or any unexpected error, leaves every
 *     row exactly as it found it, and a successful run cannot leave a
 *     booking half-deleted.
 *
 * Wired to `pnpm --filter @rg/server db:clear-demo-tours`. Same gate as
 * `seedDemo()` and `clearDemoTransferBookings()` — `ALLOW_DEMO_SEED=1` and
 * never `NODE_ENV=production` — since this is the other half of the same
 * dev-only demo-content lifecycle. **Deliberately not referenced by
 * `docs/LAUNCH_CHECKLIST.md` or any deploy script**, same convention as the
 * transfer script — a local convenience, never a step anyone should run
 * against a server.
 *
 * Run it, THEN re-run the demo seed:
 *
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:clear-demo-tours
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:seed:demo
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../env';
import { closeDb, type Transaction } from './client';
import type { DatabaseContext } from './guard';
import { auditLog, bookings, payments } from './schema';
import { guardAndConnect } from './seed';

/** The two fixed refs this script ever matches — see `SEED_UNASSIGNED_TRIPS` in `seed-data.ts`. */
const DEMO_TOUR_BOOKING_REFS = ['RG-SEED23', 'RG-SEED24'] as const;

/**
 * The one actor type `seed.ts`'s own demo-booking path (and `seedDemo`
 * generally) ever passes when it writes a `payments` row for these two
 * bookings — identical reasoning to `clear-demo-transfer-bookings.ts`'s own
 * `DEMO_PAYMENT_ACTOR_TYPE`: a webhook uses `'provider'`, an admin approval,
 * cash verification or refund uses `'user'`, driver-collected cash uses
 * `'driver'`. A cron job (`expire-holds.ts`) also writes `'system'`, but
 * never against `entity = 'payments'` — it only ever touches bookings
 * directly. That makes `(entity = 'payments', actorType = 'system')` unique
 * to the seed among every row this query could see.
 */
const DEMO_PAYMENT_ACTOR_TYPE = 'system';

/**
 * Refuses (throws, deleting nothing) if `bookingId` has any payment whose
 * own audit row was not written by the seed — see the module doc comment's
 * guard 3. A booking with no payments at all (both `RG-SEED23`/`RG-SEED24`
 * are seeded this way — `seed.ts` never records a payment against them)
 * passes trivially.
 */
async function assertOnlyDemoPayments(
  tx: Transaction,
  bookingId: number,
  ref: string,
): Promise<void> {
  const rows = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.bookingId, bookingId));
  if (rows.length === 0) return;

  const paymentIds = rows.map((row) => row.id);
  const audits = await tx
    .select({ entityId: auditLog.entityId, actorType: auditLog.actorType })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'payments'), inArray(auditLog.entityId, paymentIds)));
  const actorTypeByPaymentId = new Map(audits.map((a) => [a.entityId, a.actorType]));

  for (const paymentId of paymentIds) {
    const actorType = actorTypeByPaymentId.get(paymentId);
    if (actorType !== DEMO_PAYMENT_ACTOR_TYPE) {
      throw new Error(
        `clearDemoTourBookings: refusing to delete anything — the booking "${ref}" ` +
          `(id ${bookingId}) has a payment (id ${paymentId}) whose audit trail is not the demo ` +
          `seed's own (actor "${actorType ?? 'unknown'}", expected "${DEMO_PAYMENT_ACTOR_TYPE}"). ` +
          'This usually means someone recorded, verified, or refunded a payment on this demo ' +
          'booking by hand — delete it through the admin screens instead.',
      );
    }
  }
}

export async function clearDemoTourBookings(context: DatabaseContext = 'app'): Promise<void> {
  if (env.ALLOW_DEMO_SEED !== '1') {
    throw new Error(
      'clearDemoTourBookings: refusing to run — set ALLOW_DEMO_SEED=1 to run this. ' +
        'Dev-only; never set this on a production server.',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'clearDemoTourBookings: refusing to run — this command must never run with ' +
        'NODE_ENV=production.',
    );
  }

  const db = await guardAndConnect(context);

  await db.transaction(async (tx) => {
    const matched: { bookingId: number; ref: string }[] = [];
    for (const ref of DEMO_TOUR_BOOKING_REFS) {
      const [booking] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.ref, ref));
      if (booking) matched.push({ bookingId: booking.id, ref });
    }

    // Read-and-verify phase, fully before any delete: a refusal here leaves
    // every row — matched or not — exactly as it found it.
    for (const { bookingId, ref } of matched) {
      await assertOnlyDemoPayments(tx, bookingId, ref);
    }

    for (const { bookingId } of matched) {
      await tx.delete(payments).where(eq(payments.bookingId, bookingId));
      await tx
        .delete(auditLog)
        .where(and(eq(auditLog.entity, 'bookings'), eq(auditLog.entityId, bookingId)));
      await tx.delete(bookings).where(eq(bookings.id, bookingId));
    }
    console.log(
      `[clear-demo] demo tour bookings: ${matched.length} deleted, ` +
        `${DEMO_TOUR_BOOKING_REFS.length - matched.length} already absent`,
    );
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  clearDemoTourBookings()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('[clear-demo] failed:', error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    });
}
