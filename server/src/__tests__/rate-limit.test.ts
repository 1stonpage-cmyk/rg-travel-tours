import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createProcedureRateLimit } from '../middleware/rate-limit';
import { describeWithDb } from './helpers/db';

/**
 * Every POST here is a BROWSER request, so it carries the `Origin` header a
 * browser always sends. Required since Week 4 Task 5 mounted the CSRF
 * origin check ahead of the limiters and the body parser
 * (`middleware/origin-check.ts`): without it these requests are refused 403
 * before the thing under test ever runs.
 */
const BROWSER_ORIGIN = 'http://localhost:5180';
function post(app: Parameters<typeof request>[0], path: string) {
  return request(app).post(path).set('Origin', BROWSER_ORIGIN);
}

function appWith(max: number) {
  const app = express();
  app.use(createProcedureRateLimit(['inquiries.create'], { windowMs: 60_000, max }));
  app.all('/trpc/*splat', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('procedure-scoped rate limiting', () => {
  it('limits the named procedure', async () => {
    const app = appWith(2);
    await post(app, '/trpc/inquiries.create').expect(200);
    await post(app, '/trpc/inquiries.create').expect(200);
    await post(app, '/trpc/inquiries.create').expect(429);
  });

  it('leaves unlisted procedures alone', async () => {
    const app = appWith(1);
    await post(app, '/trpc/tours.list').expect(200);
    await post(app, '/trpc/tours.list').expect(200);
    await post(app, '/trpc/tours.list').expect(200);
  });

  it('still limits a batched call that includes the named procedure', async () => {
    const app = appWith(1);
    // `?batch=1` because that's the real shape httpBatchLink sends — tRPC
    // only treats the path as comma-joined procedure names when the batch
    // flag is present (round 1 review, cheap fix #1).
    await post(app, '/trpc/tours.list,inquiries.create?batch=1').expect(200);
    await post(app, '/trpc/tours.list,inquiries.create?batch=1').expect(429);
  });
});

/**
 * Final whole-branch review, F1 (second half): the limiter used to count
 * HTTP REQUESTS, and a batch is one request carrying any number of
 * procedure CALLS. A 50-call batch of the limited procedure therefore cost
 * one attempt out of five, which is the cap multiplied by fifty.
 *
 * The limits in this repo are all written per ATTEMPT ("5 failed attempts",
 * "5 hold creations") — never per TCP request — so the unit the limiter
 * counts has to be the matched procedure segment, and these two tests pin
 * that unit at the factory level, independent of any one limiter's options.
 */
describe('batch amplification — one attempt per matched CALL, not per request', () => {
  it('spends one unit of budget per matched segment in a batch', async () => {
    const app = appWith(2);
    // Two matched calls in one request = the whole budget.
    await post(app, '/trpc/inquiries.create,inquiries.create?batch=1').expect(200);
    await post(app, '/trpc/inquiries.create').expect(429);
  });

  it('refuses a single batch that exceeds the budget on its own', async () => {
    const app = appWith(2);
    await request(app)
      .post('/trpc/inquiries.create,inquiries.create,inquiries.create?batch=1')
      .expect(429);
  });

  it('counts only the MATCHED segments, not every segment of the batch', async () => {
    const app = appWith(2);
    // One matched call alongside two unlisted ones costs exactly one.
    await post(app, '/trpc/tours.list,inquiries.create,tours.list?batch=1').expect(200);
    await post(app, '/trpc/inquiries.create').expect(200);
    await post(app, '/trpc/inquiries.create').expect(429);
  });
});

/**
 * Final whole-branch review, F1 (first half): `@trpc/server`'s
 * `getHTTPStatusCode` answers **207** when one batch's results carry mixed
 * statuses, and `express-rate-limit`'s default `requestWasSuccessful` is
 * `statusCode < 400`. A `skipSuccessfulRequests` limiter therefore read 207
 * as "that attempt succeeded" and gave the hit back — so a failed call
 * hidden in a batch alongside any successful one was free, without limit.
 *
 * 207 is not a success and not a failure: it is "some of these failed", and
 * for a limiter that counts failures only there is just one safe reading of
 * it. These tests use a toy route that answers 207 directly, so the
 * property is pinned at the factory level; the real-tRPC 207 (which is
 * what actually produced the hole) is pinned in `checkout-router.test.ts`.
 */
describe('mixed-status batches (207) under skipSuccessfulRequests', () => {
  function appAnswering(status: number, max: number) {
    const app = express();
    app.use(
      createProcedureRateLimit(['checkout.bookingLookup'], {
        windowMs: 60_000,
        max,
        skipSuccessfulRequests: true,
      }),
    );
    app.all('/trpc/*splat', (_req, res) => res.status(status).json({ ok: true }));
    return app;
  }

  it('counts a 207 against the limit', async () => {
    const app = appAnswering(207, 2);
    await post(app, '/trpc/checkout.bookingLookup').expect(207);
    await post(app, '/trpc/checkout.bookingLookup').expect(207);
    await post(app, '/trpc/checkout.bookingLookup').expect(429);
  });

  it('still gives the hit back for a plain 200, however many times', async () => {
    const app = appAnswering(200, 2);
    for (let i = 0; i < 10; i += 1) {
      await post(app, '/trpc/checkout.bookingLookup').expect(200);
    }
  });

  /**
   * Second reader on the F1 fix, and the one property none of us could
   * settle by reading the library: **the give-back has to scale with the
   * counting.** Counting one attempt per matched call means a SUCCESSFUL
   * batch of N takes N hits on the way in, so it must return N on `finish`,
   * not one. If it returned one, an all-successful batch of three would net
   * +2 permanently and a guest batching their own real lookups would
   * accumulate hits until §7's lookup locked them out for fifteen minutes —
   * an availability bug, invisible from the symptom, erring toward refusing
   * a guest their own booking.
   *
   * **The budget has to be at least the batch size** or the limiter trips
   * mid-batch and the test measures nothing: three calls against a budget
   * of two is a 429 on the third increment, before any `finish` fires. So
   * `limit` is 3 here, and the discriminating move is a SECOND identical
   * batch rather than a single call — after one batch of three, a per-call
   * give-back leaves the counter at 0 (second batch: 1,2,3, passes) while a
   * once-per-request give-back leaves it at 2 (second batch: 3,4 — refused
   * on its second increment). A single follow-up call cannot tell those
   * apart: 2 + 1 = 3 is still inside a budget of 3.
   */
  it('gives back every hit an all-successful BATCH took, not just one', async () => {
    const app = appAnswering(200, 3);
    const batch = '/trpc/checkout.bookingLookup,checkout.bookingLookup,checkout.bookingLookup';

    // A leak of (N - 1) per request would refuse the second batch outright.
    for (let i = 0; i < 5; i += 1) {
      await post(app, `${batch}?batch=1`).expect(200);
    }
    // And the budget is genuinely intact afterwards, not merely un-tripped.
    await post(app, '/trpc/checkout.bookingLookup').expect(200);
  });
});

/**
 * Round 1 review (Critical, C1): the prior version of this predicate
 * normalized the path with a rule tRPC itself doesn't use, which left
 * both mutations effectively unlimited. tRPC actually derives the
 * procedure name by (1) taking only the segment after the LAST `/`
 * (`adapters/express.mjs`: `req.path.slice(req.path.lastIndexOf('/') + 1)`)
 * and then (2) percent-decoding it (`resolveResponse-*.mjs`:
 * `decodeURIComponent(opts.path)`) — confirmed by reading those two files
 * directly, not inferred. `createProcedureRateLimit` now mirrors that
 * derivation exactly instead of inventing a second normalization.
 *
 * None of these need a database — every request here 400s on Zod
 * validation (or is limited outright) before the resolver ever calls
 * `getDb()` — so, per I2, this is a plain `describe`, not `describeWithDb`.
 * A DB-less CI run or a fresh clone without MySQL must still exercise
 * this: that's exactly the environment where a silently-skipped suite
 * would let the production fail-open back in unnoticed.
 */
describe('rate limiting through the real app mount — bypass shapes from round 1 review', () => {
  async function statusesFor(path: string, count: number): Promise<number[]> {
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < count; i += 1) {
      // Deliberately invalid/empty bodies — the limiter runs before (and
      // regardless of) tRPC's own input validation.
      const res = await post(app, path).send({});
      statuses.push(res.status);
    }
    return statuses;
  }

  it('limits a plain, unbatched call: /trpc/inquiries.create', async () => {
    const statuses = await statusesFor('/trpc/inquiries.create', 6);
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it('limits a call with extra path segments before the procedure name: /trpc/x/inquiries.create', async () => {
    // tRPC's Express adapter takes only the segment after the LAST slash,
    // so this resolves to the same procedure as /trpc/inquiries.create.
    // The old predicate's naive `/trpc/` strip missed this entirely.
    const statuses = await statusesFor('/trpc/x/inquiries.create', 6);
    expect(statuses[5]).toBe(429);
  });

  it('limits a percent-encoded dot: /trpc/inquiries%2Ecreate', async () => {
    // decodeURIComponent('inquiries%2Ecreate') === 'inquiries.create'.
    const statuses = await statusesFor('/trpc/inquiries%2Ecreate', 6);
    expect(statuses[5]).toBe(429);
  });

  it('limits a percent-encoded leading character: /trpc/%69nquiries.create', async () => {
    // decodeURIComponent('%69nquiries.create') === 'inquiries.create'.
    const statuses = await statusesFor('/trpc/%69nquiries.create', 6);
    expect(statuses[5]).toBe(429);
  });

  it('still limits the real batched shape: /trpc/tours.list,inquiries.create?batch=1', async () => {
    const app = createApp();
    await post(app, '/trpc/tours.list,inquiries.create?batch=1').send({});
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await post(app, '/trpc/tours.list,inquiries.create?batch=1').send({});
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describeWithDb('rate limiting through the real app mount — unlisted procedures', () => {
  it('leaves tours.list untouched after more requests than the limit', async () => {
    const app = createApp();
    for (let i = 0; i < 8; i += 1) {
      await request(app).get('/trpc/tours.list?input=%7B%7D').expect(200);
    }
  });
});
