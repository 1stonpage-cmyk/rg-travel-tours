import { describe, expect, it } from 'vitest';
import { assertTurnstileConfigured } from '../services/turnstile-guard';

/**
 * Owner decision 2026-11-10/11, Task 10: the server refuses to boot if
 * Turnstile is switched on without both keys it needs. A pure function,
 * tested directly — mirrors `dev-reset-staff-password.ts`'s `refuseReason`
 * pattern (this repo's own convention for "fail closed at startup" logic:
 * extract a pure function rather than test env.ts's own module-import throw).
 */
describe('assertTurnstileConfigured', () => {
  it('is fine when Turnstile is off, however the keys are set', () => {
    expect(assertTurnstileConfigured({})).toBeNull();
    expect(
      assertTurnstileConfigured({ TURNSTILE_ENABLED: '0', TURNSTILE_SECRET_KEY: undefined }),
    ).toBeNull();
  });

  it('refuses when enabled with no secret key', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }),
    ).toMatch(/TURNSTILE_SECRET_KEY/);
  });

  it('refuses when enabled with no site key', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        TURNSTILE_SECRET_KEY: 'secret',
      }),
    ).toMatch(/VITE_TURNSTILE_SITE_KEY/);
  });

  it('is fine when enabled with both keys present', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        TURNSTILE_SECRET_KEY: 'secret',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }),
    ).toBeNull();
  });
});
