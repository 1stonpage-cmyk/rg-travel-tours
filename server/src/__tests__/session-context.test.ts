/**
 * Week 4 plan, Task 1 — the wiring, as opposed to the session service.
 *
 * `sessions.test.ts` proves mint/resolve/revoke. This file proves the two
 * things between that service and a request, neither of which it covers:
 * the **cookie's flags**, and the **context factory** that turns a cookie
 * into `ctx.session`.
 *
 * The flags are tested because they ARE the control. `httpOnly` missing
 * would hand every XSS payload a live session and absolutely nothing else
 * would fail — not a type, not a lint rule, not another test. That is the
 * definition of a thing worth pinning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { getPool } from '../db/client';
import { createContext } from '../context';
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from '../middleware/session-cookie';
import { createSession } from '../services/sessions';
import { describeWithDb } from './helpers/db';

const NOW = new Date('2026-10-13T04:00:00Z');
const SUBJECT_ID = 930_001;

interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** Captures what a resolver hands `res.cookie`, without an HTTP round trip. */
function fakeResponse() {
  const set: CapturedCookie[] = [];
  const cleared: CapturedCookie[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, value: '', options });
    },
  } as unknown as Response;
  return { res, set, cleared };
}

const fakeRequest = (cookies?: Record<string, string>) => ({ cookies }) as unknown as Request;

describe('the session cookie', () => {
  it('is httpOnly and sameSite=lax — the XSS and CSRF halves', () => {
    const { res, set } = fakeResponse();
    setSessionCookie(res, 'a-token', new Date('2026-10-14T04:00:00Z'));

    expect(set).toHaveLength(1);
    expect(set[0]!.name).toBe(SESSION_COOKIE);
    expect(set[0]!.value).toBe('a-token');
    expect(
      set[0]!.options.httpOnly,
      'httpOnly missing: an XSS payload could read the session',
    ).toBe(true);
    expect(
      set[0]!.options.sameSite,
      'sameSite missing: a cross-site POST would carry the session',
    ).toBe('lax');
    expect(set[0]!.options.path).toBe('/');
  });

  /**
   * `expires` must match the row's own `expires_at`, so the browser stops
   * sending a token the server has already begun refusing. A cookie that
   * outlives its row is not a security hole — it is a guest who looks
   * logged in and gets refused on every click.
   */
  it('expires with the row, not on its own schedule', () => {
    const { res, set } = fakeResponse();
    const expiresAt = new Date('2026-10-14T04:00:00Z');
    setSessionCookie(res, 'a-token', expiresAt);
    expect(set[0]!.options.expires).toEqual(expiresAt);
  });

  /**
   * `secure` is off outside production ON PURPOSE: the dev server is plain
   * HTTP on 5180, and a secure cookie is never sent over HTTP — the portal
   * would appear to log in and be immediately logged out. The test states
   * the environment-dependence so nobody "hardens" it and breaks dev.
   */
  it('is not secure in development, which is why dev login works at all', () => {
    const { res, set } = fakeResponse();
    setSessionCookie(res, 'a-token', NOW);
    expect(set[0]!.options.secure).toBe(false);
  });

  it('clears with the same path it was set with', () => {
    const { res, cleared } = fakeResponse();
    clearSessionCookie(res);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.name).toBe(SESSION_COOKIE);
    expect(cleared[0]!.options.path).toBe('/');
  });
});

describeWithDb('createContext', () => {
  afterEach(async () => {
    await getPool().query('DELETE FROM sessions WHERE subject_id = ?', [SUBJECT_ID]);
  });

  it('resolves a live cookie to its session', async () => {
    const { token } = await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      req: fakeRequest({ [SESSION_COOKIE]: token }),
      res,
    } as never);
    expect(ctx.session).toEqual({ subjectType: 'customer', subjectId: SUBJECT_ID });
  });

  /** An anonymous request is the normal case on a public site, not an error. */
  it('gives a null session for no cookie at all, without throwing', async () => {
    const { res } = fakeResponse();
    const ctx = await createContext({ req: fakeRequest(), res } as never);
    expect(ctx.session).toBeNull();
  });

  /**
   * A live session must exist for this to prove anything — against an empty
   * table, even an implementation that ignored the token and returned the
   * first row it found would answer null. Same weakness, same fix, as the
   * unknown-token case in `sessions.test.ts`.
   */
  it('gives a null session for a cookie that resolves to nothing', async () => {
    await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      req: fakeRequest({ [SESSION_COOKIE]: 'not-a-real-token' }),
      res,
    } as never);
    expect(ctx.session, 'a bogus cookie resolved to a real session').toBeNull();
  });

  /**
   * The property the whole admin surface rests on: a portal session and a
   * staff session arrive in the SAME cookie, and only `subject_type` tells
   * them apart. `requireRole` admits `'user'` only — so this asserts the
   * context reports the type faithfully rather than flattening it, which is
   * what would let a guest's cookie reach an admin procedure.
   */
  it('reports the subject TYPE faithfully, so a customer cannot pass as staff', async () => {
    const { token } = await createSession('customer', SUBJECT_ID, new Date());
    const { res } = fakeResponse();
    const ctx = await createContext({
      req: fakeRequest({ [SESSION_COOKIE]: token }),
      res,
    } as never);
    expect(ctx.session?.subjectType).toBe('customer');
    expect(ctx.session?.subjectType).not.toBe('user');
  });
});
