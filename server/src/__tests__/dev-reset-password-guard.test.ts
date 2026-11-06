/**
 * Task 1A — the "may this run at all?" decision of
 * `scripts/dev-reset-staff-password.ts`.
 *
 * `db-guard.test.ts` already covers `assertDatabaseName` itself; this file
 * covers THIS SCRIPT'S decision, which is the database rule plus a
 * production refusal the database name alone cannot express — production's
 * own database is also named `rg_travel` (see `env.ts`'s note on
 * `ALLOW_DEMO_SEED`, the same trap), so the name check would wave a
 * production run straight through.
 *
 * It calls the exported function directly: no terminal, no process, no
 * database. The script's CLI body is behind an `isMainModule` check, which is
 * what makes importing it here free of side effects.
 */
import { describe, expect, it } from 'vitest';
import { refuseReason } from '../../scripts/dev-reset-staff-password';

describe('dev:reset-password guard', () => {
  it('refuses NODE_ENV=production even on the right database', () => {
    const reason = refuseReason({ nodeEnv: 'production', databaseName: 'rg_travel' });
    expect(reason).not.toBeNull();
    expect(reason).toContain('production');
  });

  it("refuses the TEST database — that is the suite's, not a developer's login", () => {
    expect(refuseReason({ nodeEnv: 'development', databaseName: 'rg_travel_test' })).toContain(
      'rg_travel',
    );
  });

  it.each(['kong_pms', 'mysql', 'rg_travel_backup', 'RG_TRAVEL', ''])(
    'refuses database %s',
    (databaseName) => {
      expect(refuseReason({ nodeEnv: 'development', databaseName })).not.toBeNull();
    },
  );

  it('refuses a null / unparseable database name (fails closed)', () => {
    expect(refuseReason({ nodeEnv: 'development', databaseName: null })).not.toBeNull();
  });

  it('allows development against rg_travel', () => {
    expect(refuseReason({ nodeEnv: 'development', databaseName: 'rg_travel' })).toBeNull();
  });

  it('allows an unset NODE_ENV against rg_travel — normal locally', () => {
    expect(refuseReason({ nodeEnv: undefined, databaseName: 'rg_travel' })).toBeNull();
  });

  it('never puts a connection string or password in a refusal', () => {
    const reason = refuseReason({
      nodeEnv: 'development',
      // The script passes `databaseNameFromUrl(...)`, so only a name ever
      // reaches here — but assert the refusal is clean anyway, because this
      // string is printed to a terminal a developer may paste into an issue.
      databaseName: 'kong_pms',
    });
    expect(reason).not.toBeNull();
    expect(reason).not.toContain('mysql://');
    expect(reason).not.toContain('password');
    // Positive assertion too: a `null` returned by a broken guard would
    // satisfy neither `.not.toContain` nor this.
    expect(reason).toContain('kong_pms');
  });
});
