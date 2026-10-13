/**
 * Week 4 plan, Task 2: the customer portal login (§7 — booking ref + email).
 *
 * **The credential check is not re-implemented here.** `checkout.bookingLookup`
 * already matched a ref against a case-insensitive email and refused both
 * wrongs identically; this task extracts that into
 * `services/portal-auth.ts` so the lookup and the login cannot drift into
 * two different ideas of "these credentials match this booking". The tests
 * below therefore pin the SERVICE and the session it mints, and
 * `checkout-router.test.ts`'s existing lookup tests go on proving the
 * extraction did not change the lookup's behaviour.
 *
 * Two §7 rules carry the weight, and each has a test whose failure would be
 * a real vulnerability rather than a wrong message:
 *
 *  1. **The same refusal for a wrong ref and a wrong email.** Two different
 *     answers make the pair an oracle for which refs exist. Asserted by deep
 *     equality of the two thrown errors, never by reading each one — a test
 *     that checked them separately would pass against two messages that
 *     merely look alike.
 *  2. **A session scoped to that ONE booking.** `subject_id` is the
 *     `bookings.id`, so there is no value a portal session could carry that
 *     would widen it to another guest's booking.
 */
import { afterEach, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, tours } from '../db/schema';
import request from 'supertest';
import { createApp } from '../app';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { findBookingByCredentials } from '../services/portal-auth';
import { readSession } from '../services/sessions';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { describeWithDb } from './helpers/db';

const created = { bookingIds: [] as number[], tourIds: [] as number[], destIds: [] as number[] };
const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

/** A committed booking with a known ref and lead email. */
async function makeBooking(leadEmail: string) {
  const db = getDb();
  const slug = `__portal__${unique()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db.insert(tours).values({ slug, title: slug, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date('2099-12-20T00:00:00Z'),
    pax: 2,
    leadName: 'Portal Fixture',
    leadEmail,
    leadPhone: '09170000000',
    status: 'confirmed',
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100000 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: 100000,
      discountCentavos: 0,
      totalCentavos: 100000,
    },
    subtotalCentavos: 100000,
    totalCentavos: 100000,
  });
  created.bookingIds.push(booking.insertId);
  return { ref, bookingId: booking.insertId };
}

/** Captures the Set-Cookie a resolver asks for. */
function fakeResponse() {
  const cookies: Array<{ name: string; value: string }> = [];
  const res = {
    cookie: (name: string, value: string) => void cookies.push({ name, value }),
    clearCookie: (name: string) => void cookies.push({ name, value: '' }),
  } as unknown as Response;
  return { res, cookies };
}

const caller = (session: unknown = null) =>
  appRouter.createCaller({
    req: {} as unknown as Request,
    res: fakeResponse().res,
    session,
  } as never);

/** A caller whose Set-Cookie calls are observable. */
function callerWithCookies(session: unknown = null) {
  const { res, cookies } = fakeResponse();
  return {
    cookies,
    api: appRouter.createCaller({ req: {} as unknown as Request, res, session } as never),
  };
}

async function cleanup() {
  const pool = getPool();
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.tourIds) await getDb().delete(tours).where(eq(tours.id, id));
  for (const id of created.destIds)
    await getDb().delete(destinations).where(eq(destinations.id, id));
  created.bookingIds = [];
  created.tourIds = [];
  created.destIds = [];
}

describeWithDb('findBookingByCredentials', () => {
  afterEach(cleanup);

  /**
   * **Measured, and worth knowing before trusting this test:** it passes
   * against an implementation with NO case normalisation at all, because
   * `bookings.ref` and `lead_email` are stored under a case-INSENSITIVE
   * collation (`utf8mb4_..._ci`), so `WHERE ref = ?` already matches across
   * case at the database level. Removing `.toUpperCase()` / `LOWER()` leaves
   * this green.
   *
   * It stays because the BEHAVIOUR is what §7 requires and must hold
   * whatever the collation is; the explicit normalisation in
   * `portal-auth.ts` is there so a future migration to a case-sensitive
   * collation cannot silently stop a guest logging in. Same reasoning
   * `services/coupons.ts` records for `coupons.code`. What this test cannot
   * do is prove the normalisation is load-bearing today — nothing can,
   * because it is not.
   */
  it('matches the ref and the email, case-insensitively on both', async () => {
    const { ref, bookingId } = await makeBooking('Guest@Example.test');
    expect(await findBookingByCredentials(ref, 'guest@example.test')).toEqual({ id: bookingId });
    expect(await findBookingByCredentials(ref.toLowerCase(), 'GUEST@EXAMPLE.TEST')).toEqual({
      id: bookingId,
    });
  });

  it('tolerates surrounding whitespace, which guests paste constantly', async () => {
    const { ref, bookingId } = await makeBooking('guest@example.test');
    expect(await findBookingByCredentials(`  ${ref} `, ' guest@example.test  ')).toEqual({
      id: bookingId,
    });
  });

  it('returns null for a wrong email on a real ref, and for a ref that does not exist', async () => {
    const { ref } = await makeBooking('guest@example.test');
    expect(await findBookingByCredentials(ref, 'someone@else.test')).toBeNull();
    expect(await findBookingByCredentials('RG-ZZZZZZ', 'guest@example.test')).toBeNull();
  });

  it('never matches a DIFFERENT booking that happens to share the email', async () => {
    const first = await makeBooking('same@example.test');
    const second = await makeBooking('same@example.test');
    expect(await findBookingByCredentials(first.ref, 'same@example.test')).toEqual({
      id: first.bookingId,
    });
    expect(await findBookingByCredentials(second.ref, 'same@example.test')).toEqual({
      id: second.bookingId,
    });
  });
});

describeWithDb('portal.login', () => {
  afterEach(cleanup);

  it('logs in and sets the session cookie', async () => {
    const { ref, bookingId } = await makeBooking('guest@example.test');
    const { api, cookies } = callerWithCookies();

    await expect(api.portal.login({ ref, email: 'guest@example.test' })).resolves.toEqual({
      ok: true,
    });

    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe(SESSION_COOKIE);
    expect(await readSession(cookies[0]!.value, new Date())).toEqual({
      subjectType: 'customer',
      subjectId: bookingId,
    });
  });

  /**
   * §7's anti-enumeration rule. Deep equality on BOTH the code and the
   * message: a refusal that differs in either is an oracle.
   */
  it('refuses a wrong ref and a wrong email with a byte-identical error', async () => {
    const { ref } = await makeBooking('guest@example.test');

    const wrongRef = await caller()
      .portal.login({ ref: 'RG-ZZZZZZ', email: 'guest@example.test' })
      .catch((e: unknown) => e);
    const wrongEmail = await caller()
      .portal.login({ ref, email: 'someone@else.test' })
      .catch((e: unknown) => e);

    expect((wrongRef as Error).message).toBe((wrongEmail as Error).message);
    expect((wrongRef as { code?: string }).code).toBe((wrongEmail as { code?: string }).code);
  });

  it('sets NO cookie when it refuses', async () => {
    await makeBooking('guest@example.test');
    const { api, cookies } = callerWithCookies();
    await api.portal
      .login({ ref: 'RG-ZZZZZZ', email: 'guest@example.test' })
      .catch(() => undefined);
    expect(cookies, 'a refused login still handed out a cookie').toHaveLength(0);
  });

  /**
   * The scoping property, stated as the thing that would be a breach: a
   * session minted for booking A must not resolve to booking B.
   */
  it('scopes the session to that ONE booking', async () => {
    const a = await makeBooking('a@example.test');
    const b = await makeBooking('b@example.test');
    const { api, cookies } = callerWithCookies();

    await api.portal.login({ ref: a.ref, email: 'a@example.test' });

    const session = await readSession(cookies[0]!.value, new Date());
    expect(session).toEqual({ subjectType: 'customer', subjectId: a.bookingId });
    expect(session!.subjectId).not.toBe(b.bookingId);
  });

  it('mints a NEW session each time, so two devices can both be logged in', async () => {
    const { ref } = await makeBooking('guest@example.test');
    const first = callerWithCookies();
    const second = callerWithCookies();
    await first.api.portal.login({ ref, email: 'guest@example.test' });
    await second.api.portal.login({ ref, email: 'guest@example.test' });

    expect(first.cookies[0]!.value).not.toBe(second.cookies[0]!.value);
    expect(await readSession(first.cookies[0]!.value, new Date())).not.toBeNull();
    expect(await readSession(second.cookies[0]!.value, new Date())).not.toBeNull();
  });
});

describeWithDb('portal.logout', () => {
  afterEach(cleanup);

  it('revokes the session and clears the cookie', async () => {
    const { ref, bookingId } = await makeBooking('guest@example.test');
    const { api, cookies } = callerWithCookies();
    await api.portal.login({ ref, email: 'guest@example.test' });
    const token = cookies[0]!.value;

    const out = callerWithCookies({ subjectType: 'customer', subjectId: bookingId });
    await out.api.portal.logout({ token });

    expect(await readSession(token, new Date()), 'the session survived a logout').toBeNull();
    expect(out.cookies.some((c) => c.name === SESSION_COOKIE && c.value === '')).toBe(true);
  });

  it('is harmless with no session at all', async () => {
    const { api } = callerWithCookies();
    await expect(api.portal.logout({})).resolves.toEqual({ ok: true });
  });
});

/**
 * The shared budget, which is a security property this task introduced and
 * not merely a configuration detail.
 *
 * `portal.login` and `checkout.bookingLookup` take the SAME credential pair
 * against the SAME booking, so they are one attack surface. Two independent
 * limiters would have given an attacker five guesses on each — ten against
 * the five §7 sets. The test spends the budget ACROSS both procedures and
 * asserts the sixth attempt, whichever endpoint it arrives at, is refused.
 *
 * Driven through `createApp()` rather than a hand-built express app, so it
 * also proves the mount in `app.ts` actually covers `portal.login`: a
 * limiter that exists but is not mounted on the new procedure would pass
 * every unit test of the factory and protect nothing.
 */
describeWithDb('the shared ref+email budget', () => {
  afterEach(cleanup);

  it('spends ONE budget of five across portal.login and checkout.bookingLookup', async () => {
    const app = createApp();
    const wrong = { ref: 'RG-ZZZZZZ', email: 'nobody@example.test' };

    // Three failed logins (mutations: POST).
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/trpc/portal.login').send(wrong);
      expect(res.status, 'a failed login should be a 4xx, so the limiter counts it').toBe(401);
    }

    // Two failed lookups (a query: GET) — the SAME budget, now at five.
    const lookupPath = `/trpc/checkout.bookingLookup?input=${encodeURIComponent(
      JSON.stringify(wrong),
    )}`;
    for (let i = 0; i < 2; i += 1) {
      expect((await request(app).get(lookupPath)).status).toBe(404);
    }

    // Six: refused, on either door.
    expect(
      (await request(app).post('/trpc/portal.login').send(wrong)).status,
      'the login had its own budget rather than sharing the lookup one',
    ).toBe(429);
    expect(
      (await request(app).get(lookupPath)).status,
      'the lookup had its own budget rather than sharing the login one',
    ).toBe(429);
  });
});
