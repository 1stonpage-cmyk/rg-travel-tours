/**
 * Week 4 plan, Task 11 — `admin.bookings.list` and `.detail` (BUILD_SPEC
 * §9's 4D screens).
 *
 * The role rules are the point of this file. §9 gives the bookings VIEW to
 * all three admin roles and the payment DECISIONS to owner and finance
 * only, which is why the two sit in different areas — a dispatcher opens
 * the screen and finds no buttons on it. There is a test per role per
 * procedure (CLAUDE.md), plus the one that matters most: a customer
 * session is refused. BUG-119 moved the admin and guest-portal surfaces onto
 * separate cookies, but `requireRole` still refuses a `ctx.adminSession` that
 * is not a `'user'` subject — this is the proof that the admin surface
 * cannot be reached by a guest's identity under any context shape.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { inArray, sql } from 'drizzle-orm';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingAddons,
  bookingNotes,
  bookings,
  destinations,
  payments,
  tourAddons,
  tours,
  users,
} from '../db/schema';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { maskPhone, paymentMethodLabel } from '../routers/admin/bookings';
import { createSession } from '../services/sessions';
import { receiptStorageDir, storeReceipt } from '../services/uploads';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const TOTAL = 500_000;
/** A real JPEG header, so `storeReceipt` accepts the bytes. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('receipt')]);

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
  files: [] as string[],
};

let seq = 0;

interface Fixture {
  bookingId: number;
  ref: string;
  tourTitle: string;
}

async function makeBooking(opts: {
  status?: 'pending_payment' | 'pending_verification' | 'confirmed' | 'cancelled';
  tourDate: string;
  withPendingReceipt?: boolean;
  withAddon?: boolean;
  withNote?: boolean;
  leadPhone?: string;
}): Promise<Fixture> {
  const db = getDb();
  seq += 1;
  const slug = `__adminbk__${seq}_${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: `Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date(`${opts.tourDate}T00:00:00Z`),
    pax: 2,
    leadName: 'Maria Santos',
    leadEmail: `adminbk_${slug}@example.test`,
    leadPhone: opts.leadPhone ?? '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 2 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL,
      discountCentavos: 0,
      totalCentavos: TOTAL,
    },
    subtotalCentavos: TOTAL,
    totalCentavos: TOTAL,
    amountPaidCentavos: 0,
  });
  created.bookingIds.push(booking.insertId);

  if (opts.withPendingReceipt) {
    const { path } = await storeReceipt({
      buffer: JPEG,
      mimetype: 'image/jpeg',
      originalname: 'r.jpg',
    });
    created.files.push(path);
    await db.insert(payments).values({
      bookingId: booking.insertId,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      amountCentavos: TOTAL,
      status: 'pending',
      txnRef: `GC${seq}${Math.floor(Math.random() * 1e6)}`,
      receiptPath: path,
    });
  }

  if (opts.withAddon) {
    /*
     * `booking_addons.addon_id` is NOT NULL and a real foreign key onto
     * `tour_addons`, so the catalogue row has to exist first — the booking
     * line is a SNAPSHOT of it, not a replacement for it.
     */
    const [catalogue] = await db.insert(tourAddons).values({
      tourId: tour.insertId,
      name: 'Snorkel set',
      priceCentavos: 25_000,
      perPerson: true,
    });
    await db.insert(bookingAddons).values({
      bookingId: booking.insertId,
      addonId: catalogue.insertId,
      name: 'Snorkel set',
      priceCentavos: 25_000,
      perPerson: true,
      qty: 2,
    });
  }

  if (opts.withNote) {
    // `booking_notes.user_id` is NOT NULL and a real FK: a note nobody
    // wrote is exactly what the column refuses, so the fixture needs an
    // author. (The owner row is created in `beforeAll`, before any booking.)
    await db.insert(bookingNotes).values({
      bookingId: booking.insertId,
      userId: owner,
      note: 'Guest asked for an early pickup.',
    });
  }

  return { bookingId: booking.insertId, ref, tourTitle: `Tour ${slug}` };
}

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${unique}`,
      email: `adminbk_${role}_${unique}@example.test`,
      passwordHash: '__adminbk_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

const apiFor = (userId: number, role: 'owner' | 'dispatcher' | 'finance') =>
  appRouter.createCaller(staffContext(userId, role) as never);

let owner = 0;
let dispatcher = 0;
let finance = 0;
let queued: Fixture;
let plain: Fixture;
let cancelled: Fixture;

beforeAll(async () => {
  owner = await makeStaff('owner');
  dispatcher = await makeStaff('dispatcher');
  finance = await makeStaff('finance');
  // Three bookings on three different dates, one of which is waiting on a
  // receipt and one of which is cancelled.
  queued = await makeBooking({
    status: 'pending_verification',
    tourDate: '2099-03-10',
    withPendingReceipt: true,
    withAddon: true,
    withNote: true,
  });
  plain = await makeBooking({ status: 'pending_payment', tourDate: '2099-03-20' });
  cancelled = await makeBooking({ status: 'cancelled', tourDate: '2099-03-30' });
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const name of created.files) {
    await rm(join(receiptStorageDir(), name), { force: true });
  }
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM booking_addons WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM booking_notes WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  await getDb()
    .delete(auditLog)
    .where(sql`${auditLog.action} LIKE 'payment.%'`);
  if (created.tourIds.length > 0) {
    // Before the tours they hang off: `tour_addons.tour_id` is a real FK.
    await getDb().delete(tourAddons).where(inArray(tourAddons.tourId, created.tourIds));
    await getDb().delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await getDb().delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/** Only this suite's bookings, whatever else the test database holds. */
const mine = (items: Array<{ ref: string }>) =>
  items.filter((item) => [queued.ref, plain.ref, cancelled.ref].includes(item.ref));

describeWithDb('admin.bookings.list — who may call it', () => {
  /** §9: the bookings view is all three admin roles. */
  it('answers all three admin roles', async () => {
    for (const [userId, role] of [
      [owner, 'owner'],
      [dispatcher, 'dispatcher'],
      [finance, 'finance'],
    ] as const) {
      await expect(
        apiFor(userId, role).admin.bookings.list({}),
        `${role} could not read the bookings list`,
      ).resolves.toMatchObject({ items: expect.any(Array) });
    }
  });

  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.bookings.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * **A guest's portal session must never reach the admin surface.** Since
   * BUG-119 the two resolve from separate cookies into separate context
   * fields (`ctx.customerSession` vs `ctx.adminSession`), so this fixture
   * context — whose only field is a customer session — never populates
   * `ctx.adminSession` at all, and `requireRole` refuses accordingly.
   */
  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(queued.bookingId) as never);
    await expect(api.admin.bookings.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a staff session whose role is not a real role', async () => {
    const api = appRouter.createCaller(
      testContext({ subjectType: 'user', subjectId: owner, role: 'superuser' }) as never,
    );
    await expect(api.admin.bookings.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describeWithDb('admin.bookings.list — filtering and paging', () => {
  it('lists bookings soonest first, with a total for the pager', async () => {
    const result = await apiFor(owner, 'owner').admin.bookings.list({ limit: 100 });

    const refs = mine(result.items).map((item) => item.ref);
    expect(refs).toEqual([queued.ref, plain.ref, cancelled.ref]);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.items[0]).toMatchObject({
      tourDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      leadName: expect.any(String),
    });
  });

  it('filters by status', async () => {
    const result = await apiFor(owner, 'owner').admin.bookings.list({
      status: 'cancelled',
      limit: 100,
    });
    const refs = mine(result.items).map((item) => item.ref);
    expect(refs).toEqual([cancelled.ref]);
  });

  it('filters by a civil date range, inclusive at both ends', async () => {
    const api = apiFor(owner, 'owner');

    const middle = await api.admin.bookings.list({
      from: '2099-03-20',
      to: '2099-03-20',
      limit: 100,
    });
    expect(mine(middle.items).map((i) => i.ref)).toEqual([plain.ref]);

    // Inclusive: the boundary dates themselves are in.
    const span = await api.admin.bookings.list({
      from: '2099-03-10',
      to: '2099-03-30',
      limit: 100,
    });
    expect(mine(span.items).map((i) => i.ref)).toEqual([queued.ref, plain.ref, cancelled.ref]);

    const before = await api.admin.bookings.list({ to: '2099-03-09', limit: 100 });
    expect(mine(before.items)).toHaveLength(0);
  });

  /** The verification queue: what is waiting on someone here. */
  it('filters to the bookings waiting for verification', async () => {
    const result = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    expect(mine(result.items).map((i) => i.ref)).toEqual([queued.ref]);
  });

  it('pages, and never returns more than a hundred', async () => {
    const api = apiFor(owner, 'owner');
    const first = await api.admin.bookings.list({ from: '2099-03-01', limit: 1, offset: 0 });
    const second = await api.admin.bookings.list({ from: '2099-03-01', limit: 1, offset: 1 });

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]!.ref).not.toBe(second.items[0]!.ref);

    await expect(api.admin.bookings.list({ limit: 101 })).rejects.toThrow();
  });
});

describeWithDb('admin.bookings.detail', () => {
  it('returns the booking with its payments, add-ons, notes and audit trail', async () => {
    const result = await apiFor(owner, 'owner').admin.bookings.detail({ ref: queued.ref });

    expect(result).toMatchObject({
      ref: queued.ref,
      status: 'pending_verification',
      tourTitle: queued.tourTitle,
      tourDate: '2099-03-10',
      leadName: 'Maria Santos',
      totalCentavos: TOTAL,
      paidCentavos: 0,
    });

    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]).toMatchObject({
      provider: 'manual',
      method: 'gcash',
      status: 'pending',
      // The filename the authenticated receipt route serves.
      receiptPath: expect.stringMatching(/^[0-9a-f]{32}\.jpg$/),
    });

    expect(result.addons).toEqual([
      expect.objectContaining({ name: 'Snorkel set', qty: 2, priceCentavos: 25_000 }),
    ]);
    expect(result.notes).toEqual([
      expect.objectContaining({ note: 'Guest asked for an early pickup.' }),
    ]);
    expect(Array.isArray(result.audit)).toBe(true);
  });

  it('answers all three admin roles, and refuses everyone else', async () => {
    for (const [userId, role] of [
      [owner, 'owner'],
      [dispatcher, 'dispatcher'],
      [finance, 'finance'],
    ] as const) {
      await expect(
        apiFor(userId, role).admin.bookings.detail({ ref: queued.ref }),
        `${role} could not read a booking`,
      ).resolves.toMatchObject({ ref: queued.ref });
    }

    await expect(
      appRouter.createCaller(testContext() as never).admin.bookings.detail({ ref: queued.ref }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      appRouter
        .createCaller(customerContext(queued.bookingId) as never)
        .admin.bookings.detail({ ref: queued.ref }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a reference that does not exist', async () => {
    await expect(
      apiFor(owner, 'owner').admin.bookings.detail({ ref: 'RG-NOPE00' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * **A dispatcher sees the screen and cannot act on it.** §9 splits view
   * from decide, and this is that split asserted at both ends — the same
   * session that reads the booking is refused the approval.
   */
  it('lets a dispatcher READ a booking it may not decide', async () => {
    const api = apiFor(dispatcher, 'dispatcher');
    const detail = await api.admin.bookings.detail({ ref: queued.ref });
    const paymentId = detail.payments[0]!.id;

    await expect(api.admin.bookings.approveReceipt({ paymentId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      api.admin.bookings.rejectReceipt({ paymentId, reason: 'no' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describeWithDb('the receipt an admin is asked to verify', () => {
  /**
   * The detail view hands back a `receiptPath`, and that path has to be
   * fetchable by the admin looking at it — through the authenticated route
   * from Task 3, with their staff cookie. Driven through `createApp()`,
   * because a path nobody can fetch is a verification queue nobody can
   * work.
   */
  it('is reachable by a staff session through the authenticated route', async () => {
    const detail = await apiFor(finance, 'finance').admin.bookings.detail({ ref: queued.ref });
    const name = detail.payments[0]!.receiptPath;
    expect(name).toBeTruthy();

    const { token } = await createSession('user', finance, new Date());
    const res = await request(createApp())
      .get(`/api/receipts/${name}`)
      .set('Cookie', `${SESSION_COOKIE_BY_SUBJECT.user}=${token}`);

    expect(res.status, 'an admin cannot open the receipt they must verify').toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  /** And not by an anonymous caller, which is the route's own rule. */
  it('is NOT reachable without a session', async () => {
    const detail = await apiFor(finance, 'finance').admin.bookings.detail({ ref: queued.ref });
    const res = await request(createApp()).get(`/api/receipts/${detail.payments[0]!.receiptPath}`);
    expect(res.status).toBe(404);
  });
});

/**
 * Task 15 (7L) — pure helpers. `maskPhone` and `paymentMethodLabel` carry no
 * database or role logic, so they are proven here with plain function calls
 * rather than through a round trip.
 */
describe('maskPhone', () => {
  it('reveals only the last four characters', () => {
    expect(maskPhone('09171234567')).toBe('•••••••4567');
  });

  it('never returns more than four characters of the real number', () => {
    const masked = maskPhone('+639171234567');
    const revealed = masked.replace(/[^0-9]/g, '');
    expect(revealed).toBe('4567');
    expect(masked).not.toContain('917123');
  });

  it('leaves a string of four or fewer characters unchanged — nothing beyond the last four exists to hide', () => {
    expect(maskPhone('123')).toBe('123');
  });
});

describe('paymentMethodLabel', () => {
  it('renders every enum value in words', () => {
    expect(paymentMethodLabel('card')).toBe('Card');
    expect(paymentMethodLabel('gcash')).toBe('GCash');
    expect(paymentMethodLabel('maya')).toBe('Maya');
    expect(paymentMethodLabel('grab_pay')).toBe('GrabPay');
    expect(paymentMethodLabel('qrph')).toBe('QR Ph');
    expect(paymentMethodLabel('bank_transfer')).toBe('Bank transfer');
    expect(paymentMethodLabel('cash')).toBe('Cash');
  });

  it('falls back to the raw value for anything unrecognised, rather than throwing', () => {
    expect(paymentMethodLabel('something_new')).toBe('something_new');
  });
});

describeWithDb('admin.bookings.list — the payment queue card details (Task 15, 7L)', () => {
  /**
   * A booking whose guest uploaded a receipt, had it superseded by a second
   * upload, and whose second upload is the one still `pending` — the
   * realistic shape of a "2nd try" (owner decision 2026-10-14, Q6: a
   * replacement receipt supersedes rather than overwrites).
   */
  let secondAttempt: Fixture;
  const PENDING_PAYMENT_CREATED_AT = new Date('2099-01-05T03:00:00Z');
  const SECOND_ATTEMPT_PHONE = '09171234567';

  beforeAll(async () => {
    secondAttempt = await makeBooking({
      status: 'pending_verification',
      tourDate: '2099-04-05',
      leadPhone: SECOND_ATTEMPT_PHONE,
    });
    const db = getDb();

    const { path: firstPath } = await storeReceipt({
      buffer: JPEG,
      mimetype: 'image/jpeg',
      originalname: 'first.jpg',
    });
    created.files.push(firstPath);
    await db.insert(payments).values({
      bookingId: secondAttempt.bookingId,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      amountCentavos: TOTAL,
      status: 'superseded',
      receiptPath: firstPath,
      createdAt: new Date('2099-01-01T00:00:00Z'),
    });

    const { path: secondPath } = await storeReceipt({
      buffer: JPEG,
      mimetype: 'image/jpeg',
      originalname: 'second.jpg',
    });
    created.files.push(secondPath);
    await db.insert(payments).values({
      bookingId: secondAttempt.bookingId,
      type: 'payment',
      provider: 'manual',
      method: 'bank_transfer',
      amountCentavos: TOTAL,
      status: 'pending',
      receiptPath: secondPath,
      createdAt: PENDING_PAYMENT_CREATED_AT,
    });
  }, 30_000);

  it("carries the pending payment's own createdAt, not the booking's", async () => {
    const result = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    const row = result.items.find((item) => item.ref === secondAttempt.ref);
    expect(row).toBeDefined();
    expect(new Date(row!.pendingPaymentCreatedAt!).toISOString()).toBe(
      PENDING_PAYMENT_CREATED_AT.toISOString(),
    );
    expect(row!.pendingPaymentCreatedAt).not.toBe(row!.createdAt);
  });

  it('reads attemptNumber 2 for a booking on its second payment-type row', async () => {
    const result = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    const row = result.items.find((item) => item.ref === secondAttempt.ref);
    expect(row?.attemptNumber).toBe(2);
  });

  it('renders the method enum in words', async () => {
    const result = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    const row = result.items.find((item) => item.ref === secondAttempt.ref);
    expect(row?.method).toBe('Bank transfer');
  });

  it("masks the guest's phone to its last four digits, and never sends the real number", async () => {
    const result = await apiFor(finance, 'finance').admin.bookings.list({
      awaitingVerification: true,
      limit: 100,
    });
    const row = result.items.find((item) => item.ref === secondAttempt.ref);
    expect(row?.phoneMasked).toBe('•••••••4567');
    expect(row).not.toHaveProperty('leadPhone');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECOND_ATTEMPT_PHONE);
    // No run of more than the last four digits of the real number may
    // survive anywhere in the payload — not just the exact full string.
    expect(serialized).not.toContain(SECOND_ATTEMPT_PHONE.slice(0, -4));
  });
});
