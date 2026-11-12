/**
 * `admin.newsletter.list` — the on-screen subscriber list the Coupons page's
 * "Sign-up coupons" section renders (sign-up coupons plan, Task 1C,
 * decision 5).
 *
 * **Same gate as `admin.newsletter.export`, same reason.** This query hands
 * the browser every subscriber's email address too, so it is
 * `adminProcedure('usersSettings')` — owner only — exactly like `export`.
 * Role refusals are asserted on `code`, never on the message — the pattern
 * `admin-tours.test.ts` and `admin-coupons.test.ts` already use, because
 * `requireRole()` throws messages that name neither UNAUTHORIZED nor
 * FORBIDDEN and a regex on prose can pass against broken code.
 *
 * **The load-bearing assertions are the four `status` derivations** —
 * `'none'`, `'unused'`, `'used'`, `'expired'` — built directly against the
 * tables (`newsletter_subscribers` -> `coupons` -> `coupon_redemptions` ->
 * `bookings`) rather than through `newsletter.subscribe()`'s own mint path,
 * so this suite owns every input the derivation reads (a coupon's
 * `is_active`, its `ends_at`, and whether a redemption row exists) instead
 * of depending on `mintSignupCoupon`'s random code or the settings row's
 * live `expiryDays`.
 *
 * **Teardown, in FK order.** `coupon_redemptions` (references both
 * `coupons` and `bookings`, RESTRICT) first, then `newsletter_subscribers`
 * (references `coupons`, RESTRICT), then `bookings` — via raw parameterized
 * SQL, not `db.delete(bookings)`: `schema-conventions.test.ts` scans the
 * whole server tree for the Drizzle form of a bookings hard-delete and
 * exempts only the raw SQL form, and only inside `__tests__` (see
 * `admin-coupons.test.ts`'s own identical note) — then `coupons`, then
 * `users`.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { asc, eq, inArray, like } from 'drizzle-orm';
import type { PriceSnapshot } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  couponRedemptions,
  coupons,
  newsletterSubscribers,
  tours,
  users,
} from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { recordRedemption } from '../services/coupons';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Every email and coupon code this file creates carries it, for the sweep. */
const EMAIL_PREFIX = 'admnlsub_';
const CODE_PREFIX = 'ADMNLSUB-';

const created = {
  userIds: [] as number[],
  subscriberIds: [] as number[],
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
      email: `admnlsub_${role}_${suffix}@example.test`,
      passwordHash: '__admnlsub_fixture_not_a_hash__',
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
const dispatcherApi = () =>
  appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
const financeApi = () => appRouter.createCaller(staffContext(financeId, 'finance') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

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

/** A committed booking, for the `'used'` case's redemption to join to. */
async function makeBooking(): Promise<{ id: number; ref: string }> {
  const ref = generateBookingRef();
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId: seedTourId,
      tourDate: new Date('2027-01-10T00:00:00Z'),
      pax: 2,
      leadName: 'Newsletter Fixture',
      leadEmail: 'fixture@example.test',
      leadPhone: '09170000000',
      status: 'confirmed',
      payMode: 'full',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: 100_000,
      discountCentavos: 10_000,
      totalCentavos: 90_000,
    });
  created.bookingIds.push(row.insertId);
  return { id: row.insertId, ref };
}

/** Inserts one sign-up coupon row directly, bypassing `mintSignupCoupon`. */
async function makeCoupon(overrides: {
  isActive: boolean;
  endsAt: Date | null;
  email: string;
}): Promise<number> {
  const [row] = await getDb()
    .insert(coupons)
    .values({
      code: `${CODE_PREFIX}${unique()}`.toUpperCase(),
      discountType: 'percent',
      percentBp: 500,
      amountCentavos: null,
      minSpendCentavos: null,
      startsAt: null,
      endsAt: overrides.endsAt,
      usageLimit: 1,
      usedCount: 0,
      isActive: overrides.isActive,
      restrictedToEmail: overrides.email,
    });
  created.couponIds.push(row.insertId);
  return row.insertId;
}

/** Inserts one `newsletter_subscribers` row directly, with an optional coupon link. */
async function makeSubscriber(couponId: number | null): Promise<string> {
  const email = `${EMAIL_PREFIX}${unique()}@example.test`;
  const [row] = await getDb().insert(newsletterSubscribers).values({ email, couponId });
  created.subscriberIds.push(row.insertId);
  return email;
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');

  // A seeded tour, not one of this file's own: nothing here edits tours.
  const [tour] = await getDb().select({ id: tours.id }).from(tours).orderBy(asc(tours.id)).limit(1);
  seedTourId = tour!.id;
}, 60_000);

afterAll(async () => {
  const db = getDb();

  if (created.couponIds.length > 0) {
    await db
      .delete(couponRedemptions)
      .where(inArray(couponRedemptions.couponId, created.couponIds));
  }
  if (created.subscriberIds.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.id, created.subscriberIds));
  }
  if (created.bookingIds.length > 0) {
    const pool = getPool();
    for (const id of created.bookingIds) {
      // Raw parameterized SQL, not `db.delete(bookings)` — see this file's
      // own header comment and `admin-coupons.test.ts`'s identical note.
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
  }
  const swept = await db
    .select({ id: coupons.id })
    .from(coupons)
    .where(like(coupons.code, `${CODE_PREFIX}%`));
  const couponIds = [...new Set([...created.couponIds, ...swept.map((row) => row.id)])];
  if (couponIds.length > 0) {
    await db.delete(coupons).where(inArray(coupons.id, couponIds));
  }
  if (created.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, created.userIds));
  }
}, 60_000);

describeWithDb('admin.newsletter.list', () => {
  it('REFUSES dispatcher and finance with FORBIDDEN', async () => {
    for (const api of [dispatcherApi(), financeApi()]) {
      await expect(api.admin.newsletter.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.newsletter.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it("reports 'none' for a subscriber with no coupon minted yet", async () => {
    const email = await makeSubscriber(null);

    const rows = await ownerApi().admin.newsletter.list();
    const row = rows.find((r) => r.email === email);

    expect(row).toMatchObject({ code: null, status: 'none', usedBookingRef: null });
  });

  it("reports 'unused' for an active, unexpired, unredeemed coupon", async () => {
    const couponId = await makeCoupon({
      isActive: true,
      endsAt: new Date(Date.now() + 30 * 86_400_000),
      email: `${EMAIL_PREFIX}${unique()}@example.test`,
    });
    const email = await makeSubscriber(couponId);

    const rows = await ownerApi().admin.newsletter.list();
    const row = rows.find((r) => r.email === email);

    expect(row).toMatchObject({ status: 'unused', usedBookingRef: null });
    expect(row?.code).not.toBeNull();
  });

  it("reports 'used' with the booking ref when a redemption row exists", async () => {
    const couponId = await makeCoupon({
      isActive: true,
      endsAt: new Date(Date.now() + 30 * 86_400_000),
      email: `${EMAIL_PREFIX}${unique()}@example.test`,
    });
    const booking = await makeBooking();
    await getDb().transaction(async (tx) => {
      await recordRedemption(tx, couponId, booking.id);
    });
    const email = await makeSubscriber(couponId);

    const rows = await ownerApi().admin.newsletter.list();
    const row = rows.find((r) => r.email === email);

    expect(row).toMatchObject({ status: 'used', usedBookingRef: booking.ref });
  });

  /**
   * Two independent ways a coupon can be `'expired'`: past `ends_at`, or
   * deactivated — neither has a redemption row.
   */
  it("reports 'expired' for an unredeemed coupon past its ends_at", async () => {
    const couponId = await makeCoupon({
      isActive: true,
      endsAt: new Date(Date.now() - 86_400_000),
      email: `${EMAIL_PREFIX}${unique()}@example.test`,
    });
    const email = await makeSubscriber(couponId);

    const rows = await ownerApi().admin.newsletter.list();
    const row = rows.find((r) => r.email === email);

    expect(row).toMatchObject({ status: 'expired', usedBookingRef: null });
  });

  it("reports 'expired' for an unredeemed, deactivated coupon with no ends_at", async () => {
    const couponId = await makeCoupon({
      isActive: false,
      endsAt: null,
      email: `${EMAIL_PREFIX}${unique()}@example.test`,
    });
    const email = await makeSubscriber(couponId);

    const rows = await ownerApi().admin.newsletter.list();
    const row = rows.find((r) => r.email === email);

    expect(row).toMatchObject({ status: 'expired', usedBookingRef: null });
  });

  it('lists newest sign-up first', async () => {
    const earlier = await makeSubscriber(null);
    // A DATETIME column is second-precision; without a gap the two rows
    // could land in the same second and the ordering would be unproven.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const later = await makeSubscriber(null);

    const rows = await ownerApi().admin.newsletter.list();
    const earlierIndex = rows.findIndex((r) => r.email === earlier);
    const laterIndex = rows.findIndex((r) => r.email === later);

    expect(laterIndex).toBeLessThan(earlierIndex);
  });

  it('writes no audit row — this is a read, not the disclosure event `export` is', async () => {
    await makeSubscriber(null);

    const before = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'newsletter.exported'));

    await ownerApi().admin.newsletter.list();

    const after = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'newsletter.exported'));

    expect(after.length).toBe(before.length);
  });

  it('is mounted as a QUERY under the usersSettings area', () => {
    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, { _def?: { meta?: unknown; type?: string } }> };
      }
    )._def.procedures;
    const def = procedures['admin.newsletter.list']?._def as
      { meta?: { access?: string; area?: string }; type?: string } | undefined;
    expect(def, 'admin.newsletter.list is not mounted').toBeDefined();
    expect(def?.meta).toMatchObject({ access: 'admin', area: 'usersSettings' });
    expect(def?.type, 'admin.newsletter.list must be a query, not a mutation').toBe('query');
  });
});
