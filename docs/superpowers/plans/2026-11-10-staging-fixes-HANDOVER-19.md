# Staging Fixes (HANDOVER-19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks 1 and 10–13 touch the auth/session/rate-limit surface and MUST each get a dedicated Opus reviewer, per the owner's own instruction — do not let the same agent that implemented a task review it.** Tasks 10–13 also depend on Task 1 landing first (Turnstile passes the client's real IP to Cloudflare, which is only correct once trust proxy is fixed) — execute in task-number order. Every other task may use the default reviewer. Only ONE implementer works at a time; do not parallelize tasks against this plan.

**Goal:** Fix the staging admin-session bug (trust proxy behind nginx) and apply seven owner-decided guest-copy/visibility corrections for the transfers-first launch, without touching money, auth internals beyond the one documented change, or the schema.

**Architecture:** Nine independent, bite-sized tasks. Task 1 is the security/infra fix (Express `trust proxy`, gated by a new `TRUST_PROXY` env var, exactly one hop). Tasks 2–3 extend the existing `show_tours` visibility gate (Task T15/BUG-122's pattern) to packages, server and client. Tasks 4–8 are small, independent guest-copy/content corrections. Task 9 closes the batch (five checks, `HANDOVER-19`, final report).

**Tech Stack:** Express + tRPC (server), React + TS + Vite (client), Vitest, Drizzle/MySQL (read-only here — no schema change).

**Spec:** The controller prompt pasted into this session (owner decisions 2026-11-10, "Staging fixes: admin session behind nginx + transfers-only content"). No separate spec doc exists; this plan **is** the spec's execution record. `CLAUDE.md` (this repo's root) governs everything not explicitly overridden by the owner decisions.

## Global Constraints

- **Ports:** client dev server 5180, server 3100 — never 5173 or 3000. Do not start or stop either dev server.
- **No red anywhere in the UI.** Warnings amber/orange, errors dark blue/grey (`#334155`).
- **Package manager:** pnpm only. No npm/yarn lockfiles.
- **Line endings:** LF (`.gitattributes` already pins this) — do not relax it.
- **Money:** integers in centavos; the server computes all money. Not touched by this plan.
- **DO NOT** push. **DO NOT** use `/loop` or schedule wakeups. **DO NOT** deploy or touch the VPS.
- **DO NOT** weaken auth, cookie flags (`secure`/`httpOnly`/`sameSite`), the CSRF origin check, or any rate limit. `trust proxy` must be set to exactly `1` (one hop), **never** `true`.
- **DO NOT** change money, holds, locks, roles, or the schema.
- **DO NOT** add dependencies. **DO NOT** print or commit `.env` values.
- **Verify before any commit claim — five checks, in this order:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Never report work as done on an unrun command.
- **Every new test must be proven able to fail** (break the code, watch it go red, restore). Security controls must fail closed, with a test for the failure path.
- **Formatting changes live in their own commit**, separate from the feature diff.
- **Commit messages:** end with the attribution line this session's system reminder specifies. Report commits as `hash - short human label`.
- **Settings rows are insert-only in `db:seed` (`seedBase`)** — changing a default in `server/src/db/seed-data.ts` does **not** retroactively update an already-seeded database (local dev `rg_travel`, or staging). Any task that changes seeded guest copy must say so plainly in its own report, and the final report (Task 9) must give the owner the exact replacement text for any row that needs a manual Admin → Settings edit on an already-seeded database.
- **Unrelated bugs:** if you find one outside the current task, do not fix it — name it in the final report and keep going, unless it blocks the current task.

---

## Task 1: `trust proxy`, gated by `TRUST_PROXY`, exactly one hop (Decision 1)

**This is a required launch item regardless of the staging symptom.** `docs/LAUNCH_CHECKLIST.md` already demanded `trust proxy` be set before any real traffic, and the owner's Decision 1 makes it explicit — do this task whether or not it turns out to be the full explanation of the staging bug.

**Working theory of the staging symptom — unverified, say so in the report.** `server/src/app.ts` never calls `app.set('trust proxy', ...)`. Behind nginx (TLS terminates at nginx, proxies to `127.0.0.1:3100`), every request's socket address is nginx's own loopback address, so every one of this app's per-IP rate limiters collapses onto one shared counter. On staging this COULD mean ordinary admin traffic exhausts the generic 300-per-15-minutes `/trpc` backstop mounted in `app.ts`, reading as 429s — "could not load" / "could not confirm your session" / bounced to `/admin/login`.

**But note what Task 1's own research already found and must not be dropped:** staging runs `SITE_ENV=development`, and `setSessionCookie` sets `secure: env.SITE_ENV === 'production'` — so the admin session cookie is NOT secure-flagged on staging today, which already rules out the owner's OWN stated hypothesis ("secure cookies aren't set/accepted"). The rate-limit theory above is a _replacement_ hypothesis, not yet a measured one. **The one fact that discriminates between them is the HTTP status code of the failing `staffAuth.me` request on staging**: 429 supports the rate-limit theory; 401 means trust proxy is unrelated to the symptom and the real cause is still live after this fix deploys. Implement this task regardless (it is Decision 1, independent of the diagnosis) — but Task 9's final report MUST flag this as unverified and ask the owner for that status code (DevTools Network tab on the failing `/trpc/staffAuth.me` call, or the nginx/PM2 access log) rather than claiming the staging bug is fixed outright.

**Files:**

- Modify: `server/src/env.ts` (new `TRUST_PROXY` env key)
- Modify: `server/src/app.ts` (new `trustProxy` parameter on `createApp`)
- Modify: `server/src/index.ts` (pass `env.TRUST_PROXY === '1'` through)
- Modify: `.env.example` (document the new key)
- Modify: `docs/LAUNCH_CHECKLIST.md` (point the existing trust-proxy item at the new mechanism and test)
- Test: `server/src/__tests__/trust-proxy.test.ts` (new)

**Interfaces:**

- Consumes: `createDriverLoginLimiter()` and `DRIVER_LOGIN_IP_MAX` from `server/src/middleware/rate-limit.ts` (already exported, unchanged).
- Produces: `createApp(allowedOrigin?, clientDistDir?, siteEnv?, trustProxy?: boolean = false)` — a 4th, optional, default-`false` parameter. Every existing caller that stops at 3 arguments is unaffected.

- [ ] **Step 1: Add the env var**

In `server/src/env.ts`, add to the schema (placed right after `APP_ORIGIN`, which it is deployment-adjacent to):

```ts
  /*
   * Exactly ONE proxy hop (owner decision 2026-11-10, staging-fixes batch,
   * Decision 1). The app sits behind nginx in every real deployment
   * (`docs/LAUNCH_CHECKLIST.md`), which terminates TLS and proxies to
   * 127.0.0.1 — without telling Express to trust that one hop, `req.ip` is
   * nginx's own address for every request, and every per-IP rate limiter in
   * `middleware/rate-limit.ts` collapses onto one shared counter (measured
   * on staging as the admin-session bug this decision fixes).
   *
   * No default, optional, exact string '1' required — mirroring
   * `ALLOW_DEMO_SEED`'s shape: unset means "do not trust any proxy", which
   * is the correct, safe default for local dev (no proxy in front of
   * `pnpm dev`) and for any environment nobody has deliberately configured.
   * `app.set('trust proxy', 1)` — never `true`, which would trust an
   * attacker-controlled X-Forwarded-For chain of any length.
   */
  TRUST_PROXY: z.string().optional(),
```

- [ ] **Step 2: Add the parameter to `createApp`**

In `server/src/app.ts`, extend the JSDoc and signature:

```ts
/**
 * @param allowedOrigin  CORS origin for the browser client.
 * @param clientDistDir  Pass `client/dist` (see html.ts's CLIENT_DIST_DIR) to
 *   serve the built SPA with SEO meta injected — production only. Omit it and
 *   the app is API-only, which is what every test and the dev server want:
 *   in development Vite serves the HTML and injects the same meta itself
 *   (D6), and there is no `dist` to read.
 * @param siteEnv  Deploy environment for the crawl directives (task 4.3).
 *   Defaults to `'development'`, which is the FAIL-CLOSED value: robots.txt
 *   disallows everything and every response carries `X-Robots-Tag: noindex`.
 *   Only `'production'` can produce an indexable response, and only then with
 *   `settings.content_unverified` cleared. Passed in rather than read from
 *   ./env for the reason given above DEFAULT_ALLOWED_ORIGIN; src/index.ts
 *   supplies `env.SITE_ENV`.
 * @param trustProxy  Whether to trust exactly ONE proxy hop in front of this
 *   process (owner decision 2026-11-10, Decision 1; `env.TRUST_PROXY === '1'`
 *   in src/index.ts). Defaults to `false`, which is what every test in this
 *   repo wants: supertest talks to the app directly, with no proxy in front
 *   of it, so trusting a hop that does not exist would let a test's own
 *   `X-Forwarded-For` header spoof `req.ip` for free. `app.set('trust proxy',
 *   1)` — ONE hop, never `true` (which trusts an arbitrarily long, caller-
 *   supplied X-Forwarded-For chain) — is what makes every per-IP rate limiter
 *   below key on nginx's own `X-Forwarded-For`, rather than on nginx's own
 *   loopback address shared by every visitor.
 */
export function createApp(
  allowedOrigin: string = DEFAULT_ALLOWED_ORIGIN,
  clientDistDir?: string,
  siteEnv: SiteEnv = 'development',
  trustProxy: boolean = false,
) {
  const app = express();

  // Owner decision 2026-11-10, Decision 1. MUST be set before anything below
  // reads `req.ip` — every limiter in this file does, via express-rate-limit's
  // default key generator. Exactly one hop: `1`, never `true`.
  if (trustProxy) {
    app.set('trust proxy', 1);
  }

  // Pinned to the known client origin, not `origin: true` (which reflects
```

(The rest of the function body is unchanged — only the two new lines above `app.use(cors(...))` and the signature/JSDoc change.)

- [ ] **Step 3: Wire it in `index.ts`**

In `server/src/index.ts`, change the `createApp` call:

```ts
createApp(env.PUBLIC_BASE_URL, clientDistDir, env.SITE_ENV, env.TRUST_PROXY === '1').listen(
  env.PORT,
  () => {
    console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
  },
);
```

- [ ] **Step 4: Write the failing tests**

Create `server/src/__tests__/trust-proxy.test.ts`:

```ts
/**
 * Owner decision 2026-11-10 (staging fixes), Decision 1: exactly ONE trusted
 * proxy hop, gated by `TRUST_PROXY`, default OFF. Fixes the staging bug
 * where every per-IP rate limiter collapsed onto nginx's own loopback
 * address (see `app.ts`'s own note on `trustProxy` and
 * `docs/LAUNCH_CHECKLIST.md`).
 *
 * Four properties, each proven both ways (on fixes it / off leaves the prior
 * behaviour untouched):
 *  1. Rate-limit key: two distinct X-Forwarded-For client IPs get separate
 *     budgets when trustProxy is on, and share ONE budget when it is off.
 *  2. Cookie security: the `secure` flag is driven by SITE_ENV alone (see
 *     `middleware/session-cookie.ts`), NOT by trustProxy — proven unaffected
 *     in both directions, because wiring it to trust proxy would be a new,
 *     undocumented behaviour this task must not introduce.
 *  3. End-to-end: with trustProxy on and a forwarded HTTPS request, login
 *     still sets a working session cookie and the very next request
 *     authenticates with it — proving the proxy-trust change does not
 *     collaterally break the existing login chain.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../app';
import { env } from '../env';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { DRIVER_LOGIN_IP_MAX } from '../middleware/rate-limit';
import { hashPassword } from '../services/password';
import { describeWithDb } from './helpers/db';

const ORIGIN = 'http://localhost:5180';
const PASSWORD = 'a-strong-owner-password';
const suffix = `${Math.floor(Math.random() * 1e9)}`;
const EMAIL = `trustproxy_${suffix}@example.test`;
let ownerId: number;

// One fixture account for the whole file — nothing below deletes it
// mid-file, so there is exactly one setup and one teardown.
beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);
  const [owner] = await getDb()
    .insert(users)
    .values({ name: 'Trust Proxy Fixture', email: EMAIL, passwordHash: hash, role: 'owner' });
  ownerId = owner.insertId;
}, 60_000);

afterAll(async () => {
  await getDb().delete(users).where(eq(users.id, ownerId));
});

/**
 * `middleware/session-cookie.ts` reads `env.SITE_ENV` directly at call time
 * — it is NOT the `siteEnv` parameter `createApp` takes (that only reaches
 * `robotsHeader`/`sitemap.ts`; `app.ts` deliberately never imports `./env`
 * itself). Under this package's `vitest.config.ts`, `SITE_ENV` is never set,
 * so it resolves to the schema default (`'development'`) regardless of what
 * is passed to `createApp` — the `secure` flag would be `false` in every
 * test in this file without this helper. Same mutate-and-restore pattern
 * `origin-check.test.ts`'s "does NOT allow the dev server in production"
 * test already uses.
 */
function withProductionSiteEnv<T>(run: () => Promise<T>): Promise<T> {
  const original = env.SITE_ENV;
  (env as { SITE_ENV: string }).SITE_ENV = 'production';
  return run().finally(() => {
    (env as { SITE_ENV: string }).SITE_ENV = original;
  });
}

function driverLoginAttempt(app: Parameters<typeof request>[0], xff: string) {
  return request(app)
    .post('/trpc/driver.login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', xff)
    .send({ code: '__trust_proxy_test__', pin: '000000' });
}

describeWithDb('trust proxy — rate-limit key', () => {
  it('two distinct X-Forwarded-For IPs get SEPARATE budgets when TRUST_PROXY is on', async () => {
    const app = createApp(ORIGIN, undefined, 'development', true);

    // IP #1 spends its whole budget and is refused on the extra attempt.
    let limitedForFirstIp = 0;
    for (let i = 0; i < DRIVER_LOGIN_IP_MAX + 1; i += 1) {
      const res = await driverLoginAttempt(app, '203.0.113.21');
      if (res.status === 429) limitedForFirstIp += 1;
    }
    expect(limitedForFirstIp).toBeGreaterThan(0);

    // IP #2 has never been seen before — its own, untouched budget.
    const res = await driverLoginAttempt(app, '203.0.113.22');
    expect(res.status).not.toBe(429);
  });

  it('without TRUST_PROXY (default), two distinct X-Forwarded-For IPs share ONE budget — unchanged from before this task', async () => {
    const app = createApp(ORIGIN); // trustProxy defaults to false

    // The limiter cannot see the X-Forwarded-For header at all without
    // trust proxy, so every request — regardless of the header — is keyed
    // on supertest's own loopback socket address. Spend the whole budget
    // under IP #1's header...
    for (let i = 0; i < DRIVER_LOGIN_IP_MAX; i += 1) {
      const res = await driverLoginAttempt(app, '203.0.113.21');
      expect(res.status).not.toBe(429);
    }
    // ...and IP #2's very next request is refused, proving they shared one
    // counter the whole time.
    const res = await driverLoginAttempt(app, '203.0.113.22');
    expect(res.status).toBe(429);
  });
});

describeWithDb('trust proxy — cookie security is unaffected either way', () => {
  it('TRUST_PROXY=1 + X-Forwarded-Proto: https — login still sets the secure cookie and the follow-up request authenticates', async () => {
    await withProductionSiteEnv(async () => {
      const app = createApp(ORIGIN, undefined, 'production', true);

      const login = await request(app)
        .post('/trpc/staffAuth.login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.30')
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);

      const setCookie = login.headers['set-cookie'] as unknown as string[];
      expect(setCookie.some((c) => /Secure/i.test(c))).toBe(true);

      const me = await request(app)
        .get('/trpc/staffAuth.me')
        .set('Cookie', setCookie)
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.30');
      expect(me.status).toBe(200);
      expect(me.body.result.data.role).toBe('owner');
    });
  });

  it('without TRUST_PROXY, the secure-cookie flag is STILL driven by SITE_ENV alone — proves this task did not wire it to proxy trust', async () => {
    await withProductionSiteEnv(async () => {
      const app = createApp(ORIGIN, undefined, 'production', false);

      const login = await request(app)
        .post('/trpc/staffAuth.login')
        .set('Origin', ORIGIN)
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);

      const setCookie = login.headers['set-cookie'] as unknown as string[];
      // Unchanged from before this task: secure is `SITE_ENV === 'production'`,
      // full stop, with or without trustProxy — see
      // middleware/session-cookie.ts, which never reads createApp's
      // `trustProxy` parameter at all.
      expect(setCookie.some((c) => /Secure/i.test(c))).toBe(true);
    });
  });
});
```

- [ ] **Step 5: Run the tests and watch them fail**

Run: `pnpm --filter @rg/server test -- trust-proxy`
Expected: FAIL — `createApp` does not yet accept a 4th parameter (TypeScript error) and `trust proxy` is never set, so the "separate budgets" test cannot pass.

- [ ] **Step 6: Make them pass**

Confirm Steps 1–3 are done, then re-run. Expected: PASS, all 4 tests.

- [ ] **Step 7: Prove the tests can fail (mutation check)**

1. Temporarily change `if (trustProxy)` to `if (false)` in `app.ts` — the "separate budgets when TRUST_PROXY is on" test must go red (both IPs now share one counter). Restore.
2. Temporarily change the same line to `if (true)` (ignore the parameter) — the "share ONE budget... unchanged" test must go red (the two IPs would no longer collapse). Restore.
3. Record both results in the task's own notes (the plan does not require a separate file — a one-line note in the commit message or the final report is enough), then restore the real conditional.

- [ ] **Step 8: Document the env var and the launch checklist**

In `.env.example`, add directly after the `APP_ORIGIN` block:

```
# Exactly ONE trusted proxy hop (owner decision 2026-11-10). The deployed app
# sits behind nginx — see docs/LAUNCH_CHECKLIST.md. Leave blank for local dev
# (no proxy in front of `pnpm dev`). On the server, set to exactly 1.
# dev: leave blank. production (behind nginx): TRUST_PROXY=1
# NOTE: env.ts parses process.env once at import time — setting this in the
# server's .env requires a PM2 restart (not just a reload) to take effect.
TRUST_PROXY=
```

In `docs/LAUNCH_CHECKLIST.md`, find the existing "Express `trust proxy` is set" bullet (in the "Deployment requirements — not optional" section) and replace its body with:

```
- [ ] **`TRUST_PROXY=1` is set** in the deployed `.env`, because the app sits behind nginx (see the
      `proxy_pass` blocks above). `app.ts` reads this into `createApp(..., trustProxy)`, which calls
      `app.set('trust proxy', 1)` — exactly one hop, never `true`. The rate limiter keys on request
      IP. Without it, Express reads nginx's own address for every request, so every visitor
      collectively shares one IP's worth of rate limit — one abusive visitor exhausts the
      login/coupon/review limiter for everyone else behind the same proxy, not just themselves, and
      (measured on staging, 2026-11-10) the generic `/trpc` backstop can exhaust fast enough that
      ordinary admin traffic starts seeing 429s, which the admin UI shows as "Could not confirm your
      session". **This is measured, not only reasoned:** `server/src/__tests__/trust-proxy.test.ts`
      sends attempts from two distinct `X-Forwarded-For` addresses through a real `createApp()` and
      passes with `TRUST_PROXY` on; with it left unset, the exact same two addresses collapse onto
      one shared budget.
```

- [ ] **Step 9: Five checks, commit**

Run the five checks (lint, typecheck, test, format:check, build). Commit with message `fix(server): trust exactly one nginx hop, behind TRUST_PROXY (staging fixes, Decision 1)`.

---

## Task 2: `show_tours` gates packages too, server-side (Decision 2, server half)

**Why.** `server/src/routers/public/packages.ts`'s `list`/`bySlug` have no `show_tours` check at all — unlike `tours.ts`, which T15/BUG-122 already gated. `server/src/seo/resolvers.ts`'s `resolvePackage` and `server/src/seo/sitemap.ts`'s package-URL block carry an explicit comment saying packages are "a different product" and NOT gated by this flag — that was the owner's ruling at the time (Week 7 plan, Task 3) and is now **explicitly superseded** by today's Decision 2 ("packages follow the same show_tours gate as tours (server-side too, same pattern as T15/BUG-122)").

**Files:**

- Modify: `server/src/routers/public/packages.ts`
- Modify: `server/src/seo/resolvers.ts` (`resolvePackage`)
- Modify: `server/src/seo/sitemap.ts` (`collectSitemapUrls`)
- Test: `server/src/__tests__/public-queries.test.ts` (new `it` alongside the existing tours gate test)
- Test: `server/src/__tests__/seo-resolvers.test.ts` (update the existing "Packages are NOT gated" assertion)
- Test: `server/src/__tests__/sitemap-robots.test.ts` (update the existing "package URLs stay" assertion)

**Interfaces:**

- Consumes: `readShowTours()` from `server/src/content/settings.ts` (already exported, used by `tours.ts`).
- Produces: no new exports — `packagesRouter.list`/`bySlug` and `resolvePackage` keep their existing return shapes, only the gated branch is new.

- [ ] **Step 1: Write the failing test — `packages.list`/`bySlug` gate**

In `server/src/__tests__/public-queries.test.ts`, add directly after the existing `'tours.list and tours.bySlug are gated by show_tours'` test (which ends around line 192):

```ts
it('packages.list and packages.bySlug are gated by show_tours, same pattern as tours (Decision 2)', async () => {
  const db = getDb();
  const packageSlug = 'cebu-highlights-3d2n';

  // The premise, asserted rather than assumed.
  const before = await caller.packages.list();
  expect(before.length).toBe(3);
  await expect(caller.packages.bySlug({ slug: packageSlug })).resolves.toBeDefined();

  await db.update(settingsTable).set({ value: false }).where(eq(settingsTable.key, 'show_tours'));

  try {
    expect(await caller.packages.list()).toEqual([]);
    await expect(caller.packages.bySlug({ slug: packageSlug })).rejects.toThrow(/NOT_FOUND/);
    // Byte-identical to an unknown slug's refusal — same BUG-122 shape tours.bySlug already has.
    const hidden = await caller.packages
      .bySlug({ slug: packageSlug })
      .catch((e: unknown) => (e as Error).message);
    const unknown = await caller.packages
      .bySlug({ slug: '__no_such_package__' })
      .catch((e: unknown) => (e as Error).message);
    expect(hidden).toBe(`NOT_FOUND: no package found for slug "${packageSlug}"`);
    expect(unknown).toBe(`NOT_FOUND: no package found for slug "__no_such_package__"`);
  } finally {
    const { resetTestDb } = await import('./helpers/test-db');
    await resetTestDb();
  }

  // Baseline restored — packages are visible again.
  expect((await caller.packages.list()).length).toBe(3);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- public-queries`
Expected: FAIL — `packages.list` still returns 3 rows and `packages.bySlug` still resolves while `show_tours` is `false`.

- [ ] **Step 3: Implement the gate in `packages.ts`**

```ts
import { packagesBySlugInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import { readShowTours } from '../../content/settings';
import { getDb } from '../../db/client';
import { packages } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';
```

(add the `readShowTours` import, same relative path `tours.ts` uses)

```ts
export const packagesRouter = router({
  list: publicProcedure.query(async (): Promise<PackageListItem[]> => {
    // The `show_tours` gate (owner decision 2026-11-10, Decision 2) —
    // packages now follow the exact same rule as tours.list (T15/BUG-122):
    // an empty catalog, not an error, checked before any package query.
    if (!(await readShowTours())) return [];
    const db = getDb();
    const rows = await db
      .select()
      .from(packages)
      .where(eq(packages.isActive, true))
      .orderBy(asc(packages.sortOrder), asc(packages.id));
    // ... (unchanged below)
```

```ts
  bySlug: publicProcedure
    .input(packagesBySlugInput)
    .query(async ({ input }): Promise<PackageListItem> => {
      // The `show_tours` gate (Decision 2). The SAME message, byte for
      // byte, the inactive-row branch below throws — a hidden package and a
      // slug naming nothing must be indistinguishable (BUG-122's rule,
      // applied here for the first time).
      if (!(await readShowTours())) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `NOT_FOUND: no package found for slug "${input.slug}"`,
        });
      }
      const db = getDb();
      const [row] = await db.select().from(packages).where(eq(packages.slug, input.slug));
      // ... (unchanged below)
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @rg/server test -- public-queries`
Expected: PASS.

- [ ] **Step 5: Fix the SEO resolver — write the failing test first**

In `server/src/__tests__/seo-resolvers.test.ts`, change the existing test (around line 112–139) — replace the two lines:

```ts
// Packages are a different product and are NOT gated by this flag.
expect((await resolvePage('/packages/cebu-highlights-3d2n')).status).toBe(200);
```

with:

```ts
// Decision 2 (2026-11-10) supersedes the earlier "packages are a
// different product" ruling: packages now follow the same gate.
const pkg = await resolvePage('/packages/cebu-highlights-3d2n');
expect(pkg.status).toBe(404);
expect(pkg.robots).toBe('noindex,nofollow');
```

Also update the doc comment above the test (currently "The `show_tours` gate on the two tour routes") to say "the two tour routes and the package detail route".

Run: `pnpm --filter @rg/server test -- seo-resolvers`
Expected: FAIL — `resolvePackage` still answers 200.

- [ ] **Step 6: Implement the gate in `resolvers.ts`**

In `resolvePackage` (around line 687):

```ts
const resolvePackage: Resolver = async (params) => {
  const slug = params.slug ?? '';
  // The `show_tours` gate (owner decision 2026-11-10, Decision 2) —
  // supersedes the earlier ruling that packages are a separate product.
  // Same shape as resolveTour: a hidden package is indistinguishable from
  // one that does not exist.
  if (!(await readShowTours())) return notFoundMeta(`/packages/${slug}`);
  const [pkg, site] = await Promise.all([loadPackageSeo(slug), readSiteBlocks()]);
  if (!pkg) return notFoundMeta(`/packages/${slug}`);
  // ... (unchanged below)
```

(`readShowTours` is already imported in this file — `resolveToursIndex`/`resolveTour` use it.)

Run: `pnpm --filter @rg/server test -- seo-resolvers`
Expected: PASS.

- [ ] **Step 7: Fix the sitemap — write the failing test first**

In `server/src/__tests__/sitemap-robots.test.ts`, inside the `'omits /tours and every tour detail URL while show_tours is off'` test (around line 262), change:

```ts
expect(locs).toContain(absoluteUrl('/packages/cebu-highlights-3d2n'));
```

to:

```ts
// Decision 2 (2026-11-10) supersedes the earlier "this flag is only
// about tours" comment — package detail URLs are dropped too, same as
// tour detail URLs just above.
expect(locs).not.toContain(absoluteUrl('/packages/cebu-highlights-3d2n'));
expect(locs.filter((loc) => loc.includes('/packages/'))).toEqual([]);
```

Also change the surrounding comment (currently "Everything else stays: home, the four legal pages, and every package detail URL — this flag is only about tours.") to drop the package clause, and rename the test to `'omits /tours, every tour detail URL, and every package detail URL while show_tours is off'`.

Run: `pnpm --filter @rg/server test -- sitemap-robots`
Expected: FAIL — package URLs are still present.

- [ ] **Step 8: Implement the gate in `sitemap.ts`**

Replace the unconditional block (around line 208–213):

```ts
// Package detail pages render now too (Task 3, Week 7 plan) and
// `resolvePackage` answers `index,follow` — same reasoning as the tour
// half above, shipped in the same commit as that page and that robots
// line's deletion. Not gated by `show_tours`: packages are a separate
// product and this flag is explicitly only about tours.
urls.push(...buildPackageDetailUrls(rows));
```

with:

```ts
// Package detail pages (Task 3, Week 7 plan). Owner decision 2026-11-10,
// Decision 2, supersedes the earlier "packages are a separate product"
// ruling: `resolvePackage` now answers `notFoundMeta` while `show_tours`
// is off, exactly like the tour half above, so the sitemap must agree —
// this file's own absolute rule (see the function's doc comment).
if (showTours) {
  urls.push(...buildPackageDetailUrls(rows));
}
```

Also update the function's own doc comment (lines ~171–176) to say the flag now drops tour halves AND package detail URLs.

- [ ] **Step 9: Run it and watch it pass**

Run: `pnpm --filter @rg/server test -- sitemap-robots`
Expected: PASS.

- [ ] **Step 10: Prove the tests can fail**

Temporarily revert Step 3's `if (!(await readShowTours())) return [];` to nothing (delete the gate line) in `packages.ts` — the Task 2 public-queries test must go red. Restore. Do the same for the `resolvePackage` and `sitemap.ts` gates, one at a time, confirming each respective test goes red, then restore all three.

- [ ] **Step 11: Five checks, commit**

Commit message: `fix(packages): show_tours gates packages too, server-side (Decision 2)`.

---

## Task 3: `show_tours` gates packages too, client-side (Decision 2, client half)

**Why.** `client/src/lib/site.ts`'s `visibleNav()` filters out `/tours` while `show_tours` is off but leaves `/#packages` in `SITE.nav` unconditionally, so the "Packages" link stays in the desktop nav, mobile nav, and footer. `client/src/pages/public/HomePage.tsx` mounts `<PackagesSection />` unconditionally (unlike `<CatalogPreview />`/`<MostVisited />`, which are already gated). `PackageDetailPage.tsx` needs no change — it already falls through to `QueryBoundary`'s generic error state for any `NOT_FOUND`, which Task 2's server gate now produces while `show_tours` is off (same as `TourDetailPage` relies on the server gate for `/tours/:slug`).

**Files:**

- Modify: `client/src/lib/site.ts` (`visibleNav`)
- Modify: `client/src/pages/public/HomePage.tsx`
- Test: `client/src/__tests__/layout.test.tsx` (extend the existing "nav hides Tours" describe block)
- Test: `client/src/__tests__/home.test.tsx` (extend the existing "tours hidden" / "tours shown" describe blocks)

**Interfaces:**

- Consumes: `visibleNav(showTours: boolean)` (existing signature, unchanged) and `settings.showTours` (existing field).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests — nav**

In `client/src/__tests__/layout.test.tsx`, inside `describe('nav hides "Tours" while show_tours is off, in all three places', ...)`, extend both existing `it`s to also assert Packages:

In the `'shows Tours in desktop nav, mobile nav, and the footer when showTours is true'` test, after each existing `expect(...tours...)` block, add the matching Packages assertion, e.g. right after the desktop-nav Tours check:

```ts
expect(within(desktopNav).getByRole('link', { name: /^packages$/i })).toBeInTheDocument();
```

(and the equivalent for `mobileNav` and `footerNav`).

In the `'hides Tours from all three while leaving Transfers in all three, when showTours is false'` test, after each existing `queryByRole('link', { name: /^tours$/i })` assertion, add:

```ts
expect(within(desktopNav).queryByRole('link', { name: /^packages$/i })).toBeNull();
```

(and the equivalent for `mobileNav` and `footerNav`). Also rename the `describe` block to `'nav hides "Tours" and "Packages" while show_tours is off, in all three places'`.

In `client/src/__tests__/home.test.tsx`, inside `describe('home page — tours hidden (show_tours gate, Task T16)', ...)`'s single `it`, add after the existing `#places` assertion:

```ts
expect(screen.queryByRole('heading', { name: /^packages$/i })).not.toBeInTheDocument();
expect(document.querySelector('#packages')).toBeNull();
```

In the `'home page — tours shown (regression, Task T16)'` describe block's `it`, add:

```ts
expect(await screen.findByRole('heading', { name: /^packages$/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/client test -- layout.test home.test`
Expected: FAIL — the Packages link and section are still present/absent incorrectly.

- [ ] **Step 3: Implement — `visibleNav`**

In `client/src/lib/site.ts`:

```ts
/**
 * `SITE.nav`, minus "Tours" and "Packages" while `show_tours` is off
 * (transfers-launch plan Task T16; extended to Packages by owner decision
 * 2026-11-10, Decision 2 — packages now follow the same gate as tours,
 * server-side AND here). One shared filter rather than three independent
 * `SITE.nav.map(...)` calls each re-deriving the same rule — `SiteHeader.tsx`
 * (desktop nav and mobile nav) and `SiteFooter.tsx` (footer nav) all read
 * this instead.
 */
export function visibleNav(showTours: boolean) {
  const hiddenWhileToursOff = new Set(['/tours', '/#packages']);
  return SITE.nav.filter((item) => !hiddenWhileToursOff.has(item.href) || showTours);
}
```

- [ ] **Step 4: Implement — `HomePage.tsx`**

Change:

```tsx
<PackagesSection />
```

to:

```tsx
{
  showTours && <PackagesSection />;
}
```

And update the component's own doc comment (the one explaining why `CatalogPreview`/`MostVisited` are conditional) to also name `PackagesSection` — e.g. append: "Decision 2 (2026-11-10) extends this to `PackagesSection`: packages are hidden the same way, for the same reason — a mounted section whose only links lead into a hidden product line is worse than no section."

- [ ] **Step 5: Run them and watch them pass**

Run: `pnpm --filter @rg/client test -- layout.test home.test`
Expected: PASS.

- [ ] **Step 6: Prove the tests can fail**

Temporarily revert the `visibleNav` change (filter only `/tours`) — the new Packages-nav assertions must go red. Restore. Temporarily revert `HomePage.tsx`'s `{showTours && ...}` back to unconditional — the new Packages-section assertions must go red. Restore.

- [ ] **Step 7: Five checks, commit**

Commit message: `fix(packages): hide "Packages" from nav/footer/home while show_tours is off (Decision 2)`.

---

## Task 4: Transfer-first guest copy — "Meet your guide" / "Licensed guide" / site default title (Decision 3)

**Why.** Three literal strings name tours/guides in copy that renders regardless of `show_tours`: the home page's "How it works" step 4 title (`seed-data.ts`'s `how_it_works[3].title`, rendered unconditionally by `HowItWorks.tsx`), a package highlight ("Licensed guide" in `SEED_PACKAGES`), and the site-wide default `<title>`/description (`SEED_SETTINGS.site_seo`, used for every route whose resolver falls back to it, most visibly `/`). None of these are gated by `show_tours`, so they are guest-visible today on staging.

**Note for the final report (Task 9):** `settings` rows are inserted only-if-missing by `db:seed` (`seedBase`) — this change affects a **fresh** seed only. The already-seeded local `rg_travel` database and staging's database keep their old `how_it_works` and `site_seo` content until an admin edits them by hand (both blocks are editable via Admin → Settings → Content, per `client/src/components/admin/settings-blocks.ts`). Carry the exact new copy below into that report so the owner can paste it in directly. `SEED_PACKAGES` is dev/demo content (`seedDemo`, gated off in production) and will not reach staging at all via reseed; note it as a code-level fix only.

**Files:**

- Modify: `server/src/db/seed-data.ts`
- Modify: `client/src/__tests__/helpers/fixtures.ts` (`SETTINGS_FIXTURE.siteSeo` — keep the client fixture's copy from drifting out of sync with the real seed default; no test currently asserts this literal string, so this is a consistency edit, not a required one)
- Test: `server/src/__tests__/seo-resolvers.test.ts`
- Test: `server/src/__tests__/seo-html.test.ts`
- Test: `server/src/__tests__/seo-render.test.ts`

**Interfaces:** none — content-only change, no exported shape changes.

- [ ] **Step 1: Write the failing tests**

In `server/src/__tests__/seo-resolvers.test.ts`, change (around line 77):

```ts
expect(meta.title).toBe('TravelSugbo — Cebu Day Tours & Packages');
expect(meta.description).toContain('Book Cebu day tours');
```

to:

```ts
expect(meta.title).toBe('TravelSugbo — Cebu Airport & Island Transfers');
expect(meta.description).toContain('private airport and island transfers');
```

In `server/src/__tests__/seo-html.test.ts`, change the `SHELL` constant's placeholder `<title>` (line 20) — this is the pre-injection shell, so it must stay DIFFERENT from the resolved title (the test's whole point is proving injection overwrites it); confirm the test's actual assertion further down checks the INJECTED title matches the real resolved value, and update that assertion (not the shell) to the new string. Read the rest of the test first to find the exact assertion line before editing.

In `server/src/__tests__/seo-render.test.ts`, same approach — find the assertion that checks the final injected `<title>` against `'TravelSugbo — Cebu Day Tours &amp; Packages'` and update it to `'TravelSugbo — Cebu Airport &amp; Island Transfers'`.

Run: `pnpm --filter @rg/server test -- seo-resolvers seo-html seo-render`
Expected: FAIL (old copy still seeded).

- [ ] **Step 2: Implement — `site_seo`**

In `server/src/db/seed-data.ts`, change:

```ts
  site_seo: {
    title: 'TravelSugbo — Cebu Day Tours & Packages',
    description:
      'Book Cebu day tours and multi-day packages direct with TravelSugbo. Private vans, licensed drivers, pay a 30% deposit online.',
    ogImage: null,
  },
```

to:

```ts
  // Transfer-first (owner decision 2026-11-10, Decision 3): while
  // show_tours is off, transfers are the lead and only visible product, so
  // the site-wide default title/description must not name tours or
  // packages. This is a `settings` row, inserted only if missing by
  // `seedBase` — an already-seeded database keeps its old value until an
  // admin edits it (Admin -> Settings -> Content).
  site_seo: {
    title: 'TravelSugbo — Cebu Airport & Island Transfers',
    description:
      'Book private airport and island transfers in Cebu direct with TravelSugbo. Private vans, licensed drivers. Reserve with a 30% deposit online.',
    ogImage: null,
  },
```

- [ ] **Step 3: Implement — "Meet your guide"**

In the `how_it_works` array, change step 4:

```ts
    {
      step: 4,
      title: 'Meet your guide',
      body: 'Your driver arrives at your pickup point. Settle any balance on the day.',
    },
```

to:

```ts
    {
      step: 4,
      title: 'Meet your driver',
      body: 'Your driver arrives at your pickup point. Settle any balance on the day.',
    },
```

- [ ] **Step 4: Implement — "Licensed guide"**

In `SEED_PACKAGES`, change:

```ts
    highlights: ['Private van throughout', 'Licensed guide', '2 nights accommodation'],
```

to:

```ts
    highlights: ['Private van throughout', 'Licensed driver', '2 nights accommodation'],
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- seo-resolvers seo-html seo-render`
Expected: PASS.

- [ ] **Step 6: Prove the tests can fail**

Temporarily revert the `site_seo.title` string back to the old value — the `seo-resolvers` test must go red. Restore.

- [ ] **Step 7: Update the client fixture for consistency**

In `client/src/__tests__/helpers/fixtures.ts`, update `SETTINGS_FIXTURE.siteSeo` to the same new title/description from Step 2, so the fixture does not drift from the real seed default. Run `pnpm --filter @rg/client test` afterward to confirm nothing asserted the old literal (expected: no change in pass/fail counts, since no test was found to depend on it).

- [ ] **Step 8: Five checks, commit**

Commit message: `fix(content): transfer-first default title/description, driver wording for "guide" (Decision 3)`.

---

## Task 5: Hide "DOT accredited" without a real number (Decision 4)

**Why.** `TrustBar.tsx` and `HeroSection.tsx` each gate the "DOT accredited" badge purely on `settings.trust.dotAccredited` (an admin-set boolean, seeded `true`), never checking whether `settings.permits.dot` (the actual accreditation number) is non-null. Today `permits.dot` is seeded `null` ("— pending —" everywhere else on the site), so this is an unverified claim rendering as fact.

**Files:**

- Modify: `client/src/components/home/TrustBar.tsx`
- Modify: `client/src/components/home/HeroSection.tsx`
- Test: `client/src/__tests__/hero-trust.test.tsx`

**Interfaces:**

- Consumes: `settings.get`'s existing `permits: { dot: string | null, ... }` field (already on the payload — `SettingsPayload`, `server/src/content/settings.ts`), sibling to `trust`.

- [ ] **Step 1: Write the failing tests**

In `client/src/__tests__/hero-trust.test.tsx`, add two new tests (one per component). First, check the file's existing `mockTrpc({ 'settings.get': ... })` pattern and `SETTINGS_FIXTURE` import, then add:

```ts
import { SETTINGS_FIXTURE } from './helpers/fixtures';

describe('DOT accredited badge requires a real permit number (Decision 4)', () => {
  it('TrustBar hides "DOT accredited" when dotAccredited is true but permits.dot is null', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        trust: { ...SETTINGS_FIXTURE.trust, dotAccredited: true },
        permits: { ...SETTINGS_FIXTURE.permits, dot: null },
      },
    });
    renderTrustBar();
    await screen.findByText(/deposit to reserve/i); // wait for the real content to resolve
    expect(screen.queryByText(/dot accredited/i)).not.toBeInTheDocument();
  });

  it('TrustBar shows "DOT accredited" when dotAccredited is true AND permits.dot is set', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        trust: { ...SETTINGS_FIXTURE.trust, dotAccredited: true },
        permits: { ...SETTINGS_FIXTURE.permits, dot: 'DOT-R-IATO-12345' },
      },
    });
    renderTrustBar();
    expect(await screen.findByText(/dot accredited/i)).toBeInTheDocument();
  });

  it('HeroSection hides "DOT accredited" when permits.dot is null, even with dotAccredited true', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        trust: { ...SETTINGS_FIXTURE.trust, dotAccredited: true },
        permits: { ...SETTINGS_FIXTURE.permits, dot: null },
      },
      'destinations.list': DESTINATIONS_FIXTURE,
      'transferRoutes.list': [],
    });
    renderHero();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/^dot accredited$/i)).not.toBeInTheDocument();
  });
});
```

(Adjust the exact `mockTrpc` keys/fixtures to match what `renderHero`/`renderTrustBar` in this file already require — read the file's existing `beforeEach`/other tests for the full mock shape before finalizing; the pattern above is the minimum each test needs beyond what those helpers already set up.)

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/client test -- hero-trust`
Expected: FAIL — both components currently show the badge whenever `dotAccredited` is true, regardless of `permits.dot`.

- [ ] **Step 3: Implement — `TrustBar.tsx`**

Change the render-prop destructure and the gate:

```tsx
          {({ trust, permits }) => {
            // ...
            const items: { key: string; icon: LucideIcon; label: ReactNode }[] = [];
            // Decision 4 (2026-11-10): never claim DOT accreditation without
            // a real permit number — `trust.dotAccredited` alone is an
            // admin toggle, not proof; `permits.dot` is the actual number,
            // "— pending —" (null) until one exists.
            if (trust.dotAccredited && permits.dot !== null) {
              items.push({ key: 'dot', icon: BadgeCheck, label: 'DOT accredited operator' });
            }
```

- [ ] **Step 4: Implement — `HeroSection.tsx`**

Change the render-prop destructure and the gate:

```tsx
            {({ trust, hero, permits }) => {
              // ...
              if (trust.dotAccredited && permits.dot !== null) {
                trustItems.push(<li key="dot">DOT accredited</li>);
              }
```

- [ ] **Step 5: Run them and watch them pass**

Run: `pnpm --filter @rg/client test -- hero-trust`
Expected: PASS.

- [ ] **Step 6: Prove the tests can fail**

Temporarily revert one gate back to `if (trust.dotAccredited)` — its own new tests must go red. Restore both.

- [ ] **Step 7: Five checks, commit**

Commit message: `fix(trust): never claim "DOT accredited" without a real permit number (Decision 4)`.

---

## Task 6: Remove the visible placeholder subtitle (Decision 5)

**Why.** `WhyBookDirect.tsx` hardcodes `subtitle="Editable from admin settings once the site is live."` on its `SectionHeading` — an internal authoring note, never meant for a guest, shown on every load of the home page's "Six reasons to skip the booking platforms" section.

**Files:**

- Modify: `client/src/components/home/WhyBookDirect.tsx`

**Interfaces:** none — `SectionHeading`'s `subtitle` prop is already optional (`subtitle?: string`); omitting it is a no-op for every other caller.

- [ ] **Step 1: Confirm no test depends on the current text**

Run: `pnpm --filter @rg/client test -- content-blocks` (and skim `home.test.tsx` for `WhyBookDirect` mentions) to confirm nothing asserts `"Editable from admin settings"` or the subtitle's presence. (Already confirmed during planning — no match — but re-confirm before editing, since this is the one step that could silently break something if skipped.)

- [ ] **Step 2: Remove the prop**

In `client/src/components/home/WhyBookDirect.tsx`, change:

```tsx
<SectionHeading
  eyebrow="Book direct"
  title="Six reasons to skip the booking platforms"
  subtitle="Editable from admin settings once the site is live."
/>
```

to:

```tsx
<SectionHeading eyebrow="Book direct" title="Six reasons to skip the booking platforms" />
```

- [ ] **Step 3: Confirm the subtitle paragraph no longer renders**

Run: `pnpm --filter @rg/client test -- content-blocks home` and manually confirm (via the component's own markup, `{subtitle && <p>...}`) that omitting the prop means the `<p>` is not rendered — no new test is needed to "prove this can fail" since `SectionHeading.tsx`'s own existing conditional (`{subtitle && ...}`) is what guarantees it, and that line is untouched by this change.

- [ ] **Step 4: Five checks, commit**

Commit message: `fix(content): drop the internal placeholder subtitle from the public home page (Decision 5)`.

---

## Task 7: Friendly duration wording — "about 45 min" / "about 3 hr" / "about 3 hr 30 min" (Decision 6)

**Why.** `RoutePicker.tsx` (the guest-facing transfer route picker) renders raw minutes as `` `~${route.estimatedDurationMinutes} min` `` — e.g. "~180 min" for the three-hour Oslob route. The admin screen's own `durationWords()` helper (`AdminTransferRoutesPage.tsx`, private to that file) already converts minutes to "X hr Y min" for staff, but has no "about" prefix (appropriate for an exact admin-entered value) and is not exported for guest use.

**Files:**

- Create: `client/src/lib/duration-words.ts`
- Modify: `client/src/components/transfer/RoutePicker.tsx`
- Modify: `client/src/pages/admin/AdminTransferRoutesPage.tsx` (reuse the shared split instead of a second private copy)
- Test: `client/src/__tests__/duration-words.test.ts` (new)
- Test: `client/src/__tests__/route-picker.test.tsx`

**Interfaces:**

- Produces: `hoursAndMinutesSplit(minutes: number): { hours: number; mins: number }` (the shared hour/minute split) and `friendlyDuration(minutes: number): string` — `"about 45 min"` (< 60), `"about 3 hr"` (exact hour), `"about 3 hr 30 min"` (hour + minutes), built on top of the split.

- [ ] **Step 1: Write the failing unit test**

Create `client/src/__tests__/duration-words.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { friendlyDuration } from '@/lib/duration-words';

/**
 * Owner decision 2026-11-10 (Decision 6): a transfer's estimated duration is
 * an estimate, and the copy must say so — "about 45 min", not "~45 min" or a
 * bare number. Three shapes, matching the owner's own three examples.
 */
describe('friendlyDuration', () => {
  it('formats under an hour as "about N min"', () => {
    expect(friendlyDuration(45)).toBe('about 45 min');
  });

  it('formats an exact number of hours as "about N hr"', () => {
    expect(friendlyDuration(180)).toBe('about 3 hr');
  });

  it('formats hours plus minutes as "about N hr M min"', () => {
    expect(friendlyDuration(210)).toBe('about 3 hr 30 min');
  });

  it('formats a single minute without a plural mismatch in the surrounding words', () => {
    expect(friendlyDuration(1)).toBe('about 1 min');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- duration-words`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `client/src/lib/duration-words.ts`:

```ts
/**
 * The hour/minute split shared by the admin screen (which shows an admin-
 * entered value exactly, e.g. "3 hr 30 min") and the guest-facing estimate
 * below (which adds "about " — owner decision 2026-11-10, Decision 6).
 * Pulled out so there is exactly one place that divides by 60, rather than
 * two private copies (`AdminTransferRoutesPage.tsx` used to carry its own).
 */
export function hoursAndMinutesSplit(minutes: number): { hours: number; mins: number } {
  return { hours: Math.floor(minutes / 60), mins: minutes % 60 };
}

/** "3 hr 30 min" / "3 hr" / "45 min" — no "about": the admin-entered value, exact. */
export function exactDuration(minutes: number): string {
  const { hours, mins } = hoursAndMinutesSplit(minutes);
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/**
 * A transfer's `estimatedDurationMinutes` is exactly that — an estimate, not
 * a timetable — so the GUEST-facing copy says so: "about 45 min" / "about 3
 * hr" / "about 3 hr 30 min", never a bare number or a "~" shorthand.
 */
export function friendlyDuration(minutes: number): string {
  const { hours, mins } = hoursAndMinutesSplit(minutes);
  if (hours === 0) return `about ${mins} min`;
  if (mins === 0) return `about ${hours} hr`;
  return `about ${hours} hr ${mins} min`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @rg/client test -- duration-words`
Expected: PASS.

- [ ] **Step 4b: De-duplicate — point the admin page at the shared split**

In `client/src/pages/admin/AdminTransferRoutesPage.tsx`, delete the private `durationWords()` function and its call sites, and import `exactDuration` from `@/lib/duration-words` in its place (same output — "45 min" / "3 hr" / "3 hr 30 min" — so no test in `admin-transfer-routes-page.test.tsx` should need a text change). Run `pnpm --filter @rg/client test -- admin-transfer-routes-page` to confirm no regression.

- [ ] **Step 5: Write the failing `RoutePicker` test**

In `client/src/__tests__/route-picker.test.tsx`, add (using the file's own existing `MACTAN` and `OSLOB` fixtures, which are already 45 and 180 minutes respectively — the owner's own two examples):

```ts
describe('duration is shown as a friendly estimate (Decision 6)', () => {
  it('shows "about 45 min" and "about 3 hr" for the two seeded durations', () => {
    render(
      <RoutePicker routes={[MACTAN, OSLOB]} value={null} onChange={() => {}} />,
    );
    expect(screen.getByText('about 45 min')).toBeInTheDocument();
    expect(screen.getByText('about 3 hr')).toBeInTheDocument();
    expect(screen.queryByText(/~/)).not.toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @rg/client test -- route-picker.test`
Expected: FAIL — the component still renders `~45 min` / `~180 min`.

- [ ] **Step 6: Implement in `RoutePicker.tsx`**

Add the import:

```tsx
import { friendlyDuration } from '@/lib/duration-words';
```

Change:

```tsx
{
  `~${route.estimatedDurationMinutes} min`;
}
```

to:

```tsx
{
  friendlyDuration(route.estimatedDurationMinutes);
}
```

- [ ] **Step 7: Run it and watch it pass**

Run: `pnpm --filter @rg/client test -- route-picker.test`
Expected: PASS.

- [ ] **Step 8: Prove the tests can fail**

Temporarily change `friendlyDuration`'s hour-only branch to omit the `about ` prefix — the unit test must go red. Restore. Temporarily revert `RoutePicker.tsx`'s line to the old `` `~${...} min` `` — the new RoutePicker test must go red. Restore.

- [ ] **Step 9: Five checks, commit**

Commit message: `feat(transfer): friendly "about N hr M min" duration wording for guests (Decision 6)`.

---

## Task 8: Generic coupon placeholder (Decision 7)

**Why.** `CouponField.tsx`'s input placeholder is `"e.g. RGTOURS10"` — a tour-branded example code, inappropriate while the product is transfers-first.

**Files:**

- Modify: `client/src/components/checkout/CouponField.tsx`

**Interfaces:** none.

- [ ] **Step 1: Confirm no test depends on the current placeholder text**

Confirmed during planning (grepped `client/src/__tests__` for `RGTOURS10` and the literal placeholder text — the only hit is an unrelated coupon-code fixture value in `helpers/fixtures.ts`, used by a different test as an example redeemed code, not as the placeholder hint). Re-confirm with a quick grep before editing.

- [ ] **Step 2: Implement**

In `client/src/components/checkout/CouponField.tsx`, change:

```tsx
placeholder = 'e.g. RGTOURS10';
```

to:

```tsx
placeholder = 'e.g. WELCOME10';
```

- [ ] **Step 3: Five checks, commit**

Commit message: `fix(checkout): generic coupon placeholder, not tour-branded (Decision 7)`.

---

## Task 10: Cloudflare Turnstile — shared infrastructure (owner decision 2026-11-10/11)

**Owner instruction, verbatim intent:** Turnstile on five endpoints (staff login, staff forgot-password, the two guest booking holds, the public custom-trip inquiry, driver PIN login). Managed/invisible widget, no npm dependency (script tag only), site key via `VITE_TURNSTILE_SITE_KEY`, secret via `TURNSTILE_SECRET_KEY`, verified server-side before any DB write/lockout/email, fail closed, dev/test use Cloudflare's official test keys, server refuses to start if enabled with a missing secret or site key. **This task (10) is shared plumbing only — no endpoint is wired yet.** Tasks 11–13 wire the five endpoints. **Dedicated Opus reviewer for Tasks 10–13 (auth-adjacent surface), per the owner's instruction.** Do this after Task 1 (trust proxy) — `verifyTurnstile()` passes the client's real IP to Cloudflare as `remoteip`, which is only correct once Task 1 is deployed.

**Why no new rate limiter is needed:** every one of the five target procedures is already rate-limited in `server/src/app.ts`, and Task 10 is implemented so each endpoint's Turnstile check runs _inside_ the gated procedure, before its own logic — so a Turnstile failure is counted by the existing limiter exactly like any other failed call. No new limiter plumbing.

**Files:**

- Create: `server/src/services/turnstile-guard.ts` (pure, dependency-free — the startup check)
- Create: `server/src/services/turnstile.ts` (the real `verifyTurnstile()`, calls Cloudflare)
- Modify: `server/src/env.ts` (new env vars + startup guard call)
- Modify: `.env.example`
- Modify: `docs/LAUNCH_CHECKLIST.md` (new required item)
- Create: `client/src/components/common/TurnstileWidget.tsx`
- Test: `server/src/__tests__/turnstile-guard.test.ts` (new)
- Test: `server/src/__tests__/turnstile.test.ts` (new)

**Interfaces:**

- Produces: `assertTurnstileConfigured(env: { TURNSTILE_ENABLED?: string; TURNSTILE_SECRET_KEY?: string; VITE_TURNSTILE_SITE_KEY?: string }): string | null` (returns a problem message, or `null` if fine).
- Produces: `verifyTurnstile(input: { token: string | undefined; remoteIp: string | undefined }, fetchImpl?: typeof fetch): Promise<boolean>`.
- Produces: `<TurnstileWidget onVerify={(token: string) => void} onError={() => void} />` — a default export, renders nothing when `VITE_TURNSTILE_SITE_KEY` is unset.
- Consumed by Tasks 11–13.

- [ ] **Step 1: Write the failing startup-guard test**

Create `server/src/__tests__/turnstile-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertTurnstileConfigured } from '../services/turnstile-guard';

/**
 * Owner decision 2026-11-10/11, Task 10: the server refuses to boot if
 * Turnstile is switched on without both keys it needs. A pure function,
 * tested directly — mirrors `dev-reset-staff-password.ts`'s `refuseReason`
 * pattern (this repo's own convention for "fail closed at startup" logic:
 * extract a pure function rather than test env.ts's own module-import throw).
 */
describe('assertTurnstileConfigured', () => {
  it('is fine when Turnstile is off, however the keys are set', () => {
    expect(assertTurnstileConfigured({})).toBeNull();
    expect(
      assertTurnstileConfigured({ TURNSTILE_ENABLED: '0', TURNSTILE_SECRET_KEY: undefined }),
    ).toBeNull();
  });

  it('refuses when enabled with no secret key', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }),
    ).toMatch(/TURNSTILE_SECRET_KEY/);
  });

  it('refuses when enabled with no site key', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        TURNSTILE_SECRET_KEY: 'secret',
      }),
    ).toMatch(/VITE_TURNSTILE_SITE_KEY/);
  });

  it('is fine when enabled with both keys present', () => {
    expect(
      assertTurnstileConfigured({
        TURNSTILE_ENABLED: '1',
        TURNSTILE_SECRET_KEY: 'secret',
        VITE_TURNSTILE_SITE_KEY: 'site-key',
      }),
    ).toBeNull();
  });
});
```

Run: `pnpm --filter @rg/server test -- turnstile-guard`
Expected: FAIL — the module does not exist.

- [ ] **Step 2: Implement `turnstile-guard.ts`**

```ts
/**
 * Owner decision 2026-11-10/11, Task 10: the server refuses to boot if
 * Turnstile is switched on (`TURNSTILE_ENABLED=1`) without both keys it
 * needs. Deliberately a PURE function with no import of `./env` — `env.ts`
 * calls this, so this file must not call back into it (that would be
 * circular) and must be trivially unit-testable without booting the real
 * environment (this repo's own convention — see `dev-reset-staff-password.ts`'s
 * `refuseReason`).
 */
export function assertTurnstileConfigured(env: {
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
}): string | null {
  if (env.TURNSTILE_ENABLED !== '1') return null;
  if (!env.TURNSTILE_SECRET_KEY) {
    return 'TURNSTILE_ENABLED=1 but TURNSTILE_SECRET_KEY is missing.';
  }
  if (!env.VITE_TURNSTILE_SITE_KEY) {
    return 'TURNSTILE_ENABLED=1 but VITE_TURNSTILE_SITE_KEY is missing.';
  }
  return null;
}
```

- [ ] **Step 3: Run it and watch it pass**

Run: `pnpm --filter @rg/server test -- turnstile-guard`
Expected: PASS.

- [ ] **Step 4: Wire the env vars and the startup guard into `env.ts`**

Add to the schema (after `ALLOW_DEV_PASSWORD_RESET`):

```ts
  /*
   * Cloudflare Turnstile (owner decision 2026-11-10/11, staging-fixes
   * batch, Task 10). Off by default — unset (or anything but the exact
   * string '1') means every gated endpoint behaves exactly as it did
   * before this task, mirroring ALLOW_DEMO_SEED's shape.
   */
  TURNSTILE_ENABLED: z.string().optional(),
  /** Never sent to the client, never logged. Required when enabled. */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  /*
   * Read here ONLY so the server can refuse to boot with it missing while
   * TURNSTILE_ENABLED=1 (see assertTurnstileConfigured below) — the server
   * itself never calls Cloudflare with this value; the widget script on
   * the CLIENT does. VITE_-prefixed so Vite also exposes it to the client
   * bundle at build time; dotenv loads the same root .env for both
   * processes (client/vite.config.ts's `envDir`), so this one key is read
   * by both without being duplicated anywhere.
   */
  VITE_TURNSTILE_SITE_KEY: z.string().optional(),
```

Add the import at the top of `env.ts`:

```ts
import { assertTurnstileConfigured } from './services/turnstile-guard';
```

And after the existing `FORBIDDEN_PORTS` check, before `export const env = parsed.data;`:

```ts
const turnstileProblem = assertTurnstileConfigured(parsed.data);
if (turnstileProblem) {
  throw new Error(turnstileProblem);
}
```

(`TURNSTILE_LIVE_TEST`, added to `.env.example` in Step 10 below, is deliberately NOT added to this schema — it is a test-suite-only flag `turnstile.test.ts` reads straight off `process.env`, never consumed by the running app. `schema` here is a plain `z.object(...)`, not `.strict()`, so `safeParse` simply strips an unrecognized key rather than rejecting it — the same reason this schema has never needed to list every `VITE_*` key the client alone reads.)

- [ ] **Step 5: Write the failing `verifyTurnstile` tests**

Create `server/src/__tests__/turnstile.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../services/turnstile';
import { env } from '../env';

/**
 * `verifyTurnstile()` fails closed. The deterministic branches (off,
 * missing token, non-ok response, success:false, network error) are
 * proven with an INJECTED fetch stub — no real network call, so this suite
 * stays hermetic and fast. A separate real-network test below proves the
 * end-to-end wiring against Cloudflare's own documented test keys.
 */
describe('verifyTurnstile — deterministic branches (stubbed fetch)', () => {
  it('passes with no check at all when Turnstile is off', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = undefined;
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: undefined, remoteIp: undefined }, fetchSpy as never),
      ).resolves.toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  it('refuses a missing token when enabled, with no network call', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: undefined, remoteIp: '203.0.113.1' }, fetchSpy as never),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  /**
   * `assertTurnstileConfigured` is what makes "enabled with no secret"
   * unreachable in a real deploy — but this function must not rely on that
   * being true. Without this explicit check, a missing secret would still
   * happen to refuse (Cloudflare answers `success: false` for an empty
   * `secret` field), making the fail-closed property true by ACCIDENT, not
   * by construction. This test is what pins it as construction: it proves
   * refusal with NO network call, the same way the missing-token test above
   * does, rather than relying on Cloudflare's own error semantics.
   */
  it('refuses (fails closed) when enabled with no secret key configured, with no network call', async () => {
    const originalEnabled = env.TURNSTILE_ENABLED;
    const originalSecret = env.TURNSTILE_SECRET_KEY;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
    const fetchSpy = vi.fn();
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchSpy as never),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
    }
  });

  it('refuses when Cloudflare answers success:false', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    try {
      await expect(
        verifyTurnstile({ token: 'bad-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  it('refuses (fails closed) on a network error', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    const fetchStub = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });

  it('refuses (fails closed) on a non-OK HTTP response', async () => {
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    const fetchStub = vi.fn().mockResolvedValue({ ok: false });
    try {
      await expect(
        verifyTurnstile({ token: 'some-token', remoteIp: undefined }, fetchStub as never),
      ).resolves.toBe(false);
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
  });
});

/**
 * Real network call to Cloudflare's siteverify, using its OFFICIAL,
 * documented testing keys — this is the intended use of those keys, not a
 * workaround. GATED behind `TURNSTILE_LIVE_TEST=1` (NOT a TURNSTILE_ENABLED
 * check — this is a test-suite-hermeticity flag, unrelated to the feature
 * flag) so the default `pnpm test` — check #3 of the five this plan runs
 * after EVERY task, including the 14 after this one — never depends on
 * egress from whatever machine or sandbox runs it. Run manually with
 * `TURNSTILE_LIVE_TEST=1 pnpm --filter @rg/server test -- turnstile.test`
 * at least once per this task (and note the result in the task's own
 * notes) — do not delete this coverage, it is the only test that proves
 * the real HTTP wiring (method, content-type, field names) is correct.
 *
 * Written as a ternary rather than `describe.runIf(...)` — the latter is
 * only available on recent Vitest versions and this plan does not pin one;
 * check `pnpm --filter @rg/server exec vitest --version` if you want to use
 * `.runIf` instead, but the ternary below works on every version.
 */
const RUN_LIVE_TURNSTILE_TEST = process.env.TURNSTILE_LIVE_TEST === '1';
(RUN_LIVE_TURNSTILE_TEST ? describe : describe.skip)(
  'verifyTurnstile — real network call against Cloudflare test keys',
  () => {
    const ALWAYS_PASSES_SECRET = '1x0000000000000000000000000000000AA';
    const ALWAYS_FAILS_SECRET = '2x0000000000000000000000000000000AA';

    it('passes with the always-passes test secret and any non-empty token', async () => {
      const originalEnabled = env.TURNSTILE_ENABLED;
      const originalSecret = env.TURNSTILE_SECRET_KEY;
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = ALWAYS_PASSES_SECRET;
      try {
        await expect(
          verifyTurnstile({ token: 'any-non-empty-value', remoteIp: undefined }),
        ).resolves.toBe(true);
      } finally {
        (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
        (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
      }
    }, 10_000);

    it('refuses with the always-fails test secret', async () => {
      const originalEnabled = env.TURNSTILE_ENABLED;
      const originalSecret = env.TURNSTILE_SECRET_KEY;
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
      (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = ALWAYS_FAILS_SECRET;
      try {
        await expect(
          verifyTurnstile({ token: 'any-non-empty-value', remoteIp: undefined }),
        ).resolves.toBe(false);
      } finally {
        (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = originalEnabled;
        (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = originalSecret;
      }
    }, 10_000);
  },
);
```

Run: `pnpm --filter @rg/server test -- turnstile.test`
Expected: FAIL — the module does not exist.

- [ ] **Step 6: Implement `verifyTurnstile`**

Create `server/src/services/turnstile.ts`:

```ts
/**
 * Verifies a Cloudflare Turnstile response token (owner decision
 * 2026-11-10/11, Task 10). FAILS CLOSED in every direction but one: with
 * Turnstile switched OFF (`env.TURNSTILE_ENABLED !== '1'`), every gated
 * endpoint behaves exactly as it did before this task existed — no check,
 * no network call. Switched ON, a missing token, an unreachable Cloudflare,
 * a timeout, a non-OK HTTP status, or an explicit `success: false` all
 * refuse. A token is single-use by Cloudflare's own design, so there is no
 * local replay cache to maintain here.
 *
 * `fetchImpl` is injectable (defaults to the global `fetch`, available with
 * no dependency since Node 18+) purely so `turnstile.test.ts` can stub the
 * deterministic branches without a real network call — production code
 * never passes it.
 */
import { env } from '../env';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

export interface TurnstileVerifyInput {
  token: string | undefined;
  remoteIp: string | undefined;
}

interface SiteverifyResponse {
  success?: boolean;
}

export async function verifyTurnstile(
  { token, remoteIp }: TurnstileVerifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (env.TURNSTILE_ENABLED !== '1') return true;
  if (!token) return false;
  // Fails closed BY CONSTRUCTION, not by relying on Cloudflare's own
  // "empty secret" error — see turnstile.test.ts's own note on this line.
  if (!env.TURNSTILE_SECRET_KEY) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY ?? '',
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false; // network error, abort/timeout — fail closed
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ONE guest-safe refusal, shared by every gated endpoint that has no
 * pre-existing single-refusal shape of its own to reuse (createHold,
 * createHoldTransfer, the transfer_custom inquiry — see Tasks 12–13).
 * Deliberately generic: it must read the same whether the guest forgot to
 * complete the widget, the widget failed to load, or Cloudflare rejected
 * the token — there is nothing actionable to tell them beyond "try again".
 * Endpoints that already have their own single refusal (staffAuth.login's
 * `refused()`, driver.login's `asTrpcError('wrong_credentials')`,
 * requestPasswordReset's `REQUESTED`) reuse THEIR OWN shape instead, per
 * the owner's "same generic refusal as other failures" instruction.
 */
export function turnstileRefusedError() {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Please complete the verification and try again.',
  });
}
```

(Add `import { TRPCError } from '@trpc/server';` at the top of this file alongside the `env` import.)

- [ ] **Step 7: Run it and watch it pass**

Run: `pnpm --filter @rg/server test -- turnstile.test`
Expected: PASS for the stubbed-fetch block (always runs). The real-network block is skipped by default (`describe.runIf(process.env.TURNSTILE_LIVE_TEST === '1')`) — separately run `TURNSTILE_LIVE_TEST=1 pnpm --filter @rg/server test -- turnstile.test` at least once this task and record the result in the task's own notes; do not skip writing that block just because the default run skips it.

- [ ] **Step 8: Prove the tests can fail**

Temporarily change `if (env.TURNSTILE_ENABLED !== '1') return true;` to `return false;` unconditionally — several tests must go red (the "off" test, both real-network tests). Restore. Temporarily change the `catch { return false; }` to `return true;` — the "network error" and "non-OK response" tests must go red. Restore.

- [ ] **Step 9: Build the client widget**

Create `client/src/components/common/TurnstileWidget.tsx`:

```tsx
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

let scriptLoadPromise: Promise<void> | null = null;

/** Loads the Turnstile script at most once per page load, however many widgets mount. */
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Turnstile script failed to load'));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

/**
 * Cloudflare Turnstile, managed mode (owner decision 2026-11-10/11, Task
 * 10). Renders NOTHING when `VITE_TURNSTILE_SITE_KEY` is not configured —
 * local dev, or Turnstile switched off — so `onVerify` is simply never
 * called, and every gated server procedure treats a missing token exactly
 * like "the feature is off" (`verifyTurnstile()`).
 *
 * A Turnstile token is single-use. Give this component a fresh `key` prop
 * after a failed submit to get a new one — see each wiring site in Tasks
 * 11–13 for the exact pattern (a `turnstileResetKey` state bumped in the
 * mutation's `onError`).
 */
export default function TurnstileWidget({
  onVerify,
  onError,
}: {
  onVerify: (token: string) => void;
  onError?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return;
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          callback: onVerify,
          'error-callback': onError,
          'expired-callback': onError,
        });
      })
      .catch(() => onError?.());
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
    // Mount once per `key` the caller gives this component — see the
    // component's own doc comment on why that is the reset mechanism.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} className="my-2" />;
}
```

- [ ] **Step 10: Document the env vars**

In `.env.example`, add (near the existing `ALLOW_DEV_PASSWORD_RESET` block):

```
# ---------------------------------------------------------------------------
# Cloudflare Turnstile (owner decision 2026-11-10/11) — bot/abuse check on
# staff login, staff forgot-password, the two guest booking holds, the
# custom-trip inquiry, and driver PIN login. Off by default.
#
# dev/test: use Cloudflare's OFFICIAL testing keys (safe to commit — they are
# published by Cloudflare specifically for this purpose, not real secrets):
#   always passes — site 1x00000000000000000000AA / secret 1x0000000000000000000000000000000AA
#   always blocks — site 2x00000000000000000000AB / secret 2x0000000000000000000000000000000AA
# production: real site/secret key pair from the Cloudflare dashboard.
# NOTE: VITE_TURNSTILE_SITE_KEY needs a client REBUILD to take effect (it is
# baked into the bundle at build time); TURNSTILE_ENABLED/TURNSTILE_SECRET_KEY
# need a server PM2 RESTART (env.ts parses process.env once at import time).
TURNSTILE_ENABLED=
TURNSTILE_SECRET_KEY=
VITE_TURNSTILE_SITE_KEY=

# Test-suite-only: set to 1 to run turnstile.test.ts's real-network block
# against Cloudflare's siteverify (uses the official test keys above, not
# this app's own secret). Unrelated to TURNSTILE_ENABLED above — this one
# only affects `pnpm test`, never the running app. Leave blank normally; the
# default test run skips that block so CI/sandboxes never need egress.
TURNSTILE_LIVE_TEST=
```

In `docs/LAUNCH_CHECKLIST.md`'s "Deployment requirements — not optional" section, add a new item after the `TRUST_PROXY` one (from Task 1):

```
- [ ] **If Turnstile is enabled (`TURNSTILE_ENABLED=1`), both `TURNSTILE_SECRET_KEY` and
      `VITE_TURNSTILE_SITE_KEY` are set** — `server/src/env.ts` refuses to boot otherwise
      (`assertTurnstileConfigured`, `server/src/services/turnstile-guard.ts`), so a misconfigured
      deploy fails loudly at startup rather than silently serving a widget that can never verify.
```

- [ ] **Step 11: Five checks, commit**

Commit message: `feat(turnstile): shared infrastructure — env, server verify, client widget (Task 10)`.

---

## Task 11: Turnstile — staff login + forgot-password (auth surface, dedicated Opus review)

**Files:**

- Modify: `server/src/routers/admin/auth.ts` (`login`, `requestPasswordReset`)
- Modify: `client/src/pages/admin/AdminLoginPage.tsx`
- Modify: `client/src/pages/admin/AdminForgotPasswordPage.tsx`
- Test: `server/src/__tests__/admin-auth.test.ts`

- [ ] **Step 1: Write the failing server tests**

In `server/src/__tests__/admin-auth.test.ts`, add inside `describeWithDb('staffAuth.login', ...)`:

```ts
it('refuses with the SAME credential-mismatch message when Turnstile is enabled and the token is missing', async () => {
  const original = env.TURNSTILE_ENABLED;
  (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
  try {
    const { api } = callerWithCookies();
    await expect(
      api.staffAuth.login({ email: EMAIL.owner, password: PASSWORD }),
    ).rejects.toMatchObject({ message: 'That email and password do not match.' });
  } finally {
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
  }
});
```

(Import `env` from `'../env'` at the top of the file if not already imported.) Add a second `describeWithDb('staffAuth.requestPasswordReset — Turnstile', ...)` block near the password-reset tests:

```ts
it('answers the SAME REQUESTED shape, and sends nothing, when Turnstile is enabled and the token is missing', async () => {
  const original = env.TURNSTILE_ENABLED;
  (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
  try {
    const { api } = callerWithCookies();
    const result = await api.staffAuth.requestPasswordReset({ email: EMAIL.owner });
    expect(result.ok).toBe(true); // byte-identical shape to every other refusal this procedure gives
    const [row] = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, ownerId));
    expect(row, 'a token was written despite a missing Turnstile token').toBeUndefined();
  } finally {
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
  }
});
```

(Adjust the exact import of `passwordResetTokens` and any helper this file already uses to read that table — check the file's existing password-reset tests for the established pattern before finalizing.)

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- admin-auth`
Expected: FAIL — both procedures currently succeed/behave as if Turnstile were never consulted (because it is not yet wired in).

- [ ] **Step 3: Wire `login`**

In `server/src/routers/admin/auth.ts`, add the import:

```ts
import { verifyTurnstile } from '../../services/turnstile';
```

Change the input schema to accept the token — find `loginInput` in this file and add `turnstileToken: z.string().optional(),` inside its `z.object({...})`.

Change the mutation body:

```ts
  login: publicProcedure.input(loginInput).mutation(async ({ input, ctx }) => {
    const now = new Date();

    // Cloudflare Turnstile (owner decision 2026-11-10/11, Task 11) — checked
    // BEFORE the password verify, which does a ~128MB scrypt hash
    // (services/password.ts): a Turnstile refusal must cost nothing a real
    // credential check would. Reuses the EXISTING single refusal (`refused()`)
    // rather than a new shape, per the owner's instruction.
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw refused();
    }

    const identity = await verifyStaffPassword(input.email, input.password, now);
    // ... (unchanged below)
```

- [ ] **Step 4: Wire `requestPasswordReset`**

Change the mutation signature to take `ctx` and check Turnstile first:

```ts
  requestPasswordReset: publicProcedure
    .input(requestPasswordResetInputSchema)
    .mutation(async ({ input, ctx }) => {
      const now = new Date();
      const email = input.email;

      // Cloudflare Turnstile (Task 11). Same REQUESTED answer as every other
      // refusal this procedure gives (unknown email, throttled, deactivated)
      // — see this procedure's own note on why a different answer here would
      // be an oracle. Checked first, before the throttle read, so a refused
      // attempt costs nothing.
      if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
        return REQUESTED;
      }

      if (isResetThrottled(email, now)) return REQUESTED;
      // ... (unchanged below)
```

In `shared/src/staff-users.ts:114`, change:

```ts
export const requestPasswordResetInputSchema = z.object({ email: staffEmailSchema }).strict();
```

to:

```ts
export const requestPasswordResetInputSchema = z
  .object({ email: staffEmailSchema, turnstileToken: z.string().optional() })
  .strict();
```

**Check before moving on (this repo has been burned by this exact class of bug — BUG-120):** confirm `turnstileToken` being `.optional()` with no bounds cannot surface a Zod validation message anywhere a guest/staff sees raw text. `AdminLoginPage.tsx`'s one alert renders `firstValidationMessage(login.error) ?? login.error.message` — an optional, unbounded string field has no validation rule that can fail, so there is no message it could ever contribute. State this explicitly as checked in the task's own notes rather than leaving it assumed.

- [ ] **Step 5: Run the server tests and watch them pass**

Run: `pnpm --filter @rg/server test -- admin-auth`
Expected: PASS.

- [ ] **Step 6: Wire the client — `AdminLoginPage.tsx`**

```tsx
import TurnstileWidget from '@/components/common/TurnstileWidget';
```

Add state and reset-on-error:

```tsx
const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
const [turnstileResetKey, setTurnstileResetKey] = useState(0);

const login = trpc.staffAuth.login.useMutation({
  onSuccess: (result) => {
    queryClient.clear();
    navigate(result.mustChangePassword ? '/admin/change-password' : '/admin', { replace: true });
  },
  onError: () => setTurnstileResetKey((k) => k + 1), // tokens are single-use
});

function onSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  login.reset();
  login.mutate({ email: email.trim(), password, turnstileToken });
}
```

Add the widget inside the `<form>`, after the password field and before the submit `<Button>`:

```tsx
<TurnstileWidget key={turnstileResetKey} onVerify={setTurnstileToken} />
```

- [ ] **Step 7: Wire the client — `AdminForgotPasswordPage.tsx`**

Same pattern: import `TurnstileWidget`, add `turnstileToken`/`turnstileResetKey` state, reset on the mutation's `onError`, append `turnstileToken` to the `request.mutate({...})` call (line ~106 per this file's existing shape), and render `<TurnstileWidget key={turnstileResetKey} onVerify={setTurnstileToken} />` inside the form above its submit button.

- [ ] **Step 8: Browser-check both forms**

Start the dev server if not already running (do not start/stop it yourself per this plan's constraints — ask the owner, or skip this step with a note if the dev server isn't available) and confirm: with `TURNSTILE_ENABLED` unset, both forms work exactly as before (no visible widget, no behavior change). This is the one step this plan cannot fully automate — note the result honestly rather than claiming it was checked if it wasn't.

- [ ] **Step 9: Prove the tests can fail**

Temporarily remove the `if (!(await verifyTurnstile(...)))` check from `login` — the new admin-auth test must go red (login succeeds with Turnstile enabled and no token). Restore. Do the same for `requestPasswordReset` — the new test must go red (a token row gets written). Restore.

- [ ] **Step 10: Five checks, commit**

Commit message: `feat(turnstile): staff login and forgot-password (Task 11)`.

---

## Task 12: Turnstile — guest booking holds (tour + transfer)

**Files:**

- Modify: `shared/src/checkout.ts` (`createHoldInput`)
- Modify: `shared/src/transfers-checkout.ts` (`createHoldTransferInput`)
- Modify: `server/src/routers/public/checkout.ts` (`createHold`, `createHoldTransfer`)
- Modify: `client/src/pages/public/CheckoutPage.tsx`
- Modify: `client/src/pages/public/TransferBookingPage.tsx`
- Test: `server/src/__tests__/create-hold.test.ts` and/or `checkout-router.test.ts` (whichever already covers `createHold`/`createHoldTransfer` at the router level — check both before picking one)

- [ ] **Step 1: Write the failing server tests**

Find the existing router-level test(s) for `checkout.createHold` and `checkout.createHoldTransfer` (in `checkout-router.test.ts`, per this file's own BUG-122 tests found during planning) and add, for each:

```ts
it('refuses createHold with a guest-safe message when Turnstile is enabled and the token is missing', async () => {
  const original = env.TURNSTILE_ENABLED;
  (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
  try {
    // Build the SAME valid input an existing passing createHold test in
    // this file uses (tour/fleet/quote setup) — read that test's own setup
    // before writing this one, so the only variable is the missing token.
    await expect(
      caller.checkout.createHold({/* ...valid input, no turnstileToken... */}),
    ).rejects.toMatchObject({ message: 'Please complete the verification and try again.' });
  } finally {
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
  }
});
```

(Mirror the same shape for `createHoldTransfer`, reusing whatever valid-input builder that test file already has for it.) Both tests must also assert **no booking row was written** — reuse this file's existing "nothing written on refusal" assertion pattern if one exists for a different refusal path in the same file.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- checkout-router`
Expected: FAIL.

- [ ] **Step 3: Add the input field**

In `shared/src/checkout.ts`, inside `createHoldInput`'s `.extend({...})` block (before the closing `.strict()`), add:

```ts
    turnstileToken: z.string().optional(),
```

In `shared/src/transfers-checkout.ts`, inside `createHoldTransferInput`'s `.extend({...})` block (before its closing `.strict()` — find it; the block is long, this plan's own research read through `pax`/`luggageCount`/`pickup`/`dropoffAddress` but not to the end), add the same line.

- [ ] **Step 4: Wire the server**

In `server/src/routers/public/checkout.ts`, add the import:

```ts
import { verifyTurnstile, turnstileRefusedError } from '../../services/turnstile';
```

Change both mutations to take `ctx` and check first:

```ts
  createHold: publicProcedure.input(createHoldInput).mutation(async ({ input, ctx }) => {
    // Cloudflare Turnstile (Task 12) — before the service call, so a
    // refusal takes no lock, no capacity read, nothing.
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw turnstileRefusedError();
    }
    try {
      return await createHoldService(input);
    } catch (error) {
      throw translateHoldError(error);
    }
  }),
```

```ts
  createHoldTransfer: publicProcedure.input(createHoldTransferInput).mutation(async ({ input, ctx }) => {
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw turnstileRefusedError();
    }
    try {
      return await createTransferBooking({
        // ... (unchanged below)
```

- [ ] **Step 5: Run the server tests and watch them pass**

Run: `pnpm --filter @rg/server test -- checkout-router`
Expected: PASS.

- [ ] **Step 6: Wire the client — `CheckoutPage.tsx`**

Same recipe as Task 11: import `TurnstileWidget`, add `turnstileToken`/`turnstileResetKey` state, bump the reset key in `createHold`'s `onError`, append `turnstileToken` to the `createHold.mutate({...})` call (this file's existing call site, per this plan's research), and render the widget in the form, near the submit button, before it.

- [ ] **Step 7: Wire the client — `TransferBookingPage.tsx`**

Same recipe for `createHoldTransfer.mutate({...})`.

- [ ] **Step 8: Prove the tests can fail**

Temporarily remove the Turnstile check from `createHold` — its new test must go red (a booking hold is created). Restore, then repeat for `createHoldTransfer`.

- [ ] **Step 9: Five checks, commit**

Commit message: `feat(turnstile): guest booking holds — tour and transfer (Task 12)`.

---

## Task 13: Turnstile — custom-trip inquiry + driver PIN login

**Files:**

- Modify: `shared/src/schemas/public.ts` (`inquiryInput`)
- Modify: `shared/src/driver.ts` (`driverLoginSchema`)
- Modify: `server/src/routers/public/inquiries.ts`
- Modify: `server/src/routers/public/driver-auth.ts`
- Modify: `client/src/components/home/ContactSection.tsx`
- Modify: `client/src/pages/driver/DriverLoginPage.tsx`
- Test: `server/src/__tests__` — whichever file already covers `inquiries.create` and `driver-auth`/`driver-lockout` (check both before picking files; likely `inquiries.create` has its own test file, and driver login tests live in `driver-auth.test.ts` and/or `driver-lockout.test.ts`)

- [ ] **Step 1: Write the failing server tests**

For `inquiries.create`, add a test asserting: with `TURNSTILE_ENABLED=1` and no `turnstileToken`, a `type: 'transfer_custom'` submission is refused with `'Please complete the verification and try again.'` AND no row lands in `inquiries`; a `type: 'contact'` submission (no `transfer_custom`) with the SAME missing token still succeeds — this second half is the one that proves the scope is exactly "the custom trip request form", not every inquiry.

For `driver.login`, add a test asserting: with `TURNSTILE_ENABLED=1` and no `turnstileToken`, the SAME `{code: 'UNAUTHORIZED', message: 'wrong_credentials'}` shape a real wrong-PIN attempt gets (byte-identical, asserted the same way the existing BUG-122-style tests in this codebase compare two refusals directly) — even against a driver's genuinely correct code+PIN.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- inquiries driver-auth`
Expected: FAIL (adjust the test command to this repo's actual file names once confirmed in Step 1).

- [ ] **Step 3: Add the input fields**

In `shared/src/schemas/public.ts`, add `turnstileToken: z.string().optional(),` to `inquiryInput`'s `z.object({...})` (this one is a plain object, not `.strict()`, so the addition needs no reordering).

In `shared/src/driver.ts`, add `turnstileToken: z.string().optional(),` inside `driverLoginSchema`'s `z.object({...})` block, before its `.strict()`.

- [ ] **Step 4: Wire `inquiries.create`**

```ts
import { verifyTurnstile, turnstileRefusedError } from '../../services/turnstile';
```

```ts
  create: publicProcedure.input(inquiryInput).mutation(async ({ input, ctx }) => {
    // Cloudflare Turnstile (Task 13) — ONLY the custom-trip request kind is
    // gated; a contact or package inquiry is unaffected (owner's own
    // wording named "the public custom trip request form", not every
    // inquiry this one procedure happens to share a handler with).
    if (input.type === 'transfer_custom') {
      if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
        throw turnstileRefusedError();
      }
    }
    const db = getDb();
    // ... (unchanged below)
```

- [ ] **Step 5: Wire `driver.login`**

```ts
import { verifyTurnstile } from '../../services/turnstile';
```

```ts
  login: publicProcedure.input(driverLoginSchema).mutation(async ({ input, ctx }) => {
    // Cloudflare Turnstile (Task 13) — reuses the SAME refusal a wrong
    // code/PIN pair gets, so a missing-widget attempt and a wrong-PIN
    // attempt are indistinguishable, per the owner's "same generic refusal"
    // instruction and this endpoint's own existing anti-enumeration shape.
    if (!(await verifyTurnstile({ token: input.turnstileToken, remoteIp: ctx.req.ip }))) {
      throw asTrpcError('wrong_credentials');
    }

    const result = await attemptDriverLogin({
      code: input.code,
      pin: input.pin,
      now: new Date(),
    });
    // ... (unchanged below)
```

**Ordering decision, made here, not deferred to the implementer:** this check runs BEFORE `attemptDriverLogin`, so a Turnstile refusal does **not** count against the per-driver PIN lockout (`services/driver-auth.ts`'s own counter) — only against the per-IP rate limiter already mounted in `app.ts`, which counts every call regardless. This is correct, not merely convenient: CLAUDE.md's §8 backoff counts _wrong PINs_ specifically, and a missing or failed Turnstile token is not a wrong PIN — a driver who typed their code and PIN correctly but whose phone's widget hadn't loaded yet must not lose a lockout tier for it. The reverse would also be a new attack: anyone could strip or replay a stale `turnstileToken` to burn through a driver's five-attempt lockout budget without ever guessing a PIN, which is exactly the kind of counting change CLAUDE.md's §8 section says needs "a new owner decision" to introduce — so this task does not introduce it. Record this reasoning in the task's own notes; it does not need to go back to the owner as an open question.

- [ ] **Step 6: Run the server tests and watch them pass**

Run the same test command from Step 2.
Expected: PASS.

- [ ] **Step 7: Wire the client — `ContactSection.tsx`**

Same recipe as Task 11, scoped to the `transfer_custom` branch only: add `turnstileToken`/`turnstileResetKey` state, bump the reset key in `sendInquiry`'s `onError`, append `turnstileToken` to the `transfer_custom` branch's `sendInquiry.mutate({...})` call only (not the plain `'contact'` branch below it), and render `<TurnstileWidget key={turnstileResetKey} onVerify={setTurnstileToken} />` only while `requestKind === 'transfer_custom'` is selected.

- [ ] **Step 8: Wire the client — `DriverLoginPage.tsx`**

The mutation already has an `onError` (`setRefusal(describeRefusal(error))`) — add the reset-key bump alongside it, not in place of it:

```tsx
const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
const [turnstileResetKey, setTurnstileResetKey] = useState(0);

const login = trpc.driver.login.useMutation({
  onSuccess: () => navigate('/driver', { replace: true }),
  onError: (error) => {
    setRefusal(describeRefusal(error));
    setTurnstileResetKey((k) => k + 1); // tokens are single-use
  },
});

function onSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (!ready) return;
  setRefusal(null);
  login.mutate({ code: code.trim(), pin, turnstileToken });
}
```

Import `TurnstileWidget` and render `<TurnstileWidget key={turnstileResetKey} onVerify={setTurnstileToken} />` inside the `<form>`, below the PIN pad and above the submit button.

- [ ] **Step 9: Prove the tests can fail**

Temporarily remove each new check (inquiries' `type === 'transfer_custom'` branch, driver login's check) one at a time, confirming each one's own new test goes red, then restore both.

- [ ] **Step 10: Five checks, commit**

Commit message: `feat(turnstile): custom-trip inquiry and driver PIN login (Task 13)`.

---

## Task 14: "Powered by First On Page" footer credit

**Files:**

- Modify: `client/src/lib/site.ts` (one constant for label + URL)
- Modify: `client/src/components/layout/SiteFooter.tsx`
- Test: `client/src/__tests__/layout.test.tsx`

**Interfaces:** none new, beyond the one constant.

- [ ] **Step 1: Write the failing tests**

In `client/src/__tests__/layout.test.tsx`, add:

```ts
describe('"Powered by First On Page" footer credit (public footer only)', () => {
  it('renders with the right href, opens in a new tab, and is not followed', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderLayout();
    const credit = await screen.findByRole('link', { name: /first on page/i });
    expect(credit).toHaveAttribute('href', 'https://firstonpage.com');
    expect(credit).toHaveAttribute('target', '_blank');
    expect(credit.getAttribute('rel')).toMatch(/nofollow/);
    expect(credit.getAttribute('rel')).toMatch(/noopener/);
    expect(credit.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('keeps the existing copyright and "Operated by" lines unchanged', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderLayout();
    expect(await screen.findByText(/operated by r&g travel & tours/i)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${new Date().getFullYear()}.*r&g travel & tours`, 'i')),
    ).toBeInTheDocument();
  });
});
```

(Check this test file's own existing `render`/`mockTrpc` helper names before finalizing — it already has a `renderLayout()` helper per the "nav hides Tours" tests added in Task 3.)

In `client/src/__tests__/admin-layout.test.tsx` (which already renders `AdminLayout` per its own existing pattern — reuse that render call, do not create a new one), add:

```ts
it('does not render the "Powered by First On Page" credit (public footer only)', () => {
  // ... this file's own existing AdminLayout render call ...
  expect(screen.queryByText(/first on page/i)).not.toBeInTheDocument();
});
```

**This assertion is NOT yet real proof of anything — note that honestly, do not report it as a passing guard until Step 5.** Before the credit exists anywhere (this step), the assertion passes VACUOUSLY — there's nothing on the whole page named "First On Page", public or admin — so a green result here right now proves nothing. It only becomes a real guard once Step 4 adds the credit to the public footer and this test keeps passing specifically because `AdminLayout` never renders `SiteFooter`.

- [ ] **Step 2: Run them and watch them fail (and watch the vacuous one pass, for now)**

Run: `pnpm --filter @rg/client test -- layout.test admin-layout.test`
Expected: the two public-footer "renders" tests FAIL (the credit doesn't exist yet). The `AdminLayout` "does not render" test PASSES already, but — per the note above — that pass is currently vacuous, not a guard. Do not mistake it for Step 2 being half-done.

- [ ] **Step 3: Add the constant**

In `client/src/lib/site.ts`, add near the bottom (after `paymentMethods`, before the closing `} as const;`), or as its own small exported constant beside `SITE`:

```ts
/** The agency that built this site (owner decision 2026-11-11). Public footer only — never admin/driver/portal. */
export const BUILT_BY = {
  label: 'First On Page',
  url: 'https://firstonpage.com',
} as const;
```

- [ ] **Step 4: Add it to the footer**

In `client/src/components/layout/SiteFooter.tsx`, add the import:

```tsx
import { BUILT_BY, SITE, telLink, viberLink, visibleNav, whatsappLink } from '@/lib/site';
```

Inside the final `<div className="border-brand-blue-900 border-t">` block, directly after the existing `<p>Payments processed securely by PayMongo...</p>` line, add:

```tsx
<p className="text-brand-blue-300 mt-1 text-xs sm:mt-0">
  Powered by{' '}
  <a
    href={BUILT_BY.url}
    target="_blank"
    rel="nofollow noopener noreferrer"
    className="tap-target inline-flex min-h-11 items-center hover:underline"
  >
    {BUILT_BY.label}
  </a>
</p>
```

(Same size/colour class — `text-brand-blue-300 text-xs` — as the surrounding copyright line, per the owner's "small and subtle, same size/colour" instruction; `tap-target`+`min-h-11` for the 44px mobile target; the link text itself is the visible label, so no separate `aria-label` is needed; focus is visible via this project's existing global focus-ring styles, already applied to every other link in this footer with no extra class.)

- [ ] **Step 5: Run them and watch them pass**

Run: `pnpm --filter @rg/client test -- layout.test admin-layout.test`
Expected: PASS — and the `AdminLayout` "does not render" test is now a REAL guard for the first time (the credit exists on the public footer and genuinely does not reach `AdminLayout`), not the vacuous pass it was in Step 2.

- [ ] **Step 6: Prove the tests can fail**

Temporarily remove the new `<p>` block from `SiteFooter.tsx` — the "renders with the right href" test must go red. Restore. Then temporarily add the SAME `<p>` block directly into `AdminLayout.tsx` (not `SiteFooter.tsx`) — the `admin-layout.test.tsx` "does not render" test must go red, proving that test is actually checking `AdminLayout`'s own output and not, say, a leftover DOM node from a previous test's render. Restore (remove it from `AdminLayout.tsx` again — it was never meant to be there).

- [ ] **Step 7: Contrast and no-red guards**

Run `pnpm --filter @rg/client test -- no-red contrast` to confirm the existing guard tests still pass against this new text (it reuses an existing class pairing already proven AA, so no new failure is expected — but confirm rather than assume).

- [ ] **Step 8: Five checks, commit**

Commit message: `feat(footer): "Powered by First On Page" credit on the public footer only (Decision, 2026-11-11)`.

---

## Task 15: Close the batch — HANDOVER-19, final report

- [ ] **Step 1: Full five checks on the fully-committed tree**

Run, in order, and record each result:
`pnpm lint` · `pnpm typecheck` · `pnpm test` (shared, client, server) · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

- [ ] **Step 2: `git status` / `git log` sanity check**

Confirm `git status` is clean and list every commit made across Tasks 1–8 as `hash - short human label`.

- [ ] **Step 3: Write `docs/superpowers/plans/2026-11-10-staging-fixes-HANDOVER-19.md`'s own report section** (append to this file, or a sibling `HANDOVER-19.md` if this repo's convention is a separate handover doc — check `docs/superpowers/plans/2026-11-10-transfer-photos-HANDOVER-18.md` for the exact convention and match it) recording:

1. Each task's commit hash and label, with Tasks 1–8 mapped back to the controller prompt's own numbering so the report lines up with what was asked for: **1A = Task 1** (trust proxy), **1B = Tasks 2–3** (packages follow the show_tours gate, server + client), **1C = Tasks 4–8** (the five guest-copy decisions), **1D = Task 15** (this closing task) — and Tasks 10–14 reported under their own names (Turnstile infra/login/holds/inquiry+driver, footer credit), since they were added mid-batch and have no 1A–1D letter of their own.
2. The owner decisions (1–7 from 2026-11-10, plus the Turnstile and footer-credit decisions from 2026-11-10/11), verbatim.
3. **Task 1's diagnosis is unverified — say so plainly, do not claim the staging bug is fixed outright.** State the working theory (shared rate-limit key via nginx's loopback address) and record the owner's own instruction: they do not have the 429-vs-401 evidence yet, and asked for the fix to be robust to both named causes. Record plainly what Task 1 actually does and does not change: it fixes the rate-limit key (the only mechanism found with an actual code path); the research in Task 1 also found that the session cookie's `secure` flag is driven purely by `SITE_ENV`, never by proxy trust, so there was no second code-level "cookie" fix to make — if 401s turn out to be the real symptom after this deploys, the next things to check are `APP_ORIGIN`/`SITE_ENV` in staging's `.env`, not anything this batch touched. Ask the owner to confirm the status code after deploying (DevTools Network tab on `/trpc/staffAuth.me`, or the nginx/PM2 access log).
4. **The exact lines to add to the SERVER `.env`**, with which process-restart each needs:
   - `TRUST_PROXY=1` — PM2 restart (not reload); `env.ts` parses `process.env` once at import time.
   - `TURNSTILE_ENABLED=1` — PM2 restart.
   - `TURNSTILE_SECRET_KEY=` (owner fills in from the Cloudflare dashboard) — PM2 restart.
   - `VITE_TURNSTILE_SITE_KEY=` (owner fills in from the Cloudflare dashboard) — **this one needs a CLIENT REBUILD**, not just a server restart: it is baked into the client bundle at build time (`import.meta.env.VITE_TURNSTILE_SITE_KEY`), not read at server runtime.
     Remind the owner `TRUST_PROXY`/`TURNSTILE_ENABLED` are in ADDITION to the existing `NODE_ENV=production` / `SITE_ENV=production` launch-checklist items — `SITE_ENV` stays whatever the owner has it set to for staging vs. production. **Deliberately not in this list:** `TURNSTILE_LIVE_TEST` — it is a test-suite-only flag (`turnstile.test.ts` reads it directly off `process.env`), never consumed by the running app, so it has no place in a deployed `.env` at all.
5. **The manual content fix the owner must make on the already-seeded staging database** (per Task 4's note): the exact new "How it works" step 4 title (`"Meet your driver"`) and the exact new Site SEO title/description (from Task 4, Step 2), to paste into Admin → Settings → Content, since `db:seed` is insert-only and will not update them automatically.
6. **BUG-124 note:** while researching Decision 2, the controller asked whether `reviews.published`'s tour-visibility gap (BUG-124, logged in HANDOVER-6 as still needing an owner ruling) was in scope here. Checking `docs/BUGS_LOG.md` and `server/src/routers/public/reviews.ts` directly (not the stale HANDOVER-6 snapshot) found it was **already fixed** in a prior batch (commit `41e7287`) — `reviews.published` already nulls `tourId`/`tourTitle` while `show_tours` is off, and ignores a direct `tourId` input the same way. No action was needed or taken; recorded here so the report doesn't silently imply new work happened.
7. **Driver-login ordering question (Task 13)** — flag explicitly whether the implementer moved Turnstile's check relative to `attemptDriverLogin`'s own lockout counter, and why, per that task's own note.
8. Whether `TURNSTILE_LIVE_TEST=1 pnpm --filter @rg/server test -- turnstile.test` (the real-network block, skipped by default) was actually run this session, and its result — record this honestly rather than assuming the gated-off default run proves anything about it.
9. Any other unrelated bug found and deliberately not fixed, per `CLAUDE.md`'s "Unrelated bugs" policy.
10. Whether `PackageDetailPage.tsx` was given dedicated "this package isn't available" copy to match `TourDetailPage.tsx`'s BUG-shaped fix for a NOT_FOUND retry loop, or left as the pre-existing generic `QueryBoundary` error state (its own doc comment already says there is no package-specific 404 copy, by design) — this plan deliberately leaves it as-is; note it as a known, pre-existing gap rather than claiming parity.

- [ ] **Step 4: Final message to the owner**

End the session's final report with the line: **"✅ STAGING FIXES COMPLETE"**
