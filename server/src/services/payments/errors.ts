/**
 * The payment seam's errors (plan Task 13).
 *
 * All three are REFUSALS, not fallbacks. Every one of them is thrown where
 * the alternative would be to guess which gateway a request meant — and
 * guessing, in a payments path, means routing money through the wrong
 * processor or marking a booking paid on an unverified event.
 *
 * Messages carry a sanitised provider name and never a secret: no API key,
 * no webhook secret, no raw request body, no DATABASE_URL.
 */

/**
 * Provider names reach us from URLs (`/api/webhooks/:provider`) and from
 * settings, so they are untrusted strings by the time an error quotes one.
 * Strip everything but word characters and dashes and cap the length, so a
 * crafted name cannot forge extra lines in a log.
 */
function safeName(name: unknown): string {
  return String(name)
    .replace(/[^\w-]/g, '?')
    .slice(0, 40);
}

/**
 * No implementation is registered under this name.
 *
 * Thrown for a typo (`stripe`), for an empty string, for a prototype key
 * (`__proto__`), and for `manual` — which is a real `payments.provider`
 * value but not a gateway: a QR transfer an admin verified by hand has
 * nothing to call.
 */
export class UnknownProviderError extends Error {
  readonly provider: string;

  constructor(name: unknown) {
    const provider = safeName(name);
    super(`Unknown payment provider: "${provider}"`);
    this.name = 'UnknownProviderError';
    this.provider = provider;
  }
}

/**
 * The implementation exists but is not switched on — currently Xendit, which
 * is planned, not enabled (B1a), and PayMongo until Task 16 fills it in.
 *
 * A stub must be incapable of marking anything paid, so every method of a
 * not-enabled provider throws this rather than returning a neutral-looking
 * value.
 */
export class ProviderNotEnabledError extends Error {
  readonly provider: string;

  constructor(name: unknown) {
    const provider = safeName(name);
    super(`Payment provider "${provider}" is not enabled`);
    this.name = 'ProviderNotEnabledError';
    this.provider = provider;
  }
}

/**
 * No active gateway has been configured in settings, so there is nothing to
 * charge through. Fails closed: `getActiveProvider()` throws this instead of
 * falling back to a default gateway, because a default here would silently
 * send live money somewhere nobody chose.
 */
export class ActiveProviderNotConfiguredError extends Error {
  constructor(detail = 'no active payment provider is configured') {
    super(`Cannot resolve the active payment provider: ${detail}`);
    this.name = 'ActiveProviderNotConfiguredError';
  }
}
