/**
 * The SMS seam (Week 7 Task 14, 7E) — **an interface, a registry and a null
 * provider, and nothing that sends anything.**
 *
 * Owner decision 2026-10-23, Q6: "SMS is not paid for; email only this week;
 * the interface is built switched off." BUILD_SPEC §11 calls for "optional SMS
 * behind a provider interface", and this is that interface, built now so the
 * day a provider is bought is a day of adding one `Map` entry rather than a
 * day of threading a new concept through the notification layer.
 *
 * ## Shaped on `services/payments/registry.ts`, and simpler
 *
 * Same two load-bearing properties as the payment registry:
 *
 *  - **A `Map`, not an object literal.** `lookup['__proto__']` on a plain
 *    object returns `Object.prototype` — truthy, not a provider, and it sails
 *    straight past an `if (!impl) throw`. `constructor` and `toString` do the
 *    same. A `Map` has no inherited keys, so a name nobody registered has
 *    exactly one answer: `undefined`.
 *  - **It REFUSES an unknown name rather than defaulting.** The payment
 *    registry's reason is that a typo must not route money through whichever
 *    gateway is first in the table; here it is that a typo must not route a
 *    guest's mobile number through a provider nobody chose.
 *
 * What it does NOT copy is the settings-block indirection. There is no
 * per-admin "active SMS provider" to read: one environment variable chooses,
 * which is the whole configuration surface this week.
 *
 * ## The default is a provider that does nothing
 *
 * With `SMS_PROVIDER` unset — the committed default, and the state every
 * environment is in today — `getSmsProvider()` returns `nullSmsProvider`,
 * which logs a line and returns. It cannot throw, exactly as `notify()` cannot
 * when SMTP is unconfigured, and for the same §11 reason: a notification layer
 * must never be able to fail a booking.
 *
 * ## What the log may contain
 *
 * That an SMS was not sent, and nothing else. **Never the phone number and
 * never the message body** — logs are read by anyone with server access and
 * are often shipped to a third-party aggregator, and a guest's mobile number
 * is personal data under RA 10173. `services/notify/index.ts` keeps the same
 * rule for the same reason.
 */
import { env } from '../../env';

/** One outbound text. Deliberately the smallest shape a provider could need. */
export interface SmsMessage {
  /** E.164, e.g. `+639171234567`. Normalising belongs to the caller that gains one. */
  to: string;
  text: string;
}

/**
 * What any SMS provider must offer. One method, like `MailTransport`: a
 * narrow interface is one a test can stand in for in three lines, and one a
 * real provider cannot quietly widen.
 */
export interface SmsProvider {
  readonly name: string;
  /** Resolves when the provider has accepted the message, or rejects. */
  send(message: SmsMessage): Promise<void>;
}

/** Thrown for a configured name nobody registered. Fails closed. */
export class UnknownSmsProviderError extends Error {
  constructor(name: string) {
    super(`Unknown SMS provider "${name}" — SMS_PROVIDER names no registered provider.`);
    this.name = 'UnknownSmsProviderError';
  }
}

/**
 * The provider in force when no SMS provider is configured: it logs and sends
 * nothing.
 *
 * Exported so a test can drive it directly, and so a future caller can assert
 * on identity (`provider === nullSmsProvider`) rather than on a magic name.
 */
export const nullSmsProvider: SmsProvider = {
  name: 'null',
  send: async (): Promise<void> => {
    // No `to`, no `text` — see the module note on what a log may contain.
    console.warn('[sms] not sent — no SMS provider is configured (SMS is off, owner Q6)');
  },
};

/**
 * Every real provider, by the name `SMS_PROVIDER` would carry.
 *
 * **Empty, deliberately** (Q6). The null provider is NOT registered here: it
 * is what "unconfigured" selects, not a name anybody should be able to
 * configure, and putting it in the table would make `SMS_PROVIDER=null` a
 * valid-looking setting that means the same as leaving it blank.
 */
const PROVIDERS = new Map<string, SmsProvider>();

/**
 * The registered provider names, for the test that pins "nothing is
 * registered this week". Exported for that, and so a reader can see the
 * registry is empty without opening it.
 */
export const SMS_PROVIDER_NAMES: readonly string[] = [...PROVIDERS.keys()];

/**
 * The provider for a configured name — the null provider when there is none,
 * a refusal when the name is unknown.
 *
 * Takes the configured value as a PARAMETER so the refusal path is testable
 * without rewriting `process.env` mid-suite, the same discipline every job
 * here follows with its clock. `getSmsProvider()` below is the one caller that
 * supplies the real setting, so nothing in the app chooses its own provider.
 */
export function selectSmsProvider(configured: string | undefined): SmsProvider {
  const name = configured?.trim();
  if (!name) return nullSmsProvider;

  const impl = PROVIDERS.get(name);
  if (!impl) throw new UnknownSmsProviderError(name);
  return impl;
}

/** The provider this deployment is configured for. */
export function getSmsProvider(): SmsProvider {
  return selectSmsProvider(env.SMS_PROVIDER);
}
