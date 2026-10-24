/**
 * Week 7 plan, Task 8 — `admin.coupons.*`: the coupon CRUD surface and the
 * redemption log (BUILD_SPEC §9 "Coupons", server half).
 *
 * **This suite writes money.** A coupon's `percent_bp` / `amount_centavos` is
 * subtracted from a guest's subtotal, so the blocks below are mostly about
 * three things: that a discount arrives as integer basis points or integer
 * centavos in exactly the shape the database's CHECK constraints allow, that
 * the cached `used_count` counter is unreachable through the admin input, and
 * that switching a coupon off retracts nothing that was already redeemed.
 *
 * **Both layers are proven, because neither is load-bearing alone.** The Zod
 * boundary refuses a malformed discount shape with `BAD_REQUEST` before MySQL
 * ever sees it; a raw `INSERT` that bypasses Zod entirely is refused by
 * `coupons_discount_shape` itself. A suite that only tested the first would
 * stay green if the CHECK were dropped (and a seed script or a 2am `UPDATE`
 * would then write the row); a suite that only tested the second would stay
 * green if the API started returning 500s.
 *
 * Role refusals are asserted on `code`, never on the message — the pattern
 * `admin-tours.test.ts` and `admin-drivers.test.ts` already follow, because
 * `requireRole()` throws messages that name neither UNAUTHORIZED nor
 * FORBIDDEN and a regex on prose can pass against broken code.
 *
 * **Teardown.** Every coupon this file creates is tracked by id AND swept by
 * code prefix, because the two catch different failures: the ids catch the
 * coupons the tests meant to make, and the prefix sweep catches the ones a
 * BROKEN build made — a role gate that let a refused `create` through writes a
 * coupon nothing tracked, and `coupons.code` is UNIQUE, so one stray row makes
 * the next run's duplicate test pass for the wrong reason.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, couponRedemptions, coupons, tours, users } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { recordRedemption } from '../services/coupons';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * Every coupon this file creates carries it, so the sweep in `afterAll` finds
 * them. Uppercase and hyphenated, because `normalizeCouponCode` uppercases on
 * write and `couponCodeSchema` allows only letters, digits, hyphens and
 * underscores — a lowercase prefix would be stored uppercased and the sweep's
 * `LIKE` would still match, but the fixtures read more honestly this way.
 */
const CODE_PREFIX = 'ADMCPN-';

const created = {
  userIds: [] as number[],
  couponIds: [] as number[],
  bookingIds: [] as number[],
};

const unique = () => `${Math.floor(Math.random() * 1e9)}-${Date.now()}`;

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `admcpn_${role}_${suffix}@example.test`,
      passwordHash: '__admcpn_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let seedTourId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

/** A fresh code in this file's namespace. Uppercase: stored form, no surprises. */
const freshCode = () => `${CODE_PREFIX}${unique()}`.toUpperCase();

/** Every field `couponCreateInput` requires, as a 10% coupon. */
function percentInput(overrides: Record<string, unknown> = {}) {
  return {
    code: freshCode(),
    discountType: 'percent' as const,
    // 1000 basis points = 10%.
    percentBp: 1_000,
    amountCentavos: null,
    minSpendCentavos: 200_000,
    startsAt: null,
    endsAt: null,
    usageLimit: 50,
    ...overrides,
  };
}

/** The same, as a flat ₱250-off coupon. */
function fixedInput(overrides: Record<string, unknown> = {}) {
  return {
    code: freshCode(),
    discountType: 'fixed' as const,
    percentBp: null,
    amountCentavos: 25_000,
    minSpendCentavos: null,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    ...overrides,
  };
}

/** Creates a coupon through the real mutation and tracks it for teardown. */
async function createCoupon(input: Record<string, unknown>) {
  const { id } = await ownerApi().admin.coupons.create(input as never);
  created.couponIds.push(id);
  return id;
}

async function couponIdByCode(code: string): Promise<number | undefined> {
  const [row] = await getDb()
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.code, code.trim().toUpperCase()));
  return row?.id;
}

async function couponRow(id: number) {
  const [row] = await getDb().select().from(coupons).where(eq(coupons.id, id));
  return row;
}

async function redemptionRowsFor(couponId: number) {
  return getDb()
    .select({ id: couponRedemptions.id, bookingId: couponRedemptions.bookingId })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponId, couponId))
    .orderBy(asc(couponRedemptions.id));
}

async function auditRowsForCoupon(couponId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'coupon'), eq(auditLog.entityId, couponId)))
    .orderBy(asc(auditLog.id));
}

/** The minimum snapshot `bookings.price_snapshot` accepts. No test reads it. */
const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100_000,
  discountCentavos: 0,
  totalCentavos: 100_000,
};

/**
 * A committed booking that used `couponId`, so the redemption log has
 * something real to join to. `discount_centavos` is what the coupon took off
 * this booking, which is the figure the log reports.
 */
async function makeBooking(couponId: number, tourDate: string, discountCentavos: number) {
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: seedTourId,
      tourDate: new Date(`${tourDate}T00:00:00Z`),
      pax: 2,
      leadName: 'Coupon Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100_000,
      discountCentavos,
      totalCentavos: 100_000 - discountCentavos,
      couponId,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

/** The public ref of a booking this file made, read back for the log's assertions. */
async function refOf(bookingId: number): Promise<string> {
  const [row] = await getDb()
    .select({ ref: bookings.ref })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row!.ref;
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');

  // A seeded tour, not one of this file's own: nothing here edits tours, and
  // `public-queries.test.ts` asserts the catalog holds exactly six.
  const [tour] = await getDb().select({ id: tours.id }).from(tours).orderBy(asc(tours.id)).limit(1);
  seedTourId = tour!.id;
}, 60_000);

afterAll(async () => {
  const db = getDb();

  /*
   * The prefix sweep comes FIRST and is the authority: it finds every coupon
   * this file's code convention owns, including one a broken build created
   * through a refusal that should have blocked it. The tracked ids are
   * unioned in so nothing is missed either way.
   */
  const swept = await db
    .select({ id: coupons.id })
    .from(coupons)
    .where(like(coupons.code, `${CODE_PREFIX}%`));
  const couponIds = [...new Set([...created.couponIds, ...swept.map((row) => row.id)])];

  /*
   * In FK order. `coupon_redemptions` points at both `coupons` and `bookings`
   * with RESTRICT, and `bookings.coupon_id` points at `coupons` too, so the
   * redemptions go first, then the bookings, then the coupons.
   *
   * `bookings` is in the leak detector's `LEAK_TABLES`, so a miss there fails
   * the run by name rather than quietly; `coupons` and `coupon_redemptions`
   * are not, which is exactly why this sweep is by prefix and not by id alone.
   */
  if (couponIds.length > 0) {
    await db.delete(couponRedemptions).where(inArray(couponRedemptions.couponId, couponIds));
  }
  if (created.bookingIds.length > 0) {
    await db
      .delete(couponRedemptions)
      .where(inArray(couponRedemptions.bookingId, created.bookingIds));
    const pool = getPool();
    for (const id of created.bookingIds) {
      // Raw parameterized SQL, not `db.delete(bookings)` — `schema-conventions
      // .test.ts` scans the whole server tree for the Drizzle form of a
      // bookings hard-delete and exempts only the raw form in a test file.
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
  }
  if (couponIds.length > 0) {
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'coupon'), inArray(auditLog.entityId, couponIds)));
    await db.delete(coupons).where(inArray(coupons.id, couponIds));
  }

  const pool = getPool();
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('admin.coupons', () => {
  /* ------------------------------------------------------------------ *
   * Create and read back — both discount shapes
   * ------------------------------------------------------------------ */

  it('creates a PERCENT coupon and lists it as integer basis points', async () => {
    const input = percentInput();
    const id = await createCoupon(input);

    const listed = await ownerApi().admin.coupons.list();
    const mine = listed.find((row) => row.id === id);
    expect(mine, 'the coupon just created must be listed').toBeDefined();
    expect(mine).toMatchObject({
      code: input.code,
      discountType: 'percent',
      percentBp: 1_000,
      // The other discount column stays null — that is what the CHECK is for.
      amountCentavos: null,
      minSpendCentavos: 200_000,
      usageLimit: 50,
      // Not in the input: a new coupon is unused and live.
      usedCount: 0,
      redemptionCount: 0,
      isActive: true,
    });
  });

  it('creates a FIXED coupon and lists it as integer centavos', async () => {
    const input = fixedInput();
    const id = await createCoupon(input);

    const mine = (await ownerApi().admin.coupons.list()).find((row) => row.id === id);
    expect(mine).toMatchObject({
      code: input.code,
      discountType: 'fixed',
      percentBp: null,
      amountCentavos: 25_000,
      minSpendCentavos: null,
      usageLimit: null,
      usedCount: 0,
      isActive: true,
    });
  });

  it('stores the start and end of the window as the UTC instants it was given', async () => {
    // 2026-12-01 08:00 Manila and 2026-12-31 23:59 Manila, already converted
    // by the client (`lib/manila-datetime.ts`) — the server stores what it is
    // handed and converts nothing.
    const startsAt = '2026-12-01T00:00:00.000Z';
    const endsAt = '2026-12-31T15:59:00.000Z';
    const id = await createCoupon(percentInput({ startsAt, endsAt }));

    const row = await couponRow(id);
    expect(row?.startsAt?.toISOString()).toBe(startsAt);
    expect(row?.endsAt?.toISOString()).toBe(endsAt);

    const mine = (await ownerApi().admin.coupons.list()).find((entry) => entry.id === id);
    expect(mine?.startsAt).toBe(startsAt);
    expect(mine?.endsAt).toBe(endsAt);
  });

  it('NORMALISES the code on write, the way validateCoupon does on read', async () => {
    const lower = `${CODE_PREFIX}${unique()}`.toLowerCase();
    const id = await createCoupon(percentInput({ code: `  ${lower}  ` }));
    expect((await couponRow(id))?.code).toBe(lower.toUpperCase());
  });

  /* ------------------------------------------------------------------ *
   * The discount shape — Zod first, then MySQL's own CHECK
   * ------------------------------------------------------------------ */

  /**
   * The four shapes `coupons_discount_shape` forbids, refused at the Zod
   * boundary before a query is issued. BAD_REQUEST, not a 500 from the
   * driver — and nothing written.
   */
  it('REFUSES every malformed discount shape with BAD_REQUEST, before MySQL', async () => {
    const malformed = [
      {
        label: 'percent with centavos instead',
        patch: { discountType: 'percent', percentBp: null, amountCentavos: 25_000 },
      },
      {
        label: 'fixed with basis points instead',
        patch: { discountType: 'fixed', percentBp: 1_000, amountCentavos: null },
      },
      {
        label: 'both columns set',
        patch: { discountType: 'percent', percentBp: 1_000, amountCentavos: 25_000 },
      },
      {
        label: 'neither column set',
        patch: { discountType: 'percent', percentBp: null, amountCentavos: null },
      },
      {
        label: 'a percentage above 100%',
        patch: { discountType: 'percent', percentBp: 10_001, amountCentavos: null },
      },
      {
        label: 'a fractional percentage',
        patch: { discountType: 'percent', percentBp: 250.5, amountCentavos: null },
      },
      {
        label: 'a zero fixed discount',
        patch: { discountType: 'fixed', percentBp: null, amountCentavos: 0 },
      },
      {
        label: 'a fractional fixed discount',
        patch: { discountType: 'fixed', percentBp: null, amountCentavos: 1_999.5 },
      },
    ];

    for (const { label, patch } of malformed) {
      const input = { ...percentInput(), ...patch };
      await expect(
        ownerApi().admin.coupons.create(input as never),
        `${label} was accepted`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await couponIdByCode(input.code as string)).toBeUndefined();
    }
  });

  /**
   * The SECOND layer, and the reason the first is not enough: a seed script, a
   * migration or a hand-written `UPDATE` never passes through Zod. This insert
   * is raw, parameterised SQL straight at the pool — no Drizzle validation, no
   * schema object, nothing but the database's own opinion.
   *
   * If `coupons_discount_shape` were dropped, the Zod test above would still
   * pass and this one would not.
   */
  it('is REFUSED BY MYSQL ITSELF when the API layer is bypassed entirely', async () => {
    const pool = getPool();
    const malformed = [
      { label: 'percent with centavos instead', type: 'percent', bp: null, amount: 25_000 },
      { label: 'fixed with basis points instead', type: 'fixed', bp: 1_000, amount: null },
      { label: 'both columns set', type: 'percent', bp: 1_000, amount: 25_000 },
      { label: 'neither column set', type: 'percent', bp: null, amount: null },
      { label: 'a percentage above 100%', type: 'percent', bp: 10_001, amount: null },
      { label: 'a negative fixed discount', type: 'fixed', bp: null, amount: -5_000 },
    ];

    for (const { label, type, bp, amount } of malformed) {
      const code = freshCode();
      const attempt = pool.query(
        'INSERT INTO coupons (code, discount_type, percent_bp, amount_centavos, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, NOW(), NOW())',
        [code, type, bp, amount],
      );
      await expect(attempt, `MySQL accepted ${label}`).rejects.toThrow();
      expect(await couponIdByCode(code), `${label} left a row behind`).toBeUndefined();
    }
  });

  /* ------------------------------------------------------------------ *
   * The duplicate code — a named refusal, never a raw driver error
   * ------------------------------------------------------------------ */

  it('REFUSES a duplicate code with a NAMED error, not a raw ER_DUP_ENTRY', async () => {
    const input = percentInput();
    const id = await createCoupon(input);

    const refused = (await ownerApi()
      .admin.coupons.create(fixedInput({ code: input.code }) as never)
      .catch((error: unknown) => error)) as { code?: string; message?: string };

    expect(refused.code, 'a duplicate-key 500 is not a refusal').toBe('CONFLICT');
    expect(refused.message).toBe('A coupon with that code already exists.');
    // The driver's own words must never reach a screen.
    expect(refused.message).not.toMatch(/ER_DUP_ENTRY|Duplicate entry/i);

    // And the first coupon is exactly as it was — still a percent coupon.
    expect(await couponIdByCode(input.code)).toBe(id);
    expect(await couponRow(id)).toMatchObject({ discountType: 'percent', percentBp: 1_000 });
  });

  it('REFUSES a duplicate that differs only in case, because the code is normalised', async () => {
    const input = percentInput();
    await createCoupon(input);
    await expect(
      ownerApi().admin.coupons.create(percentInput({ code: input.code.toLowerCase() }) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('REFUSES an update that would take another coupon code, with the same named error', async () => {
    const first = percentInput();
    await createCoupon(first);
    const secondId = await createCoupon(fixedInput());

    await expect(
      ownerApi().admin.coupons.update({
        ...fixedInput({ code: first.code }),
        id: secondId,
      } as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A coupon with that code already exists.',
    });
  });

  /* ------------------------------------------------------------------ *
   * used_count is NOT writable through the admin input
   * ------------------------------------------------------------------ */

  /**
   * Structurally, not by omission: `.strict()` makes the key a refusal, so a
   * resolver that later started reading `input.usedCount` could not be handed
   * one. The same test covers `isActive`, which `setActive` owns alone.
   */
  it('REFUSES usedCount and isActive at the Zod boundary, on create and on update', async () => {
    for (const smuggled of [{ usedCount: 99 }, { isActive: false }, { redemptionCount: 7 }]) {
      const input = { ...percentInput(), ...smuggled };
      await expect(
        ownerApi().admin.coupons.create(input as never),
        `${JSON.stringify(smuggled)} was accepted by create`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await couponIdByCode(input.code)).toBeUndefined();
    }

    const id = await createCoupon(percentInput());
    for (const smuggled of [{ usedCount: 99 }, { isActive: false }]) {
      await expect(
        ownerApi().admin.coupons.update({ ...percentInput(), id, ...smuggled } as never),
        `${JSON.stringify(smuggled)} was accepted by update`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(await couponRow(id)).toMatchObject({ usedCount: 0, isActive: true });
  });

  /**
   * And a legitimate update does not reset the counter either. `used_count`
   * belongs to `recordRedemption` / `releaseRedemption` and an edit to a
   * coupon's wording or dates must leave it alone — resetting it would hand a
   * sold-out coupon back out with no redemption row to show for it.
   */
  it('leaves used_count alone when the coupon is edited', async () => {
    const id = await createCoupon(percentInput({ usageLimit: 2 }));
    const bookingId = await makeBooking(id, '2026-12-05', 10_000);
    await getDb().transaction(async (tx) => {
      await recordRedemption(tx, id, bookingId);
    });
    expect(await couponRow(id)).toMatchObject({ usedCount: 1 });

    await expect(
      ownerApi().admin.coupons.update({
        ...percentInput({ code: freshCode(), usageLimit: 10, percentBp: 1_500 }),
        id,
      } as never),
    ).resolves.toEqual({ ok: true });

    const row = await couponRow(id);
    expect(row).toMatchObject({ usedCount: 1, usageLimit: 10, percentBp: 1_500 });
  });

  /**
   * A save that writes a coupon the values it already holds must SUCCEED.
   *
   * `update`'s NOT_FOUND is inferred from `affectedRows === 0`, and on this
   * pool `affectedRows` is the MATCHED count — mysql2 sets `CLIENT_FOUND_ROWS`
   * and `db/client.ts` turns it off nowhere, so a no-op save still reports 1.
   * A resolver that read it as the CHANGED count would answer NOT_FOUND for a
   * coupon that is plainly there, which is a belief this codebase has held
   * twice (see `db/client.ts`'s measured header). This is the test that pins
   * it, because every other update test changes something.
   */
  it('accepts an update that changes nothing, rather than calling it NOT_FOUND', async () => {
    const input = percentInput();
    const id = await createCoupon(input);

    await expect(ownerApi().admin.coupons.update({ ...input, id } as never)).resolves.toEqual({
      ok: true,
    });
    expect(await couponRow(id)).toMatchObject({ code: input.code, percentBp: 1_000 });
  });

  /* ------------------------------------------------------------------ *
   * The role gate — §9's `toursPricing` row is OWNER ONLY
   * ------------------------------------------------------------------ */

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES a ${role} on every coupons procedure, and writes nothing`, async () => {
      const id = role === 'dispatcher' ? dispatcherId : financeId;
      const api = appRouter.createCaller(staffContext(id, role) as never);
      const input = percentInput();

      const refusals = await Promise.all([
        api.admin.coupons.list().catch((e: unknown) => e),
        api.admin.coupons.create(input as never).catch((e: unknown) => e),
        api.admin.coupons.update({ ...input, id: 1 } as never).catch((e: unknown) => e),
        api.admin.coupons.setActive({ id: 1, isActive: false }).catch((e: unknown) => e),
        api.admin.coupons.redemptions({ couponId: 1 }).catch((e: unknown) => e),
      ]);

      expect(refusals).toHaveLength(5);
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
      }
      // Hiding a button is not access control: the refused `create` must have
      // written no coupon at all.
      expect(await couponIdByCode(input.code)).toBeUndefined();
    });
  }

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.coupons.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  /* ------------------------------------------------------------------ *
   * The redemption log
   * ------------------------------------------------------------------ */

  it('returns the booking ref, the tour date and the discount for each redemption', async () => {
    const id = await createCoupon(percentInput());
    const firstId = await makeBooking(id, '2026-12-05', 10_000);
    const secondId = await makeBooking(id, '2026-12-09', 12_500);
    await getDb().transaction(async (tx) => {
      await recordRedemption(tx, id, firstId);
      await recordRedemption(tx, id, secondId);
    });

    const log = await ownerApi().admin.coupons.redemptions({ couponId: id });
    expect(log).toHaveLength(2);
    // Newest redemption first: a log is read from the most recent use back.
    expect(log.map((row) => [row.bookingRef, row.tourDate, row.discountCentavos])).toEqual([
      [await refOf(secondId), '2026-12-09', 12_500],
      [await refOf(firstId), '2026-12-05', 10_000],
    ]);
    for (const row of log) {
      expect(row.bookingStatus).toBe('confirmed');
      // A real instant, not an invented one.
      expect(Number.isNaN(Date.parse(row.redeemedAt))).toBe(false);
    }

    // The list's two usage numbers agree once the record and the counter are
    // both written by the same call.
    const listed = (await ownerApi().admin.coupons.list()).find((row) => row.id === id);
    expect(listed).toMatchObject({ usedCount: 2, redemptionCount: 2, usageLimit: 50 });
  });

  it('returns an empty log for a coupon nobody has redeemed', async () => {
    const id = await createCoupon(fixedInput());
    await expect(ownerApi().admin.coupons.redemptions({ couponId: id })).resolves.toEqual([]);
  });

  /* ------------------------------------------------------------------ *
   * Soft delete — and what it must NOT retract
   * ------------------------------------------------------------------ */

  it('setActive(false) retracts NOTHING already redeemed', async () => {
    const id = await createCoupon(percentInput());
    const bookingId = await makeBooking(id, '2026-12-11', 10_000);
    await getDb().transaction(async (tx) => {
      await recordRedemption(tx, id, bookingId);
    });
    const redemptionsBefore = await redemptionRowsFor(id);
    expect(redemptionsBefore).toHaveLength(1);

    await expect(ownerApi().admin.coupons.setActive({ id, isActive: false })).resolves.toEqual({
      ok: true,
    });

    // Switched off — and that is ALL that changed. The counter stands and the
    // redemption row stands: the guest really did use this coupon, and
    // retiring it afterwards does not unwind their booking's discount.
    const row = await couponRow(id);
    expect(row).toMatchObject({ isActive: false, usedCount: 1 });
    expect(await redemptionRowsFor(id)).toEqual(redemptionsBefore);
    expect(await ownerApi().admin.coupons.redemptions({ couponId: id })).toHaveLength(1);

    // The admin list still shows it — that is the only place it can be
    // switched back on.
    const listed = (await ownerApi().admin.coupons.list()).find((entry) => entry.id === id);
    expect(listed).toMatchObject({ isActive: false, usedCount: 1, redemptionCount: 1 });

    await ownerApi().admin.coupons.setActive({ id, isActive: true });
    expect(await couponRow(id)).toMatchObject({ isActive: true, usedCount: 1 });
  });

  /* ------------------------------------------------------------------ *
   * Audit
   * ------------------------------------------------------------------ */

  it('writes exactly ONE audit row per mutation, naming the actor and the discount', async () => {
    const input = percentInput();
    const id = await createCoupon(input);
    expect(await auditRowsForCoupon(id)).toHaveLength(1);

    await ownerApi().admin.coupons.update({
      ...fixedInput({ code: input.code, amountCentavos: 30_000 }),
      id,
    } as never);
    await ownerApi().admin.coupons.setActive({ id, isActive: false });
    await ownerApi().admin.coupons.setActive({ id, isActive: true });

    const rows = await auditRowsForCoupon(id);
    expect(rows.map((row) => row.action)).toEqual([
      'coupon.created',
      'coupon.updated',
      'coupon.deactivated',
      'coupon.reactivated',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'user', actorId: ownerId });
    }
    // The money that changed is in the row — a discount nobody can trace is
    // the one kind of change this log exists for.
    expect(rows[0]!.data).toMatchObject({
      code: input.code,
      discountType: 'percent',
      percentBp: 1_000,
      amountCentavos: null,
    });
    expect(rows[1]!.data).toMatchObject({
      discountType: 'fixed',
      amountCentavos: 30_000,
      percentBp: null,
    });
  });

  it('audits NOTHING when a mutation is refused', async () => {
    const first = percentInput();
    await createCoupon(first);
    const id = await createCoupon(fixedInput());
    const before = await auditRowsForCoupon(id);

    await expect(
      ownerApi().admin.coupons.update({ ...fixedInput({ code: first.code }), id } as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await auditRowsForCoupon(id)).toEqual(before);
  });

  /* ------------------------------------------------------------------ *
   * Not found
   * ------------------------------------------------------------------ */

  it('answers NOT_FOUND for a coupon that does not exist', async () => {
    const api = ownerApi();
    await expect(
      api.admin.coupons.update({ ...percentInput(), id: 2_000_000_000 } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.admin.coupons.setActive({ id: 2_000_000_000, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.admin.coupons.redemptions({ couponId: 2_000_000_000 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
