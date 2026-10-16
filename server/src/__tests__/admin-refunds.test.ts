/**
 * Week 6 plan, Task 13 — cancel and refund (§13's 6F, BUILD_SPEC §6
 * "Refunds & cancellations", §9's "Cancel / refund" row).
 *
 * **Everything dangerous here was already built and tested.**
 * `recordPayment({ type: 'refund', … })` owns the always-positive amount,
 * the sum that may never exceed `amount_paid_centavos`, the booking row
 * lock, the admin-only gate and the audit row; `record-payment.test.ts`
 * proves all of them at the service level. This file is about the SURFACE
 * that composes them, and the four §6 rules it has to get right:
 *
 *  1. **The provider that TOOK the payment**, read off the payment row —
 *     never the currently-active gateway. Proven with a row whose provider
 *     is `xendit` while every live charge in this codebase goes through
 *     PayMongo, plus a source scan: neither new file may so much as mention
 *     `getActiveProvider`.
 *  2. **A refund is never a booking status.** The cancel sets `cancelled`
 *     and writes no `payments` row; the refund writes a row and moves no
 *     status, and `amount_paid_centavos` is not decremented by either —
 *     it is money IN, and the refunds are a separate sum measured against
 *     it.
 *  3. **Partial refunds are allowed**, so the cap is a SUM: two partials
 *     adding up to the paid amount are fine, a third centavo is not, and
 *     two CONCURRENT refunds cannot between them exceed what came in.
 *  4. **A webhook may confirm a refund an admin initiated; it may never
 *     initiate one.** `recordPayment()` refuses a `provider` actor on a
 *     refund (`record-payment.test.ts`), and nothing in this surface can
 *     supply one: both procedures take the admin's id from the gate's
 *     validated session.
 *
 * **No test here reaches the network.** `globalThis.fetch` is replaced with
 * a throw for the whole file, and `../services/payments/registry` is mocked
 * so `getProvider()` hands back the REALLY REGISTERED provider for the name
 * asked for, with only `refund` stubbed — so "which provider was used" is
 * answered by the registry, as in production, and "was a gateway called at
 * all" is observable. `getProvider('manual')` still throws
 * `UnknownProviderError` through the mock, because the mock defers to the
 * real registry: the manual path must be proven to never ask for it.
 *
 * Fixtures are rebuilt per test and deleted in `afterEach` — `bookings`,
 * `payments`, `vans`, `users` and `trip_checkpoints` are all in
 * `global-setup.ts`'s `LEAK_TABLES`, so a miss fails the run by name, and
 * the test database keeps an EMPTY fleet (`capacity.test.ts` counts it).
 * `audit_log` is deliberately not cleaned: it is append-only and nothing
 * here counts it to make a decision — the audit assertions look rows up by
 * entity id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { depositCentavos, type AdminRole, type PriceSnapshot } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tours, tripCheckpoints, users, vans } from '../db/schema';
import { ROLE_MATRIX } from '../middleware/require-role';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { recordPayment } from '../services/payments/record-payment';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/* -------------------------------------------------------------------------
 * The mocked registry, and the network guard behind it.
 * ---------------------------------------------------------------------- */

const gateway = vi.hoisted(() => ({
  /** Every provider name `getProvider()` was asked for, in order. */
  requested: [] as string[],
  /** Every `refund()` call: the name asked for, the provider's OWN name, the input. */
  refunds: [] as Array<{ asked: string; providerName: string; input: unknown }>,
  /**
   * Run while the gateway is "paying out", i.e. between the pre-flight check
   * and the `payments` row. It is the only honest way to reach the
   * money-left-and-nothing-written window deterministically — see the test
   * that uses it.
   */
  onRefund: null as null | (() => Promise<void>),
}));

vi.mock('../services/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payments/registry')>();
  return {
    ...actual,
    getProvider: (name: string) => {
      gateway.requested.push(name);
      /*
       * The REAL registry lookup, so this mock cannot invent a provider the
       * project does not register — `manual` still throws
       * `UnknownProviderError` here, which is what makes "the manual path
       * never asks for a gateway" a meaningful assertion rather than a
       * silently-answered one.
       */
      const impl = actual.getProvider(name as never);
      return {
        ...impl,
        refund: async (input: unknown) => {
          gateway.refunds.push({ asked: name, providerName: impl.name, input });
          if (gateway.onRefund) await gateway.onRefund();
          return { providerRef: `rf_${gateway.refunds.length}`, providerStatus: 'succeeded' };
        },
      };
    },
  };
});

const networkGuard = vi.fn((): never => {
  throw new Error('a test tried to reach the network');
});
let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = networkGuard as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------
 * Fixtures.
 * ---------------------------------------------------------------------- */

/** Random first, timestamp second — the house pattern. */
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** The trip's price, in centavos. */
const TOTAL = 400_000;
const DEPOSIT_PERCENT = 30;
/**
 * What the guest paid up front — computed with the SAME helper
 * `recordPayment()` checks an inbound payment against, never a literal, so
 * the fixture cannot drift from owner decision Q4's rounding.
 */
const PAID = depositCentavos(TOTAL, DEPOSIT_PERCENT);

const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 4 },
  addons: [],
  coupon: null,
  depositPercent: DEPOSIT_PERCENT,
  freeCancelHours: 48,
  subtotalCentavos: TOTAL,
  discountCentavos: 0,
  totalCentavos: TOTAL,
};

/** Far future, so no other suite's date filter can collide with these rows. */
const TOUR_DATE = '2099-08-09';

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  userIds: [] as number[],
};

async function scalar(statement: Parameters<ReturnType<typeof getDb>['execute']>[0]) {
  const [rows] = (await getDb().execute(statement)) as unknown as [Array<{ n: number }>, unknown];
  return Number(rows[0]?.n ?? -1);
}

async function rows<T>(statement: string, params: unknown[]): Promise<T[]> {
  const [result] = (await getPool().query(statement, params)) as unknown as [T[], unknown];
  return result;
}

/** Every payments row for one booking, newest first. */
function paymentRows(bookingId: number) {
  return rows<Record<string, unknown>>(
    'SELECT * FROM payments WHERE booking_id = ? ORDER BY id DESC',
    [bookingId],
  );
}

/** What the booking says about itself afterwards. */
async function bookingMoney(bookingId: number) {
  const [row] = await rows<Record<string, unknown>>(
    'SELECT status, amount_paid_centavos, payment_review_required FROM bookings WHERE id = ?',
    [bookingId],
  );
  if (!row) throw new Error(`no booking ${bookingId}`);
  return {
    status: String(row.status),
    paidCentavos: Number(row.amount_paid_centavos),
    paymentReviewRequired: Number(row.payment_review_required),
  };
}

/** The sum this whole task exists to bound. */
async function refundedTotal(bookingId: number): Promise<number> {
  const [row] = await rows<{ n: number }>(
    "SELECT COALESCE(SUM(amount_centavos), 0) n FROM payments WHERE booking_id = ? AND type = 'refund'",
    [bookingId],
  );
  return Number(row?.n ?? -1);
}

async function auditRows(entity: string, entityId: number) {
  return rows<Record<string, unknown>>(
    'SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC',
    [entity, entityId],
  );
}

async function makeStaff(role: AdminRole): Promise<number> {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `refunds_${role}_${suffix}@example.test`,
      passwordHash: '__refunds_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeVan(status: 'available' | 'on_trip'): Promise<number> {
  const suffix = unique();
  const [van] = await getDb()
    .insert(vans)
    .values({
      plate: `RF${suffix}`.slice(0, 20),
      model: 'Refund Fixture Van',
      capacity: 12,
      status,
      isActive: true,
    });
  created.vanIds.push(van.insertId);
  return van.insertId;
}

interface BookingOptions {
  status?: 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  vanId?: number | null;
}

/**
 * A booking that has paid its 30% deposit and nothing else.
 *
 * `amount_paid_centavos` is NOT set here: it is moved by `recordPayment()`,
 * the only module allowed to (CLAUDE.md, A5b), which is also how the PAID
 * payment row this task refunds against comes to exist. The actor is a
 * `provider` — a verified webhook, which is one of the two things §6 allows
 * to mark a booking paid.
 */
async function makePaidBooking(
  provider: 'paymongo' | 'xendit' | 'manual',
  options: BookingOptions = {},
): Promise<{ id: number; ref: string; paymentId: number }> {
  const ref = generateBookingRef();
  const [booking] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date(`${TOUR_DATE}T00:00:00Z`),
      pax: 4,
      leadName: 'Refund Fixture Guest',
      leadEmail: 'admin-refunds@example.test',
      leadPhone: '09171234567',
      status: 'pending_payment',
      payMode: 'deposit',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: TOTAL,
      totalCentavos: TOTAL,
      paymentReviewRequired: false,
      holdExpiresAt: null,
      vanId: options.vanId ?? null,
      driverId: null,
    });
  created.bookingIds.push(booking.insertId);

  const manual = provider === 'manual';
  const recorded = await recordPayment({
    bookingId: booking.insertId,
    type: 'payment',
    provider,
    method: manual ? 'bank_transfer' : 'gcash',
    amountCentavos: PAID,
    // A gateway charge has the gateway's id; a hand-verified transfer has
    // the guest's own reference and no gateway id at all.
    providerRef: manual ? null : `${provider}_charge_${unique()}`,
    providerStatus: manual ? null : 'paid',
    txnRef: manual ? `GUEST-${unique()}` : null,
    actor: manual ? { type: 'user', id: owner } : { type: 'provider', id: null },
    verifiedBy: manual ? owner : null,
  });

  if (options.status && options.status !== 'confirmed') {
    await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', [
      options.status,
      booking.insertId,
    ]);
  }

  return { id: booking.insertId, ref, paymentId: recorded.paymentId };
}

const apiFor = (userId: number, role: AdminRole) =>
  appRouter.createCaller(staffContext(userId, role) as never);

let tourId = 0;
let owner = 0;
let dispatcher = 0;
let finance = 0;

/* -------------------------------------------------------------------------
 * Two guards that need no database.
 * ---------------------------------------------------------------------- */

/**
 * Blank out comment spans before matching, so prose ABOUT a rule does not
 * trip the rule. Lifted from `schema-conventions.test.ts`, which lifted it
 * from `no-red.test.ts`: block comments are blanked character-by-character
 * so line numbers stay stable, and `//` only starts a line comment when it
 * is not preceded by `:` (so `https://` survives).
 */
function stripComments(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

/**
 * The gate, read off the procedures as MOUNTED.
 *
 * Beside the dispatcher refusal below, not instead of it: that refusal would
 * survive a widened area, because a dispatcher would then be refused by
 * nothing at all and the test would have to catch it behaviourally. This
 * pins the transport gate itself, against `ROLE_MATRIX` rather than a
 * literal pair — §9's table is transcribed exactly once in this codebase.
 */
it('declares §9’s cancelRefund gate on both mounted procedures', () => {
  const mounted = (
    appRouter as unknown as {
      _def: { procedures: Record<string, { _def?: { meta?: unknown } }> };
    }
  )._def.procedures;
  for (const path of ['admin.refunds.cancelBooking', 'admin.refunds.refundPayment']) {
    expect(mounted[path], `${path} is not mounted`).toBeDefined();
    expect(mounted[path]?._def?.meta).toMatchObject({
      access: 'admin',
      area: 'cancelRefund',
      roles: ROLE_MATRIX.cancelRefund,
    });
  }
});

/**
 * **This task added no second refund path.** A source scan, because that
 * claim is about what the code CANNOT do and no behavioural test can say so:
 *
 *  - neither new file inserts or updates a `payments` row — there is one
 *    `payments` insert in this project and it is in `record-payment.ts`;
 *  - neither mentions `getActiveProvider`, which is §6's rule 1 stated as
 *    an absence. The currently-active gateway is not merely unused here, it
 *    is unmentionable.
 *
 * `bookings.amount_paid_centavos` is not scanned for here because
 * `schema-conventions.test.ts` already scans the WHOLE server tree for it,
 * which is strictly stronger than a two-file check.
 *
 * Comments are blanked first, the way every other source-reading guard in
 * this project does it: both files SAY "never the currently-active provider"
 * in prose, which is the rule being documented rather than broken, and a
 * guard that punished the explanation would get the explanation deleted.
 *
 * Each pattern is proven against a known-bad sample first (the vacuity trap:
 * a regex that stops matching passes forever).
 */
it('adds no payments write and no reference to the active provider', () => {
  const files = ['src/services/payments/cancel-refund.ts', 'src/routers/admin/refunds.ts'];
  const serverRoot = resolve(import.meta.dirname, '../..');

  const paymentsWrite = /\.(?:insert|update)\(\s*(?:schema\.)?payments\s*\)/;
  const activeProvider = /\bgetActiveProvider\b/;
  expect(paymentsWrite.test('await tx.insert(payments).values({})')).toBe(true);
  expect(activeProvider.test('const p = await getActiveProvider();')).toBe(true);

  for (const file of files) {
    const raw = readFileSync(resolve(serverRoot, file), 'utf8');
    expect(raw.length, `${file} was not read`).toBeGreaterThan(1000);
    const source = stripComments(raw);
    expect(source, `${file} writes a payments row — only record-payment.ts may`).not.toMatch(
      paymentsWrite,
    );
    expect(source, `${file} calls getActiveProvider — §6 says use the payment row`).not.toMatch(
      activeProvider,
    );
  }
});

/* -------------------------------------------------------------------------
 * The surface.
 * ---------------------------------------------------------------------- */

describeWithDb('admin.refunds — cancelling a booking and sending money back', () => {
  beforeEach(async () => {
    const db = getDb();
    expect(await scalar(sql`SELECT COUNT(*) n FROM vans`), 'leftover vans in rg_travel_test').toBe(
      0,
    );
    gateway.requested = [];
    gateway.refunds = [];
    gateway.onRefund = null;
    networkGuard.mockClear();

    const slug = `__adminrefunds__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db.insert(tours).values({
      slug,
      title: `Refund Fixture Tour ${slug}`,
      destinationId: destination.insertId,
      isActive: true,
    });
    created.tourIds.push(tour.insertId);
    tourId = tour.insertId;

    owner = await makeStaff('owner');
    dispatcher = await makeStaff('dispatcher');
    finance = await makeStaff('finance');
  }, 30_000);

  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM trip_checkpoints WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.vanIds) await pool.query('DELETE FROM vans WHERE id = ?', [id]);
    for (const id of created.userIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'user',
        id,
      ]);
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
    created.bookingIds = [];
    created.tourIds = [];
    created.destIds = [];
    created.vanIds = [];
    created.userIds = [];
  });

  /**
   * 1. The whole flow, once: cancel, then give the money back.
   *
   * The assertions that matter are the shape of the single row it writes —
   * `type='refund'`, a POSITIVE amount (direction comes from `type`, never a
   * sign), the gateway's own refund id — and the two things that must NOT
   * have moved: the booking's status stays `cancelled` (a refund is not a
   * status) and `amount_paid_centavos` stays where it was (it is money IN;
   * decrementing it would re-open the cap one partial refund at a time).
   */
  it('records ONE positive refund row for a full refund and leaves the booking cancelled', async () => {
    const booking = await makePaidBooking('paymongo');

    await expect(
      apiFor(owner, 'owner').admin.refunds.cancelBooking({
        bookingId: booking.id,
        reason: 'Guest cancelled inside the window.',
      }),
    ).resolves.toMatchObject({ ref: booking.ref, previousStatus: 'confirmed', vanReleased: false });

    const result = await apiFor(finance, 'finance').admin.refunds.refundPayment({
      paymentId: booking.paymentId,
      amountCentavos: PAID,
      reason: 'requested_by_customer',
    });
    expect(result).toMatchObject({
      bookingId: booking.id,
      provider: 'paymongo',
      calledGateway: true,
    });

    const all = await paymentRows(booking.id);
    expect(all, 'one payment in, one refund out').toHaveLength(2);
    const refund = all[0]!;
    expect(refund.type).toBe('refund');
    expect(Number(refund.amount_centavos)).toBe(PAID);
    expect(Number(refund.amount_centavos)).toBeGreaterThan(0);
    expect(refund.status).toBe('refunded');
    expect(refund.provider).toBe('paymongo');
    expect(refund.method).toBe('gcash');
    // The gateway's own id for the REFUND, not for the charge.
    expect(refund.provider_ref).toBe('rf_1');
    expect(refund.provider_status).toBe('succeeded');

    expect(await bookingMoney(booking.id)).toMatchObject({
      status: 'cancelled',
      paidCentavos: PAID,
      paymentReviewRequired: 0,
    });
    expect(await refundedTotal(booking.id)).toBe(PAID);
  });

  /**
   * 2. §6: "Partial refunds are allowed … their sum must never exceed
   * `amount_paid`."
   *
   * Both partials are well inside the cap on their own, so nothing but the
   * SUM can refuse the third — and the third is ONE CENTAVO, which is the
   * only amount that proves the boundary is the boundary rather than
   * somewhere approximate.
   */
  it('allows two partial refunds that sum to the paid amount, and refuses a third centavo', async () => {
    const booking = await makePaidBooking('paymongo');
    const api = apiFor(finance, 'finance');
    const first = 100_000;
    const second = PAID - first;

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: first,
        reason: 'Partly refunded — one guest dropped out.',
      }),
    ).resolves.toMatchObject({ calledGateway: true });
    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: second,
        reason: 'The rest, after the office agreed.',
      }),
    ).resolves.toMatchObject({ calledGateway: true });

    expect(await refundedTotal(booking.id)).toBe(PAID);

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: 1,
        reason: 'One centavo too many.',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await refundedTotal(booking.id), 'the third refund was recorded anyway').toBe(PAID);
    expect(await paymentRows(booking.id)).toHaveLength(3);
  });

  /**
   * 3. The boundary from the other side, exactly: one centavo over is
   * refused and the gateway is never asked, and the same booking then takes
   * the full amount.
   *
   * "The gateway is never asked" is the assertion with teeth. §6 has the
   * payout happen BEFORE the row is written, so a refusal that only happened
   * at the row would mean real money had already left for an amount this
   * system had just decided it would not refund.
   */
  it('refuses one centavo more than was paid WITHOUT calling the gateway, then allows the exact amount', async () => {
    const booking = await makePaidBooking('paymongo');
    const api = apiFor(finance, 'finance');

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PAID + 1,
        reason: 'One centavo over the cap.',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(gateway.refunds, 'the gateway was asked to pay out an over-cap refund').toEqual([]);
    expect(await refundedTotal(booking.id)).toBe(0);
    expect(await paymentRows(booking.id)).toHaveLength(1);

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PAID,
        reason: 'Exactly what came in.',
      }),
    ).resolves.toMatchObject({ calledGateway: true });
    expect(await refundedTotal(booking.id)).toBe(PAID);
  });

  /**
   * 4. **Two admins refunding the same booking at the same moment.**
   *
   * Genuinely overlapping: both mutations are in flight before either
   * commits, so both open a transaction and both pass the pre-flight check
   * seeing nothing refunded yet. What separates them is inside
   * `recordPayment()`: the booking row `SELECT … FOR UPDATE` is that
   * transaction's FIRST statement, so the loser waits for the winner to
   * commit and its later `SUM(payments)` read — its first consistent read,
   * and therefore the one that establishes its snapshot — sees the winner's
   * refund row and refuses.
   *
   * **The amounts fit on their own, which is what makes this test about the
   * sum.** 70,000 is well under the 120,000 paid, so neither call can be
   * refused by anything except having seen the other one. Together they are
   * 140,000, which must not be possible. And the assertion is on the
   * REFUNDED TOTAL, not merely on an error code: a test that only counted
   * rejections would pass just as happily if both refunds had landed and
   * something unrelated had thrown.
   *
   * **Proven, twice, and this test is the only proof of either.** Removing
   * `.for('update')` from the booking read in `recordPayment()` turns it red
   * — with it gone there is no lock on the refund path at all (unlike the
   * CASH path, whose authoritative payment re-read is itself `FOR UPDATE`
   * and keeps money safe through either lock), so both transactions read
   * "nothing refunded yet" and both succeed. And making that function's cap
   * ignore the refunds already recorded turns it red the same way — while
   * leaving the sequential partial-refund test above GREEN, because the
   * pre-flight check catches a sequential caller first. Measured, not
   * assumed: the pre-flight masks the authoritative check for one admin at a
   * keyboard, so a race is the only place the real cap is observable.
   *
   * **A MANUAL payment on purpose**, so no gateway is in the race: the
   * loser's refusal is then the cap itself (`BAD_REQUEST`), not the
   * "refunded at the gateway, could not be recorded" window that a payout
   * before the row necessarily opens. That window is a different fact and
   * would hide this one.
   */
  it('serialises two concurrent refunds so their sum cannot exceed what was paid', async () => {
    /** Each one fits; together they do not. */
    const PART = 70_000;
    expect(PART).toBeLessThan(PAID);
    expect(PART * 2).toBeGreaterThan(PAID);

    const booking = await makePaidBooking('manual');
    const offline = { method: 'gcash' as const, reference: `OFFLINE-${unique()}` };

    const results = await Promise.allSettled([
      apiFor(owner, 'owner').admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PART,
        reason: 'Refund from the owner.',
        offline,
      }),
      apiFor(finance, 'finance').admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PART,
        reason: 'Refund from finance, at the same moment.',
        offline,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled, 'both refunds succeeded — more money went out than came in').toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
      'the loser was refused by something other than the refund cap',
    ).toMatchObject({ code: 'BAD_REQUEST' });

    expect(await refundedTotal(booking.id), 'the paid amount was refunded twice over').toBe(PART);
    expect(await paymentRows(booking.id), 'a second refund row appeared').toHaveLength(2);
    expect(await bookingMoney(booking.id)).toMatchObject({ paidCentavos: PAID });
  });

  /**
   * 5. §6: "Manual payments: admin records the refund as done offline
   * (method + reference)."
   *
   * **And it calls no gateway**, which is asserted three ways because one
   * would not do: no provider was requested from the registry at all, no
   * `refund()` ran, and no socket was opened. A manual payment is a QR
   * transfer or cash an admin verified — `getProvider('manual')` throws by
   * design — so a path that reached for a gateway here would fail on every
   * single manual refund in production.
   */
  it('records a manual payment’s refund as an offline record with a method and reference, calling no gateway', async () => {
    const booking = await makePaidBooking('manual');
    const reference = `BPI-${unique()}`;

    const result = await apiFor(finance, 'finance').admin.refunds.refundPayment({
      paymentId: booking.paymentId,
      amountCentavos: 50_000,
      reason: 'Sent back by bank transfer.',
      offline: { method: 'bank_transfer', reference },
    });
    expect(result).toMatchObject({ provider: 'manual', calledGateway: false });

    expect(gateway.requested, 'a gateway was looked up for a manual refund').toEqual([]);
    expect(gateway.refunds).toEqual([]);
    expect(networkGuard).not.toHaveBeenCalled();

    const [refund] = await paymentRows(booking.id);
    expect(refund?.type).toBe('refund');
    expect(refund?.provider).toBe('manual');
    // The instrument the ADMIN used to send it back, which need not be the
    // one it arrived by (this fixture arrived as a bank transfer too, so the
    // reference is what distinguishes the rows).
    expect(refund?.method).toBe('bank_transfer');
    expect(refund?.txn_ref).toBe(reference);
    expect(refund?.provider_ref).toBeNull();
    expect(Number(refund?.amount_centavos)).toBe(50_000);
    expect(await refundedTotal(booking.id)).toBe(50_000);
  });

  /**
   * 6. The two halves of the offline record are not optional paperwork: a
   * manual refund without them would say money went back and not how, and
   * an offline record against a gateway charge means the admin is on the
   * wrong form. Both fail closed, writing nothing.
   */
  it('REFUSES a manual refund with no offline record, and an offline record against a gateway charge', async () => {
    const manual = await makePaidBooking('manual');
    const api = apiFor(finance, 'finance');

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: manual.paymentId,
        amountCentavos: 10_000,
        reason: 'No method, no reference.',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await refundedTotal(manual.id)).toBe(0);

    const card = await makePaidBooking('paymongo');
    await expect(
      api.admin.refunds.refundPayment({
        paymentId: card.paymentId,
        amountCentavos: 10_000,
        reason: 'Offline details against a gateway charge.',
        offline: { method: 'cash', reference: 'handed over in the office' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(gateway.refunds, 'the gateway was called for a refusal').toEqual([]);
    expect(await refundedTotal(card.id)).toBe(0);
  });

  /**
   * 7. **§6's rule 1: the provider that TOOK the payment.**
   *
   * The payment row says `xendit`. Every live charge this codebase can make
   * goes through PayMongo (`checkout.startPayment` asks the registry for
   * `'paymongo'` by name), and the settings-driven "active provider" is not
   * configured at all — `getActiveProvider()` throws — so a refund built on
   * the active gateway would either refuse this or send the money to the
   * wrong company. It goes to Xendit, by name, with the charge's own
   * `provider_ref`.
   *
   * Asserted on the provider OBJECT the registry returned, not only on the
   * string requested: `impl.name` comes from the registered implementation,
   * so this would catch a lookup that asked for the right name and used the
   * wrong provider.
   */
  it('refunds through the provider named on the payment row, not the gateway the site charges through', async () => {
    const booking = await makePaidBooking('xendit');
    const [charge] = await paymentRows(booking.id);
    const chargeRef = String(charge?.provider_ref);

    await apiFor(finance, 'finance').admin.refunds.refundPayment({
      paymentId: booking.paymentId,
      amountCentavos: PAID,
      reason: 'fraudulent',
    });

    expect(gateway.requested).toEqual(['xendit']);
    expect(gateway.requested).not.toContain('paymongo');
    expect(gateway.refunds).toHaveLength(1);
    expect(gateway.refunds[0]).toMatchObject({
      asked: 'xendit',
      providerName: 'xendit',
      input: { providerRef: chargeRef, amountCentavos: PAID, reason: 'fraudulent' },
    });

    const [refund] = await paymentRows(booking.id);
    expect(refund?.provider).toBe('xendit');
    expect(await refundedTotal(booking.id)).toBe(PAID);
  });

  /**
   * 7b. **The gateway paid out and the row could not be written** — the
   * worst outcome 6F can produce, and the reason it has its own error class.
   *
   * §6 fixes the order (call the provider, THEN record), so this window
   * exists by design: the alternative order would leave a booking believing
   * it refunded money that never left, silently, which is worse. What must
   * never happen is that the fact money LEFT gets lost. So this asserts all
   * four halves of that:
   *
   *  - the gateway really was asked to pay (one `refund()` call);
   *  - the caller is refused, not told it worked;
   *  - the message tells the admin not to refund again — it is the only
   *     instruction that matters at that moment;
   *  - and it is on the server's record, loudly, naming the gateway's own
   *     refund id and the booking, so a human can reconcile it.
   *
   * **Deterministic, not a timing trick.** The competing refund is committed
   * from inside the mocked `refund()` call, which is exactly where a second
   * admin's refund would land in the real race — between this call's
   * pre-flight check and its authoritative one. No `setTimeout`, no sleep,
   * and the cap is the real cap: it is `recordPayment()` that refuses.
   */
  it('refuses loudly, naming the gateway refund, when a payout cannot be recorded', async () => {
    const booking = await makePaidBooking('paymongo');
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    });

    // Another admin's refund commits while the gateway is paying this one
    // out, taking the whole cap with it.
    gateway.onRefund = async () => {
      gateway.onRefund = null;
      await recordPayment({
        bookingId: booking.id,
        type: 'refund',
        provider: 'manual',
        method: 'cash',
        amountCentavos: PAID,
        actor: { type: 'user', id: owner },
      });
    };

    try {
      await expect(
        apiFor(finance, 'finance').admin.refunds.refundPayment({
          paymentId: booking.paymentId,
          amountCentavos: PAID,
          reason: 'Full refund, overtaken by another admin.',
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.stringContaining('Do NOT refund again'),
      });
    } finally {
      spy.mockRestore();
    }

    expect(gateway.refunds, 'the gateway was never asked to pay').toHaveLength(1);
    const shouted = logged.join(' | ');
    expect(shouted, 'nothing was logged about money that left the account').toMatch(
      /accepted by the gateway/i,
    );
    expect(shouted).toContain('rf_1');
    expect(shouted).toContain(String(booking.id));

    /*
     * The database kept the cap: the competing refund is the only one
     * recorded, and the payout this call made is NOT double-counted into it.
     * One payment in, one refund row — the one that committed.
     */
    expect(await refundedTotal(booking.id)).toBe(PAID);
    expect(await paymentRows(booking.id)).toHaveLength(2);
  });

  /**
   * 8. §9's row, both directions: `ROLE_MATRIX.cancelRefund` is
   * `['owner', 'finance']`. A dispatcher may run the day and assign a van;
   * they may not cancel a booking or send money back.
   *
   * On the `code`, never the message, and the refusal leaves the booking
   * exactly where finance will find it — which is also what proves the gate
   * ran before the resolver rather than halfway through it.
   */
  it('lets finance refund and cancel, and REFUSES a dispatcher both, changing nothing', async () => {
    const booking = await makePaidBooking('paymongo');

    await expect(
      apiFor(dispatcher, 'dispatcher').admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PAID,
        reason: 'A dispatcher trying to refund.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      apiFor(dispatcher, 'dispatcher').admin.refunds.cancelBooking({
        bookingId: booking.id,
        reason: 'A dispatcher trying to cancel.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(gateway.refunds, 'a refused refund still reached the gateway').toEqual([]);
    expect(await refundedTotal(booking.id)).toBe(0);
    expect(await paymentRows(booking.id)).toHaveLength(1);
    expect(await bookingMoney(booking.id)).toMatchObject({ status: 'confirmed' });

    const api = apiFor(finance, 'finance');
    await expect(
      api.admin.refunds.cancelBooking({ bookingId: booking.id, reason: 'Finance cancelling.' }),
    ).resolves.toMatchObject({ previousStatus: 'confirmed' });
    await expect(
      api.admin.refunds.refundPayment({
        paymentId: booking.paymentId,
        amountCentavos: PAID,
        reason: 'Finance refunding.',
      }),
    ).resolves.toMatchObject({ calledGateway: true });
    expect(await refundedTotal(booking.id)).toBe(PAID);
  });

  /**
   * 9. §6: "Refunds are admin-only and write to `audit_log` naming the
   * admin." Both halves of 6F, and they must name DIFFERENT admins here —
   * an audit row that said "finance" for both would pass a one-actor test.
   *
   * The refund's row is `recordPayment()`'s own (`payment.refunded`, entity
   * `payments`); the cancellation's is this task's (`booking.cancelled`,
   * entity `bookings`), and it carries the reason, which is the only record
   * of WHY seats were given back.
   */
  it('names the admin in the audit row for the cancellation and for the refund', async () => {
    const booking = await makePaidBooking('paymongo');

    await apiFor(owner, 'owner').admin.refunds.cancelBooking({
      bookingId: booking.id,
      reason: 'Typhoon signal 3 — all trips off.',
    });
    const refund = await apiFor(finance, 'finance').admin.refunds.refundPayment({
      paymentId: booking.paymentId,
      amountCentavos: PAID,
      reason: 'Weather cancellation, full refund.',
    });

    const cancelTrail = (await auditRows('bookings', booking.id)).filter(
      (row) => row.action === 'booking.cancelled',
    );
    expect(cancelTrail, 'the cancellation wrote no audit row').toHaveLength(1);
    expect(cancelTrail[0]).toMatchObject({ actor_type: 'user', actor_id: owner });
    expect(JSON.stringify(cancelTrail[0]?.data)).toContain('Typhoon signal 3');
    expect(JSON.stringify(cancelTrail[0]?.data)).toContain('"previousStatus":"confirmed"');

    const refundTrail = (await auditRows('payments', refund.paymentId)).filter(
      (row) => row.action === 'payment.refunded',
    );
    expect(refundTrail, 'the refund wrote no audit row').toHaveLength(1);
    expect(refundTrail[0]).toMatchObject({ actor_type: 'user', actor_id: finance });
  });

  /**
   * 10. **Cancelling a trip that is already moving** (the question Tasks 5
   * and 6 sent here; owner ruling 2026-10-16).
   *
   * The cancel stands, every check-in already recorded STANDS — the van
   * really did reach those stops, and erasing that would be the worse record
   * — and the van goes back on sale, because the completion that would
   * normally have cleared `on_trip` is never going to happen now. CLAUDE.md:
   * whatever sets that status must also clear it.
   */
  it('cancels a trip under way: the van goes back on sale and the check-ins stand', async () => {
    const vanId = await makeVan('on_trip');
    const booking = await makePaidBooking('paymongo', { status: 'in_progress', vanId });
    // The trip-start checkpoint, which is what a driver's first tap writes.
    await getDb().insert(tripCheckpoints).values({ bookingId: booking.id, stopId: null });

    await expect(
      apiFor(owner, 'owner').admin.refunds.cancelBooking({
        bookingId: booking.id,
        reason: 'Guest taken ill at the first stop.',
      }),
    ).resolves.toMatchObject({ previousStatus: 'in_progress', vanReleased: true });

    expect(await bookingMoney(booking.id)).toMatchObject({ status: 'cancelled' });
    const [van] = await rows<{ status: string }>('SELECT status FROM vans WHERE id = ?', [vanId]);
    expect(van?.status, 'the van is still marked on_trip and cannot be sold').toBe('available');

    const checkpoints = await rows<{ n: number }>(
      'SELECT COUNT(*) n FROM trip_checkpoints WHERE booking_id = ?',
      [booking.id],
    );
    expect(Number(checkpoints[0]?.n), 'a cancellation retracted a check-in').toBe(1);
    // And it moved no money at all: the cancel is a status change.
    expect(await paymentRows(booking.id)).toHaveLength(1);
    expect(await refundedTotal(booking.id)).toBe(0);
  });

  /**
   * 11. Cancelling twice, which is a double-click as much as a race. The
   * second is refused on the `code`, and writes no second audit row — the
   * conditional UPDATE matches nothing, so nothing below it runs.
   *
   * A `completed` trip is refused by the same allow-list, and that is the
   * case worth keeping beside it: a finished tour must not walk backwards,
   * and it does not need to — the refund below proves money can still go
   * back without a cancellation, which is §6's "a refund is never a booking
   * status" from the other end.
   */
  it('REFUSES cancelling a booking that is already cancelled, or a trip that ran', async () => {
    const booking = await makePaidBooking('paymongo');
    const api = apiFor(owner, 'owner');

    await api.admin.refunds.cancelBooking({ bookingId: booking.id, reason: 'First cancel.' });
    await expect(
      api.admin.refunds.cancelBooking({ bookingId: booking.id, reason: 'Second cancel.' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (await auditRows('bookings', booking.id)).filter((row) => row.action === 'booking.cancelled'),
      'the refused cancel wrote a second audit row',
    ).toHaveLength(1);

    const ran = await makePaidBooking('paymongo', { status: 'completed' });
    await expect(
      api.admin.refunds.cancelBooking({ bookingId: ran.id, reason: 'Cancelling a finished trip.' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await bookingMoney(ran.id)).toMatchObject({ status: 'completed' });

    // But its money can still go back, with no cancellation at all.
    await expect(
      apiFor(finance, 'finance').admin.refunds.refundPayment({
        paymentId: ran.paymentId,
        amountCentavos: 25_000,
        reason: 'Goodwill after a bad trip.',
      }),
    ).resolves.toMatchObject({ calledGateway: true });
    expect(await bookingMoney(ran.id)).toMatchObject({ status: 'completed' });
    expect(await refundedTotal(ran.id)).toBe(25_000);
  });

  /**
   * 12. An id that is not money this booking received is a refusal, not a
   * 500 — and a REFUND row's own id is the case with teeth: refunding a
   * refund would be the one way to walk out of the cap by compounding. The
   * lookup is scoped to `type='payment' AND status='paid'`, so it is simply
   * not found.
   *
   * **Measured while proving this test can fail:** the two clauses are
   * independently sufficient for a refund row — `recordPayment()` writes
   * every refund as `type='refund'` AND `status='refunded'` — so removing
   * either one alone leaves this green, and only removing BOTH turns it red
   * (observed: the second refund resolved). They are kept as a pair anyway,
   * because each is a different question ("is this a payment?" and "did the
   * money arrive?") and the second is what refuses a PENDING receipt or an
   * unreconciled cash claim, which the type clause would happily pass.
   */
  it('refuses a payment id that is not paid money the booking received', async () => {
    const booking = await makePaidBooking('paymongo');
    const api = apiFor(finance, 'finance');

    await expect(
      api.admin.refunds.refundPayment({
        paymentId: 987_654_321,
        amountCentavos: 1_000,
        reason: 'An id nobody issued.',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const refund = await api.admin.refunds.refundPayment({
      paymentId: booking.paymentId,
      amountCentavos: 10_000,
      reason: 'A real partial refund.',
    });
    await expect(
      api.admin.refunds.refundPayment({
        paymentId: refund.paymentId,
        amountCentavos: 10_000,
        reason: 'Refunding the refund.',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await refundedTotal(booking.id)).toBe(10_000);
    expect(await paymentRows(booking.id)).toHaveLength(2);
  });
});
