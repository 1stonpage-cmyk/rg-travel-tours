/**
 * Task 10 of the core-schema plan: the three tables that hang off a
 * booking — `booking_addons`, `booking_notes` and `coupon_redemptions`.
 *
 * All three are WAVE 3 tables, and Waves 2–4 are generated once, in Task 11,
 * so none of them exists in any database yet. Hence two layers, the same
 * split `schema-bookings.test.ts` uses:
 *
 *  1. **Shape assertions read the Drizzle table object** through
 *     `getTableConfig()` — the very object drizzle-kit will emit DDL from.
 *     Every one of them fails today if the column, foreign key or index it
 *     names is changed, and not one of them passes because a table is
 *     missing.
 *
 *  2. **The load-bearing constraints are re-asserted against the real
 *     database**, gated on the tables existing. They report as SKIPPED until
 *     Wave 3 is applied and enable themselves the moment it is — the pattern
 *     in `audit.test.ts` and `schema-sessions.test.ts`. A schema object and
 *     the DDL a generator emits from it are two different things, and "the
 *     database refuses a second redemption" is exactly the kind of property
 *     that can be true in one and false in the other.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { getDb, getPool, type Transaction } from '../db/client';
import {
  bookingAddons,
  bookingNotes,
  bookings,
  couponRedemptions,
  coupons,
  destinations,
  tourAddons,
  tours,
  users,
} from '../db/schema';

interface Shape {
  columnNames: string[];
  column: (name: string) => ReturnType<typeof getTableConfig>['columns'][number] | undefined;
  indexes: Record<string, string[]>;
  /** Only the indexes drizzle-kit will emit as UNIQUE, by name. */
  uniqueIndexes: Record<string, string[]>;
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
    uniqueIndexes: Object.fromEntries(
      config.indexes
        .filter((i) => i.config.unique === true)
        .map((i) => [i.config.name, names(i.config.columns)]),
    ),
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

const addons = shapeOf(bookingAddons);
const notes = shapeOf(bookingNotes);
const redemptions = shapeOf(couponRedemptions);

describe('booking_addons', () => {
  /**
   * The point of the whole table. An add-on may be renamed from "Island
   * lunch" to "Lunch (buffet)" and repriced from ₱350 to ₱500 next season;
   * a booking taken this season must still say what the guest actually
   * agreed to pay for. The foreign key alone cannot do that — it points at
   * a row that changes. So the line carries its own copy, for the same
   * reason `bookings.price_snapshot` exists.
   */
  it('snapshots the add-on name and price, so a later edit cannot rewrite history', () => {
    for (const required of ['addon_id', 'name', 'price_centavos', 'per_person', 'qty']) {
      expect(addons.columnNames, `${required} is missing from the snapshot`).toContain(required);
    }
    expect(addons.column('name')?.notNull).toBe(true);
    expect(addons.column('price_centavos')?.notNull).toBe(true);
    expect(addons.column('per_person')?.notNull).toBe(true);
  });

  /**
   * Money is integer centavos everywhere (CLAUDE.md), and this column is
   * written from server-side data only — never from a value the browser
   * sent. `per_person` decides whether it multiplies by `pax`, so storing
   * one without the other would make the line unpriceable.
   */
  it('stores the price as int centavos and names it so', () => {
    expect(addons.column('price_centavos')?.getSQLType()).toBe('int');
    const moneyish = addons.columnNames.filter((n) => /amount|price|total|fee/.test(n));
    expect(moneyish.filter((n) => !/_centavos$/.test(n))).toEqual([]);
    const offenders = addons.columnNames.filter((n) =>
      /decimal|float|double|numeric/i.test(addons.column(n)?.getSQLType() ?? ''),
    );
    expect(offenders).toEqual([]);
  });

  it('defaults the quantity to one line, and requires it', () => {
    expect(addons.column('qty')?.getSQLType()).toBe('int');
    expect(addons.column('qty')?.notNull).toBe(true);
    expect(addons.column('qty')?.default).toBe(1);
  });

  /**
   * Nothing in this schema cascades (plan: `ON DELETE RESTRICT` everywhere).
   * A cascade from `tour_addons` would silently delete the add-on lines of
   * paid bookings the moment an admin tidied up a tour's add-on list — and
   * the booking's money would no longer add up.
   */
  it('references bookings and tour_addons, and cascades nothing', () => {
    expect(addons.foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`).sort()).toEqual([
      'addon_id->tour_addons',
      'booking_id->bookings',
    ]);
    for (const fk of addons.foreignKeys) {
      expect(fk.foreignColumns).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
    expect(addons.column('booking_id')?.notNull).toBe(true);
    expect(addons.column('addon_id')?.notNull).toBe(true);
  });

  it('indexes the lines of one booking, which is the only way they are read', () => {
    expect(addons.indexes['booking_addons_booking_idx']).toEqual(['booking_id']);
  });
});

describe('booking_notes', () => {
  /**
   * `user_id` is NOT NULL, deliberately. An internal note is read later to
   * reconstruct why a booking was moved, refunded or argued about, and an
   * unattributed note cannot be audited — "someone decided to waive the
   * balance" is not a record of anything. Nullable here would also make the
   * natural import path (a bulk migration with no author) land a pile of
   * anonymous notes.
   */
  it('attributes every note to the admin who wrote it, never null', () => {
    expect(notes.column('user_id')?.notNull, 'an unattributed note is not auditable').toBe(true);
    expect(notes.column('booking_id')?.notNull).toBe(true);
    expect(notes.column('note')?.getSQLType()).toBe('text');
    expect(notes.column('note')?.notNull).toBe(true);
  });

  it('references bookings and users, and cascades nothing', () => {
    expect(notes.foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`).sort()).toEqual([
      'booking_id->bookings',
      'user_id->users',
    ]);
    for (const fk of notes.foreignKeys) {
      expect(fk.foreignColumns).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
  });

  /**
   * MySQL's `timestamp` converts on read and write using the session's
   * `time_zone`, so the same row reads differently from two connections.
   * Every instant in this schema is `datetime`, written in UTC from JS.
   */
  it('times the note with a UTC datetime, never MySQL timestamp', () => {
    expect(notes.column('created_at')?.getSQLType()).toBe('datetime');
    expect(notes.column('created_at')?.notNull).toBe(true);
    expect(notes.column('created_at')?.hasDefault).toBe(true);
  });

  it('indexes a booking note thread in the order it is displayed', () => {
    expect(notes.indexes['booking_notes_booking_idx']).toEqual(['booking_id', 'created_at']);
  });
});

describe('coupon_redemptions', () => {
  /**
   * One row per coupon use is what enforces `usage_limit`, so a booking
   * must not be able to count twice against the same coupon. The uniqueness
   * is `(coupon_id, booking_id)` — not `booking_id` alone, which would stop
   * a booking ever using a second coupon, and not `coupon_id` alone, which
   * would cap every coupon at one use in total.
   */
  it('records at most one redemption per coupon per booking', () => {
    expect(redemptions.uniqueIndexes['coupon_redemptions_unique']).toEqual([
      'coupon_id',
      'booking_id',
    ]);
    expect(redemptions.column('coupon_id')?.notNull).toBe(true);
    expect(redemptions.column('booking_id')?.notNull).toBe(true);
    // And neither column may carry a unique constraint of its own: one would
    // cap the coupon at a single use, the other would cap the booking at one
    // coupon. Only the PAIR is unique.
    expect(redemptions.column('coupon_id')?.isUnique).toBeFalsy();
    expect(redemptions.column('booking_id')?.isUnique).toBeFalsy();
  });

  it('indexes the coupon, which is how the usage cap is counted', () => {
    expect(redemptions.indexes['coupon_redemptions_coupon_idx']).toEqual(['coupon_id']);
  });

  it('references coupons and bookings, and cascades nothing', () => {
    expect(
      redemptions.foreignKeys.map((fk) => `${fk.columns.join(',')}->${fk.table}`).sort(),
    ).toEqual(['booking_id->bookings', 'coupon_id->coupons']);
    for (const fk of redemptions.foreignKeys) {
      expect(fk.foreignColumns).toEqual(['id']);
      expect(fk.onDelete, `${fk.columns} must not cascade`).toBeUndefined();
      expect(fk.onUpdate, `${fk.columns} must not cascade`).toBeUndefined();
    }
  });

  it('times the redemption with a UTC datetime', () => {
    expect(redemptions.column('created_at')?.getSQLType()).toBe('datetime');
    expect(redemptions.column('created_at')?.notNull).toBe(true);
  });
});

/**
 * True once Wave 3 (Task 11) has created these tables in `rg_travel_test`.
 * Also false when MySQL is unreachable, which is how the rest of the suite
 * behaves (see `helpers/db.ts`).
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

const migrated = await tablesExist([
  'bookings',
  'booking_addons',
  'booking_notes',
  'coupon_redemptions',
]);
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
 * The code, not the message. Drizzle wraps a mysql2 error in its own
 * `DrizzleQueryError` whose message is the SQL text — so matching
 * `/duplicate/i` on a statement issued through a transaction handle passes
 * or fails for reasons that have nothing to do with the constraint under
 * test. `ER_DUP_ENTRY` and `ER_BAD_NULL_ERROR` are exact, and say which
 * constraint did the refusing. The chain is walked, and bounded, for the
 * same reason `services/booking-ref.ts` walks one.
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
async function makeBooking(tx: Transaction): Promise<number> {
  const unique = `__lines__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
  const [tour] = await tx
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  const [booking] = await tx.insert(bookings).values({
    ref: `RG-${unique
      .slice(-6)
      .toUpperCase()
      .replace(/[^ABCDEFGHJKMNPQRSTVWXYZ23456789]/g, 'A')}`,
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
  return booking.insertId;
}

describe('the booking lines, as actually migrated', () => {
  /**
   * The snapshot, proven end to end: the add-on is repriced after the line
   * is written, and the line must not move. A schema that trusted the
   * foreign key for money would show the new price here.
   */
  dbIt('keeps an add-on line at its snapshotted price after the add-on is repriced', async () => {
    await inRollback(async (tx) => {
      const bookingId = await makeBooking(tx);
      const [addon] = await tx
        .insert(tourAddons)
        .values({ tourId: 1, name: 'Island lunch', price: 35000, perPerson: true });
      await tx.insert(bookingAddons).values({
        bookingId,
        addonId: addon.insertId,
        name: 'Island lunch',
        priceCentavos: 35000,
        perPerson: true,
        qty: 1,
      });

      // The add-on is renamed and repriced, the way next season's admin would.
      await tx.execute(
        sql`UPDATE tour_addons SET name = 'Lunch (buffet)', price = 50000 WHERE id = ${addon.insertId}`,
      );

      const [rows] = (await tx.execute(
        sql`SELECT name, price_centavos FROM booking_addons WHERE booking_id = ${bookingId}`,
      )) as unknown as [Array<{ name: string; price_centavos: number }>, unknown];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name, 'the line followed the renamed add-on').toBe('Island lunch');
      expect(Number(rows[0]?.price_centavos), 'the line followed the new price').toBe(35000);
    });
  });

  /**
   * Refused BY THE DATABASE, through a raw INSERT that bypasses Zod and
   * every service — because a seed script, a migration or a hand-written
   * UPDATE at 2am all bypass application validation too, and a coupon
   * counted twice is a usage cap that does not hold.
   */
  dbIt('refuses a second redemption of the same coupon on the same booking', async () => {
    await inRollback(async (tx) => {
      const bookingId = await makeBooking(tx);
      const [coupon] = await tx.insert(coupons).values({
        code: `__lines__${Date.now()}`,
        discountType: 'percent',
        percentBp: 1000,
        amountCentavos: null,
      });
      const insert = () =>
        tx.execute(
          sql`INSERT INTO coupon_redemptions (coupon_id, booking_id, created_at)
              VALUES (${coupon.insertId}, ${bookingId}, UTC_TIMESTAMP())`,
        );
      expect(await rejectionCode(insert), 'the first redemption was refused').toBeNull();
      expect(
        await rejectionCode(insert),
        'a booking counted twice against one coupon, so the usage cap does not hold',
      ).toBe('ER_DUP_ENTRY');
    });
  });

  /**
   * The other half of that index: the same coupon on a DIFFERENT booking is
   * a normal second use. A unique index on `coupon_id` alone would cap every
   * coupon at one redemption in total, which is not what `usage_limit` means.
   */
  dbIt('allows the same coupon on a different booking', async () => {
    await inRollback(async (tx) => {
      const first = await makeBooking(tx);
      const second = await makeBooking(tx);
      const [coupon] = await tx.insert(coupons).values({
        code: `__lines2__${Date.now()}`,
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 10000,
      });
      for (const bookingId of [first, second]) {
        expect(
          await rejectionCode(() =>
            tx.execute(
              sql`INSERT INTO coupon_redemptions (coupon_id, booking_id, created_at)
                  VALUES (${coupon.insertId}, ${bookingId}, UTC_TIMESTAMP())`,
            ),
          ),
          'a second booking could not use the coupon — the cap is one use in total',
        ).toBeNull();
      }
    });
  });

  /**
   * Fails closed: the database, not the service layer, is what refuses an
   * anonymous note. Raw INSERT again, for the same reason as above.
   */
  dbIt('refuses an internal note with no author', async () => {
    await inRollback(async (tx) => {
      const bookingId = await makeBooking(tx);
      const [user] = await tx.insert(users).values({
        name: 'Test Admin',
        email: `__lines__${Date.now()}@example.test`,
        passwordHash: 'x',
        role: 'owner',
      });
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO booking_notes (booking_id, user_id, note, created_at)
                VALUES (${bookingId}, ${user.insertId}, 'Moved to the 26th', UTC_TIMESTAMP())`,
          ),
        ),
        'an attributed note was refused',
      ).toBeNull();
      expect(
        await rejectionCode(() =>
          tx.execute(
            sql`INSERT INTO booking_notes (booking_id, user_id, note, created_at)
                VALUES (${bookingId}, NULL, 'Someone waived the balance', UTC_TIMESTAMP())`,
          ),
        ),
        'an anonymous internal note was accepted — it cannot be audited',
      ).toBe('ER_BAD_NULL_ERROR');
    });
  });
});
