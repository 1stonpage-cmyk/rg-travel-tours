/**
 * Week 4 plan, Task 7 — `decideManualReceipt()`, §6 step 5.
 *
 * **The reject half did not exist in this codebase before this task.**
 * `verifyCashPayment()` only approved; `payments.reject_reason` was a column
 * nothing wrote. So the tests that matter most here are the rejection ones:
 * what the guest is told, how long they have, and that the capacity really
 * does come back when they do not act.
 *
 * Two properties are worth naming before the tests:
 *
 *  1. **Approval credits money exactly once.** Deciding twice is refused
 *     under the booking row lock, which is the only reason one transfer
 *     cannot be counted as two.
 *  2. **The expiry sweep needs no change at all** to release a rejected
 *     booking's seats. That is asserted by running the REAL sweep, not by
 *     reading `expire-holds.ts` and believing it.
 *
 * Fixtures are committed and torn down by id, for the reason
 * `record-payment.test.ts` sets out: these functions open their own
 * transactions on their own pooled connections. Teardown deletes
 * `bookings` and `payments` through raw SQL, never Drizzle's `.delete()`,
 * which is what `schema-conventions.test.ts` requires of a fixture.
 */
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  RECEIPT_REUPLOAD_WINDOW_MS,
  bookingCutoffInstant,
  manilaCivilDate,
  type BookingWindowSettings,
} from '@rg/shared';
import { readSettingBlock } from '../content/settings';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, payments, tours, users } from '../db/schema';
import { expireHolds } from '../jobs/expire-holds';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import { decideManualReceipt } from '../services/payments/manual-receipt';
import { recordManualReceipt } from '../services/payments/manual-receipt';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** A tour date far enough out that nothing here brushes a real cutoff. */
const TOUR_DATE = new Date('2099-12-25T00:00:00Z');
const TOTAL = 100_000;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

const sent: Array<{ to: string; subject: string; text: string }> = [];

beforeEach(() => {
  sent.length = 0;
  setTransportForTests({
    sendMail: async (mail) => {
      sent.push({
        to: String(mail.to),
        subject: String(mail.subject),
        text: String(mail.text ?? ''),
      });
    },
  });
});

afterEach(() => resetTransportForTests());

let windowSettings: BookingWindowSettings;
/** The instant the booking window closes for `TOUR_DATE`. */
let cutoff: Date;

async function settings(): Promise<BookingWindowSettings> {
  windowSettings ??= await readSettingBlock('booking');
  cutoff ??= bookingCutoffInstant(manilaCivilDate(TOUR_DATE), windowSettings);
  return windowSettings;
}

let seq = 0;

/** A booking with one pending receipt on it, through the real upload path. */
async function makeReceipt(): Promise<{
  bookingId: number;
  paymentId: number;
  ref: string;
  leadEmail: string;
}> {
  const db = getDb();
  const slug = `__decide__${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({ slug, title: slug, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const leadEmail = `decide_${slug}@example.test`;
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: TOUR_DATE,
    pax: 2,
    leadName: 'Decide Fixture',
    leadEmail,
    leadPhone: '09170000000',
    status: 'pending_payment',
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
    holdExpiresAt: new Date('2099-12-24T00:00:00Z'),
  });
  created.bookingIds.push(booking.insertId);

  seq += 1;
  const { paymentId } = await recordManualReceipt({
    bookingId: booking.insertId,
    method: 'gcash',
    txnRef: `GC${String(seq).padStart(10, '0')}`,
    receiptPath: `${seq.toString(16).padStart(32, 'd')}.jpg`,
    now: new Date('2026-10-14T06:00:00Z'),
  });
  return { bookingId: booking.insertId, paymentId, ref, leadEmail };
}

async function makeStaff(role: 'owner' | 'finance' | 'dispatcher') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Decide ${role} ${unique}`,
      email: `decide_${role}_${unique}@example.test`,
      passwordHash: '__decide_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/**
 * A REAL owner row, created once and reused.
 *
 * `payments.verified_by` is a genuine foreign key onto `users.id`, so an
 * invented id makes the approval UPDATE fail — which is how the first run
 * of this file failed, and the same trap `record-payment.test.ts`
 * documents for its cash fixtures.
 */
let ownerId = 0;
async function owner(): Promise<{ type: 'user'; id: number; role: string }> {
  if (ownerId === 0) ownerId = await makeStaff('owner');
  return { type: 'user', id: ownerId, role: 'owner' };
}

async function readPayment(paymentId: number) {
  const [row] = await getDb()
    .select({
      status: payments.status,
      rejectReason: payments.rejectReason,
      verifiedBy: payments.verifiedBy,
      verifiedAt: payments.verifiedAt,
      amountCentavos: payments.amountCentavos,
    })
    .from(payments)
    .where(eq(payments.id, paymentId));
  return row!;
}

async function readBooking(bookingId: number) {
  const [row] = await getDb()
    .select({
      status: bookings.status,
      paid: bookings.amountPaidCentavos,
      holdExpiresAt: bookings.holdExpiresAt,
      reviewRequired: bookings.paymentReviewRequired,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId));
  return row!;
}

async function lastAudit(action: string) {
  const [row] = await getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      entityId: auditLog.entityId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(sql`${auditLog.id} DESC`)
    .limit(1);
  return row;
}

afterAll(async () => {
  const pool = getPool();
  for (const id of created.bookingIds) {
    // Raw SQL for these two tables — see the file note.
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  await getDb()
    .delete(auditLog)
    .where(
      sql`${auditLog.action} IN ('payment.receipt_submitted', 'payment.rejected', 'payment.verified', 'booking.expired')`,
    );
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

describeWithDb('decideManualReceipt — approve', () => {
  it('marks the payment paid, credits the booking once and confirms it', async () => {
    const { bookingId, paymentId } = await makeReceipt();

    const result = await decideManualReceipt({
      paymentId,
      decision: 'approve',
      verifier: await owner(),
      now: new Date(),
    });

    expect(result.bookingStatus).toBe('confirmed');
    expect(result.reuploadBy, 'an approval set a re-upload deadline').toBeNull();

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('paid');
    expect(payment.verifiedBy).toBe((await owner()).id);
    expect(payment.verifiedAt, 'an approval nobody can date').not.toBeNull();

    const booking = await readBooking(bookingId);
    expect(booking.status).toBe('confirmed');
    expect(booking.paid).toBe(TOTAL);
    expect(booking.holdExpiresAt).toBeNull();
  });

  it('audits the approval against the admin who made it', async () => {
    const { paymentId, ref } = await makeReceipt();
    await decideManualReceipt({
      paymentId,
      decision: 'approve',
      verifier: await owner(),
      now: new Date(),
    });

    const row = await lastAudit('payment.verified');
    expect(row!.actorType).toBe('user');
    expect(Number(row!.actorId)).toBe((await owner()).id);
    expect(Number(row!.entityId)).toBe(paymentId);
    const data = JSON.stringify(row!.data);
    expect(data).toContain(ref);
    // The instrument the guest actually used, not a hardcoded 'cash'.
    expect(data).toContain('gcash');
  });

  /**
   * **The double-credit refusal.** One transfer must never be counted
   * twice: two admins working the queue, or one double-click, and the
   * booking total is wrong in the direction nobody notices.
   */
  it('REFUSES a second decision and credits nothing further', async () => {
    const { bookingId, paymentId } = await makeReceipt();
    await decideManualReceipt({
      paymentId,
      decision: 'approve',
      verifier: await owner(),
      now: new Date(),
    });

    await expect(
      decideManualReceipt({
        paymentId,
        decision: 'approve',
        verifier: await owner(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ name: 'ReceiptAlreadyDecidedError' });
    await expect(
      decideManualReceipt({
        paymentId,
        decision: 'reject',
        reason: 'changed my mind',
        verifier: await owner(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ name: 'ReceiptAlreadyDecidedError' });

    expect((await readBooking(bookingId)).paid, 'one transfer was credited twice').toBe(TOTAL);
  });

  /**
   * Owner decision 2026-10-14 (Q6): only the NEWEST receipt can be decided.
   * A superseded row is not `pending`, so it lands in the same refusal —
   * which is the rule enforced rather than described.
   */
  it('REFUSES a superseded receipt', async () => {
    const { bookingId, paymentId: first } = await makeReceipt();
    seq += 1;
    await recordManualReceipt({
      bookingId,
      method: 'maya',
      txnRef: `GC${String(seq).padStart(10, '0')}`,
      receiptPath: `${seq.toString(16).padStart(32, 'e')}.jpg`,
      now: new Date('2026-10-14T07:00:00Z'),
    });

    await expect(
      decideManualReceipt({
        paymentId: first,
        decision: 'approve',
        verifier: await owner(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ name: 'ReceiptAlreadyDecidedError' });
    expect((await readBooking(bookingId)).paid).toBe(0);
  });

  /**
   * §9: verifying payments is owner and finance. Every other actor is
   * refused by the service's own gate, not only by the tRPC role
   * middleware — a driver who could verify their own collection is §8's
   * central risk, and the same gate guards this door.
   */
  it('REFUSES every actor that may not verify payments', async () => {
    const { bookingId, paymentId } = await makeReceipt();
    const refused = [
      { type: 'user' as const, id: 1, role: 'dispatcher' },
      { type: 'driver' as const, id: 1, role: 'owner' },
      { type: 'system' as const, id: null, role: 'owner' },
      { type: 'provider' as const, id: null, role: 'owner' },
      { type: 'customer' as const, id: 1, role: 'owner' },
      { type: 'user' as const, id: 1, role: 'superuser' },
      { type: 'user' as const, id: null, role: 'owner' },
      { type: 'user' as const, id: 1, role: undefined },
    ];
    for (const verifier of refused) {
      await expect(
        decideManualReceipt({ paymentId, decision: 'approve', verifier, now: new Date() }),
        `${verifier.type}/${String(verifier.role)} approved a payment`,
      ).rejects.toMatchObject({ name: 'PaymentVerificationNotPermittedError' });
      await expect(
        decideManualReceipt({
          paymentId,
          decision: 'reject',
          reason: 'blurry',
          verifier,
          now: new Date(),
        }),
        `${verifier.type}/${String(verifier.role)} rejected a payment`,
      ).rejects.toMatchObject({ name: 'PaymentVerificationNotPermittedError' });
    }
    // And nothing moved.
    expect((await readPayment(paymentId)).status).toBe('pending');
    expect((await readBooking(bookingId)).paid).toBe(0);
  });

  it('accepts a FINANCE user as well as the owner', async () => {
    const { paymentId } = await makeReceipt();
    await expect(
      decideManualReceipt({
        paymentId,
        decision: 'approve',
        verifier: { type: 'user', id: await makeStaff('finance'), role: 'finance' },
        now: new Date(),
      }),
    ).resolves.toMatchObject({ bookingStatus: 'confirmed' });
  });
});

describeWithDb('decideManualReceipt — reject', () => {
  it('rejects with the reason and returns the booking to pending_payment', async () => {
    const { bookingId, paymentId } = await makeReceipt();
    const now = new Date('2026-11-01T02:00:00Z');

    const result = await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: '  The reference does not match any transfer we received.  ',
      verifier: await owner(),
      now,
    });

    expect(result.bookingStatus).toBe('pending_payment');

    const payment = await readPayment(paymentId);
    expect(payment.status).toBe('rejected');
    // Trimmed, because a reason of three spaces is a blank one.
    expect(payment.rejectReason).toBe('The reference does not match any transfer we received.');

    const booking = await readBooking(bookingId);
    // Owner decision Q7: awaiting payment again, NOT cancelled.
    expect(booking.status).toBe('pending_payment');
    expect(booking.paid, 'a rejection moved money').toBe(0);
    expect(
      booking.reviewRequired,
      'a rejection raised the review flag, which means money arrived',
    ).toBe(false);
    expect(booking.holdExpiresAt).not.toBeNull();
  });

  /**
   * **The Q8 deadline is the EARLIER of the two bounds**, and both branches
   * are asserted against the same tour date — a rejection far from the
   * cutoff gets its twelve hours, and one close to it gets only what is
   * left. A test that checked just one branch would pass against
   * `rejectedAt + 12h` with the cutoff bound deleted entirely.
   */
  it('gives twelve hours when the cutoff is far away', async () => {
    const window = await settings();
    void window;
    const { bookingId, paymentId } = await makeReceipt();
    const now = new Date(cutoff.getTime() - 30 * 3_600_000);

    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'blurry',
      verifier: await owner(),
      now,
    });

    const booking = await readBooking(bookingId);
    expect(booking.holdExpiresAt!.getTime()).toBe(now.getTime() + RECEIPT_REUPLOAD_WINDOW_MS);
  });

  it('never extends past the booking cutoff for the tour date', async () => {
    await settings();
    const { bookingId, paymentId } = await makeReceipt();
    // Four hours before the cutoff: twelve would overrun it by eight.
    const now = new Date(cutoff.getTime() - 4 * 3_600_000);

    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'blurry',
      verifier: await owner(),
      now,
    });

    const booking = await readBooking(bookingId);
    expect(
      booking.holdExpiresAt!.getTime(),
      'the re-upload window outlived the booking window for that tour date',
    ).toBe(cutoff.getTime());
    expect(booking.holdExpiresAt!.getTime()).toBeLessThan(
      now.getTime() + RECEIPT_REUPLOAD_WINDOW_MS,
    );
  });

  /** Rejected after the cutoff has already gone: the deadline is in the past. */
  it('leaves a deadline in the past when the cutoff has already passed', async () => {
    await settings();
    const { bookingId, paymentId } = await makeReceipt();
    const now = new Date(cutoff.getTime() + 3_600_000);

    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'blurry',
      verifier: await owner(),
      now,
    });

    expect((await readBooking(bookingId)).holdExpiresAt!.getTime()).toBe(cutoff.getTime());
  });

  it('audits the rejection with the actor and the reason', async () => {
    const { paymentId, ref } = await makeReceipt();
    const finance = await makeStaff('finance');

    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'The amount is short by 500 pesos.',
      verifier: { type: 'user', id: finance, role: 'finance' },
      now: new Date('2026-11-01T02:00:00Z'),
    });

    const row = await lastAudit('payment.rejected');
    expect(row!.actorType).toBe('user');
    expect(Number(row!.actorId), 'the trail cannot say who rejected it').toBe(finance);
    expect(Number(row!.entityId)).toBe(paymentId);
    const data = JSON.stringify(row!.data);
    expect(data).toContain(ref);
    expect(data).toContain('short by 500 pesos');
    expect(data).toContain('reuploadBy');
  });

  /**
   * An empty reason is refused, because the portal has nothing to show
   * otherwise — and whitespace is empty.
   */
  it('REFUSES a rejection with no reason, writing nothing', async () => {
    const { bookingId, paymentId } = await makeReceipt();
    for (const reason of [undefined, '', '   ', '\n\t']) {
      await expect(
        decideManualReceipt({
          paymentId,
          decision: 'reject',
          reason,
          verifier: await owner(),
          now: new Date(),
        }),
        `a rejection with ${JSON.stringify(reason)} as its reason was accepted`,
      ).rejects.toMatchObject({ name: 'ReceiptRejectionNeedsReasonError' });
    }
    expect((await readPayment(paymentId)).status).toBe('pending');
    expect((await readBooking(bookingId)).status).toBe('pending_verification');
  });

  it('REFUSES an id that is not a receipt row', async () => {
    await expect(
      decideManualReceipt({
        paymentId: 987_654_321,
        decision: 'reject',
        reason: 'blurry',
        verifier: await owner(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ name: 'ReceiptPaymentNotFoundError' });
  });

  /**
   * **The sweep needs no change, proved by running it.** A rejected booking
   * whose deadline has passed is an ordinary `pending_payment` hold with no
   * money against it, which is exactly what `expireHolds()` already
   * collects — so the whole of the Q8 capacity release is "set the status
   * and the deadline", and `jobs/expire-holds.ts` is untouched by this task.
   */
  it('is swept by the EXISTING expiry job once the deadline passes', async () => {
    await settings();
    const { bookingId, paymentId } = await makeReceipt();
    const rejectedAt = new Date(cutoff.getTime() - 30 * 3_600_000);
    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'blurry',
      verifier: await owner(),
      now: rejectedAt,
    });

    const deadline = (await readBooking(bookingId)).holdExpiresAt!;

    // A minute before the deadline: still the guest's to fix.
    await expireHolds(new Date(deadline.getTime() - 60_000));
    expect((await readBooking(bookingId)).status, 'the sweep took it early').toBe(
      'pending_payment',
    );

    // At the deadline itself.
    await expireHolds(deadline);
    expect(
      (await readBooking(bookingId)).status,
      'the sweep left a lapsed rejected booking holding a van seat',
    ).toBe('expired');
  });

  /**
   * And the sweep's money rule still wins. A rejected booking that is
   * flagged for review — money arrived late, an admin has to resolve it —
   * must NOT be expired out from under that review, which is the one
   * property `expire-holds.ts` was written to protect.
   */
  it('is NOT swept while it is flagged for payment review', async () => {
    await settings();
    const { bookingId, paymentId } = await makeReceipt();
    const rejectedAt = new Date(cutoff.getTime() - 30 * 3_600_000);
    await decideManualReceipt({
      paymentId,
      decision: 'reject',
      reason: 'blurry',
      verifier: await owner(),
      now: rejectedAt,
    });
    await getDb()
      .update(bookings)
      .set({ paymentReviewRequired: true })
      .where(eq(bookings.id, bookingId));

    const deadline = (await readBooking(bookingId)).holdExpiresAt!;
    await expireHolds(new Date(deadline.getTime() + 86_400_000));

    expect(
      (await readBooking(bookingId)).status,
      'the sweep expired a booking an admin was still reviewing',
    ).toBe('pending_payment');
  });
});

describeWithDb('admin.bookings.approveReceipt / rejectReceipt', () => {
  it('approves through the router and emails the guest', async () => {
    const { paymentId, leadEmail, ref } = await makeReceipt();
    const owner = await makeStaff('owner');
    const api = appRouter.createCaller(staffContext(owner, 'owner') as never);

    await expect(api.admin.bookings.approveReceipt({ paymentId })).resolves.toEqual({
      bookingStatus: 'confirmed',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(leadEmail);
    expect(sent[0]!.subject).toMatch(/confirmed/i);
    expect(sent[0]!.subject).toContain(ref);
  });

  it('rejects through the router and emails the REASON to the guest', async () => {
    const { paymentId, leadEmail } = await makeReceipt();
    const finance = await makeStaff('finance');
    const api = appRouter.createCaller(staffContext(finance, 'finance') as never);

    const result = await api.admin.bookings.rejectReceipt({
      paymentId,
      reason: 'The screenshot shows a different amount.',
    });

    expect(result.bookingStatus).toBe('pending_payment');
    expect(result.reuploadBy).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(leadEmail);
    expect(sent[0]!.text, 'the guest was not told why').toContain('different amount');
  });

  /**
   * A DISPATCHER runs the day; they do not decide that money arrived (§9).
   * `role-isolation.test.ts` asserts the matrix for every procedure; this
   * is the same rule at the procedure a dispatcher is most likely to try.
   */
  it('REFUSES a dispatcher, and writes nothing', async () => {
    const { bookingId, paymentId } = await makeReceipt();
    const dispatcher = await makeStaff('dispatcher');
    const api = appRouter.createCaller(staffContext(dispatcher, 'dispatcher') as never);

    await expect(api.admin.bookings.approveReceipt({ paymentId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      api.admin.bookings.rejectReceipt({ paymentId, reason: 'no' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect((await readPayment(paymentId)).status).toBe('pending');
    expect((await readBooking(bookingId)).paid).toBe(0);
    expect(sent, 'a refused decision still emailed the guest').toHaveLength(0);
  });

  it('REFUSES a request with no session at all', async () => {
    const { paymentId } = await makeReceipt();
    const api = appRouter.createCaller({ req: { cookies: {} }, res: {}, session: null } as never);
    await expect(api.admin.bookings.approveReceipt({ paymentId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  /**
   * A blank reason never reaches the service: Zod answers first, kindly.
   *
   * **Two layers hold this**, so no single mutation reddens it — the input
   * schema refuses it and `decideManualReceipt()` refuses it again. Proved
   * by removing both, after which a guest really is rejected with nothing
   * to read. Belt and braces, with a test that notices if someone removes
   * the belt and the braces together.
   */
  it('REFUSES a blank reason at the input boundary', async () => {
    const { paymentId } = await makeReceipt();
    const owner = await makeStaff('owner');
    const api = appRouter.createCaller(staffContext(owner, 'owner') as never);

    await expect(api.admin.bookings.rejectReceipt({ paymentId, reason: '   ' })).rejects.toThrow();
    expect((await readPayment(paymentId)).status).toBe('pending');
  });

  /**
   * §11: an email failure never blocks the flow. The payment is already
   * approved and committed by the time the transport is asked to send, so a
   * dead mail server must not turn it into an error — which would invite
   * the admin to click approve again.
   */
  it('still approves when the mail transport throws', async () => {
    setTransportForTests({
      sendMail: async () => {
        throw new Error('SMTP is down');
      },
    });
    const { bookingId, paymentId } = await makeReceipt();
    const owner = await makeStaff('owner');
    const api = appRouter.createCaller(staffContext(owner, 'owner') as never);

    await expect(api.admin.bookings.approveReceipt({ paymentId })).resolves.toEqual({
      bookingStatus: 'confirmed',
    });
    expect((await readBooking(bookingId)).paid).toBe(TOTAL);
  });

  /** Deciding a receipt someone else just decided reads as a CONFLICT. */
  it('answers a second decision with CONFLICT, not a 500', async () => {
    const { paymentId } = await makeReceipt();
    const owner = await makeStaff('owner');
    const api = appRouter.createCaller(staffContext(owner, 'owner') as never);

    await api.admin.bookings.approveReceipt({ paymentId });
    await expect(api.admin.bookings.approveReceipt({ paymentId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
