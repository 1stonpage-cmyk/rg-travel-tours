import { describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../services/turnstile';
import { env } from '../env';

/**
 * `verifyTurnstile()` fails closed. The deterministic branches (off,
 * missing token, non-ok response, success:false, network error) are
 * proven with an INJECTED fetch stub — no real network call, so this suite
 * stays hermetic and fast. A separate real-network test below proves the
 * end-to-end wiring against Cloudflare's own documented test keys.
 */
describe('verifyTurnstile — deterministic branches (stubbed fetch)', () => {
  it('passes with no check at all when Turnstile is off', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = undefined;
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: undefined, remoteIp: undefined }, fetchSpy as never),
      ).resolves.toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  it('refuses a missing token when enabled, with no network call', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: undefined, remoteIp: '203.0.113.1' }, fetchSpy as never),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  /**
   * `assertTurnstileConfigured` is what makes "enabled with no secret"
   * unreachable in a real deploy — but this function must not rely on that
   * being true. Without this explicit check, a missing secret would still
   * happen to refuse (Cloudflare answers `success: false` for an empty
   * `secret` field), making the fail-closed property true by ACCIDENT, not
   * by construction. This test is what pins it as construction: it proves
   * refusal with NO network call, the same way the missing-token test above
   * does, rather than relying on Cloudflare's own error semantics.
   */
  it('refuses (fails closed) when enabled with no secret key configured, with no network call', async () => {
    const originalEnabled = env.TURNSTILE_ENABLED;
    const originalSecret = env.TURNSTILE_SECRET_KEY;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchSpy as never),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
    }
  });

  /*
   * Deviation from the brief's verbatim code (noted in task-10-report.md):
   * the brief's own version of this test left TURNSTILE_SECRET_KEY unset.
   * In THIS repo's ambient test env that key is already unset, so the
   * earlier `if (!env.TURNSTILE_SECRET_KEY) return false;` guard answered
   * `false` before ever reaching the mocked fetch — the test passed, but
   * for the wrong reason, and would still pass with the fetch/parse logic
   * deleted entirely (proven: mutating the code below this guard did not
   * redden it). Setting the secret key here, and asserting the stub was
   * actually called, is what makes this test exercise the branch it is
   * named for.
   */
  it('refuses when Cloudflare answers success:false', async () => {
    const originalEnabled = env.TURNSTILE_ENABLED;
    const originalSecret = env.TURNSTILE_SECRET_KEY;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = 'test-secret';
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    try {
      await expect(
        verifyTurnstile({ token: 'bad-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
    }
  });

  it('refuses (fails closed) on a network error', async () => {
    const originalEnabled = env.TURNSTILE_ENABLED;
    const originalSecret = env.TURNSTILE_SECRET_KEY;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = 'test-secret';
    const fetchStub = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
    }
  });

  it('refuses (fails closed) on a non-OK HTTP response', async () => {
    const originalEnabled = env.TURNSTILE_ENABLED;
    const originalSecret = env.TURNSTILE_SECRET_KEY;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = 'test-secret';
    const fetchStub = vi.fn().mockResolvedValue({ ok: false });
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
    }
  });
});

/**
 * Real network call to Cloudflare's siteverify, using its OFFICIAL,
 * documented testing keys — this is the intended use of those keys, not a
 * workaround. GATED behind `TURNSTILE_LIVE_TEST=1` (NOT a TURNSTILE_ENABLED
 * check — this is a test-suite-hermeticity flag, unrelated to the feature
 * flag) so the default `pnpm test` — check #3 of the five this plan runs
 * after EVERY task, including the 14 after this one — never depends on
 * egress from whatever machine or sandbox runs it. Run manually with
 * `TURNSTILE_LIVE_TEST=1 pnpm --filter @rg/server test -- turnstile.test`
 * at least once per this task (and note the result in the task's own
 * notes) — do not delete this coverage, it is the only test that proves
 * the real HTTP wiring (method, content-type, field names) is correct.
 *
 * Written as a ternary rather than `describe.runIf(...)` — the latter is
 * only available on recent Vitest versions and this plan does not pin one;
 * check `pnpm --filter @rg/server exec vitest --version` if you want to use
 * `.runIf` instead, but the ternary below works on every version.
 */
const RUN_LIVE_TURNSTILE_TEST = process.env.TURNSTILE_LIVE_TEST === '1';
(RUN_LIVE_TURNSTILE_TEST ? describe : describe.skip)(
  'verifyTurnstile — real network call against Cloudflare test keys',
  () => {
    const ALWAYS_PASSES_SECRET = '1x0000000000000000000000000000000AA';
    const ALWAYS_FAILS_SECRET = '2x0000000000000000000000000000000AA';

    it('passes with the always-passes test secret and any non-empty token', async () => {
      const originalEnabled = env.TURNSTILE_ENABLED;
      const originalSecret = env.TURNSTILE_SECRET_KEY;
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = ALWAYS_PASSES_SECRET;
      try {
        await expect(
          verifyTurnstile({ token: 'any-non-empty-value', remoteIp: undefined }),
        ).resolves.toBe(true);
      } finally {
        (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
        (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
      }
    }, 10_000);

    it('refuses with the always-fails test secret', async () => {
      const originalEnabled = env.TURNSTILE_ENABLED;
      const originalSecret = env.TURNSTILE_SECRET_KEY;
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = ALWAYS_FAILS_SECRET;
      try {
        await expect(
          verifyTurnstile({ token: 'any-non-empty-value', remoteIp: undefined }),
        ).resolves.toBe(false);
      } finally {
        (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
        (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
      }
    }, 10_000);
  },
);
