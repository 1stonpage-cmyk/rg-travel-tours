/**
 * Verifies a Cloudflare Turnstile response token (owner decision
 * 2026-11-10/11, Task 10). FAILS CLOSED in every direction but one: with
 * Turnstile switched OFF (`env.TURNSTILE_ENABLED !== '1'`), every gated
 * endpoint behaves exactly as it did before this task existed — no check,
 * no network call. Switched ON, a missing token, an unreachable Cloudflare,
 * a timeout, a non-OK HTTP status, or an explicit `success: false` all
 * refuse. A token is single-use by Cloudflare's own design, so there is no
 * local replay cache to maintain here.
 *
 * `fetchImpl` is injectable (defaults to the global `fetch`, available with
 * no dependency since Node 18+) purely so `turnstile.test.ts` can stub the
 * deterministic branches without a real network call — production code
 * never passes it.
 */
import { TRPCError } from '@trpc/server';
import { env } from '../env';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

export interface TurnstileVerifyInput {
  token: string | undefined;
  remoteIp: string | undefined;
}

interface SiteverifyResponse {
  success?: boolean;
}

export async function verifyTurnstile(
  { token, remoteIp }: TurnstileVerifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (env.TURNSTILE_ENABLED !== '1') return true;
  if (!token) return false;
  // Fails closed BY CONSTRUCTION, not by relying on Cloudflare's own
  // "empty secret" error — see turnstile.test.ts's own note on this line.
  if (!env.TURNSTILE_SECRET_KEY) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY ?? '',
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false; // network error, abort/timeout — fail closed
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ONE guest-safe refusal, shared by every gated endpoint that has no
 * pre-existing single-refusal shape of its own to reuse (createHold,
 * createHoldTransfer, the transfer_custom inquiry — see Tasks 12–13).
 * Deliberately generic: it must read the same whether the guest forgot to
 * complete the widget, the widget failed to load, or Cloudflare rejected
 * the token — there is nothing actionable to tell them beyond "try again".
 * Endpoints that already have their own single refusal (staffAuth.login's
 * `refused()`, driver.login's `asTrpcError('wrong_credentials')`,
 * requestPasswordReset's `REQUESTED`) reuse THEIR OWN shape instead, per
 * the owner's "same generic refusal as other failures" instruction.
 */
export function turnstileRefusedError() {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Please complete the verification and try again.',
  });
}
