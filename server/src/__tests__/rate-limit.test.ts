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
    await request(app).post('/trpc/tours.list,inquiries.create').expect(200);
    await request(app).post('/trpc/tours.list,inquiries.create').expect(429);
  });
});

/**
 * The suite above mounts `createProcedureRateLimit` at the app root
 * (`app.use(middleware)`, no path), which is NOT how app.ts mounts it.
 * app.ts mounts it with `app.use('/trpc', middleware)`, and Express
 * strips the `/trpc` prefix from `req.path` for middleware mounted at a
 * path — confirmed with a throwaway probe against this exact mount shape
 * (see rate-limit.ts's doc comment and task-1.7-report.md). A predicate
 * that only knew how to strip `/trpc/` would pass every test above while
 * never firing in production for an unbatched call. This suite exercises
 * the real `createApp()` mount instead, to close that gap.
 */
describeWithDb('rate limiting through the real app mount', () => {
  it('limits repeated calls to inquiries.create', async () => {
    const app = createApp();
    const statuses: number[] = [];
    // Deliberately invalid bodies — the limiter runs before tRPC's own
    // input validation, so this never reaches the database either way.
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app).post('/trpc/inquiries.create').send({});
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it('leaves tours.list untouched after more requests than the limit', async () => {
    const app = createApp();
    for (let i = 0; i < 8; i += 1) {
      await request(app).get('/trpc/tours.list?input=%7B%7D').expect(200);
    }
  });
});
