/**
 * CLI entry point: deletes ONLY the five Task 1E demo items (four transfer
 * bookings + the one trip-request inquiry), by their known fixed
 * `leadEmail`/`email` values, so the next `db:seed:demo` run recreates them
 * fresh with today's actual date and the current seed logic — useful before
 * a demo, when an earlier run's "today" bookings have aged into yesterday
 * or (per the fixed-slot design, `upsertDemoTransferBookings`'s own doc
 * comment) rolled onto tomorrow because that earlier run happened late in
 * the day.
 *
 * **Deletes nothing else.** No real guest data, no fleet, no routes, no
 * `fleet_date_slots` rows (those are shared lock bookkeeping that real
 * bookings also write — touching them here would risk a date some other,
 * real booking also uses). Every delete is scoped to a `bookings.id`
 * resolved from one of the five known demo emails; a row that does not
 * exist (already cleared, or never created this run) is silently skipped,
 * never an error.
 *
 * **Owner decision 2026-11-10 (the transfer-photos task's "fix both
 * unrelated failures now" instruction) hardened this file in three ways,
 * none of which loosen `schema-conventions.test.ts`'s hard-delete guard —
 * that guard now allowlists exactly this one file (see its own comment):**
 *
 *  1. Both fail-closed checks below (`ALLOW_DEMO_SEED=1`,
 *     `NODE_ENV !== 'production'`) run first, before any query, each with
 *     its own message — unchanged from this file's first version, carried
 *     over from `seedDemo()`'s own Task C2 guard.
 *  2. **A matched booking's payments are checked, not trusted.** Matching a
 *     `bookings` row by one of the five fixed demo emails only proves the
 *     BOOKING is the demo seed's own; it says nothing about every payment
 *     row now hanging off it — an admin could have manually recorded a
 *     payment, verified cash, or refunded one of these bookings by hand on
 *     a dev box. `assertOnlyDemoPayments()` below refuses the ENTIRE run,
 *     deleting nothing, the moment any matched booking has a payment whose
 *     own audit row was not written by `upsertDemoTransferBookings()`
 *     itself — identified by `actor_type = 'system'`, which among every
 *     path that can write a `payments` row is unique to this seed (a
 *     verified webhook writes `provider`; an admin approval, cash
 *     verification or refund writes `user`; driver-collected cash writes
 *     `driver`; see `record-payment.ts`'s own `actorSchema` doc comment).
 *     This is a POSITIVE check — it never reasons from a payment's date,
 *     amount or status, only from who the audit trail says created it.
 *  3. **Runs in one transaction.** Every read and every delete share one
 *     `db.transaction()`, so a refusal partway through (the payment check
 *     above, or any unexpected error) leaves every row exactly as it found
 *     it, and a successful run cannot leave a booking half-deleted.
 *
 * Wired to `pnpm --filter @rg/server db:clear-demo-transfers`. Same gate as
 * `seedDemo()` — `ALLOW_DEMO_SEED=1` and never `NODE_ENV=production` — since
 * this is the other half of the same dev-only demo-content lifecycle.
 * **Deliberately not referenced by `docs/LAUNCH_CHECKLIST.md` or any deploy
 * script** — it is a local convenience for refreshing a demo, never a step
 * anyone should run against a server.
 *
 * Run it, THEN re-run the demo seed:
 *
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:clear-demo-transfers
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:seed:demo
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '../env';
import { closeDb, type Transaction } from './client';
import type { DatabaseContext } from './guard';
import { auditLog, bookingTransferDetails, bookings, inquiries, payments } from './schema';
import { SEED_DEMO_TRANSFER_BOOKINGS, SEED_DEMO_TRIP_REQUEST } from './seed-data';
import { guardAndConnect } from './seed';

/**
 * The one actor type `upsertDemoTransferBookings()` ever passes to
 * `recordPayment()` (`seed.ts`) — see that call's own `actor: { type:
 * 'system', id: null }`. No other caller of `recordPayment()` uses
 * `'system'` for a payment: a webhook uses `'provider'`, an admin approval
 * or cash verification or refund uses `'user'`, driver-collected cash uses
 * `'driver'`. A cron job (`expire-holds.ts`) also writes `'system'`, but
 * never against `entity = 'payments'` — it only ever touches bookings
 * directly. That makes `(entity = 'payments', actorType = 'system')`
 * unique to this seed among every row this query could see.
 */
const DEMO_PAYMENT_ACTOR_TYPE = 'system';

/**
 * Refuses (throws, deleting nothing) if `bookingId` has any payment whose
 * own audit row was not written by the demo seed — see the module doc
 * comment's point 2. A booking with no payments at all (the one
 * `payDeposit: false` recipe, still `pending_payment`) passes trivially.
 */
async function assertOnlyDemoPayments(
  tx: Transaction,
  bookingId: number,
  leadEmail: string,
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
        `clearDemoTransferBookings: refusing to delete anything — the booking for "${leadEmail}" ` +
          `(id ${bookingId}) has a payment (id ${paymentId}) whose audit trail is not the demo ` +
          `seed's own (actor "${actorType ?? 'unknown'}", expected "${DEMO_PAYMENT_ACTOR_TYPE}"). ` +
          'This usually means someone recorded, verified, or refunded a payment on this demo ' +
          'booking by hand — delete it through the admin screens instead.',
      );
    }
  }
}

export async function clearDemoTransferBookings(context: DatabaseContext = 'app'): Promise<void> {
  if (env.ALLOW_DEMO_SEED !== '1') {
    throw new Error(
      'clearDemoTransferBookings: refusing to run — set ALLOW_DEMO_SEED=1 to run this. ' +
        'Dev-only; never set this on a production server.',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'clearDemoTransferBookings: refusing to run — this command must never run with ' +
        'NODE_ENV=production.',
    );
  }

  const db = await guardAndConnect(context);

  await db.transaction(async (tx) => {
    const matched: { bookingId: number; leadEmail: string }[] = [];
    for (const recipe of SEED_DEMO_TRANSFER_BOOKINGS) {
      const [booking] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.leadEmail, recipe.leadEmail));
      if (booking) matched.push({ bookingId: booking.id, leadEmail: recipe.leadEmail });
    }

    // Read-and-verify phase, fully before any delete: a refusal here leaves
    // every row — matched or not — exactly as it found it.
    for (const { bookingId, leadEmail } of matched) {
      await assertOnlyDemoPayments(tx, bookingId, leadEmail);
    }

    for (const { bookingId } of matched) {
      await tx.delete(payments).where(eq(payments.bookingId, bookingId));
      await tx
        .delete(bookingTransferDetails)
        .where(eq(bookingTransferDetails.bookingId, bookingId));
      await tx
        .delete(auditLog)
        .where(and(eq(auditLog.entity, 'bookings'), eq(auditLog.entityId, bookingId)));
      await tx.delete(bookings).where(eq(bookings.id, bookingId));
    }
    console.log(
      `[clear-demo] demo transfer bookings: ${matched.length} deleted, ` +
        `${SEED_DEMO_TRANSFER_BOOKINGS.length - matched.length} already absent`,
    );

    const [inquiryResult] = await tx
      .delete(inquiries)
      .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
    console.log(
      `[clear-demo] demo trip request: ${inquiryResult.affectedRows > 0 ? 'deleted' : 'already absent'}`,
    );
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  clearDemoTransferBookings()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error('[clear-demo] failed:', error instanceof Error ? error.message : error);
      await closeDb();
      process.exit(1);
    });
}
