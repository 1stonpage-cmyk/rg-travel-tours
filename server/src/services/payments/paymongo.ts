import { ProviderNotEnabledError } from './errors';
import type { PaymentProvider } from './types';

/**
 * PLACEHOLDER — **Task 16 writes the real implementation.**
 *
 * Task 13 builds the seam, and the registry has to be able to name PayMongo
 * for the seam to exist at all; this file is the minimum that makes that
 * true. Deliberately NOT a half-real implementation: the real one turns on
 * `verifyWebhook()`, which is the single control stopping anyone who can
 * reach the webhook URL from marking a booking paid, and that has to be
 * written and tested as its own piece of work rather than sketched here.
 *
 * Until then every method throws, exactly like the Xendit stub, so nothing
 * in this file can mark anything paid. `name` is real, because the registry
 * key and the implementation must agree.
 *
 * When Task 16 lands: no SDK (none is allowed), plain `fetch` against
 * documented REST endpoints, secret key read from `.env` only, and
 * `verifyWebhook` comparing the signature with a timing-safe compare.
 */
function notImplementedYet(): never {
  throw new ProviderNotEnabledError('paymongo');
}

export const paymongoProvider: PaymentProvider = {
  name: 'paymongo',
  createCheckout: async () => notImplementedYet(),
  verifyWebhook: () => notImplementedYet(),
  parseEvent: () => notImplementedYet(),
  refund: async () => notImplementedYet(),
};
