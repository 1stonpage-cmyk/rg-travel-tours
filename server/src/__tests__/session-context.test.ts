/**
 * Week 4 plan, Task 1 — the wiring, as opposed to the session service.
 * Rewritten for BUG-119 (Week 7 pre-launch fixes): one cookie PER SURFACE
 * instead of one shared `rg_session`.
 *
 * `sessions.test.ts` proves mint/resolve/revoke. This file proves the things
 * between that service and a request: the **cookie's flags** (now per
 * surface, but identical across all three), the **context factory** that
 * turns three independent cookies into `ctx.adminSession` /
 * `ctx.driverSession` / `ctx.customerSession`, and — the whole point of the
 * split — that the three surfaces no longer evict one another in the same
 * browser and cannot reach one another's gated procedures.
 *
 * The flags are tested because they ARE the control. `httpOnly` missing
 * would hand every XSS payload a live session and absolutely nothing else
 * would fail — not a type, not a lint rule, not another test. That is the
 * definition of a thing worth pinning.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import request from 'supertest';
import { getDb, getPool } from '../db/client';
import { users } from '../db/schema';
import { createApp } from '../app';
import { createContext } from '../context';
import {
  SESSION_COOKIE_BY_SUBJECT,
  clearSessionCookie,
  setSessionCookie,
} from '../middleware/session-cookie';
import { createSession, type SessionSubject } from '../services/sessions';
import { describeWithDb } from './helpers/db';

const NOW = new Date('2026-10-13T04:00:00Z');
const SUBJECT_ID = 930_001;
const ORIGIN = 'http://localhost:5180';
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** Captures what a resolver hands `res.cookie`, without an HTTP round trip. */
function fakeResponse() {
  const set: CapturedCookie[] = [];
  const cleared: CapturedCookie[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, value: '', options });
    },
  } as unknown as Response;
  return { res, set, cleared };
}

const fakeRequest = (cookies?: Record<string, string>) => ({ cookies }) as unknown as Request;

const SUBJECTS: readonly SessionSubject[] = ['user', 'driver', 'customer'];

describe('the session cookie', () => {
  /**
   * One cookie NAME per surface, but the same flags on all three — looped
   * rather than hand-written three times, so a fourth subject added to
   * `SessionSubject` without a matching cookie name fails
   * `SESSION_COOKIE_BY_SUBJECT`'s own `Record<SessionSubject, string>` type
   * before this loop even runs.
   */
  for (const subjectType of SUBJECTS) {
    describe(`for ${subjectType}`, () => {
      it(`sets the cookie named ${SESSION_COOKIE_BY_SUBJECT[subjectType]}, httpOnly and sameSite=lax`, () => {
        const { res, set } = fakeResponse();
        setSessionCookie(res, subjectType, 'a-token', new Date('2026-10-14T04:00:00Z'));

        expect(set).toHaveLength(1);
        expect(set[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT[subjectType]);
        expect(set[0]!.value).toBe('a-token');
        expect(
          set[0]!.options.httpOnly,
          'httpOnly missing: an XSS payload could read the session',
        ).toBe(true);
        expect(
          set[0]!.options.sameSite,
          'sameSite missing: a cross-site POST would carry the session',
        ).toBe('lax');
        expect(set[0]!.options.path).toBe('/');
      });

      /**
       * `expires` must match the row's own `expires_at`, so the browser stops
       * sending a token the server has already begun refusing. A cookie that
       * outlives its row is not a security hole — it is a guest who looks
       * logged in and gets refused on every click.
       */
      it('expires with the row, not on its own schedule', () => {
        const { res, set } = fakeResponse();
        const expiresAt = new Date('2026-10-14T04:00:00Z');
        setSessionCookie(res, subjectType, 'a-token', expiresAt);
        expect(set[0]!.options.expires).toEqual(expiresAt);
      });

      /**
       * `secure` is off outside production ON PURPOSE: the dev server is
       * plain HTTP on 5180, and a secure cookie is never sent over HTTP — the
       * portal would appear to log in and be immediately logged out. The
       * test states the environment-dependence so nobody "hardens" it and
       * breaks dev.
       */
      it('is not secure in development, which is why dev login works at all', () => {
        const { res, set } = fakeResponse();
        setSessionCookie(res, subjectType, 'a-token', NOW);
        expect(set[0]!.options.secure).toBe(false);
      });

      it('clears with the same NAME and path it was set with', () => {
        const { res, cleared } = fakeResponse();
        clearSessionCookie(res, subjectType);
        expect(cleared).toHaveLength(1);
        expect(cleared[0]!.name).toBe(SESSION_COOKIE_BY_SUBJECT[subjectType]);
        expect(cleared[0]!.options.path).toBe('/');
      });
    });
  }

  /**
   * **BUG-119's whole premise.** Three distinct names, pairwise different —
   * not merely "three strings", because a bug that aliased two of them back
   * together would make this suite's other tests individually pass while
   * the eviction bug came straight back.
   */
  it('gives each surface a DIFFERENT cookie name', () => {
    const names = SUBJECTS.map((s) => SESSION_COOKIE_BY_SUBJECT[s]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describeWithDb('createContext', () => {
  afterEach(async () => {
    await getPool().query('DELETE FROM sessions WHERE subject_id = ?', [SUBJECT_ID]);
  });

  it('resolves a live customer cookie onto ctx.customerSession, leaving the other two null', async () => {
    const { token } = await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      req: fakeRequest({ [SESSION_COOKIE_BY_SUBJECT.customer]: token }),
      res,
    } as never);
    expect(ctx.customerSession).toEqual({ subjectType: 'customer', subjectId: SUBJECT_ID });
    expect(ctx.adminSession).toBeNull();
    expect(ctx.driverSession).toBeNull();
  });

  /** An anonymous request is the normal case on a public site, not an error. */
  it('gives all three fields null for no cookie at all, without throwing', async () => {
    const { res } = fakeResponse();
    const ctx = await createContext({ req: fakeRequest(), res } as never);
    expect(ctx.adminSession).toBeNull();
    expect(ctx.driverSession).toBeNull();
    expect(ctx.customerSession).toBeNull();
  });

  /**
   * A live session must exist for this to prove anything — against an empty
   * table, even an implementation that ignored the token and returned the
   * first row it found would answer null. Same weakness, same fix, as the
   * unknown-token case in `sessions.test.ts`.
   */
  it('gives a null customerSession for a cookie that resolves to nothing', async () => {
    await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      req: fakeRequest({ [SESSION_COOKIE_BY_SUBJECT.customer]: 'not-a-real-token' }),
      res,
    } as never);
    expect(ctx.customerSession, 'a bogus cookie resolved to a real session').toBeNull();
  });

  /**
   * **The property the whole admin surface rests on, restated for three
   * cookies instead of one.** Before BUG-119's fix, a portal session and a
   * staff session arrived in the SAME cookie and only `subject_type` told
   * them apart. Now a customer token presented under the ADMIN cookie's name
   * must still not resolve into `ctx.adminSession` — `resolveSurfaceSession`
   * checks the subject type against the surface the cookie claims to be for,
   * not only against the token's own validity.
   */
  it('refuses to adopt a customer session presented under the ADMIN cookie name', async () => {
    const { token } = await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      // The admin cookie NAME, carrying a token that is really a customer
      // session — the shape a stolen or mis-set cookie would take.
      req: fakeRequest({ [SESSION_COOKIE_BY_SUBJECT.user]: token }),
      res,
    } as never);
    expect(
      ctx.adminSession,
      'a customer token was accepted as an admin session merely by arriving under that cookie name',
    ).toBeNull();
    // And it is not picked up as a customer session either, since it did
    // not arrive under THAT cookie's name.
    expect(ctx.customerSession).toBeNull();
  });

  it('resolves all three independently when a browser sends all three cookies at once', async () => {
    const admin = await createSession('user', 930_002, new Date());
    const driver = await createSession('driver', 930_003, new Date());
    const customer = await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    try {
      const ctx = await createContext({
        req: fakeRequest({
          [SESSION_COOKIE_BY_SUBJECT.user]: admin.token,
          [SESSION_COOKIE_BY_SUBJECT.driver]: driver.token,
          [SESSION_COOKIE_BY_SUBJECT.customer]: customer.token,
        }),
        res,
      } as never);
      // `ctx.adminSession` is EXPECTED null here: there is no real `users`
      // row behind id 930_002, and `readSession` treats a `user` subject
      // with no matching, active row exactly like a deactivated staff
      // account — null, not a half-resolved session. The driver and
      // customer fields need no such row and resolve to real sessions.
      expect(ctx.adminSession).toBeNull();
      expect(ctx.driverSession).toEqual({ subjectType: 'driver', subjectId: 930_003 });
      expect(ctx.customerSession).toEqual({ subjectType: 'customer', subjectId: SUBJECT_ID });
    } finally {
      await getPool().query('DELETE FROM sessions WHERE subject_id IN (?, ?)', [930_002, 930_003]);
    }
  });
});

/* ======================================================================
 * BUG-119 — the behaviour the whole task exists to prove, end to end over
 * real HTTP with `createApp()` and `supertest`: a browser can now hold all
 * three cookies at once, each surface refuses the other two's cookies, and
 * logging out of one clears only its own.
 * ====================================================================== */

describeWithDb('BUG-119 — one cookie per surface, not one shared cookie', () => {
  let staffUserId = 0;

  beforeAll(async () => {
    const [row] = await getDb()
      .insert(users)
      .values({
        name: 'Cookie Split Fixture',
        email: `cookiesplit_${unique()}@example.test`,
        // Never signed in with through this file — only `createSession` mints
        // tokens directly, so the hash is never verified and need not be real.
        passwordHash: '__cookie_split_fixture_not_a_hash__',
        role: 'owner',
        isActive: true,
      });
    staffUserId = row.insertId;
  }, 30_000);

  afterAll(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      staffUserId,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [staffUserId]);
  });

  /**
   * **The regression this whole task fixes.** Before BUG-119, signing a
   * guest into "My Booking" in the same browser overwrote a live staff
   * session, because both minted the same `rg_session` cookie. Proof: mint
   * a staff session and confirm an admin-only call succeeds; mint a guest
   * session (same "browser" — the two cookies now have different names, so
   * a real browser would hold both); present the ORIGINAL staff cookie again
   * — alongside the guest's own, exactly as a real browser would send both —
   * on a subsequent admin-only call, and confirm it still succeeds.
   */
  it('a guest signing into My Booking no longer evicts a live staff session', async () => {
    const app = createApp();
    // The REAL clock, not the fixed `NOW` above: `createContext` always
    // reads `new Date()` to check a session's expiry, so a session minted
    // against a fixture instant from the past would already be expired by
    // the time this request resolves it.
    const realNow = new Date();
    const staff = await createSession('user', staffUserId, realNow);
    const customerSubjectId = Math.floor(Math.random() * 1e9);
    const customer = await createSession('customer', customerSubjectId, realNow);

    const adminCookie = `${SESSION_COOKIE_BY_SUBJECT.user}=${staff.token}`;
    const customerCookie = `${SESSION_COOKIE_BY_SUBJECT.customer}=${customer.token}`;

    try {
      // Before the guest ever signs in, the staff session answers normally.
      const before = await request(app).get('/trpc/staffAuth.me').set('Cookie', adminCookie);
      expect(before.status).toBe(200);
      expect((before.body as { result: { data: { userId: number } } }).result.data.userId).toBe(
        staffUserId,
      );

      // The guest's login already happened (minted above) — in a real
      // browser BOTH cookies are now present, since they have different
      // names. The admin-only call still succeeds with the SAME staff
      // cookie as before, proving the guest's session did not evict it.
      const after = await request(app)
        .get('/trpc/staffAuth.me')
        .set('Cookie', `${adminCookie}; ${customerCookie}`);
      expect(after.status, 'the staff session was evicted by the guest login').toBe(200);
      expect(
        (after.body as { result: { data: { userId: number } } }).result.data.userId,
        'the staff session answered for the wrong user, or not at all',
      ).toBe(staffUserId);

      // And the guest's own session is just as live, the other direction.
      const guestStillWorks = await request(app)
        .get('/trpc/portal.manualPayment')
        .set('Cookie', `${adminCookie}; ${customerCookie}`);
      // 404 (no such booking) rather than 401 proves the customer session
      // itself resolved and reached the gate — a real booking row is not
      // needed to prove THIS property.
      expect(
        guestStillWorks.status,
        'the staff cookie, sent alongside it, evicted the guest session',
      ).not.toBe(401);
    } finally {
      await getPool().query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'customer',
        customerSubjectId,
      ]);
    }
  });

  /**
   * **Each surface refuses the others' cookies.** Not "a forged token is
   * refused" — a perfectly VALID driver session, presented to an
   * admin-only procedure, is refused simply because the admin cookie is
   * never sent at all. And the reverse.
   */
  it("each surface refuses the OTHER surfaces' cookies", async () => {
    const app = createApp();
    const realNow = new Date(); // see the note above: the REAL clock, not the fixed `NOW`.
    const staff = await createSession('user', staffUserId, realNow);
    const driverSubjectId = Math.floor(Math.random() * 1e9);
    const driver = await createSession('driver', driverSubjectId, realNow);

    const adminCookie = `${SESSION_COOKIE_BY_SUBJECT.user}=${staff.token}`;
    const driverCookie = `${SESSION_COOKIE_BY_SUBJECT.driver}=${driver.token}`;

    try {
      // A valid DRIVER cookie against an ADMIN-only procedure.
      const driverAgainstAdmin = await request(app)
        .get('/trpc/staffAuth.me')
        .set('Cookie', driverCookie);
      expect(
        driverAgainstAdmin.status,
        'a valid driver cookie reached an admin-only procedure',
      ).toBe(401);

      // The reverse: a valid STAFF cookie against a DRIVER-only procedure.
      const staffAgainstDriver = await request(app)
        .get('/trpc/driver.trips')
        .set('Cookie', adminCookie);
      expect(
        staffAgainstDriver.status,
        'a valid staff cookie reached a driver-only procedure',
      ).toBe(401);

      // Sanity: each cookie DOES work against its own surface, so the two
      // refusals above are the cross-surface check doing something, not a
      // route that refuses everyone.
      const driverAgainstDriver = await request(app)
        .get('/trpc/driver.trips')
        .set('Cookie', driverCookie);
      expect(driverAgainstDriver.status).toBe(200);
      const staffAgainstAdmin = await request(app)
        .get('/trpc/staffAuth.me')
        .set('Cookie', adminCookie);
      expect(staffAgainstAdmin.status).toBe(200);
    } finally {
      await getPool().query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'driver',
        driverSubjectId,
      ]);
    }
  });

  /**
   * **Logout clears only its own cookie.** A driver signing out must not
   * touch the admin or customer cookie names at all — not clear them, not
   * mention them.
   */
  it('driver.logout clears only the driver cookie, never the admin or customer ones', async () => {
    const app = createApp();
    const driverSubjectId = Math.floor(Math.random() * 1e9);
    const driver = await createSession('driver', driverSubjectId, new Date()); // the REAL clock — see note above.

    const res = await request(app)
      .post('/trpc/driver.logout')
      .set('Origin', ORIGIN)
      .set('Cookie', `${SESSION_COOKIE_BY_SUBJECT.driver}=${driver.token}`)
      .send({});

    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'];
    const cleared = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];

    expect(
      cleared.some((c) => c.startsWith(`${SESSION_COOKIE_BY_SUBJECT.driver}=`)),
      'driver.logout did not clear its own cookie',
    ).toBe(true);
    expect(
      cleared.some((c) => c.startsWith(`${SESSION_COOKIE_BY_SUBJECT.user}=`)),
      'driver.logout touched the ADMIN cookie',
    ).toBe(false);
    expect(
      cleared.some((c) => c.startsWith(`${SESSION_COOKIE_BY_SUBJECT.customer}=`)),
      'driver.logout touched the CUSTOMER cookie',
    ).toBe(false);
  });
});
