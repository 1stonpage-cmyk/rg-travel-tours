/**
 * Week 4 plan, Task 3 — the authenticated receipt route.
 *
 * Storing a receipt outside the web root is only half the rule; this route
 * is the other half, and it is the half that can leak. Every test here is
 * an access-control test, and the central property is that **every refusal
 * is the same 404**: a "403 Forbidden" would tell a caller the file exists
 * and belongs to someone else, which is precisely the fact that must not be
 * learnable.
 *
 * Driven through `createApp()` with `supertest`, never through the router
 * function directly: the mount, the cookie parser and the route have to
 * work together, and a route tested in isolation proves nothing about
 * whether `app.ts` actually exposes it.
 */
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, payments, tours } from '../db/schema';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { generateBookingRef } from '../services/booking-ref';
import { users } from '../db/schema';
import { createSession } from '../services/sessions';
import { recordManualReceipt } from '../services/payments/manual-receipt';
import { receiptStorageDir, storeReceipt } from '../services/uploads';
import { describeWithDb } from './helpers/db';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('receipt-bytes')]);

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  files: [] as string[],
};
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** A booking with a stored receipt and the `payments` row that points at it. */
async function makeBookingWithReceipt() {
  const db = getDb();
  const slug = `__receipt__${unique()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({ slug, title: slug, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const [booking] = await db.insert(bookings).values({
    ref: generateBookingRef(),
    tourId: tour.insertId,
    tourDate: new Date('2099-12-20T00:00:00Z'),
    pax: 2,
    leadName: 'Receipt Fixture',
    leadEmail: 'receipt@example.test',
    leadPhone: '09170000000',
    status: 'pending_verification',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: 100000,
      discountCentavos: 0,
      totalCentavos: 100000,
    },
    subtotalCentavos: 100000,
    totalCentavos: 100000,
  });
  created.bookingIds.push(booking.insertId);

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
    amountCentavos: 100000,
    status: 'pending',
    txnRef: `TXN${unique()}`,
    receiptPath: path,
  });

  return { bookingId: booking.insertId, path };
}

const cookie = (token: string) => `${SESSION_COOKIE}=${token}`;

const staffIds: number[] = [];

/**
 * A real staff row. A `user` session resolves its role LIVE from `users`
 * (Week 4, Task 5), so an invented subject id no longer resolves at all —
 * which is the deactivation guarantee working, and the reason these tests
 * create an actual staff member instead of a number.
 *
 * The ROLE is a parameter because this route is no longer open to every
 * staff role (owner decision 2026-10-23, Q2): `finance` is the default so
 * the tests written before that decision still describe someone who may
 * read a receipt, and the role-by-role tests below pass their own.
 */
async function makeStaff(role: 'owner' | 'dispatcher' | 'finance' = 'finance') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Receipt Staff ${unique}`,
      email: `receipt_staff_${unique}@example.test`,
      passwordHash: '__receipt_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  staffIds.push(row.insertId);
  return row.insertId;
}

async function cleanup() {
  const pool = getPool();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_id = ?', [id]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) await getDb().delete(tours).where(eq(tours.id, id));
  for (const id of created.destIds)
    await getDb().delete(destinations).where(eq(destinations.id, id));
  for (const name of created.files) await rm(join(receiptStorageDir(), name), { force: true });
  for (const id of staffIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
  staffIds.length = 0;
  created.bookingIds = [];
  created.tourIds = [];
  created.destIds = [];
  created.files = [];
}

describeWithDb('GET /api/receipts/:name', () => {
  afterEach(cleanup);

  it('serves the receipt to the guest whose booking it belongs to', async () => {
    const { bookingId, path } = await makeBookingWithReceipt();
    const { token } = await createSession('customer', bookingId, new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${path}`)
      .set('Cookie', cookie(token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(res.body as Buffer)).toEqual(JPEG);
  });

  /* ====================================================================
   * Who, among staff, may read one (owner decision 2026-10-23, Q2).
   *
   * **It is not "any staff session" any more.** A receipt is payment data,
   * and §9's "Verify payments, record payments ✅ ❌ ✅" row gives payment
   * data to the owner and to finance. A dispatcher runs the day; nothing in
   * it needs a guest's bank transfer screenshot, and a guest disputing a
   * transfer at the office is handled by finance or the owner.
   *
   * The dispatcher's refusal is asserted against a STRANGER'S refusal, byte
   * for byte, because the narrowing must not open the oracle this route
   * exists to keep shut: "403" or any distinguishable body would tell a
   * dispatcher that the file is real and belongs to someone.
   * ==================================================================== */

  it('serves a receipt to an OWNER session', async () => {
    const { path } = await makeBookingWithReceipt();
    const { token } = await createSession('user', await makeStaff('owner'), new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${path}`)
      .set('Cookie', cookie(token));
    expect(res.status, 'an owner cannot read a receipt').toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('serves a receipt to a FINANCE session — verifying one is their job', async () => {
    const { path } = await makeBookingWithReceipt();
    const { token } = await createSession('user', await makeStaff('finance'), new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${path}`)
      .set('Cookie', cookie(token));
    expect(res.status, 'finance cannot read the receipt they must verify').toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  /**
   * **The load-bearing test of this narrowing.** Not "a dispatcher gets a
   * 404" — a 404 with a different body, or with a `WWW-Authenticate`, or
   * with anything else that varies by reason, would still be an oracle. The
   * dispatcher's whole answer is compared with the answer given to a caller
   * with no session at all.
   */
  it('REFUSES a DISPATCHER session with the SAME 404 as a stranger', async () => {
    const { path } = await makeBookingWithReceipt();
    const { token } = await createSession('user', await makeStaff('dispatcher'), new Date());
    const app = createApp();

    const dispatcher = await request(app).get(`/api/receipts/${path}`).set('Cookie', cookie(token));
    const stranger = await request(app).get(`/api/receipts/${path}`);

    expect(dispatcher.status, 'a dispatcher was served a guest’s bank receipt').toBe(404);
    expect(dispatcher.body).toEqual({ error: 'Not found' });
    // Byte for byte the stranger's refusal, so the status is not the only
    // thing the two have in common.
    expect(stranger.status).toBe(404);
    expect(dispatcher.status).toBe(stranger.status);
    expect(dispatcher.body).toEqual(stranger.body);
    expect(dispatcher.text).toBe(stranger.text);
  });

  /** §8 needs no bank receipt, and this did not change with Q2. */
  it('REFUSES a DRIVER session', async () => {
    const { path } = await makeBookingWithReceipt();
    const { token } = await createSession('driver', 7, new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${path}`)
      .set('Cookie', cookie(token));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  /**
   * A staff member who still owes a password change has not finished
   * signing in (staff accounts, 2026-10-23): every admin procedure refuses
   * them, and this route must not be the side door. 404, the same answer as
   * every other refusal here. The 200 for the same person once the flag is
   * cleared is what proves the 404 came from the flag and not from some other
   * reason the request was turned away.
   */
  it('REFUSES a staff session that still owes a password change, then serves it once cleared', async () => {
    const { path } = await makeBookingWithReceipt();
    const staffId = await makeStaff();
    const { token } = await createSession('user', staffId, new Date());
    const get = () =>
      request(createApp()).get(`/api/receipts/${path}`).set('Cookie', cookie(token));

    await getPool().query('UPDATE users SET must_change_password = 1 WHERE id = ?', [staffId]);
    const owing = await get();
    expect(owing.status, 'a staff session that owes a new password was served a receipt').toBe(404);
    expect(owing.body).toEqual({ error: 'Not found' });

    await getPool().query('UPDATE users SET must_change_password = 0 WHERE id = ?', [staffId]);
    expect((await get()).status).toBe(200);
  });

  /**
   * **The central property.** Four different reasons to refuse, one
   * indistinguishable answer. Asserted by deep equality across all four
   * responses, not one at a time — a test that checked each separately
   * would pass against four different bodies that happened to share a
   * status.
   */
  it('answers every refusal with the SAME 404 — no oracle', async () => {
    const mine = await makeBookingWithReceipt();
    const someoneElse = await makeBookingWithReceipt();
    const app = createApp();

    const other = await createSession('customer', someoneElse.bookingId, new Date());
    const driver = await createSession('driver', 7, new Date());

    const responses = [
      // No session at all.
      await request(app).get(`/api/receipts/${mine.path}`),
      // A session for a DIFFERENT booking.
      await request(app).get(`/api/receipts/${mine.path}`).set('Cookie', cookie(other.token)),
      // A driver session, which has no business with a bank receipt.
      await request(app).get(`/api/receipts/${mine.path}`).set('Cookie', cookie(driver.token)),
      // A well-formed name that is not a real receipt.
      await request(app)
        .get(`/api/receipts/${'a'.repeat(32)}.jpg`)
        .set('Cookie', cookie(other.token)),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(responses[0]!.body);
    }
  });

  it('REFUSES a path-traversal name without touching the filesystem', async () => {
    const app = createApp();
    const { token } = await createSession('user', await makeStaff(), new Date());
    for (const name of ['../../.env', '..%2f..%2f.env', 'x.jpg', 'ABCDEF.jpg']) {
      const res = await request(app).get(`/api/receipts/${name}`).set('Cookie', cookie(token));
      expect(res.status, `${name} was not refused`).toBe(404);
    }
  });

  /**
   * **The filename regex, proven load-bearing — and it took a planted row
   * to do it.** The first version of the traversal test sent `../../.env`
   * and friends with no matching `payments` row, and removing the regex left
   * it GREEN: Express's own routing refuses a param containing slashes, and
   * anything else fails the receipt lookup. The regex was defence in depth
   * against a hazard the test could not reach.
   *
   * This is the input where it is the only thing standing in the way: a
   * `payments` row whose `receipt_path` IS a traversal string. Written with
   * a raw insert, bypassing `storeReceipt()` entirely — the way a seed
   * script, a migration or a future code path that trusts a client-supplied
   * path would write it. With the regex, 404. Without it, `join()` escapes
   * the receipts directory and the route serves whatever is there.
   */
  it('REFUSES a receipt_path that escapes the directory, even with a row behind it', async () => {
    const { bookingId } = await makeBookingWithReceipt();
    /*
     * TWO levels up from `uploads/receipts` is the repo root, where the real
     * `.env` lives. The first attempt used three levels and stayed green
     * for an embarrassing reason: the traversal resolved to a path with no
     * file, so `stat` failed and the route answered 404 for the wrong
     * reason. A traversal test has to land on something that EXISTS or it
     * proves nothing.
     */
    const escaping = '../../.env';
    await getPool().query('UPDATE payments SET receipt_path = ? WHERE booking_id = ?', [
      escaping,
      bookingId,
    ]);
    const { token } = await createSession('user', await makeStaff(), new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${encodeURIComponent(escaping)}`)
      .set('Cookie', cookie(token));

    expect(res.status, 'a traversal path with a payments row behind it was served').toBe(404);
    /*
     * A BOOLEAN, not the text. `not.toContain` would print the whole body
     * on failure — and the body in the failing case is the repo's `.env`,
     * so the test would leak the secrets it exists to protect into the CI
     * log. Assert the predicate and keep the contents out of the report.
     */
    expect(
      (res.text ?? '').includes('DATABASE_URL'),
      'the route served the repository .env file',
    ).toBe(false);
  });

  it('REFUSES an expired session', async () => {
    const { bookingId, path } = await makeBookingWithReceipt();
    const { token } = await createSession(
      'customer',
      bookingId,
      new Date(Date.now() - 48 * 3600_000),
    );

    expect(
      (await request(createApp()).get(`/api/receipts/${path}`).set('Cookie', cookie(token))).status,
    ).toBe(404);
  });

  /* ====================================================================
   * Superseded receipts (Week 4 Task 6; owner decision 2026-10-14, Q6).
   *
   * A second upload does not delete the first — it marks it `superseded`
   * and keeps the file, so a disputed transfer can still be examined. The
   * access rule narrows with it: the older file is for **the people who
   * verify payments** and nobody else, because the guest has already moved
   * on to the receipt that replaced it. (Those people were "any staff" when
   * this was written and are owner and finance since Q2, 2026-10-23; the
   * fixture's default role is one of them, so the rule tested is unchanged.)
   * ==================================================================== */

  it('serves a SUPERSEDED receipt to a verifier', async () => {
    const { bookingId, path: first } = await makeBookingWithReceipt();
    const second = await storeReceipt({
      buffer: JPEG,
      mimetype: 'image/jpeg',
      originalname: 'r2.jpg',
    });
    created.files.push(second.path);
    await recordManualReceipt({
      bookingId,
      method: 'gcash',
      txnRef: `TXN${unique()}`,
      receiptPath: second.path,
      now: new Date(),
    });

    const { token } = await createSession('user', await makeStaff(), new Date());
    expect(
      (await request(createApp()).get(`/api/receipts/${first}`).set('Cookie', cookie(token)))
        .status,
      'a verifier cannot read the receipt they are being asked to compare against',
    ).toBe(200);
  });

  /**
   * And NOT to the guest who uploaded it — with the same 404 as any
   * stranger's file, so the refusal does not announce that it still exists.
   * Their current receipt is still theirs to see, which is what makes this
   * a narrowing rather than a lockout.
   */
  it('REFUSES a superseded receipt to the guest, while still serving the current one', async () => {
    const { bookingId, path: first } = await makeBookingWithReceipt();
    const second = await storeReceipt({
      buffer: JPEG,
      mimetype: 'image/jpeg',
      originalname: 'r2.jpg',
    });
    created.files.push(second.path);
    await recordManualReceipt({
      bookingId,
      method: 'gcash',
      txnRef: `TXN${unique()}`,
      receiptPath: second.path,
      now: new Date(),
    });

    const { token } = await createSession('customer', bookingId, new Date());
    const app = createApp();

    const superseded = await request(app)
      .get(`/api/receipts/${first}`)
      .set('Cookie', cookie(token));
    expect(superseded.status).toBe(404);
    expect(superseded.body).toEqual({ error: 'Not found' });

    expect(
      (await request(app).get(`/api/receipts/${second.path}`).set('Cookie', cookie(token))).status,
      'the guest lost access to the receipt they just uploaded',
    ).toBe(200);
  });

  /**
   * A receipt is a bank transfer screenshot. It must never sit in a shared
   * cache, and a browser must never be talked into sniffing it as something
   * executable.
   */
  it('sends no-store and nosniff', async () => {
    const { bookingId, path } = await makeBookingWithReceipt();
    const { token } = await createSession('customer', bookingId, new Date());

    const res = await request(createApp())
      .get(`/api/receipts/${path}`)
      .set('Cookie', cookie(token));

    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
