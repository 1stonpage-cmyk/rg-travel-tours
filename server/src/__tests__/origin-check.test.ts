/**
 * Week 4 plan, Task 5 — the origin check (CSRF), built once as middleware
 * for every state-changing request (owner instruction 2026-10-14).
 *
 * Driven through `createApp()` with `supertest` throughout. That is not a
 * preference: the property under test is "every state-changing route is
 * covered", and a middleware tested in isolation proves nothing about
 * whether `app.ts` mounts it ahead of the routes that need it. The owner's
 * four named endpoints are each driven from a foreign origin and from the
 * allowed one.
 *
 * The one exemption — `/api/webhooks/*` — gets its own test, because an
 * exemption nobody checks is how a hole opens: a gateway sends no `Origin`
 * at all, so a check that applied there would reject every real payment
 * notification and leave bookings unpaid.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { allowedOrigins, isStateChanging } from '../middleware/origin-check';
import { env } from '../env';

const ALLOWED = 'http://localhost:5180';
const FOREIGN = 'https://evil.example';

/** A plausible body per endpoint. None of these should get far enough to matter. */
const MUTATIONS = [
  { name: 'checkout.createHold', path: '/trpc/checkout.createHold', body: {} },
  {
    name: 'portal.login',
    path: '/trpc/portal.login',
    body: { ref: 'RG-AAAAAA', email: 'a@b.test' },
  },
  {
    name: 'staffAuth.login',
    path: '/trpc/staffAuth.login',
    body: { email: 'a@b.test', password: 'x' },
  },
  { name: 'inquiries.create', path: '/trpc/inquiries.create', body: {} },
] as const;

describe('the origin check', () => {
  /**
   * **A foreign origin is refused with 403, before anything else runs.**
   * 403 and not 401: no credential would change the answer, because the
   * objection is to where the request came from.
   */
  it('REFUSES every state-changing endpoint from a foreign origin', async () => {
    const app = createApp();
    for (const mutation of MUTATIONS) {
      const res = await request(app).post(mutation.path).set('Origin', FOREIGN).send(mutation.body);
      expect(res.status, `${mutation.name} accepted a request from ${FOREIGN}`).toBe(403);
    }
  });

  /**
   * **A MISSING Origin is refused too**, which is the decision worth
   * pinning. Every browser sends `Origin` on a POST, so a request without
   * one is not a browser — and our only state-changing callers are
   * browsers. Allowing it "for compatibility" would make the whole check
   * optional from an attacker's point of view.
   */
  it('REFUSES a state-changing request with no Origin at all', async () => {
    const app = createApp();
    for (const mutation of MUTATIONS) {
      const res = await request(app).post(mutation.path).send(mutation.body);
      expect(res.status, `${mutation.name} accepted a request with no Origin`).toBe(403);
    }
  });

  /**
   * And it lets the real site through. Asserted as "not 403" rather than a
   * specific status: these bodies are deliberately invalid, so the
   * endpoints answer 400 or 401 — what matters is that the origin gate is
   * no longer what stopped them.
   */
  it('ALLOWS every one of them from APP_ORIGIN', async () => {
    const app = createApp();
    for (const mutation of MUTATIONS) {
      const res = await request(app).post(mutation.path).set('Origin', ALLOWED).send(mutation.body);
      expect(res.status, `${mutation.name} was refused from the allowed origin`).not.toBe(403);
    }
  });

  it('REFUSES a receipt upload route from a foreign origin', async () => {
    const res = await request(createApp())
      .post('/api/receipts/upload')
      .set('Origin', FOREIGN)
      .send({});
    expect(res.status).toBe(403);
  });

  /**
   * **The webhook exemption.** A gateway is not a browser: it sends no
   * `Origin`, so without this exemption every real payment notification
   * would 403 and bookings would never be marked paid. They are protected
   * by HMAC signature verification over the raw body instead, which is
   * strictly stronger — an attacker without the signing secret is refused
   * there, and one who has it would not be stopped by a header.
   *
   * Asserted as "not 403": whatever the webhook route decides about an
   * unsigned body (and it refuses it), the ORIGIN check must not be what
   * answered.
   *
   * **This test only means something because of where the middleware is
   * mounted.** While `createOriginCheck()` sat BELOW the webhook router in
   * `app.ts`, the exemption was unreachable — the router answered first,
   * so deleting `EXEMPT_PREFIXES` changed nothing and this test passed
   * either way. A mutation run caught that, the mount moved above the
   * router, and removing the exemption now 403s a gateway callback.
   */
  it('EXEMPTS /api/webhooks/* so a gateway with no Origin still reaches the signature check', async () => {
    const res = await request(createApp())
      .post('/api/webhooks/paymongo')
      .set('Content-Type', 'application/json')
      .send({ data: { id: 'evt_test' } });

    expect(res.status, 'the origin check swallowed a webhook before its signature check').not.toBe(
      403,
    );
  });

  /**
   * A GET changes nothing, so it is none of this middleware's business.
   * Also only meaningful since the mount moved: `/api/health` is declared
   * above where the check used to sit, so this request never reached it.
   */
  it('leaves safe methods alone, with or without an Origin', async () => {
    const app = createApp();
    expect((await request(app).get('/api/health')).status).not.toBe(403);
    expect((await request(app).get('/api/health').set('Origin', FOREIGN)).status).not.toBe(403);
  });
});

describe('isStateChanging', () => {
  it('is true for a POST to a normal route and false for safe methods', () => {
    expect(isStateChanging('POST', '/trpc/checkout.createHold')).toBe(true);
    expect(isStateChanging('PATCH', '/api/anything')).toBe(true);
    expect(isStateChanging('DELETE', '/api/anything')).toBe(true);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(isStateChanging(method, '/trpc/checkout.createHold')).toBe(false);
    }
  });

  it('exempts the webhook prefix and nothing that merely looks like it', () => {
    expect(isStateChanging('POST', '/api/webhooks/paymongo')).toBe(false);
    expect(isStateChanging('POST', '/api/webhooks')).toBe(false);
    // A path that only STARTS with the same letters is not exempt — this is
    // the prefix-matching mistake that turns an exemption into a bypass.
    expect(isStateChanging('POST', '/api/webhooks-not-really/x')).toBe(true);
    expect(isStateChanging('POST', '/api/webhooksx')).toBe(true);
  });
});

describe('allowedOrigins', () => {
  /**
   * **`env.APP_ORIGIN` defaults to `http://localhost:5180`**, which made the
   * first version of this test vacuous: "the list contains the dev origin"
   * passed with the dev push deleted, because APP_ORIGIN already *was* the
   * dev origin. It proved the default, not the behaviour. A mutation run
   * caught it.
   *
   * So APP_ORIGIN is pointed at the production domain for the duration —
   * the only configuration in which the two values differ and the push is
   * therefore observable. `env` is a parsed object read once at import, so
   * it is written directly and restored, as `owner-seed.test.ts` does.
   */
  it('adds the dev server ALONGSIDE APP_ORIGIN outside production', () => {
    const original = env.APP_ORIGIN;
    (env as { APP_ORIGIN: string }).APP_ORIGIN = 'https://travelsugbo.com';
    try {
      const origins = allowedOrigins();
      expect(origins).toContain('https://travelsugbo.com');
      expect(origins, 'the dev origin is missing — nothing can post from localhost').toContain(
        'http://localhost:5180',
      );
    } finally {
      (env as { APP_ORIGIN: string }).APP_ORIGIN = original;
    }
  });

  /**
   * And in production the dev origin is NOT in the list, so a misconfigured
   * box cannot accept a request forged from a developer's machine.
   */
  it('does NOT allow the dev server in production', () => {
    const origin = env.APP_ORIGIN;
    const siteEnv = env.SITE_ENV;
    (env as { APP_ORIGIN: string }).APP_ORIGIN = 'https://travelsugbo.com';
    (env as { SITE_ENV: string }).SITE_ENV = 'production';
    try {
      expect(allowedOrigins()).toEqual(['https://travelsugbo.com']);
    } finally {
      (env as { APP_ORIGIN: string }).APP_ORIGIN = origin;
      (env as { SITE_ENV: string }).SITE_ENV = siteEnv;
    }
  });

  it('lists no duplicates when APP_ORIGIN already is the dev origin', () => {
    const origins = allowedOrigins();
    expect(new Set(origins).size).toBe(origins.length);
  });

  it('never includes a wildcard', () => {
    expect(allowedOrigins()).not.toContain('*');
  });
});
