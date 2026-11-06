/**
 * §12's third door: self-service staff password reset (owner decision
 * 2026-11-06, task 1C).
 *
 * This is a NEW AUTHENTICATION PATH, which makes it the highest-risk thing
 * in this codebase, and the tests are shaped around the five ways it could
 * be a vulnerability rather than around its happy path:
 *
 *  1. **It must not enumerate the staff list.** An unknown address and a
 *     real one are asserted byte-identical — the whole response object, not
 *     merely "neither threw".
 *  2. **An expired token must be refused**, driven by a controlled `now`
 *     written straight into `expires_at` rather than by faking global
 *     timers.
 *  3. **A spent token must be refused**, and two simultaneous redemptions
 *     of one link must produce exactly ONE password write.
 *  4. **An unknown token must be refused with the same sentence** as the
 *     other three, so the endpoint is not an oracle for which links are
 *     live.
 *  5. **A success must really work and must really revoke**: the new
 *     password signs in through the real procedure, and every session the
 *     user held is gone.
 *
 * Plus the three the brief names separately: a throttled request still
 * returns the generic response; the audit row carries no secret; and an
 * inactive account produces the generic response and NO token row.
 *
 * Nothing here prints a password, a token or a hash.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { STAFF_PASSWORD_RESET_MAX_PER_IP } from '../middleware/rate-limit';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  PASSWORD_RESET_REFUSED_MESSAGE,
  PASSWORD_RESET_REQUESTED_MESSAGE,
  STAFF_PASSWORD_MIN_LENGTH,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { auditLog, passwordResetTokens, sessions, users } from '../db/schema';
import { hashPassword } from '../services/password';
import {
  hashResetToken,
  maskEmail,
  passwordResetUrl,
  RESET_MAX_PER_EMAIL,
  RESET_TOKEN_TTL_MS,
  resetPasswordResetThrottleForTests,
} from '../services/password-reset';
import {
  renderStaffPasswordResetMail,
  resetTransportForTests,
  sendStaffPasswordResetEmail,
  setTransportForTests,
} from '../services/notify';
import { createSession, readSession } from '../services/sessions';
import { resetEmailThrottleForTests } from '../services/staff-auth';
import { appRouter } from '../routers/_app';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Long enough for `staffPasswordSchema`, and never printed anywhere. */
const OLD_PASSWORD = `old-fixture-secret-${'x'.repeat(STAFF_PASSWORD_MIN_LENGTH)}`;
const NEW_PASSWORD = `new-fixture-secret-${'y'.repeat(STAFF_PASSWORD_MIN_LENGTH)}`;

const suffix = `${Math.floor(Math.random() * 1e9)}`;
const EMAIL = {
  active: `reset_active_${suffix}@example.test`,
  inactive: `reset_gone_${suffix}@example.test`,
  unknown: `reset_nobody_${suffix}@example.test`,
};

const createdIds: number[] = [];
let activeId: number;
let inactiveId: number;

/** An anonymous caller on the REAL router — both procedures are public. */
function api() {
  return appRouter.createCaller(testContext() as never);
}

beforeAll(async () => {
  const hash = await hashPassword(OLD_PASSWORD);
  const db = getDb();
  const [active] = await db
    .insert(users)
    .values({ name: 'Reset Fixture', email: EMAIL.active, passwordHash: hash, role: 'owner' });
  activeId = active.insertId;
  const [gone] = await db.insert(users).values({
    name: 'Reset Inactive Fixture',
    email: EMAIL.inactive,
    passwordHash: hash,
    role: 'finance',
    isActive: false,
  });
  inactiveId = gone.insertId;
  createdIds.push(activeId, inactiveId);
}, 120_000);

beforeEach(() => {
  resetPasswordResetThrottleForTests();
  resetEmailThrottleForTests();
  // No SMTP in the test environment, so the unconfigured branch is the one
  // that runs unless a test installs a transport of its own.
  resetTransportForTests();
});

afterEach(async () => {
  resetTransportForTests();
  vi.restoreAllMocks();
  const pool = getPool();
  for (const id of createdIds) {
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query(
      "DELETE FROM audit_log WHERE action = 'staff.password_reset_self' AND actor_id = ?",
      [id],
    );
  }
  // Put the fixture back the way the suite found it, so test order never
  // decides whether `OLD_PASSWORD` still signs in.
  const hash = await hashPassword(OLD_PASSWORD);
  await getDb()
    .update(users)
    .set({ passwordHash: hash, mustChangePassword: false })
    .where(inArray(users.id, createdIds));
});

afterAll(async () => {
  if (createdIds.length > 0) await getDb().delete(users).where(inArray(users.id, createdIds));
});

/** Every live token row for one user, newest first. */
async function tokenRows(userId: number) {
  return getDb()
    .select({
      id: passwordResetTokens.id,
      tokenHash: passwordResetTokens.tokenHash,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, userId))
    .orderBy(sql`${passwordResetTokens.id} DESC`);
}

/**
 * Issues a token the way the resolver does — a raw value plus the row — so a
 * test can own the clock and the `used_at` state without going through the
 * mail path.
 *
 * It mirrors `requestPasswordReset`'s own insert deliberately rather than
 * calling it: the tests for expiry and reuse need a row with a chosen
 * `expires_at`, and the procedure takes no time from its caller.
 */
async function issueToken(
  userId: number,
  options: { expiresAt?: Date; usedAt?: Date } = {},
): Promise<string> {
  const raw = `fixture-token-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await getDb()
    .insert(passwordResetTokens)
    .values({
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: options.expiresAt ?? new Date(Date.now() + RESET_TOKEN_TTL_MS),
      usedAt: options.usedAt ?? null,
      createdAt: new Date(),
    });
  return raw;
}

/**
 * Redeems a token and returns WHAT WENT WRONG, as a plain `{code, message}`.
 *
 * A helper rather than an inline `.catch()` at each call site, for a reason
 * the compiler found: `promise.catch(e => e as Refusal)` widens to
 * `{ ok: true } | Refusal`, so reading `.code` off it is a type error — and
 * the honest fix is to make "this call was supposed to be refused" explicit.
 * A call that unexpectedly SUCCEEDS throws here, so a test asserting on a
 * refusal can never quietly pass against a procedure that allowed the thing.
 */
interface Refusal {
  code?: string;
  message?: string;
}

async function refusalOf(token: string, newPassword: string = NEW_PASSWORD): Promise<Refusal> {
  try {
    await api().staffAuth.resetPassword({ token, newPassword });
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('resetPassword SUCCEEDED where the test expected a refusal');
}

/* ------------------------------------------------------------------ *
 * maskEmail — pure, total, and it never emits the whole address.
 * ------------------------------------------------------------------ */

describe('maskEmail', () => {
  it('keeps the first character and the domain for an ordinary address', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
  });

  /**
   * The case the obvious implementation gets wrong: showing the first
   * character of a one-character local part prints the ENTIRE address.
   */
  it('masks a ONE-CHARACTER local part completely rather than printing the whole address', () => {
    expect(maskEmail('j@example.com')).toBe('•••@example.com');
    expect(maskEmail('j@example.com')).not.toContain('j@');
  });

  it('survives an empty local part', () => {
    expect(maskEmail('@example.com')).toBe('•••@example.com');
  });

  it('replaces a value with no @ at all, and never throws', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('')).toBe('•••');
  });

  /** `lastIndexOf`, so a local part containing an @ cannot shift the split. */
  it('splits on the LAST @, so a quoted local part cannot leak', () => {
    expect(maskEmail('a@b@example.com')).toBe('a•••@example.com');
  });

  it('never emits the full address for any of these', () => {
    for (const address of ['jane@example.com', 'j@example.com', 'a@b@example.com']) {
      expect(maskEmail(address)).not.toBe(address);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The mail: no token in a log line, and it cannot throw.
 * ------------------------------------------------------------------ */

describe('sendStaffPasswordResetEmail', () => {
  it('logs ONE masked line and NEVER the link when SMTP is not configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const url = passwordResetUrl('a-secret-raw-token-value');

    await sendStaffPasswordResetEmail('jane@example.com', url);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(' ');
    expect(line).toContain('reset email queued for');
    expect(line).toContain('j•••@example.com');
    expect(line, 'the log line carried the raw token').not.toContain('a-secret-raw-token-value');
    expect(line, 'the log line carried the reset link').not.toContain(url);
    expect(line, 'the log line carried the full address').not.toContain('jane@example.com');
  });

  it('CANNOT THROW when the transport fails, and logs no token', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });
    const url = passwordResetUrl('another-secret-raw-token');

    await expect(sendStaffPasswordResetEmail('jane@example.com', url)).resolves.toBeUndefined();

    const line = error.mock.calls[0]!.join(' ');
    expect(line).toContain('j•••@example.com');
    expect(line).not.toContain('another-secret-raw-token');
    // The error's TYPE, never its message — SMTP failures quote credentials.
    expect(line).toContain('Error');
    expect(line).not.toContain('smtp unreachable');
  });

  it('sends a mail carrying the link, with no red anywhere', () => {
    const mail = renderStaffPasswordResetMail(
      'https://travelsugbo.test/admin/reset-password?token=x',
    );
    expect(mail.html).toContain('https://travelsugbo.test/admin/reset-password?token=x');
    expect(mail.text).toContain('https://travelsugbo.test/admin/reset-password?token=x');
    expect(mail.subject).toContain('password');
    expect(mail.html.toLowerCase()).not.toMatch(/#(?:f00|ff0000|dc2626|ef4444)/);
  });

  it('builds the link from PUBLIC_BASE_URL and points at the client reset route', () => {
    expect(passwordResetUrl('abc')).toMatch(/\/admin\/reset-password\?token=abc$/);
  });
});

/* ------------------------------------------------------------------ *
 * requestPasswordReset — one response, always.
 * ------------------------------------------------------------------ */

describeWithDb('staffAuth.requestPasswordReset', () => {
  /**
   * **Test 1 of the brief's five.** The whole response object, compared
   * field for field between a real account and an address that belongs to
   * nobody. Asserting only "it did not throw" would pass against a version
   * that answered `{ ok: true, sent: true }` for one and
   * `{ ok: true, sent: false }` for the other.
   */
  it('answers an UNKNOWN email byte-identically to a known one', async () => {
    const known = await api().staffAuth.requestPasswordReset({ email: EMAIL.active });
    const unknown = await api().staffAuth.requestPasswordReset({ email: EMAIL.unknown });

    expect(unknown).toEqual(known);
    expect(unknown).toEqual({ ok: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
  });

  it('issues exactly one token for an active account, stored only as a SHA-256', async () => {
    await api().staffAuth.requestPasswordReset({ email: EMAIL.active });

    const rows = await tokenRows(activeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.usedAt).toBeNull();
  });

  /**
   * **The window is asserted against a LITERAL thirty minutes, not against
   * `RESET_TOKEN_TTL_MS`.** Reading the constant the resolver reads would
   * make this test a tautology — it would pass for a five-minute window and
   * for a five-year one — which is exactly the shape of test CLAUDE.md
   * calls a bug. The constant is pinned separately below.
   */
  it('sets expires_at THIRTY MINUTES out', async () => {
    const thirtyMinutes = 30 * 60_000;
    const before = Date.now();
    await api().staffAuth.requestPasswordReset({ email: EMAIL.active });
    const after = Date.now();

    const [row] = await tokenRows(activeId);
    const expires = row!.expiresAt.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + thirtyMinutes - 2_000);
    expect(expires).toBeLessThanOrEqual(after + thirtyMinutes + 2_000);
  });

  /**
   * §12's own numbers, pinned so a loosening is a deliberate edit here and
   * not a one-character change nobody reads. Thirty minutes is the spec's
   * figure; the two limits are this task's (see `services/password-reset.ts`
   * and `middleware/rate-limit.ts` for why each is the number it is).
   */
  it('pins the policy numbers §12 and task 1C decided', () => {
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60_000);
    expect(RESET_MAX_PER_EMAIL).toBe(3);
    expect(STAFF_PASSWORD_RESET_MAX_PER_IP).toBe(10);
  });

  /** An unknown address writes nothing, so there is nothing to sweep. */
  it('writes NO token row for an unknown email', async () => {
    await api().staffAuth.requestPasswordReset({ email: EMAIL.unknown });

    const counted = await getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(passwordResetTokens);
    expect(Number(counted[0]!.n)).toBe(0);
  });

  /**
   * A deactivated staff member must not be able to reset their way back in:
   * `readSession` already refuses their sessions and `verifyStaffPassword`
   * already refuses their password, so a live reset link would be the one
   * door left open.
   */
  it('answers the SAME for a deactivated account and writes NO token row', async () => {
    const result = await api().staffAuth.requestPasswordReset({ email: EMAIL.inactive });

    expect(result).toEqual({ ok: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
    expect(await tokenRows(inactiveId)).toHaveLength(0);
  });

  it('does not attempt a send for an unknown email', async () => {
    const sent: unknown[] = [];
    setTransportForTests({
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: 'mock' };
      },
    });

    await api().staffAuth.requestPasswordReset({ email: EMAIL.unknown });
    expect(sent, 'a mail was sent for an address nobody asked about').toHaveLength(0);

    await api().staffAuth.requestPasswordReset({ email: EMAIL.active });
    expect(sent).toHaveLength(1);
  });

  /**
   * The throttle must not become the oracle the generic message exists to
   * prevent: the fourth request in a window answers exactly like the first.
   */
  it('returns the SAME generic response once the per-email throttle has fired, and issues no token', async () => {
    for (let i = 0; i < RESET_MAX_PER_EMAIL; i += 1) {
      await api().staffAuth.requestPasswordReset({ email: EMAIL.active });
    }
    const issued = (await tokenRows(activeId)).length;
    expect(issued).toBe(RESET_MAX_PER_EMAIL);

    const throttled = await api().staffAuth.requestPasswordReset({ email: EMAIL.active });

    expect(throttled).toEqual({ ok: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
    expect((await tokenRows(activeId)).length, 'a throttled request still issued a token').toBe(
      issued,
    );
  });

  /** Casing must not dodge the throttle, nor miss the account. */
  it('matches the account case-insensitively and throttles on the same key', async () => {
    await api().staffAuth.requestPasswordReset({ email: EMAIL.active.toUpperCase() });
    expect(await tokenRows(activeId)).toHaveLength(1);

    for (let i = 1; i < RESET_MAX_PER_EMAIL; i += 1) {
      await api().staffAuth.requestPasswordReset({ email: EMAIL.active });
    }
    await api().staffAuth.requestPasswordReset({ email: EMAIL.active.toUpperCase() });
    expect(await tokenRows(activeId)).toHaveLength(RESET_MAX_PER_EMAIL);
  });

  it('refuses a stray field rather than ignoring it', async () => {
    await expect(
      api().staffAuth.requestPasswordReset({ email: EMAIL.active, userId: 1 } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * **The `skipSuccessfulRequests` trap, pinned — and it takes SEQUENTIAL
   * requests to pin it.**
   *
   * `requestPasswordReset` answers 200 for EVERY input by design, so a
   * limiter that counted failures only — which is what
   * `STAFF_LOGIN_PROCEDURES` does via `skipSuccessfulRequests: true` —
   * would limit nothing at all here.
   *
   * This has to be eleven separate HTTP requests rather than one batch of
   * eleven, and the reason was MEASURED rather than reasoned: the give-back
   * that `skipSuccessfulRequests` performs happens on the response's
   * `finish` event, so inside a single batched request all eleven
   * increments land before any of them is handed back and the 429 fires
   * either way. A batch therefore cannot tell the two configurations apart
   * — the first version of this test WAS a batch, the mutation was applied,
   * and it stayed green. Sequential requests are what make the flag
   * observable.
   *
   * Unknown addresses on purpose: this test is about the per-IP limiter, so
   * it must not spend the per-email throttle or write any token rows.
   */
  it('counts SUCCESSFUL reset requests per IP, so the eleventh in a window is refused', async () => {
    const app = createApp();
    const statuses: number[] = [];

    for (let i = 0; i <= STAFF_PASSWORD_RESET_MAX_PER_IP; i += 1) {
      const res = await request(app)
        .post('/trpc/staffAuth.requestPasswordReset')
        // The CSRF origin check runs ahead of the limiter; without this the
        // request is 403'd and the limiter never sees it.
        .set('Origin', 'http://localhost:5180')
        .send({ email: `ip_seq_${i}_${suffix}@example.test` });
      statuses.push(res.status);
    }

    expect(
      statuses.slice(0, STAFF_PASSWORD_RESET_MAX_PER_IP),
      'a request inside the budget was refused',
    ).toEqual(Array(STAFF_PASSWORD_RESET_MAX_PER_IP).fill(200));
    expect(
      statuses.at(-1),
      'the eleventh SUCCESSFUL reset request was not refused — the limiter is missing from ' +
        'app.ts, or it is counting failures only (skipSuccessfulRequests)',
    ).toBe(429);
  });

  /**
   * And the same budget is spent per CALL, not per request: a tRPC batch
   * naming the procedure eleven times is eleven attempts. The same property
   * `createProcedureRateLimit` gives every other limiter, asserted here
   * because a limiter aimed at a procedure name that does not match fails
   * OPEN while looking mounted.
   */
  it('counts batched calls individually rather than once per request', async () => {
    const app = createApp();
    const count = STAFF_PASSWORD_RESET_MAX_PER_IP + 1;

    const batch = Array(count).fill('staffAuth.requestPasswordReset').join(',');
    const res = await request(app)
      .post(`/trpc/${batch}?batch=1`)
      .set('Origin', 'http://localhost:5180')
      .send(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            i,
            { email: `ip_b_${i}_${suffix}@example.test` },
          ]),
        ),
      );

    expect(res.status, 'a batch of eleven reset requests was not refused').toBe(429);
  });
});

/* ------------------------------------------------------------------ *
 * resetPassword — one refusal for four wrongs, and single use.
 * ------------------------------------------------------------------ */

describeWithDb('staffAuth.resetPassword', () => {
  /** **Test 2:** expired, driven by a controlled `expires_at`. */
  it('REFUSES an expired token', async () => {
    const token = await issueToken(activeId, { expiresAt: new Date(Date.now() - 1_000) });

    await expect(
      api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: PASSWORD_RESET_REFUSED_MESSAGE });

    // And it did not write the password anyway.
    const signIn = await api()
      .staffAuth.login({ email: EMAIL.active, password: NEW_PASSWORD })
      .catch((e: unknown) => e);
    expect(signIn).toBeInstanceOf(Error);
  });

  /** **Test 3, first half:** already spent. */
  it('REFUSES a token that has already been used', async () => {
    const token = await issueToken(activeId, { usedAt: new Date() });

    await expect(
      api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: PASSWORD_RESET_REFUSED_MESSAGE });
  });

  /** **Test 4:** unknown, with the SAME sentence as expired and used. */
  it('REFUSES an unknown token with the same message as expired and used', async () => {
    const expiredToken = await issueToken(activeId, { expiresAt: new Date(Date.now() - 1_000) });
    const usedToken = await issueToken(activeId, { usedAt: new Date() });

    const unknown = await refusalOf('a-token-that-was-never-issued');
    const expired = await refusalOf(expiredToken);
    const used = await refusalOf(usedToken);

    expect(unknown.message).toBe(expired.message);
    expect(unknown.message).toBe(used.message);
    expect(unknown.code).toBe(expired.code);
    expect(unknown.code).toBe(used.code);
  });

  /** A token for a deactivated account is the same refusal again. */
  it('REFUSES a token whose user is deactivated, with the same message', async () => {
    const token = await issueToken(inactiveId);

    await expect(
      api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: PASSWORD_RESET_REFUSED_MESSAGE });
  });

  /**
   * **Test 5:** the whole flow, through the real procedures. Ask for a
   * reset, redeem the token, sign in with the new password — and every
   * session the user held at the start is gone.
   */
  it('sets the password, signs in with it, and revokes EVERY old session', async () => {
    const stale = await createSession('user', activeId, new Date());
    const second = await createSession('user', activeId, new Date());
    expect(await readSession(stale.token, new Date())).not.toBeNull();

    const token = await issueToken(activeId);

    await expect(
      api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD }),
    ).resolves.toEqual({ ok: true });

    expect(await readSession(stale.token, new Date()), 'an old session survived').toBeNull();
    expect(await readSession(second.token, new Date()), 'an old session survived').toBeNull();

    await expect(
      api().staffAuth.login({ email: EMAIL.active, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ role: 'owner', mustChangePassword: false });

    // The old one is dead.
    resetEmailThrottleForTests();
    await expect(
      api().staffAuth.login({ email: EMAIL.active, password: OLD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * The person chose this password at a form, so they are NOT asked to
   * change it again — the contrast with `admin.staffUsers.resetPassword`,
   * which issues a temporary one and correctly sets the flag.
   */
  it('clears must_change_password rather than setting it', async () => {
    await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, activeId));
    const token = await issueToken(activeId);

    await api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD });

    const [row] = await getDb()
      .select({ flag: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, activeId));
    expect(row!.flag).toBe(false);
  });

  it('marks the redeemed token used and invalidates every OTHER outstanding one', async () => {
    const first = await issueToken(activeId);
    const second = await issueToken(activeId);
    const third = await issueToken(activeId);
    expect([first, second, third]).toHaveLength(3);

    await api().staffAuth.resetPassword({ token: second, newPassword: NEW_PASSWORD });

    const rows = await tokenRows(activeId);
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((row) => row.usedAt === null),
      'a live reset link survived a completed reset',
    ).toHaveLength(0);
  });

  /**
   * **Test 3, second half — the race.** Two redemptions of ONE link, fired
   * together. Exactly one wins; the loser is refused by exception, and only
   * one password write happened.
   *
   * The pre-read in the resolver would let both through, so what is being
   * proven is the conditional `UPDATE … WHERE used_at IS NULL` and the
   * `affectedRows` check beneath it.
   */
  it('lets only ONE of two concurrent redemptions win, with one password write', async () => {
    const token = await issueToken(activeId);
    const firstPassword = `${NEW_PASSWORD}-one`;
    const secondPassword = `${NEW_PASSWORD}-two`;

    const settled = await Promise.allSettled([
      api().staffAuth.resetPassword({ token, newPassword: firstPassword }),
      api().staffAuth.resetPassword({ token, newPassword: secondPassword }),
    ]);

    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');
    expect(won, 'both concurrent redemptions succeeded').toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      message: PASSWORD_RESET_REFUSED_MESSAGE,
    });

    // ONE password write: exactly one of the two passwords signs in.
    const okFirst = await api()
      .staffAuth.login({ email: EMAIL.active, password: firstPassword })
      .then(() => true)
      .catch(() => false);
    resetEmailThrottleForTests();
    const okSecond = await api()
      .staffAuth.login({ email: EMAIL.active, password: secondPassword })
      .then(() => true)
      .catch(() => false);
    expect(
      [okFirst, okSecond].filter(Boolean),
      'both passwords were written, or neither was',
    ).toHaveLength(1);

    // And exactly ONE audit row, so the loser committed nothing.
    const audit = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'staff.password_reset_self' AND ${auditLog.actorId} = ${activeId}`,
      );
    expect(audit).toHaveLength(1);
  });

  /**
   * The audit row is the record, and it must be useless to anyone who reads
   * it looking for a credential. `audit_log` is admin-only but is also
   * exported in reports.
   */
  it('writes ONE audit row with the counts and NO secret', async () => {
    await createSession('user', activeId, new Date());
    const extra = await issueToken(activeId);
    const token = await issueToken(activeId);
    expect(extra).toBeTruthy();

    await api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD });

    const rows = await getDb()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        data: auditLog.data,
      })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'staff.password_reset_self' AND ${auditLog.actorId} = ${activeId}`,
      );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorType).toBe('user');
    expect(Number(row.actorId)).toBe(activeId);
    expect(row.entity).toBe('users');
    expect(Number(row.entityId)).toBe(activeId);
    expect(row.data).toEqual({ sessionsRevoked: 1, tokensInvalidated: 1 });

    const serialised = JSON.stringify(row.data);
    expect(serialised, 'the new password reached the audit row').not.toContain(NEW_PASSWORD);
    expect(serialised, 'the raw token reached the audit row').not.toContain(token);
    expect(serialised, 'the token hash reached the audit row').not.toContain(hashResetToken(token));
    expect(serialised, 'a scrypt hash reached the audit row').not.toContain('scrypt$');
  });

  it('refuses a password below the shared minimum, with a per-FIELD message', async () => {
    const token = await issueToken(activeId);

    const error = await refusalOf(token, 'short');
    expect(error.code).toBe('BAD_REQUEST');

    // The token is untouched, so a typo does not burn the link.
    const [row] = await tokenRows(activeId);
    expect(row!.usedAt).toBeNull();
  });

  it('refuses a stray field rather than ignoring it', async () => {
    const token = await issueToken(activeId);
    await expect(
      api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD, userId: 1 } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * The end of the flow: no session is created by a reset. The person signs
   * in afterwards, which is what the client does by sending them to the
   * sign-in screen.
   */
  it('creates NO session of its own', async () => {
    const token = await issueToken(activeId);
    await api().staffAuth.resetPassword({ token, newPassword: NEW_PASSWORD });

    const rows = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(sql`${sessions.subjectType} = 'user' AND ${sessions.subjectId} = ${activeId}`);
    expect(rows).toHaveLength(0);
  });
});
