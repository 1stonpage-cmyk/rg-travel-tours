/**
 * PayMongo, over plain `fetch` (plan Task 16).
 *
 * **No SDK.** Global Constraints forbid one for either gateway, so this file
 * is three documented REST endpoints, `node:crypto` for the signature, and
 * nothing else. The allowed dependency set is unchanged by this task.
 *
 * **It never marks anything paid.** `recordPayment()` (Task 14) is the only
 * function that may, and this file does not import it. What this file owes
 * the rest of the system is narrower and harder: turn an anonymous HTTP
 * request into either "PayMongo really sent this" or "no", and translate
 * PayMongo's wording into ours.
 *
 * **Secrets.** `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` come from
 * `.env` via `env.ts` and are never logged, never put in an error message,
 * never stored, and never sent anywhere but PayMongo's own API over HTTPS.
 * Nothing below prints a request body, a response body or a signature
 * header, on any path including the error paths — a signed body is exactly
 * the kind of thing that ends up in a log aggregator.
 *
 * **The factory exists for the tests**, and only for them: the suite builds
 * an instance with a fixture webhook secret and a stub transport, so no test
 * reads a real key and no test can reach `api.paymongo.com`. The registry
 * uses the env-backed singleton at the bottom.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../env';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  ParsedPaymentEvent,
  PaymentMethod,
  PaymentProvider,
  RefundInput,
  RefundResult,
} from './types';

const API_BASE = 'https://api.paymongo.com/v1';

/**
 * How far a webhook's own timestamp may sit from our clock, in seconds.
 *
 * PayMongo signs `"<t>.<body>"`, so `t` cannot be edited without breaking
 * the digest — which makes it usable as a freshness bound and not merely
 * decoration. Five minutes each way is the usual reading and leaves room for
 * ordinary skew and a retry or two.
 *
 * This is a SECOND line of defence, not the first: the route's
 * `(provider, provider_event_id)` UNIQUE index already makes a replayed
 * delivery a no-op forever, because `payment_events` rows are never pruned.
 * The window adds the case that index cannot cover — a captured body
 * replayed against a database that has lost its history.
 *
 * The cost is honest and worth stating: a server clock more than five
 * minutes out rejects every genuine webhook, with a 400 that PayMongo
 * retries and eventually abandons. Keep NTP running on the box.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** PayMongo's own header name, lower-cased as Node gives it to us. */
const SIGNATURE_HEADER = 'paymongo-signature';

export interface PaymongoConfig {
  /** `sk_test_…` / `sk_live_…`. Absent means "not configured", never "skip auth". */
  secretKey?: string;
  /** The webhook signing secret. Absent means every signature check answers false. */
  webhookSecret?: string;
  /** Injected by the tests so no test can open a socket. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * `PAYMONGO_SECRET_KEY` is missing, so there is nothing to authenticate with.
 *
 * Thrown at the first payment rather than at boot, deliberately (plan Task
 * 16): the app must still start without payment credentials — that is how it
 * runs today and how the public site runs during content work — but a
 * checkout must not quietly produce a redirect to nowhere. The message names
 * the variable and never its value.
 */
export class PaymongoNotConfiguredError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`PayMongo is not configured: ${variable} is not set in the server environment`);
    this.name = 'PaymongoNotConfiguredError';
    this.variable = variable;
  }
}

/**
 * PayMongo answered, and the answer was not usable.
 *
 * Carries the HTTP status and PayMongo's own `errors[].detail` strings,
 * which are human-readable messages about the request ("amount must be at
 * least 10000") and contain no credential. It deliberately does NOT carry
 * the response body verbatim, the request body, or any header.
 */
export class PaymongoApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`PayMongo API request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'PaymongoApiError';
    this.status = status;
  }
}

/* -------------------------------------------------------------------------
 * Signature verification — the critical unit.
 *
 * It is the only thing standing between an anonymous POST to
 * /api/webhooks/paymongo and `recordPayment()`. Everything here therefore
 * answers FALSE on doubt: a missing header, a malformed header, an
 * unparseable timestamp, a stale timestamp, a wrong-length digest, a missing
 * secret. There is exactly one `return true`, and it is behind
 * `timingSafeEqual`.
 * ---------------------------------------------------------------------- */

/**
 * PayMongo's header is `t=<unix seconds>,te=<hex>,li=<hex>`: the timestamp,
 * the digest for a TEST-mode event and the digest for a LIVE-mode one. An
 * event carries one or the other, each signed with that mode's own secret,
 * so accepting whichever is present is not a weakening — the secret is the
 * gate, and a `te` digest computed with a live secret does not match a live
 * secret's `te` either.
 *
 * Returns null rather than a partial result for anything it cannot read, so
 * the caller has no "well, some of it parsed" branch to get wrong.
 */
function parseSignatureHeader(header: string): { timestamp: number; digests: string[] } | null {
  let timestamp: number | null = null;
  const digests: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (value === '') continue;

    if (key === 't') {
      // Strict: `parseInt` would read "17abc" as 17, and a timestamp we
      // half-understood is one we do not understand.
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'te' || key === 'li') {
      digests.push(value);
    }
  }

  if (timestamp === null || digests.length === 0) return null;
  return { timestamp, digests };
}

/** Constant-time compare of two hex digests, length checked first. */
function digestsMatch(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` THROWS on a length mismatch, so the length check is
  // not an optimisation — without it a short digest is a 500, not a 400.
  // Length is not secret: it is fixed by the algorithm.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * True only if `rawBody` was signed with `webhookSecret` and the signature
 * is fresh. Exported so the suite can test it directly with a fixture
 * secret, a wrong secret, and timestamps inside and outside the window —
 * none of which is expressible through the env-backed singleton.
 *
 * `rawBody` must be the EXACT bytes PayMongo sent. The webhook route mounts
 * `express.raw()` above `express.json()` for this reason: a JSON parser that
 * has already re-serialised the body has destroyed the thing being verified.
 */
export function verifyPaymongoSignature(
  rawBody: Buffer,
  headerValue: string | undefined,
  webhookSecret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  // No secret configured: we cannot tell, so the answer is no. Returning
  // true here — or skipping the check "because it isn't set up yet" — hands
  // anyone who can reach the URL the ability to mark bookings paid.
  if (!webhookSecret) return false;
  if (!headerValue) return false;

  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return false;

  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  // The signed payload is the timestamp and the body, joined by a dot —
  // which is what binds `t` to this body and stops it being re-dated.
  const expected = createHmac('sha256', webhookSecret)
    .update(`${parsed.timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  for (const offered of parsed.digests) {
    if (digestsMatch(offered, expected)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Event parsing — PayMongo's vocabulary onto ours.
 * ---------------------------------------------------------------------- */

/**
 * PayMongo's event types we act on. Anything absent maps to `ignored`.
 *
 * `ignored` is the DEFAULT for a reason the plan is explicit about: PayMongo
 * adds event types over time, and a provider that throws on an unfamiliar
 * one turns the next addition into a 500, which the gateway answers with
 * retries forever. An event we have no opinion about is stored, stamped and
 * acknowledged.
 */
const OUTCOME_BY_EVENT_TYPE: Record<string, ParsedPaymentEvent['outcome']> = {
  'payment.paid': 'paid',
  'checkout_session.payment.paid': 'paid',
  'link.payment.paid': 'paid',
  'payment.failed': 'failed',
  'payment.refunded': 'refunded',
  'payment.refund.updated': 'refunded',
  // Listed rather than left to the default so the intent is on the record:
  // a chargeable source and an expired QR are real events that move no
  // money, and neither is an "unknown type" we failed to handle.
  'source.chargeable': 'ignored',
  'qrph.expired': 'ignored',
};

/**
 * PayMongo's payment-method strings onto `PAYMENT_METHODS` (plan Task 15
 * added `ParsedPaymentEvent.method`; Task 16 owes this table).
 *
 * Read the right-hand side carefully — it is OUR enum, not PayMongo's:
 *
 *   - `paymaya` is PayMongo's name for Maya; ours is `maya`.
 *   - ours is `grab_pay`, WITH an underscore, which happens to match
 *     PayMongo's `grab_pay`. `grabpay` is accepted too because the string
 *     appears both ways in PayMongo's own material.
 *   - `dob*` is Direct Online Banking and `brankas_*` is bank-to-bank —
 *     both are a bank moving money, so both land on `bank_transfer`.
 *
 * Anything else returns NULL, not a guess. Null is what the webhook route
 * refuses on (`payments.method` is NOT NULL), so an unrecognised instrument
 * becomes a stored, unprocessed event an admin reconciles — never a
 * `card` row for a payment that was not on a card, in the one column §9's
 * revenue-by-method report reads. Adding BNPL (`billease`, `atome`) means
 * adding a `PAYMENT_METHODS` value first; mapping them onto `card` today
 * would be exactly that fiction.
 */
const METHOD_BY_PAYMONGO_NAME: Record<string, PaymentMethod> = {
  card: 'card',
  gcash: 'gcash',
  paymaya: 'maya',
  maya: 'maya',
  grab_pay: 'grab_pay',
  grabpay: 'grab_pay',
  qrph: 'qrph',
  dob: 'bank_transfer',
  dob_ubp: 'bank_transfer',
  brankas_bdo: 'bank_transfer',
  brankas_landbank: 'bank_transfer',
  brankas_metrobank: 'bank_transfer',
};

/** Our instruments that PayMongo can actually present at a checkout. */
const PAYMONGO_NAME_BY_METHOD: Partial<Record<PaymentMethod, string>> = {
  card: 'card',
  gcash: 'gcash',
  maya: 'paymaya',
  grab_pay: 'grab_pay',
  qrph: 'qrph',
  // `bank_transfer` and `cash` are deliberately absent: both are OUR manual
  // flows (receipt upload, cash to the driver) with `provider='manual'`, and
  // neither is a PayMongo payment method type.
};

export function mapPaymongoMethod(name: unknown): PaymentMethod | null {
  if (typeof name !== 'string') return null;
  return METHOD_BY_PAYMONGO_NAME[name.trim().toLowerCase()] ?? null;
}

/** Narrow a parsed-JSON value to something with string keys, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The booking ref, from wherever this event shape keeps it.
 *
 * `createCheckout` puts it in `metadata.bookingRef` AND in
 * `reference_number`, because the two event families carry different
 * resources: a `payment.*` event's metadata is the payment's, while a
 * `checkout_session.payment.paid` event's is the session's. Reading both,
 * plus the session's first payment, is cheaper than demanding one shape
 * from a gateway that does not promise one.
 */
function findBookingRef(resource: Record<string, unknown> | null): string | null {
  if (!resource) return null;
  const attributes = asRecord(resource.attributes);
  if (!attributes) return null;

  const direct = asString(asRecord(attributes.metadata)?.bookingRef);
  if (direct) return direct;

  const reference = asString(attributes.reference_number);
  if (reference) return reference;

  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  for (const payment of payments) {
    const nested = asRecord(asRecord(payment)?.attributes);
    const ref = asString(asRecord(nested?.metadata)?.bookingRef);
    if (ref) return ref;
  }
  return null;
}

/**
 * The payment resource an event is really about.
 *
 * For `payment.*` that is the event's own resource. For
 * `checkout_session.payment.paid` the resource is the session and the
 * payment is inside it, so the amount, status and instrument all have to be
 * read one level down — otherwise a checkout-session event would record a
 * null amount and be refused as undescribable.
 */
function findPaymentResource(
  resource: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!resource) return null;
  const attributes = asRecord(resource.attributes);
  const payments = Array.isArray(attributes?.payments) ? attributes.payments : [];
  const first = asRecord(payments[0]);
  return first ?? resource;
}

/**
 * Reads a verified body into our vocabulary. **Never throws on an
 * unrecognised event type** — see `OUTCOME_BY_EVENT_TYPE`.
 *
 * It DOES throw on a body that is not a PayMongo event at all (not JSON, or
 * carrying no event id), and that is a different thing: `providerEventId` is
 * the idempotency key, so an event with no id cannot be de-duplicated and
 * must not be stored under an empty string. The route turns that into a 400
 * with nothing written, which is the right answer for a body that only a
 * broken signer could have produced.
 */
export function parsePaymongoEvent(rawBody: Buffer): ParsedPaymentEvent {
  const body = asRecord(JSON.parse(rawBody.toString('utf8')) as unknown);
  const data = asRecord(body?.data);
  const eventId = asString(data?.id);
  if (!eventId) {
    throw new Error('PayMongo event carries no id, so it cannot be de-duplicated');
  }

  const eventAttributes = asRecord(data?.attributes);
  const providerType = asString(eventAttributes?.type) ?? 'unknown';
  const resource = asRecord(eventAttributes?.data);
  const payment = findPaymentResource(resource);
  const paymentAttributes = asRecord(payment?.attributes);

  const amount = paymentAttributes?.amount;

  return {
    providerEventId: eventId,
    providerType,
    outcome: OUTCOME_BY_EVENT_TYPE[providerType] ?? 'ignored',
    bookingRef: findBookingRef(resource) ?? findBookingRef(payment),
    /*
     * PayMongo's `amount` is ALREADY IN CENTAVOS — ₱1,890.00 is 189000 —
     * which is the same unit this codebase uses everywhere (Global
     * Constraints: money is integer centavos, DB, API and logic). So there
     * is NO conversion here and none is missing: not ×100, not ÷100. The
     * next reader will look for one, which is why this comment is long.
     *
     * Non-integers are refused rather than rounded. A fractional centavo
     * from a payment gateway is not a number to coerce.
     */
    amountCentavos: typeof amount === 'number' && Number.isInteger(amount) ? amount : null,
    providerRef: asString(payment?.id),
    providerStatus: asString(paymentAttributes?.status),
    method: mapPaymongoMethod(
      paymentAttributes?.payment_method_used ??
        asRecord(paymentAttributes?.source)?.type ??
        asRecord(paymentAttributes?.payment_method)?.type,
    ),
  };
}

/* -------------------------------------------------------------------------
 * REST calls — plain `fetch`, Basic auth, no SDK.
 * ---------------------------------------------------------------------- */

/**
 * PayMongo's reasons are a fixed set; ours is free text an admin typed.
 * Map the four exactly, send everything else as `others`, and carry the
 * admin's own words in `notes` so the real reason survives either way.
 */
const PAYMONGO_REFUND_REASONS = new Set([
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'others',
]);

/** PayMongo's error bodies are `{ errors: [{ detail }] }`. Details only — never the body. */
function extractErrorDetail(payload: unknown): string {
  const errors = asRecord(payload)?.errors;
  if (!Array.isArray(errors)) return '';
  return errors
    .map((entry) => asString(asRecord(entry)?.detail))
    .filter((detail): detail is string => detail !== null)
    .join('; ')
    .slice(0, 300);
}

/**
 * The secret key this process would actually authenticate with — the ONE
 * place `env.PAYMONGO_SECRET_KEY` is read and trimmed.
 *
 * Extracted (task A5) because a second reader arrived: `isPaymongoConfigured()`
 * below answers the UI's "may we offer Pay now at all?" question, and it has
 * to agree with `authorization()`'s refusal byte for byte. Two copies of
 * "is there a key" is how a checkout offers a button that throws.
 */
function resolveSecretKey(config: PaymongoConfig = {}): string {
  return (config.secretKey ?? env.PAYMONGO_SECRET_KEY ?? '').trim();
}

/**
 * Is online payment through PayMongo even possible right now?
 *
 * The same question `authorization()` asks before every call, asked ahead of
 * time so a surface can decline to offer what it knows cannot work (task
 * A5: an unset `PAYMONGO_SECRET_KEY` used to be discovered only by a guest
 * clicking "Pay now"). It reads the key but **never returns, logs or
 * otherwise exposes it** — the answer is one boolean, which is the whole
 * point: this value is safe to publish in the public settings payload and
 * the key never is.
 *
 * Read at CALL time, not at module load, so it reflects the environment the
 * request is actually served in.
 */
export function isPaymongoConfigured(): boolean {
  return resolveSecretKey() !== '';
}

export function createPaymongoProvider(config: PaymongoConfig = {}): PaymentProvider {
  const secretKey = resolveSecretKey(config);
  const webhookSecret = (config.webhookSecret ?? env.PAYMONGO_WEBHOOK_SECRET ?? '').trim();
  const doFetch = config.fetchImpl;

  /**
   * Basic auth, PayMongo's documented scheme: the secret key as the
   * username with an empty password. Built per call and never retained
   * anywhere a logger could reach.
   */
  function authorization(): string {
    if (!secretKey) throw new PaymongoNotConfiguredError('PAYMONGO_SECRET_KEY');
    return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
  }

  async function post(path: string, attributes: Record<string, unknown>): Promise<unknown> {
    // `authorization()` first, so a missing key fails before any socket is
    // opened: a misconfigured deploy fails at the first payment, loudly,
    // rather than sending an unauthenticated request to a live gateway.
    const headers = {
      Authorization: authorization(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const response = await (doFetch ?? fetch)(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: { attributes } }),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new PaymongoApiError(response.status, extractErrorDetail(payload));
    }
    return payload;
  }

  return {
    name: 'paymongo',

    async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
      const paymentMethodTypes = input.methods
        .map((method) => PAYMONGO_NAME_BY_METHOD[method])
        .filter((name): name is string => name !== undefined);
      if (paymentMethodTypes.length === 0) {
        throw new Error('No PayMongo payment method types for the requested instruments');
      }

      const payload = await post('/checkout_sessions', {
        line_items: [
          {
            name: input.description,
            /*
             * Centavos, straight through. PayMongo's unit IS centavos and
             * so is ours, so the ONLY correct operation is none — see the
             * long note in `parsePaymongoEvent`. The figure arrives already
             * computed server-side (`CreateCheckoutInput.amountCentavos`);
             * nothing here recomputes or adjusts it.
             */
            amount: input.amountCentavos,
            currency: 'PHP',
            quantity: 1,
          },
        ],
        payment_method_types: paymentMethodTypes,
        description: input.description,
        /*
         * The booking ref twice, on purpose: `metadata.bookingRef` is what
         * `parseEvent` reads first, and `reference_number` is what shows on
         * PayMongo's dashboard, which is where an admin reconciles. Both
         * carry the public ref — never an internal id, never a customer
         * name, never an email (RA 10173: the gateway gets what the payment
         * needs and nothing else).
         */
        reference_number: input.bookingRef,
        metadata: { bookingRef: input.bookingRef },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });

      const data = asRecord(asRecord(payload)?.data);
      const providerRef = asString(data?.id);
      const redirectUrl = asString(asRecord(data?.attributes)?.checkout_url);
      if (!providerRef || !redirectUrl) {
        // Refuse rather than return a half-built result: a checkout with no
        // redirect URL sends the guest nowhere, and one with no provider ref
        // is a charge we could never reconcile.
        throw new PaymongoApiError(200, 'checkout session response had no id or checkout_url');
      }
      return { redirectUrl, providerRef };
    },

    verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
      return verifyPaymongoSignature(rawBody, headers[SIGNATURE_HEADER], webhookSecret);
    },

    parseEvent(rawBody: Buffer): ParsedPaymentEvent {
      return parsePaymongoEvent(rawBody);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const reason = input.reason.trim().toLowerCase();
      const payload = await post('/refunds', {
        // Centavos again, unconverted, for the same reason as above.
        amount: input.amountCentavos,
        payment_id: input.providerRef,
        reason: PAYMONGO_REFUND_REASONS.has(reason) ? reason : 'others',
        notes: input.reason,
      });

      const data = asRecord(asRecord(payload)?.data);
      const providerRef = asString(data?.id);
      const providerStatus = asString(asRecord(data?.attributes)?.status);
      if (!providerRef || !providerStatus) {
        throw new PaymongoApiError(200, 'refund response had no id or status');
      }
      return { providerRef, providerStatus };
    },
  };
}

/** The instance the registry holds. Reads its credentials from `.env` only. */
export const paymongoProvider: PaymentProvider = createPaymongoProvider();
