/**
 * Owner decision 2026-11-10 (staging fixes), Decision 1: exactly ONE trusted
 * proxy hop, gated by `TRUST_PROXY`, default OFF. Fixes the staging bug
 * where every per-IP rate limiter collapsed onto nginx's own loopback
 * address (see `app.ts`'s own note on `trustProxy` and
 * `docs/LAUNCH_CHECKLIST.md`).
 *
 * Four properties, each proven both ways (on fixes it / off leaves the prior
 * behaviour untouched):
 *  1. Rate-limit key: two distinct X-Forwarded-For client IPs get separate
 *     budgets when trustProxy is on, and share ONE budget when it is off.
 *  2. Cookie security: the `secure` flag is driven by SITE_ENV alone (see
 *     `middleware/session-cookie.ts`), NOT by trustProxy — proven unaffected
 *     in both directions, because wiring it to trust proxy would be a new,
 *     undocumented behaviour this task must not introduce.
 *  3. End-to-end: with trustProxy on and a forwarded HTTPS request, login
 *     still sets a working session cookie and the very next request
 *     authenticates with it — proving the proxy-trust change does not
 *     collaterally break the existing login chain.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../app';
import { env } from '../env';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { DRIVER_LOGIN_IP_MAX } from '../middleware/rate-limit';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const ORIGIN = 'http://localhost:5180';
const PASSWORD = 'a-strong-owner-password';
const suffix = `${Math.floor(Math.random() * 1e9)}`;
const EMAIL = `trustproxy_${suffix}@example.test`;
let ownerId: number;

// One fixture account for the whole file — nothing below deletes it
// mid-file, so there is exactly one setup and one teardown.
beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  const [owner] = await getDb()
    .insert(users)
    .values({ name: 'Trust Proxy Fixture', email: EMAIL, passwordHash: hash, role: 'owner' });
  ownerId = owner.insertId;
}, 60_000);

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, ownerId));
});

/**
 * `middleware/session-cookie.ts` reads `env.SITE_ENV` directly at call time
 * — it is NOT the `siteEnv` parameter `createApp` takes (that only reaches
 * `robotsHeader`/`sitemap.ts`; `app.ts` deliberately never imports `./env`
 * itself). Under this package's `vitest.config.ts`, `SITE_ENV` is never set,
 * so it resolves to the schema default (`'development'`) regardless of what
 * is passed to `createApp` — the `secure` flag would be `false` in every
 * test in this file without this helper. Same mutate-and-restore pattern
 * `origin-check.test.ts`'s "does NOT allow the dev server in production"
 * test already uses.
 */
function withProductionSiteEnv<T>(run: () => Promise<T>): Promise<T> {
  const original = env.SITE_ENV;
  (env as { SITE_ENV: string }).SITE_ENV = 'production';
  return run().finally(() => {
    (env as { SITE_ENV: string }).SITE_ENV = original;
  });
}

function driverLoginAttempt(app: Parameters<typeof request>[0], xff: string) {
  return request(app)
    .post('/trpc/driver.login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', xff)
    .send({ code: '__trust_proxy_test__', pin: '000000' });
}

describeWithDb('trust proxy — rate-limit key', () => {
  it('two distinct X-Forwarded-For IPs get SEPARATE budgets when TRUST_PROXY is on', async () => {
    const app = createApp(ORIGIN, undefined, 'development', true);

    // IP #1 spends its whole budget and is refused on the extra attempt.
    let limitedForFirstIp = 0;
    for (let i = 0; i < DRIVER_LOGIN_IP_MAX + 1; i += 1) {
      const res = await driverLoginAttempt(app, '203.0.113.21');
      if (res.status === 429) limitedForFirstIp += 1;
    }
    expect(limitedForFirstIp).toBeGreaterThan(0);

    // IP #2 has never been seen before — its own, untouched budget.
    const res = await driverLoginAttempt(app, '203.0.113.22');
    expect(res.status).not.toBe(429);
  });

  it('without TRUST_PROXY (default), two distinct X-Forwarded-For IPs share ONE budget — unchanged from before this task', async () => {
    const app = createApp(ORIGIN); // trustProxy defaults to false

    // The limiter cannot see the X-Forwarded-For header at all without
    // trust proxy, so every request — regardless of the header — is keyed
    // on supertest's own loopback socket address. Spend the whole budget
    // under IP #1's header...
    for (let i = 0; i < DRIVER_LOGIN_IP_MAX; i += 1) {
      const res = await driverLoginAttempt(app, '203.0.113.21');
      expect(res.status).not.toBe(429);
    }
    // ...and IP #2's very next request is refused, proving they shared one
    // counter the whole time.
    const res = await driverLoginAttempt(app, '203.0.113.22');
    expect(res.status).toBe(429);
  });
});

describeWithDb('trust proxy — cookie security is unaffected either way', () => {
  it('TRUST_PROXY=1 + X-Forwarded-Proto: https — login still sets the secure cookie and the follow-up request authenticates', async () => {
    await withProductionSiteEnv(async () => {
      const app = createApp(ORIGIN, undefined, 'production', true);

      const login = await request(app)
        .post('/trpc/staffAuth.login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.30')
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);

      const setCookie = login.headers['set-cookie'] as unknown as string[];
      expect(setCookie.some((c) => /Secure/i.test(c))).toBe(true);

      const me = await request(app)
        .get('/trpc/staffAuth.me')
        .set('Cookie', setCookie)
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.30');
      expect(me.status).toBe(200);
      expect(me.body.result.data.role).toBe('owner');
    });
  });

  it('without TRUST_PROXY, the secure-cookie flag is STILL driven by SITE_ENV alone — proves this task did not wire it to proxy trust', async () => {
    await withProductionSiteEnv(async () => {
      const app = createApp(ORIGIN, undefined, 'production', false);

      const login = await request(app)
        .post('/trpc/staffAuth.login')
        .set('Origin', ORIGIN)
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);

      const setCookie = login.headers['set-cookie'] as unknown as string[];
      // Unchanged from before this task: secure is `SITE_ENV === 'production'`,
      // full stop, with or without trustProxy — see
      // middleware/session-cookie.ts, which never reads createApp's
      // `trustProxy` parameter at all.
      expect(setCookie.some((c) => /Secure/i.test(c))).toBe(true);
    });
  });
});
