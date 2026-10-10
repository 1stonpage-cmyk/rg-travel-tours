/**
 * The production wiring (task 5B): Express serves the built shell with meta
 * injected and the resolver's status code, without shadowing the API routes
 * mounted above it.
 *
 * A throwaway `dist` directory stands in for `client/dist` so this suite never
 * depends on a build having run.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../app';
import { describeWithDb } from './helpers/db';

const SHELL = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<title>TravelSugbo — Cebu Day Tours &amp; Packages</title>
<meta name="description" content="shell description" />
</head><body><div id="root"></div></body></html>`;

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-seo-dist-'));
  writeFileSync(join(dir, 'index.html'), SHELL, 'utf8');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.css'), '.a{color:#334155}', 'utf8');
  return dir;
}

describeWithDb('Express HTML serving', () => {
  const app = createApp('http://localhost:5180', makeDist());

  it('injects the resolved meta into the shell for the home page', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<link rel="canonical" href="http://localhost:5180/">');
    expect(res.text.match(/<title>/g)).toHaveLength(1);
    expect(res.text).not.toContain('shell description');
  });

  it('answers an unknown path with the 404 the resolver asked for', async () => {
    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex,nofollow"');
  });

  it('answers an unknown tour slug with 404, not 200', async () => {
    expect((await request(app).get('/tours/no-such-tour')).status).toBe(404);
  });

  it('does not shadow the API routes mounted above it', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true });

    const trpc = await request(app).get('/trpc/health');
    expect(trpc.status).toBe(200);
    expect(trpc.body.result.data).toMatchObject({ ok: true });
  });

  it('serves real static files as files, not as the HTML shell', async () => {
    const res = await request(app).get('/assets/app.css');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.text).toContain('#334155');
  });
});
