/**
 * Types for `build-guard.mjs`.
 *
 * The guard itself is plain ESM JavaScript because `check-placeholders.mjs`
 * runs under bare `node` before `tsc` and `vite build` do anything — there is
 * no build step available to it. This declaration exists so the Vitest suite
 * (TypeScript) can import the real module and still typecheck under
 * `tsc --noEmit`. It describes the module; it does not reimplement it.
 */

/** Raw probe output: whatever `server/src/db/content-status.ts` printed. */
export type RawProbe = unknown;

/** The five decision inputs, plus the sanitised failure code. */
export interface GuardInputs {
  sampleReviewCount: number;
  contentUnverified: boolean;
  dbReachable: boolean;
  isProduction: boolean;
  override: boolean;
  /** An upper-case driver code, or null. Never a connection string. */
  code?: string | null;
}

export interface GuardResult {
  ok: boolean;
  message: string;
}

export function guardInputs(
  rawProbe: RawProbe,
  env: Record<string, string | undefined>,
): GuardInputs & { code: string | null };

export function evaluateGuard(inputs: GuardInputs): GuardResult;
