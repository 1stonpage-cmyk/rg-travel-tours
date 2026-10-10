/**
 * The production content guard's decision logic — pure, no I/O, no imports.
 *
 * This is the half of `check-placeholders.mjs` that decides whether a build
 * may proceed. It lives in its own module so the decision is unit-tested
 * (`client/src/__tests__/build-guard.test.ts`) against the SAME functions the
 * build script calls — a guard whose test constructs its own inputs drifts
 * away from the script within a release or two, and then only the test is
 * green.
 *
 * Two exports, in the order the script uses them:
 *
 *   guardInputs(rawProbe, env)  — turns whatever the database probe printed
 *                                 (unknown shape, possibly nothing at all)
 *                                 plus process.env into the five decision
 *                                 inputs, FAILING CLOSED on anything it does
 *                                 not recognise.
 *   evaluateGuard(inputs)       — { ok, message }.
 *
 * Policy (plan decisions D2 + D3):
 *   - A published `is_sample` review, or `settings.content_unverified` still
 *     set, blocks EVERY build. Both mean the database still holds seed
 *     content, and CLAUDE.md forbids presenting seeded reviews as real social
 *     proof or invented permits as real accreditation.
 *   - The database being unreachable blocks only a PRODUCTION build (D3):
 *     outside production it passes with a warning, because a developer with
 *     MySQL stopped is not shipping anything. In production "we could not
 *     check" is treated exactly like "it is not clean".
 *   - ALLOW_PLACEHOLDER_BUILD=1 overrides all of it. It is the documented,
 *     deliberate escape hatch (demos, CI, every `pnpm build` verification run
 *     in this repo), checked first so it works even when MySQL is down.
 *
 * SECURITY: no message this module produces may ever contain DATABASE_URL or
 * any part of it. The probe reports a failure as a bare driver code
 * (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, …); `guardInputs` re-sanitises
 * that code against a strict allow-shape before it can reach a message, so a
 * future probe change cannot turn this into a credential leak.
 * `build-guard.test.ts` feeds a connection string through that path and
 * asserts it never comes out.
 */

/**
 * A driver/error code is safe to print only if it looks like one: an
 * upper-case enum token. `mysql://rg_travel:pw@host/db` cannot match this.
 */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

/**
 * The probe's failure code when it is safely shaped, `null` otherwise.
 * Applied in `guardInputs` (where the untrusted value arrives) AND again in
 * `evaluateGuard` (the only place it is interpolated into text), because the
 * two are separately callable and only one of them prints.
 */
function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

/**
 * The five decision inputs, derived from the probe output and the
 * environment. Fails closed on every axis:
 *
 *   - an unrecognised probe result is "unreachable" (not "clean");
 *   - an unknown deploy environment is "production" (not "development"), so a
 *     build with no SITE_ENV anywhere and no readable database refuses rather
 *     than shrugging;
 *   - `contentUnverified` defaults to true, matching the server's own
 *     fail-closed read in `server/src/content/settings.ts`.
 *
 * `isProduction` is `NODE_ENV === 'production' || SITE_ENV === 'production'`.
 * SITE_ENV is taken from the real environment when set, and otherwise from
 * the probe, which parses the repo-root `.env` through the server's canonical
 * `env.ts` (same variable, same zod schema, same fail-closed default) — this
 * script has no dotenv of its own and must not grow one.
 */
export function guardInputs(rawProbe, env) {
  const probe = rawProbe !== null && typeof rawProbe === 'object' ? rawProbe : {};

  const reachable =
    probe.ok === true &&
    Number.isInteger(probe.sampleReviewCount) &&
    probe.sampleReviewCount >= 0 &&
    typeof probe.contentUnverified === 'boolean';

  const siteEnv =
    typeof env.SITE_ENV === 'string' && env.SITE_ENV !== ''
      ? env.SITE_ENV
      : typeof probe.siteEnv === 'string' && probe.siteEnv !== ''
        ? probe.siteEnv
        : null;

  return {
    sampleReviewCount: reachable ? probe.sampleReviewCount : 0,
    contentUnverified: reachable ? probe.contentUnverified : true,
    dbReachable: reachable,
    isProduction: env.NODE_ENV === 'production' || siteEnv === 'production' || siteEnv === null,
    override: Boolean(env.ALLOW_PLACEHOLDER_BUILD),
    code: safeCode(probe.code),
  };
}

/** Decides whether this build may proceed. Pure. */
export function evaluateGuard({
  sampleReviewCount,
  contentUnverified,
  dbReachable,
  isProduction,
  override,
  code = null,
}) {
  if (override) {
    return {
      ok: true,
      message:
        'ALLOW_PLACEHOLDER_BUILD=1 — content guard skipped deliberately.\n' +
        'This build may present seeded reviews and placeholder copy as real. Do not serve it\n' +
        'as the live TravelSugbo site.',
    };
  }

  if (!dbReachable) {
    const safe = safeCode(code);
    const reason = safe ? `reported ${safe}` : 'reported no usable result';
    if (isProduction) {
      return {
        ok: false,
        message:
          `Build blocked: the content guard could not read the rg_travel database (${reason}),\n` +
          'so it cannot prove this site is free of seed content.\n\n' +
          'This is a production build (NODE_ENV or SITE_ENV is "production"), and an\n' +
          'unverifiable content state fails closed — shipping now risks publishing sample\n' +
          'reviews and placeholder copy to guests and to search engines.\n\n' +
          'Start MySQL, confirm DATABASE_URL in .env points at rg_travel, and rebuild. To\n' +
          'build without this check on purpose, set ALLOW_PLACEHOLDER_BUILD=1.',
      };
    }
    return {
      ok: true,
      message:
        `Warning: the content guard could not read the rg_travel database (${reason}).\n` +
        'Published sample reviews and settings.content_unverified were NOT checked. This is\n' +
        'not a production build, so it continues; a production build with the database\n' +
        'unreachable fails instead.',
    };
  }

  const reasons = [];
  if (sampleReviewCount > 0) {
    const plural = sampleReviewCount === 1 ? 'review is' : 'reviews are';
    reasons.push(
      `${sampleReviewCount} published sample ${plural} still live (reviews.is_sample = 1).\n` +
        '    Seeded reviews must never be presented as real social proof — delete them or\n' +
        '    set their status to hidden.',
    );
  }
  if (contentUnverified) {
    reasons.push(
      'settings.content_unverified is still set, so the database is still flagged as holding\n' +
        '    unverified seed content (placeholder tours, placeholder prices, pending permit\n' +
        '    numbers) and every route is held at noindex.',
    );
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      message:
        'Build blocked: TravelSugbo still holds unverified seed content.\n\n' +
        reasons.map((reason) => `  - ${reason}`).join('\n') +
        '\n\nClearing settings.content_unverified is what publishes this site to search engines\n' +
        '(task 4.3), so clear it only once real content has replaced the seed and no sample\n' +
        'review is published. To build a demo deliberately, set ALLOW_PLACEHOLDER_BUILD=1.',
    };
  }

  return {
    ok: true,
    message:
      'Content guard passed: no published sample reviews, settings.content_unverified cleared.',
  };
}
