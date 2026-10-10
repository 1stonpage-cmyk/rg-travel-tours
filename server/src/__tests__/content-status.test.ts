/**
 * The build guard's database probe (task 4.5).
 *
 * `probePayload()` is what `content-status-cli.ts` prints for
 * `client/scripts/check-placeholders.mjs` to read. Two properties matter more
 * than the happy path (which the guard's own manual verification covers
 * against the live `rg_travel`):
 *
 *  1. It FAILS CLOSED. A read it cannot complete must come back as
 *     `{ ok: false }` — never a throw, which the guard would see as "no
 *     usable result" either way, and never a half-filled payload that could
 *     read as "clean".
 *  2. It never leaks DATABASE_URL. The guard prints what this returns, so a
 *     driver message echoing host, user or password must not get in.
 *
 * This file deliberately does NOT call `describeWithDb`. Under Vitest every
 * connection is routed to `rg_travel_test` (see db/client.ts), while
 * `readContentStatus` asserts the 'app' context — `rg_travel` — so the probe
 * is guaranteed to fail here. That is exactly the path worth testing: the
 * real failure, through the real guard, rather than a mocked rejection.
 */
import { expect, it } from 'vitest';
import { probePayload, safeCode } from '../db/content-status';

/** Shapes a leak would take: the URL itself, a password, a user@host pair. */
const SECRETS = [/mysql:\/\//, /CHANGE_ME/, /rg_travel:/, /@localhost/, /:3306/, /password/i];

it('fails closed when the app database cannot be read, instead of throwing', async () => {
  const payload = await probePayload();

  expect(payload.ok).toBe(false);
  expect(payload.sampleReviewCount).toBeUndefined();
  expect(payload.contentUnverified).toBeUndefined();
  // siteEnv still rides along: it comes from env.ts, not from the database,
  // and the guard needs it to know whether to hard-fail (plan decision D3).
  expect(payload.siteEnv).toBe('development');
});

it('reports a failure as a code only — never a driver message or the connection string', async () => {
  const payload = await probePayload();

  // An allow-list of keys, not just a hunt for patterns. The real leak
  // vector here is an extra "helpful" diagnostic field — a driver message
  // echoes the host, the user, sometimes the whole URL — and no pattern
  // catches every shape that could take. So: these three keys, nothing else.
  expect(Object.keys(payload).sort()).toEqual(['code', 'ok', 'siteEnv']);
  expect(payload.code).toMatch(/^[A-Z][A-Z0-9_]*$/);

  const serialised = JSON.stringify(payload);
  for (const secret of SECRETS) {
    expect(serialised).not.toMatch(secret);
  }
});

it('passes a safely shaped driver code through', () => {
  expect(safeCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
  expect(safeCode(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' }))).toBe(
    'ER_ACCESS_DENIED_ERROR',
  );
});

it('replaces anything else with UNREACHABLE', () => {
  const leaky = [
    // A hand-thrown Error (guard.ts's own wrong-database and cannot-reach
    // errors) carries no `code` at all.
    new Error('Cannot reach MySQL at localhost:3306 — is the service running?'),
    // And a `code` that is not a plain enum token is not a code.
    Object.assign(new Error('x'), { code: 'mysql://rg_travel:CHANGE_ME@localhost:3306/rg_travel' }),
    Object.assign(new Error('x'), { code: 42 }),
    undefined,
    null,
    'ECONNREFUSED but as a bare string',
  ];

  for (const error of leaky) {
    expect(safeCode(error)).toBe('UNREACHABLE');
  }
});
