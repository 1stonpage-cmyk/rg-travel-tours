/**
 * The production content guard (task 4.5).
 *
 * `client/scripts/check-placeholders.mjs` blocks a build that would publish
 * seed content as real. This suite tests the two functions that script
 * actually calls — imported from the same module, not reimplemented here:
 *
 *   guardInputs()  — probe output + process.env  ->  the five decision inputs
 *   evaluateGuard() — the five decision inputs   ->  { ok, message }
 *
 * `guardInputs` is covered as carefully as `evaluateGuard` on purpose. A
 * guard test that builds its own tidy inputs object drifts away from whatever
 * the script really passes in, and then the decision is perfect and the
 * build still ships placeholders. The `PROBE_TODAY` fixture below is a
 * byte-for-byte copy of what `server/src/db/content-status-cli.ts` prints
 * against the live development database right now.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGuard, guardInputs } from '../../scripts/build-guard.mjs';

/** Exactly the JSON the probe CLI prints today. */
const PROBE_TODAY = {
  ok: true,
  siteEnv: 'development',
  sampleReviewCount: 6,
  contentUnverified: true,
};

/** Exactly the JSON the probe CLI prints when it cannot read the database. */
const PROBE_FAILED = { ok: false, siteEnv: 'development', code: 'UNREACHABLE' };

describe('production build guard', () => {
  const ok = {
    sampleReviewCount: 0,
    contentUnverified: false,
    dbReachable: true,
    isProduction: true,
    override: false,
  };

  it('passes on clean, verified content', () => {
    expect(evaluateGuard(ok).ok).toBe(true);
  });

  it('blocks while a published sample review exists', () => {
    const r = evaluateGuard({ ...ok, sampleReviewCount: 6 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sample review/i);
  });

  it('blocks while content is flagged unverified', () => {
    const r = evaluateGuard({ ...ok, contentUnverified: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unverified/i);
  });

  it('is overridable with ALLOW_PLACEHOLDER_BUILD', () => {
    expect(
      evaluateGuard({ ...ok, sampleReviewCount: 6, contentUnverified: true, override: true }).ok,
    ).toBe(true);
  });

  it('skips with a warning when the DB is unreachable outside production (D3)', () => {
    const r = evaluateGuard({ ...ok, dbReachable: false, isProduction: false });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/warning/i);
  });

  it('hard-fails when the DB is unreachable in production (D3)', () => {
    const r = evaluateGuard({ ...ok, dbReachable: false, isProduction: true });
    expect(r.ok).toBe(false);
  });

  it('never puts the connection string in a message', () => {
    for (const r of [evaluateGuard({ ...ok, dbReachable: false, isProduction: true })]) {
      expect(r.message).not.toMatch(/mysql:\/\//);
    }
  });
});

describe('production build guard — blocking is not production-only', () => {
  const dev = {
    sampleReviewCount: 0,
    contentUnverified: false,
    dbReachable: true,
    isProduction: false,
    override: false,
  };

  it('blocks a plain `pnpm --filter @rg/client build` on published samples', () => {
    expect(evaluateGuard({ ...dev, sampleReviewCount: 6 }).ok).toBe(false);
  });

  it('blocks a plain `pnpm --filter @rg/client build` on the unverified flag', () => {
    expect(evaluateGuard({ ...dev, contentUnverified: true }).ok).toBe(false);
  });

  it('names both reasons when both are true, as separate bullets', () => {
    // Pinned to the bullets, not just to the words appearing somewhere: the
    // closing paragraph mentions content_unverified too, so a looser match
    // stays green even if a reason stops being reported at all.
    const r = evaluateGuard({ ...dev, sampleReviewCount: 6, contentUnverified: true });
    expect(r.message).toMatch(/- 6 published sample reviews are still live/);
    expect(r.message).toMatch(/- settings\.content_unverified is still set/);
  });

  it('reports a single sample review in the singular', () => {
    expect(evaluateGuard({ ...dev, sampleReviewCount: 1 }).message).toMatch(
      /- 1 published sample review is still live/,
    );
  });
});

describe('guardInputs — the inputs the build script really passes', () => {
  it('maps the live probe payload to a blocking decision', () => {
    const inputs = guardInputs(PROBE_TODAY, { SITE_ENV: 'development' });
    expect(inputs).toMatchObject({
      sampleReviewCount: 6,
      contentUnverified: true,
      dbReachable: true,
      isProduction: false,
      override: false,
    });
    expect(evaluateGuard(inputs).ok).toBe(false);
  });

  it('passes a clean probe payload through to a green build', () => {
    const inputs = guardInputs(
      { ok: true, siteEnv: 'production', sampleReviewCount: 0, contentUnverified: false },
      {},
    );
    expect(inputs.dbReachable).toBe(true);
    expect(inputs.isProduction).toBe(true);
    expect(evaluateGuard(inputs).ok).toBe(true);
  });

  it('reads NODE_ENV=production as production', () => {
    expect(guardInputs(PROBE_TODAY, { NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('reads SITE_ENV=production as production, overriding the probe', () => {
    expect(guardInputs(PROBE_TODAY, { SITE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('takes SITE_ENV from the probe when the real environment has none', () => {
    // The script has no dotenv: SITE_ENV normally reaches it only via the
    // probe, which parses .env through the server's own env.ts.
    expect(guardInputs({ ...PROBE_TODAY, siteEnv: 'production' }, {}).isProduction).toBe(true);
    expect(guardInputs({ ...PROBE_TODAY, siteEnv: 'preview' }, {}).isProduction).toBe(false);
  });

  it('treats a failed probe as unreachable and unverified, not as clean', () => {
    const inputs = guardInputs(PROBE_FAILED, {});
    expect(inputs.dbReachable).toBe(false);
    expect(inputs.contentUnverified).toBe(true);
    expect(inputs.isProduction).toBe(false); // probe still reported siteEnv
    expect(evaluateGuard(inputs).ok).toBe(true); // warning, not a block (D3)
  });

  it('fails closed to production when nothing reports an environment', () => {
    // The probe could not even start (no .env, no DATABASE_URL, no tsx): we
    // know neither the content state nor the deploy target, so refuse.
    for (const raw of [null, undefined, '', 'not json', {}, { ok: false }]) {
      const inputs = guardInputs(raw, {});
      expect(inputs.dbReachable).toBe(false);
      expect(inputs.isProduction).toBe(true);
      expect(evaluateGuard(inputs).ok).toBe(false);
    }
  });

  it('fails closed on a probe payload of the wrong shape', () => {
    const malformed = [
      { ok: true, sampleReviewCount: '6', contentUnverified: true },
      { ok: true, sampleReviewCount: 6 },
      { ok: true, sampleReviewCount: 1.5, contentUnverified: false },
      { ok: true, sampleReviewCount: -1, contentUnverified: false },
      { ok: 'true', sampleReviewCount: 0, contentUnverified: false },
    ];
    for (const raw of malformed) {
      expect(guardInputs(raw, { SITE_ENV: 'development' }).dbReachable).toBe(false);
    }
  });

  it('reads ALLOW_PLACEHOLDER_BUILD as the override, and its absence as no override', () => {
    expect(guardInputs(PROBE_TODAY, { ALLOW_PLACEHOLDER_BUILD: '1' }).override).toBe(true);
    expect(guardInputs(PROBE_TODAY, {}).override).toBe(false);
    expect(guardInputs(PROBE_TODAY, { ALLOW_PLACEHOLDER_BUILD: '' }).override).toBe(false);
  });

  it('lets the override through even with the database unreachable in production', () => {
    // `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` is this repo's standard
    // verification command and must not depend on MySQL being up.
    const inputs = guardInputs(null, { NODE_ENV: 'production', ALLOW_PLACEHOLDER_BUILD: '1' });
    expect(inputs.isProduction).toBe(true);
    expect(evaluateGuard(inputs).ok).toBe(true);
  });
});

describe('production build guard — never leaks the connection string', () => {
  /** Shapes a leak would take: the URL itself, a password, a user@host pair. */
  const SECRETS = [/mysql:\/\//, /CHANGE_ME/, /rg_travel:/, /@localhost/, /:3306/];

  /** Every message the guard can produce, for every combination of inputs. */
  function everyMessage(code: string | null): string[] {
    const messages: string[] = [];
    for (const sampleReviewCount of [0, 1, 6]) {
      for (const contentUnverified of [true, false]) {
        for (const dbReachable of [true, false]) {
          for (const isProduction of [true, false]) {
            for (const override of [true, false]) {
              messages.push(
                evaluateGuard({
                  sampleReviewCount,
                  contentUnverified,
                  dbReachable,
                  isProduction,
                  override,
                  code,
                }).message,
              );
            }
          }
        }
      }
    }
    return messages;
  }

  it('keeps every message clean for a normal driver code', () => {
    expect(everyMessage('ECONNREFUSED').length).toBe(48);
    for (const message of everyMessage('ECONNREFUSED')) {
      for (const secret of SECRETS) expect(message).not.toMatch(secret);
    }
  });

  it('sanitises a connection string that reaches the guard as a failure code', () => {
    // The only untrusted string that gets anywhere near a message is the
    // probe's `code`. If a future probe change put DATABASE_URL there,
    // guardInputs must drop it before evaluateGuard can print it.
    const leaked = 'mysql://rg_travel:CHANGE_ME@localhost:3306/rg_travel';
    const inputs = guardInputs({ ok: false, code: leaked }, { SITE_ENV: 'production' });
    expect(inputs.code).toBeNull();

    for (const message of [evaluateGuard(inputs).message, ...everyMessage(leaked)]) {
      for (const secret of SECRETS) expect(message).not.toMatch(secret);
    }
  });

  it('still reports a usable, safely shaped code to the operator', () => {
    const inputs = guardInputs({ ok: false, code: 'ER_ACCESS_DENIED_ERROR' }, {});
    expect(inputs.code).toBe('ER_ACCESS_DENIED_ERROR');
    expect(evaluateGuard({ ...inputs, isProduction: true }).message).toMatch(
      /ER_ACCESS_DENIED_ERROR/,
    );
  });
});
