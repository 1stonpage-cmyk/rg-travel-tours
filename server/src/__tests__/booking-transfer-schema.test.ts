/**
 * Task T5 of the transfers-launch plan: the `bookings` schema change that
 * makes a booking a tour OR a transfer, and the 1:1
 * `booking_transfer_details` table.
 *
 * Three things are under test, and only three — this is a schema task, so
 * these are schema tests. Pricing, capacity and the booking flow belong to
 * T7/T9/T10 and are deliberately absent:
 *
 *  1. **The declaration**, through `getTableConfig()`. A column, index or
 *     CHECK removed from `schema.ts` goes red here before a migration is
 *     ever generated.
 *
 *  2. **The migrated database**, through raw SQL that bypasses Zod, Drizzle's
 *     typing and any future service-layer guard. `bookings_product_type_shape`
 *     is the whole point of the change and the point is that MySQL refuses
 *     the row — a CHECK that parses and does not enforce is decoration
 *     (MySQL ≤ 8.0.15 did exactly that).
 *
 *  3. **The 1:1-ness of `booking_transfer_details`.** Its primary key IS its
 *     foreign key, so "works once" is not the claim; "cannot happen twice"
 *     is.
 *
 * Every database fixture lives inside a transaction that is always rolled
 * back, the pattern `schema-bookings.test.ts` and `schema-payments.test.ts`
 * use. There is no `DELETE FROM bookings` anywhere in this file: a booking is
 * never hard-deleted (CLAUDE.md), and a teardown that deletes them is how
 * that rule gets normalised away.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { PRODUCT_TYPES, VEHICLE_TYPES, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool, type Transaction } from '../db/client';
import {
  bookingTransferDetails,
  bookings,
  destinations,
  tours,
  transferRoutes,
} from '../db/schema';

const PRODUCT_TYPE_CHECK = 'bookings_product_type_shape';

/**
 * Far enough out that no sweep, reminder or report window can reach it.
 * `bookings.tour_date` is a Drizzle `date()` column in `'date'` mode, so it
 * takes a `Date` — built at UTC midnight, the shape `admin-bookings.test.ts`
 * uses, never a bare string.
 */
const TOUR_DATE = new Date('2099-12-25T00:00:00Z');

const bookingsConfig = getTableConfig(bookings);
const detailsConfig = getTableConfig(bookingTransferDetails);
const bookingsColumn = (name: string) => bookingsConfig.columns.find((c) => c.name === name);
const detailsColumn = (name: string) => detailsConfig.columns.find((c) => c.name === name);

/**
 * A tour-shaped price snapshot, used for every fixture here INCLUDING the
 * transfer ones.
 *
 * Deliberate, and worth stating: `PriceSnapshot` is still the tour shape
 * (`tier`/`addons`/`coupon`/…) and widening it for transfers is explicitly
 * out of scope for this task — nothing writes a transfer booking yet, so
 * there is nothing to type against. `price_snapshot` is a JSON column, so a
 * tour-shaped blob satisfies the database, which is all these schema tests
 * need. T9/T10 decide the transfer snapshot's real shape.
 */
function validSnapshot(): PriceSnapshot {
  return {
    tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: 150000 },
    addons: [],
    coupon: null,
    depositPercent: 30,
    freeCancelHours: 24,
    subtotalCentavos: 300000,
    discountCentavos: 0,
    totalCentavos: 300000,
  };
}

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

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
 * The code, not the message: Drizzle wraps a mysql2 error in a
 * `DrizzleQueryError` whose message is the SQL text, so matching on the
 * message would pass or fail for reasons unrelated to the constraint.
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

function unique(): string {
  return `__t5__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

/** A tour and its destination, so a tour booking's FK has something to point at. */
async function makeTour(tx: Transaction): Promise<number> {
  const slug = unique();
  const [destination] = await tx.insert(destinations).values({ name: slug, slug });
  const [tour] = await tx
    .insert(tours)
    .values({ slug, title: slug, destinationId: destination.insertId });
  return tour.insertId;
}

/** A transfer route and its destination, for the `route_id` FK. */
async function makeRoute(tx: Transaction): Promise<number> {
  const slug = unique().replace(/_/g, '-');
  const [destination] = await tx.insert(destinations).values({ name: slug, slug });
  const [route] = await tx.insert(transferRoutes).values({
    destinationId: destination.insertId,
    slug,
    estimatedDurationMinutes: 120,
  });
  return route.insertId;
}

/** A public ref for a fixture. Nothing here is ever committed, so random is enough. */
function nextRef(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 6; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `RG-${tail}`;
}

/**
 * **A raw INSERT, bypassing Zod and Drizzle's typing entirely** — the whole
 * point of the CHECK tests below. `createTransferBooking()` (T10) does not
 * exist yet, so there is no service-layer guard to bypass; what has to be
 * proven is that a seed script, a migration or a hand-written INSERT at 2am
 * cannot write a booking that is a tour and a transfer at once.
 *
 * `null` is passed as a real SQL NULL rather than omitted, so the statement's
 * shape is identical across every case and only the value under test moves.
 */
function insertBookingShape(
  tx: Transaction,
  shape: {
    productType: string;
    tourId: number | null;
    routeId: number | null;
    vehicleTypeRequested: string | null;
  },
): Promise<unknown> {
  const snapshot = JSON.stringify(validSnapshot());
  return tx.execute(
    sql`INSERT INTO bookings
          (ref, tour_id, product_type, route_id, vehicle_type_requested,
           tour_date, pax, lead_name, lead_email, lead_phone,
           status, pay_mode, price_snapshot,
           subtotal_centavos, discount_centavos, total_centavos, amount_paid_centavos,
           created_at, updated_at)
        VALUES
          (${nextRef()}, ${shape.tourId}, ${shape.productType}, ${shape.routeId},
           ${shape.vehicleTypeRequested},
           '2099-12-25', 2, 'Raw SQL Guest', 'raw@example.test', '09170000000',
           'pending_payment', 'full', ${snapshot},
           300000, 0, 300000, 0,
           UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  );
}

describe('product types (@rg/shared)', () => {
  /**
   * `'tour'` must be FIRST and must be the column's default: every booking
   * that existed before the column did was a tour, and the default is what
   * backfills them. Reordering this list would change what migration 0017
   * means retroactively.
   */
  it('names the three products, tour first', () => {
    expect([...PRODUCT_TYPES]).toEqual(['tour', 'transfer_one_way', 'transfer_day_use']);
  });

  it('treats every non-tour product as a transfer', () => {
    const transfers = PRODUCT_TYPES.filter((p) => p !== 'tour');
    expect(transfers.length).toBe(2);
    for (const p of transfers) expect(p.startsWith('transfer_'), p).toBe(true);
  });
});

describe('bookings table — the transfer discriminator (declaration)', () => {
  it('makes tour_id NULLABLE, because a transfer has no tour', () => {
    expect(
      bookingsColumn('tour_id')?.notNull,
      'tour_id is still NOT NULL — a transfer booking cannot be written at all',
    ).toBe(false);
    // Still a real foreign key: nullable is not "untyped".
    const referenced = bookingsConfig.foreignKeys
      .map((fk) => fk.reference())
      .filter((r) => r.columns.some((c) => c.name === 'tour_id'));
    expect(referenced.length, 'tour_id lost its foreign key').toBe(1);
  });

  it('discriminates with product_type, NOT NULL and defaulting to tour', () => {
    expect(bookingsColumn('product_type')?.enumValues).toEqual([...PRODUCT_TYPES]);
    expect(bookingsColumn('product_type')?.notNull).toBe(true);
    expect(
      bookingsColumn('product_type')?.default,
      'without a tour default, migration 0017 would leave every existing booking undecided',
    ).toBe('tour');
  });

  it('carries a nullable route_id pointing at transfer_routes, and a nullable vehicle type', () => {
    expect(bookingsColumn('route_id')?.notNull).toBe(false);
    const routeFk = bookingsConfig.foreignKeys
      .map((fk) => fk.reference())
      .find((r) => r.columns.some((c) => c.name === 'route_id'));
    expect(routeFk, 'route_id is not a foreign key').toBeDefined();
    expect(getTableConfig(routeFk!.foreignTable).name).toBe('transfer_routes');

    expect(bookingsColumn('vehicle_type_requested')?.enumValues).toEqual([...VEHICLE_TYPES]);
    expect(bookingsColumn('vehicle_type_requested')?.notNull).toBe(false);
  });

  it('cascades nothing, route_id included', () => {
    for (const fk of bookingsConfig.foreignKeys) {
      const columns = fk
        .reference()
        .columns.map((c) => c.name)
        .join(',');
      expect(fk.onDelete, `${columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${columns} must not cascade`).toBeUndefined();
    }
  });

  it('declares the product-type shape CHECK', () => {
    expect(
      bookingsConfig.checks.map((c) => c.name),
      'nothing stops a booking being a tour and a transfer at once',
    ).toContain(PRODUCT_TYPE_CHECK);
  });

  /**
   * The existing capacity index leads on `tour_id`, which is NULL for every
   * transfer row — so a transfer date sweep would get no use from it. This is
   * its twin, `product_type` in the lead.
   */
  it('indexes product_type + date + status for transfer capacity queries', () => {
    const indexes = Object.fromEntries(
      bookingsConfig.indexes.map((i) => [
        i.config.name,
        i.config.columns.map((c) => ('name' in c ? c.name : String(c))),
      ]),
    ) as Record<string, string[]>;
    expect(indexes['bookings_product_type_date_idx']).toEqual([
      'product_type',
      'tour_date',
      'status',
    ]);
    // The tour-side index is untouched.
    expect(indexes['bookings_tour_date_status_idx']).toEqual(['tour_id', 'tour_date', 'status']);
  });
});

describe('booking_transfer_details table (declaration)', () => {
  /**
   * The primary key IS the foreign key. A surrogate `id` would permit a
   * second details row for one booking, and "which pickup time is this
   * trip's" would become a question with two answers.
   */
  it('keys on booking_id and nothing else — one row per booking, for ever', () => {
    const pkColumns = detailsConfig.columns.filter((c) => c.primary).map((c) => c.name);
    expect(pkColumns).toEqual(['booking_id']);
    expect(detailsConfig.columns.map((c) => c.name)).not.toContain('id');

    const fk = detailsConfig.foreignKeys.map((f) => f.reference())[0];
    expect(fk?.columns.map((c) => c.name)).toEqual(['booking_id']);
    expect(getTableConfig(fk!.foreignTable).name).toBe('bookings');
  });

  it('requires a pickup time, a dropoff and the frozen buffer; leaves the rest optional', () => {
    for (const required of [
      'pickup_time',
      'dropoff_address',
      'buffer_minutes_used',
      'luggage_count',
    ]) {
      expect(detailsColumn(required)?.notNull, `${required} must be NOT NULL`).toBe(true);
    }
    for (const optional of [
      'day_use_end_time',
      'dropoff_map_url',
      'flight_number',
      'airline',
      'custom_route_description',
    ]) {
      expect(detailsColumn(optional)?.notNull, `${optional} must be nullable`).toBe(false);
    }
  });

  /**
   * `buffer_minutes_used` freezes the setting's value at hold time, the same
   * reasoning as `bookings.price_snapshot`. NOT NULL with **no default**: a
   * default would let a writer that forgot the value record a buffer nobody
   * chose, which is exactly the reinterpretation this column exists to
   * prevent.
   */
  it('freezes the buffer with no default to fall back on', () => {
    expect(detailsColumn('buffer_minutes_used')?.notNull).toBe(true);
    expect(detailsColumn('buffer_minutes_used')?.default).toBeUndefined();
  });

  it('uses no decimal, float or double anywhere', () => {
    const offenders = detailsConfig.columns
      .filter((c) => /decimal|float|double|numeric|real/i.test(c.getSQLType()))
      .map((c) => `${c.name}: ${c.getSQLType()}`);
    expect(offenders).toEqual([]);
  });
});

/** False when MySQL is unreachable, which is how the rest of the suite behaves. */
async function tableExists(name: string): Promise<boolean> {
  try {
    const [rows] = (await getPool().query(
      'SELECT 1 FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name],
    )) as [unknown[], unknown];
    return rows.length > 0;
  } catch {
    return false;
  }
}

const migrated = (await tableExists('bookings')) && (await tableExists('booking_transfer_details'));
const dbIt = migrated ? it : it.skip;

describe('bookings + booking_transfer_details, as actually migrated', () => {
  dbIt('declares the product-type CHECK as a real, enforced constraint', async () => {
    const [rows] = (await getPool().query(
      'SELECT CHECK_CLAUSE FROM information_schema.check_constraints ' +
        'WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?',
      [PRODUCT_TYPE_CHECK],
    )) as [Array<{ CHECK_CLAUSE: string }>, unknown];
    expect(rows.length, `${PRODUCT_TYPE_CHECK} was dropped or never migrated`).toBe(1);
    // MySQL rewrites the clause it stores: backticks, whitespace, a
    // `_utf8mb4` charset introducer on every string literal, and a backslash
    // escaping each of that literal's quotes. Normalise all four away so the
    // assertions below are about the LOGIC, not the server's spelling of it.
    const clause = String(rows[0]?.CHECK_CLAUSE)
      .replace(/[`\s\\]/g, '')
      .replace(/_utf8mb4/g, '');
    // Both branches, in both directions — a clause that drifted to naming
    // only `tour_id` would still appear in the catalogue.
    expect(clause).toContain("product_type='tour'");
    expect(clause).toContain("product_type<>'tour'");
    expect(clause.match(/tour_idisnotnull/gi)?.length).toBe(1);
    expect(clause.match(/tour_idisnull/gi)?.length).toBe(1);
    expect(clause.match(/vehicle_type_requestedisnotnull/gi)?.length).toBe(1);
    expect(clause.match(/vehicle_type_requestedisnull/gi)?.length).toBe(1);
    // route_id is deliberately NOT in the CHECK — the XOR with
    // custom_route_description is cross-table and lives in the writer.
    expect(clause, 'route_id must not be constrained here').not.toContain('route_id');
  });

  dbIt('made tour_id nullable in the real table, and backfilled product_type to tour', async () => {
    const [rows] = (await getPool().query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
         FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
          AND COLUMN_NAME IN ('tour_id', 'product_type', 'route_id', 'vehicle_type_requested')`,
    )) as [
      Array<{
        COLUMN_NAME: string;
        IS_NULLABLE: string;
        COLUMN_DEFAULT: string | null;
        COLUMN_TYPE: string;
      }>,
      unknown,
    ];
    const byName = Object.fromEntries(rows.map((r) => [String(r.COLUMN_NAME), r]));
    expect(byName['tour_id']?.IS_NULLABLE).toBe('YES');
    expect(byName['route_id']?.IS_NULLABLE).toBe('YES');
    expect(byName['vehicle_type_requested']?.IS_NULLABLE).toBe('YES');
    expect(byName['product_type']?.IS_NULLABLE).toBe('NO');
    expect(byName['product_type']?.COLUMN_DEFAULT).toBe('tour');
    expect(byName['product_type']?.COLUMN_TYPE).toBe(
      "enum('tour','transfer_one_way','transfer_day_use')",
    );

    // No pre-0017 booking may have been left undecided by the backfill.
    const [undecided] = (await getPool().query(
      "SELECT COUNT(*) AS n FROM bookings WHERE product_type IS NULL OR product_type = ''",
    )) as [Array<{ n: number }>, unknown];
    expect(Number(undecided[0]?.n)).toBe(0);
  });

  dbIt('carries the transfer capacity index', async () => {
    const [rows] = (await getPool().query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'`,
    )) as [Array<{ INDEX_NAME: string }>, unknown];
    expect(rows.map((r) => String(r.INDEX_NAME))).toContain('bookings_product_type_date_idx');
  });

  /**
   * The shape every existing fixture in the suite uses. If this fails, the
   * default or the CHECK is wrong and migration 0017 broke every booking the
   * system already takes.
   */
  dbIt('still accepts a tour-shaped booking, unchanged', async () => {
    await inRollback(async (tx) => {
      const tourId = await makeTour(tx);
      const [result] = await tx.insert(bookings).values({
        ref: nextRef(),
        tourId,
        tourDate: TOUR_DATE,
        pax: 2,
        leadName: 'Tour Guest',
        leadEmail: 'tour@example.test',
        leadPhone: '09170000000',
        payMode: 'full',
        priceSnapshot: validSnapshot(),
        subtotalCentavos: 300000,
        totalCentavos: 300000,
      });

      const [row] = await tx
        .select({
          productType: bookings.productType,
          tourId: bookings.tourId,
          routeId: bookings.routeId,
          vehicleTypeRequested: bookings.vehicleTypeRequested,
        })
        .from(bookings)
        .where(sql`id = ${result.insertId}`)
        .limit(1);

      // The default is what backfills: a writer that knows nothing about
      // product_type still produces a tour.
      expect(row?.productType, 'a booking written without product_type is not a tour').toBe('tour');
      expect(row?.tourId).toBe(tourId);
      expect(row?.routeId).toBeNull();
      expect(row?.vehicleTypeRequested).toBeNull();
    });
  });

  dbIt('accepts a transfer-shaped booking with no tour at all', async () => {
    await inRollback(async (tx) => {
      const routeId = await makeRoute(tx);
      const [result] = await tx.insert(bookings).values({
        ref: nextRef(),
        tourId: null,
        productType: 'transfer_one_way',
        routeId,
        vehicleTypeRequested: 'van',
        tourDate: TOUR_DATE,
        pax: 3,
        leadName: 'Transfer Guest',
        leadEmail: 'transfer@example.test',
        leadPhone: '09170000001',
        payMode: 'full',
        priceSnapshot: validSnapshot(),
        subtotalCentavos: 250000,
        totalCentavos: 250000,
      });

      const [row] = await tx
        .select({
          productType: bookings.productType,
          tourId: bookings.tourId,
          routeId: bookings.routeId,
          vehicleTypeRequested: bookings.vehicleTypeRequested,
        })
        .from(bookings)
        .where(sql`id = ${result.insertId}`)
        .limit(1);

      expect(row?.tourId, 'a transfer booking must not carry a tour').toBeNull();
      expect(row?.productType).toBe('transfer_one_way');
      expect(row?.routeId).toBe(routeId);
      expect(row?.vehicleTypeRequested).toBe('van');
    });
  });

  /** Both transfer products satisfy the CHECK, not just the one-way. */
  dbIt('accepts a day-use transfer too', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          insertBookingShape(tx, {
            productType: 'transfer_day_use',
            tourId: null,
            routeId: null,
            vehicleTypeRequested: 'suv',
          }),
        ),
        'a day-use transfer with a custom route was refused',
      ).toBeNull();
    });
  });

  /**
   * **The three rejections, by the DATABASE, through raw SQL.** One field at a
   * time off an otherwise valid row, so what fired is unambiguous.
   */
  const REJECTED: Array<[string, Parameters<typeof insertBookingShape>[1], string]> = [
    [
      'a tour with no tour_id',
      { productType: 'tour', tourId: null, routeId: null, vehicleTypeRequested: null },
      'a tour booking pointing at no tour was accepted — it is in no tour report and on no tour',
    ],
    [
      'a transfer with no vehicle type requested',
      {
        productType: 'transfer_one_way',
        tourId: null,
        routeId: null,
        vehicleTypeRequested: null,
      },
      'a transfer with no vehicle type was accepted — nothing says which vehicle to send',
    ],
    [
      'a tour carrying a vehicle type requested',
      { productType: 'tour', tourId: -1, routeId: null, vehicleTypeRequested: 'van' },
      'a tour booking carrying a vehicle-type-requested was accepted — "is this a transfer?" now has two answers',
    ],
  ];

  for (const [label, shape, why] of REJECTED) {
    dbIt(`REFUSES ${label}`, async () => {
      await inRollback(async (tx) => {
        const resolved = { ...shape, tourId: shape.tourId === -1 ? await makeTour(tx) : null };
        expect(await rejectionCode(() => insertBookingShape(tx, resolved)), why).toBe(
          'ER_CHECK_CONSTRAINT_VIOLATED',
        );
        const [rows] = (await tx.execute(
          sql`SELECT COUNT(*) AS n FROM bookings WHERE product_type = ${resolved.productType}
                AND lead_email = 'raw@example.test'`,
        )) as unknown as [Array<{ n: number }>, unknown];
        expect(Number(rows[0]?.n), 'the refused row was written anyway').toBe(0);
      });
    });
  }

  /**
   * A transfer with NO `route_id` must be accepted — a staff-quoted custom
   * trip has no catalog route and carries
   * `booking_transfer_details.custom_route_description` instead. This is the
   * half the CHECK deliberately does not police, asserted so nobody "fixes"
   * the perceived gap by adding `route_id` to it.
   */
  dbIt('ACCEPTS a transfer with no route_id — a custom, staff-quoted trip', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          insertBookingShape(tx, {
            productType: 'transfer_one_way',
            tourId: null,
            routeId: null,
            vehicleTypeRequested: 'van',
          }),
        ),
        'route_id was added to the CHECK — a custom transfer can no longer be booked',
      ).toBeNull();
    });
  });

  dbIt('round-trips a booking_transfer_details row, and refuses a second one', async () => {
    await inRollback(async (tx) => {
      const routeId = await makeRoute(tx);
      const [booking] = await tx.insert(bookings).values({
        ref: nextRef(),
        tourId: null,
        productType: 'transfer_day_use',
        routeId,
        vehicleTypeRequested: 'suv',
        tourDate: TOUR_DATE,
        pax: 4,
        leadName: 'Day Use Guest',
        leadEmail: 'dayuse@example.test',
        leadPhone: '09170000002',
        payMode: 'deposit',
        priceSnapshot: validSnapshot(),
        subtotalCentavos: 600000,
        totalCentavos: 600000,
      });

      const details = {
        bookingId: booking.insertId,
        pickupTime: '05:30',
        dayUseEndTime: '18:00',
        dropoffAddress: 'Kawasan Falls parking, Badian, Cebu',
        dropoffMapUrl: 'https://maps.example.test/kawasan',
        luggageCount: 3,
        flightNumber: 'PR2871',
        airline: 'Philippine Airlines',
        customRouteDescription: null,
        bufferMinutesUsed: 45,
      };
      await tx.insert(bookingTransferDetails).values(details);

      const [row] = await tx
        .select()
        .from(bookingTransferDetails)
        .where(sql`booking_id = ${booking.insertId}`)
        .limit(1);

      expect(row).toMatchObject(details);
      expect(row?.createdAt).toBeInstanceOf(Date);
      expect(row?.updatedAt).toBeInstanceOf(Date);

      /*
       * The 1:1 claim. "Works once" is not it — the primary key has to be
       * what refuses the second row, and a surrogate `id` would have let this
       * through with two different pickup times for one trip.
       */
      expect(
        await rejectionCode(() =>
          tx
            .insert(bookingTransferDetails)
            .values({ ...details, pickupTime: '09:00', bufferMinutesUsed: 60 }),
        ),
        'a SECOND details row was accepted for one booking — the table is not 1:1',
      ).toBe('ER_DUP_ENTRY');

      // And the first row is untouched by the refused insert.
      const [after] = await tx
        .select({ pickupTime: bookingTransferDetails.pickupTime })
        .from(bookingTransferDetails)
        .where(sql`booking_id = ${booking.insertId}`)
        .limit(1);
      expect(after?.pickupTime).toBe('05:30');
    });
  });

  /** Defaults: a one-way transfer with no day-use end and no luggage stated. */
  dbIt('defaults luggage to zero and leaves the optional fields null', async () => {
    await inRollback(async (tx) => {
      const [booking] = await tx.insert(bookings).values({
        ref: nextRef(),
        tourId: null,
        productType: 'transfer_one_way',
        vehicleTypeRequested: 'van',
        tourDate: TOUR_DATE,
        pax: 2,
        leadName: 'Minimal Guest',
        leadEmail: 'minimal@example.test',
        leadPhone: '09170000003',
        payMode: 'full',
        priceSnapshot: validSnapshot(),
        subtotalCentavos: 200000,
        totalCentavos: 200000,
      });

      await tx.insert(bookingTransferDetails).values({
        bookingId: booking.insertId,
        pickupTime: '06:00',
        dropoffAddress: 'Mactan-Cebu International Airport, Terminal 2',
        customRouteDescription: 'Hotel pickup in Mandaue, no catalog route',
        bufferMinutesUsed: 30,
      });

      const [row] = await tx
        .select()
        .from(bookingTransferDetails)
        .where(sql`booking_id = ${booking.insertId}`)
        .limit(1);

      expect(row?.luggageCount).toBe(0);
      expect(row?.dayUseEndTime).toBeNull();
      expect(row?.dropoffMapUrl).toBeNull();
      expect(row?.flightNumber).toBeNull();
      expect(row?.airline).toBeNull();
      expect(row?.customRouteDescription).toBe('Hotel pickup in Mandaue, no catalog route');
    });
  });

  dbIt('refuses a details row for a booking that does not exist', async () => {
    await inRollback(async (tx) => {
      expect(
        await rejectionCode(() =>
          tx.insert(bookingTransferDetails).values({
            bookingId: 2_000_000_000,
            pickupTime: '07:00',
            dropoffAddress: 'Nowhere',
            bufferMinutesUsed: 30,
          }),
        ),
        'a details row with no booking behind it was accepted',
      ).toBe('ER_NO_REFERENCED_ROW_2');
    });
  });
});
