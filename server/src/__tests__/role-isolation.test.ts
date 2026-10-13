/**
 * Task 17 of the core-schema plan: role isolation, both directions.
 *
 * CLAUDE.md asks for "a test per role per area". Three roles across §9's ten
 * areas is 30 cases, and they are GENERATED from `ROLE_MATRIX` rather than
 * hand-written, because the direction that matters is the denial — and the
 * denial is exactly the case a hand-written set forgets. Writing them out by
 * hand also lets a new area arrive with no test at all; generating them means
 * area eleven is covered the moment it is added to the matrix.
 *
 * Three layers, because the generated 30 on their own would prove less than
 * they appear to:
 *
 *  1. **The matrix is checked against the spec, not against a second copy of
 *     itself.** `BUILD_SPEC.md` §9 is parsed out of the markdown and its
 *     ✅/❌ cells compared cell by cell with `ROLE_MATRIX`. A transcription
 *     typo, a widened role list, or an edit to the spec table all fail here.
 *     (Same discipline as `no-red.test.ts` and `contrast.test.ts`: read the
 *     real source, never a fixture list.)
 *  2. **The 30 cases run through a real tRPC procedure**, not through a
 *     lookup. The harness below builds a router with one gated procedure per
 *     area — the shape a Week 5 admin procedure will have — and the pass/fail
 *     signal is whether the RESOLVER BODY actually ran, recorded by a
 *     side effect. "Did not throw" is a weaker claim than "the handler
 *     executed", and a middleware that throws after calling `next()` would
 *     satisfy the first and fail the second.
 *  3. **The fail-closed cases.** No session, a `null` session, a driver or
 *     customer session, an unrecognised role, `'__proto__'`, a non-object
 *     context and an empty allow-list. None of those are "a role in an area",
 *     so the generated loop cannot reach them, and every one of them is a way
 *     a gate quietly opens.
 *
 * What this file does NOT prove: that admin procedures are gated. There are
 * no admin procedures yet (Weeks 5–7), so there is nothing to audit for
 * missing `.use()` calls. The procedure-coverage guard belongs with the
 * procedures; it is named in the report, not faked here.
 *
 * No database is touched by this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, type AdminRole } from '@rg/shared';
import {
  ROLE_MATRIX,
  requireRole,
  type AdminArea,
  type StaffSession,
} from '../middleware/require-role';
import { publicProcedure, router } from '../trpc';

/* ------------------------------------------------------------------ *
 * The harness: what a real admin procedure will look like.
 * ------------------------------------------------------------------ */

/**
 * Every resolver body that actually executed, newest last.
 *
 * This is the allow/deny signal. A gate is only doing its job if the work
 * behind it never happens, so the test asks "did the handler run?" rather
 * than "was an error thrown?".
 */
const resolverRuns: AdminArea[] = [];

/**
 * One gated procedure, built exactly the way an admin procedure will be: the
 * area names itself, the middleware spreads that area's row of the matrix
 * into `requireRole`, and the validated session is passed down the chain for
 * the resolver to attribute an audit row to.
 */
function gated(area: AdminArea) {
  return publicProcedure
    .use(({ ctx, next }) => {
      const session = requireRole(...ROLE_MATRIX[area])(ctx);
      return next({ ctx: { session } });
    })
    .query(({ ctx }) => {
      resolverRuns.push(area);
      return { area, actor: (ctx as { session: StaffSession }).session.subjectId };
    });
}

/**
 * Listed one per line rather than generated from `Object.keys`, so that the
 * router is a second, independent statement of the ten areas: a key dropped
 * here while the matrix keeps it is caught by `covers every area`, below.
 */
const adminHarness = router({
  dashboard: gated('dashboard'),
  bookingsView: gated('bookingsView'),
  assignVanDriver: gated('assignVanDriver'),
  verifyPayments: gated('verifyPayments'),
  cancelRefund: gated('cancelRefund'),
  vansDrivers: gated('vansDrivers'),
  toursPricing: gated('toursPricing'),
  reviewsModeration: gated('reviewsModeration'),
  reports: gated('reports'),
  usersSettings: gated('usersSettings'),
});

/** An authenticated staff session, as the Week 5 session service will build it. */
function staffSession(role: unknown) {
  return { session: { subjectType: 'user', subjectId: 7, role } };
}

/** Calls one area with one context and reports what happened. */
async function callArea(area: AdminArea, ctx: unknown) {
  const before = resolverRuns.length;
  /*
   * `as never`, deliberately. This suite feeds contexts the real factory
   * could never produce — a session with an invalid role, a role as a
   * number, no session at all — because the property under test is that
   * `requireRole` RE-VALIDATES at runtime instead of trusting the type it
   * was handed. Typing this argument properly would delete the test.
   */
  const caller = adminHarness.createCaller(ctx as never);
  try {
    await caller[area]();
  } catch (error) {
    return {
      ok: false,
      ran: resolverRuns.length > before,
      code: error instanceof TRPCError ? error.code : `NOT_A_TRPC_ERROR: ${String(error)}`,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, ran: resolverRuns.length > before, code: null, message: '' };
}

/* ------------------------------------------------------------------ *
 * Layer 1 — the matrix against BUILD_SPEC §9 itself.
 * ------------------------------------------------------------------ */

/**
 * §9's row labels, mapped to matrix keys. This mapping is the only thing that
 * cannot be derived — the spec writes prose ("Verify payments, record
 * payments"), the code writes an identifier — so it is stated once, here,
 * and the ten labels must match the spec's text exactly or the parse fails.
 */
const AREA_LABELS: Record<string, AdminArea> = {
  Dashboard: 'dashboard',
  'Bookings: view, notes': 'bookingsView',
  'Assign van/driver': 'assignVanDriver',
  'Verify payments, record payments': 'verifyPayments',
  'Cancel / refund': 'cancelRefund',
  'Vans, drivers': 'vansDrivers',
  'Tours, pricing, coupons': 'toursPricing',
  'Reviews moderation': 'reviewsModeration',
  'Reports, CSV export': 'reports',
  'Users, settings': 'usersSettings',
};

/** The spec's column order: `| Area | Owner | Dispatcher | Finance |`. */
const SPEC_COLUMNS: readonly AdminRole[] = ['owner', 'dispatcher', 'finance'];

/** Parses §9's permission table into the same shape as `ROLE_MATRIX`. */
function parseSpecMatrix(): Record<string, AdminRole[]> {
  const spec = readFileSync(resolve(import.meta.dirname, '../../../docs/BUILD_SPEC.md'), 'utf8');
  const section = /### Roles & permissions\s*\n([\s\S]*?)\n### /.exec(spec);
  if (!section) throw new Error('BUILD_SPEC.md has no "### Roles & permissions" section');

  const parsed: Record<string, AdminRole[]> = {};
  for (const line of (section[1] ?? '').split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    // Header, separator and prose lines have no tick in them.
    if (cells.length !== 4 || !cells.slice(1).some((cell) => cell === '✅' || cell === '❌')) {
      continue;
    }
    const label = cells[0] ?? '';
    const key = AREA_LABELS[label];
    if (!key) throw new Error(`§9 row "${label}" is not mapped to a ROLE_MATRIX key`);
    parsed[key] = cells.slice(1).flatMap((mark, column) => {
      const role = SPEC_COLUMNS[column];
      if (!role) throw new Error(`§9 row "${label}" has more columns than there are roles`);
      if (mark === '✅') return [role];
      if (mark === '❌') return [];
      throw new Error(`§9 row "${label}" has an unreadable cell: "${mark}"`);
    });
  }
  return parsed;
}

describe('ROLE_MATRIX is BUILD_SPEC §9, transcribed', () => {
  const specMatrix = parseSpecMatrix();

  it('covers the ten areas of §9 and nothing else', () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual(Object.keys(specMatrix).sort());
    expect(Object.keys(ROLE_MATRIX)).toHaveLength(10);
  });

  for (const [area, allowed] of Object.entries(ROLE_MATRIX)) {
    it(`${area} allows exactly what the spec table allows`, () => {
      expect(specMatrix[area], `§9 has no row for ${area}`).toBeDefined();
      expect([...allowed]).toEqual(specMatrix[area]);
    });
  }

  it('splits the 30 role/area cases 20 allowed to 10 denied', () => {
    const allow = Object.values(ROLE_MATRIX).reduce((sum, roles) => sum + roles.length, 0);
    expect(allow).toBe(20);
    expect(ADMIN_ROLES.length * Object.keys(ROLE_MATRIX).length - allow).toBe(10);
  });

  it('names no role outside ADMIN_ROLES', () => {
    for (const roles of Object.values(ROLE_MATRIX)) {
      for (const role of roles) expect(ADMIN_ROLES).toContain(role);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Layer 2 — a test per role per area, both directions.
 * ------------------------------------------------------------------ */

describe('a test per role per area, both directions', () => {
  it('covers every area of the matrix with a harness procedure', () => {
    // `createCaller({})` would deny everything, so the keys are read off the
    // router's own definition rather than by calling it.
    expect(Object.keys(adminHarness._def.procedures).sort()).toEqual(
      Object.keys(ROLE_MATRIX).sort(),
    );
  });

  for (const [area, allowed] of Object.entries(ROLE_MATRIX) as [
    AdminArea,
    readonly AdminRole[],
  ][]) {
    for (const role of ADMIN_ROLES) {
      const shouldPass = allowed.includes(role);
      it(`${role} is ${shouldPass ? 'allowed' : 'DENIED'} in ${area}`, async () => {
        const result = await callArea(area, staffSession(role));
        expect(result.ok).toBe(shouldPass);
        // The resolver body ran if and only if the role is allowed.
        expect(result.ran).toBe(shouldPass);
        if (!shouldPass) expect(result.code).toBe('FORBIDDEN');
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * Layer 3 — the gate fails closed.
 * ------------------------------------------------------------------ */

describe('requireRole fails closed', () => {
  /** Areas chosen for the breadth they cover: all-roles, two-role, owner-only. */
  const SAMPLE: readonly AdminArea[] = ['dashboard', 'cancelRefund', 'usersSettings'];

  const denied: readonly { what: string; ctx: unknown; code: string }[] = [
    { what: 'no session on the context', ctx: {}, code: 'UNAUTHORIZED' },
    { what: 'an explicitly null session', ctx: { session: null }, code: 'UNAUTHORIZED' },
    { what: 'an undefined session', ctx: { session: undefined }, code: 'UNAUTHORIZED' },
    {
      what: 'a DRIVER session carrying an owner role',
      ctx: { session: { subjectType: 'driver', subjectId: 3, role: 'owner' } },
      code: 'UNAUTHORIZED',
    },
    {
      what: 'a CUSTOMER session carrying an owner role',
      ctx: { session: { subjectType: 'customer', subjectId: 42, role: 'owner' } },
      code: 'UNAUTHORIZED',
    },
    { what: 'a session with no role at all', ctx: staffSession(undefined), code: 'FORBIDDEN' },
    { what: 'an unrecognised role string', ctx: staffSession('superuser'), code: 'FORBIDDEN' },
    {
      what: 'the role "admin", which does not exist',
      ctx: staffSession('admin'),
      code: 'FORBIDDEN',
    },
    { what: 'a role of the wrong case', ctx: staffSession('Owner'), code: 'FORBIDDEN' },
    { what: 'a prototype-shaped role', ctx: staffSession('__proto__'), code: 'FORBIDDEN' },
    { what: 'a role that is an object', ctx: staffSession({ role: 'owner' }), code: 'FORBIDDEN' },
    { what: 'a role that is an array of roles', ctx: staffSession(['owner']), code: 'FORBIDDEN' },
    { what: 'a session that is a string', ctx: { session: 'owner' }, code: 'UNAUTHORIZED' },
  ];

  for (const { what, ctx, code } of denied) {
    for (const area of SAMPLE) {
      it(`refuses ${what} in ${area} with ${code}`, async () => {
        const result = await callArea(area, ctx);
        expect(result.ok).toBe(false);
        expect(result.ran).toBe(false);
        expect(result.code).toBe(code);
      });
    }
  }

  it('refuses an empty allow-list — a mistyped area must not open the door', () => {
    const gate = requireRole();
    for (const role of ADMIN_ROLES) {
      expect(() => gate(staffSession(role))).toThrow(TRPCError);
    }
  });

  it('refuses a context that is not an object at all', () => {
    const gate = requireRole('owner');
    for (const ctx of [undefined, null, 0, '', 'owner', true, []]) {
      expect(() => gate(ctx)).toThrow(TRPCError);
    }
  });

  it('returns the validated session so a procedure can attribute an audit row', () => {
    const session = requireRole('owner', 'finance')(staffSession('finance'));
    expect(session).toEqual({ subjectType: 'user', subjectId: 7, role: 'finance' });
  });

  it('never names a role, an area or the allow-list in the refusal message', async () => {
    const forbidden = await callArea('usersSettings', staffSession('dispatcher'));
    const unauthorised = await callArea('usersSettings', {});
    for (const { message } of [forbidden, unauthorised]) {
      for (const word of [...ADMIN_ROLES, ...Object.keys(ROLE_MATRIX)]) {
        expect(message.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });
});
