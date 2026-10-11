/**
 * Task 11 of the core-schema plan: `trip_checkpoints`,
 * `review_helpful_votes`, and the two foreign keys retro-fitted onto
 * tables that already existed (`reviews.booking_id` → `bookings.id`,
 * `reviews.tour_id` → `tours.id` (task 11b),
 * `inquiries.package_id` → `packages.id`).
 *
 * Two layers, the split `schema-sessions.test.ts` and
 * `schema-booking-lines.test.ts` use:
 *
 *  1. **Shape assertions read the Drizzle table object** through
 *     `getTableConfig()` — the very object drizzle-kit emits DDL from. They
 *     hold before and after the migration, and every one of them fails if
 *     the column, key or foreign key it names changes.
 *
 *  2. **The load-bearing constraints are re-asserted against the real
 *     database**, gated on the tables existing. A schema object and the DDL
 *     a generator emits from it are two different things, and "the database
 *     refuses a second helpful vote" or "an orphan package_id is rejected"
 *     are exactly the properties a generator can get wrong silently.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, getPool, type Transaction } from '../db/client';
import {
  bookings,
  destinations,
  drivers,
  inquiries,
  packages,
  reviewHelpfulVotes,
  reviews,
  tourItineraryStops,
  tours,
  tripCheckpoints,
} from '../db/schema';

interface Shape {
  columnNames: string[];
  column: (name: string) => ReturnType<typeof getTableConfig>['columns'][number] | undefined;
  indexes: Record<string, string[]>;
  primaryKeys: string[][];
  foreignKeys: Array<{
    columns: string[];
    table: string;
    foreignColumns: string[];
    onDelete: string | undefined;
    onUpdate: string | undefined;
  }>;
}

/** Reads one Drizzle table into the handful of facts these tests assert. */
function shapeOf(table: Parameters<typeof getTableConfig>[0]): Shape {
  const config = getTableConfig(table);
  // An index column is normally a Column (which has `.name`), but Drizzle
  // also allows a raw SQL expression — hence the guard rather than `c.name`.
  const names = (columns: readonly unknown[]) =>
    columns.map((c) =>
      c !== null && typeof c === 'object' && 'name' in c ? String(c.name) : String(c),
    );
  return {
    columnNames: config.columns.map((c) => c.name),
    column: (name) => config.columns.find((c) => c.name === name),
    indexes: Object.fromEntries(
      config.indexes.map((i) => [i.config.name, names(i.config.columns)]),
    ),
    primaryKeys: config.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
    foreignKeys: config.foreignKeys.map((fk) => {
      const reference = fk.reference();
      return {
        columns: reference.columns.map((c) => c.name),
        table: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((c) => c.name),
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      };
    }),
  };
}

const checkpoints = shapeOf(tripCheckpoints);
const votes = shapeOf(reviewHelpfulVotes);
const reviewsShape = shapeOf(reviews);
const inquiriesShape = shapeOf(inquiries);

describe('trip_checkpoints', () => {
  /**
   * §8: "Undo last check-in … marked undone, not deleted". A driver who
   * taps the wrong stop must be able to correct it without the trip's
   * timeline losing the fact that a tap happened — that timeline is what
   * answers "when did this van actually reach Kawasan?" months later, and a
   * DELETE makes the question unanswerable.
   */
  it('marks an undone check-in rather than deleting it', () => {
    expect(checkpoints.columnNames).toContain('undone');
    expect(checkpoints.column('undone')?.getSQLType()).toBe('boolean');
    expect(checkpoints.column('undone')?.notNull).toBe(true);
    expect(checkpoints.column('undone')?.default, 'a check-in starts done').toBe(false);
  });

  /**
   * Null `stop_id` is the "start trip" event (§8). The driver taps Start
   * before reaching any itinerary stop, so that event has no stop behind
   * it — and inventing a synthetic stop row per tour just to hang it on
   * would put fake itinerary entries in front of guests.
   */
  it('allows a null stop_id, which means "trip start"', () => {
    expect(checkpoints.columnNames).toContain('stop_id');
    expect(checkpoints.column('stop_id')?.notNull, 'trip start has no stop').toBeFalsy();
    expect(checkpoints.column('booking_id')?.notNull, 'a checkpoint is always a trip').toBe(true);
  });

  /**
   * Server time, never the device's. A phone clock is settable, and a
   * check-in timestamp is evidence in a dispute about whether a trip ran —
   * so there is no `device_checked_at` column for a driver's handset to
   * write, and `checked_at` is filled in by the server.
   */
  it('times the check-in with a UTC datetime and no device clock beside it', () => {
    expect(checkpoints.column('checked_at')?.getSQLType()).toBe('datetime');
    expect(checkpoints.column('checked_at')?.notNull).toBe(true);
    expect(checkpoints.columnNames.filter((n) => /device|local|client|phone/i.test(n))).toEqual([]);
  });

  /**
   * Nothing in this schema cascades (plan: `ON DELETE RESTRICT` everywhere).
   * A cascade from `tour_itinerary_stops` would erase the check-ins of
   * completed trips the moment an admin reordered a tour's itinerary.
   */
  it('references bookings, tour_itinerary_stops and the undoing driver, and cascades nothing', () => {
    expect(
      checkpoints.foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`).sort(),
    ).toEqual(['booking_id->bookings', 'stop_id->tour_itinerary_stops', 'undone_by->drivers']);
    for (const fk of checkpoints.foreignKeys) {
      expect(fk.foreignColumns).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
  });

  it('indexes one trip’s checkpoints in the order they happened', () => {
    expect(checkpoints.indexes['trip_checkpoints_booking_idx']).toEqual([
      'booking_id',
      'checked_at',
    ]);
  });

  /**
   * Task 11b-2. `undone` alone records that a tap was retracted but not
   * when or by whom — and "arrived at 10:15, retracted at 10:16" and
   * "… retracted three days later, after the complaint arrived" are very
   * different facts in a refund argument.
   *
   * `undone_by` is a DRIVER: §8 scopes undo to the driver portal ("Undo
   * last check-in — only the most recent"). Both columns are nullable
   * because they are empty for the normal, un-retracted check-in.
   */
  it('records when an undo happened and which driver did it', () => {
    expect(checkpoints.column('undone_at')?.getSQLType()).toBe('datetime');
    expect(
      checkpoints.column('undone_at')?.notNull,
      'a live check-in has no undo time',
    ).toBeFalsy();
    expect(checkpoints.column('undone_by')?.getSQLType()).toBe('int');
    expect(checkpoints.column('undone_by')?.notNull).toBeFalsy();
    const fk = checkpoints.foreignKeys.find((f) => f.columns.join(',') === 'undone_by');
    expect(fk, 'undone_by is a bare int, not a real driver reference').toBeDefined();
    expect(fk?.table, 'undo is the driver portal’s, not an admin user’s').toBe('drivers');
    expect(fk?.onDelete, 'a retired driver must not erase the check-in').toBeUndefined();
  });

  /**
   * Task 11b-2, the double-tap guard, completed by task 16b-2. A driver on a
   * moving van taps "Arrived at Kawasan" twice, or taps Start twice while the
   * first request is in flight, and the tracker must not show either event
   * twice.
   *
   * **Keyed on `stop_key`, not `stop_id` — that is the fix.** The original
   * `(booking_id, stop_id)` index constrained real stops only, because null
   * means "trip start" and MySQL permits unlimited NULLs in a unique index.
   * This assertion goes red if anyone points the index back at `stop_id`,
   * which would silently re-open the hole.
   */
  it('declares one check-in per (booking, stop_key) as a UNIQUE index', () => {
    const config = getTableConfig(tripCheckpoints);
    const unique = config.indexes.find(
      (i) => i.config.name === 'trip_checkpoints_booking_stop_unique',
    );
    expect(unique, 'the double-tap guard is gone').toBeDefined();
    expect(unique?.config.unique, 'the index exists but is not unique — it guards nothing').toBe(
      true,
    );
    expect(checkpoints.indexes['trip_checkpoints_booking_stop_unique']).toEqual([
      'booking_id',
      'stop_key',
    ]);
    expect(
      checkpoints.indexes['trip_checkpoints_booking_stop_unique'],
      'indexing stop_id again re-opens the NULL hole task 16b-2 closed',
    ).not.toContain('stop_id');
  });

  /**
   * Task 16b-2. `stop_key` is `COALESCE(stop_id, 0)`, STORED and NOT NULL —
   * every one of those three matters:
   *
   *   - the COALESCE is what gives the trip-start rows a key to collide on;
   *   - STORED because that is the form a unique index can be built on;
   *   - NOT NULL because a nullable key would just move the hole.
   *
   * It is `GENERATED ALWAYS`, so application code can never write it. Write
   * `stop_id`; this follows.
   */
  it('derives stop_key from stop_id as a stored, non-null generated column', () => {
    const column = checkpoints.column('stop_key');
    expect(column, 'stop_key is gone — the trip-start UNIQUE constrains nothing').toBeDefined();
    expect(column?.getSQLType()).toBe('int');
    expect(column?.notNull, 'a nullable key would move the NULL hole, not close it').toBe(true);
    const generated = column?.generated;
    expect(
      generated,
      'stop_key is a plain column — nothing keeps it in step with stop_id',
    ).toBeDefined();
    expect(generated?.type, 'GENERATED ALWAYS, so application code can never write it').toBe(
      'always',
    );
    expect(generated?.mode, 'a virtual column cannot carry the UNIQUE index').toBe('stored');
    // The COALESCE itself is asserted against the real database below, where
    // `information_schema.columns.GENERATION_EXPRESSION` holds what MySQL
    // actually stored rather than what Drizzle meant to say.
  });
});

describe('review_helpful_votes', () => {
  /**
   * The composite primary key IS the one-vote-per-browser rule (§4). Not a
   * surrogate `id` with a unique index beside it: the pair is the identity
   * of the row, and an auto-increment key would invite a second row for the
   * same pair the moment someone wrote an INSERT without the index in mind.
   */
  it('is keyed by (review_id, voter_hash), which is the one-vote rule', () => {
    expect(votes.primaryKeys).toEqual([['review_id', 'voter_hash']]);
    expect(votes.columnNames, 'a surrogate key would allow a second vote').not.toContain('id');
    expect(votes.column('review_id')?.notNull).toBe(true);
    expect(votes.column('voter_hash')?.notNull).toBe(true);
  });

  /**
   * A HASH of cookie id + IP, never the address itself. A raw IP is
   * personal data under RA 10173 and this table has no admin screen, no
   * retention rule and no subject-access path behind it — so it must not
   * hold one. 64 characters is a hex SHA-256.
   */
  it('stores a hash, never the raw IP address', () => {
    expect(votes.column('voter_hash')?.getSQLType()).toBe('varchar(64)');
    expect(
      votes.columnNames.filter((n) => /\bip\b|ip_|_ip|address|user_agent|cookie/i.test(n)),
      'personal data reached a table with no admin screen behind it',
    ).toEqual([]);
  });

  it('references reviews, and cascades nothing', () => {
    expect(votes.foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`)).toEqual([
      'review_id->reviews',
    ]);
    for (const fk of votes.foreignKeys) {
      expect(fk.foreignColumns).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
  });

  it('times the vote with a UTC datetime', () => {
    expect(votes.column('created_at')?.getSQLType()).toBe('datetime');
    expect(votes.column('created_at')?.notNull).toBe(true);
  });
});

describe('the retro-fitted foreign keys', () => {
  /**
   * `reviews.booking_id` has been a bare nullable int since the public-site
   * plan, because `bookings` did not exist yet. It is what makes a review
   * "verified" — a review claiming a booking that was never taken is the
   * exact shape of fake social proof CLAUDE.md forbids, so the column must
   * point at a real row or at nothing.
   *
   * Still nullable: an admin-entered review has no booking behind it.
   */
  it('points reviews.booking_id at a real booking, or at nothing', () => {
    const fk = reviewsShape.foreignKeys.find((f) => f.columns.join(',') === 'booking_id');
    expect(fk, 'reviews.booking_id is still a bare int').toBeDefined();
    expect(fk?.table).toBe('bookings');
    expect(fk?.foreignColumns).toEqual(['id']);
    expect(fk?.onDelete, 'a deleted booking must not delete its review').toBeUndefined();
    expect(
      reviewsShape.column('booking_id')?.notNull,
      'an admin-entered review has no booking',
    ).toBeFalsy();
  });

  /**
   * Task 11b-4. `reviews.tour_id` has been a bare nullable int since the
   * public-site plan. A dangling id is a review of a tour that does not
   * exist — it still counts toward a rating while showing on no page a
   * reader could check, which is fake social proof reached by accident.
   *
   * Nullable stays (a review of the operator as a whole names no tour), and
   * nothing cascades: retiring a tour must not erase what guests said.
   */
  it('points reviews.tour_id at a real tour, or at nothing', () => {
    const fk = reviewsShape.foreignKeys.find((f) => f.columns.join(',') === 'tour_id');
    expect(fk, 'reviews.tour_id is still a bare int').toBeDefined();
    expect(fk?.table).toBe('tours');
    expect(fk?.foreignColumns).toEqual(['id']);
    expect(fk?.onDelete, 'a retired tour must not delete its reviews').toBeUndefined();
    expect(fk?.onUpdate).toBeUndefined();
    expect(
      reviewsShape.column('tour_id')?.notNull,
      'a review of the operator as a whole names no tour',
    ).toBeFalsy();
  });

  /**
   * `inquiries.package_id` is how a package enquiry is routed to the right
   * package. A dangling id silently turns into "enquiry about (nothing)" in
   * the admin list, which is how a real customer's question gets lost.
   */
  it('points inquiries.package_id at a real package, or at nothing', () => {
    const fk = inquiriesShape.foreignKeys.find((f) => f.columns.join(',') === 'package_id');
    expect(fk, 'inquiries.package_id is still a bare int').toBeDefined();
    expect(fk?.table).toBe('packages');
    expect(fk?.foreignColumns).toEqual(['id']);
    expect(fk?.onDelete, 'a deleted package must not delete the enquiry').toBeUndefined();
    expect(
      inquiriesShape.column('package_id')?.notNull,
      'a general contact enquiry names no package',
    ).toBeFalsy();
  });
});

/**
 * True once Waves 2–4 (Task 11) have created these tables in
 * `rg_travel_test`. Also false when MySQL is unreachable, which is how the
 * rest of the suite behaves (see `helpers/db.ts`).
 */
async function tablesExist(names: string[]): Promise<boolean> {
  try {
    const [rows] = (await getPool().query(
      `SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
      [names],
    )) as [unknown[], unknown];
    return rows.length === names.length;
  } catch {
    return false;
  }
}

const migrated = await tablesExist(['bookings', 'trip_checkpoints', 'review_helpful_votes']);
const dbIt = migrated ? it : it.skip;

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

/**
 * Runs `fn` in a transaction that is always rolled back.
 *
 * Nothing these tests write is committed, so there is no cleanup to forget
 * — and no DELETE against `bookings`, which is the one operation this
 * system forbids outright (CLAUDE.md: never hard-delete a booking).
 */
async function inRollback(fn: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

/**
 * Runs `run` and reports the MySQL error code it was refused with, or `null`
 * when the database accepted it.
 *
 * The code, not the message: Drizzle wraps a mysql2 error in its own
 * `DrizzleQueryError` whose message is the SQL text, so matching
 * `/duplicate/i` would pass or fail for reasons unrelated to the constraint
 * under test. Same helper shape as `schema-booking-lines.test.ts`.
 */
async function rejectionCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current != null; depth += 1) {
      if (typeof current !== 'object') break;
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    }
    return 'UNRECOGNISED';
  }
}

/** A booking, and the tour and destination its foreign keys need. */
async function makeBooking(tx: Transaction): Promise<{ bookingId: number; tourId: number }> {
  const unique = `__trips__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
  const [tour] = await tx
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  const [booking] = await tx.insert(bookings).values({
    ref: `RG-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, 'A')}`,
    tourId: tour.insertId,
    tourDate: new Date('2026-12-25T00:00:00Z'),
    pax: 4,
    leadName: 'Test Guest',
    leadEmail: 'guest@example.test',
    leadPhone: '09170000000',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: 189000 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: 756000,
      discountCentavos: 0,
      totalCentavos: 756000,
    },
    subtotalCentavos: 756000,
    totalCentavos: 756000,
  });
  return { bookingId: booking.insertId, tourId: tour.insertId };
}

describe('trip_checkpoints, as actually migrated', () => {
  /**
   * The "start trip" event, end to end: a null `stop_id` must be accepted
   * by the database, not merely permitted by the Drizzle object. A NOT NULL
   * here would make the driver portal's first tap impossible.
   */
  dbIt('accepts a check-in with no stop, which is the trip-start event', async () => {
    await inRollback(async (tx) => {
      const { bookingId } = await makeBooking(tx);
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
                VALUES (${bookingId}, NULL, UTC_TIMESTAMP(), 0)`,
          ),
        ),
        'the trip-start check-in was refused',
      ).toBeNull();
    });
  });

  /**
   * An undo marks, never deletes (§8). Proven by doing the undo the way the
   * driver portal will — an UPDATE — and confirming the row and its
   * original timestamp are still there afterwards.
   */
  dbIt('keeps an undone check-in, with its original timestamp', async () => {
    await inRollback(async (tx) => {
      const { bookingId, tourId } = await makeBooking(tx);
      const [stop] = await tx
        .insert(tourItineraryStops)
        .values({ tourId, sortOrder: 1, name: 'Kawasan Falls' });
      await tx.execute(
        sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
            VALUES (${bookingId}, ${stop.insertId}, '2026-12-25 02:30:00', 0)`,
      );
      await tx.execute(sql`UPDATE trip_checkpoints SET undone = 1 WHERE booking_id = ${bookingId}`);

      const [rows] = (await tx.execute(
        sql`SELECT stop_id, undone, checked_at FROM trip_checkpoints WHERE booking_id = ${bookingId}`,
      )) as unknown as [Array<{ stop_id: number; undone: number; checked_at: unknown }>, unknown];
      expect(rows, 'the undo deleted the check-in instead of marking it').toHaveLength(1);
      expect(Number(rows[0]?.undone)).toBe(1);
      expect(String(rows[0]?.checked_at), 'the undo rewrote the time of the tap').toContain(
        '2026-12-25',
      );
    });
  });

  /**
   * A checkpoint against a booking that does not exist is not a trip.
   *
   * Inside `inRollback` like the rest: if this assertion ever fails, the
   * insert it expected to be refused has SUCCEEDED, and an orphan row
   * committed outside a transaction would then block the foreign key from
   * ever being re-added.
   */
  dbIt('refuses a check-in for a booking that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
                VALUES (2147483600, NULL, UTC_TIMESTAMP(), 0)`,
          ),
        ),
        'a checkpoint was written against a non-existent booking',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });

  /**
   * Task 11b-2. The double-tap the UNIQUE index is for: a driver taps
   * "Arrived at Kawasan", the request is slow, and they tap again.
   *
   * Raw `INSERT`s, so no service-layer guard can be what makes this pass —
   * the database must be the thing that refuses the second row.
   */
  dbIt('refuses a second check-in for the same (booking, real stop)', async () => {
    await inRollback(async (tx) => {
      const { bookingId, tourId } = await makeBooking(tx);
      const [stop] = await tx
        .insert(tourItineraryStops)
        .values({ tourId, sortOrder: 1, name: 'Kawasan Falls' });
      const insert = () =>
        tx.execute(
          sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
              VALUES (${bookingId}, ${stop.insertId}, UTC_TIMESTAMP(), 0)`,
        );
      expect(await rejectionCode(insert), 'the first check-in was refused').toBeNull();
      expect(
        await rejectionCode(insert),
        'a double-tap wrote the stop twice — the UNIQUE index is gone or not unique',
      ).toBe('ER_DUP_ENTRY');
    });
  });

  /**
   * **THE case the old index missed** (task 16b-2 — owner decision
   * 2026-10-11, closing the hole task 11b reported).
   *
   * `stop_id` is nullable and null means "trip start" (§8), and **MySQL
   * permits unlimited NULLs in a unique index** — so `UNIQUE (booking_id,
   * stop_id)` refused a duplicate real stop but accepted two trip-start
   * rows for one booking, which is a trip the tracker would show starting
   * twice. The `stop_key = COALESCE(stop_id, 0)` stored generated column
   * gives those rows a real key, and the UNIQUE now sits on it.
   *
   * Raw `INSERT`s, so nothing in the service layer can be what makes this
   * pass: the database must refuse the second row.
   */
  dbIt('refuses a second trip-start for the same booking (the old NULL hole)', async () => {
    await inRollback(async (tx) => {
      const { bookingId } = await makeBooking(tx);
      const insertStart = () =>
        tx.execute(
          sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
              VALUES (${bookingId}, NULL, UTC_TIMESTAMP(), 0)`,
        );
      expect(await rejectionCode(insertStart), 'the first trip-start was refused').toBeNull();
      expect(
        await rejectionCode(insertStart),
        'a double-tap on Start wrote two trip-start rows — the UNIQUE is back on ' +
          'stop_id, or stop_key is gone',
      ).toBe('ER_DUP_ENTRY');

      const [rows] = (await tx.execute(
        sql`SELECT COUNT(*) AS n FROM trip_checkpoints
            WHERE booking_id = ${bookingId} AND stop_id IS NULL`,
      )) as unknown as [Array<{ n: number }>, unknown];
      expect(Number(rows[0]?.n), 'exactly one trip-start survived').toBe(1);
    });
  });

  /**
   * `stop_key` as MySQL actually stored it: STORED GENERATED, NOT NULL, and
   * `coalesce(stop_id, 0)`. The Drizzle object says all three too, but a
   * generator can emit DDL that disagrees with it, and a VIRTUAL column
   * here would mean the UNIQUE index was built on something else entirely.
   */
  dbIt('stores stop_key as COALESCE(stop_id, 0), generated and not null', async () => {
    const [rows] = (await getPool().query(
      'SELECT IS_NULLABLE, EXTRA, GENERATION_EXPRESSION FROM information_schema.columns ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip_checkpoints' " +
        "AND COLUMN_NAME = 'stop_key'",
    )) as [Array<{ IS_NULLABLE: string; EXTRA: string; GENERATION_EXPRESSION: string }>, unknown];
    expect(rows, 'stop_key was never migrated').toHaveLength(1);
    expect(rows[0]?.IS_NULLABLE).toBe('NO');
    expect(rows[0]?.EXTRA, 'a VIRTUAL column cannot carry the UNIQUE index').toBe(
      'STORED GENERATED',
    );
    expect(rows[0]?.GENERATION_EXPRESSION.toLowerCase().replace(/[`\s]/g, '')).toBe(
      'coalesce(stop_id,0)',
    );
  });

  /**
   * The sentinel is safe: `tour_itinerary_stops.id` is an AUTO_INCREMENT
   * primary key, which never issues 0, so no real stop can ever share the
   * trip-start key and be refused for it. Asserted rather than assumed —
   * a seed or an import that forced id 0 would make every trip-start on
   * that stop's bookings impossible.
   */
  dbIt(
    'never issues stop id 0, so the trip-start key cannot collide with a real stop',
    async () => {
      const [rows] = (await getPool().query(
        'SELECT COUNT(*) AS n FROM tour_itinerary_stops WHERE id = 0',
      )) as [Array<{ n: number }>, unknown];
      expect(Number(rows[0]?.n), 'a stop with id 0 collides with the trip-start key').toBe(0);
    },
  );

  /**
   * And the index MySQL really built — on `stop_key`, unique, in that order.
   * The declaration test above reads Drizzle's object; this reads the table.
   */
  dbIt('indexes (booking_id, stop_key) uniquely in the real table', async () => {
    const [rows] = (await getPool().query(
      'SELECT NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.statistics ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip_checkpoints' " +
        "AND INDEX_NAME = 'trip_checkpoints_booking_stop_unique' ORDER BY SEQ_IN_INDEX",
    )) as [Array<{ NON_UNIQUE: number; COLUMN_NAME: string }>, unknown];
    expect(rows.map((r) => r.COLUMN_NAME)).toEqual(['booking_id', 'stop_key']);
    for (const r of rows) expect(Number(r.NON_UNIQUE), 'the index is not unique').toBe(0);
  });

  /**
   * The undo columns, end to end. `undone_by` must accept a real driver id
   * and refuse one that does not exist — an undo attributed to nobody is an
   * undo nobody can be asked about.
   */
  dbIt('records an undo against a real driver, and refuses an unknown one', async () => {
    await inRollback(async (tx) => {
      const { bookingId, tourId } = await makeBooking(tx);
      const [stop] = await tx
        .insert(tourItineraryStops)
        .values({ tourId, sortOrder: 1, name: 'Kawasan Falls' });
      const unique = `__trips__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const [driver] = await tx.insert(drivers).values({
        name: 'Test Driver',
        code: unique.slice(0, 20),
        phone: '09170000000',
        pinHash: 'x'.repeat(40),
      });
      await tx.execute(
        sql`INSERT INTO trip_checkpoints (booking_id, stop_id, checked_at, undone)
            VALUES (${bookingId}, ${stop.insertId}, UTC_TIMESTAMP(), 0)`,
      );
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`UPDATE trip_checkpoints
                SET undone = 1, undone_at = UTC_TIMESTAMP(), undone_by = ${driver.insertId}
                WHERE booking_id = ${bookingId}`,
          ),
        ),
        'a legitimate driver undo was refused',
      ).toBeNull();

      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`UPDATE trip_checkpoints SET undone_by = 2147483600
                WHERE booking_id = ${bookingId}`,
          ),
        ),
        'an undo was attributed to a driver who does not exist',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });
});

describe('review_helpful_votes, as actually migrated', () => {
  /**
   * The one-vote rule, refused BY THE DATABASE through a raw INSERT that
   * bypasses every service — because the rate limiter in front of the
   * endpoint is the first line, not the guarantee, and a vote counted twice
   * is inflated social proof.
   */
  dbIt('accepts one vote per (review, voter) and refuses the second', async () => {
    await inRollback(async (tx) => {
      const [review] = await tx.insert(reviews).values({
        name: 'Test Guest',
        rating: 5,
        body: 'A helpful review.',
      });
      const insert = () =>
        tx.execute(
          sql`INSERT INTO review_helpful_votes (review_id, voter_hash, created_at)
              VALUES (${review.insertId}, 'abc', UTC_TIMESTAMP())`,
        );
      expect(await rejectionCode(insert), 'the first vote was refused').toBeNull();
      expect(await rejectionCode(insert), 'one browser voted twice on the same review').toBe(
        'ER_DUP_ENTRY',
      );
    });
  });

  /**
   * The other half of the composite key: the same browser voting on a
   * DIFFERENT review is a normal second vote. A key on `voter_hash` alone
   * would give every visitor one helpful vote across the whole site.
   */
  dbIt('allows the same voter on a different review', async () => {
    await inRollback(async (tx) => {
      const made: number[] = [];
      for (const body of ['First review.', 'Second review.']) {
        const [review] = await tx.insert(reviews).values({ name: 'Test Guest', rating: 5, body });
        made.push(review.insertId);
      }
      for (const reviewId of made) {
        expect(
          await rejectionCode(() =>
            tx.execute(
              sql`INSERT INTO review_helpful_votes (review_id, voter_hash, created_at)
                  VALUES (${reviewId}, 'same-voter', UTC_TIMESTAMP())`,
            ),
          ),
          'a visitor got one helpful vote for the whole site',
        ).toBeNull();
      }
    });
  });

  /** Rolled back for the same reason as the checkpoint case above. */
  dbIt('refuses a vote on a review that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO review_helpful_votes (review_id, voter_hash, created_at)
                VALUES (2147483600, 'orphan', UTC_TIMESTAMP())`,
          ),
        ),
        'a helpful vote was written against a non-existent review',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });
});

describe('the retro-fitted foreign keys, as actually migrated', () => {
  /**
   * The point of retro-fitting the FK: before it, `booking_id = 99999` was
   * a perfectly storable value, and a "verified" badge could be shown for a
   * booking that never existed.
   */
  dbIt('refuses a review claiming a booking that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO reviews (booking_id, name, rating, body, created_at, updated_at)
                VALUES (2147483600, 'Fake Guest', 5, 'Great trip', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          ),
        ),
        'a review claimed a booking that does not exist',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });

  /** Still nullable — an admin-entered review has no booking behind it. */
  dbIt('still accepts a review with no booking at all', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO reviews (booking_id, name, rating, body, created_at, updated_at)
                VALUES (NULL, 'Admin Entry', 5, 'Great trip', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          ),
        ),
        'the FK made an admin-entered review impossible',
      ).toBeNull();
    });
  });

  /**
   * Task 11b-4. `reviews.tour_id` was a bare int until now, so
   * `tour_id = 99999` stored fine — a five-star review of a tour that does
   * not exist, lifting the site-wide average while appearing on no page a
   * reader could check. CLAUDE.md forbids exactly that, and this is how it
   * arrives by accident rather than by intent.
   */
  dbIt('refuses a review of a tour that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO reviews (tour_id, name, rating, body, created_at, updated_at)
                VALUES (2147483600, 'Fake Guest', 5, 'Great trip', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          ),
        ),
        'a review was stored against a non-existent tour',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });

  /**
   * Both legitimate states survive the new FK: a review of a real tour, and
   * a review of the operator as a whole with no tour behind it.
   */
  dbIt('still accepts a review of a real tour, and one of no tour at all', async () => {
    await inRollback(async (tx) => {
      const unique = `__trips__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
      const [tour] = await tx
        .insert(tours)
        .values({ slug: unique, title: unique, destinationId: destination.insertId });
      for (const tourId of [null, tour.insertId]) {
        expect(
          await rejectionCode(() =>
            tx.execute(
              sql`INSERT INTO reviews (tour_id, name, rating, body, created_at, updated_at)
                  VALUES (${tourId}, 'Guest', 5, 'Great trip', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
            ),
          ),
          `a valid review with tour_id=${tourId} was refused`,
        ).toBeNull();
      }
    });
  });

  dbIt('refuses an enquiry about a package that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO inquiries (type, package_id, name, email, message, created_at)
                VALUES ('package', 2147483600, 'Guest', 'g@example.test', 'Interested', UTC_TIMESTAMP())`,
          ),
        ),
        'an enquiry was filed against a non-existent package',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });

  /** A general contact enquiry names no package, and must stay possible. */
  dbIt('still accepts a contact enquiry with no package', async () => {
    await inRollback(async (tx) => {
      const [pkg] = await tx.insert(packages).values({
        slug: `__trips__${Date.now()}`,
        title: 'Test package',
        days: 3,
        newPrice: 1500000,
      });
      for (const packageId of [null, pkg.insertId]) {
        expect(
          await rejectionCode(() =>
            tx.execute(
              sql`INSERT INTO inquiries (type, package_id, name, email, message, created_at)
                  VALUES ('contact', ${packageId}, 'Guest', 'g@example.test', 'Hello', UTC_TIMESTAMP())`,
            ),
          ),
          'a valid enquiry was refused',
        ).toBeNull();
      }
    });
  });
});
