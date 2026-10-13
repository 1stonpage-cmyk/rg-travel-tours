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

type HttpResponse = { status: number; text: string; headers: Record<string, string> };

/**
 * Every way an error response can leak internals, in one assertion, at
 * whatever status the handler was supposed to answer with. The body is first
 * checked to BE the handler's fixed answer for that status, so none of the
 * negatives can pass vacuously against an empty body.
 */
function expectCleanError(res: HttpResponse, status: number, error: string): void {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(JSON.parse(res.text)).toEqual({ error });

  expect(res.text).not.toMatch(/<html|<pre>/i); // finalhandler's page
  expect(res.text).not.toMatch(/\bat \S+ \(/); // stack frames
  expect(res.text).not.toMatch(/node_modules|[A-Za-z]:\\|\/(usr|var|home)\//); // paths
  expect(res.text).not.toMatch(/\.[cm]?[jt]sx?:\d+:\d+/); // file:line:col
  expect(res.text).not.toMatch(/Error: /); // the raw message
  expect(res.text).not.toMatch(/SyntaxError|boom|hunter2/);
}

/** An unclassified error: the handler's 500, with nothing of the error in it. */
function expectCleanInternalError(res: HttpResponse): void {
  expectCleanError(res, 500, 'Internal Server Error');
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
      .set('Origin', BROWSER_ORIGIN)
      .send('{"password":"hunter2-not-a-real-secret",');

    expect(spy).toHaveBeenCalled();
    expect(loggedText(spy), 'the request body reached the server log').not.toMatch(/hunter2/);
  });
});

/**
 * Cleanup A2 — the status an error carries, when and only when it is a 4xx.
 *
 * Mounted through a real app rather than called directly, because the point
 * is what a caller receives: a status line AND a body, with the body still
 * fixed per status and still nothing from the error.
 */
describe('errorHandler: a 4xx on the error is honoured, anything else is not', () => {
  /** Throws `err` from a route, with `errorHandler` mounted last. */
  function appThrowing(err: unknown) {
    const app = express();
    app.get('/__throw', () => {
      throw err;
    });
    app.use(errorHandler);
    return request(app).get('/__throw');
  }

  /** An `http-errors`-shaped error: both spellings, as body-parser sets them. */
  function withStatus(status: unknown, statusCode: unknown = status) {
    return Object.assign(new Error('boom: C:\\dev\\rg-travel-tours in the message'), {
      status,
      statusCode,
    });
  }

  it('answers a 400 error with 400 Bad Request', async () => {
    spyOnConsoleError();

    expectCleanError(await appThrowing(withStatus(400)), 400, 'Bad Request');
  });

  it('honours other 4xx statuses with their own fixed phrase', async () => {
    spyOnConsoleError();

    expectCleanError(await appThrowing(withStatus(413)), 413, 'Payload Too Large');
    expectCleanError(await appThrowing(withStatus(415)), 415, 'Unsupported Media Type');
    expectCleanError(await appThrowing(withStatus(404)), 404, 'Not Found');
  });

  it('reads statusCode when status is absent', async () => {
    spyOnConsoleError();

    expectCleanError(await appThrowing(withStatus(undefined, 400)), 400, 'Bad Request');
  });

  it('gives an unassigned 4xx a generic phrase, never the number as text', async () => {
    spyOnConsoleError();

    expectCleanError(await appThrowing(withStatus(499)), 499, 'Client Error');
  });

  /**
   * The fail-closed half: everything that is NOT a plain 4xx integer stays a
   * 500. An error that never set a status is one nobody classified, and
   * answering "your request was bad" when the database is down is worse than
   * saying nothing.
   */
  it('leaves a 5xx, a non-integer and a string status at 500', async () => {
    spyOnConsoleError();

    expectCleanInternalError(await appThrowing(withStatus(500)));
    expectCleanInternalError(await appThrowing(withStatus(503)));
    expectCleanInternalError(await appThrowing(withStatus(399)));
    expectCleanInternalError(await appThrowing(withStatus('400'))); // not a number
    expectCleanInternalError(await appThrowing(withStatus(400.5)));
    expectCleanInternalError(await appThrowing(withStatus(Number.NaN)));
    expectCleanInternalError(await appThrowing(new Error('no status at all')));
    expectCleanInternalError(await appThrowing('a thrown string'));
  });

  it('still logs a client error server-side, with its stack', async () => {
    const spy = spyOnConsoleError();
    await appThrowing(withStatus(400));

    expect(spy, 'a 400 that keeps happening must still be visible in the log').toHaveBeenCalled();
    const logged = loggedText(spy);
    expect(logged).toMatch(/GET \/__throw/);
    expect(logged).toMatch(/boom/);
    expect(logged).toMatch(/\bat \S+ \(/);
  });
});

describe('createApp(): the mount is really there', () => {
  /** A real unhandled throw in the real app: `express.json()` on a bad body. */
  const malformedJsonPost = () =>
    post(createApp(), '/trpc/health').set('Content-Type', 'application/json').send('{bad');

  /**
   * Cleanup A2: body-parser's `SyntaxError` carries `status: 400`, and that
   * is the caller's mistake. It was a 400 before Task 20's handler existed
   * (with a stack page attached, which is why the handler exists) and it is
   * a 400 again — now with the handler's fixed body and nothing else.
   */
  it('answers a malformed JSON body with a clean 400, not a 500 and not finalhandler HTML', async () => {
    spyOnConsoleError();
    const res = await malformedJsonPost();

    expectCleanError(res, 400, 'Bad Request');
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
    const unknown = await post(app, '/api/webhooks/stripe').send({});
    expect(unknown.status).toBe(404);

    const manual = await post(app, '/api/webhooks/manual').send({});
    expect(manual.status).toBe(404);

    const unsigned = await post(app, '/api/webhooks/paymongo').send({});
    expect(unsigned.status).toBe(400);

    const disabled = await post(app, '/api/webhooks/xendit').send({});
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
