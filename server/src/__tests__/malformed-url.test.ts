/**
 * Task 4.3b — `/trpc/%zz` and friends must answer 400 and say nothing about
 * the server.
 *
 * Both app shapes are exercised on purpose, because before the guard the
 * three consumers of the request path failed three different ways and a test
 * against only one of them would have missed the others:
 *
 *  - `createApp()` — the API-only shape the dev server runs. `/trpc/%zz` was
 *    a **500** with a tRPC `stack` containing absolute filesystem paths;
 *    `/tours/%zz` was a bare **404**.
 *  - `createApp(origin, dist, 'production')` — the deployed shape, where the
 *    Express router and `express.static` sit under the catch-all. Those paths
 *    already answered 400, but with finalhandler's development error page,
 *    which renders `URIError: Failed to decode param '%zz'` plus the stack.
 *    So for that app it is the BODY assertions, not the status, that catch a
 *    regression.
 *
 * None of the malformed cases need MySQL — the guard answers above the robots
 * header's settings read and above the SEO resolver — which is also the
 * "response must not vary based on whether MySQL is up" requirement, hence a
 * plain `describe` rather than `describeWithDb`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { isMalformedPath } from '../middleware/malformed-url';

const SHELL = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<title>TravelSugbo</title>
<meta name="description" content="shell description" />
</head><body><div id="root"></div></body></html>`;

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-malformed-dist-'));
  writeFileSync(join(dir, 'index.html'), SHELL, 'utf8');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.css'), '.a{color:#334155}', 'utf8');
  return dir;
}

/**
 * Every way the pre-guard behaviour leaked internals, in one assertion. The
 * body is first checked to BE the guard's answer, so these cannot pass
 * vacuously against an empty body (a 404 shell, for instance, matches none of
 * these patterns either — it would sail through the negatives alone).
 */
function expectCleanBadRequest(res: { status: number; text: string; type: string }): void {
  expect(res.status).toBe(400);
  expect(res.type).toBe('application/json');
  expect(JSON.parse(res.text)).toEqual({ error: 'Bad Request' });

  // A stack frame, in either the JSON-escaped or the HTML-escaped form
  // finalhandler uses.
  expect(res.text).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  expect(res.text).not.toMatch(/\bat decodeURIComponent\b/);
  expect(res.text).not.toContain('stack');
  // The error's own name and message, which named the bad input back at the
  // caller and told them which internal decode threw.
  expect(res.text).not.toContain('URIError');
  expect(res.text).not.toContain('malformed');
  expect(res.text).not.toContain('Failed to decode param');
  // Filesystem and dependency detail.
  expect(res.text).not.toContain('node_modules');
  expect(res.text).not.toContain('server/src');
  expect(res.text).not.toContain('server\\src');
  expect(res.text).not.toMatch(/[A-Za-z]:[\\/]/); // a Windows absolute path
  expect(res.text).not.toContain('@trpc');
}

const MALFORMED_PATHS = ['/trpc/%zz', '/%zz', '/tours/%zz', '/privacy%', '/assets/%zz'];

// ---------------------------------------------------------------------------
// The predicate on its own
// ---------------------------------------------------------------------------

describe('isMalformedPath', () => {
  it.each(MALFORMED_PATHS)('rejects %s', (path) => {
    expect(isMalformedPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/tours',
    '/tours/oslob-whale-shark-tumalog-falls',
    '/tours/%20x', // a valid escape for a space
    '/tours/caf%C3%A9', // a valid escape for a non-ASCII character
    '/trpc/inquiries%2Ecreate', // the shape rate-limit.ts mirrors
    '/trpc/tours.list,inquiries.create',
    '/assets/app%2Ecss',
  ])('accepts %s', (path) => {
    expect(isMalformedPath(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The API-only app (what the dev server runs)
// ---------------------------------------------------------------------------

describe('malformed request paths through createApp (API-only)', () => {
  const app = createApp();

  it('answers GET /trpc/%zz with a clean 400, not the 500 with a tRPC stack trace', async () => {
    expectCleanBadRequest(await request(app).get('/trpc/%zz'));
  });

  it('answers POST /trpc/%zz the same way', async () => {
    expectCleanBadRequest(await request(app).post('/trpc/%zz').send({}));
  });

  it.each(MALFORMED_PATHS)('answers GET %s with a clean 400', async (path) => {
    expectCleanBadRequest(await request(app).get(path));
  });

  it('does not reject a VALID percent-escape: /trpc/%68ealth still resolves', async () => {
    // decodeURIComponent('%68ealth') === 'health'. If the guard were a
    // blanket ban on `%`, this would be a 400 instead of a live procedure.
    const res = await request(app).get('/trpc/%68ealth');

    expect(res.status).toBe(200);
    expect(res.body.result.data).toMatchObject({ ok: true, service: 'rg-travel-tours' });
  });

  it('leaves a malformed escape in the QUERY string alone — it throws nothing', async () => {
    // qs's decoder is tolerant, so `?input=%zz` has always answered 200.
    // Widening the guard to req.url would turn working requests into 400s.
    for (const path of ['/trpc/health?input=%zz', '/trpc/health?batch=1&input=%zz']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('URIError');
    }
  });

  it('leaves the ordinary routes untouched', async () => {
    expect((await request(app).get('/api/health')).body).toMatchObject({ ok: true });
    expect((await request(app).get('/trpc/health')).status).toBe(200);
    expect((await request(app).get('/robots.txt')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The deployed app shape — static assets and the SPA catch-all
// ---------------------------------------------------------------------------

describe('malformed request paths through createApp (with the built client)', () => {
  const app = createApp('http://localhost:5180', makeDist(), 'production');

  it.each(MALFORMED_PATHS)(
    'answers GET %s with a clean 400, not finalhandler’s stack-trace page',
    async (path) => {
      expectCleanBadRequest(await request(app).get(path));
    },
  );

  it('does not reject a valid escape: /assets/app%2Ecss is still served as CSS', async () => {
    const res = await request(app).get('/assets/app%2Ecss');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.text).toContain('#334155');
  });

  it('does not 400 a valid escape the SPA shell has to answer: /tours/%20x', async () => {
    const res = await request(app).get('/tours/%20x');

    // 404 with MySQL up (the resolver says "no such slug"), 200 if the
    // resolver fails soft — either way it is the HTML shell, never a 400.
    expect(res.status).not.toBe(400);
    expect(res.text).toContain('<div id="root">');
  });
});
