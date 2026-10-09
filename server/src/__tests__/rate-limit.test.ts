import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createProcedureRateLimit } from '../middleware/rate-limit';
import { describeWithDb } from './helpers/db';

function appWith(max: number) {
  const app = express();
  app.use(createProcedureRateLimit(['inquiries.create'], { windowMs: 60_000, max }));
  app.all('/trpc/*splat', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('procedure-scoped rate limiting', () => {
  it('limits the named procedure', async () => {
    const app = appWith(2);
    await request(app).post('/trpc/inquiries.create').expect(200);
    await request(app).post('/trpc/inquiries.create').expect(200);
    await request(app).post('/trpc/inquiries.create').expect(429);
  });

  it('leaves unlisted procedures alone', async () => {
    const app = appWith(1);
    await request(app).post('/trpc/tours.list').expect(200);
    await request(app).post('/trpc/tours.list').expect(200);
    await request(app).post('/trpc/tours.list').expect(200);
  });

  it('still limits a batched call that includes the named procedure', async () => {
    const app = appWith(1);
    // `?batch=1` because that's the real shape httpBatchLink sends — tRPC
    // only treats the path as comma-joined procedure names when the batch
    // flag is present (round 1 review, cheap fix #1).
    await request(app).post('/trpc/tours.list,inquiries.create?batch=1').expect(200);
    await request(app).post('/trpc/tours.list,inquiries.create?batch=1').expect(429);
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
      const res = await request(app).post(path).send({});
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
    await request(app).post('/trpc/tours.list,inquiries.create?batch=1').send({});
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app).post('/trpc/tours.list,inquiries.create?batch=1').send({});
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
