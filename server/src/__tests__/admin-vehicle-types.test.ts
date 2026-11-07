/**
 * `admin.vehicleTypes.*` (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). Vehicle types
 * used to be a hard-coded `van`/`suv` enum; they are now an admin-managed
 * list, and this router is the CRUD surface for it.
 *
 * Gated `adminProcedure('toursPricing')` — the SAME owner-only area
 * `admin.transferRoutes.*` already uses, not a new `ROLE_MATRIX` row. This
 * file follows `admin-transfer-routes.test.ts`'s own pattern: a role test
 * per role per area (CLAUDE.md), and a procedure-enumeration guard against a
 * later task quietly adding a delete mutation.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, users, vehicleTypes } from '../db/schema';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
const uniqueSlug = () => `advt-${unique().replace('_', '-')}`;

const created = {
  userIds: [] as number[],
  vehicleTypeIds: [] as number[],
};

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `advt_${role}_${suffix}@example.test`,
      passwordHash: '__advt_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** Every audit row written against one vehicle type, oldest first. */
async function auditRowsFor(entityId: number) {
  return getDb()
    .select({ action: auditLog.action, actorType: auditLog.actorType, actorId: auditLog.actorId })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'vehicle_type'), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

function validInput(overrides: Partial<{ name: string; slug: string }> = {}) {
  return {
    name: 'Fixture Van',
    slug: uniqueSlug(),
    defaultSeats: 10,
    defaultLuggage: 8,
    ...overrides,
  };
}

async function createType(overrides: Partial<{ name: string; slug: string }> = {}) {
  const { id } = await ownerApi().admin.vehicleTypes.create(validInput(overrides));
  created.vehicleTypeIds.push(id);
  return id;
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();

  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }

  if (created.vehicleTypeIds.length > 0) {
    await db
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.entity, 'vehicle_type'),
          inArray(auditLog.entityId, created.vehicleTypeIds),
        ),
      );
    await db.delete(vehicleTypes).where(inArray(vehicleTypes.id, created.vehicleTypeIds));
  }
});

describeWithDb('admin.vehicleTypes', () => {
  /* ------------------------------------------------------------------ *
   * The gate, per role, per procedure.
   * ------------------------------------------------------------------ */

  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.vehicleTypes.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(1) as never);
    await expect(api.admin.vehicleTypes.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES ${role} on every procedure — §9 gives tours/pricing to the owner alone`, async () => {
      const api = appRouter.createCaller(
        staffContext(role === 'dispatcher' ? dispatcherId : financeId, role) as never,
      ).admin.vehicleTypes;
      await expect(api.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.create(validInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.update({ id: 1, patch: { name: 'Whatever' } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(api.setActive({ id: 1, isActive: false })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  }

  it('ALLOWS the owner', async () => {
    await expect(ownerApi().admin.vehicleTypes.list()).resolves.toBeInstanceOf(Array);
  });

  /* ------------------------------------------------------------------ *
   * Create / list.
   * ------------------------------------------------------------------ */

  it('round-trips every field through create and list', async () => {
    const input = validInput();
    const id = await createType(input);

    const row = (await ownerApi().admin.vehicleTypes.list()).find((r) => r.id === id);
    expect(row).toMatchObject({
      name: input.name,
      slug: input.slug,
      defaultSeats: 10,
      defaultLuggage: 8,
      isActive: true,
    });
  });

  it('accepts null defaultSeats/defaultLuggage — the two backfilled rows have none', async () => {
    const { id } = await ownerApi().admin.vehicleTypes.create({
      name: 'No Defaults',
      slug: uniqueSlug(),
      defaultSeats: null,
      defaultLuggage: null,
    });
    created.vehicleTypeIds.push(id);
    const row = (await ownerApi().admin.vehicleTypes.list()).find((r) => r.id === id);
    expect(row?.defaultSeats).toBeNull();
    expect(row?.defaultLuggage).toBeNull();
  });

  it('refuses a duplicate slug with CONFLICT, not a raw database error', async () => {
    const input = validInput();
    await createType(input);
    const clash = ownerApi().admin.vehicleTypes.create(validInput({ slug: input.slug }));
    await expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(clash).rejects.toThrow(/already/i);
  });

  it('refuses a slug that could not go in a URL', async () => {
    const malformed = ['Mini Van', 'mini_van', 'mini--van', '-mini-van', 'mini-van-'];
    for (const slug of malformed) {
      await expect(
        ownerApi().admin.vehicleTypes.create(validInput({ slug })),
        `"${slug}" was accepted as a vehicle-type slug`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    await expect(
      ownerApi().admin.vehicleTypes.create({ ...validInput(), isActive: false } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /* ------------------------------------------------------------------ *
   * Update.
   * ------------------------------------------------------------------ */

  it('refuses an empty patch instead of writing an audit row for nothing', async () => {
    const id = await createType();
    await expect(ownerApi().admin.vehicleTypes.update({ id, patch: {} })).rejects.toThrow(
      /at least one/i,
    );
    expect((await auditRowsFor(id)).map((r) => r.action)).toEqual(['vehicle_type_created']);
  });

  it("rejects an unknown field in update's patch instead of silently stripping it", async () => {
    const id = await createType();
    await expect(
      ownerApi().admin.vehicleTypes.update({
        id,
        patch: { name: 'Updated name', isActive: false } as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers NOT_FOUND for an id no vehicle type holds', async () => {
    await expect(
      ownerApi().admin.vehicleTypes.update({ id: 999_999_999, patch: { name: 'Nope' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      ownerApi().admin.vehicleTypes.setActive({ id: 999_999_999, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /* ------------------------------------------------------------------ *
   * setActive — the soft delete.
   * ------------------------------------------------------------------ */

  it('retires a vehicle type without deleting it, and its slug stays taken', async () => {
    const input = validInput();
    const id = await createType(input);

    await ownerApi().admin.vehicleTypes.setActive({ id, isActive: false });

    const row = (await ownerApi().admin.vehicleTypes.list()).find((r) => r.id === id);
    expect(
      row,
      'a retired type must stay on the admin list — it is the only place to revive it',
    ).toBeDefined();
    expect(row?.isActive).toBe(false);

    await expect(
      ownerApi().admin.vehicleTypes.create(validInput({ slug: input.slug })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await ownerApi().admin.vehicleTypes.setActive({ id, isActive: true });
    expect((await ownerApi().admin.vehicleTypes.list()).find((r) => r.id === id)?.isActive).toBe(
      true,
    );
  });

  /* ------------------------------------------------------------------ *
   * The audit trail and the procedure list.
   * ------------------------------------------------------------------ */

  it('writes an audit row naming the actor on every change', async () => {
    const id = await createType();
    await ownerApi().admin.vehicleTypes.update({ id, patch: { name: 'Renamed' } });
    await ownerApi().admin.vehicleTypes.setActive({ id, isActive: false });

    const rows = await auditRowsFor(id);
    expect(rows.map((r) => r.action)).toEqual([
      'vehicle_type_created',
      'vehicle_type_updated',
      'vehicle_type_active_changed',
    ]);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([ownerId]));
    expect(new Set(rows.map((r) => r.actorType))).toEqual(new Set(['user']));
  });

  it('has no delete mutation — vehicle types are soft-deleted through is_active', () => {
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const paths = Object.keys(procedures)
      .filter((key) => /^admin\.vehicleTypes\./.test(key))
      .sort();
    expect(paths.length).toBe(4);
    expect(paths).toEqual([
      'admin.vehicleTypes.create',
      'admin.vehicleTypes.list',
      'admin.vehicleTypes.setActive',
      'admin.vehicleTypes.update',
    ]);
  });
});
