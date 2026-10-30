/**
 * Week 4 plan, Task 8 — `portal.manualPayment`, the data behind the manual
 * QR screen (§6 step 1).
 *
 * **The property this file exists to protect: a booking reference alone
 * reveals nothing** (owner decision 2026-10-14, Q5). This procedure takes
 * no input at all — the booking comes from the customer session, whose
 * `subject_id` IS the booking id — so there is no reference to pass and
 * nothing to tamper with. The tests below prove that from the outside: no
 * session, a staff session and a foreign argument are all refused or
 * ignored.
 *
 * The second property is the owner's Q3 rule: while `payment_qr` is not
 * configured, the account details do not exist to be leaked. `qr` is null,
 * the public settings payload says the option is off, and the checkout does
 * not offer it. Three places, one flag.
 */
import { afterAll, afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { RECEIPT_UPLOAD_MAX_PER_BOOKING, depositCentavos } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, payments, settings, tours, users } from '../db/schema';
import { createApp } from '../app';
import { paymentQrStorageDir } from '../routers/payment-qr';
import { appRouter } from '../routers/_app';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { createSession } from '../services/sessions';
import { generateBookingRef } from '../services/booking-ref';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const TOTAL = 1_000_000;
const DEPOSIT_PERCENT = 30;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

/** The seeded `payment_qr` row, restored after any test that changes it. */
let storedQr: unknown;

async function readQrRow(): Promise<unknown> {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'payment_qr'));
  return row?.value;
}

async function writeQrRow(value: unknown): Promise<void> {
  await getDb().update(settings).set({ value }).where(eq(settings.key, 'payment_qr'));
}

afterEach(async () => {
  if (storedQr !== undefined) {
    await writeQrRow(storedQr);
    storedQr = undefined;
  }
});

async function makeBooking(
  opts: { payMode?: 'full' | 'deposit'; amountPaidCentavos?: number; receipts?: number } = {},
) {
  const db = getDb();
  const slug = `__qr__${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
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
    tourDate: new Date('2099-12-25T00:00:00Z'),
    pax: 3,
    leadName: 'QR Fixture',
    leadEmail: `qr_${slug}@example.test`,
    leadPhone: '09170000000',
    status: 'pending_payment',
    payMode: opts.payMode ?? 'deposit',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 3 },
      addons: [],
      coupon: null,
      depositPercent: DEPOSIT_PERCENT,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL,
      discountCentavos: 0,
      totalCentavos: TOTAL,
    },
    subtotalCentavos: TOTAL,
    totalCentavos: TOTAL,
    amountPaidCentavos: opts.amountPaidCentavos ?? 0,
    holdExpiresAt: new Date('2099-12-24T00:00:00Z'),
  });
  created.bookingIds.push(booking.insertId);

  for (let i = 0; i < (opts.receipts ?? 0); i += 1) {
    await db.insert(payments).values({
      bookingId: booking.insertId,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      amountCentavos: 1_000,
      status: i === (opts.receipts ?? 0) - 1 ? 'pending' : 'superseded',
      txnRef: `GC${i}${slug.slice(-6)}`,
      receiptPath: `${(i + 1).toString(16).padStart(32, 'a')}.jpg`,
    });
  }

  return { bookingId: booking.insertId, ref, tourTitle: `Tour ${slug}` };
}

async function makeStaff() {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `QR Staff ${unique}`,
      email: `qr_staff_${unique}@example.test`,
      passwordHash: '__qr_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

const CONFIGURED = {
  imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
  accountName: 'R&G Travel and Tours',
  accountNumber: '0917 000 0000',
  instructions: 'Put your booking reference in the transfer note.',
  isConfigured: true,
};

afterAll(async () => {
  const pool = getPool();
  for (const id of created.bookingIds) {
    // Raw SQL for bookings and payments, per `schema-conventions.test.ts`.
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
    await getDb().delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await getDb().delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('portal.manualPayment', () => {
  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.portal.manualPayment()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * A staff session is not a guest session. Staff read a booking through the
   * admin surface, where access is role-gated and audited.
   */
  it('REFUSES a staff session', async () => {
    const api = appRouter.createCaller(staffContext(await makeStaff(), 'owner') as never);
    await expect(api.portal.manualPayment()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('answers the booking the session names', async () => {
    const mine = await makeBooking();
    const api = appRouter.createCaller(customerContext(mine.bookingId) as never);

    const result = await api.portal.manualPayment();

    expect(result.ref).toBe(mine.ref);
    expect(result.tourTitle).toBe(mine.tourTitle);
    expect(result.tourDate, 'a civil date, never a timestamp').toBe('2099-12-25');
    expect(result.pax).toBe(3);
  });

  /**
   * **The IDOR test.** There is no input on this procedure, so an argument
   * is not merely refused — it has nowhere to go. A caller who passes
   * someone else's booking still gets their own, which is the property that
   * makes "a booking reference reveals nothing" structural.
   */
  it('IGNORES an argument naming another booking', async () => {
    const mine = await makeBooking();
    const theirs = await makeBooking();
    const api = appRouter.createCaller(customerContext(mine.bookingId) as never);

    const result = await (
      api.portal.manualPayment as unknown as (input: unknown) => Promise<{ ref: string }>
    )({ ref: theirs.ref, bookingId: theirs.bookingId });

    expect(result.ref, 'an argument reached a booking the session does not own').toBe(mine.ref);
    expect(result.ref).not.toBe(theirs.ref);
  });

  /**
   * The amount is the server's, computed from the booking's own price
   * snapshot — never a number a browser could supply, and never one the QR
   * image carries (a static QR cannot embed an amount, which is why §6
   * shows it as text beside it).
   */
  it('computes the amount due from the booking, for both pay modes', async () => {
    const deposit = await makeBooking({ payMode: 'deposit' });
    const depositApi = appRouter.createCaller(customerContext(deposit.bookingId) as never);
    expect((await depositApi.portal.manualPayment()).amountDueCentavos).toBe(
      depositCentavos(TOTAL, DEPOSIT_PERCENT),
    );

    const full = await makeBooking({ payMode: 'full' });
    const fullApi = appRouter.createCaller(customerContext(full.bookingId) as never);
    expect((await fullApi.portal.manualPayment()).amountDueCentavos).toBe(TOTAL);
  });

  it('subtracts what has already been paid, and never goes negative', async () => {
    const part = await makeBooking({ payMode: 'full', amountPaidCentavos: 400_000 });
    const partApi = appRouter.createCaller(customerContext(part.bookingId) as never);
    expect((await partApi.portal.manualPayment()).amountDueCentavos).toBe(TOTAL - 400_000);

    const overpaid = await makeBooking({ payMode: 'deposit', amountPaidCentavos: TOTAL });
    const overApi = appRouter.createCaller(customerContext(overpaid.bookingId) as never);
    expect(
      (await overApi.portal.manualPayment()).amountDueCentavos,
      'a paid-up booking showed a negative amount due',
    ).toBe(0);
  });

  /**
   * Owner decision Q3: nothing is invented. Until R&G send the real values,
   * `qr` is null and the screen says so in amber.
   */
  it('answers qr: null while payment_qr is not configured', async () => {
    const mine = await makeBooking();
    const api = appRouter.createCaller(customerContext(mine.bookingId) as never);
    expect((await api.portal.manualPayment()).qr).toBeNull();
  });

  it('returns the account details once payment_qr IS configured', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);

    const mine = await makeBooking();
    const api = appRouter.createCaller(customerContext(mine.bookingId) as never);
    const result = await api.portal.manualPayment();

    expect(result.qr).toEqual({
      imagePath: CONFIGURED.imagePath,
      accountName: CONFIGURED.accountName,
      accountNumber: CONFIGURED.accountNumber,
      instructions: CONFIGURED.instructions,
    });
    // `isConfigured` itself is internal: the client reads "are there
    // details" from whether `qr` is null.
    expect(result.qr).not.toHaveProperty('isConfigured');
  });

  /**
   * Even configured, the details are behind the session. This is the test
   * that would have caught publishing them in the public settings payload.
   */
  it('still refuses an anonymous caller when the details EXIST', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);

    const api = appRouter.createCaller(testContext() as never);
    await expect(api.portal.manualPayment()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /** So the screen can say "two uploads left" before a guest picks a file. */
  it('reports how many uploads are left', async () => {
    const fresh = await makeBooking();
    const freshApi = appRouter.createCaller(customerContext(fresh.bookingId) as never);
    expect((await freshApi.portal.manualPayment()).uploadsRemaining).toBe(
      RECEIPT_UPLOAD_MAX_PER_BOOKING,
    );

    const used = await makeBooking({ receipts: 2 });
    const usedApi = appRouter.createCaller(customerContext(used.bookingId) as never);
    expect((await usedApi.portal.manualPayment()).uploadsRemaining).toBe(
      RECEIPT_UPLOAD_MAX_PER_BOOKING - 2,
    );

    const capped = await makeBooking({ receipts: RECEIPT_UPLOAD_MAX_PER_BOOKING });
    const cappedApi = appRouter.createCaller(customerContext(capped.bookingId) as never);
    expect((await cappedApi.portal.manualPayment()).uploadsRemaining).toBe(0);
  });

  /** The hold the countdown runs from, as an instant the client can compare. */
  it('publishes the hold expiry', async () => {
    const mine = await makeBooking();
    const api = appRouter.createCaller(customerContext(mine.bookingId) as never);
    const result = await api.portal.manualPayment();
    expect(result.holdExpiresAt).toBeInstanceOf(Date);
    expect(result.holdExpiresAt!.toISOString()).toBe('2099-12-24T00:00:00.000Z');
  });
});

describeWithDb('the public settings payload', () => {
  /**
   * **The account details must never be in the public payload.** This is
   * every page's settings query: a leak here would publish R&G's account
   * number to anyone who opened the home page.
   */
  it('publishes only the manual-transfer FLAG, never the account details', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);

    const api = appRouter.createCaller(testContext() as never);
    const payload = await api.settings.get();

    expect(payload.manualTransferEnabled).toBe(true);
    const serialised = JSON.stringify(payload);
    expect(serialised, 'the account number reached the public payload').not.toContain(
      CONFIGURED.accountNumber,
    );
    expect(serialised).not.toContain(CONFIGURED.accountName);
    expect(serialised).not.toContain(CONFIGURED.imagePath);
    expect(serialised).not.toContain('accountNumber');
  });

  /** And the flag is false on the seeded, unconfigured database. */
  it('says the manual transfer is OFF while payment_qr is unconfigured', async () => {
    const api = appRouter.createCaller(testContext() as never);
    const payload = await api.settings.get();
    expect(payload.manualTransferEnabled).toBe(false);
  });
});

/* ======================================================================
 * GET /api/payment-qr — the image itself.
 *
 * Driven through `createApp()`, because the mount, the cookie parser and
 * the route have to work together. The route takes NO parameter, so the
 * traversal tests the receipts route needs have nothing to aim at here:
 * the filename comes from a settings row, not from the caller.
 * ====================================================================== */

/** A real PNG header, so the response is a plausible image. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('qr-bytes'),
]);

describeWithDb('GET /api/payment-qr', () => {
  async function putImage(name: string): Promise<void> {
    await mkdir(paymentQrStorageDir(), { recursive: true });
    await writeFile(join(paymentQrStorageDir(), name), PNG);
  }

  async function removeImage(name: string): Promise<void> {
    await rm(join(paymentQrStorageDir(), name), { force: true });
  }

  async function guestCookie(bookingId: number): Promise<string> {
    const { token } = await createSession('customer', bookingId, new Date());
    return `${SESSION_COOKIE_BY_SUBJECT.customer}=${token}`;
  }

  it('REFUSES an anonymous request with the same 404 as everything else', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await putImage(CONFIGURED.imagePath);

    const res = await request(createApp()).get('/api/payment-qr');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });

    await removeImage(CONFIGURED.imagePath);
  });

  /**
   * A cookie that is not a live session — expired, revoked, or simply
   * invented. Added after a mutation run: the anonymous case above is
   * answered by the "no cookie at all" branch, so deleting the
   * `readSession` check changed nothing and that test stayed green. A
   * stale cookie is also the realistic case: a guest comes back to the
   * tab tomorrow.
   */
  it('REFUSES a cookie that is not a live session', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await putImage(CONFIGURED.imagePath);

    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', `${SESSION_COOKIE_BY_SUBJECT.customer}=not-a-real-session-token`);
    expect(res.status, 'an invented session token was served the QR').toBe(404);

    await removeImage(CONFIGURED.imagePath);
  });

  it('serves the image to a signed-in guest, with nosniff and a private cache', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await putImage(CONFIGURED.imagePath);
    const mine = await makeBooking();

    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', await guestCookie(mine.bookingId));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(Buffer.from(res.body as Buffer)).toEqual(PNG);

    await removeImage(CONFIGURED.imagePath);
  });

  it('serves it to staff too, who have to look at what the guest sees', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await putImage(CONFIGURED.imagePath);
    const { token } = await createSession('user', await makeStaff(), new Date());

    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', `${SESSION_COOKIE_BY_SUBJECT.user}=${token}`);
    expect(res.status).toBe(200);

    await removeImage(CONFIGURED.imagePath);
  });

  /**
   * A staff member who still owes a password change has not finished
   * signing in, so they are not shown the QR either (staff accounts,
   * 2026-10-23). This route answers 404 for several other reasons, so the
   * refusal is only meaningful next to the 200 for the same person once the
   * flag is cleared, with everything else held still.
   */
  it('REFUSES staff who still owe a password change, then serves the QR once cleared', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await putImage(CONFIGURED.imagePath);
    const staffId = await makeStaff();
    const { token } = await createSession('user', staffId, new Date());
    const get = () =>
      request(createApp())
        .get('/api/payment-qr')
        .set('Cookie', `${SESSION_COOKIE_BY_SUBJECT.user}=${token}`);

    await getPool().query('UPDATE users SET must_change_password = 1 WHERE id = ?', [staffId]);
    const owing = await get();
    expect(owing.status, 'a staff session that owes a new password was served the QR').toBe(404);

    await getPool().query('UPDATE users SET must_change_password = 0 WHERE id = ?', [staffId]);
    expect((await get()).status).toBe(200);

    await removeImage(CONFIGURED.imagePath);
  });

  /** Nothing is configured, so there is nothing to serve — and no hint either. */
  it('REFUSES while payment_qr is unconfigured, even to a signed-in guest', async () => {
    const mine = await makeBooking();
    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', await guestCookie(mine.bookingId));
    expect(res.status).toBe(404);
  });

  /**
   * **`isConfigured` is load-bearing on its own.** The schema allows an
   * image to be uploaded with the flag still false — that is exactly the
   * state between an admin uploading the QR and confirming the account
   * details — and in that state the route must still refuse. Without this
   * case the flag could be deleted from the check and every other test
   * would stay green, because an unconfigured block also has a null
   * `imagePath`.
   */
  it('REFUSES when the image exists but isConfigured is still false', async () => {
    storedQr = await readQrRow();
    await writeQrRow({ ...CONFIGURED, isConfigured: false });
    await putImage(CONFIGURED.imagePath);
    const mine = await makeBooking();

    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', await guestCookie(mine.bookingId));
    expect(res.status, 'an unconfirmed QR was served to a guest').toBe(404);

    await removeImage(CONFIGURED.imagePath);
  });

  /**
   * The row says there is an image and the disk disagrees. Same 404: the
   * row is the thing to investigate, and a guest cannot act on the
   * difference.
   */
  it('REFUSES when the configured file is not on disk', async () => {
    storedQr = await readQrRow();
    await writeQrRow(CONFIGURED);
    await removeImage(CONFIGURED.imagePath);
    const mine = await makeBooking();

    const res = await request(createApp())
      .get('/api/payment-qr')
      .set('Cookie', await guestCookie(mine.bookingId));
    expect(res.status).toBe(404);
  });

  /**
   * A filename an admin could only set by hand, and the route refuses it
   * rather than handing it to `join`. The settings row is admin-only, which
   * is a reason to trust it less than a generated name, not more.
   */
  it('REFUSES a stored filename that is not a plain image name', async () => {
    const mine = await makeBooking();
    const cookie = await guestCookie(mine.bookingId);
    for (const imagePath of ['../../.env', 'qr.png/../../x', 'qr.svg', 'qr', '']) {
      storedQr ??= await readQrRow();
      await writeQrRow({ ...CONFIGURED, imagePath: imagePath || 'x.png' });
      const res = await request(createApp()).get('/api/payment-qr').set('Cookie', cookie);
      expect(res.status, `${imagePath} was accepted as a QR filename`).toBe(404);
    }
  });
});
