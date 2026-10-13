import { TRPCClientError } from '@trpc/client';

/**
 * A calm, specific message for the shared 5-per-15-min rate limit on
 * `inquiries.create` / `newsletter.subscribe` (server/src/app.ts). A
 * visitor who hits it has usually just double-clicked — this is not the
 * generic failure message.
 */
export const RATE_LIMIT_MESSAGE = 'Too many messages — please try again shortly.';

/** The generic, human fallback for every other mutation failure. */
export const GENERIC_MUTATION_ERROR_MESSAGE =
  'Something went wrong sending this. Please try again, or reach us directly on WhatsApp.';

/**
 * Turns a failed `inquiries.create` / `newsletter.subscribe` mutation into
 * one of two calm, human sentences — never the raw error. Mirrors
 * `QueryBoundary`'s discipline (src/components/common/QueryBoundary.tsx)
 * for the write side: CLAUDE.md forbids rendering a raw error, and BUG-021
 * was a real case where a MySQL error would have echoed a visitor's own
 * email address back to them.
 *
 * `error.data.httpStatus` is reliably `429` for the rate limiter thanks to
 * `lib/trpc.ts`'s `fetchWithNormalizedErrors`, which normalizes the rate
 * limiter's plain-text response into this same shape before tRPC ever
 * tries to parse it as JSON.
 */
export function describeMutationError(error: unknown): string {
  if (error instanceof TRPCClientError && error.data?.httpStatus === 429) {
    return RATE_LIMIT_MESSAGE;
  }
  return GENERIC_MUTATION_ERROR_MESSAGE;
}

/**
 * `describeMutationError` above only ever returns one of two fixed strings
 * — a deliberate scope for `inquiries.create`/`newsletter.subscribe`, which
 * have no other guest-safe message to preserve. The checkout mutations
 * (`checkout.createHold`, `checkout.startPayment`) are different: their
 * router (`server/src/routers/public/checkout.ts`) crafts a SPECIFIC
 * guest-safe sentence for every 4xx it can throw ("This tour is fully
 * booked for that date.", "This booking can no longer be paid online.",
 * "Online payment is temporarily unavailable...") — that router's own doc
 * comment calls picking that sentence its whole job. Collapsing every one
 * of those into one generic line would throw the work away. So: a 429 (and
 * anything 5xx) still goes through `describeMutationError`'s two approved
 * strings, but every other 4xx's OWN message passes through untouched.
 *
 * Shared by `CheckoutPage` (createHold) and `PayNowButton`
 * (components/checkout/PayNowButton.tsx, startPayment) — both talk to the
 * same router and so share the same translation rule (Task 8b).
 */
export function describeCheckoutError(error: unknown): string {
  if (
    error instanceof TRPCClientError &&
    typeof error.data?.httpStatus === 'number' &&
    error.data.httpStatus < 500 &&
    error.data.httpStatus !== 429
  ) {
    return error.message;
  }
  return describeMutationError(error);
}
