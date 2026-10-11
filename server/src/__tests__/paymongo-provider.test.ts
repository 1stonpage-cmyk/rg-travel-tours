/**
 * Task 16 of the core-schema plan: the PayMongo provider.
 *
 * **Signature verification is the critical unit here, and it is the only
 * thing standing between an anonymous POST to `/api/webhooks/paymongo` and
 * `recordPayment()`.** So the bulk of this file is rejections: a tampered
 * body, a tampered digest, a missing header, a digest of the wrong length, a
 * well-formed digest computed with the wrong secret, a stale timestamp, a
 * re-dated signature, and no configured secret at all. Nine ways to say no
 * against one way to say yes is the right proportion for a control whose
 * failure mode is "anyone can mark a booking paid".
 *
 * **The accept case is a GOLDEN FIXTURE, not a re-computation.** A test that
 * signs with `createHmac` the same way the implementation does would pass
 * just as happily if both switched to signing the body without the
 * timestamp, or to sha512, or to a `:` separator. The fixture below pins
 * PayMongo's documented scheme — HMAC-SHA256 over `"<t>.<raw body>"`, hex —
 * to a literal digest computed once, and the clock is pinned with it so the
 * freshness window cannot age the fixture out.
 *
 * **No live keys, no real charges, no network.** Every secret in this file
 * is a fixture string that is not a credential for anything, the transport
 * is injected, and `globalThis.fetch` is replaced in `beforeAll` with a
 * function that THROWS — so a call that tried to reach `api.paymongo.com`
 * fails the suite instead of leaving it. The last test asserts that guard
 * was never tripped.
 *
 * This file needs no database. It is in `__tests__/` with the rest, so
 * `per-file-setup.ts` still proves the worker is pointed at
 * `rg_travel_test`, but nothing below reads or writes a row.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PaymongoApiError,
  PaymongoNotConfiguredError,
  createPaymongoProvider,
  mapPaymongoMethod,
  parsePaymongoEvent,
  verifyPaymongoSignature,
} from '../services/payments/paymongo';
import type { PaymentMethod } from '../services/payments/types';

/* -------------------------------------------------------------------------
 * Fixtures. NONE of these is a credential for anything.
 * ---------------------------------------------------------------------- */

const FIXTURE_WEBHOOK_SECRET = 'whsk_test_fixture_not_a_real_secret';
const WRONG_WEBHOOK_SECRET = 'whsk_test_a_different_fixture_secret';
const FIXTURE_SECRET_KEY = 'sk_test_fixture_not_a_real_key';

/** Pinned so the golden digest below stays inside the freshness window. */
const FIXTURE_TIMESTAMP = 1760000000;

/**
 * A `payment.paid` event body, byte-exact. The golden digest is over these
 * exact bytes, so this string must not be reformatted or rebuilt from an
 * object — `JSON.stringify` key order is not a promise worth signing.
 */
const FIXTURE_BODY =
  '{"data":{"id":"evt_fixture_16","type":"event","attributes":{"type":"payment.paid",' +
  '"data":{"id":"pay_fixture_16","type":"payment","attributes":{"amount":189000,' +
  '"status":"paid","payment_method_used":"gcash","metadata":{"bookingRef":"RG-7KQ4M9"}}}}}}';

/**
 * HMAC-SHA256(`"1760000000." + FIXTURE_BODY`, FIXTURE_WEBHOOK_SECRET), hex.
 * Computed once, by hand, and written down. If the implementation changes
 * what it signs, what it signs it with, or how it encodes the result, this
 * literal stops matching.
 */
const FIXTURE_DIGEST = 'c83ec58db6cbbf1abfc4515710ae3dd2eb33d3a9d9cacab8a47ae61df89f00db';

const FIXTURE_HEADER = `t=${FIXTURE_TIMESTAMP},te=${FIXTURE_DIGEST}`;

const body = (text: string): Buffer => Buffer.from(text, 'utf8');

/** Only used to BUILD rejection cases, never to assert the accept case. */
const digestFor = (text: string, secret: string, timestamp: number): string =>
  createHmac('sha256', secret).update(`${timestamp}.${text}`).digest('hex');

/** A JSON body plus a fresh, valid header for it — for the `verifyWebhook` path. */
function freshlySigned(text: string): { raw: Buffer; header: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    raw: body(text),
    header: `t=${timestamp},te=${digestFor(text, FIXTURE_WEBHOOK_SECRET, timestamp)}`,
  };
}

/** A stub transport. Records the call; answers with a real `Response`. */
function stubFetch(status: number, payload: unknown) {
  return vi.fn<(...args: unknown[]) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

/** What the provider actually sent, as `[url, init]`. */
function sentRequest(transport: ReturnType<typeof stubFetch>): [string, RequestInit] {
  return transport.mock.calls[0] as [string, RequestInit];
}

/**
 * Replaces global `fetch` for the whole file with a throw.
 *
 * Belt and braces: every provider in this file is built with an injected
 * transport, so nothing SHOULD reach this. If something does — a forgotten
 * injection, a future edit — the suite says "a test tried to reach the
 * network" instead of quietly contacting a payment gateway.
 */
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

/* =========================================================================
 * Signature verification
 * ====================================================================== */

describe('PayMongo signature verification', () => {
  it('accepts the known-good fixture signature', () => {
    expect(
      verifyPaymongoSignature(
        body(FIXTURE_BODY),
        FIXTURE_HEADER,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP,
      ),
    ).toBe(true);
  });

  it('accepts a live-mode digest under li= as well as a test-mode te=', () => {
    expect(
      verifyPaymongoSignature(
        body(FIXTURE_BODY),
        `t=${FIXTURE_TIMESTAMP},li=${FIXTURE_DIGEST}`,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP,
      ),
    ).toBe(true);
  });

  it('REJECTS a tampered body', () => {
    // ₱1,890.00 becomes ₱18,900.00 — one character, ten times the money.
    const tampered = FIXTURE_BODY.replace('"amount":189000', '"amount":1890000');
    expect(tampered).not.toBe(FIXTURE_BODY);
    expect(
      verifyPaymongoSignature(
        body(tampered),
        FIXTURE_HEADER,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP,
      ),
    ).toBe(false);
  });

  it('REJECTS a tampered signature', () => {
    const flipped = `${FIXTURE_DIGEST.slice(0, -1)}${FIXTURE_DIGEST.endsWith('b') ? 'c' : 'b'}`;
    expect(flipped).not.toBe(FIXTURE_DIGEST);
    expect(
      verifyPaymongoSignature(
        body(FIXTURE_BODY),
        `t=${FIXTURE_TIMESTAMP},te=${flipped}`,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP,
      ),
    ).toBe(false);
  });

  it('REJECTS a missing or empty header', () => {
    for (const header of [undefined, '', '   ']) {
      expect(
        verifyPaymongoSignature(
          body(FIXTURE_BODY),
          header,
          FIXTURE_WEBHOOK_SECRET,
          FIXTURE_TIMESTAMP,
        ),
      ).toBe(false);
    }
  });

  it('REJECTS a well-formed signature computed with the WRONG secret', () => {
    const header = `t=${FIXTURE_TIMESTAMP},te=${digestFor(
      FIXTURE_BODY,
      WRONG_WEBHOOK_SECRET,
      FIXTURE_TIMESTAMP,
    )}`;
    // Right scheme, right length, right timestamp, right body — only the
    // secret differs. This is the case a `startsWith`/truthiness check or a
    // comparison against the wrong variable would sail straight past.
    expect(header).toMatch(/^t=\d+,te=[0-9a-f]{64}$/);
    expect(
      verifyPaymongoSignature(
        body(FIXTURE_BODY),
        header,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP,
      ),
    ).toBe(false);
  });

  it('REJECTS a digest of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so a missing length
    // check here is a 500 from the webhook route rather than a 400 — and an
    // unhandled throw inside a verifier is exactly the shape of bug that
    // gets "fixed" by catching it and returning true.
    for (const truncated of [FIXTURE_DIGEST.slice(0, 32), `${FIXTURE_DIGEST}00`, 'a']) {
      expect(() =>
        verifyPaymongoSignature(
          body(FIXTURE_BODY),
          `t=${FIXTURE_TIMESTAMP},te=${truncated}`,
          FIXTURE_WEBHOOK_SECRET,
          FIXTURE_TIMESTAMP,
        ),
      ).not.toThrow();
      expect(
        verifyPaymongoSignature(
          body(FIXTURE_BODY),
          `t=${FIXTURE_TIMESTAMP},te=${truncated}`,
          FIXTURE_WEBHOOK_SECRET,
          FIXTURE_TIMESTAMP,
        ),
      ).toBe(false);
    }
  });

  it('REJECTS a malformed or missing timestamp', () => {
    for (const header of [
      `t=not-a-number,te=${FIXTURE_DIGEST}`,
      `t=17abc,te=${FIXTURE_DIGEST}`,
      `t=,te=${FIXTURE_DIGEST}`,
      `te=${FIXTURE_DIGEST}`,
      `t=${FIXTURE_TIMESTAMP}`,
      'garbage',
    ]) {
      expect(
        verifyPaymongoSignature(
          body(FIXTURE_BODY),
          header,
          FIXTURE_WEBHOOK_SECRET,
          FIXTURE_TIMESTAMP,
        ),
      ).toBe(false);
    }
  });

  it('REJECTS a signature re-dated to a different timestamp', () => {
    // The digest is over `"<t>.<body>"`, so moving `t` must invalidate it.
    // If it did not, a captured signature would be replayable forever by
    // simply advancing the timestamp past the freshness window.
    expect(
      verifyPaymongoSignature(
        body(FIXTURE_BODY),
        `t=${FIXTURE_TIMESTAMP + 1},te=${FIXTURE_DIGEST}`,
        FIXTURE_WEBHOOK_SECRET,
        FIXTURE_TIMESTAMP + 1,
      ),
    ).toBe(false);
  });

  it('accepts a signature inside the five-minute window and REJECTS one outside it', () => {
    const inside = [FIXTURE_TIMESTAMP + 299, FIXTURE_TIMESTAMP - 299, FIXTURE_TIMESTAMP + 300];
    for (const now of inside) {
      expect(
        verifyPaymongoSignature(body(FIXTURE_BODY), FIXTURE_HEADER, FIXTURE_WEBHOOK_SECRET, now),
      ).toBe(true);
    }
    // Stale in both directions: an old captured delivery, and one dated in
    // the future by a sender whose clock we do not control.
    for (const now of [FIXTURE_TIMESTAMP + 301, FIXTURE_TIMESTAMP - 301]) {
      expect(
        verifyPaymongoSignature(body(FIXTURE_BODY), FIXTURE_HEADER, FIXTURE_WEBHOOK_SECRET, now),
      ).toBe(false);
    }
  });

  it('REJECTS everything when no webhook secret is configured', () => {
    for (const secret of [undefined, '']) {
      expect(
        verifyPaymongoSignature(body(FIXTURE_BODY), FIXTURE_HEADER, secret, FIXTURE_TIMESTAMP),
      ).toBe(false);
    }
    // And through the provider, whose secret comes from `.env`: an
    // unconfigured deploy must not accept a webhook, it must refuse one.
    const unconfigured = createPaymongoProvider({ webhookSecret: '' });
    const { raw, header } = freshlySigned(FIXTURE_BODY);
    expect(unconfigured.verifyWebhook(raw, { 'paymongo-signature': header })).toBe(false);
  });
});

describe('paymongoProvider.verifyWebhook', () => {
  const provider = createPaymongoProvider({ webhookSecret: FIXTURE_WEBHOOK_SECRET });

  it('reads the signature from the paymongo-signature header', () => {
    const { raw, header } = freshlySigned(FIXTURE_BODY);
    expect(provider.verifyWebhook(raw, { 'paymongo-signature': header })).toBe(true);
  });

  it('REJECTS a valid signature offered under any other header name', () => {
    const { raw, header } = freshlySigned(FIXTURE_BODY);
    expect(provider.verifyWebhook(raw, { 'x-signature': header })).toBe(false);
    expect(provider.verifyWebhook(raw, {})).toBe(false);
  });
});

/* =========================================================================
 * Event parsing
 * ====================================================================== */

describe('parseEvent', () => {
  it('reads a payment.paid event into our vocabulary, amount in centavos', () => {
    const event = parsePaymongoEvent(body(FIXTURE_BODY));
    expect(event).toEqual({
      providerEventId: 'evt_fixture_16',
      providerType: 'payment.paid',
      outcome: 'paid',
      bookingRef: 'RG-7KQ4M9',
      // PayMongo's unit is centavos and so is ours: ₱1,890.00 is 189000,
      // unconverted. A ×100 or ÷100 anywhere would show up right here.
      amountCentavos: 189000,
      providerRef: 'pay_fixture_16',
      providerStatus: 'paid',
      method: 'gcash',
    });
  });

  it('reads the nested payment out of a checkout_session.payment.paid event', () => {
    const event = parsePaymongoEvent(
      body(
        JSON.stringify({
          data: {
            id: 'evt_cs_1',
            attributes: {
              type: 'checkout_session.payment.paid',
              data: {
                id: 'cs_1',
                attributes: {
                  reference_number: 'RG-ABC123',
                  payments: [
                    {
                      id: 'pay_cs_1',
                      attributes: { amount: 50000, status: 'paid', source: { type: 'card' } },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );
    expect(event.outcome).toBe('paid');
    expect(event.bookingRef).toBe('RG-ABC123');
    expect(event.amountCentavos).toBe(50000);
    expect(event.providerRef).toBe('pay_cs_1');
    expect(event.method).toBe('card');
  });

  it('maps failed and refunded event types', () => {
    const event = (type: string) =>
      parsePaymongoEvent(
        body(
          JSON.stringify({
            data: { id: `evt_${type}`, attributes: { type, data: { id: 'pay_x' } } },
          }),
        ),
      );
    expect(event('payment.failed').outcome).toBe('failed');
    expect(event('payment.refunded').outcome).toBe('refunded');
    expect(event('payment.refund.updated').outcome).toBe('refunded');
    expect(event('link.payment.paid').outcome).toBe('paid');
  });

  it('returns `ignored` for an unrecognised event type and NEVER throws', () => {
    // The whole point: a PayMongo event type that did not exist when this
    // was written must not 500 the webhook route, because a 500 is what
    // triggers retries forever.
    for (const type of ['payment.unfrobnicated', 'source.chargeable', 'qrph.expired', '']) {
      const raw = body(
        JSON.stringify({ data: { id: 'evt_new', attributes: { type, data: { id: 'pay_x' } } } }),
      );
      expect(() => parsePaymongoEvent(raw)).not.toThrow();
      expect(parsePaymongoEvent(raw).outcome).toBe('ignored');
    }
    // And the verbatim type survives for the audit trail either way.
    expect(
      parsePaymongoEvent(
        body(JSON.stringify({ data: { id: 'evt_new', attributes: { type: 'a.brand.new.type' } } })),
      ).providerType,
    ).toBe('a.brand.new.type');
  });

  it('refuses a body that is not an event at all, because it has no idempotency key', () => {
    // Distinct from an unknown TYPE: `provider_event_id` is the idempotency
    // key, so an event with no id cannot be de-duplicated and must not be
    // stored under an empty string.
    for (const text of ['{}', '{"data":{}}', '{"data":{"id":""}}', 'not json at all']) {
      expect(() => parsePaymongoEvent(body(text))).toThrow();
    }
  });

  it('leaves amount, ref and method NULL rather than guessing when the event is silent', () => {
    const event = parsePaymongoEvent(
      body(
        JSON.stringify({
          data: {
            id: 'evt_quiet',
            attributes: {
              type: 'payment.paid',
              data: { id: 'pay_quiet', attributes: { amount: 1890.5, status: 'paid' } },
            },
          },
        }),
      ),
    );
    expect(event.amountCentavos).toBeNull();
    expect(event.bookingRef).toBeNull();
    // Null is what the webhook route refuses on. A default of `card` here
    // would put a fiction in the one column the revenue report reads.
    expect(event.method).toBeNull();
  });
});

/* =========================================================================
 * PayMongo's method strings onto PAYMENT_METHODS
 * ====================================================================== */

describe('PayMongo payment-method mapping', () => {
  const expected: [string, PaymentMethod][] = [
    ['card', 'card'],
    ['gcash', 'gcash'],
    // PayMongo says `paymaya`; our enum says `maya`.
    ['paymaya', 'maya'],
    ['maya', 'maya'],
    // Ours is `grab_pay`, WITH the underscore.
    ['grab_pay', 'grab_pay'],
    ['grabpay', 'grab_pay'],
    ['qrph', 'qrph'],
    ['dob', 'bank_transfer'],
    ['dob_ubp', 'bank_transfer'],
    ['brankas_bdo', 'bank_transfer'],
  ];

  for (const [paymongoName, ours] of expected) {
    it(`maps "${paymongoName}" to ${ours}`, () => {
      expect(mapPaymongoMethod(paymongoName)).toBe(ours);
      expect(mapPaymongoMethod(paymongoName.toUpperCase())).toBe(ours);
    });
  }

  it('returns null for an instrument we have no enum value for — never a guess', () => {
    // BNPL and anything newer: adding these means adding a PAYMENT_METHODS
    // value first. Mapping them onto `card` would be a lie in the ledger.
    for (const name of ['billease', 'atome', 'unknown_wallet', '', 'cash']) {
      expect(mapPaymongoMethod(name)).toBeNull();
    }
    for (const value of [undefined, null, 42, {}, ['card']]) {
      expect(mapPaymongoMethod(value)).toBeNull();
    }
  });
});

/* =========================================================================
 * createCheckout and refund — plain fetch, injected transport
 * ====================================================================== */

const CHECKOUT_OK = {
  data: {
    id: 'cs_live_ref',
    attributes: { checkout_url: 'https://checkout.paymongo.com/cs_live_ref' },
  },
};

describe('createCheckout', () => {
  const input = {
    bookingRef: 'RG-7KQ4M9',
    amountCentavos: 189000,
    description: 'Kawasan Falls day tour — deposit',
    methods: ['gcash', 'maya', 'card', 'bank_transfer'] as const,
    successUrl: 'https://travelsugbo.com/checkout/success',
    cancelUrl: 'https://travelsugbo.com/checkout/cancelled',
  };

  it('THROWS a clear error when PAYMONGO_SECRET_KEY is absent, before any request', async () => {
    const transport = stubFetch(200, CHECKOUT_OK);
    const provider = createPaymongoProvider({ secretKey: '', fetchImpl: transport });
    await expect(provider.createCheckout(input)).rejects.toThrow(PaymongoNotConfiguredError);
    await expect(provider.createCheckout(input)).rejects.toThrow('PAYMONGO_SECRET_KEY');
    // A misconfigured deploy must fail at the first payment, not send an
    // unauthenticated request to a live gateway and interpret the refusal.
    expect(transport).not.toHaveBeenCalled();
  });

  it('POSTs a checkout session with the amount in centavos and the ref in metadata', async () => {
    const transport = stubFetch(200, CHECKOUT_OK);
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: transport,
    });

    const result = await provider.createCheckout(input);
    expect(result).toEqual({
      redirectUrl: 'https://checkout.paymongo.com/cs_live_ref',
      providerRef: 'cs_live_ref',
    });

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = sentRequest(transport);
    expect(url).toBe('https://api.paymongo.com/v1/checkout_sessions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`${FIXTURE_SECRET_KEY}:`).toString('base64')}`,
    );

    const sent = JSON.parse(String(init.body)) as {
      data: {
        attributes: {
          line_items: { amount: number; currency: string; quantity: number }[];
          payment_method_types: string[];
          metadata: { bookingRef: string };
          reference_number: string;
          success_url: string;
          cancel_url: string;
        };
      };
    };
    const attributes = sent.data.attributes;
    // No conversion: 189000 in, 189000 out. Both units are centavos.
    expect(attributes.line_items[0]?.amount).toBe(189000);
    expect(attributes.line_items[0]?.currency).toBe('PHP');
    // The webhook finds us by this, so it is the load-bearing field.
    expect(attributes.metadata.bookingRef).toBe('RG-7KQ4M9');
    expect(attributes.reference_number).toBe('RG-7KQ4M9');
    // `maya` becomes `paymaya`, and `bank_transfer` is dropped — it is our
    // manual receipt flow, not a PayMongo payment method type.
    expect(attributes.payment_method_types).toEqual(['gcash', 'paymaya', 'card']);
    expect(attributes.success_url).toBe(input.successUrl);
    expect(attributes.cancel_url).toBe(input.cancelUrl);
  });

  it('refuses when no requested instrument is one PayMongo can present', async () => {
    const transport = stubFetch(200, CHECKOUT_OK);
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: transport,
    });
    await expect(
      provider.createCheckout({ ...input, methods: ['bank_transfer', 'cash'] }),
    ).rejects.toThrow(/payment method types/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('THROWS on a non-2xx answer, quoting PayMongo but never the secret key', async () => {
    const transport = stubFetch(400, {
      errors: [{ detail: 'amount must be greater than or equal to 10000' }],
    });
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: transport,
    });
    const error = await provider.createCheckout(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymongoApiError);
    expect((error as PaymongoApiError).status).toBe(400);
    expect((error as Error).message).toContain('amount must be greater');
    expect((error as Error).message).not.toContain(FIXTURE_SECRET_KEY);
  });

  it('THROWS rather than returning a checkout with no redirect URL', async () => {
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: stubFetch(200, { data: { id: 'cs_1', attributes: {} } }),
    });
    await expect(provider.createCheckout(input)).rejects.toThrow(PaymongoApiError);
  });
});

describe('refund', () => {
  const REFUND_OK = { data: { id: 'ref_1', attributes: { status: 'pending' } } };

  it('POSTs the amount in centavos against the payment id', async () => {
    const transport = stubFetch(200, REFUND_OK);
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: transport,
    });

    const result = await provider.refund({
      providerRef: 'pay_fixture_16',
      amountCentavos: 150000,
      reason: 'Guest cancelled, typhoon signal 3',
    });
    expect(result).toEqual({ providerRef: 'ref_1', providerStatus: 'pending' });

    const [url, init] = sentRequest(transport);
    expect(url).toBe('https://api.paymongo.com/v1/refunds');
    const sent = JSON.parse(String(init.body)) as {
      data: { attributes: { amount: number; payment_id: string; reason: string; notes: string } };
    };
    expect(sent.data.attributes.amount).toBe(150000);
    expect(sent.data.attributes.payment_id).toBe('pay_fixture_16');
    // PayMongo's `reason` is a fixed set, ours is free text an admin typed:
    // unrecognised text becomes `others` and the admin's words survive in
    // `notes` rather than being discarded.
    expect(sent.data.attributes.reason).toBe('others');
    expect(sent.data.attributes.notes).toBe('Guest cancelled, typhoon signal 3');
  });

  it('passes a reason PayMongo already understands straight through', async () => {
    const transport = stubFetch(200, REFUND_OK);
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: transport,
    });
    await provider.refund({
      providerRef: 'pay_x',
      amountCentavos: 1000,
      reason: 'requested_by_customer',
    });
    const [, init] = sentRequest(transport);
    expect(
      (JSON.parse(String(init.body)) as { data: { attributes: { reason: string } } }).data
        .attributes.reason,
    ).toBe('requested_by_customer');
  });

  it('THROWS rather than reporting a refund it cannot identify', async () => {
    const provider = createPaymongoProvider({
      secretKey: FIXTURE_SECRET_KEY,
      fetchImpl: stubFetch(200, { data: { attributes: { status: 'pending' } } }),
    });
    // A refund with no id is money we could never reconcile against
    // PayMongo's dashboard. Refuse it rather than record a blank ref.
    await expect(
      provider.refund({ providerRef: 'pay_x', amountCentavos: 1000, reason: 'others' }),
    ).rejects.toThrow(PaymongoApiError);
  });

  it('THROWS when PAYMONGO_SECRET_KEY is absent, before any request', async () => {
    const transport = stubFetch(200, REFUND_OK);
    const provider = createPaymongoProvider({ secretKey: '', fetchImpl: transport });
    await expect(
      provider.refund({ providerRef: 'pay_x', amountCentavos: 1000, reason: 'others' }),
    ).rejects.toThrow(PaymongoNotConfiguredError);
    expect(transport).not.toHaveBeenCalled();
  });
});

/* =========================================================================
 * The constraints the owner set, as assertions
 * ====================================================================== */

describe('no SDK, no network', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../services/payments/paymongo.ts'),
    'utf8',
  );

  it('imports nothing but node:crypto, our env and our own types', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['../../env', './types', 'node:crypto']);
    expect(source).not.toMatch(/require\(/);
  });

  it('declares no gateway SDK as a dependency', () => {
    const pkg = readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8');
    expect(pkg).not.toMatch(/paymongo|xendit|stripe|axios|node-fetch|got/i);
  });

  it('compares signatures with timingSafeEqual, not ===', () => {
    expect(source).toContain('timingSafeEqual');
    // The only `===` allowed near the compare is the length guard; an
    // equality compare of two digests is the bug this asserts against.
    expect(source).not.toMatch(/offered === expected|expected === offered/);
  });

  it('never reached the network', () => {
    expect(networkGuard).not.toHaveBeenCalled();
  });
});
