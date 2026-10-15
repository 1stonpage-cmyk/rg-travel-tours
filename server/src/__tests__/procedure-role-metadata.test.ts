/**
 * Task A4: an admin procedure cannot exist without a role gate.
 *
 * Task 17 built the gate (`requireRole`) and proved it decides correctly —
 * 30 role/area cases, both directions. It also wrote down what it could not
 * prove: *"the real Week 5 risk — an admin procedure that forgets to call
 * `requireRole` — cannot be tested here because no admin procedure exists."*
 * This file is that guard, arriving before the procedures it guards.
 *
 * Two mechanisms, and the second exists because the first cannot be total:
 *
 *  1. **The builder** (`adminProcedure(area)` in `../trpc.ts`). The area is a
 *     required argument, so forgetting the gate is a COMPILE error, and the
 *     validated `ctx.session` only exists downstream of it, so an admin
 *     handler that needs the actor cannot be written without it.
 *  2. **This enumeration**, for what types cannot reach: a procedure built out
 *     of `publicProcedure` that is administrative in substance. Every
 *     procedure on the REAL `appRouter` is walked and must declare its access
 *     in metadata. (`appRouter._def.procedures` is the same shape task 21's
 *     driver-login guard reads, for the same reason: it is the router as
 *     mounted, not a list of what someone believes is mounted.)
 *
 * **Why metadata rather than an allow-list of public procedure names.** An
 * allow-list fails closed — a new procedure is not on it, so the test goes red
 * — but it goes red for EVERY new procedure, public ones included. The fix a
 * developer then reaches for is "append the name to the public list", which is
 * precisely the unexamined one-line edit this guard exists to prevent, and it
 * is indistinguishable in review from the same edit made for an admin
 * procedure. Metadata inverts that: the declaration lives on the procedure, a
 * new public procedure needs no edit here at all, and the only way to obtain
 * either stamp is to use a builder — `t` is not exported from `../trpc.ts`,
 * which `only ../trpc.ts calls initTRPC`, below, is what keeps true.
 *
 * No database is touched by this file. The fixtures are test-local; this task
 * ships no admin endpoint.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, type AdminRole } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { ROLE_MATRIX, type AdminArea } from '../middleware/require-role';
import { adminProcedure, publicProcedure, router, type ProcedureAccess } from '../trpc';

/* ------------------------------------------------------------------ *
 * Reading the router as mounted.
 * ------------------------------------------------------------------ */

/** The slice of tRPC's internals this guard depends on. */
type ProcedureLike = { _def?: { meta?: unknown } };

/**
 * Every procedure on a router, keyed by its dotted tRPC path.
 *
 * Read off `_def.procedures` rather than by walking the record of child
 * routers, because that is the flattened map the HTTP adapter itself resolves
 * a request against: if a procedure is callable, it is in here.
 */
function proceduresOf(target: unknown): Record<string, ProcedureLike> {
  const procedures = (target as { _def?: { procedures?: Record<string, ProcedureLike> } })._def
    ?.procedures;
  if (!procedures || Object.keys(procedures).length === 0) {
    throw new Error('router._def.procedures is missing or empty — tRPC internals have moved');
  }
  return procedures;
}

/** What a procedure declares about who may call it, or `undefined` if nothing. */
function accessOf(procedure: ProcedureLike): ProcedureAccess | undefined {
  const meta = procedure._def?.meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const access = (meta as { access?: unknown }).access;
  if (access === 'public') return { access: 'public' };
  // Week 4 Task 8: the guest portal's own access kind. No area and no roles
  // to compare — a guest has neither — so the assertions that bite on it
  // are "it is declared" and "it refuses an anonymous caller".
  if (access === 'customer') return { access: 'customer' };
  /*
   * Week 6 Task 2: the driver portal's own access kind, and the FOURTH of
   * them. Added the moment the first `driverProcedure` was mounted
   * (`driver.trips`) — before that this function returned `undefined` for
   * it and the enumeration below was right to fail, because nothing had
   * declared what a driver procedure is.
   *
   * Recognising it is only half the extension: on its own, a `driver`
   * branch here would turn the red to green and leave driver procedures
   * enumerated but unproven. The other half is
   * `refuses an anonymous caller, a staff session and a customer session on
   * every driver procedure` plus the driver-namespace rule below — all
   * three subject types, because a driver's day sheet carries other
   * guests' names and phone numbers and a signed-in dispatcher or guest
   * reaching it would be an RA 10173 disclosure with a 200 status code.
   *
   * No area and no roles to compare: a driver has neither, exactly as a
   * guest does not.
   */
  if (access === 'driver') return { access: 'driver' };
  if (access === 'admin') {
    const { area, roles } = meta as { area?: unknown; roles?: unknown };
    if (typeof area !== 'string' || !Array.isArray(roles)) return undefined;
    return { access: 'admin', area: area as AdminArea, roles: roles as AdminRole[] };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * A Week-5-shaped router, so the admin half of the enumeration is not
 * vacuous today.
 * ------------------------------------------------------------------ */

/**
 * `appRouter` is all-public until Week 5, which would leave every
 * admin-specific assertion below looping over an empty list — green, and
 * proving nothing. So the same assertions run against this fixture as well:
 * one gated procedure under an `admin` namespace plus one public sibling,
 * which is the shape the real surface takes when it arrives.
 *
 * It is a FIXTURE, not an endpoint. Nothing mounts it, and the enumeration
 * over `appRouter` is what actually guards the server.
 */
const weekFiveShaped = router({
  admin: router({
    pricing: adminProcedure('toursPricing').query(({ ctx }) => ({
      // Compile-time proof: `ctx.session` exists here and nowhere else. The
      // same body on `publicProcedure` is `error TS2339: Property 'session'
      // does not exist on type 'object'`.
      actor: ctx.session.subjectId,
      role: ctx.session.role,
    })),
    queue: adminProcedure('verifyPayments').query(() => ({ ok: true as const })),
  }),
  open: publicProcedure.query(() => ({ ok: true as const })),
});

/** Resolves a dotted tRPC path against a `createCaller` proxy. */
function callerFor(target: { createCaller: (ctx: never) => unknown }, path: string, ctx: unknown) {
  const segments = path.split('.');
  let node = target.createCaller(ctx as never) as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
  return node[segments.at(-1) as string] as () => Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * The enumeration — every procedure, on the real router and the fixture.
 * ------------------------------------------------------------------ */

const TARGETS = [
  /*
   * `adminExpected` flipped to TRUE in Week 4, Task 5: `staffAuth.me` is the
   * first `adminProcedure` ever mounted on `appRouter`. Before it, the whole
   * router was public and the admin assertions below had nothing to bite on
   * here — which is what this flag exists to state rather than leave as an
   * accident. Everything else on `appRouter` is still public.
   *
   * `driverExpected` is the same statement for the driver portal, and
   * flipped to TRUE in Week 6, Task 2 with `driver.trips` — the first
   * mounted `driverProcedure`. It exists so the driver assertions below
   * cannot go quietly vacuous: if the driver surface were ever unmounted,
   * renamed out of its access kind, or built with the wrong builder, the
   * loops would find nothing to check and `reads a non-empty procedure
   * map` fails rather than passing on an empty list.
   */
  { name: 'appRouter', router: appRouter, adminExpected: true, driverExpected: true },
  {
    name: 'a Week-5-shaped router',
    router: weekFiveShaped,
    adminExpected: true,
    driverExpected: false,
  },
] as const;

/**
 * The ONLY two procedures allowed to be public under `driver.*`, and the
 * reason the list is two names rather than a pattern.
 *
 * A login cannot require a session and a logout must succeed for a driver
 * whose twelve hours lapsed mid-trip (see `driverAuthRouter`), so those two
 * are necessarily `publicProcedure`. Everything else under that namespace
 * reads a driver's own trips, manifests and check-ins and must be
 * `driverProcedure`.
 *
 * It is an allow-list of exactly the two, not a prefix or a substring rule:
 * a future `driver.loginWithLink` would NOT be excused by it, which is the
 * point. And the test below refuses to trust the list blindly — while any
 * driver procedure is mounted, both of these names must exist and both must
 * really be public, so the list cannot sit here excusing a name nothing
 * answers to.
 */
const DRIVER_PUBLIC_PROCEDURES: readonly string[] = ['driver.login', 'driver.logout'];

for (const target of TARGETS) {
  describe(`every procedure on ${target.name} declares who may call it`, () => {
    const mounted = proceduresOf(target.router);
    const paths = Object.keys(mounted).sort();
    const access = (path: string) => accessOf(mounted[path] as ProcedureLike);
    const adminPaths = paths.filter((path) => access(path)?.access === 'admin');
    const driverPaths = paths.filter((path) => access(path)?.access === 'driver');

    it('reads a non-empty procedure map', () => {
      // Guards the guard: a vacuous enumeration would pass everything below.
      expect(paths.length).toBeGreaterThan(0);
      expect(paths).toContain(target.name === 'appRouter' ? 'health' : 'open');
      // And the admin assertions below have something to bite on where they
      // are supposed to. `appRouter` gained its first admin procedure in
      // Week 4 (`staffAuth.me`); before that it was all-public.
      expect(adminPaths.length > 0).toBe(target.adminExpected);
      // And the same for the driver assertions, which gained something to
      // bite on in Week 6 (`driver.trips`). A driver surface that stopped
      // being enumerated here would otherwise pass every loop below by
      // being absent from all of them.
      expect(driverPaths.length > 0).toBe(target.driverExpected);
    });

    it('leaves no procedure without role metadata', () => {
      const undeclared = paths.filter((path) => access(path) === undefined);
      expect(
        undeclared,
        `${undeclared.join(', ')} was not built with publicProcedure or adminProcedure(area), so ` +
          'nothing states who may call it and no role gate is attached. Build admin procedures ' +
          'with adminProcedure(area) from server/src/trpc.ts.',
      ).toEqual([]);
    });

    it('gives every admin procedure exactly the roles BUILD_SPEC §9 gives its area', () => {
      for (const path of adminPaths) {
        const declared = access(path);
        if (declared?.access !== 'admin') throw new Error(`${path} changed shape mid-test`);
        expect(Object.keys(ROLE_MATRIX), `${path} names an area §9 does not have`).toContain(
          declared.area,
        );
        expect(
          [...declared.roles],
          `${path} claims roles that are not §9's row for ${declared.area}`,
        ).toEqual([...ROLE_MATRIX[declared.area]]);
      }
    });

    it('refuses an anonymous caller on every admin procedure, not just in its metadata', async () => {
      for (const path of adminPaths) {
        await expect(
          callerFor(target.router, path, {})(),
          `${path} is labelled admin but answered a caller with no session`,
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    });

    /**
     * The same proof for the guest portal (Week 4, Task 8). A `customer`
     * procedure reads ONE booking — an amount due, an account number — and
     * the owner's instruction is that a booking reference alone reveals
     * nothing, so an unauthenticated caller must be refused by the GATE and
     * not merely by the label.
     *
     * Also asserted: a STAFF session does not satisfy it. An admin reads a
     * booking through the admin surface, where access is role-gated and
     * audited; if a staff session passed this gate, "which booking is this
     * session for" would stop having an answer.
     */
    it('refuses an anonymous caller, and a staff session, on every customer procedure', async () => {
      const customerPaths = paths.filter((path) => access(path)?.access === 'customer');
      for (const path of customerPaths) {
        await expect(
          callerFor(target.router, path, {})(),
          `${path} is labelled customer but answered a caller with no session`,
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(
          callerFor(target.router, path, {
            session: { subjectType: 'user', subjectId: 1, role: 'owner' },
          })(),
          `${path} let a STAFF session through the guest-portal gate`,
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    });

    /**
     * The same proof for the driver portal (Week 6, Task 2), against **all
     * three** subject types rather than two.
     *
     * A driver procedure answers from `ctx.driver.driverId` and has no
     * input field naming a driver, so there is no identity a staff or guest
     * session could be. Letting either through would not be "an admin
     * seeing what the driver sees" — it would be a 200 response carrying
     * another driver's trips, whose guests' names and phone numbers are
     * personal data under RA 10173. `requireDriver` refuses all three; this
     * is what holds every FUTURE driver procedure to the same, because it
     * enumerates the router rather than naming the procedures it knows.
     */
    it('refuses an anonymous caller, a staff session and a customer session on every driver procedure', async () => {
      const refused = [
        ['a caller with no session', {}],
        ['a caller with an explicitly null session', { session: null }],
        ['a STAFF session', { session: { subjectType: 'user', subjectId: 1, role: 'owner' } }],
        [
          'a DISPATCHER session',
          { session: { subjectType: 'user', subjectId: 2, role: 'dispatcher' } },
        ],
        ['a CUSTOMER session', { session: { subjectType: 'customer', subjectId: 1 } }],
      ] as const;

      for (const path of driverPaths) {
        for (const [who, ctx] of refused) {
          await expect(
            callerFor(target.router, path, ctx)(),
            `${path} is labelled driver but answered ${who}`,
          ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        }
      }
    });

    /**
     * Everything under `driver.*` is driver-gated except the login pair.
     *
     * The driver namespace's counterpart to the admin-namespace rule below,
     * and the reason it is needed: `driverProcedure` makes the gate
     * unforgettable for anyone who reaches for `ctx.driver`, but a
     * procedure that reads a driver id from its own INPUT and never touches
     * `ctx` would type-check perfectly on `publicProcedure`. That is the
     * substance this catches — "it is in the driver portal, so it is gated
     * or it is one of the two logins".
     */
    it('lets no procedure under the driver namespace be public outside the login pair', () => {
      const mislabelled = paths.filter(
        (path) =>
          // `\b` after `driver` keeps `admin.drivers.*` out of this rule:
          // those are `adminProcedure('vansDrivers')` and the admin rules
          // below already hold them. `driver.trips` matches; `drivers`
          // does not.
          /(^|\.)driver\b/i.test(path) &&
          !DRIVER_PUBLIC_PROCEDURES.includes(path) &&
          access(path)?.access !== 'driver',
      );
      expect(
        mislabelled,
        `${mislabelled.join(', ')} sits in the driver namespace but was not built with ` +
          'driverProcedure from server/src/trpc.ts. Only driver.login and driver.logout may be ' +
          'public there — a login cannot require a session; reading a driver trip can.',
      ).toEqual([]);

      // The allow-list is only safe while it names what it claims to name.
      // Whenever a driver procedure is mounted at all, both excused names
      // must exist and both must really be public.
      if (driverPaths.length > 0) {
        for (const path of DRIVER_PUBLIC_PROCEDURES) {
          expect(
            paths,
            `${path} is excused as a public driver login but is not mounted — the allow-list is ` +
              'excusing a name nothing answers to',
          ).toContain(path);
          expect(access(path), `${path} is excused as public but does not declare public`).toEqual({
            access: 'public',
          });
        }
      }
    });

    it('lets no procedure under an admin namespace claim to be public', () => {
      const mislabelled = paths.filter(
        (path) => /(^|\.)admin\b/i.test(path) && access(path)?.access !== 'admin',
      );
      expect(
        mislabelled,
        `${mislabelled.join(', ')} sits in an admin namespace but was built with publicProcedure`,
      ).toEqual([]);
    });
  });
}

/* ------------------------------------------------------------------ *
 * What keeps the metadata unforgeable: one tRPC instance.
 * ------------------------------------------------------------------ */

describe('only server/src/trpc.ts calls initTRPC', () => {
  /**
   * The metadata above is only a fact because `t` never leaves `../trpc.ts`.
   * A second `initTRPC` call anywhere in the server would hand its caller a
   * bare `t.procedure` with no meta and no gate — reachable, mountable, and
   * invisible to code review. So the count is pinned.
   *
   * `__tests__` is excluded deliberately: this file's own proof of failure
   * builds a rogue instance to confirm the enumeration bites, and a test
   * fixture is not a mounted route.
   */
  it('has exactly one tRPC root instance in non-test server source', () => {
    const src = resolve(import.meta.dirname, '..');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => file.endsWith('.ts') && !file.includes('__tests__/'));
    expect(files, 'the source scan found nothing to scan').toContain('trpc.ts');

    const callers = files
      .filter((file) => /\binitTRPC\b/.test(readFileSync(resolve(src, file), 'utf8')))
      .sort();
    expect(
      callers,
      'a second initTRPC instance can mint procedures with neither metadata nor a role gate',
    ).toEqual(['trpc.ts']);
  });
});

/* ------------------------------------------------------------------ *
 * The builder itself — test-local fixtures, nothing shipped.
 * ------------------------------------------------------------------ */

describe('adminProcedure(area) is a gate, not a label', () => {
  function callAs(session: unknown) {
    return callerFor(weekFiveShaped, 'admin.pricing', { session })();
  }

  it('stamps the area and §9 row into the procedure metadata', () => {
    const meta = accessOf(proceduresOf(weekFiveShaped)['admin.pricing'] as ProcedureLike);
    expect(meta).toEqual({ access: 'admin', area: 'toursPricing', roles: ['owner'] });
  });

  it('stamps public on publicProcedure', () => {
    expect(accessOf(proceduresOf(weekFiveShaped).open as ProcedureLike)).toEqual({
      access: 'public',
    });
  });

  it('admits the role §9 allows and returns the validated actor', async () => {
    await expect(callAs({ subjectType: 'user', subjectId: 7, role: 'owner' })).resolves.toEqual({
      actor: 7,
      role: 'owner',
    });
  });

  // Widened, because `ROLE_MATRIX.toursPricing` is `readonly ['owner']` and
  // `.includes` would otherwise only accept the literal it already contains.
  const mayPrice: readonly AdminRole[] = ROLE_MATRIX.toursPricing;
  for (const role of ADMIN_ROLES.filter((r) => !mayPrice.includes(r))) {
    it(`denies ${role}, whom §9 excludes from toursPricing`, async () => {
      await expect(callAs({ subjectType: 'user', subjectId: 7, role })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  }

  it('denies an anonymous caller', async () => {
    await expect(callAs(undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('denies a driver session carrying an owner role', async () => {
    await expect(
      callAs({ subjectType: 'driver', subjectId: 3, role: 'owner' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('runs the gate BEFORE the resolver body, not alongside it', async () => {
    const ran: string[] = [];
    const watched = router({
      pricing: adminProcedure('toursPricing').query(() => {
        ran.push('resolver');
        return { ok: true as const };
      }),
    });
    await expect(watched.createCaller({} as never).pricing()).rejects.toBeInstanceOf(TRPCError);
    // "Did not resolve" is weaker than "the work never happened".
    expect(ran).toEqual([]);
  });
});
