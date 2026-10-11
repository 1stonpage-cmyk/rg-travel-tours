/**
 * Task 13 of the core-schema plan: the `PaymentProvider` seam.
 *
 * Phase 3's design rule is that nothing outside
 * `server/src/services/payments/` may name a gateway. Task 12 proved the
 * `payments` TABLE holds no gateway-specific column; this file pins the same
 * property for the CODE — the registry is the one place a provider name
 * becomes an implementation, and it must fail closed.
 *
 * Two properties matter here and both are security properties, not
 * ergonomics:
 *
 *  1. **An unknown provider is refused, never substituted.** A typo in a
 *     webhook URL must not route money through whichever gateway happens to
 *     be first in a lookup table. `'__proto__'` is in the list on purpose:
 *     on a plain object literal, `map['__proto__']` returns
 *     `Object.prototype`, which is truthy and would sail straight past a
 *     naive `if (!impl) throw`. That is why the registry is a `Map`.
 *
 *  2. **The Xendit stub cannot mark anything paid.** It exists so the seam is
 *     real from day one rather than theoretical, and every method throws.
 *
 * No database is touched by this file.
 */
import { describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDERS } from '../db/schema';
import {
  ActiveProviderNotConfiguredError,
  ProviderNotEnabledError,
  UnknownProviderError,
} from '../services/payments/errors';
import { getActiveProvider, getProvider } from '../services/payments/registry';

describe('provider registry', () => {
  it('returns an implementation for a known provider', () => {
    expect(getProvider('paymongo').name).toBe('paymongo');
  });

  it('REFUSES an unknown provider rather than defaulting to one', () => {
    // Fail closed: a typo in a webhook URL must not silently route money
    // through whichever gateway happens to be first in the map.
    expect(() => getProvider('stripe' as never)).toThrow(UnknownProviderError);
    expect(() => getProvider('' as never)).toThrow(UnknownProviderError);
    // A plain-object lookup table answers this one with Object.prototype.
    expect(() => getProvider('__proto__' as never)).toThrow(UnknownProviderError);
    expect(() => getProvider('constructor' as never)).toThrow(UnknownProviderError);
  });

  it('exposes Xendit, but every method throws ProviderNotEnabledError', async () => {
    const xendit = getProvider('xendit');
    expect(xendit.name).toBe('xendit');
    await expect(xendit.createCheckout({} as never)).rejects.toThrow(ProviderNotEnabledError);
    await expect(xendit.refund({} as never)).rejects.toThrow(ProviderNotEnabledError);
    expect(() => xendit.verifyWebhook(Buffer.from(''), {})).toThrow(ProviderNotEnabledError);
    expect(() => xendit.parseEvent(Buffer.from(''))).toThrow(ProviderNotEnabledError);
  });

  it('has an implementation for every gateway the payments enum allows, each answering to its own name', () => {
    // `manual` is not a gateway — a hand-verified QR transfer has nothing to
    // call — so it is deliberately absent. Every OTHER value of
    // PAYMENT_PROVIDERS must resolve, so adding an enum value without a file
    // in services/payments/ is caught here rather than at the first webhook.
    // Asserting `.name` also guards the one transcription risk a Map has: a
    // key mapped to the wrong implementation would route one gateway's
    // webhooks into another gateway's code.
    for (const name of PAYMENT_PROVIDERS) {
      if (name === 'manual') continue;
      expect(getProvider(name).name).toBe(name);
    }
  });

  it('refuses `manual` — a hand-verified payment has no gateway to call', () => {
    expect(() => getProvider('manual')).toThrow(UnknownProviderError);
  });
});

describe('getActiveProvider', () => {
  it('takes no argument — a caller cannot choose its own processor', () => {
    expect(getActiveProvider.length).toBe(0);
  });

  it('fails closed while the active gateway is unconfigured', async () => {
    // The `payments` settings block does not exist yet (see registry.ts).
    // Until it does, this must REFUSE rather than guess a gateway.
    await expect(getActiveProvider()).rejects.toThrow(ActiveProviderNotConfiguredError);
  });
});
