/**
 * Owner decision 2026-11-10/11, Task 10: the server refuses to boot if
 * Turnstile is switched on (`TURNSTILE_ENABLED=1`) without both keys it
 * needs. Deliberately a PURE function with no import of `./env` — `env.ts`
 * calls this, so this file must not call back into it (that would be
 * circular) and must be trivially unit-testable without booting the real
 * environment (this repo's own convention — see `dev-reset-staff-password.ts`'s
 * `refuseReason`).
 */
export function assertTurnstileConfigured(env: {
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
}): string | null {
  if (env.TURNSTILE_ENABLED !== '1') return null;
  if (!env.TURNSTILE_SECRET_KEY) {
    return 'TURNSTILE_ENABLED=1 but TURNSTILE_SECRET_KEY is missing.';
  }
  if (!env.VITE_TURNSTILE_SITE_KEY) {
    return 'TURNSTILE_ENABLED=1 but VITE_TURNSTILE_SITE_KEY is missing.';
  }
  return null;
}
