/**
 * Week 5 plan, Task 4 — `admin.vans.*` (BUILD_SPEC §9 "Vans" / §5A, server
 * half). Updated 2026-11-08 (owner decision: flexible places/routes/vehicle
 * types) — `vehicleType` was a hard-coded `van`/`suv` enum; it is now
 * `vehicleTypeId`, a foreign key onto the admin-managed `vehicle_types`
 * table. `seedBase` still seeds `van` and `suv` as real rows (migration
 * 0023), so this file resolves their ids rather than hard-coding one.
 *
 * §9 gives the "Vans, drivers" row to owner and dispatcher only — finance
 * is refused, which is the opposite split from `admin.bookings.list` (view
 * is all three roles there). That is the point of this file, same as it was
 * the point of `admin-bookings.test.ts`: a role test per role per area, and
 * a procedure-enumeration guard so a later task cannot quietly add a fifth
 * `admin.vans.*` mutation — there is deliberately no delete, because vans
 * are soft-deleted through `is_active` (CLAUDE.md).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, users, vans, vehicleTypes } from '../db/schema';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const created = {
  userIds: [] as number[],
  vanIds: [] as number[],
};

/**
 * The real, global `vehicle_types.id` for `'van'`/`'suv'` — seeded by
 * `seedBase` (migration 0023), never a literal id (CLAUDE.md). Resolved
 * once in `beforeAll`.
 */
let VAN_ID = 0;
let SUV_ID = 0;

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}" — expected from seedBase.`);
  return row.id;
}

/** Every `vanInputSchema` field present — `.strict()` requires all of them. */
function validVan() {
  return {
    plate: 'ABC123',
    model: 'Toyota Hiace',
    capacity: 10,
    /** Pre-task 0C's nullable column. `null` = "not recorded for this vehicle". */
    luggageCapacity: null,
    vehicleTypeId: VAN_ID,
    odometer: 50_000,
    lastService: '2026-01-01',
    nextService: '2026-07-01',
    orcrExpiry: '2027-01-01',
    franchiseNo: 'FR-2026-001',
    franchiseExpiry: '2027-01-01',
    repairNotes: null,
  } as const;
}

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${unique}`,
      email: `advan_${role}_${unique}@example.test`,
      passwordHash: '__advan_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** Every audit row written against one entity, oldest first. */
async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const idFor = (role: 'owner' | 'dispatcher' | 'finance') =>
  role === 'owner' ? ownerId : role === 'dispatcher' ? dispatcherId : financeId;

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
  VAN_ID = await vehicleTypeIdBySlug('van');
  SUV_ID = await vehicleTypeIdBySlug('suv');
}, 60_000);

afterAll(async () => {
  const pool = getPool();
  if (created.vanIds.length > 0) {
    // `audit_log.entity_id` is polymorphic — a booking and a van can share
    // the same numeric id, so the entity column is part of the filter too.
    await getDb()
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'van'), inArray(auditLog.entityId, created.vanIds)));
    await getDb().delete(vans).where(inArray(vans.id, created.vanIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('vans', () => {
  /*
   * The brief's own draft asserted `.rejects.toThrow(/UNAUTHORIZED|FORBIDDEN/)`
   * here, against the error MESSAGE. `requireRole` (require-role.ts) throws
   * `TRPCError({ code: 'UNAUTHORIZED', message: 'Admin sign-in required.' })`
   * and `{ code: 'FORBIDDEN', message: 'Not permitted for this account.' }` —
   * by design, "Neither message names a role, an area or the allow-list."
   * Neither message contains the word UNAUTHORIZED or FORBIDDEN, so that
   * regex can never match even when the gate is working correctly. Asserting
   * on `code` is the house pattern `admin-bookings.test.ts` already uses for
   * exactly this reason (`.rejects.toMatchObject({ code: 'UNAUTHORIZED' })`).
   */
  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.vans.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(1) as never);
    await expect(api.admin.vans.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES finance — §9 gives vans to owner and dispatcher only', async () => {
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(api.admin.vans.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.admin.vans.create({ ...validVan(), plate: 'XYZ999' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  /**
   * Fix round 1, addition 2: only `list` and `create` were exercised with a
   * finance session before this. The shared gate plus
   * `procedure-role-metadata.test.ts` cover the role list structurally, but
   * §9's matrix is a security boundary and CLAUDE.md asks for a test per
   * role per area — one procedure accidentally built on the wrong area is
   * exactly the defect this catches. The id never has to resolve to a real
   * van: `requireRole` runs before the resolver, so a finance session is
   * refused before either procedure ever reads the database.
   */
  it('REFUSES finance for update and setStatus', async () => {
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(
      api.admin.vans.update({ id: 1, patch: { model: 'Valid model name' } }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api.admin.vans.setStatus({ id: 1, status: 'parked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('ALLOWS dispatcher and owner', async () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      const api = appRouter.createCaller(staffContext(idFor(role), role) as never);
      await expect(api.admin.vans.list()).resolves.toBeInstanceOf(Array);
    }
  });

  it('refuses a duplicate plate with a message a human can act on', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'ABC123' });
    created.vanIds.push(id);
    await expect(api.admin.vans.create({ ...validVan(), plate: 'ABC123' })).rejects.toThrow(
      /already/i,
    );
  });

  it('normalises the plate so ABC123 and abc123 are the same van', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    // 'ABC123' already exists from the test above — this is the same suite's
    // transform (`.toUpperCase()`) and the DB's unique index agreeing.
    await expect(api.admin.vans.create({ ...validVan(), plate: 'abc123' })).rejects.toThrow(
      /already/i,
    );
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(
      api.admin.vans.create({ ...validVan(), plate: 'NEW111', isActive: false } as never),
    ).rejects.toThrow();
  });

  /**
   * Fix round 1, addition 1: the review confirmed by reading Zod's source
   * that `.strict()` on `vanInputSchema` survives `.partial()`, but nothing
   * in the suite proved it. This is the guard that stops a client posting
   * `isActive` or `status` through the `update` door instead of through
   * `setStatus` — proven able to fail by dropping `.strict()` from
   * `vanInputSchema` (same toggle the "rejects an unknown field" proof
   * above used) and confirming this test goes red too.
   */
  it("rejects an unknown field in update's patch instead of silently stripping it", async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'STR111' });
    created.vanIds.push(id);
    await expect(
      api.admin.vans.update({
        id,
        patch: { model: 'Updated model', isActive: false } as never,
      }),
    ).rejects.toThrow();
  });

  it('writes an audit row naming the actor on every change', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'AUD111' });
    created.vanIds.push(id);
    await api.admin.vans.setStatus({ id, status: 'for_repair' });
    const rows = await auditRowsFor('van', id);
    expect(rows.map((r) => r.action)).toEqual(['van_created', 'van_status_changed']);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([ownerId]));
    expect(new Set(rows.map((r) => r.actorType))).toEqual(new Set(['user']));
  });

  /**
   * Fix round 1, blocking finding: `{}` used to skip both the `.update()`
   * call and its `affectedRows === 0` existence check, while still
   * committing a `van_updated` row — a row claiming a change happened (and
   * even that the van exists) when neither was true. Fixed at the Zod
   * boundary (`vanPatchSchema`'s `.refine()`), so this is checked both for
   * a real van (no spurious audit row lands next to its `van_created` one)
   * and for an id that does not exist at all — the exact case from the
   * review.
   */
  it('rejects an empty patch instead of writing an audit row for nothing', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'EMP111' });
    created.vanIds.push(id);

    await expect(api.admin.vans.update({ id, patch: {} })).rejects.toThrow(/at least one/i);
    await expect(api.admin.vans.update({ id: 999_999, patch: {} })).rejects.toThrow(
      /at least one/i,
    );

    const rows = await auditRowsFor('van', id);
    expect(rows.map((r) => r.action)).toEqual(['van_created']);
  });

  /**
   * Fix round 1, addition 3: the review verified the `Date` <-> civil-date
   * conversion by inspection; nobody had watched a date actually survive
   * the trip. A one-day timezone slip here would silently move a service
   * due date, and the symptom would not show up until months later as a
   * van the dashboard thinks is fine but is actually overdue.
   */
  it('round-trips the four civil dates through create and list unchanged', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const dates = {
      lastService: '2026-02-15',
      nextService: '2026-08-15',
      orcrExpiry: '2027-03-01',
      franchiseExpiry: '2028-04-20',
    };
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'DATE111', ...dates });
    created.vanIds.push(id);

    const rows = await api.admin.vans.list();
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject(dates);
  });

  /**
   * Task T2 — `vehicleTypeId` is a required Zod field with no default, so a
   * `create` call missing it must be rejected as a validation failure
   * (BAD_REQUEST-shaped), never a 500.
   */
  it('rejects create with no vehicleTypeId', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const base = validVan();
    const withoutVehicleTypeId = {
      plate: 'NOVT111',
      model: base.model,
      capacity: base.capacity,
      // Present on purpose: `vehicleTypeId` must stay the ONLY field missing,
      // or this test stops proving which omission the refusal is about.
      luggageCapacity: base.luggageCapacity,
      odometer: base.odometer,
      lastService: base.lastService,
      nextService: base.nextService,
      orcrExpiry: base.orcrExpiry,
      franchiseNo: base.franchiseNo,
      franchiseExpiry: base.franchiseExpiry,
      repairNotes: base.repairNotes,
    };
    await expect(api.admin.vans.create(withoutVehicleTypeId as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('round-trips vehicleTypeId: the suv type through create and list', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({
      ...validVan(),
      plate: 'SUV111',
      vehicleTypeId: SUV_ID,
    });
    created.vanIds.push(id);

    const rows = await api.admin.vans.list();
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.vehicleTypeId).toBe(SUV_ID);
    expect(row?.vehicleTypeName).toBe('SUV');
  });

  /*
   * Before 2026-11-08, an invalid vehicle type was a Zod BAD_REQUEST
   * (`z.enum(VEHICLE_TYPES)`) — the enum made every bad value a shape error
   * before the database was ever asked. Now that `vehicleTypeId` is a bare
   * FK, an id answering to no row would otherwise reach
   * `vans_vehicle_type_id_vehicle_types_id_fk` as a raw `ER_NO_REFERENCED_ROW_2`
   * and rethrow as INTERNAL_SERVER_ERROR — this pins the restored
   * BAD_REQUEST, and that nothing was written for the refusal.
   */
  it('refuses create with a vehicleTypeId that answers to no row', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(
      api.admin.vans.create({ ...validVan(), plate: 'NOTYPE1', vehicleTypeId: 999_999 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const rows = await api.admin.vans.list();
    expect(rows.some((r) => r.plate === 'NOTYPE1')).toBe(false);
  });

  it('refuses update with a vehicleTypeId that answers to no row', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'NOTYPE2' });
    created.vanIds.push(id);

    await expect(
      api.admin.vans.update({ id, patch: { vehicleTypeId: 999_999 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const rows = await api.admin.vans.list();
    expect(rows.find((r) => r.id === id)?.vehicleTypeId).toBe(VAN_ID);
  });

  it("update's patch can change a van's vehicleTypeId from van to suv and back", async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...validVan(), plate: 'SWAP111' });
    created.vanIds.push(id);

    await api.admin.vans.update({ id, patch: { vehicleTypeId: SUV_ID } });
    let rows = await api.admin.vans.list();
    expect(rows.find((r) => r.id === id)?.vehicleTypeId).toBe(SUV_ID);

    await api.admin.vans.update({ id, patch: { vehicleTypeId: VAN_ID } });
    rows = await api.admin.vans.list();
    expect(rows.find((r) => r.id === id)?.vehicleTypeId).toBe(VAN_ID);
  });

  it('has no delete mutation — vans are soft-deleted through is_active', () => {
    // `_def.procedures` is not in tRPC v11's public types, so it needs the
    // cast the rest of this suite already uses — see
    // `checkout-router.test.ts:629` and `driver-lockout.test.ts:357`. Copy
    // that shape rather than inventing one.
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const vanProcedures = Object.keys(procedures)
      .filter((k) => /^admin\.vans\./.test(k))
      .sort();
    // Vacuity guard: a typo in the filter would make the comparison below
    // empty-vs-empty, which passes while proving nothing.
    expect(vanProcedures.length).toBe(4);
    expect(vanProcedures).toEqual([
      'admin.vans.create',
      'admin.vans.list',
      'admin.vans.setStatus',
      'admin.vans.update',
    ]);
  });
});
