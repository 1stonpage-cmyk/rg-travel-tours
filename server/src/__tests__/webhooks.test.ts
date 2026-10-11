/**
 * Task 15 of the core-schema plan: `POST /api/webhooks/:provider`, the only
 * internet-facing path that can move money.
 *
 * **Every assertion here counts rows in `payments` and `payment_events`.**
 * A webhook test that checks `res.status` alone passes happily while money
 * moves — a 400 with a payment row behind it is the exact failure this
 * suite exists to catch, and the status code is the one thing that cannot
 * see it.
 *
 * So the row counts are asserted BEFORE the status code in every test
 * below, deliberately. A guard that stops working then reports itself as
 * "a bad-signature webhook created a payment" rather than as "expected 400,
 * got 200" — the first sentence is the bug, the second is a symptom.
 *
 * The counts are SCOPED to the fixtures this file creates (one booking id,
 * one event id per test) rather than `SELECT id FROM payments` over the
 * whole table. The suite shares one live `rg_travel_test` database with
 * every other file, and a global count would be asserting other files'
 * teardown rather than this route's behaviour. Scoping costs nothing in
 * strength: each fixture is unique to its test, so a guard that stops
 * working puts a row exactly where the scoped count is looking.
 *
 * **How the PayMongo placeholder is handled.** `services/payments/paymongo.ts`
 * is still a stub whose every method throws — Task 16 writes the real one —
 * so there is no signature to verify yet and `getProvider('paymongo')`
 * would answer every request here with a 503. Rather than sketch half a
 * PayMongo verifier (which is Task 16's security-critical work, not this
 * task's), the registry is mocked so `paymongo` resolves to the test double
 * below: a provider with its OWN hand-rolled HMAC scheme that resembles no
 * real gateway. The mock DELEGATES to the real registry for every other
 * name, so the `xendit` and `manual` cases exercise the genuine article,
 * and the route, the mount order in `app.ts` and the raw-body parser under
 * test are all the real ones. If the mock ever stopped intercepting, the
 * signed cases would get the stub's 503 and go red — it fails closed.
 *
 * Fixtures are COMMITTED and torn down by id in `afterAll`, for the reason
 * `record-payment.test.ts` spells out: `recordPayment()` opens its own
 * transaction on its own pooled connection, so a booking left inside an
 * uncommitted transaction is a booking the route cannot see. The seed has
 * no bookings at all, so each test builds its own.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import type {
  ParsedPaymentEvent,
  PaymentMethod,
  PaymentProvider,
} from '../services/payments/types';

/** Not a key for anything. No live gateway credential is used in this suite. */
const STUB_SECRET = 'test-only-webhook-secret';
const SIGNATURE_HEADER = 'x-stub-signature';

const sign = (body: string): string => createHmac('sha256', STUB_SECRET).update(body).digest('hex');

/** The shape the test double's `parseEvent` reads. Resembles no real gateway. */
interface StubEventBody {
  id: string;
  type: string;
  outcome: ParsedPaymentEvent['outcome'];
  bookingRef: string | null;
  amountCentavos: number | null;
  providerRef: string | null;
  providerStatus: string | null;
  method: PaymentMethod | null;
}

/**
 * The provider the route sees for `paymongo` in this file.
 *
 * `verifyWebhook` is deliberately strict in the way the interface demands:
 * no header, wrong length and mismatch are all `false`. It is a test
 * double — Task 16 writes the real verifier against PayMongo's documented
 * scheme.
 */
const stubProvider: PaymentProvider = {
  name: 'paymongo',
  createCheckout: () => Promise.reject(new Error('not used by this suite')),
  refund: () => Promise.reject(new Error('not used by this suite')),
  verifyWebhook: (rawBody, headers) => {
    const offered = headers[SIGNATURE_HEADER];
    if (!offered) return false;
    const expected = sign(rawBody.toString('utf8'));
    if (offered.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
  },
  parseEvent: (rawBody) => {
    const body = JSON.parse(rawBody.toString('utf8')) as StubEventBody;
    return {
      providerEventId: body.id,
      providerType: body.type,
      outcome: body.outcome,
      bookingRef: body.bookingRef,
      amountCentavos: body.amountCentavos,
      providerRef: body.providerRef,
      providerStatus: body.providerStatus,
      method: body.method,
    };
  },
};

vi.mock('../services/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payments/registry')>();
  return {
    ...actual,
    getProvider: (name: string) =>
      name === 'paymongo' ? stubProvider : actual.getProvider(name as never),
  };
});

const { createApp } = await import('../app');
const app = createApp();

/**
 * True once the payments migrations have run against `rg_travel_test`, and
 * false when MySQL is unreachable — the same runtime probe the sibling
 * suites use, so a missing migration reports as SKIPPED rather than
 * silently passing.
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

const ready =
  (await tableExists('payments')) &&
  (await tableExists('payment_events')) &&
  (await tableExists('bookings'));
const dbIt = ready ? it : it.skip;

/** Every id this file committed, so `afterAll` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  eventIds: [] as string[],
};

let eventCounter = 0;
/** A provider event id unique to this run, so the scoped counts below are exact. */
function nextEventId(): string {
  eventCounter += 1;
  const id = `evt_wh15_${Date.now()}_${eventCounter}_${Math.floor(Math.random() * 1e6)}`;
  created.eventIds.push(id);
  return id;
}

/** A committed booking awaiting its first payment, plus the rows its FKs need. */
async function seedBooking(
  totalCentavos: number,
  payMode: 'full' | 'deposit' = 'full',
): Promise<{ bookingId: number; ref: string }> {
  const db = getDb();
  const unique = `__wh15__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const [destination] = await db.insert(destinations).values({ name: unique, slug: unique });
  created.destinationIds.push(destination.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug: unique, title: unique, destinationId: destination.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date('2099-12-25T00:00:00Z'),
    pax: 2,
    leadName: 'Webhook Fixture',
    leadEmail: 'fixture@example.test',
    leadPhone: '09170000000',
    status: 'pending_payment',
    payMode,
    priceSnapshot: {
      tier: {
        tierId: 1,
        minPax: 1,
        maxPax: 6,
        pricePerPersonCentavos: Math.floor(totalCentavos / 2),
      },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: totalCentavos,
      discountCentavos: 0,
      totalCentavos,
    },
    subtotalCentavos: totalCentavos,
    totalCentavos,
    amountPaidCentavos: 0,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref };
}

type Statement = Parameters<ReturnType<typeof getDb>['execute']>[0];

async function scalar(statement: Statement): Promise<number> {
  const [result] = (await getDb().execute(statement)) as unknown as [{ c: number }[], unknown];
  return Number(result[0]?.c ?? -1);
}

/** THE assertion of this suite: how many payment rows exist for this booking. */
const paymentRowCount = (bookingId: number) =>
  scalar(sql`SELECT COUNT(*) c FROM payments WHERE booking_id = ${bookingId}`);

/** And: did this event get stored at all. */
const eventRowCount = (providerEventId: string) =>
  scalar(sql`SELECT COUNT(*) c FROM payment_events WHERE provider_event_id = ${providerEventId}`);

const unprocessedEventCount = (providerEventId: string) =>
  scalar(
    sql`SELECT COUNT(*) c FROM payment_events
        WHERE provider_event_id = ${providerEventId} AND processed_at IS NULL`,
  );

const bookingRow = async (bookingId: number) => {
  const [result] = (await getDb().execute(
    sql`SELECT status, amount_paid_centavos FROM bookings WHERE id = ${bookingId}`,
  )) as unknown as [{ status: string; amount_paid_centavos: number }[], unknown];
  const row = result[0];
  if (!row) throw new Error('the fixture booking is not there');
  return row;
};

/** A body a gateway would send for a successful payment on `ref`. */
function paidBody(overrides: Partial<StubEventBody> & { bookingRef: string }): StubEventBody {
  return {
    id: nextEventId(),
    type: 'stub.payment.paid',
    outcome: 'paid',
    amountCentavos: 150000,
    providerRef: 'pi_stub_ref',
    providerStatus: 'paid',
    method: 'gcash',
    ...overrides,
  };
}

/** POST it the way a gateway would: exact bytes, signature over those bytes. */
function deliver(provider: string, body: StubEventBody, signature?: string) {
  const raw = JSON.stringify(body);
  const req = request(app)
    .post(`/api/webhooks/${provider}`)
    .set('Content-Type', 'application/json');
  if (signature !== undefined) req.set(SIGNATURE_HEADER, signature);
  return req.send(raw);
}

/** Correctly signed — used where the test is about something OTHER than the signature. */
const deliverSigned = (provider: string, body: StubEventBody) =>
  deliver(provider, body, sign(JSON.stringify(body)));

describe('POST /api/webhooks/:provider', () => {
  afterAll(async () => {
    if (!ready) return;
    const pool = getPool();
    for (const bookingId of created.bookingIds) {
      // Audit rows first: `entity_id` points at payments, so they have to go
      // while the payment ids are still readable.
      await pool.query(
        "DELETE FROM audit_log WHERE entity = 'payments' AND entity_id IN " +
          '(SELECT id FROM payments WHERE booking_id = ?)',
        [bookingId],
      );
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [bookingId]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [bookingId]);
    }
    for (const tourId of created.tourIds) {
      await pool.query('DELETE FROM tours WHERE id = ?', [tourId]);
    }
    for (const destinationId of created.destinationIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [destinationId]);
    }
    // Exactly the event ids this file minted, and nothing else.
    for (const eventId of created.eventIds) {
      await pool.query('DELETE FROM payment_events WHERE provider_event_id = ?', [eventId]);
    }
  });

  /**
   * A typo in a webhook URL must not route money through whichever gateway
   * happens to be first in the registry. The body sent here is a VALID,
   * correctly signed paid event for a real booking — so if the unknown name
   * resolved to anything at all, the row counts below would find a payment.
   */
  dbIt('rejects an unknown provider before the body is read', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliverSigned('stripe', body);

    expect(await paymentRowCount(bookingId), 'an unknown provider created a payment').toBe(0);
    expect(await eventRowCount(body.id), 'an unknown provider stored an event').toBe(0);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/paymongo|xendit/i);
  });

  /**
   * The one control between the internet and a booking marked paid. The
   * status code is the least interesting assertion in this test.
   */
  dbIt('rejects a bad signature with 400 and records nothing', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliver('paymongo', body, 'nonsense');

    expect(await paymentRowCount(bookingId), 'a bad-signature webhook created a payment').toBe(0);
    expect(await eventRowCount(body.id), 'a bad-signature event was stored').toBe(0);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(Number(booking.amount_paid_centavos)).toBe(0);
    expect(res.status).toBe(400);
  });

  /** A missing signature header is the same answer as a wrong one. */
  dbIt('rejects a missing signature header with 400 and records nothing', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliver('paymongo', body);

    expect(await paymentRowCount(bookingId), 'an unsigned webhook created a payment').toBe(0);
    expect(await eventRowCount(body.id), 'an unsigned event was stored').toBe(0);
    expect(res.status).toBe(400);
  });

  /**
   * The gateway retries until it gets a 2xx, so the same event arrives more
   * than once. The `(provider, provider_event_id)` unique index is the gate,
   * and the assertion that matters is that the booking was paid ONCE.
   */
  dbIt('is idempotent: the same event delivered twice pays exactly once', async () => {
    /*
     * A DEPOSIT booking, on purpose, and it is the whole point of the
     * fixture. On a pay-in-full booking Task 14's overpay check would
     * refuse a second payment on its own — ₱1,500 paid twice exceeds a
     * ₱1,500 total — so the test would stay green even with the idempotency
     * gate removed, and would be proving Task 14's lock rather than this
     * route's. A 30% deposit of ₱450 on a ₱1,500 total leaves room for a
     * second ₱450 to land, so here the unique index really is the only
     * thing between one payment and two.
     */
    const { bookingId, ref } = await seedBooking(150000, 'deposit');
    const body = paidBody({ bookingRef: ref, amountCentavos: 45000 });

    const first = await deliverSigned('paymongo', body);
    const second = await deliverSigned('paymongo', body);

    expect(await paymentRowCount(bookingId), 'a duplicate webhook created a second payment').toBe(
      1,
    );
    expect(await eventRowCount(body.id), 'the replay stored a second event row').toBe(1);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('confirmed');
    // Paid once, not twice: the amount is the proof the second delivery did
    // not reach `recordPayment()`.
    expect(Number(booking.amount_paid_centavos)).toBe(45000);
    expect(first.status).toBe(200);
    // An ack, so the gateway stops retrying.
    expect(second.status).toBe(200);
  });

  /**
   * Xendit is planned, not enabled (B1a): every method of the real stub
   * throws. A provider that is switched off is OUR misconfiguration, not a
   * forged request — 503 — and it must never be able to mark anything paid.
   */
  dbIt('cannot mark anything paid through the Xendit stub', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliverSigned('xendit', body);

    expect(await paymentRowCount(bookingId), 'the disabled provider recorded a payment').toBe(0);
    expect(await eventRowCount(body.id), 'the disabled provider stored an event').toBe(0);
    expect(res.status).toBe(503);
  });

  /**
   * `manual` is a valid `payments.provider` and a valid `ProviderName`, and
   * it is NOT a webhook provider: a QR transfer an admin verified by hand
   * has no gateway, no secret and no event. It must 404, not 500.
   */
  dbIt('refuses `manual`, which is a provider but not a gateway', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliverSigned('manual', body);

    expect(await paymentRowCount(bookingId), '`manual` recorded a payment').toBe(0);
    expect(await eventRowCount(body.id), '`manual` stored an event').toBe(0);
    expect(res.status).toBe(404);
  });

  /**
   * `payments.method` is NOT NULL, and an event that does not say which
   * instrument the guest used cannot be recorded without inventing one.
   * Fails closed: the event is kept, unprocessed, for reconciliation, and no
   * money lands.
   */
  dbIt('refuses a paid event that does not say which instrument was used', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref, method: null });

    const res = await deliverSigned('paymongo', body);

    expect(await paymentRowCount(bookingId), 'an event with no method recorded a payment').toBe(0);
    // Stored but NOT stamped: a null `processed_at` is what makes it
    // reconcilable instead of lost.
    expect(await eventRowCount(body.id)).toBe(1);
    expect(await unprocessedEventCount(body.id), 'an unapplied event was marked processed').toBe(1);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });

  /**
   * An outcome that moved no money is stored, stamped and acknowledged —
   * `recordPayment()` is never called, so there is nothing to refuse.
   */
  dbIt('acknowledges a failed payment event without recording one', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref, outcome: 'failed', type: 'stub.payment.failed' });

    const res = await deliverSigned('paymongo', body);

    expect(await paymentRowCount(bookingId), 'a failed event recorded a payment').toBe(0);
    expect(await eventRowCount(body.id)).toBe(1);
    expect(await unprocessedEventCount(body.id), 'a handled event was left unprocessed').toBe(0);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(res.status).toBe(200);
  });

  /** The response body never names a provider, an amount or an error. */
  dbIt('answers a verified event with a bare ok and nothing else', async () => {
    const { bookingId, ref } = await seedBooking(150000);
    const body = paidBody({ bookingRef: ref });

    const res = await deliverSigned('paymongo', body);

    expect(await paymentRowCount(bookingId), 'the verified event did not pay the booking').toBe(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(JSON.stringify(res.body)).not.toMatch(/paymongo|150000|pi_stub_ref|RG-/i);
  });
});
