/**
 * `lib/mutation-errors.ts` on its own (task A5).
 *
 * `describeCheckoutError` is the single translation rule both checkout
 * surfaces share — `CheckoutPage`'s `createHold` and `<PayNowButton>`'s
 * `startPayment`. Its job is to pick, per refusal, between the router's own
 * guest-safe sentence and the two approved fallbacks, and the line it draws
 * is HTTP status plus code.
 *
 * The bug this file pins: `SERVICE_UNAVAILABLE` is HTTP **503**, so the old
 * `httpStatus < 500` rule swallowed `startPayment`'s
 * `gatewayUnavailable()` message — "Online payment is temporarily
 * unavailable…", written for a guest by the same router that writes the 4xx
 * ones — and showed the generic "Something went wrong sending this" line
 * instead. That is the exact sentence the owner says must never stand in for
 * this case, and it was reproduced in a browser against a dev `.env` with a
 * blank `PAYMONGO_SECRET_KEY` before the fix.
 *
 * The other half matters as much: a real `INTERNAL_SERVER_ERROR` is a crash,
 * its message is whatever threw, and it must STILL fall through. A fix that
 * widened the threshold past 500 would pass the first test here and fail the
 * second.
 *
 * Errors are built with `TRPCClientError.from`, which is what `@trpc/client`
 * itself uses on a JSON-RPC error response, so `error.data` is populated the
 * way a real refusal populates it.
 */
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import {
  describeCheckoutError,
  describeMutationError,
  GENERIC_MUTATION_ERROR_MESSAGE,
  RATE_LIMIT_MESSAGE,
} from '@/lib/mutation-errors';

/** A refusal exactly as `server/src/trpc.ts`'s `errorFormatter` shapes it. */
function refusal(code: string, httpStatus: number, message: string): TRPCClientError<never> {
  return TRPCClientError.from({
    error: { message, code: -32600, data: { code, httpStatus } },
  } as never);
}

/**
 * `server/src/routers/public/checkout.ts`'s `gatewayUnavailable()`, verbatim
 * enough to be recognisable. The point is the SHAPE — 503 carrying prose a
 * guest may read — not the exact wording, which the router owns.
 */
const GATEWAY_DOWN =
  'Online payment is temporarily unavailable. Please try again shortly, or contact us to pay another way.';

describe('describeCheckoutError — which refusals keep their own message', () => {
  it('passes a SERVICE_UNAVAILABLE (503) message through, never the generic line', () => {
    const message = describeCheckoutError(refusal('SERVICE_UNAVAILABLE', 503, GATEWAY_DOWN));
    expect(message).toBe(GATEWAY_DOWN);
    expect(message).not.toBe(GENERIC_MUTATION_ERROR_MESSAGE);
  });

  it('still hides an INTERNAL_SERVER_ERROR (500) behind the generic line', () => {
    // A crash's message is whatever threw — a guest's own email address, in
    // BUG-021's case. It is never guest-safe copy, whatever the status.
    expect(
      describeCheckoutError(
        refusal('INTERNAL_SERVER_ERROR', 500, "Duplicate entry 'juan@example.com' for key"),
      ),
    ).toBe(GENERIC_MUTATION_ERROR_MESSAGE);
  });

  it("keeps passing a 4xx's own sentence through", () => {
    const soldOut = 'This tour is fully booked for that date.';
    expect(describeCheckoutError(refusal('CONFLICT', 409, soldOut))).toBe(soldOut);
  });

  it('still answers a 429 with the rate-limit sentence, not the server message', () => {
    expect(describeCheckoutError(refusal('TOO_MANY_REQUESTS', 429, 'slow down'))).toBe(
      RATE_LIMIT_MESSAGE,
    );
  });

  it('falls through for anything that is not a TRPCClientError at all', () => {
    expect(describeCheckoutError(new Error('boom'))).toBe(GENERIC_MUTATION_ERROR_MESSAGE);
  });
});

/**
 * `describeMutationError` is deliberately NOT widened by any of the above:
 * `inquiries.create` / `newsletter.subscribe` have no guest-safe message to
 * preserve, so a 503 there is still the generic line.
 */
describe('describeMutationError — unchanged, two strings only', () => {
  it('answers a SERVICE_UNAVAILABLE with the generic line', () => {
    expect(describeMutationError(refusal('SERVICE_UNAVAILABLE', 503, GATEWAY_DOWN))).toBe(
      GENERIC_MUTATION_ERROR_MESSAGE,
    );
  });
});
