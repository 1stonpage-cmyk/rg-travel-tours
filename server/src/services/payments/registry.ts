/**
 * The one place a provider name becomes code (plan Task 13).
 *
 * Everything else — routers, the webhook route, `recordPayment()` — asks this
 * registry for a `PaymentProvider` and talks to the interface. That is what
 * makes "nothing outside services/payments/ may name a gateway" affordable
 * rather than aspirational.
 */
import { ActiveProviderNotConfiguredError, UnknownProviderError } from './errors';
import { paymongoProvider } from './paymongo';
import { xenditProvider } from './xendit';
import type { PaymentProvider, ProviderName } from './types';

/**
 * The plan's Task 13 interface lists these alongside the two functions, and
 * callers reach for them on the same import as `getProvider`. `./errors` is
 * still where they are defined.
 */
export {
  ActiveProviderNotConfiguredError,
  ProviderNotEnabledError,
  UnknownProviderError,
} from './errors';

/**
 * A `Map`, not an object literal: `map['__proto__']` on a plain object
 * returns `Object.prototype` — truthy, not a provider, and it would sail
 * straight past an `if (!impl) throw` check. `constructor`, `toString` and
 * friends do the same. A `Map` has no inherited keys, so a name nobody
 * registered has exactly one answer: `undefined`.
 *
 * `manual` is absent on purpose. It is a valid `payments.provider` value —
 * a QR transfer an admin verified by hand — but it is not a gateway, so
 * there is nothing to implement and nothing to call. Asking for it fails
 * closed, like any other unregistered name.
 */
const PROVIDERS = new Map<ProviderName, PaymentProvider>([
  ['paymongo', paymongoProvider],
  ['xendit', xenditProvider],
]);

/**
 * The implementation registered under `name`, or a refusal.
 *
 * REFUSES rather than defaults: a typo in a webhook URL must not route money
 * through whichever gateway happens to be first in the table.
 */
export function getProvider(name: ProviderName): PaymentProvider {
  const impl = PROVIDERS.get(name);
  if (!impl) throw new UnknownProviderError(name);
  return impl;
}

/**
 * The gateway the admin has switched on, from SETTINGS — never from the
 * request, so a caller cannot choose its own processor. It takes no argument
 * for exactly that reason, and that is a test.
 *
 * **Not yet wired, and it fails closed until it is.** The `settings` table
 * has no `payments` block today (`server/src/content/settings-schema.ts`
 * holds fifteen keys and none of them carries an active gateway), and
 * inventing a settings key is a settings-schema + seed + fixtures change
 * that belongs to the task which first needs a live checkout, not to the
 * task that builds the seam. So this refuses instead of guessing a gateway.
 *
 * What it needs, when a caller finally needs it — three edits, no new
 * concept:
 *
 *  1. `SETTING_SCHEMAS.payments` in `content/settings-schema.ts`:
 *     `z.object({ activeProvider: z.enum(['paymongo', 'xendit']) })` —
 *     `manual` is NOT a member, because a hand-verified payment has no
 *     gateway to call.
 *  2. A seeded `payments` row in `db/seed-data.ts` (`readSettings()` throws
 *     on a missing key, so the seed and the settings fixtures must gain it
 *     together).
 *  3. The two lines below, replacing the throw:
 *     `const block = await readSettingBlock('payments');`
 *     `return getProvider(block.activeProvider);`
 */
export async function getActiveProvider(): Promise<PaymentProvider> {
  throw new ActiveProviderNotConfiguredError(
    'the settings table has no `payments` block yet (plan Task 13)',
  );
}
