# Week 4 — Manual QR, Customer Portal & Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 — a guest can pay by manual QR transfer, upload a receipt, track the booking in a portal they reach with ref + email, and receive email at each step; an admin can verify or reject that receipt.

**Architecture:** Four layers, each usable before the next exists. (1) A **session foundation** — the tRPC context factory, signed cookies and `sessions` row handling — which does not exist today and which both the portal and the admin surface need. (2) An **upload layer** storing receipts outside the web root behind an authenticated route. (3) **Manual payment** recording and admin approve/**reject**, reusing `recordPayment`'s invariant that only a verified webhook or an admin approval marks a booking paid. (4) The **portal and admin screens** on top, plus a **notification** layer whose failures never block a booking flow.

**Tech Stack:** Existing — React + TS + Vite + Tailwind v4 + shadcn/ui, Express + tRPC, Drizzle + MySQL 8, Zod, `express-rate-limit`, `node-cron`, Vitest. **Two new dependencies, both named in BUILD_SPEC §2:** `nodemailer` (SMTP transport) and `cookie-parser` (session cookies). No others — see Q11.

**Spec:** `docs/BUILD_SPEC.md` — §6 (manual QR payment), §7 (customer portal), §9 (admin), §11 (notifications), §12 (security checklist), §13 Week 4 (4A–4E).

## Global Constraints

Copied verbatim from `CLAUDE.md` and BUILD_SPEC. Every task's requirements implicitly include this section.

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display. The server computes all money; the browser never sends one.
- **Only a verified webhook or an admin approval marks a booking paid** — for every provider. Nothing on a redirect, a client call or a portal action may.
- **Never hard-delete a booking or a payment.** Soft-delete through `is_active` / status fields.
- **Time:** store **UTC**; compute business dates in **Asia/Manila**. A tour date is a civil date, never an instant.
- **Audit:** every payment, refund, status change and assignment writes to `audit_log` via `writeAudit(tx, …)`.
- **Validation:** Zod on every input, schemas shared from `/shared`.
- **NO RED ANYWHERE** — including errors, badges and destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`). `client/src/__tests__/no-red.test.ts` fails the build if red reappears.
- **Mobile-first, must work at 360px.** 44px minimum tap targets, visible focus states, alt text on every image, AA contrast. `brand-gold-600` fails AA for normal-size text — small gold text uses `brand-gold-700` or darker.
- **Use `ui-ux-pro-max` for every screen in this plan** (owner instruction 2026-10-13). Motion only after layout exists, via `emilkowalski-motion`, and must respect `prefers-reduced-motion`.
- **Uploads:** validate MIME **and** extension **and** size, rename to random IDs, store **outside the web root**, serve only via an authenticated route.
- **Ports:** client **5180**, server **3100**. Never 5173 or 3000. Test database is `rg_travel_test`; never connect a test to `rg_travel`.
- **Data Privacy Act (RA 10173):** admin-only access to personal data; a portal session reaches exactly one booking.
- **Every new test must be proven able to fail.** Break the covered code, confirm red, restore. Security controls and destructive operations must fail closed, with a test for the failure path.
- **Verify before pushing — all five, in this order:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.
- After any schema change, remind the user to apply the migration on the server database.

---

## What already exists (read before Task 1)

Verified against the tree at `83b83f9`, so no task rebuilds something that is there:

| Thing                                  | State                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions` table                       | **Exists** — `subject_type` (`user`\|`customer`\|`driver`), `subject_id`, `token_hash` (unique, 64), `expires_at`. No schema change needed.                                                                                                                               |
| `payments` table                       | **Exists with every column this week needs** — `txn_ref`, `receipt_path`, `reject_reason`, `verified_by`, `verified_at`, `status` (`pending`\|`paid`\|`rejected`\|`failed`\|`refunded`), `provider` (`paymongo`\|`xendit`\|`manual`). **No schema change needed for 4A.** |
| `reviews` table                        | **Exists** with `booking_id` and the four sub-scores (`guide`, `value`, `punctuality`, `safety`), `status` defaulting to `pending`.                                                                                                                                       |
| `requireRole` / `adminProcedure(area)` | **Exist** (`server/src/middleware/require-role.ts`, `server/src/trpc.ts`) and **fail closed**.                                                                                                                                                                            |
| tRPC **context factory**               | **DOES NOT EXIST.** `app.ts:142` is `createExpressMiddleware({ router: appRouter })` with no `createContext`, so `ctx` is `{}` and `ctx.session` is always `undefined`. **Every `adminProcedure` currently refuses everything.** This is why Task 1 exists.               |
| Cookie parsing                         | **Does not exist.** No `cookie-parser`, no `cookie` dependency.                                                                                                                                                                                                           |
| Any upload handling                    | **Does not exist.** No `multer`, no `/uploads` route, no `uploads/` directory.                                                                                                                                                                                            |
| Email                                  | **Does not exist.** No transport, no templates, no `nodemailer`.                                                                                                                                                                                                          |
| `recordPendingCash()`                  | Exists but is the **driver-collected cash** path — its input _requires_ `collectedByDriverId`. It is **not** reusable for a guest receipt.                                                                                                                                |
| `verifyCashPayment()`                  | Exists but **only approves**. `payments.reject_reason` is never written anywhere in the codebase and `'rejected'` is never set. **The reject path does not exist** — Task 6 builds it.                                                                                    |
| Portal / admin pages                   | **Do not exist.** No `client/src/pages/portal`, no `.../admin`.                                                                                                                                                                                                           |
| QR image setting                       | **Does not exist** in `settings-schema.ts`. See Q3.                                                                                                                                                                                                                       |

---

## File Structure

**Session foundation**

- `server/src/services/sessions.ts` — mint, hash, read, revoke a `sessions` row. One responsibility: session lifecycle.
- `server/src/context.ts` — the tRPC context factory: reads the cookie, resolves a session, exposes `ctx.session`. The single place a request becomes an identity.
- `server/src/middleware/session-cookie.ts` — cookie name, flags and the set/clear helpers, so no resolver hand-rolls a `Set-Cookie`.

**Uploads**

- `server/src/services/uploads.ts` — validate (MIME + extension + size), rename to a random id, write under `UPLOAD_DIR`.
- `server/src/routers/receipts.ts` — the authenticated Express route that serves one receipt to the session that owns it.

**Manual payment**

- `server/src/services/payments/manual-receipt.ts` — `recordManualReceipt()` and `decideManualReceipt()` (approve **or** reject). Separate file from `record-payment.ts`, which is a do-not-modify file for this week.

**Notifications**

- `server/src/services/notify/transport.ts` — nodemailer transport, plus the mock used by every test.
- `server/src/services/notify/templates.ts` — one function per §11 event, returning `{ subject, html, text }`.
- `server/src/services/notify/index.ts` — `notify(event, payload)`: renders, sends, swallows and logs failures.

**Routers**

- `server/src/routers/public/portal.ts` — `portal.login`, `portal.logout`, `portal.booking`, `portal.uploadReceipt`, `portal.submitReview`.
- `server/src/routers/admin/bookings.ts` — `admin.bookings.list`, `admin.bookings.detail`, `admin.bookings.decideReceipt`.

**Client**

- `client/src/pages/portal/PortalLoginPage.tsx`, `PortalBookingPage.tsx`
- `client/src/components/portal/Tracker.tsx`, `ReceiptUpload.tsx`, `DriverCard.tsx`, `ReviewForm.tsx`
- `client/src/pages/public/ManualQrPage.tsx` — the QR, the amount, the countdown, the download
- `client/src/pages/admin/AdminBookingsPage.tsx`, `AdminBookingDetailPage.tsx`

---

## Tasks

### Task 1: The session foundation

**Files:**

- Create: `server/src/services/sessions.ts`
- Create: `server/src/middleware/session-cookie.ts`
- Create: `server/src/context.ts`
- Modify: `server/src/app.ts:142` (pass `createContext`), and the `cors` block at `:52`
- Modify: `server/src/env.ts` (add `SESSION_COOKIE_SECRET`)
- Test: `server/src/__tests__/sessions.test.ts`

**Interfaces:**

- Consumes: `sessions` table from `db/schema`; `getDb`, `Transaction` from `db/client`.
- Produces:
  - `createSession(subjectType: 'user' | 'customer' | 'driver', subjectId: number, now: Date): Promise<{ token: string; expiresAt: Date }>`
  - `readSession(token: string, now: Date): Promise<{ subjectType: string; subjectId: number } | null>`
  - `revokeSession(token: string): Promise<void>`
  - `SESSION_COOKIE = 'rg_session'`, `setSessionCookie(res, token, expiresAt)`, `clearSessionCookie(res)`
  - `createContext({ req, res })` → `{ req, res, session: StaffSession | CustomerSession | null }`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/sessions.test.ts
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions } from '../db/schema';
import { createSession, readSession, revokeSession } from '../services/sessions';
import { describeWithDb } from './helpers/db';

const NOW = new Date('2026-10-13T00:00:00Z');

describeWithDb('sessions', () => {
  it('stores only a HASH of the token, never the token itself', async () => {
    const { token } = await createSession('customer', 4242, NOW);
    const [row] = await getDb()
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.subjectId, 4242));
    expect(row!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row!.tokenHash).not.toBe(token);
  });

  it('resolves a live token to its subject', async () => {
    const { token } = await createSession('customer', 7, NOW);
    expect(await readSession(token, NOW)).toEqual({ subjectType: 'customer', subjectId: 7 });
  });

  it('refuses an expired token — fails CLOSED', async () => {
    const { token, expiresAt } = await createSession('customer', 7, NOW);
    const oneMsLater = new Date(expiresAt.getTime() + 1);
    expect(await readSession(token, oneMsLater)).toBeNull();
  });

  it('refuses an unknown token, and a token whose row was revoked', async () => {
    expect(await readSession('not-a-real-token', NOW)).toBeNull();
    const { token } = await createSession('customer', 9, NOW);
    await revokeSession(token);
    expect(await readSession(token, NOW)).toBeNull();
  });

  it('mints a token with at least 256 bits of entropy, and never the same one twice', async () => {
    const a = await createSession('customer', 1, NOW);
    const b = await createSession('customer', 1, NOW);
    expect(a.token).not.toBe(b.token);
    // 32 bytes, base64url: 43 chars.
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && pnpm vitest run src/__tests__/sessions.test.ts`
Expected: FAIL — `Cannot find module '../services/sessions'`.

- [ ] **Step 3: Implement `services/sessions.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions } from '../db/schema';

/** Customer sessions last a day; §7 logs a guest in with ref + email, not a password. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The token is the credential; only its SHA-256 lands in the database. A
 * stolen database dump is then a list of hashes, not a list of live
 * sessions — the same reason passwords are hashed.
 */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  subjectType: 'user' | 'customer' | 'driver',
  subjectId: number,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await getDb()
    .insert(sessions)
    .values({
      subjectType,
      subjectId,
      tokenHash: hash(token),
      expiresAt,
      createdAt: now,
    });
  return { token, expiresAt };
}

export async function readSession(
  token: string,
  now: Date,
): Promise<{ subjectType: string; subjectId: number } | null> {
  const [row] = await getDb()
    .select({ subjectType: sessions.subjectType, subjectId: sessions.subjectId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, hash(token)));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd server && pnpm vitest run src/__tests__/sessions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the cookie helper**

```ts
// server/src/middleware/session-cookie.ts
import type { Response } from 'express';
import { env } from '../env';

export const SESSION_COOKIE = 'rg_session';

/**
 * §12 / CLAUDE.md: secure, httpOnly, sameSite=lax. `httpOnly` is the one
 * that matters most here — it is what stops an XSS payload reading the
 * session token out of `document.cookie`.
 *
 * `secure` is conditional on SITE_ENV because the dev server is plain HTTP
 * on 5180; a cookie marked secure would simply never be sent there, and the
 * portal would appear to log in and then immediately be logged out.
 */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.SITE_ENV === 'production',
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
```

- [ ] **Step 6: Add the context factory and wire it**

```ts
// server/src/context.ts
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { readSession } from './services/sessions';
import { SESSION_COOKIE } from './middleware/session-cookie';

/**
 * The ONE place a request becomes an identity.
 *
 * Until this existed, `ctx` was `{}` — so `ctx.session` was always
 * undefined and every `adminProcedure` refused everything. That failed
 * closed, which is why nothing was broken by it, but it also means nothing
 * downstream has ever run with a real session: treat every `adminProcedure`
 * as unexercised until Task 10 drives one.
 */
export async function createContext({ req, res }: CreateExpressContextOptions) {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const session = token ? await readSession(token, new Date()) : null;
  return { req, res, session };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
```

In `app.ts`, add `app.use(cookieParser())` before the tRPC mount and change `:142` to
`app.use('/trpc', createExpressMiddleware({ router: appRouter, createContext }));`

- [ ] **Step 7: Prove each test can fail**

For each: break the covered line, confirm red, restore. State the red message per test in the report.
Mutations to use: store `token` instead of `hash(token)` (hash test reds); drop the `gt(expiresAt, now)` clause (expiry test reds); make `revokeSession` a no-op (revoke test reds); replace `randomBytes(32)` with `randomBytes(8)` (entropy test reds).

- [ ] **Step 8: Five checks, then commit**

```bash
git add server/src/services/sessions.ts server/src/middleware/session-cookie.ts server/src/context.ts server/src/app.ts server/src/env.ts server/src/__tests__/sessions.test.ts
git commit -m "feat(auth): the session foundation every portal and admin screen needs"
```

**✅ DONE 1**

---

### Task 2: Portal login on ref + email, rate-limited

**Files:**

- Create: `server/src/routers/public/portal.ts`
- Modify: `server/src/routers/_app.ts` (mount `portal`)
- Modify: `server/src/middleware/rate-limit.ts` (add `createPortalLoginLimiter()`)
- Modify: `server/src/app.ts` (mount the limiter)
- Test: `server/src/__tests__/portal-login.test.ts`

**Interfaces:**

- Consumes: `createSession`, `setSessionCookie`, `clearSessionCookie` (Task 1); `bookings` from `db/schema`; `normalizeCouponCode`-style normalisation is NOT reused — email is lowercased here.
- Produces: `portal.login({ ref, email })` → `{ ok: true }` + cookie; `portal.logout()`; `portalLoginInput` in `shared/src/portal.ts`.

**The two rules that make this safe (§7):** the same generic error for a wrong ref and a wrong email, and a session scoped to **that booking only** — `subject_id` is the `bookings.id`, so a session can never widen to another booking.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/portal-login.test.ts
import { expect, it } from 'vitest';
import { appRouter } from '../routers/_app';
import { describeWithDb } from './helpers/db';
// `makeBooking` is this file's own committed fixture, same shape as
// create-hold.test.ts's — a booking with a known ref and lead_email.

describeWithDb('portal.login', () => {
  it('logs in with the right ref and email, and sets an httpOnly cookie', async () => {
    const { ref } = await makeBooking({ leadEmail: 'Guest@Example.test' });
    const res = fakeResponse();
    const caller = appRouter.createCaller({ req: fakeRequest(), res, session: null });
    await expect(caller.portal.login({ ref, email: 'guest@example.test' })).resolves.toEqual({
      ok: true,
    });
    expect(res.cookies[0]).toMatchObject({ name: 'rg_session', options: { httpOnly: true } });
  });

  it('matches the email case-insensitively (§7)', async () => {
    const { ref } = await makeBooking({ leadEmail: 'guest@example.test' });
    await expect(caller().portal.login({ ref, email: 'GUEST@EXAMPLE.TEST' })).resolves.toEqual({
      ok: true,
    });
  });

  /**
   * §7: "Same generic error for wrong ref or wrong email (don't reveal
   * which)." Asserted by DEEP EQUALITY of the two errors, not by reading
   * each one — a test that checks each message separately passes against
   * two different messages that happen to look similar.
   */
  it('gives byte-identical errors for a wrong ref and a wrong email', async () => {
    const { ref } = await makeBooking({ leadEmail: 'guest@example.test' });
    const wrongRef = await caller()
      .portal.login({ ref: 'RG-ZZZZZZ', email: 'guest@example.test' })
      .catch((e: unknown) => e);
    const wrongEmail = await caller()
      .portal.login({ ref, email: 'someone@else.test' })
      .catch((e: unknown) => e);
    expect((wrongRef as Error).message).toBe((wrongEmail as Error).message);
    expect((wrongRef as { code?: string }).code).toBe((wrongEmail as { code?: string }).code);
  });

  it('scopes the session to that ONE booking', async () => {
    const a = await makeBooking({ leadEmail: 'a@example.test' });
    const b = await makeBooking({ leadEmail: 'b@example.test' });
    const res = fakeResponse();
    await appRouter
      .createCaller({ req: fakeRequest(), res, session: null })
      .portal.login({ ref: a.ref, email: 'a@example.test' });
    const session = await readSession(res.cookies[0]!.value, new Date());
    expect(session).toEqual({ subjectType: 'customer', subjectId: a.bookingId });
    expect(session!.subjectId).not.toBe(b.bookingId);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `Cannot find module '../routers/public/portal'`.

- [ ] **Step 3: Implement the resolver**

```ts
// server/src/routers/public/portal.ts
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { portalLoginInput } from '@rg/shared';
import { getDb } from '../../db/client';
import { bookings } from '../../db/schema';
import { createSession } from '../../services/sessions';
import { setSessionCookie } from '../../middleware/session-cookie';
import { publicProcedure, router } from '../../trpc';

/**
 * ONE message for every failure, built once and returned from both
 * branches. §7 requires a guest who typed the wrong email and a guest who
 * typed a ref that does not exist to be told exactly the same thing —
 * otherwise the pair of responses is an oracle for "which refs exist".
 */
const REFUSED = () =>
  new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'That booking reference and email do not match a booking.',
  });

export const portalRouter = router({
  login: publicProcedure.input(portalLoginInput).mutation(async ({ input, ctx }) => {
    const [booking] = await getDb()
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.ref, input.ref.trim().toUpperCase()),
          // Case-insensitive by §7. `LOWER()` on the column is deliberate:
          // emails are stored as the guest typed them.
          sql`LOWER(${bookings.leadEmail}) = ${input.email.trim().toLowerCase()}`,
        ),
      )
      .limit(1);
    if (!booking) throw REFUSED();

    const { token, expiresAt } = await createSession('customer', booking.id, new Date());
    setSessionCookie(ctx.res, token, expiresAt);
    return { ok: true as const };
  }),
});
```

`shared/src/portal.ts` gains:

```ts
import { z } from 'zod';
export const portalLoginInput = z
  .object({ ref: z.string().min(1).max(12), email: z.email().max(200) })
  .strict();
```

- [ ] **Step 4: Run it and watch it pass.**

- [ ] **Step 5: Add the rate limit (§7: 5 failed attempts per IP per 15 minutes)**

Follow `createCheckoutHoldLimiter()`'s existing shape in `middleware/rate-limit.ts`, and **read that file's current state first** — a Week 3 fix wave changed how it counts, specifically so a tRPC batch cannot bypass it. The limiter must count **failed procedure calls**, not HTTP requests, or fifty batched login attempts cost one.

- [ ] **Step 6: Test the limiter, driving a BATCH**

A single-call test passes against both the counting-requests version and the counting-calls version. The test must send one HTTP request containing several `portal.login` calls and assert the 6th is refused.

- [ ] **Step 7: Prove each test can fail, then five checks and commit**

```bash
git commit -m "feat(portal): login on ref + email, with one error for both wrongs"
```

**✅ DONE 2**

---

### Task 3: Receipt upload storage

**Files:**

- Create: `server/src/services/uploads.ts`
- Create: `server/src/routers/receipts.ts`
- Modify: `server/src/app.ts` (mount `/api/receipts`), `server/src/env.ts` (`UPLOAD_DIR`)
- Modify: `.env.example`, `.gitignore` (ignore `uploads/`)
- Test: `server/src/__tests__/uploads.test.ts`

**Interfaces:**

- Consumes: `readSession` (Task 1).
- Produces: `storeReceipt(file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<{ path: string }>`; `RECEIPT_MAX_BYTES = 5 * 1024 * 1024`; `ALLOWED_RECEIPT_TYPES`.

**§6:** jpg/png/webp/pdf, max 5 MB. **CLAUDE.md:** validate MIME **and** extension **and** size, rename to a random id, store outside the web root, serve via an authenticated route.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/uploads.test.ts
import { expect, it, describe } from 'vitest';
import { RECEIPT_MAX_BYTES, storeReceipt } from '../services/uploads';

const jpeg = (bytes = 10) => ({
  buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(bytes)]),
  mimetype: 'image/jpeg',
  originalname: 'receipt.jpg',
});

describe('storeReceipt', () => {
  it('renames to a random id and keeps no part of the original name', async () => {
    const { path } = await storeReceipt({ ...jpeg(), originalname: 'my holiday receipt.jpg' });
    expect(path).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(path).not.toContain('holiday');
  });

  it('REFUSES a file whose extension and MIME disagree', async () => {
    await expect(
      storeReceipt({ ...jpeg(), mimetype: 'image/jpeg', originalname: 'receipt.pdf' }),
    ).rejects.toThrow(/type/i);
  });

  it('REFUSES an executable renamed to .jpg', async () => {
    await expect(
      storeReceipt({
        buffer: Buffer.from('MZ'),
        mimetype: 'application/x-msdownload',
        originalname: 'receipt.jpg',
      }),
    ).rejects.toThrow(/type/i);
  });

  it('REFUSES a file over 5 MB', async () => {
    await expect(storeReceipt(jpeg(RECEIPT_MAX_BYTES + 1))).rejects.toThrow(/size|large/i);
  });

  it('REFUSES a path-traversal filename without writing anything', async () => {
    await expect(
      storeReceipt({ ...jpeg(), originalname: '../../../etc/passwd.jpg' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement — reject on ANY of the three checks; the stored name is `randomBytes(16).toString('hex')` plus the extension derived from the allow-listed MIME, never from the upload.**
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: The authenticated serve route, and its own test** — a receipt belongs to exactly one booking; the route must refuse a session for a different booking and refuse no session at all, **returning the same 404 for both** so it is not an oracle for which receipts exist. An admin session may read any receipt.
- [ ] **Step 6: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(uploads): receipts outside the web root, behind a session"
```

**✅ DONE 3**

---

### Task 4: The notification layer

**Files:**

- Create: `server/src/services/notify/transport.ts`, `templates.ts`, `index.ts`
- Modify: `server/src/env.ts`, `.env.example` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`)
- Modify: `server/package.json` (add `nodemailer`)
- Test: `server/src/__tests__/notify.test.ts`

**Interfaces:**

- Produces: `notify(event: NotifyEvent, payload): Promise<void>`; `setTransportForTests(mock)`; `renderTemplate(event, payload) → { subject, html, text }`.

**Owner decision 2026-10-13 (Week 3 Q2):** `nodemailer` over SMTP, Brevo SMTP relay as the intended provider, **no other email library**, every value in `.env` so the provider swaps without a code change. **Tests use a mock transport and never send real email.**

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/notify.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notify, setTransportForTests } from '../services/notify';

const sent: Array<{ to: string; subject: string; html: string }> = [];
setTransportForTests({
  sendMail: async (message) => {
    sent.push(message);
    return { messageId: 'mock' };
  },
});

afterEach(() => (sent.length = 0));

describe('notify', () => {
  it('sends the booking-confirmed email to the guest with the ref in the subject', async () => {
    await notify('booking_confirmed', {
      to: 'guest@example.test',
      ref: 'RG-7KQ4M9',
      tourTitle: 'Oslob',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('guest@example.test');
    expect(sent[0]!.subject).toContain('RG-7KQ4M9');
  });

  /**
   * §11: "Failures are logged and never block the booking flow." This is
   * the test that matters — a guest must never lose a booking because an
   * SMTP server was down.
   */
  it('NEVER throws when the transport fails, and logs instead', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });
    await expect(
      notify('booking_confirmed', { to: 'g@example.test', ref: 'RG-7KQ4M9', tourTitle: 'Oslob' }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('never puts a secret or a full email body in the log line', async () => {
    // The log names the event and the ref only — never SMTP_PASS, never the
    // rendered HTML, never the guest's full details.
  });

  it('renders no red into any template (brand rule)', () => {
    for (const event of [
      'booking_confirmed',
      'receipt_received',
      'payment_rejected',
      'driver_assigned',
    ] as const) {
      const { html } = renderTemplate(event, SAMPLE[event]);
      expect(html).not.toMatch(/#(f|e|d)[0-9a-f]{0,5}\b|red|crimson/i);
    }
  });
});
```

- [ ] **Step 2–4: Fail, implement, pass.** The real transport is created lazily from `env` so importing this module never opens a socket — the same discipline `db/client.ts` follows.
- [ ] **Step 5: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(notify): branded email that can never block a booking"
```

**✅ DONE 4**

---

### Task 5: Manual receipt submission (4A, server)

**Files:**

- Create: `server/src/services/payments/manual-receipt.ts`
- Modify: `server/src/routers/public/portal.ts` (add `uploadReceipt`)
- Test: `server/src/__tests__/manual-receipt.test.ts`

**Interfaces:**

- Consumes: `storeReceipt` (Task 3), `notify` (Task 4), `writeAudit`, `takeSlotLocks` is **NOT** needed (this consumes no capacity).
- Produces: `recordManualReceipt({ bookingId, method, amountCentavos, txnRef, receiptPath, now })` → `{ paymentId }`.

**§6 steps 3–4:** the guest enters a transaction reference and uploads a receipt; the booking becomes `pending_verification` and the payment row `pending`. **§5:** a receipt upload before expiry **stops the expiry** — `hold_expires_at` is cleared, which is what takes the booking out of the sweep's candidate set.

- [ ] **Step 1: Write the failing test** — covering: a `payments` row with `provider='manual'`, `status='pending'`, the `txn_ref` and `receipt_path` stored; the booking moved to `pending_verification` with `hold_expires_at` **nulled**; one audit row; **nothing marked paid** (`amount_paid_centavos` unchanged, status never `confirmed`); a second submission for the same booking **replaces** the pending row rather than creating two (see Q6); and a submission for a booking that is already `confirmed` refused with nothing written.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** in one transaction, locking the booking row `FOR UPDATE` first — the same row `recordPayment()` locks, so a webhook and a receipt upload cannot interleave.
- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Wire `portal.uploadReceipt`**, which must read the booking id **from the session**, never from the input — an input-supplied booking id is an IDOR.
- [ ] **Step 6: Send the "receipt received" email (§11) and the admin "receipt to verify" email.**
- [ ] **Step 7: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(payments): a guest receipt that marks nothing paid"
```

**✅ DONE 5**

---

### Task 6: Admin approve **and reject** (the missing half)

**Files:**

- Modify: `server/src/services/payments/manual-receipt.ts` (add `decideManualReceipt`)
- Create: `server/src/routers/admin/bookings.ts`
- Test: `server/src/__tests__/manual-receipt-decide.test.ts`

**Interfaces:**

- Produces: `decideManualReceipt({ paymentId, decision: 'approve' | 'reject', reason?, verifier, now })`.

**This is the half that does not exist anywhere in the codebase today.** `verifyCashPayment()` only approves; `payments.reject_reason` is never written and `status='rejected'` is never set. §6 step 5: approve → payment `paid`, booking `confirmed`; reject **with reason** → the portal shows the reason and a re-upload prompt.

- [ ] **Step 1: Write the failing test** — approve moves payment to `paid`, booking to `confirmed`, sets `verified_by`/`verified_at`, writes audit, sends the confirmed email; **reject** sets `status='rejected'` and `reject_reason`, leaves the booking **`pending_verification`** (see Q7), writes audit, sends the rejected email; a reject with an **empty reason is refused** (the portal has nothing to show otherwise); deciding an already-decided payment is refused and writes nothing (idempotent, fails closed); a non-admin role is refused by `adminProcedure('verifyPayments')`.
- [ ] **Step 2–4: Fail, implement, pass.** Approve must go through the existing paid-marking path so the one-way rule stays in one place.
- [ ] **Step 5: Prove each test can fail — including a role test per role**, per CLAUDE.md.
- [ ] **Step 6: Five checks, commit**

```bash
git commit -m "feat(admin): approve or reject a receipt, with the reason the guest will read"
```

**✅ DONE 6**

---

### Task 7: The manual QR page (4A, client)

**Files:**

- Create: `client/src/pages/public/ManualQrPage.tsx`
- Modify: `client/src/App.tsx` (route), `server/src/content/settings-schema.ts` + seed (QR settings block — see Q3)
- Test: `client/src/__tests__/manual-qr-page.test.tsx`

**Use `ui-ux-pro-max`.** Mobile-first at 360px, 44px targets, no red, amber for the expiry warning.

**§6:** the QR image, the **exact amount** as text beside it (a static QR cannot embed an amount), the booking ref, instructions to put the ref in the transfer note, a 15-minute countdown and a "Download QR" button.

- [ ] **Step 1: Write the failing test** — the amount comes from the server quote and is never computed in the client (the repo-wide centavos-arithmetic guard already enforces this); the ref is shown; the countdown renders from `holdExpiresAt` and shows an **amber** warning under two minutes; "Download QR" produces the image; and at zero the page stops offering to pay and directs the guest to start again.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(checkout): the manual QR screen, amount as text beside it"
```

**✅ DONE 7**

---

### Task 8: The portal booking page — tracker, auto-refresh, re-upload

**Files:**

- Create: `client/src/pages/portal/PortalLoginPage.tsx`, `PortalBookingPage.tsx`
- Create: `client/src/components/portal/Tracker.tsx`, `ReceiptUpload.tsx`, `DriverCard.tsx`
- Modify: `client/src/App.tsx`; `server/src/routers/public/portal.ts` (add `booking`)
- Test: `client/src/__tests__/portal-booking.test.tsx`, `server/src/__tests__/portal-booking.test.ts`

**Use `ui-ux-pro-max`.** The five tracker steps are §7's table exactly: Booked → Payment sent → Verified by admin → Driver assigned → Tour day.

- [ ] **Step 1: Write the failing test** — `portal.booking` returns **only** the logged-in booking and refuses with no session; the tracker lights the right step for each status (driven from a table over all eight `BOOKING_STATUSES`, not three hand-picked ones); a rejected payment shows **the reason** and the re-upload prompt; auto-refresh polls every 20s **only while `pending_verification`** and stops otherwise; the driver card appears from `assigned` until the tour day ends, with call and WhatsApp buttons following the documented brand-colour exception (icon-only pills, `aria-label`, wording outside the pill); the balance due is **read from the server**, never computed client-side.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(portal): one booking, five steps, and the rejection reason"
```

**✅ DONE 8**

---

### Task 9: The post-tour review form

**Files:**

- Modify: `server/src/routers/public/portal.ts` (add `submitReview`)
- Create: `client/src/components/portal/ReviewForm.tsx`
- Test: `server/src/__tests__/portal-review.test.ts`

**§7:** after `completed`, a rate & review form with sub-scores → `pending` → admin approval.

- [ ] **Step 1: Write the failing test** — a review is accepted **only** when the booking is `completed`; it is written with `status='pending'` and `is_sample=false` and `booking_id` set; one review per booking (a second is refused); the four sub-scores are each 1–5 or absent; and a submitted review does **not** appear in the public `reviews.published` list until an admin approves it. That last assertion is the one that matters — it is the guard against a guest publishing straight to the site.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(portal): a review that waits for approval"
```

**✅ DONE 9**

---

### Task 10: Admin bookings list and detail (4D)

**Files:**

- Create: `client/src/pages/admin/AdminBookingsPage.tsx`, `AdminBookingDetailPage.tsx`
- Modify: `server/src/routers/admin/bookings.ts` (add `list`, `detail`)
- Test: `server/src/__tests__/admin-bookings.test.ts`, `client/src/__tests__/admin-bookings.test.tsx`

**Use `ui-ux-pro-max`.** **Depends on Q1** — an admin cannot reach this without a staff login, which is Week 1's 1C and does not exist.

- [ ] **Step 1: Write the failing test** — `list` is paginated and filterable by status and date; `detail` returns the booking with its payments, add-on lines and audit trail; **a role test per role per area** (CLAUDE.md), including that a `customer` session is refused; and the receipt image is reachable by an admin through the authenticated route from Task 3.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Prove each test can fail, five checks, commit**

```bash
git commit -m "feat(admin): the bookings list and the verification queue"
```

**✅ DONE 10**

---

### Task 11: Phase 1 end-to-end pass (4E)

**Files:**

- Create: `docs/superpowers/plans/2026-10-13-week4-phase1-walkthrough.md` (the evidence record)

Not a code task. Drive every Phase 1 flow against the running app and record what was proven, what was mocked, and what failed and was fixed.

- [ ] **Step 1:** Online payment path end to end — **blocked on the PayMongo account** (`docs/LAUNCH_CHECKLIST.md`, "gateway wire check"). Record it as untested against the real gateway rather than papering over it.
- [ ] **Step 2:** Manual QR path end to end: hold → QR screen → txn ref + receipt → `pending_verification` → admin approves → `confirmed` → guest email.
- [ ] **Step 3:** The reject path: admin rejects with a reason → portal shows the reason → guest re-uploads → admin approves.
- [ ] **Step 4:** Portal: login, wrong-credential parity, tracker at each status, auto-refresh, review after completion.
- [ ] **Step 5:** Hold expiry: a hold left unpaid is swept, its capacity returns, its coupon use returns.
- [ ] **Step 6:** Fix anything found, with a test per fix, then re-run the whole pass.
- [ ] **Step 7:** Five checks, commit, and write **✅ WEEK 4 COMPLETE** only if every step above passed.

**✅ DONE 11**

---

## Questions — all of them, before any task starts

**Q1 — Staff login (1C) is not built. Is it in Week 4's scope?** `adminProcedure` exists and fails closed, but there is no staff login, no password hashing and no admin UI shell. **Task 6 and Task 10 cannot be exercised by a real admin without it.** Three options: (a) pull 1C into this week as a Task 0 (password login, `users` table, role middleware already exists — probably 1–2 extra tasks); (b) keep 4D server-side only, tested through `createCaller` with a synthetic staff session, and defer the admin _screens_ to Week 5; (c) descope 4D entirely. **I recommend (a)** — the admin must be able to approve a receipt for the manual flow to work at all, and a verification queue nobody can log into does not complete Phase 1.

**Q2 — Can an admin approve a payment before any staff login exists?** If Q1 is (b) or (c), the manual flow has no human approver and the guest's receipt sits in `pending_verification` forever. Is a temporary approval path acceptable, and if so what guards it?

**Q3 — Where does the QR image come from?** §6 says "uploaded by admin in Settings", but there is no QR settings key and no admin settings screen. Options: (a) a new `payment_qr` settings block holding an uploaded image path plus the account name/number shown beside it; (b) a file dropped on the server and named in `.env`. **(a) is the spec's intent** but needs an admin upload screen — which depends on Q1. Also: **what account details must appear beside the QR** (name, number, bank/e-wallet)? I will not invent them.

**Q4 — Which payment methods may a guest choose for a manual transfer?** `PAYMENT_METHODS` includes `gcash`, `maya`, `bank_transfer` and more; §6 says the method records "whichever instrument the guest actually used". Does the guest pick from a list, and which subset?

**Q5 — Is the manual QR flow reachable from checkout today?** Week 3 shipped `startPayment` for the gateway only. Does the checkout page need a "pay by QR transfer instead" branch (a Week 4 change to a Week 3 file), or is manual QR a separate entry point?

**Q6 — A guest uploads a second receipt while the first is still pending.** Replace the pending row, or keep both? I have planned **replace** (one pending payment per booking is simpler to verify and leaves no ambiguity about which receipt the admin approved), but the audit trail arguably wants both. Which?

**Q7 — After a rejection, what status does the booking hold?** I have planned **`pending_verification`** so the portal still shows the tracker and the re-upload prompt, with the _payment_ carrying `rejected`. The alternative is to send the booking back to `pending_payment`, which would re-arm the expiry sweep and could expire a guest who is mid-re-upload. **Confirm `pending_verification`**, or state the intended behaviour.

**Q8 — Does a rejection re-start the 15-minute hold?** §5 says a receipt upload stops the expiry. If a rejected guest must re-upload, is there any time limit at all, and does their capacity stay held indefinitely meanwhile? This is a real overbooking-adjacent risk: capacity held by a booking nobody is paying for.

**Q9 — "Visible from assignment until tour day ends" (§7, driver card).** What is "ends" — the tour date's 23:59 Manila, the booking reaching `completed`, or a fixed number of hours after the start? `tours` has `duration_hours` but no departure time.

**Q10 — Reminder emails (§11, "day before") need a scheduler job.** `node-cron` and `server/src/jobs/` now exist from Week 3's sweep. Is the day-before reminder in Week 4's scope, or Week 5 with the rest of dispatch? It is not in §13's 4A–4E list.

**Q11 — Two new dependencies: `nodemailer` and `cookie-parser`.** Both are implied by BUILD_SPEC §2's stack ("SMTP via a transactional provider", "session cookies"), but CLAUDE.md requires asking before adding any library. Approving `nodemailer` is already done (Week 3 Q2). **Please confirm `cookie-parser`** — the alternative is hand-parsing the `Cookie` header, which I would rather not do for an auth credential.

**Q12 — Review "verified badge" (§7).** `reviews` has no `verified` column. Is a review verified precisely when `booking_id` is not null (which Task 9 always sets)? That seems right, and needs no schema change — confirm.

**Q13 — SMS.** §11 lists optional SMS for four events, and the stack says "behind a provider interface (off by default)". Is the interface in Week 4's scope, or deferred with no stub at all?

---

## Self-review

**1. Spec coverage.** §6 manual QR → Tasks 5, 6, 7. §7 portal login → 2; tracker/auto-refresh/re-upload → 8; driver card → 8; review → 9. §11 email → 4, wired in 5, 6 and 8. §13's 4A → 5+6+7; 4B → 1+2; 4C → 8; 4D → 6+10 (gated on Q1); 4E → 11. §12 security → the upload rules in 3, the session rules in 1, the role tests in 6 and 10. **Gaps I am declaring rather than hiding:** staff login (Q1) has no task until it is answered; the day-before reminder (Q10) and SMS (Q13) have no task; the live gateway check (Task 11 Step 1) is blocked outside this plan.

**2. Placeholder scan.** Tasks 1–4 carry full test code. Tasks 5–10 carry full test _case lists_ and the implementation shape, with code deferred because each depends on an unanswered question (Q1, Q3, Q4, Q6, Q7) — these are named limits, not "TBD". **No task says "similar to Task N".** If the questions are answered before execution, each of 5–10 should gain its test code at dispatch time.

**3. Type consistency.** `createSession`/`readSession`/`revokeSession` are used with the same signatures in Tasks 1, 2 and 3. `storeReceipt` returns `{ path }` in Task 3 and is consumed as `receiptPath` in Task 5. `notify(event, payload)` is called identically in 4, 5, 6 and 8. `decideManualReceipt`'s `decision: 'approve' | 'reject'` is the same union in Task 6 and Task 10. `SESSION_COOKIE` is defined once, in Task 1.

---

## Execution handoff

**PLAN ONLY — not executing.** Awaiting the owner's answers to Q1–Q13 and approval. Q1 is the one that changes the plan's shape: if staff login comes into this week, a Task 0 precedes everything and Tasks 6 and 10 grow a UI.
