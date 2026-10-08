import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

describe('server health', () => {
  const app = createApp();

  it('answers GET /api/health', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: 'rg-travel-tours',
      timezone: 'Asia/Manila',
    });
  });

  it('answers the tRPC health query', async () => {
    const res = await request(app).get('/trpc/health');

    expect(res.status).toBe(200);
    expect(res.body.result.data).toMatchObject({ ok: true, service: 'rg-travel-tours' });
  });
});
