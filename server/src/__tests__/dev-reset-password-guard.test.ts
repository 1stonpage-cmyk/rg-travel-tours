/**
 * Task 1A — the "may this run at all?" decision of
 * `scripts/dev-reset-staff-password.ts`.
 *
 * `db-guard.test.ts` already covers `assertDatabaseName` itself; this file
 * covers THIS SCRIPT'S decision, which is the database rule plus three checks
 * the database name cannot express. Two of those exist because the obvious
 * guards do not actually hold on a production box (1A review, I1):
 * production's own database is also named `rg_travel`, and
 * `NODE_ENV=production` lives in the PM2 environment rather than `.env`, so an
 * interactive SSH shell on the VPS sees it unset. `SITE_ENV` and
 * `ALLOW_DEV_PASSWORD_RESET` are the two that genuinely refuse there.
 *
 * It calls the exported function directly: no terminal, no process, no
 * database. The script's CLI body is behind an `isMainModule` check, which is
 * what makes importing it here free of side effects.
 */
import { describe, expect, it } from 'vitest';
import { refuseReason, type RunEnvironment } from '../../scripts/dev-reset-staff-password';

/** The one combination that is allowed; every case below is a change to it. */
const ALLOWED: RunEnvironment = {
  nodeEnv: 'development',
  siteEnv: 'development',
  allowDevPasswordReset: '1',
  databaseName: 'rg_travel',
};

const reasonFor = (overrides: Partial<RunEnvironment>): string | null =>
  refuseReason({ ...ALLOWED, ...overrides });

describe('dev:reset-password guard', () => {
  it('allows development against rg_travel with the opt-in set', () => {
    expect(refuseReason(ALLOWED)).toBeNull();
  });

  it('allows an unset NODE_ENV — normal locally, and on a VPS shell', () => {
    expect(reasonFor({ nodeEnv: undefined })).toBeNull();
  });

  it('refuses NODE_ENV=production even on the right database', () => {
    const reason = reasonFor({ nodeEnv: 'production' });
    expect(reason).toContain('NODE_ENV=production');
  });

  /*
   * The review's I1: with NODE_ENV unset (as it is on an interactive shell on
   * the VPS, because the checklist sets it in PM2's environment) and the
   * database named `rg_travel` (as production's own is), these two are the
   * only things standing between this script and a live staff password.
   */
  it('refuses SITE_ENV=production even with NODE_ENV unset and the opt-in set', () => {
    const reason = reasonFor({ nodeEnv: undefined, siteEnv: 'production' });
    expect(reason).toContain('SITE_ENV=production');
  });

  it.each([undefined, '', '0', 'true', 'yes', ' 1', '11'])(
    'refuses ALLOW_DEV_PASSWORD_RESET=%p — only the exact string "1" opts in',
    (allowDevPasswordReset) => {
      const reason = reasonFor({ nodeEnv: undefined, allowDevPasswordReset });
      expect(reason).toContain('ALLOW_DEV_PASSWORD_RESET=1');
    },
  );

  it('names which check failed, so two refusals are never confused', () => {
    // Each check owns its own sentence rather than one shared "refused".
    expect(reasonFor({ nodeEnv: 'production' })).not.toContain('SITE_ENV');
    expect(reasonFor({ siteEnv: 'production' })).not.toContain('NODE_ENV');
    expect(reasonFor({ allowDevPasswordReset: undefined })).not.toContain('SITE_ENV');
  });

  it("refuses the TEST database — that is the suite's, not a developer's login", () => {
    // `toContain('rg_travel_test')`, not `toContain('rg_travel')`: every
    // wrong-database message names the REQUIRED database, so the looser
    // assertion passed even when the offending name was never mentioned
    // (1A review, M3).
    expect(reasonFor({ databaseName: 'rg_travel_test' })).toContain('rg_travel_test');
  });

  it.each(['kong_pms', 'mysql', 'rg_travel_backup', 'RG_TRAVEL', ''])(
    'refuses database %p',
    (databaseName) => {
      expect(reasonFor({ databaseName })).toContain(databaseName || '(none)');
    },
  );

  it('refuses a null / unparseable database name (fails closed)', () => {
    expect(reasonFor({ databaseName: null })).toContain('(none)');
  });

  it.each([
    ['the wrong database', { databaseName: 'kong_pms' }, 'kong_pms'],
    ['NODE_ENV', { nodeEnv: 'production' }, 'NODE_ENV'],
    ['SITE_ENV', { siteEnv: 'production' }, 'SITE_ENV'],
    ['the missing opt-in', { allowDevPasswordReset: undefined }, 'ALLOW_DEV_PASSWORD_RESET'],
  ] as Array<[string, Partial<RunEnvironment>, string]>)(
    'never puts a connection string or credential in the refusal for %s',
    (_label, overrides, expected) => {
      // The first version only checked `guard.ts`'s message, not the three
      // this file authors itself (1A review, M3).
      const reason = reasonFor(overrides);
      expect(reason).not.toContain('mysql://');
      expect(reason).not.toContain('DATABASE_URL=');
      expect(reason).not.toMatch(/pass(word)?\s*[:=]/i);
      // A positive assertion too: a `null` returned by a broken guard would
      // satisfy every `.not.toContain` above just as well as a real refusal.
      expect(reason).toContain(expected);
    },
  );
});
