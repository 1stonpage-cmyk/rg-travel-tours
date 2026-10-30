/**
 * BUG-102 — a tRPC error must never carry a stack trace or a filesystem path
 * to a client, in ANY environment.
 *
 * Before the `errorFormatter` in src/trpc.ts, bare `initTRPC.create()` meant
 * tRPC's default error shape attached `data.stack` to every error from every
 * procedure whenever `NODE_ENV !== 'production'` — which is what `pnpm test`
 * and `pnpm dev` both are. A live probe against the dev server returned
 * absolute `C:\dev\rg-travel-tours\node_modules\...\resolveResponse.ts:241:17`
 * frames to an anonymous caller.
 *
 * Two shapes are exercised, because the leak has two different sources:
 *
 *  1. An UNEXPECTED internal error (code INTERNAL_SERVER_ERROR), where tRPC
 *     reports the underlying error's own message — and that message may
 *     itself contain a path, independently of `data.stack`. This needs a
 *     procedure that genuinely throws, so it is mounted on a test-local
 *     router built from the REAL `router`/`publicProcedure` exported by
 *     src/trpc.ts: the same `initTRPC` instance, the same formatter, a real
 *     `createExpressMiddleware`, and a real Node error carrying a real stack.
 *     (The public router has no procedure that can be made to throw a 500
 *     without a database outage, and mocking the failure would test the mock.)
 *
 *  2. A Zod input-validation failure through the REAL app (`createApp()`),
 *     which is the only error shape the public site's forms actually see.
 *     The formatter must keep this one usable: `code`, `message` and
 *     per-field errors all still arrive.
 *
 * The "no stack" assertions are deliberately paired with POSITIVE assertions
 * about the same response (its status, its `data.code`, a substring of its
 * message). A `not.toContain` suite on its own passes just as happily against
 * an empty body or a 404 — which is exactly how a vacuous security test gets
 * written.
 */
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { REDACTED_PATH, publicProcedure, router, scrubPaths } from '../trpc';

/**
 * A path that does not exist, shaped exactly like the real leak: a Windows
 * absolute path, through `node_modules`, ending in a `.ts` file. Node's ENOENT
 * message echoes the requested path verbatim on every platform, so this is
 * deterministic on Windows and Linux alike — unlike `tmpdir()`, which would
 * produce a different shape per OS and so test a different regex per OS.
 */
const LEAK_PATH = 'C:\\dev\\rg-travel-tours\\node_modules\\@trpc\\server\\resolveResponse.ts';

const throwingRouter = router({
  boom: publicProcedure.query(() => {
    // A real filesystem error, not `new Error('...')`: it arrives with a real
    // multi-frame stack AND a message that embeds a path, which is the pair
    // of leaks this guard has to close.
    return readFileSync(LEAK_PATH, 'utf8');
  }),
});

function throwingApp() {
  const app = express();
  app.use(express.json());
  /*
   * `createContext` is required now that the router carries a context type
   * (Week 4, Task 1). This harness is about the ERROR SHAPE, so the real
   * factory would be noise — and it would open a database connection to
   * resolve a session that no throwing procedure reads. A fixed anonymous
   * context is the honest stand-in.
   */
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: throwingRouter,
      // BUG-119: the real `Context` carries three per-surface fields now,
      // not one `session`. Every throwing procedure here is public and
      // reads none of them; all three are `null` for the same reason the
      // comment above explains — a fixed anonymous context is the honest
      // stand-in.
      createContext: ({ req, res }) => ({
        req,
        res,
        adminSession: null,
        driverSession: null,
        customerSession: null,
      }),
    }),
  );
  return app;
}

/** Every way a stack or a path showed up in the pre-fix body. */
function expectNoInternals(text: string): void {
  expect(text).not.toMatch(/"stack"/);
  expect(text).not.toMatch(/C:\\\\|C:\\/);
  expect(text).not.toMatch(/node_modules/);
  expect(text).not.toMatch(/\.[cm]?[jt]sx?:\d+:\d+/);
  expect(text).not.toMatch(/\bat [\w.<>]+ \(/);
  expect(text).not.toMatch(/\bat processTicksAndRejections\b/);
  expect(text).not.toMatch(/file:\/\//);
}

describe('tRPC error shape — an internal error', () => {
  /**
   * Proof that the error under test really does carry the internals this
   * suite claims to be suppressing. Without this, "the response has no stack"
   * could be true because there was never a stack to leak.
   */
  it('the underlying error really does carry a stack and a path', () => {
    let raw: Error | undefined;
    try {
      readFileSync(LEAK_PATH, 'utf8');
    } catch (error) {
      raw = error as Error;
    }
    expect(raw).toBeDefined();
    expect(raw?.message).toContain('ENOENT');
    expect(raw?.message).toContain(LEAK_PATH);
    expect(raw?.stack).toMatch(/\bat /);
    expect(raw?.stack).toContain('trpc-error-shape.test.ts');
  });

  it('answers 500 with the code and a message, and no stack or path anywhere', async () => {
    const res = await request(throwingApp()).get('/trpc/boom');

    // Positive first: this IS a real, fully formed internal-error response.
    expect(res.status).toBe(500);
    expect(res.body.error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.data.httpStatus).toBe(500);
    expect(res.body.error.data.path).toBe('boom');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message).toContain('ENOENT');

    // The message kept its meaning and lost its path.
    expect(res.body.error.message).toContain(REDACTED_PATH);
    expect(res.body.error.message).not.toContain(LEAK_PATH);

    // No `stack` key at all — not an empty one, not a short one.
    expect(res.body.error.data).not.toHaveProperty('stack');
    expect(Object.keys(res.body.error.data).sort()).toEqual(['code', 'httpStatus', 'path']);
    expectNoInternals(res.text);
  });

  it('suppresses it in development too — NODE_ENV is not production here', async () => {
    // The pre-fix default shape attached `stack` only when NODE_ENV was not
    // 'production', so a guard that only held in production would have left
    // `pnpm dev` (and `pnpm dev:lan`, reachable on the LAN) leaking.
    expect(process.env.NODE_ENV).not.toBe('production');

    const res = await request(throwingApp()).get('/trpc/boom');
    expect(res.status).toBe(500);
    expectNoInternals(res.text);
  });
});

/*
 * `.set('Origin', ...)` on every POST below (Week 4, Task 5): the origin
 * check refuses a state-changing request with no `Origin`, which is the
 * CSRF defence working — a browser always sends one, so a request without
 * it is not a browser. These tests are about the ERROR SHAPE, so they send
 * the header and get past the gate to the thing they are actually testing.
 */
const ORIGIN = 'http://localhost:5180';

describe('tRPC error shape — a Zod validation failure through the real app', () => {
  it('still returns the code, the message and per-field errors', async () => {
    const res = await request(createApp())
      .post('/trpc/newsletter.subscribe')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error.data.code).toBe('BAD_REQUEST');
    expect(res.body.error.data.httpStatus).toBe(400);
    expect(res.body.error.message).toMatch(/email/i);

    // The point of the fix's allow-list: field errors survive, the stack does not.
    expect(res.body.error.data.zodError.fieldErrors.email).toEqual([
      expect.stringMatching(/email/i),
    ]);
    expect(res.body.error.data).not.toHaveProperty('stack');
    expectNoInternals(res.text);
  });

  it('names every failing field of an inquiry, not just the first', async () => {
    const res = await request(createApp())
      .post('/trpc/inquiries.create')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ type: 'contact', name: '', email: 'nope', message: '', consent: false });

    expect(res.status).toBe(400);
    const fieldErrors = res.body.error.data.zodError.fieldErrors as Record<string, string[]>;
    expect(Object.keys(fieldErrors).sort()).toEqual(['consent', 'email', 'message', 'name']);
    for (const messages of Object.values(fieldErrors)) {
      expect(messages.length).toBeGreaterThan(0);
    }
    expectNoInternals(res.text);
  });

  /**
   * BUG-120: `createHoldInput.lead` is a nested object, and the existing
   * `fieldErrors` map (asserted below, unchanged) groups by `issue.path[0]`
   * — so a bad phone number alone arrives as one `fieldErrors.lead` entry
   * with no sub-key, and `GuestDetails.tsx` used to mark all three of
   * name/email/phone invalid for it. The fix adds `nestedFieldErrors`
   * alongside that map, dot-path keyed from the ZodError's own `issues`, so
   * a form can resolve the message to the one leaf that actually failed.
   *
   * This goes through the REAL app and the REAL `createHoldInput` schema —
   * no hand-built ZodError — so the only way this is false is if the wire
   * shape actually changed. `tourSlug`/`date`/`pax`/`quoteId` are all
   * well-formed (so nothing else fails validation); `createHold`'s resolver
   * never runs, because tRPC parses the input and rejects before any
   * handler executes, so no database row for any of them needs to exist.
   */
  it('BUG-120: a bad lead.phone alone publishes a lead.phone-keyed nested error, and only that leaf', async () => {
    const res = await request(createApp())
      .post('/trpc/checkout.createHold')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({
        tourSlug: 'fixture-tour',
        date: '2030-01-01',
        pax: 2,
        quoteId: '0'.repeat(32),
        payMode: 'deposit',
        lead: { name: 'Juan Dela Cruz', email: 'juan@example.com', phone: 'not-a-phone' },
        consent: true,
      });

    expect(res.status).toBe(400);
    const zodError = res.body.error.data.zodError;

    // The old top-level grouping is still there, byte-for-byte as before —
    // this is additive, not a replacement.
    expect(zodError.fieldErrors.lead).toEqual([expect.stringMatching(/mobile number/i)]);

    // The new leaf-keyed entry exists for the one sub-field that is
    // actually wrong...
    expect(zodError.nestedFieldErrors['lead.phone']).toEqual([
      expect.stringMatching(/mobile number/i),
    ]);
    // ...and ONLY for that one: name and email were valid, so neither gets
    // an entry — which is the whole bug, proven absent.
    expect(zodError.nestedFieldErrors).not.toHaveProperty('lead.name');
    expect(zodError.nestedFieldErrors).not.toHaveProperty('lead.email');
    expectNoInternals(res.text);
  });
});

describe('scrubPaths', () => {
  it.each([
    ['C:\\dev\\rg-travel-tours\\server\\src\\trpc.ts', 'a Windows absolute path'],
    ['C:/dev/rg-travel-tours/server/src/trpc.ts', 'a Windows path with forward slashes'],
    ['file:///C:/dev/rg-travel-tours/server/src/app.ts:12:5', 'a file:// URL'],
    ['/app/node_modules/@trpc/server/dist/index.js', 'a node_modules path'],
    ['/srv/rg/server/src/routers/_app.ts:41:9', 'a POSIX source reference'],
    ['/var/www/rg/uploads/receipt.jpg', 'a POSIX deploy path'],
    ['/home/deploy/.env', 'a POSIX home path'],
  ])('redacts %s (%s)', (path) => {
    const scrubbed = scrubPaths(`ENOENT: no such file or directory, open ${path}`);
    expect(scrubbed).toContain(REDACTED_PATH);
    expect(scrubbed).not.toContain(path);
    // The surrounding sentence is kept — this is a scrub, not a wipe.
    expect(scrubbed).toContain('ENOENT: no such file or directory');
  });

  it('leaves a message with no path in it exactly as it was', () => {
    const message = 'Could not complete the request.';
    expect(scrubPaths(message)).toBe(message);
  });
});
