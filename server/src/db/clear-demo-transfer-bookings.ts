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
 * Wired to `pnpm --filter @rg/server db:clear-demo-transfers`. Same gate as
 * `seedDemo()` — `ALLOW_DEMO_SEED=1` and never `NODE_ENV=production` — since
 * this is the other half of the same dev-only demo-content lifecycle.
 *
 * Run it, THEN re-run the demo seed:
 *
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:clear-demo-transfers
 *   set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:seed:demo
 */
import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { env } from '../env';
import { closeDb } from './client';
import { auditLog, bookingTransferDetails, bookings, inquiries, payments } from './schema';
import { SEED_DEMO_TRANSFER_BOOKINGS, SEED_DEMO_TRIP_REQUEST } from './seed-data';
import { guardAndConnect } from './seed';

async function clearDemoTransferBookings(): Promise<void> {
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

  const db = await guardAndConnect('app');

  let deleted = 0;
  for (const recipe of SEED_DEMO_TRANSFER_BOOKINGS) {
    const [booking] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.leadEmail, recipe.leadEmail));
    if (!booking) continue;
    await db.delete(payments).where(eq(payments.bookingId, booking.id));
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, booking.id));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'bookings'), eq(auditLog.entityId, booking.id)));
    await db.delete(bookings).where(eq(bookings.id, booking.id));
    deleted += 1;
  }
  console.log(
    `[clear-demo] demo transfer bookings: ${deleted} deleted, ${SEED_DEMO_TRANSFER_BOOKINGS.length - deleted} already absent`,
  );

  const [inquiryResult] = await db
    .delete(inquiries)
    .where(eq(inquiries.email, SEED_DEMO_TRIP_REQUEST.email));
  console.log(
    `[clear-demo] demo trip request: ${inquiryResult.affectedRows > 0 ? 'deleted' : 'already absent'}`,
  );
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
