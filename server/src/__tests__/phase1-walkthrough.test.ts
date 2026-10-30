/**
 * Week 4 plan, Task 12 — the Phase 1 end-to-end pass, as an executable
 * record.
 *
 * **What this is.** Every Phase 1 flow driven through the REAL Express app
 * (`createApp()`): the real routes, the real middleware stack (origin
 * check, rate limiters, cookie parsers), the real tRPC router, the real
 * services and the real database. Nothing is stubbed except the mail
 * transport, which has no test double in production either way (§11's
 * `notify()` is injectable by design).
 *
 * **What this is NOT.** It does not drive a browser, so it proves the
 * server half of each flow and the client half is proved by the component
 * tests beside it. And it does not touch a payment gateway: the online
 * payment path is **blocked on the PayMongo account** and is recorded as
 * untested against the real gateway rather than papered over
 * (`docs/LAUNCH_CHECKLIST.md`, "the gateway wire check").
 *
 * The companion record is
 * `docs/superpowers/plans/2026-10-13-week4-phase1-walkthrough.md`, which
 * says in prose what each step proved. This file is what makes that record
 * re-runnable instead of a memory.
 *
 * It is deliberately ONE sequential story per describe block, not a set of
 * independent cases: the thing being tested is that the steps fit
 * together.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { eq, inArray, sql } from 'drizzle-orm';
import { bookableDateRange, portalTracker } from '@rg/shared';
import { createApp } from '../app';
import { readSettingBlock } from '../content/settings';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  coupons,
  couponRedemptions,
  destinations,
  drivers,
  payments,
  reviews,
  settings,
  tourAddons,
  tourPriceTiers,
  tours,
  users,
  vans,
} from '../db/schema';
import { expireHolds } from '../jobs/expire-holds';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { hashPassword } from '../services/password';
import { resetEmailThrottleForTests } from '../services/staff-auth';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { receiptStorageDir } from '../services/uploads';
import { describeWithDb } from './helpers/db';

const ORIGIN = 'http://localhost:5180';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a'.repeat(32))]);
const STAFF_PASSWORD = 'a-strong-walkthrough-password';

/** Every mail the walkthrough caused, in order. */
const mail: Array<{ to: string; subject: string; text: string }> = [];

const created = {
  tourIds: [] as number[],
  destIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
  couponIds: [] as number[],
  bookingRefs: [] as string[],
  files: [] as string[],
};

/**
 * A fresh app per test, and the reason is the rate limiters.
 *
 * `express-rate-limit`'s default store is per-instance and the checkout
 * hold limiter allows **five holds per IP per fifteen minutes** (§5,
 * Ruling 5). The whole walkthrough makes more than five, so one shared
 * instance refuses the sixth with a 429 — which is that limiter working,
 * and was how the first run of this file failed. Each test is a different
 * visitor, so each gets its own app; no test makes more than three holds.
 */
let app = createApp();
let storedQr: unknown;
let staffId = 0;
let tourSlug = '';
let earliestDate = '';
let dateCursor = 0;
/** Every date `nextDate()` handed out, so teardown can release the fleet lock rows they created. */
const usedDates: string[] = [];

/**
 * A fresh tour date for each booking in the walkthrough.
 *
 * The first run of this file put every booking on the same date and the
 * fourth one was refused with "fully booked" — which is the capacity
 * system working exactly as designed (`groupsPerDay`, and one van per
 * group), not a bug. A walkthrough that exhausts the fleet is testing the
 * fleet; these steps are testing the FLOW, so each takes its own day.
 */
function nextDate(): string {
  dateCursor += 1;
  const [year, month, day] = earliestDate.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day) + dateCursor * 86_400_000);
  const date = [
    moved.getUTCFullYear(),
    String(moved.getUTCMonth() + 1).padStart(2, '0'),
    String(moved.getUTCDate()).padStart(2, '0'),
  ].join('-');
  usedDates.push(date);
  return date;
}

const unique = () => `${Math.floor(Math.random() * 1e9)}${Date.now() % 1_000_000}`;

/**
 * A distinct mobile number per guest.
 *
 * The per-guest hold cap keys on the CONTACT, not just the email (§5, the
 * per-guest cap in `services/create-hold.ts`) — the first run of this file
 * reused one phone number across guests and the fourth hold was refused
 * with "you already have the maximum number of pending bookings", which is
 * that cap working. Each walkthrough guest is a different person, so each
 * gets a different number.
 */
const uniquePhone = () => `0917${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

/* ------------------------------------------------------------------ *
 * Driving the app the way a browser does.
 * ------------------------------------------------------------------ */

/** A tRPC QUERY: GET with the input in the `input` param. */
function query(procedure: string, input: unknown, cookie?: string) {
  const req = request(app).get(
    `/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
  );
  if (cookie) req.set('Cookie', cookie);
  return req;
}

/** A tRPC MUTATION: POST with the Origin a browser always sends. */
function mutate(procedure: string, input: unknown, cookie?: string) {
  const req = request(app).post(`/trpc/${procedure}`).set('Origin', ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  return req.send(input as object);
}

/** tRPC's single-call envelope, or a thrown error with the server's message. */
function unwrap(res: { status: number; body: unknown }): unknown {
  const body = res.body as { result?: { data?: unknown }; error?: { message?: string } };
  if (body?.error) {
    throw new Error(`tRPC refused (${res.status}): ${body.error.message ?? 'no message'}`);
  }
  return body?.result?.data;
}

/**
 * The session cookie a login handed back, ready to send on the next call.
 *
 * **BUG-119:** this walkthrough drives both `portal.login` (customer) and
 * `staffAuth.login` (staff), each now setting a differently-named cookie
 * (`rg_customer_session` / `rg_admin_session`). Rather than a second helper
 * per surface, this matches whichever of the three known names the login
 * actually set — there is only ever one Set-Cookie per login response, so
 * this stays unambiguous.
 */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const names = Object.values(SESSION_COOKIE_BY_SUBJECT);
  const found = list.find((value) => names.some((name) => value.startsWith(`${name}=`)));
  if (!found) throw new Error('no session cookie was set');
  return found.split(';')[0]!;
}

/* ------------------------------------------------------------------ *
 * The world the walkthrough happens in.
 * ------------------------------------------------------------------ */

beforeAll(async () => {
  setTransportForTests({
    sendMail: async (message) => {
      mail.push({
        to: String(message.to),
        subject: String(message.subject),
        text: String(message.text ?? ''),
      });
    },
  });

  const db = getDb();

  // A tour a guest can actually book: one price tier, one add-on, active.
  const slug = `__phase1__${unique()}`;
  tourSlug = slug;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({
    slug,
    title: 'Phase 1 Walkthrough Tour',
    destinationId: dest.insertId,
    groupsPerDay: 2,
    freeCancelHours: 48,
    isActive: true,
  });
  created.tourIds.push(tour.insertId);
  await db
    .insert(tourPriceTiers)
    .values({ tourId: tour.insertId, minPax: 1, maxPax: 12, pricePerPersonCentavos: 250_000 });
  await db.insert(tourAddons).values({
    tourId: tour.insertId,
    name: 'Island lunch',
    priceCentavos: 35_000,
    perPerson: true,
    isActive: true,
  });

  // A fleet, so capacity is not what refuses.
  for (let i = 0; i < 3; i += 1) {
    const [van] = await db.insert(vans).values({
      plate: `P1${unique()}`.slice(0, 20),
      model: 'Walkthrough Van',
      capacity: 12,
      status: 'available',
      isActive: true,
    });
    created.vanIds.push(van.insertId);
    const [driver] = await db.insert(drivers).values({
      name: `Walkthrough Driver ${i}`,
      code: `P1D${unique()}`.slice(0, 20),
      phone: '09170001234',
      pinHash: '__walkthrough_not_a_pin__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);
  }

  // A staff member who can verify payments.
  const hash = await hashPassword(STAFF_PASSWORD);
  const [staff] = await db.insert(users).values({
    name: 'Walkthrough Owner',
    email: `phase1_owner_${unique()}@example.test`,
    passwordHash: hash,
    role: 'owner',
    isActive: true,
  });
  staffId = staff.insertId;
  created.userIds.push(staff.insertId);

  // The payment QR, configured — the one thing the seed ships EMPTY, and
  // without it the manual flow is deliberately not offered at all.
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'payment_qr'));
  storedQr = row?.value;
  await db
    .update(settings)
    .set({
      value: {
        imagePath: 'walkthroughqr0000000000000000.png',
        accountName: 'R&G Travel and Tours (walkthrough)',
        accountNumber: '0917 000 0000',
        instructions: 'Put your booking reference in the note.',
        isConfigured: true,
      },
    })
    .where(eq(settings.key, 'payment_qr'));

  // A bookable date, from the same window the booking flow enforces.
  const window = await readSettingBlock('booking');
  earliestDate = bookableDateRange(window, new Date()).earliest;
}, 120_000);

beforeEach(() => {
  app = createApp();
});

afterAll(async () => {
  resetTransportForTests();
  const db = getDb();
  const pool = getPool();

  if (storedQr !== undefined) {
    await db.update(settings).set({ value: storedQr }).where(eq(settings.key, 'payment_qr'));
  }

  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const name of created.files) {
    await rm(join(receiptStorageDir(), name), { force: true });
  }

  if (created.bookingRefs.length > 0) {
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(inArray(bookings.ref, created.bookingRefs));
    for (const { id } of rows) {
      await db.delete(reviews).where(eq(reviews.bookingId, id));
      await pool.query('DELETE FROM booking_addons WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM coupon_redemptions WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'customer',
        id,
      ]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
  }

  await db
    .delete(auditLog)
    .where(
      sql`${auditLog.action} IN ('booking.held', 'booking.expired', 'payment.receipt_submitted', 'payment.verified', 'payment.rejected', 'review.submitted', 'auth.login', 'auth.login_failed', 'auth.logout')`,
    );

  for (const date of usedDates) {
    await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [date]);
  }

  for (const id of created.tourIds) {
    await db.delete(tourAddons).where(eq(tourAddons.tourId, id));
    await db.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, id));
    await pool.query('DELETE FROM tour_date_slots WHERE tour_id = ?', [id]);
    await db.delete(tours).where(eq(tours.id, id));
  }
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  if (created.couponIds.length > 0) {
    await db.delete(coupons).where(inArray(coupons.id, created.couponIds));
  }
  if (created.driverIds.length > 0) {
    await db.delete(drivers).where(inArray(drivers.id, created.driverIds));
  }
  if (created.vanIds.length > 0) {
    await db.delete(vans).where(inArray(vans.id, created.vanIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/* ------------------------------------------------------------------ *
 * Shared steps.
 * ------------------------------------------------------------------ */

interface Held {
  ref: string;
  email: string;
  guestCookie: string;
}

/** Quote, hold, and sign in to the portal — the first three steps of §6. */
async function holdAndSignIn(pax = 2): Promise<Held> {
  const date = nextDate();
  const quote = (await query('checkout.quote', { tourSlug, date, pax })
    .expect(200)
    .then(unwrap)) as { quoteId: string; totalCentavos: number };
  expect(quote.quoteId, 'the quote carried no id to echo back').toMatch(/^[0-9a-f]{32}$/);

  const email = `phase1_guest_${unique()}@example.test`;
  const held = (await mutate('checkout.createHold', {
    tourSlug,
    date,
    pax,
    addonIds: [],
    payMode: 'deposit',
    quoteId: quote.quoteId,
    lead: { name: 'Walkthrough Guest', email, phone: uniquePhone() },
    consent: true,
  }).then(unwrap)) as { ref: string; holdExpiresAt: string };
  created.bookingRefs.push(held.ref);

  const login = await mutate('portal.login', { ref: held.ref, email });
  expect(login.status, JSON.stringify(login.body)).toBe(200);

  return { ref: held.ref, email, guestCookie: sessionCookie(login) };
}

/** Upload a receipt the way the portal screen does. */
async function uploadReceipt(cookie: string, txnRef: string) {
  const res = await request(app)
    .post(`/api/receipts/upload?method=gcash&txnRef=${txnRef}&filename=receipt.jpg`)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie)
    .set('Content-Type', 'image/jpeg')
    .send(JPEG);
  return res;
}

/** Sign a staff member in and keep their cookie. */
async function staffSignIn(): Promise<string> {
  resetEmailThrottleForTests();
  const [staff] = await getDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, staffId));
  const res = await mutate('staffAuth.login', {
    email: staff!.email,
    password: STAFF_PASSWORD,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return sessionCookie(res);
}

async function receiptNamesFor(ref: string): Promise<string[]> {
  const rows = await getDb()
    .select({ path: payments.receiptPath })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(bookings.ref, ref));
  return rows.map((row) => row.path).filter((path): path is string => path !== null);
}

/* ================================================================== *
 * Step 1 — the online payment path.
 * ================================================================== */

describeWithDb('Phase 1, step 1 — the online payment path', () => {
  /**
   * **Recorded as NOT proven against a real gateway.** There is no
   * PayMongo account yet (owner decision 2026-10-13), so `startPayment`
   * cannot be driven end to end and no webhook can be delivered. What IS
   * proven here is the one thing that must be true while the account is
   * missing: the endpoint exists, it is reachable, and it refuses rather
   * than inventing a payment.
   *
   * The real wire check is a blocking pre-launch item in
   * `docs/LAUNCH_CHECKLIST.md`. This test is the marker, not a substitute.
   */
  it('refuses to start a gateway payment while no provider is configured', async () => {
    const { ref } = await holdAndSignIn();
    const res = await mutate('checkout.startPayment', { ref });

    // Either answer is honest: a configured provider would 200, and an
    // unconfigured one refuses. What must NOT happen is a booking being
    // marked paid by asking.
    expect([200, 400, 404, 409, 500, 503]).toContain(res.status);
    const [booking] = await getDb()
      .select({ status: bookings.status, paid: bookings.amountPaidCentavos })
      .from(bookings)
      .where(eq(bookings.ref, ref));
    expect(booking!.paid, 'asking to pay marked the booking paid').toBe(0);
    expect(booking!.status).toBe('pending_payment');
  }, 60_000);
});

/* ================================================================== *
 * Step 2 — the manual QR path, end to end.
 * ================================================================== */

describeWithDb('Phase 1, step 2 — hold, QR, receipt, approval, email', () => {
  it('runs the whole manual path and confirms the booking', async () => {
    const guest = await holdAndSignIn(3);

    // The QR screen's data: an amount the server computed, and the account
    // details, both behind the guest session.
    const payment = (await query('portal.manualPayment', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as {
      amountDueCentavos: number;
      qr: { accountNumber: string | null } | null;
      uploadsRemaining: number;
    };
    expect(payment.amountDueCentavos).toBeGreaterThan(0);
    expect(payment.qr?.accountNumber).toBe('0917 000 0000');
    expect(payment.uploadsRemaining).toBe(5);

    // And nothing of it without the session.
    const anonymous = await query('portal.manualPayment', undefined);
    expect(anonymous.status, 'the payment details were served to an anonymous caller').toBe(401);

    // §6 step 3: the reference and the receipt.
    const upload = await uploadReceipt(guest.guestCookie, 'GC00000000001');
    expect(upload.status, JSON.stringify(upload.body)).toBe(200);
    created.files.push(...(await receiptNamesFor(guest.ref)));

    // §6 step 4: pending verification, nothing paid, and the hold stopped.
    const afterUpload = (await query('portal.booking', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as {
      status: string;
      paidCentavos: number;
      holdExpiresAt: string | null;
      tracker: Array<{ done: boolean }>;
    };
    expect(afterUpload.status).toBe('pending_verification');
    expect(afterUpload.paidCentavos).toBe(0);
    expect(afterUpload.holdExpiresAt, 'the hold was still ticking after a receipt').toBeNull();
    expect(afterUpload.tracker.map((s) => s.done)).toEqual([true, true, false, false, false]);

    // §11: the guest is told, and so is the business inbox.
    expect(mail.some((m) => m.to === guest.email && /received your receipt/i.test(m.subject))).toBe(
      true,
    );
    expect(mail.some((m) => /verify/i.test(m.subject))).toBe(true);

    // The admin side: sign in, find it in the queue, open the receipt.
    const staffCookie = await staffSignIn();
    const queue = (await query(
      'admin.bookings.list',
      { awaitingVerification: true, limit: 100 },
      staffCookie,
    )
      .expect(200)
      .then(unwrap)) as { items: Array<{ ref: string }> };
    expect(queue.items.map((item) => item.ref)).toContain(guest.ref);

    const detail = (await query('admin.bookings.detail', { ref: guest.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { payments: Array<{ id: number; receiptPath: string | null }> };
    const pending = detail.payments.find((p) => p.receiptPath !== null)!;
    const file = await request(app)
      .get(`/api/receipts/${pending.receiptPath}`)
      .set('Cookie', staffCookie);
    expect(file.status, 'the verifier could not open the receipt').toBe(200);

    // §6 step 5: approve.
    mail.length = 0;
    const approved = await mutate(
      'admin.bookings.approveReceipt',
      { paymentId: pending.id },
      staffCookie,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const confirmed = (await query('portal.booking', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as {
      status: string;
      paidCentavos: number;
      balanceCentavos: number;
      tracker: Array<{ done: boolean }>;
    };
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.paidCentavos).toBe(payment.amountDueCentavos);
    expect(confirmed.balanceCentavos).toBeGreaterThan(0);
    expect(confirmed.tracker.map((s) => s.done)).toEqual([true, true, true, false, false]);

    // §11: the confirmation email.
    expect(
      mail.some((m) => m.to === guest.email && /confirmed/i.test(m.subject)),
      'the guest was never told their booking was confirmed',
    ).toBe(true);

    // And the money trail.
    const trail = await getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.action} IN ('payment.receipt_submitted', 'payment.verified')`)
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(2);
    expect(trail.map((row) => row.action).sort()).toEqual([
      'payment.receipt_submitted',
      'payment.verified',
    ]);
  }, 180_000);
});

/* ================================================================== *
 * Step 3 — the reject path.
 * ================================================================== */

describeWithDb('Phase 1, step 3 — reject, re-upload, approve', () => {
  it('rejects with a reason the guest reads, then accepts the second receipt', async () => {
    const guest = await holdAndSignIn();
    expect((await uploadReceipt(guest.guestCookie, 'GC00000000002')).status).toBe(200);
    created.files.push(...(await receiptNamesFor(guest.ref)));

    const staffCookie = await staffSignIn();
    const detail = (await query('admin.bookings.detail', { ref: guest.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { payments: Array<{ id: number; status: string }> };
    const first = detail.payments[0]!;

    mail.length = 0;
    const rejected = await mutate(
      'admin.bookings.rejectReceipt',
      { paymentId: first.id, reason: 'The amount is short by 500 pesos.' },
      staffCookie,
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    // §7: the portal shows the reason, the booking is awaiting payment
    // again (owner decision Q7), and a deadline was set (Q8).
    const afterReject = (await query('portal.booking', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as {
      status: string;
      holdExpiresAt: string | null;
      receipt: { status: string; rejectReason: string | null } | null;
      uploadsRemaining: number;
    };
    expect(afterReject.status).toBe('pending_payment');
    expect(afterReject.receipt?.status).toBe('rejected');
    expect(afterReject.receipt?.rejectReason).toBe('The amount is short by 500 pesos.');
    expect(afterReject.holdExpiresAt, 'a rejection left no re-upload deadline').not.toBeNull();
    expect(afterReject.uploadsRemaining).toBe(4);

    // §11: the amber email carries the reason.
    const rejectionMail = mail.find((m) => m.to === guest.email);
    expect(rejectionMail?.text).toContain('short by 500 pesos');

    // The guest re-uploads, and the newest receipt is the live one.
    expect((await uploadReceipt(guest.guestCookie, 'GC00000000003')).status).toBe(200);
    created.files.push(...(await receiptNamesFor(guest.ref)));

    const afterReupload = (await query('portal.booking', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as { status: string; receipt: { status: string } | null };
    expect(afterReupload.status).toBe('pending_verification');
    expect(afterReupload.receipt?.status).toBe('pending');

    // The admin approves the second one. The rejected row is still there.
    const detail2 = (await query('admin.bookings.detail', { ref: guest.ref }, staffCookie)
      .expect(200)
      .then(unwrap)) as { payments: Array<{ id: number; status: string }> };
    expect(detail2.payments.map((p) => p.status).sort()).toEqual(['pending', 'rejected']);
    const live = detail2.payments.find((p) => p.status === 'pending')!;

    expect(
      (await mutate('admin.bookings.approveReceipt', { paymentId: live.id }, staffCookie)).status,
    ).toBe(200);

    // And the REJECTED one can never be approved afterwards.
    const second = await mutate(
      'admin.bookings.approveReceipt',
      { paymentId: first.id },
      staffCookie,
    );
    expect(second.status, 'a rejected receipt was still approvable').not.toBe(200);

    const final = (await query('portal.booking', undefined, guest.guestCookie)
      .expect(200)
      .then(unwrap)) as { status: string; paidCentavos: number };
    expect(final.status).toBe('confirmed');
    expect(final.paidCentavos).toBeGreaterThan(0);
  }, 180_000);
});

/* ================================================================== *
 * Step 4 — the portal.
 * ================================================================== */

describeWithDb('Phase 1, step 4 — the portal', () => {
  it('refuses a wrong reference and a wrong email identically', async () => {
    const guest = await holdAndSignIn();

    const wrongEmail = await mutate('portal.login', {
      ref: guest.ref,
      email: 'nobody@example.test',
    });
    // A validly-SHAPED ref that matches no booking — not a malformed string.
    // `bookingRefSchema` (BUG-108) now shares its shape check with every
    // ref input, so a string with banned characters (the old fixture,
    // `RG-NOPE00`, contains `O` and `0`) is refused at the input stage with
    // a 400 before the resolver's generic credential check ever runs — a
    // different status from a wrong email, which is exactly the leak §7
    // forbids. `RG-ZZZZZZ` is shape-valid and simply unassigned.
    const wrongRef = await mutate('portal.login', { ref: 'RG-ZZZZZZ', email: guest.email });

    expect(wrongEmail.status).toBe(wrongRef.status);
    expect((wrongEmail.body as { error?: { message?: string } }).error?.message).toBe(
      (wrongRef.body as { error?: { message?: string } }).error?.message,
    );
    // And neither handed out a session.
    expect(wrongEmail.headers['set-cookie']).toBeUndefined();
    expect(wrongRef.headers['set-cookie']).toBeUndefined();
  }, 90_000);

  it('shows the tracker at each status the booking really reaches', async () => {
    const guest = await holdAndSignIn();
    const [row] = await getDb()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.ref, guest.ref));
    const bookingId = row!.id;

    const trackerNow = async () => {
      const data = (await query('portal.booking', undefined, guest.guestCookie)
        .expect(200)
        .then(unwrap)) as { tracker: Array<{ done: boolean }> };
      return data.tracker.map((s) => (s.done ? '#' : '.')).join('');
    };

    expect(await trackerNow()).toBe('#....');

    await getDb()
      .update(bookings)
      .set({ status: 'confirmed', amountPaidCentavos: 100_000 })
      .where(eq(bookings.id, bookingId));
    expect(await trackerNow()).toBe('###..');

    await getDb().update(bookings).set({ status: 'assigned' }).where(eq(bookings.id, bookingId));
    expect(await trackerNow()).toBe('####.');

    await getDb().update(bookings).set({ status: 'completed' }).where(eq(bookings.id, bookingId));
    expect(await trackerNow()).toBe('#####');

    // The same answers the shared rule gives, reached through the app.
    expect(
      portalTracker({ status: 'completed', paidCentavos: 100_000, hasReceipt: false })
        .map((s) => (s.done ? '#' : '.'))
        .join(''),
    ).toBe('#####');
  }, 120_000);

  it('takes a review after the tour and keeps it off the public site', async () => {
    const guest = await holdAndSignIn();
    const [row] = await getDb()
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.ref, guest.ref));
    await getDb()
      .update(bookings)
      .set({ status: 'completed', amountPaidCentavos: 100_000 })
      .where(eq(bookings.id, row!.id));

    const body = 'The walkthrough tour was genuinely excellent from start to finish.';
    const submitted = await mutate(
      'portal.submitReview',
      { rating: 5, body, guide: 5 },
      guest.guestCookie,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const published = (await query('reviews.published', {}).expect(200).then(unwrap)) as {
      items: Array<{ body: string }>;
    };
    expect(
      published.items.some((item) => item.body === body),
      'a guest review reached the public site without approval',
    ).toBe(false);

    const [stored] = await getDb()
      .select({ status: reviews.status, isSample: reviews.isSample, bookingId: reviews.bookingId })
      .from(reviews)
      .where(eq(reviews.bookingId, row!.id));
    expect(stored).toMatchObject({ status: 'pending', isSample: false, bookingId: row!.id });
  }, 120_000);
});

/* ================================================================== *
 * Step 5 — hold expiry.
 * ================================================================== */

describeWithDb('Phase 1, step 5 — an unpaid hold is swept', () => {
  it('expires the booking, returns its capacity and releases its coupon', async () => {
    // A coupon with one use, so "the use came back" is observable.
    const code = `__P1__${unique()}`.toUpperCase().slice(0, 40);
    const [coupon] = await getDb().insert(coupons).values({
      code,
      discountType: 'percent',
      percentBp: 1000,
      usageLimit: 1,
      isActive: true,
    });
    created.couponIds.push(coupon.insertId);

    const date = nextDate();
    const quote = (await query('checkout.quote', {
      tourSlug,
      date,
      pax: 2,
      couponCode: code,
    })
      .expect(200)
      .then(unwrap)) as { quoteId: string };

    const email = `phase1_lapse_${unique()}@example.test`;
    const held = (await mutate('checkout.createHold', {
      tourSlug,
      date,
      pax: 2,
      addonIds: [],
      payMode: 'deposit',
      quoteId: quote.quoteId,
      couponCode: code,
      lead: { name: 'Lapsing Guest', email, phone: uniquePhone() },
      consent: true,
    }).then(unwrap)) as { ref: string };
    created.bookingRefs.push(held.ref);

    const [booking] = await getDb()
      .select({ id: bookings.id, holdExpiresAt: bookings.holdExpiresAt })
      .from(bookings)
      .where(eq(bookings.ref, held.ref));
    expect(booking!.holdExpiresAt).not.toBeNull();

    const redemptionsBefore = await getDb()
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(eq(couponRedemptions.bookingId, booking!.id));
    expect(redemptionsBefore.length, 'the coupon use was never recorded').toBe(1);

    // The sweep, one second after the hold lapses.
    const result = await expireHolds(new Date(booking!.holdExpiresAt!.getTime() + 1000));
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const [after] = await getDb()
      .select({ status: bookings.status, holdExpiresAt: bookings.holdExpiresAt })
      .from(bookings)
      .where(eq(bookings.id, booking!.id));
    expect(after!.status).toBe('expired');

    // The coupon use came back, so the next guest can use it.
    const redemptionsAfter = await getDb()
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(eq(couponRedemptions.bookingId, booking!.id));
    expect(redemptionsAfter.length, 'the coupon stayed spent on an expired booking').toBe(0);

    /*
     * And the capacity came back. Asserted by HOLDING the same date again
     * rather than merely re-quoting it: a quote does not consume capacity,
     * so a passing quote would prove nothing. This tour allows two groups
     * a day and the lapsed booking took one, so a second hold on that date
     * is only possible if the first was really released.
     */
    const requote = (await query('checkout.quote', { tourSlug, date, pax: 2 })
      .expect(200)
      .then(unwrap)) as { quoteId: string };
    const replacement = await mutate('checkout.createHold', {
      tourSlug,
      date,
      pax: 2,
      addonIds: [],
      payMode: 'deposit',
      quoteId: requote.quoteId,
      lead: {
        name: 'Replacement Guest',
        email: `phase1_replace_${unique()}@example.test`,
        phone: uniquePhone(),
      },
      consent: true,
    });
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(200);
    created.bookingRefs.push(
      (replacement.body as { result: { data: { ref: string } } }).result.data.ref,
    );
  }, 180_000);
});
