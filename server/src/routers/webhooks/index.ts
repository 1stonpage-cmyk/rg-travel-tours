/**
 * `POST /api/webhooks/:provider` — the one internet-facing path that can
 * move money (plan Task 15).
 *
 * Anyone on the internet can POST here. Everything below therefore FAILS
 * CLOSED at every step, in this order, and each refusal happens before the
 * next step's work:
 *
 *   1. unknown provider            -> 404, before the body is read
 *   2. bad or unverifiable signature -> 400, nothing stored
 *      provider switched off        -> 503, nothing stored
 *   3. unparseable event           -> 400, nothing stored
 *   4. event already seen          -> 200, and NOTHING else happens
 *   5. `paid` / `refunded`         -> `recordPayment()`, the only writer
 *   6. stamp `processed_at`        -> 200
 *
 * **It is not this route's job to decide anything about money.** It
 * verifies, de-duplicates, and hands the facts to `recordPayment()`, which
 * re-derives the expected amount from the booking and refuses anything else
 * (Task 14). The amount in a webhook body is a claim by whoever sent it,
 * never a figure this route trusts.
 *
 * **The responses carry nothing.** A bare `{ ok: true }` / `{ ok: false }`,
 * never an error detail, a stack, a provider name or the parsed event: the
 * tRPC `errorFormatter` that scrubs the rest of this server (BUG-102) does
 * not cover this route, it is plain Express, and the caller here is
 * untrusted. Diagnostics go to the server log (error NAME and event id
 * only — never the body, never a signature, never a booking ref) and to the
 * `payment_events` row, which is what an admin reconciles against.
 */
import express, { Router, type Request, type Response } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { bookings, paymentEvents } from '../../db/schema';
import { ProviderNotEnabledError, UnknownProviderError } from '../../services/payments/errors';
import { getProvider } from '../../services/payments/registry';
import { recordPayment } from '../../services/payments/record-payment';
import type {
  ParsedPaymentEvent,
  PaymentProvider,
  ProviderName,
} from '../../services/payments/types';

/**
 * A gateway retries until it gets a 2xx, so a webhook body is small and
 * repeated. 100kb (body-parser's default) is far more than any payment
 * event needs, and leaving the default means an oversized body is refused
 * by the parser rather than buffered into this process's memory.
 */
const rawWebhookBody = express.raw({ type: '*/*' });

/**
 * `manual` is a real `payments.provider` value and a real `ProviderName` —
 * a QR transfer an admin verified by hand — but it is NOT a gateway: there
 * is no secret to verify a signature against and no event to parse, which
 * is why the registry deliberately does not resolve it (Task 13). So
 * `/api/webhooks/manual` is a 404 like any other unknown name, and this
 * explicit branch exists so that is a decision rather than a side effect of
 * `getProvider()` happening to throw.
 */
function resolveWebhookProvider(name: string): PaymentProvider {
  if (name === 'manual') throw new UnknownProviderError(name);
  // Safe to narrow: `getProvider` is a Map lookup that throws
  // UnknownProviderError for every name it does not hold, so an arbitrary
  // URL segment cannot resolve to a provider.
  return getProvider(name as ProviderName);
}

/**
 * Node gives most repeated headers back comma-joined, but a few arrive as
 * an array; `verifyWebhook` takes flat strings. Taking the first value is
 * the conservative reading — a request carrying two signature headers does
 * not get to have whichever one happens to match.
 */
function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}

/**
 * The verified body, stored verbatim for reconciliation, or null if it is
 * not JSON after all.
 *
 * It is the GATEWAY'S event, not ours: it holds ids, amounts and statuses.
 * The signature header is not stored with it, and no gateway puts a card
 * number or an e-wallet credential in a webhook — if one ever did, this is
 * the line that would have to filter it (CLAUDE.md: never store card
 * numbers, CVV or e-wallet credentials).
 */
function jsonPayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Records what a verified event says happened, through the ONLY function
 * allowed to mark a booking paid.
 *
 * Three things must be present before it can: which booking, how much, and
 * which instrument. Any of them missing is a refusal, not a default —
 * `payments.method` is NOT NULL and guessing `card` would put a fiction in
 * the one column §9's revenue-by-method report reads.
 *
 * Throws on anything it cannot apply. The caller leaves `processed_at` NULL
 * in that case, so the stored event stays visible as unreconciled work.
 */
async function applyEvent(provider: ProviderName, event: ParsedPaymentEvent): Promise<void> {
  if (event.bookingRef === null || event.amountCentavos === null || event.method === null) {
    throw new Error('the event does not say which booking, how much, or by which method');
  }

  const [booking] = await getDb()
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.ref, event.bookingRef))
    .limit(1);
  if (!booking) throw new Error('the event names a booking this database does not have');

  await recordPayment({
    bookingId: booking.id,
    /*
     * NOTE, and it is a live gap rather than a decision made here: §6 lets a
     * gateway webhook CONFIRM a refund an admin started, but Task 14's
     * `recordPayment()` refuses every refund whose actor is not a `user`
     * (`RefundNotAdminInitiatedError`) — there is no confirm path yet. So a
     * `refunded` event today is stored, left unprocessed and reported as
     * unapplied. That fails closed, which is the right side to fail on, and
     * it is flagged for the task that builds the admin refund flow.
     */
    type: event.outcome === 'refunded' ? 'refund' : 'payment',
    provider,
    method: event.method,
    /*
     * Passed, never trusted: `recordPayment()` re-derives what the booking
     * expects from the frozen `price_snapshot` and refuses any other figure.
     * This route does no arithmetic on money at all.
     */
    amountCentavos: event.amountCentavos,
    providerRef: event.providerRef,
    providerStatus: event.providerStatus,
    /*
     * `provider`, never `system` (Q10): `system` means a cron job, and "the
     * cron expired this hold" and "the gateway confirmed this payment" must
     * not collapse into one actor in the money trail. The gateway's name
     * goes in the audit row's `data.provider`, which `recordPayment()`
     * writes.
     */
    actor: { type: 'provider', id: null },
  });
}

async function handleWebhook(req: Request, res: Response): Promise<void> {
  /* 1. WHO is this for? Resolved first, and nothing reads `req.body` until
   * it has: an unknown name gets a 404 and no verification, no parsing and
   * no row. A typo in a webhook URL must never route money through
   * whichever gateway happens to be first in the registry. */
  let provider: PaymentProvider;
  try {
    /*
     * Express 5 types a route param as `string | string[]`. An array means
     * the segment matched more than once, which no gateway URL does — so it
     * is not a provider name, and the empty string sends it down the same
     * 404 as any other name the registry does not hold. Fail closed rather
     * than picking one of them.
     */
    const named = req.params.provider;
    provider = resolveWebhookProvider(typeof named === 'string' ? named : '');
  } catch (error) {
    if (error instanceof UnknownProviderError) {
      res.status(404).json({ ok: false });
      return;
    }
    throw error;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  /* 2. IS IT REALLY FROM THEM? The single control standing between the
   * internet and a booking marked paid. False, a throw, a missing header
   * and an unreadable secret are all the same answer: 400, nothing stored.
   * A provider that is switched off is a 503 — a misconfiguration on our
   * side, not a forged request — and stores nothing either. */
  let verified: boolean;
  try {
    verified = provider.verifyWebhook(rawBody, flattenHeaders(req.headers));
  } catch (error) {
    const notEnabled = error instanceof ProviderNotEnabledError;
    res.status(notEnabled ? 503 : 400).json({ ok: false });
    return;
  }
  if (!verified) {
    res.status(400).json({ ok: false });
    return;
  }

  /* 3. WHAT does it say? Only ever called on a body step 2 accepted. */
  let event: ParsedPaymentEvent;
  try {
    event = provider.parseEvent(rawBody);
  } catch {
    res.status(400).json({ ok: false });
    return;
  }

  /*
   * 4. HAVE WE SEEN IT? The idempotency gate is the `(provider,
   * provider_event_id)` UNIQUE index — this INSERT — and not a SELECT
   * first, which races: two deliveries of one event arriving together both
   * read "not seen", both proceed, and the booking is paid twice. Only the
   * index can decide that atomically, so this asks it and reacts.
   *
   * A replay is acknowledged (200, so the gateway stops retrying) and
   * NOTHING else happens: no `recordPayment()`, no second `processed_at`.
   */
  let eventRowId: number;
  try {
    const [inserted] = await getDb()
      .insert(paymentEvents)
      .values({
        provider: provider.name,
        providerEventId: event.providerEventId,
        type: event.providerType,
        payload: jsonPayload(rawBody),
      });
    eventRowId = Number(inserted.insertId);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(200).json({ ok: true });
      return;
    }
    throw error;
  }

  try {
    /* 5. Only an outcome that moved money reaches `recordPayment()`.
     * `failed` and `ignored` are stored, stamped and acknowledged. */
    if (event.outcome === 'paid' || event.outcome === 'refunded') {
      await applyEvent(provider.name, event);
    }

    /* 6. Stamped only once the work above actually succeeded, so a NULL
     * `processed_at` always means "stored, not acted on" — the column the
     * `payment_events_unprocessed_idx` index exists to scan. */
    await getDb()
      .update(paymentEvents)
      .set({ processedAt: new Date() })
      .where(eq(paymentEvents.id, eventRowId));

    res.status(200).json({ ok: true });
  } catch (error) {
    /*
     * The event row stays, unprocessed, and the response says nothing. The
     * log line carries the error's NAME and the event id — never the
     * message (which quotes amounts and the booking ref, and a ref is half
     * a portal credential), never the body, never a header.
     */
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error(
      `[webhook] ${provider.name} event ${eventRowId} stored but NOT applied (${name}).`,
    );
    res.status(500).json({ ok: false });
  }
}

/**
 * The webhook router. Mount it with no body parser above it — see the
 * comment block in `app.ts`; `verifyWebhook` needs the exact bytes the
 * gateway signed, and a JSON parser that has already consumed them makes
 * every signature check unverifiable.
 */
export function createWebhookRouter(): Router {
  const router = Router();
  // `express.raw` sits on the route rather than the router so it is
  // impossible to add a sibling route here that silently gets no raw body.
  router.post('/:provider', rawWebhookBody, handleWebhook);
  return router;
}
