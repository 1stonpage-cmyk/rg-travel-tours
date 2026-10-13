/**
 * Week 4 plan, Task 6 — `POST /api/receipts/upload`.
 *
 * `manual-receipt.test.ts` proves what the service writes. This file proves
 * the door: who may push bytes through it, which bytes, how many, and what
 * the guest is told when it refuses.
 *
 * Driven through `createApp()` with `supertest`, never the router function
 * directly — the mount, the cookie parser, the origin check, the limiter
 * and the route have to work together, and a route tested in isolation
 * proves nothing about whether `app.ts` exposes it.
 *
 * **The test that matters most is the IDOR one.** The booking comes from
 * the session; a `bookingId` in the request is ignored. Everything else
 * here is a quality-of-refusal test, and that one is a vulnerability test.
 */
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { RECEIPT_UPLOAD_MAX_PER_BOOKING } from '@rg/shared';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, payments, tours, users } from '../db/schema';
import { RECEIPT_UPLOAD_MAX_PER_IP } from '../middleware/rate-limit';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { generateBookingRef } from '../services/booking-ref';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { createSession } from '../services/sessions';
import { receiptStorageDir } from '../services/uploads';
import { describeWithDb } from './helpers/db';

/*
 * Teardown uses RAW SQL through the pool for `bookings` and `payments`,
 * never Drizzle's `.delete()`.
 *
 * `schema-conventions.test.ts` forbids `.delete(bookings)` and
 * `.delete(payments)` anywhere in the server tree, tests included, and
 * scans only application source for the raw form — so raw SQL in a fixture
 * teardown is the shape the guard is built to allow. It is cleanup in
 * `rg_travel_test`, not shipped behaviour, and `record-payment.test.ts`
 * does the same for the same reason.
 */

/** A real JPEG header, so the magic-byte check in `storeReceipt` passes. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a'.repeat(64))]);
/** JPEG-shaped claim, HEIC-shaped bytes: what an iPhone screenshot really does. */
const NOT_JPEG = Buffer.from('ftypheic-not-a-jpeg-at-all');
const ORIGIN = 'http://localhost:5180';

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

const sent: Array<{ to: string; subject: string }> = [];

beforeEach(() => {
  sent.length = 0;
  setTransportForTests({
    sendMail: async (mail) => {
      sent.push({ to: String(mail.to), subject: String(mail.subject) });
    },
  });
});

afterEach(() => resetTransportForTests());

async function makeBooking(opts: { status?: 'pending_payment' | 'confirmed' } = {}) {
  const db = getDb();
  const slug = `__upload__${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({ slug, title: slug, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const [booking] = await db.insert(bookings).values({
    ref: generateBookingRef(),
    tourId: tour.insertId,
    tourDate: new Date('2099-12-20T00:00:00Z'),
    pax: 2,
    leadName: 'Upload Fixture',
    leadEmail: `upload_${slug}@example.test`,
    leadPhone: '09170000000',
    status: opts.status ?? 'pending_payment',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 50_000 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: 100_000,
      discountCentavos: 0,
      totalCentavos: 100_000,
    },
    subtotalCentavos: 100_000,
    totalCentavos: 100_000,
    holdExpiresAt: new Date('2099-12-19T00:00:00Z'),
  });
  created.bookingIds.push(booking.insertId);

  const { token } = await createSession('customer', booking.insertId, new Date());
  return { bookingId: booking.insertId, token, leadEmail: `upload_${slug}@example.test` };
}

async function makeStaffSession() {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Upload Staff ${unique}`,
      email: `upload_staff_${unique}@example.test`,
      passwordHash: '__upload_fixture_not_a_hash__',
      role: 'finance',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  const { token } = await createSession('user', row.insertId, new Date());
  return token;
}

/**
 * One upload, shaped the way the browser will send it: the file as the raw
 * body with its real content type, the metadata in the query string.
 */
function upload(
  app: ReturnType<typeof createApp>,
  token: string | null,
  query: Record<string, string>,
  body: Buffer = JPEG,
  contentType = 'image/jpeg',
) {
  const search = new URLSearchParams(query).toString();
  const req = request(app)
    .post(`/api/receipts/upload?${search}`)
    .set('Origin', ORIGIN)
    .set('Content-Type', contentType);
  if (token) req.set('Cookie', `${SESSION_COOKIE}=${token}`);
  return req.send(body);
}

const META = { method: 'gcash', txnRef: 'GC1234567890', filename: 'receipt.jpg' };

async function receiptsOf(bookingId: number) {
  return getDb()
    .select({ id: payments.id, status: payments.status, path: payments.receiptPath })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), sql`${payments.receiptPath} IS NOT NULL`))
    .orderBy(payments.id);
}

const storedFiles = async () => (await readdir(receiptStorageDir())).length;

afterAll(async () => {
  const pool = getPool();
  // Remove the files this suite actually wrote, by name, from its rows.
  for (const id of created.bookingIds) {
    const rows = await receiptsOf(id);
    for (const row of rows) {
      if (row.path) await rm(join(receiptStorageDir(), row.path), { force: true });
    }
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
  }
  await getDb()
    .delete(auditLog)
    .where(sql`${auditLog.action} LIKE 'payment.receipt%'`);
  for (const id of created.bookingIds) {
    // Raw SQL, not `.delete(bookings)` — see the note on the import block.
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
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

describeWithDb('POST /api/receipts/upload', () => {
  it('accepts a receipt and leaves the booking awaiting verification', async () => {
    const { bookingId, token } = await makeBooking();

    const res = await upload(createApp(), token, META);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'pending_verification' });

    const rows = await receiptsOf(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    const [booking] = await getDb()
      .select({ status: bookings.status, paid: bookings.amountPaidCentavos })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    expect(booking!.status).toBe('pending_verification');
    expect(booking!.paid, 'an upload moved money onto the booking').toBe(0);
  });

  /**
   * **The IDOR test.** A `bookingId` in the request is not merely refused,
   * it is unreadable: the route never looks at one. So an upload carrying
   * someone else's booking id lands on the SESSION's booking, and the other
   * booking is untouched.
   */
  it('IGNORES a bookingId in the request and uses the session', async () => {
    const mine = await makeBooking();
    const theirs = await makeBooking();

    const res = await upload(createApp(), mine.token, {
      ...META,
      bookingId: String(theirs.bookingId),
    });

    expect(res.status).toBe(200);
    expect(await receiptsOf(mine.bookingId)).toHaveLength(1);
    expect(
      await receiptsOf(theirs.bookingId),
      'an upload reached a booking the session does not own',
    ).toHaveLength(0);
  });

  it('REFUSES an upload with no session, and one with a STAFF session', async () => {
    const app = createApp();
    expect((await upload(app, null, META)).status).toBe(401);

    // Staff verify receipts; they do not upload them on a guest's behalf.
    // There is no booking in a staff session to attach one to.
    const staff = await makeStaffSession();
    expect((await upload(app, staff, META)).status).toBe(401);
  });

  /**
   * The magic-byte check, from the outside. And the file must NOT be left
   * on disk: a rejected upload that still writes bytes is a directory
   * slowly filling with unreferenced guest data (RA 10173).
   */
  it('REFUSES bytes that are not the type they claim, and stores nothing', async () => {
    const { token } = await makeBooking();
    const before = await storedFiles();

    const res = await upload(createApp(), token, META, NOT_JPEG);

    expect(res.status).toBe(415);
    expect(String(res.body.error)).toMatch(/photo|PDF/i);
    expect(await storedFiles(), 'a refused upload left a file behind').toBe(before);
  });

  it('REFUSES a body whose content type is not allowed at all', async () => {
    const { token } = await makeBooking();
    const res = await upload(createApp(), token, META, Buffer.from('hello'), 'text/plain');
    expect(res.status).toBe(415);
  });

  /**
   * The method allowlist (owner decision 2026-10-14, Q4): gcash, maya and
   * bank_transfer. Every other `PAYMENT_METHODS` value is refused at the
   * Zod boundary — `cash` especially, which is the office/driver flow and
   * must not be reachable from a guest's browser.
   */
  it('REFUSES every payment method outside the manual-transfer three', async () => {
    const { token } = await makeBooking();
    const app = createApp();
    for (const method of ['cash', 'card', 'grab_pay', 'qrph', 'paymongo', '']) {
      const res = await upload(app, token, { ...META, method });
      expect(res.status, `${method || '(empty)'} was accepted`).toBe(400);
    }
  });

  it('ACCEPTS each of the three allowed methods', async () => {
    const app = createApp();
    for (const method of ['gcash', 'maya', 'bank_transfer']) {
      const { token } = await makeBooking();
      const res = await upload(app, token, { ...META, method });
      expect(res.status, `${method} was refused`).toBe(200);
    }
  });

  it('REFUSES a missing or too-short transfer reference', async () => {
    const { token } = await makeBooking();
    const app = createApp();
    for (const txnRef of ['', ' ', 'ab']) {
      const res = await upload(app, token, { ...META, txnRef });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/reference/i);
    }
  });

  /** The cap, from the outside, with the message the portal shows in amber. */
  it('REFUSES the sixth upload with the cap message and stores no file', async () => {
    const { token } = await makeBooking();
    const app = createApp();
    for (let i = 0; i < RECEIPT_UPLOAD_MAX_PER_BOOKING; i += 1) {
      const res = await upload(app, token, { ...META, txnRef: `GC000000000${i}` });
      expect(res.status, `upload ${i + 1} was refused`).toBe(200);
    }

    const before = await storedFiles();
    const res = await upload(app, token, { ...META, txnRef: 'GC9999999999' });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/five receipts/i);
    expect(String(res.body.error), 'the cap message must offer a way forward').toMatch(
      /message us/i,
    );
    expect(await storedFiles(), 'a capped upload left a file behind').toBe(before);
  });

  it('REFUSES an upload against a booking that is already paid', async () => {
    const { token } = await makeBooking({ status: 'confirmed' });
    const res = await upload(createApp(), token, META);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already paid/i);
  });

  /**
   * §11's two emails: one to the guest, one to the business inbox
   * (`settings.contact.email`, not a new environment variable). The admin
   * notice carries no guest contact details — `notify.test.ts` pins that;
   * here it is enough that it went to the business address and not to the
   * guest's.
   */
  it('emails the guest and the business inbox', async () => {
    const { token, leadEmail } = await makeBooking();
    await upload(createApp(), token, META);

    expect(sent).toHaveLength(2);
    expect(sent[0]!.to).toBe(leadEmail);
    expect(sent[0]!.subject).toMatch(/received your receipt/i);
    expect(sent[1]!.to).not.toBe(leadEmail);
    expect(sent[1]!.subject).toMatch(/verify/i);
  });

  /**
   * §11: "failures never block the booking flow". A mail server that
   * refuses everything must not turn a recorded receipt into an error the
   * guest sees — the row is already committed, and telling them it failed
   * would have them upload it again.
   *
   * **Two independent layers hold this**, which is worth knowing because it
   * is why no single mutation reddens this test: `notify()` cannot throw,
   * and `sendReceiptNotices()` wraps the whole thing again (the READ before
   * the send can fail too). It was proved by removing BOTH — the upload
   * then 500s on a committed receipt. Belt and braces, with a test that
   * notices if someone removes the belt and the braces together.
   */
  it('still answers 200 when the mail transport throws', async () => {
    setTransportForTests({
      sendMail: async () => {
        throw new Error('SMTP is down');
      },
    });
    const { token, bookingId } = await makeBooking();

    const res = await upload(createApp(), token, META);

    expect(res.status, 'a dead mail server failed an upload that had already been recorded').toBe(
      200,
    );
    expect(await receiptsOf(bookingId)).toHaveLength(1);
  });

  /**
   * The per-IP limiter, mounted on the route. Successes count here, unlike
   * the login limiters: what is being limited is 5MB of body and a disk
   * write, which a successful upload spends just as much of.
   */
  it('limits uploads per IP', async () => {
    const app = createApp();
    let last = 0;
    for (let i = 0; i < RECEIPT_UPLOAD_MAX_PER_IP + 1; i += 1) {
      // A fresh booking each time, so the per-booking cap is not what
      // answers — this test is about the IP limit and must not pass for the
      // wrong reason.
      const { token } = await makeBooking();
      last = (await upload(app, token, { ...META, txnRef: `GC100000000${i}` })).status;
    }
    expect(last, 'the eleventh upload from one IP was not limited').toBe(429);
  });
});
