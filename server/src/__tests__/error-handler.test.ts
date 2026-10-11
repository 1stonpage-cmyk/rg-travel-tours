/**
 * Plan Task 20 — an unhandled throw in plain Express must not answer with
 * finalhandler's HTML error page.
 *
 * Two shapes are exercised deliberately:
 *
 *  - **The real app** (`createApp()`), through a genuine unhandled-throw
 *    path it has today: `express.json()` throws a `SyntaxError` on a
 *    malformed body, and before this task that reached finalhandler and
 *    rendered `<pre>SyntaxError: ...<br> at parse
 *    (C:\dev\rg-travel-tours\node_modules\...\json.js:91:21)` to an
 *    anonymous caller. These are the assertions that go red if the mount in
 *    `app.ts` is removed, which is the point of testing the real app rather
 *    than a stand-in.
 *  - **A minimal app** mirroring `app.ts`'s mount order (routes, then
 *    `errorHandler` last), for the two cases the real app has no route for:
 *    a bare `throw`, and a throw AFTER the response has been flushed.
 *
 * None of it needs MySQL — every path answers above the robots header's
 * settings read — except the `/robots.txt` non-shadowing check, which is
 * why that one sits in its own `describeWithDb`.
 */
import { inspect } from 'node:util';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { errorHandler } from '../middleware/error-handler';
import { describeWithDb } from './helpers/db';

/** Mirrors app.ts: routes first, the error handler last. */
function appWithThrowingRoutes() {
  const app = express();

  app.get('/__throw', () => {
    throw new Error('boom: a stack with C:\\dev\\rg-travel-tours in it');
  });

  // Flushes a 200 and only then throws, which is the case `res.headersSent`
  // exists for: writing a second status here throws inside the handler.
  app.get('/__throw-after-send', (_req, res) => {
    res.status(200).json({ ok: true });
    throw new Error('boom after send');
  });

  app.use(errorHandler); // LAST, exactly as in app.ts
  return app;
}

/**
 * Every way an error response can leak internals, in one assertion. The body
 * is first checked to BE the handler's fixed answer, so none of the
 * negatives can pass vacuously against an empty body.
 */
function expectCleanInternalError(res: {
  status: number;
  text: string;
  headers: Record<string, string>;
}): void {
  expect(res.status).toBe(500);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(JSON.parse(res.text)).toEqual({ error: 'Internal Server Error' });

  expect(res.text).not.toMatch(/<html|<pre>/i); // finalhandler's page
  expect(res.text).not.toMatch(/\bat \S+ \(/); // stack frames
  expect(res.text).not.toMatch(/node_modules|[A-Za-z]:\\|\/(usr|var|home)\//); // paths
  expect(res.text).not.toMatch(/\.[cm]?[jt]sx?:\d+:\d+/); // file:line:col
  expect(res.text).not.toMatch(/Error: /); // the raw message
  expect(res.text).not.toMatch(/SyntaxError|boom/);
}

/** Silences the handler's own log line, and hands back the spy to assert on. */
function spyOnConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/**
 * Everything the spied `console.error` would actually have PRINTED.
 *
 * `inspect`, not `calls.map(join)`, and the difference is the whole point of
 * the leak test below: `console.error` runs `util.inspect` on its arguments,
 * which prints an Error's extra own properties — body-parser's `err.body`,
 * the raw request body — while `String(err)` shows only `name: message` and
 * hides it. Measured: with the error object logged, `join` finds no password
 * and `inspect` finds it. Asserting on the joined form would have made the
 * leak test pass over a live leak.
 */
function loggedText(spy: { mock: { calls: unknown[][] } }): string {
  return inspect(spy.mock.calls, { depth: 6 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler, mounted last', () => {
  it('turns an unhandled throw into a clean 500 with no stack and no paths', async () => {
    spyOnConsoleError();
    const res = await request(appWithThrowingRoutes()).get('/__throw');

    expectCleanInternalError(res);
  });

  it('logs the real error server-side, with the stack intact', async () => {
    const spy = spyOnConsoleError();
    await request(appWithThrowingRoutes()).get('/__throw');

    expect(spy, 'the error was swallowed entirely — nothing to debug from').toHaveBeenCalled();
    const logged = loggedText(spy);
    expect(logged).toMatch(/GET \/__throw/);
    expect(logged).toMatch(/boom/); // the message the client never sees
    expect(logged).toMatch(/\bat \S+ \(/); // and the frames with it
  });

  /**
   * A throw AFTER headers are flushed must DELEGATE — writing a second
   * status would throw `ERR_HTTP_HEADERS_SENT` inside the handler itself.
   *
   * The `res.headersSent` guard is asserted by calling the middleware
   * directly, because end-to-end it cannot be: the 200 has already left for
   * the client, so supertest reads 200 whether the guard is there or not.
   * Deleting the guard leaves the request-level assertion below perfectly
   * green — which makes it, on its own, a test that cannot fail. The direct
   * call is what actually pins the contract; the request-level assertion
   * stays because it is what a caller experiences.
   */
  it('delegates an already-sent response instead of writing a second status', async () => {
    const err = new Error('boom after send');
    const next = vi.fn();
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res as never); // chainable, so a regression
    const spy = spyOnConsoleError(); // fails on the assertion, not a TypeError

    errorHandler(err, { method: 'GET', path: '/__throw-after-send' } as never, res as never, next);

    expect(next, 'the error was not handed on to Express').toHaveBeenCalledWith(err);
    expect(
      res.status,
      'a second status was written onto a flushed response',
    ).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(spy, 'the guard must return before the log line, not after').not.toHaveBeenCalled();

    // And the caller still receives the response that was already on its way.
    spyOnConsoleError();
    const live = await request(appWithThrowingRoutes()).get('/__throw-after-send');
    expect(live.status).toBe(200);
    expect(JSON.parse(live.text)).toEqual({ ok: true });
  });

  it('does not log a request body, which may hold a password', async () => {
    const spy = spyOnConsoleError();
    // body-parser attaches the raw body to its SyntaxError as `err.body`,
    // so logging the error OBJECT would print this straight into the log.
    await request(createApp())
      .post('/trpc/auth.login')
      .set('Content-Type', 'application/json')
      .send('{"password":"hunter2-not-a-real-secret",');

    expect(spy).toHaveBeenCalled();
    expect(loggedText(spy), 'the request body reached the server log').not.toMatch(/hunter2/);
  });
});

describe('createApp(): the mount is really there', () => {
  /** A real unhandled throw in the real app: `express.json()` on a bad body. */
  const malformedJsonPost = () =>
    request(createApp()).post('/trpc/health').set('Content-Type', 'application/json').send('{bad');

  it('answers a malformed JSON body with the clean 500, not finalhandler HTML', async () => {
    spyOnConsoleError();
    const res = await malformedJsonPost();

    expectCleanInternalError(res);
  });

  it('still logs that error server-side', async () => {
    const spy = spyOnConsoleError();
    await malformedJsonPost();

    expect(spy).toHaveBeenCalled();
    expect(loggedText(spy)).toMatch(/SyntaxError/);
  });
});

describe('createApp(): routes that handle their own errors are not shadowed', () => {
  const app = createApp();

  it('leaves the malformed-URL guard at 400 (task 4.3b)', async () => {
    const res = await request(app).get('/trpc/%zz');

    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual({ error: 'Bad Request' });
  });

  it('leaves /api/health at 200', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  /**
   * The webhook route's own fail-closed answers (Task 15). Full coverage is
   * in webhooks.test.ts, which asserts nothing was written either; these
   * three are here because a catch-all error handler is exactly the kind of
   * change that could turn one of them into a 500.
   */
  it('leaves the webhook route 404/400/503 answers alone', async () => {
    const unknown = await request(app).post('/api/webhooks/stripe').send({});
    expect(unknown.status).toBe(404);

    const manual = await request(app).post('/api/webhooks/manual').send({});
    expect(manual.status).toBe(404);

    const unsigned = await request(app).post('/api/webhooks/paymongo').send({});
    expect(unsigned.status).toBe(400);

    const disabled = await request(app).post('/api/webhooks/xendit').send({});
    expect(disabled.status).toBe(503);
  });
});

describeWithDb('createApp(): /robots.txt is not shadowed', () => {
  it('leaves /robots.txt at 200', async () => {
    const res = await request(createApp()).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/User-agent/i);
  });
});
