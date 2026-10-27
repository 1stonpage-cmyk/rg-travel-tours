/**
 * Week 7 plan, Task 10 — `reviews.voteHelpful` (BUILD_SPEC §4: "Was this
 * helpful? — one per browser via cookie + IP rate limit").
 *
 * Two properties carry this file, and both are about what is NOT stored.
 *
 *  1. **`voter_hash` is a SHA-256 of the anonymous cookie id plus the IP, and
 *     never the address itself.** `review_helpful_votes` has no admin screen,
 *     no retention rule and no subject-access path behind it, so it must not
 *     hold a raw IP — that is personal data under RA 10173 (the column's own
 *     doc comment says so, and this is the test that holds the code to it).
 *  2. **The one-vote rule is the composite primary key.** A second vote from
 *     the same browser is a duplicate-key shrug (`counted: false`) — not an
 *     error a reader sees, and not a second row.
 *
 * The rate-limit block goes through the REAL app mount, because a limiter
 * tested against a hand-built middleware stack proves nothing about whether
 * `app.ts` mounts it. It votes on an id no review has, so every attempt is a
 * 404 that still costs budget and writes nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createApp } from '../app';
import { getDb } from '../db/client';
import { auditLog, destinations, reviewHelpfulVotes, reviews, tours } from '../db/schema';
import { VOTER_COOKIE } from '../services/reviews/votes';
import { REVIEW_VOTE_MAX, REVIEW_VOTE_PROCEDURES } from '../middleware/rate-limit';
import { appRouter } from '../routers/_app';
import { captureResponse, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const BROWSER_ORIGIN = 'http://localhost:5180';

/** An id no review in this database ever has. */
const NO_SUCH_REVIEW_ID = 2_000_000_200;

const created = {
  reviewIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}_${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
};

let tourSlug = '';

/**
 * The hash the implementation must produce, computed here from first
 * principles rather than by calling the function under test — the separator
 * is part of the contract this file pins.
 */
function expectedHash(cookieId: string, ip: string): string {
  return createHash('sha256').update(`${cookieId}:${ip}`).digest('hex');
}

/**
 * A caller that looks like an anonymous browser: an optional `rg_vid` cookie,
 * an IP, and a `res` whose cookie writes are observable.
 */
function voter(opts: { cookieId?: string; ip?: string; rawCookie?: string } = {}) {
  const cookies: Record<string, string> = {};
  const value = opts.rawCookie ?? opts.cookieId;
  if (value !== undefined) cookies[VOTER_COOKIE] = value;
  const captured = captureResponse();
  const ctx = {
    req: { cookies, ip: opts.ip ?? '203.0.113.7' } as unknown as Request,
    res: captured.res,
    session: null,
  };
  return { api: appRouter.createCaller(ctx as never), set: captured.set };
}

async function makeTour() {
  const slug = `__revvote__${unique()}`;
  const [dest] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({ slug, title: `Review Vote Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);
  return { id: tour.insertId, slug };
}

async function makeReview(
  tourId: number,
  opts: { status?: 'pending' | 'published' | 'hidden'; rating?: number } = {},
) {
  const [row] = await getDb()
    .insert(reviews)
    .values({
      tourId,
      name: 'Maria Santos',
      rating: opts.rating ?? 5,
      guide: 5,
      body: `Vote fixture review ${unique()}.`,
      status: opts.status ?? 'published',
    });
  created.reviewIds.push(row.insertId);
  return row.insertId;
}

async function votesFor(reviewId: number) {
  return getDb()
    .select({ reviewId: reviewHelpfulVotes.reviewId, voterHash: reviewHelpfulVotes.voterHash })
    .from(reviewHelpfulVotes)
    .where(eq(reviewHelpfulVotes.reviewId, reviewId))
    .orderBy(asc(reviewHelpfulVotes.voterHash));
}

let suiteTourId = 0;

beforeAll(async () => {
  const tour = await makeTour();
  suiteTourId = tour.id;
  tourSlug = tour.slug;
}, 60_000);

afterAll(async () => {
  const db = getDb();
  if (created.reviewIds.length > 0) {
    await db
      .delete(reviewHelpfulVotes)
      .where(inArray(reviewHelpfulVotes.reviewId, created.reviewIds));
    await db.delete(reviews).where(inArray(reviews.id, created.reviewIds));
  }
  // The limiter block votes on an id no review has; nothing can have been
  // written under it, but a broken build that skipped the published check
  // would have, so it is swept by name.
  await db.delete(reviewHelpfulVotes).where(eq(reviewHelpfulVotes.reviewId, NO_SUCH_REVIEW_ID));
  if (created.tourIds.length > 0) {
    await db.delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
  }
});

/* ------------------------------------------------------------------ *
 * The hash — the RA 10173 property
 * ------------------------------------------------------------------ */

describeWithDb('reviews.voteHelpful — what it stores', () => {
  it('stores a SHA-256 of the cookie id plus the IP, and NEITHER of them', async () => {
    const reviewId = await makeReview(suiteTourId);
    const cookieId = randomUUID();
    const ip = '203.0.113.42';

    await expect(voter({ cookieId, ip }).api.reviews.voteHelpful({ reviewId })).resolves.toEqual({
      ok: true,
      counted: true,
    });

    const rows = await votesFor(reviewId);
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.voterHash;

    expect(stored).toBe(expectedHash(cookieId, ip));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // The two things that must never be recoverable from the row.
    expect(stored, 'the raw IP is in the column').not.toContain(ip);
    expect(stored, 'the cookie id is in the column').not.toContain(cookieId);
  });

  it('mints an httpOnly, sameSite=lax cookie when the browser has none', async () => {
    const reviewId = await makeReview(suiteTourId);
    const { api, set } = voter({ ip: '203.0.113.43' });

    await api.reviews.voteHelpful({ reviewId });

    expect(set).toHaveLength(1);
    expect(set[0]!.name).toBe(VOTER_COOKIE);
    // A distinct cookie, never the session one.
    expect(set[0]!.name).not.toBe('rg_session');
    expect(set[0]!.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(set[0]!.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });

    // And the row is the hash of exactly the id it just handed out.
    const rows = await votesFor(reviewId);
    expect(rows[0]!.voterHash).toBe(expectedHash(set[0]!.value, '203.0.113.43'));
  });

  it('does NOT re-mint a cookie the browser already has', async () => {
    const reviewId = await makeReview(suiteTourId);
    const { api, set } = voter({ cookieId: randomUUID() });
    await api.reviews.voteHelpful({ reviewId });
    expect(set, 'a repeat visitor was handed a second identity').toEqual([]);
  });

  /**
   * The cookie is `httpOnly`, so a browser script cannot forge one — but
   * `curl` can send anything. A value that is not a minted id is replaced
   * rather than hashed, so the column only ever holds a hash of a well-formed
   * identifier.
   */
  it('replaces a malformed cookie value instead of hashing it', async () => {
    const reviewId = await makeReview(suiteTourId);
    const junk = 'not-a-uuid; drop table reviews';
    const { api, set } = voter({ rawCookie: junk, ip: '203.0.113.44' });

    await api.reviews.voteHelpful({ reviewId });

    expect(set).toHaveLength(1);
    const rows = await votesFor(reviewId);
    expect(rows[0]!.voterHash).not.toBe(expectedHash(junk, '203.0.113.44'));
    expect(rows[0]!.voterHash).toBe(expectedHash(set[0]!.value, '203.0.113.44'));
  });

  /** `req.ip` is undefined on a context assembled without Express. */
  it('does not crash when the request has no IP at all', async () => {
    const reviewId = await makeReview(suiteTourId);
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.reviews.voteHelpful({ reviewId })).resolves.toMatchObject({ counted: true });
    expect(await votesFor(reviewId)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * One vote per browser — the composite primary key
 * ------------------------------------------------------------------ */

describeWithDb('reviews.voteHelpful — one vote per browser', () => {
  it('shrugs at a second vote: counted false, and still exactly ONE row', async () => {
    const reviewId = await makeReview(suiteTourId);
    const cookieId = randomUUID();
    const ip = '203.0.113.45';

    const first = await voter({ cookieId, ip }).api.reviews.voteHelpful({ reviewId });
    expect(first).toEqual({ ok: true, counted: true });

    const second = await voter({ cookieId, ip }).api.reviews.voteHelpful({ reviewId });
    expect(second, 'a repeat vote must be a shrug, not an error').toEqual({
      ok: true,
      counted: false,
    });

    expect(await votesFor(reviewId), 'a second row was written').toHaveLength(1);
  });

  it('counts a DIFFERENT browser separately', async () => {
    const reviewId = await makeReview(suiteTourId);
    const ip = '203.0.113.46';
    await voter({ cookieId: randomUUID(), ip }).api.reviews.voteHelpful({ reviewId });
    await voter({ cookieId: randomUUID(), ip }).api.reviews.voteHelpful({ reviewId });
    expect(await votesFor(reviewId)).toHaveLength(2);
  });

  /** One vote per review, not one vote for the whole site. */
  it('lets the same browser vote on a DIFFERENT review', async () => {
    const first = await makeReview(suiteTourId);
    const second = await makeReview(suiteTourId);
    const cookieId = randomUUID();

    await expect(
      voter({ cookieId }).api.reviews.voteHelpful({ reviewId: first }),
    ).resolves.toMatchObject({ counted: true });
    await expect(
      voter({ cookieId }).api.reviews.voteHelpful({ reviewId: second }),
    ).resolves.toMatchObject({ counted: true });

    expect(await votesFor(first)).toHaveLength(1);
    expect(await votesFor(second)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * What may be voted on
 * ------------------------------------------------------------------ */

describeWithDb('reviews.voteHelpful — what may be voted on', () => {
  for (const status of ['pending', 'hidden'] as const) {
    it(`REFUSES a ${status} review with NOT_FOUND, writing nothing`, async () => {
      const reviewId = await makeReview(suiteTourId, { status });
      await expect(voter().api.reviews.voteHelpful({ reviewId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await votesFor(reviewId)).toEqual([]);
    });
  }

  it('REFUSES an id no review has, with the same NOT_FOUND', async () => {
    await expect(
      voter().api.reviews.voteHelpful({ reviewId: NO_SUCH_REVIEW_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('REFUSES an unknown input field, and a non-positive id', async () => {
    const reviewId = await makeReview(suiteTourId);
    await expect(
      voter().api.reviews.voteHelpful({ reviewId, voterHash: 'deadbeef' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(voter().api.reviews.voteHelpful({ reviewId: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await votesFor(reviewId)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The count the public block reads
 * ------------------------------------------------------------------ */

describeWithDb('reviews.forTour — helpfulCount and the helpful sort', () => {
  it('reports the vote count per review and orders by it on request', async () => {
    const tour = await makeTour();
    const quiet = await makeReview(tour.id, { rating: 5 });
    const popular = await makeReview(tour.id, { rating: 3 });

    for (let i = 0; i < 3; i += 1) {
      await voter({ cookieId: randomUUID() }).api.reviews.voteHelpful({ reviewId: popular });
    }
    await voter({ cookieId: randomUUID() }).api.reviews.voteHelpful({ reviewId: quiet });

    const api = appRouter.createCaller(testContext() as never);

    const byHelpful = await api.reviews.forTour({ tourSlug: tour.slug, sort: 'helpful' });
    expect(byHelpful.items.map((item) => [item.id, item.helpfulCount])).toEqual([
      [popular, 3],
      [quiet, 1],
    ]);

    // The count travels on every ordering, not only the helpful one.
    const byNewest = await api.reviews.forTour({ tourSlug: tour.slug });
    expect(byNewest.items.find((item) => item.id === popular)!.helpfulCount).toBe(3);
  });

  it('reports zero for a review nobody voted on, and still lists it', async () => {
    const tour = await makeTour();
    const reviewId = await makeReview(tour.id);
    const api = appRouter.createCaller(testContext() as never);
    const result = await api.reviews.forTour({ tourSlug: tour.slug, sort: 'helpful' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: reviewId, helpfulCount: 0 });
  });

  it('leaves the star breakdown untouched by votes', async () => {
    const tour = await makeTour();
    const reviewId = await makeReview(tour.id, { rating: 4 });
    await voter({ cookieId: randomUUID() }).api.reviews.voteHelpful({ reviewId });

    const api = appRouter.createCaller(testContext() as never);
    const result = await api.reviews.forTour({ tourSlug: tour.slug });
    expect(result.total).toBe(1);
    expect(result.breakdown.find((row) => row.stars === 4)).toEqual({ stars: 4, count: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * The rate limit (§12), through the REAL app mount
 * ------------------------------------------------------------------ */

function voteRequest(app: Parameters<typeof request>[0], path: string) {
  return request(app).post(path).set('Origin', BROWSER_ORIGIN);
}

describeWithDb('the helpful-vote rate limit', () => {
  const procedure = REVIEW_VOTE_PROCEDURES[0];

  /**
   * Every attempt counts, successful or not (no `skipSuccessfulRequests`) —
   * so this votes on an id no review has: each one is a 404 that costs
   * budget and writes no row. A limiter that only counted failures would
   * leave a voter free to inflate a count forever.
   */
  it('answers 429 once the per-IP budget is spent', async () => {
    const app = createApp();
    for (let i = 0; i < REVIEW_VOTE_MAX; i += 1) {
      const res = await voteRequest(app, `/trpc/${procedure}`).send({
        reviewId: NO_SUCH_REVIEW_ID,
      });
      expect(res.status, `attempt ${i + 1} should have been allowed through`).toBe(404);
    }
    const refused = await voteRequest(app, `/trpc/${procedure}`).send({
      reviewId: NO_SUCH_REVIEW_ID,
    });
    expect(refused.status).toBe(429);
  });

  /**
   * BUG-111's lesson: the limiter counts procedure CALLS, not HTTP requests.
   * A batch naming the vote twice spends two units of budget, so a batch of
   * `REVIEW_VOTE_MAX` calls exhausts it in ONE request.
   */
  it('counts a batched vote once per CALL, not once per request', async () => {
    const app = createApp();
    const batch = Array.from({ length: REVIEW_VOTE_MAX }, () => procedure).join(',');
    await voteRequest(app, `/trpc/${batch}?batch=1`).send(
      Object.fromEntries(
        Array.from({ length: REVIEW_VOTE_MAX }, (_, i) => [i, { reviewId: NO_SUCH_REVIEW_ID }]),
      ),
    );
    const refused = await voteRequest(app, `/trpc/${procedure}`).send({
      reviewId: NO_SUCH_REVIEW_ID,
    });
    expect(
      refused.status,
      'one batch of the whole budget left room for another vote — the limiter is counting requests',
    ).toBe(429);
  });

  it('leaves the public read untouched — a query is not a vote', async () => {
    const app = createApp();
    const path = `/trpc/reviews.forTour?input=${encodeURIComponent(JSON.stringify({ tourSlug }))}`;
    for (let i = 0; i < REVIEW_VOTE_MAX + 2; i += 1) {
      await request(app).get(path).expect(200);
    }
  });

  it('wrote no vote row at all while refusing every attempt', async () => {
    expect(await votesFor(NO_SUCH_REVIEW_ID)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * A vote is not an audit event
 * ------------------------------------------------------------------ */

describeWithDb('a helpful vote writes no audit row', () => {
  /**
   * §12's audit list is payments, refunds, status changes and assignments. A
   * helpful vote is none of them, and a row per vote would bury the log an
   * admin actually reads under anonymous clicks.
   */
  it('records the vote and nothing in audit_log', async () => {
    const reviewId = await makeReview(suiteTourId);
    await voter({ cookieId: randomUUID() }).api.reviews.voteHelpful({ reviewId });

    expect(await votesFor(reviewId)).toHaveLength(1);
    const audits = await getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'reviews'), eq(auditLog.entityId, reviewId)));
    expect(audits).toEqual([]);
  });
});
