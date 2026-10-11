/**
 * Task 16b-4: ONE genuinely signed PayMongo event, driven through the real
 * route, into `recordPayment()`, until a booking is paid.
 *
 * **Why this file exists next to `webhooks.test.ts`.** That file tests the
 * ROUTE and deliberately mocks `paymongo` to a hand-rolled test double with
 * its own HMAC scheme — which means nothing in the suite ever proved that
 * the REAL provider's verification, the real `parseEvent`, the real raw-body
 * mount order and `recordPayment()` fit together. Each half was green on its
 * own: `paymongo-provider.test.ts` unit-tests the verifier with a fixture
 * secret, `record-payment.test.ts` calls the writer directly, and
 * `webhooks.test.ts` exercises the route past a double. The seam between
 * them was untested, and a seam is exactly where a signature check gets
 * bypassed.
 *
 * So everything below is real except two things, and both are named:
 *
 *  - **the webhook secret**, which is a test-only constant defined in this
 *    file and injected through `createPaymongoProvider({ webhookSecret })`,
 *    the seam `paymongo.ts` already exposes for its own unit tests
 *    (`config.webhookSecret ?? env.PAYMONGO_WEBHOOK_SECRET`). No secret is
 *    read from, written to or added to `.env`, `.env.example` or any other
 *    committed file, and `process.env` is never mutated.
 *  - **the HTTP transport**, replaced with a throw, so no test here can
 *    reach `api.paymongo.com`. The webhook path makes no outbound call at
 *    all; the stub is there so a future edit that adds one says so loudly.
 *
 * **The bridge, and why the real code still runs.** The route resolves its
 * provider through the registry, and the registry holds the env-backed
 * `paymongoProvider` singleton — which, in the test environment, has no
 * webhook secret and therefore (correctly) refuses every signature. So this
 * file mocks `getProvider` so that `paymongo` resolves to an instance built
 * by the REAL `createPaymongoProvider` factory from the real
 * `services/payments/paymongo.ts`, with the test-only secret passed in.
 * Nothing is reimplemented: `verifyWebhook` is the real
 * `verifyPaymongoSignature` (real header parsing, real `t.body` payload
 * construction, real HMAC-SHA256, real `timingSafeEqual`, real freshness
 * window) and `parseEvent` is the real `parsePaymongoEvent`. The first test
 * below pins that: the provider the route is handed must answer, case for
 * case, exactly what the real exported `verifyPaymongoSignature` answers —
 * so a future edit that quietly swaps a double back in goes red.
 *
 * **It fails closed if the mock stops intercepting:** the env-backed
 * singleton would answer `false` for every signature and every expected-200
 * case here would become a 400.
 *
 * Every assertion counts DATABASE ROWS before it looks at a status code. A
 * 400 with a payment row behind it is the failure this file exists to catch,
 * and the status code is the one thing that cannot see it.
 *
 * Fixtures are COMMITTED and torn down by id in `afterAll`:
 * `recordPayment()` opens its own transaction on its own pooled connection,
 * so a booking left inside an uncommitted transaction is a booking the route
 * cannot see. The seed has no bookings at all, so each test builds its own,
 * and the teardown deletes exactly the ids this file created.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tours } from '../db/schema';
import { generateBookingRef } from '../services/booking-ref';
import { verifyPaymongoSignature } from '../services/payments/paymongo';

/**
 * The test-only fixtures, in `vi.hoisted` so the `vi.mock` factory below —
 * which is hoisted above every import — can read them.
 *
 * `webhookSecret` is not a credential for anything and is not the shape of
 * any real key. It never leaves this process: it is handed to
 * `createPaymongoProvider` and used to compute digests in-process. Nothing
 * here reads or writes `.env`, and `process.env` is never mutated.
 *
 * `networkGuard` stands in for `fetch`. The webhook path opens no socket, so
 * nothing should reach it; if a future edit makes it, the suite says "a
 * webhook test tried to reach the network" instead of quietly contacting a
 * payment gateway.
 */
const fixtures = vi.hoisted(() => ({
  webhookSecret: 'whsk_test_16b4_not_a_real_secret',
  /** A different one, to prove the secret — not the scheme — is the gate. */
  otherSecret: 'whsk_test_16b4_a_different_secret',
  secretKey: 'sk_test_16b4_not_a_real_key',
  networkGuard: vi.fn((): never => {
    throw new Error('a webhook test tried to reach the network');
  }),
}));

/** PayMongo's real header name, lower-cased as Node delivers it. */
const SIGNATURE_HEADER = 'paymongo-signature';

/**
 * The bridge. The route resolves its provider through the registry, so the
 * registry is where the test-only secret has to arrive — and it arrives
 * through `createPaymongoProvider`, the REAL factory from the real file,
 * which already takes `config.webhookSecret ?? env.PAYMONGO_WEBHOOK_SECRET`
 * for its own unit tests. Nothing is reimplemented: `verifyWebhook` and
 * `parseEvent` on this instance are the genuine `verifyPaymongoSignature`
 * and `parsePaymongoEvent`.
 *
 * Every other provider name still goes to the real registry.
 */
vi.mock('../services/payments/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payments/registry')>();
  const { createPaymongoProvider } = await import('../services/payments/paymongo');
  const injected = createPaymongoProvider({
    webhookSecret: fixtures.webhookSecret,
    // Never used on the webhook path; present so a stray REST call fails on
    // the transport rather than on a missing-key error that would read like
    // a configuration problem.
    secretKey: fixtures.secretKey,
    fetchImpl: fixtures.networkGuard as unknown as typeof fetch,
  });
  return {
    ...actual,
    getProvider: (name: string) =>
      name === 'paymongo' ? injected : actual.getProvider(name as never),
  };
});

const { createApp } = await import('../app');
const { getProvider } = await import('../services/payments/registry');
const app = createApp();

/** The migrations have run against `rg_travel_test`, and MySQL is reachable. */
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
  (await tableExists('bookings')) &&
  (await tableExists('audit_log'));
const dbIt = ready ? it : it.skip;

/** Every id this file committed, so `afterAll` removes exactly those rows. */
const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destinationIds: [] as number[],
  eventIds: [] as string[],
};

/** The booking total, and therefore the only amount a full payment may be. */
const TOTAL_CENTAVOS = 189000;

let eventCounter = 0;
/** A provider event id unique to this run, so the scoped counts are exact. */
function nextEventId(): string {
  eventCounter += 1;
  const id = `evt_e2e16b4_${Date.now()}_${eventCounter}_${Math.floor(Math.random() * 1e6)}`;
  created.eventIds.push(id);
  return id;
}

/** A committed, pay-in-full booking awaiting its first payment. */
async function seedBooking(): Promise<{ bookingId: number; ref: string }> {
  const db = getDb();
  const unique = `__e2e16b4__${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
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
    pax: 1,
    leadName: 'Signed Webhook Fixture',
    leadEmail: 'fixture@example.test',
    leadPhone: '09170000000',
    status: 'pending_payment',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 6, pricePerPersonCentavos: TOTAL_CENTAVOS },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL_CENTAVOS,
      discountCentavos: 0,
      totalCentavos: TOTAL_CENTAVOS,
    },
    subtotalCentavos: TOTAL_CENTAVOS,
    totalCentavos: TOTAL_CENTAVOS,
    amountPaidCentavos: 0,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref };
}

/* -------------------------------------------------------------------------
 * The bodies. PayMongo's own envelope, written as TEXT.
 *
 * Built as strings rather than from objects because the signature is over
 * BYTES: `JSON.stringify` key order is not a promise worth signing, and a
 * body re-serialised after signing is the exact bug `express.raw` exists to
 * prevent. The field names and nesting are PayMongo's documented webhook
 * shape — `data.id` / `data.attributes.type` / `data.attributes.data` — and
 * include the fields PayMongo really sends and this codebase ignores
 * (`livemode`, `fee`, `net_amount`, `currency`), precisely so the body is
 * not a minimal object tailored to our own parser.
 * ---------------------------------------------------------------------- */

/** `payment.paid`: the event a GCash or card payment produces. */
function paymentPaidBody(eventId: string, ref: string, amount = TOTAL_CENTAVOS): string {
  return (
    `{"data":{"id":"${eventId}","type":"event","attributes":{"type":"payment.paid",` +
    `"livemode":false,"created_at":1760000000,"updated_at":1760000000,` +
    `"data":{"id":"pay_${eventId}","type":"payment","attributes":{"amount":${amount},` +
    `"currency":"PHP","status":"paid","description":"TravelSugbo booking ${ref}",` +
    `"fee":4914,"net_amount":${amount - 4914},"payment_method_used":"gcash",` +
    `"metadata":{"bookingRef":"${ref}"}}}}}}`
  );
}

/**
 * `checkout_session.payment.paid`: the other family, where the event's
 * resource is the SESSION and the payment sits inside `payments[]`. Included
 * because it is a shape only the real `parseEvent` knows how to read — a
 * parser written for the simple shape above returns a null amount here and
 * the route refuses the event.
 */
function checkoutSessionPaidBody(eventId: string, ref: string): string {
  return (
    `{"data":{"id":"${eventId}","type":"event","attributes":` +
    `{"type":"checkout_session.payment.paid","livemode":false,"created_at":1760000000,` +
    `"data":{"id":"cs_${eventId}","type":"checkout_session","attributes":` +
    `{"reference_number":"${ref}","checkout_url":"https://checkout.paymongo.com/cs_x",` +
    `"payment_method_types":["gcash","card"],"payments":[{"id":"pay_${eventId}",` +
    `"type":"payment","attributes":{"amount":${TOTAL_CENTAVOS},"currency":"PHP",` +
    `"status":"paid","payment_method_used":"gcash","fee":4914,` +
    `"net_amount":${TOTAL_CENTAVOS - 4914}}}]}}}}}`
  );
}

/**
 * PayMongo's real scheme: HMAC-SHA256 over `"<unix seconds>.<body>"`, hex,
 * presented as `t=<ts>,te=<digest>`. The timestamp is NOW, because the real
 * verifier enforces a five-minute freshness window — a golden digest over a
 * pinned timestamp is unit-testable (`paymongo-provider.test.ts` does
 * exactly that) but cannot travel through an HTTP route.
 */
function signLikePaymongo(
  bodyText: string,
  secret: string = fixtures.webhookSecret,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${bodyText}`).digest('hex');
  return `t=${timestamp},te=${digest}`;
}

/** POST the exact bytes, the way the gateway does. */
function deliver(bodyText: string, signature?: string) {
  const req = request(app).post('/api/webhooks/paymongo').set('Content-Type', 'application/json');
  if (signature !== undefined) req.set(SIGNATURE_HEADER, signature);
  return req.send(bodyText);
}

type Statement = Parameters<ReturnType<typeof getDb>['execute']>[0];

async function scalar(statement: Statement): Promise<number> {
  const [result] = (await getDb().execute(statement)) as unknown as [{ c: number }[], unknown];
  return Number(result[0]?.c ?? -1);
}

/** THE assertion of this suite: how many payment rows exist for this booking. */
const paymentRowCount = (bookingId: number) =>
  scalar(sql`SELECT COUNT(*) c FROM payments WHERE booking_id = ${bookingId}`);

const eventRowCount = (providerEventId: string) =>
  scalar(sql`SELECT COUNT(*) c FROM payment_events WHERE provider_event_id = ${providerEventId}`);

/** Audit rows written by the gateway for this booking's payments. */
const providerAuditCount = (bookingId: number) =>
  scalar(
    sql`SELECT COUNT(*) c FROM audit_log
        WHERE entity = 'payments' AND actor_type = 'provider'
          AND entity_id IN (SELECT id FROM payments WHERE booking_id = ${bookingId})`,
  );

const bookingRow = async (bookingId: number) => {
  const [result] = (await getDb().execute(
    sql`SELECT status, amount_paid_centavos FROM bookings WHERE id = ${bookingId}`,
  )) as unknown as [{ status: string; amount_paid_centavos: number }[], unknown];
  const row = result[0];
  if (!row) throw new Error('the fixture booking is not there');
  return row;
};

const paymentRow = async (bookingId: number) => {
  const [result] = (await getDb().execute(
    sql`SELECT provider, method, status, amount_centavos, provider_ref, provider_status
        FROM payments WHERE booking_id = ${bookingId}`,
  )) as unknown as [
    Array<{
      provider: string;
      method: string;
      status: string;
      amount_centavos: number;
      provider_ref: string | null;
      provider_status: string | null;
    }>,
    unknown,
  ];
  const row = result[0];
  if (!row) throw new Error('no payment row was written');
  return row;
};

describe('a genuinely signed PayMongo webhook, end to end', () => {
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
    for (const eventId of created.eventIds) {
      await pool.query('DELETE FROM payment_events WHERE provider_event_id = ?', [eventId]);
    }
  });

  /**
   * The bridge, asserted. If a future edit replaces the injected provider
   * with a hand-rolled double, this goes red — which matters because a test
   * that swaps in its own verifier proves nothing about the real one.
   */
  it('hands the route the real PayMongo provider, not a double', () => {
    const provider = getProvider('paymongo');
    expect(provider.name).toBe('paymongo');
    /*
     * The structural proof: the injected instance answers the REAL scheme
     * and refuses the shape `webhooks.test.ts`'s double accepted (a bare
     * HMAC over the body, under a different header). A double would not
     * know PayMongo's `t=`/`te=` header, its `"<t>.<body>"` payload, or its
     * freshness window.
     */
    const bodyText = paymentPaidBody('evt_identity_probe', 'RG-7KQ4M9');
    const raw = Buffer.from(bodyText, 'utf8');
    const now = Math.floor(Date.now() / 1000);

    /*
     * Case by case, `verifyWebhook` must answer exactly what the REAL
     * exported `verifyPaymongoSignature` answers for the same inputs and
     * the same secret — including the accept case, so a double that simply
     * returned false everywhere would not satisfy it either. These six
     * cover the scheme (`t=`/`te=`), the `"<t>.<body>"` payload, the
     * freshness window, a short digest and a missing header; a hand-rolled
     * double diverges on at least one.
     */
    const headers: Array<string | undefined> = [
      signLikePaymongo(bodyText),
      signLikePaymongo(bodyText, fixtures.otherSecret),
      signLikePaymongo(bodyText, fixtures.webhookSecret, now - 3600),
      // A correct digest, computed the way `webhooks.test.ts`'s double
      // computed one: over the body alone, with no timestamp bound to it.
      `t=${now},te=${createHmac('sha256', fixtures.webhookSecret).update(bodyText).digest('hex')}`,
      't=1,te=deadbeef',
      undefined,
    ];
    for (const header of headers) {
      expect(
        provider.verifyWebhook(raw, header === undefined ? {} : { [SIGNATURE_HEADER]: header }),
        'the provider is not running the real PayMongo verifier',
      ).toBe(verifyPaymongoSignature(raw, header, fixtures.webhookSecret));
    }
    // And the first of those really is an ACCEPT, so the loop above is not
    // six agreeing refusals.
    expect(
      provider.verifyWebhook(raw, { [SIGNATURE_HEADER]: signLikePaymongo(bodyText) }),
      'a correctly signed body was refused',
    ).toBe(true);
    // The double's scheme — bare HMAC over the body — is refused.
    expect(
      provider.verifyWebhook(raw, {
        [SIGNATURE_HEADER]: createHmac('sha256', fixtures.webhookSecret)
          .update(bodyText)
          .digest('hex'),
      }),
      'the provider accepted a non-PayMongo signature scheme',
    ).toBe(false);
  });

  /**
   * The body is PayMongo's, not ours. `webhooks.test.ts`'s double read a
   * flat object with `outcome`, `bookingRef` and `amountCentavos` on it —
   * fields no gateway sends. If the fixture here ever drifts into that
   * shape, the end-to-end claim is hollow, so the shape is asserted.
   */
  it('signs a realistic PayMongo envelope, not an object shaped for our parser', () => {
    const parsed = JSON.parse(paymentPaidBody('evt_shape_probe', 'RG-7KQ4M9')) as {
      data: {
        id: string;
        type: string;
        attributes: {
          type: string;
          livemode: boolean;
          data: { id: string; attributes: Record<string, unknown> };
        };
      };
    };
    expect(parsed.data.type).toBe('event');
    expect(parsed.data.attributes.type).toBe('payment.paid');
    expect(parsed.data.attributes.livemode).toBe(false);
    // PayMongo's amount really is centavos — no conversion anywhere.
    expect(parsed.data.attributes.data.attributes.amount).toBe(TOTAL_CENTAVOS);
    expect(parsed.data.attributes.data.attributes.currency).toBe('PHP');
    expect(parsed.data.attributes.data.attributes.payment_method_used).toBe('gcash');
    // And none of our own vocabulary is present to be read instead.
    const flat = JSON.stringify(parsed);
    for (const ours of ['outcome', 'amountCentavos', 'providerStatus', 'providerEventId']) {
      expect(flat, `the fixture carries our own field \`${ours}\``).not.toContain(`"${ours}"`);
    }
  });

  /**
   * THE TEST. A correctly signed `payment.paid` event, POSTed to the real
   * route, through the real signature check and the real parser, into
   * `recordPayment()`.
   */
  dbIt('pays a booking: one payment row, confirmed, amount moved, audit written', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const bodyText = paymentPaidBody(eventId, ref);

    const res = await deliver(bodyText, signLikePaymongo(bodyText));

    expect(await paymentRowCount(bookingId), 'the signed event did not pay the booking').toBe(1);
    expect(await eventRowCount(eventId), 'the event was not stored for idempotency').toBe(1);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('confirmed');
    expect(Number(booking.amount_paid_centavos)).toBe(TOTAL_CENTAVOS);

    const payment = await paymentRow(bookingId);
    expect(payment.provider).toBe('paymongo');
    expect(payment.method).toBe('gcash');
    expect(payment.status).toBe('paid');
    expect(Number(payment.amount_centavos)).toBe(TOTAL_CENTAVOS);
    expect(payment.provider_ref).toBe(`pay_${eventId}`);
    expect(payment.provider_status).toBe('paid');

    // The gateway is the actor, never `system` (Q10).
    expect(await providerAuditCount(bookingId), 'no provider audit row was written').toBe(1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fixtures.networkGuard, 'the webhook path opened a socket').not.toHaveBeenCalled();
  });

  /**
   * **THE PROOF-OF-FAILURE CASE.** One hex character of the digest is
   * flipped — same length, so `timingSafeEqual` really runs rather than the
   * length guard short-circuiting — and nothing may happen.
   */
  dbIt('refuses a tampered signature: 400, no payment, booking untouched', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const bodyText = paymentPaidBody(eventId, ref);

    const honest = signLikePaymongo(bodyText);
    // Flip the final hex digit, keeping the length identical.
    const last = honest.slice(-1);
    const tampered = `${honest.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    expect(tampered).toHaveLength(honest.length);
    expect(tampered).not.toBe(honest);

    const res = await deliver(bodyText, tampered);

    expect(await paymentRowCount(bookingId), 'a tampered signature created a payment').toBe(0);
    expect(await eventRowCount(eventId), 'a tampered signature stored an event').toBe(0);
    expect(await providerAuditCount(bookingId), 'a tampered signature wrote an audit row').toBe(0);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(Number(booking.amount_paid_centavos)).toBe(0);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false });
  });

  /**
   * The same body, signed correctly with the WRONG secret. The scheme is
   * right and the digest is well formed, so only the key can be what
   * refuses it — which is what makes the secret the gate.
   */
  dbIt('refuses a body signed with a different secret', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const bodyText = paymentPaidBody(eventId, ref);

    const res = await deliver(bodyText, signLikePaymongo(bodyText, fixtures.otherSecret));

    expect(await paymentRowCount(bookingId), 'a wrong-secret signature created a payment').toBe(0);
    expect(await eventRowCount(eventId)).toBe(0);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('pending_payment');
    expect(res.status).toBe(400);
  });

  /**
   * A valid signature over DIFFERENT bytes. This is the attack
   * `express.raw()` is mounted for: if any parser re-serialised the body
   * before verification, a signature taken over one payload would start
   * matching another.
   */
  dbIt('refuses a signature taken over a different body', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const delivered = paymentPaidBody(eventId, ref);
    // Signed honestly — over an event for twice the money.
    const otherBody = paymentPaidBody(eventId, ref, TOTAL_CENTAVOS * 2);

    const res = await deliver(delivered, signLikePaymongo(otherBody));

    expect(await paymentRowCount(bookingId), 'a mismatched signature created a payment').toBe(0);
    expect(await eventRowCount(eventId)).toBe(0);
    expect(Number((await bookingRow(bookingId)).amount_paid_centavos)).toBe(0);
    expect(res.status).toBe(400);
  });

  /**
   * A signature whose timestamp is outside the five-minute window, signed
   * correctly for that timestamp. A captured body replayed against a
   * database that has lost its `payment_events` history must still fail.
   */
  dbIt('refuses a correctly signed but stale event', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const bodyText = paymentPaidBody(eventId, ref);
    const stale = Math.floor(Date.now() / 1000) - 3600;

    const res = await deliver(bodyText, signLikePaymongo(bodyText, fixtures.webhookSecret, stale));

    expect(await paymentRowCount(bookingId), 'a stale event created a payment').toBe(0);
    expect(await eventRowCount(eventId)).toBe(0);
    expect(res.status).toBe(400);
  });

  /**
   * The other real event family, end to end: the resource is the checkout
   * session and the amount, status and instrument all live one level down in
   * `payments[]`. Only the real `parseEvent` reads that.
   */
  dbIt('pays a booking from a checkout_session.payment.paid event', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();
    const bodyText = checkoutSessionPaidBody(eventId, ref);

    const res = await deliver(bodyText, signLikePaymongo(bodyText));

    expect(await paymentRowCount(bookingId), 'the checkout-session event did not pay').toBe(1);
    const booking = await bookingRow(bookingId);
    expect(booking.status).toBe('confirmed');
    expect(Number(booking.amount_paid_centavos)).toBe(TOTAL_CENTAVOS);
    // The ref came from `reference_number`, not from metadata, on this shape.
    const payment = await paymentRow(bookingId);
    expect(payment.provider_ref).toBe(`pay_${eventId}`);
    expect(await providerAuditCount(bookingId)).toBe(1);
    expect(res.status).toBe(200);
  });

  /** A missing header is the same answer as a wrong one: 400, nothing stored. */
  dbIt('refuses an unsigned body', async () => {
    const { bookingId, ref } = await seedBooking();
    const eventId = nextEventId();

    const res = await deliver(paymentPaidBody(eventId, ref));

    expect(await paymentRowCount(bookingId), 'an unsigned webhook created a payment').toBe(0);
    expect(await eventRowCount(eventId)).toBe(0);
    expect(res.status).toBe(400);
  });
});
