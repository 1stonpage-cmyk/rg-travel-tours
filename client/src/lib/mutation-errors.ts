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
