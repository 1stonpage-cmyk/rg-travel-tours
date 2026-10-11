/**
 * Task 9 of the core-schema plan: `generateBookingRef()` and the
 * collision-safe insert.
 *
 * Two layers, and the split matters:
 *
 *  1. **The generator is a pure function** over `node:crypto` with no table
 *     anywhere near it, so every assertion about it runs for real, today —
 *     nothing here is gated.
 *
 *  2. **`insertBookingWithRef` touches `bookings`**, a WAVE 2 table that
 *     Task 11 generates. Those assertions are gated on the table actually
 *     existing (the pattern in `audit.test.ts`, `schema-sessions.test.ts`
 *     and `schema-bookings.test.ts`): they report as SKIPPED until Wave 2 is
 *     applied and enable themselves the moment it is. They never pass
 *     because the table is missing.
 *
 * The ref is a credential, not a cosmetic id. §7 logs a guest into the
 * portal with ref + email, so a predictable ref is half a password and lets
 * someone walk other people's bookings — which is why the `Math.random`
 * assertion below is the load-bearing one.
 */
import { describe, expect, it, vi } from 'vitest';
import { bookingRefSchema } from '@rg/shared';
import { getDb, getPool, type Transaction } from '../db/client';
import { destinations, tours } from '../db/schema';
import { REF_ALPHABET, generateBookingRef, insertBookingWithRef } from '../services/booking-ref';

describe('generateBookingRef', () => {
  it('matches the public ref format @rg/shared already defines', () => {
    for (let i = 0; i < 200; i += 1) {
      const ref = generateBookingRef();
      expect(bookingRefSchema.safeParse(ref).success, ref).toBe(true);
    }
  });

  /**
   * A guest reads this aloud over a bad mobile line from a kerb in Cebu.
   * 0/O, 1/I/L and U (which reads as V in a lot of handwriting) are all
   * excluded, and the alphabet must stay in lockstep with the regex in
   * `bookingRefSchema` — widen one without the other and the generator
   * mints refs the schema rejects.
   */
  it('omits every character a guest could misread over the phone', () => {
    for (const banned of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(REF_ALPHABET, `${banned} is ambiguous when read aloud`).not.toContain(banned);
    }
    expect(REF_ALPHABET.length, '30 characters give 30^6 ≈ 729 million refs').toBe(30);
    // No duplicate character, or the distribution is quietly skewed.
    expect(new Set(REF_ALPHABET).size).toBe(REF_ALPHABET.length);
  });

  it('is not sequential — 500 refs share no common prefix beyond "RG-"', () => {
    const refs = Array.from({ length: 500 }, generateBookingRef);
    const firstChars = new Set(refs.map((r) => r[3]));
    expect(firstChars.size, 'the first ref character barely varies').toBeGreaterThan(5);
    // And they are not merely all one value: 500 draws from 729M should collide never.
    expect(new Set(refs).size).toBe(refs.length);
  });

  /**
   * THE assertion of this task. `Math.random` is a non-cryptographic PRNG
   * whose internal state is recoverable from a handful of outputs, so refs
   * drawn from it are predictable — and a predictable ref is half of a
   * customer-portal login (§7: ref + email).
   */
  it('draws from crypto randomness, not Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    generateBookingRef();
    expect(spy, 'booking refs must not come from Math.random').not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * True once Wave 2 (Task 11) has created `bookings` in `rg_travel_test`.
 * Also false when MySQL is unreachable, which is how the rest of the suite
 * behaves (see `helpers/db.ts`).
 */
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

const bookingsExists = await tableExists('bookings');
const dbIt = bookingsExists ? it : it.skip;

/** Thrown to roll the fixture transaction back; never escapes `inRollback`. */
const ROLLBACK = new Error('__rollback__');

/**
 * Runs `fn` inside a transaction that is always rolled back, and returns
 * whatever it produced.
 *
 * Nothing these tests write is ever committed — not the booking, not the
 * tour and destination it needs for its foreign key. That matters twice
 * over: bookings are never hard-deleted (CLAUDE.md), so a cleanup that
 * DELETEs them would be modelling the one operation the system forbids;
 * and `insertBookingWithRef` takes a transaction handle anyway, so this is
 * the shape a real caller uses.
 */
async function inRollback<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await getDb().transaction(async (tx) => {
      result = await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result as T;
}

/** A tour (and the destination it needs) to hang a booking's FK on. */
async function makeTour(tx: Transaction): Promise<number> {
  const unique = `__bookingref__${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const [destination] = await tx.insert(destinations).values({ name: unique, slug: unique });
  const [tour] = await tx
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  return tour.insertId;
}

/** The NOT NULL columns of `bookings`, minus `ref` — which is the point. */
function bookingValues(tourId: number) {
  return {
    tourId,
    // `tour_date` is a civil Manila date; Drizzle's `date` column takes a
    // Date and formats it, so midnight UTC keeps the calendar day intact.
    tourDate: new Date('2026-12-25T00:00:00Z'),
    pax: 4,
    leadName: 'Test Guest',
    leadEmail: 'guest@example.test',
    leadPhone: '09170000000',
    payMode: 'full' as const,
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
  };
}

describe('insertBookingWithRef', () => {
  dbIt('inserts a booking and reports the ref it allocated', async () => {
    const { id, ref } = await inRollback(async (tx) => {
      const tourId = await makeTour(tx);
      return insertBookingWithRef(tx, bookingValues(tourId));
    });
    expect(id).toBeGreaterThan(0);
    expect(bookingRefSchema.safeParse(ref).success, ref).toBe(true);
  });

  /**
   * The retry, proven. The first ref collides with a booking that already
   * exists; the helper must try again rather than fail, and must do it by
   * letting the UNIQUE index refuse the INSERT — a SELECT-then-INSERT races
   * another request between the two statements, and only the database can
   * decide uniqueness atomically.
   */
  dbIt('retries when the generated ref is already taken, and succeeds', async () => {
    const taken = 'RG-AAAAAA';
    const free = 'RG-BBBBBB';
    const result = await inRollback(async (tx) => {
      const tourId = await makeTour(tx);
      // Occupy `taken` first, so the next attempt hits a real UNIQUE violation.
      await insertBookingWithRef(tx, bookingValues(tourId), () => taken);
      const queue = [taken, free];
      return insertBookingWithRef(tx, bookingValues(tourId), () => queue.shift() ?? free);
    });
    expect(result.ref, 'it kept the colliding ref instead of retrying').toBe(free);
  });

  /**
   * Fail closed. If every attempt collides — a broken generator, an
   * exhausted keyspace — the helper must refuse rather than loop forever or,
   * worse, return a booking that shares a ref with someone else's.
   */
  dbIt('gives up loudly after five collisions instead of looping or overwriting', async () => {
    const attempts: string[] = [];
    await expect(
      inRollback(async (tx) => {
        const tourId = await makeTour(tx);
        await insertBookingWithRef(tx, bookingValues(tourId), () => 'RG-CCCCCC');
        return insertBookingWithRef(tx, bookingValues(tourId), () => {
          attempts.push('RG-CCCCCC');
          return 'RG-CCCCCC';
        });
      }),
    ).rejects.toThrow(/unique booking reference/i);
    expect(attempts.length, 'it did not try exactly five times').toBe(5);
  });
});
