import { ProviderNotEnabledError } from './errors';
import type { PaymentProvider } from './types';

/**
 * Xendit is planned, not enabled (B1a). Every method throws, loudly.
 *
 * It exists so the seam is real rather than theoretical: the registry, the
 * webhook route and the settings enum all carry a second provider from day
 * one, so adding the real implementation is filling this file in — not
 * discovering that the abstraction never worked.
 *
 * It must NEVER be able to mark anything paid. There is a test for that
 * (`payment-registry.test.ts`). Note there is no Xendit SDK and no Xendit
 * API call anywhere in this file: when this is implemented it will be plain
 * `fetch` against documented REST endpoints, like PayMongo.
 */
function notEnabled(): never {
  throw new ProviderNotEnabledError('xendit');
}

export const xenditProvider: PaymentProvider = {
  name: 'xendit',
  createCheckout: async () => notEnabled(),
  // Not "return false" — a provider that is switched off has no business
  // answering a signature question at all, and a silent false would look
  // like a forged webhook rather than a misconfiguration.
  verifyWebhook: () => notEnabled(),
  parseEvent: () => notEnabled(),
  refund: async () => notEnabled(),
};
