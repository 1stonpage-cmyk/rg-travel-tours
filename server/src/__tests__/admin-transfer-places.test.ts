/**
 * `admin.transferPlaces.*` (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §1.2). A transfer
 * route used to be anchored on a single `destinations` row; it now runs
 * BETWEEN two admin-managed `transfer_places`, and this router is the CRUD
 * surface for that catalog.
 *
 * Gated `adminProcedure('toursPricing')` — the SAME owner-only area
 * `admin.transferRoutes.*` already uses, not a new `ROLE_MATRIX` row. This
 * file follows `admin-transfer-routes.test.ts`'s own pattern: a role test
 * per role per area (CLAUDE.md), and a procedure-enumeration guard against a
 * later task quietly adding a delete mutation.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { TransferPlaceType } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, destinations, transferPlaces, users } from '../db/schema';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  userIds: [] as number[],
  placeIds: [] as number[],
  destIds: [] as number[],
};

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `adtp_${role}_${suffix}@example.test`,
      passwordHash: '__adtp_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeDestination() {
  const slug = `__adtpdest__${unique()}`;
  const [row] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(row.insertId);
  return row.insertId;
}

/** Every audit row written against one place, oldest first. */
async function auditRowsFor(entityId: number) {
  return getDb()
    .select({ action: auditLog.action, actorType: auditLog.actorType, actorId: auditLog.actorId })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'transfer_place'), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

function validInput(overrides: Partial<{ name: string }> = {}) {
  return {
    name: `__adtpplace__${unique()}`,
    placeType: 'destination' as TransferPlaceType,
    destinationId: null,
    ...overrides,
  };
}

async function createPlace(
  overrides: Partial<{ name: string; destinationId: number | null }> = {},
) {
  const { id } = await ownerApi().admin.transferPlaces.create(validInput(overrides));
  created.placeIds.push(id);
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

  if (created.placeIds.length > 0) {
    await db
      .delete(auditLog)
      .where(
        and(eq(auditLog.entity, 'transfer_place'), inArray(auditLog.entityId, created.placeIds)),
      );
    await db.delete(transferPlaces).where(inArray(transferPlaces.id, created.placeIds));
  }
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
  }
});

describeWithDb('admin.transferPlaces', () => {
  /* ------------------------------------------------------------------ *
   * The gate, per role, per procedure.
   * ------------------------------------------------------------------ */

  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.transferPlaces.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(1) as never);
    await expect(api.admin.transferPlaces.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES ${role} on every procedure — §9 gives tours/pricing to the owner alone`, async () => {
      const api = appRouter.createCaller(
        staffContext(role === 'dispatcher' ? dispatcherId : financeId, role) as never,
      ).admin.transferPlaces;
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
    await expect(ownerApi().admin.transferPlaces.list()).resolves.toBeInstanceOf(Array);
  });

  /* ------------------------------------------------------------------ *
   * Create / list.
   * ------------------------------------------------------------------ */

  it('round-trips every field through create and list, with no cross-link by default', async () => {
    const input = validInput({ name: `__adtpplace__airport-${unique()}` });
    const id = await createPlace({ ...input, destinationId: null });

    const row = (await ownerApi().admin.transferPlaces.list()).find((r) => r.id === id);
    expect(row).toMatchObject({ name: input.name, placeType: 'destination', isActive: true });
    expect(row?.destinationId).toBeNull();
  });

  it('round-trips the optional destinationId cross-link', async () => {
    const destinationId = await makeDestination();
    const id = await createPlace({ destinationId } as never);
    const row = (await ownerApi().admin.transferPlaces.list()).find((r) => r.id === id);
    expect(row?.destinationId).toBe(destinationId);
  });

  it('refuses an unknown destinationId with BAD_REQUEST, not a foreign-key 500', async () => {
    await expect(
      ownerApi().admin.transferPlaces.create({ ...validInput(), destinationId: 999_999_999 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a duplicate name (case/whitespace-insensitive) with CONFLICT', async () => {
    const name = `__adtpplace__dup-${unique()}`;
    await createPlace({ name });
    const clash = ownerApi().admin.transferPlaces.create(
      validInput({ name: `  ${name.toUpperCase()}  ` }),
    );
    await expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(clash).rejects.toThrow(/already/i);
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    await expect(
      ownerApi().admin.transferPlaces.create({ ...validInput(), isActive: false } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /* ------------------------------------------------------------------ *
   * Update.
   * ------------------------------------------------------------------ */

  it('refuses an empty patch instead of writing an audit row for nothing', async () => {
    const id = await createPlace();
    await expect(ownerApi().admin.transferPlaces.update({ id, patch: {} })).rejects.toThrow(
      /at least one/i,
    );
    expect((await auditRowsFor(id)).map((r) => r.action)).toEqual(['transfer_place_created']);
  });

  it("rejects an unknown field in update's patch instead of silently stripping it", async () => {
    const id = await createPlace();
    await expect(
      ownerApi().admin.transferPlaces.update({
        id,
        patch: { name: 'Updated name', isActive: false } as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers NOT_FOUND for an id no place holds', async () => {
    await expect(
      ownerApi().admin.transferPlaces.update({ id: 999_999_999, patch: { name: 'Nope' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      ownerApi().admin.transferPlaces.setActive({ id: 999_999_999, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("refuses an update's unknown destinationId with BAD_REQUEST before writing anything", async () => {
    const id = await createPlace();
    await expect(
      ownerApi().admin.transferPlaces.update({ id, patch: { destinationId: 999_999_999 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /* ------------------------------------------------------------------ *
   * setActive — the soft delete.
   * ------------------------------------------------------------------ */

  it('retires a place without deleting it, and its name stays taken', async () => {
    const name = `__adtpplace__retire-${unique()}`;
    const id = await createPlace({ name });

    await ownerApi().admin.transferPlaces.setActive({ id, isActive: false });

    const row = (await ownerApi().admin.transferPlaces.list()).find((r) => r.id === id);
    expect(
      row,
      'a retired place must stay on the admin list — it is the only place to revive it',
    ).toBeDefined();
    expect(row?.isActive).toBe(false);

    await expect(
      ownerApi().admin.transferPlaces.create(validInput({ name })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await ownerApi().admin.transferPlaces.setActive({ id, isActive: true });
    expect((await ownerApi().admin.transferPlaces.list()).find((r) => r.id === id)?.isActive).toBe(
      true,
    );
  });

  /* ------------------------------------------------------------------ *
   * The audit trail and the procedure list.
   * ------------------------------------------------------------------ */

  it('writes an audit row naming the actor on every change', async () => {
    const id = await createPlace();
    await ownerApi().admin.transferPlaces.update({ id, patch: { placeType: 'airport' } });
    await ownerApi().admin.transferPlaces.setActive({ id, isActive: false });

    const rows = await auditRowsFor(id);
    expect(rows.map((r) => r.action)).toEqual([
      'transfer_place_created',
      'transfer_place_updated',
      'transfer_place_active_changed',
    ]);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([ownerId]));
    expect(new Set(rows.map((r) => r.actorType))).toEqual(new Set(['user']));
  });

  it('has no delete mutation — places are soft-deleted through is_active', () => {
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const paths = Object.keys(procedures)
      .filter((key) => /^admin\.transferPlaces\./.test(key))
      .sort();
    expect(paths.length).toBe(4);
    expect(paths).toEqual([
      'admin.transferPlaces.create',
      'admin.transferPlaces.list',
      'admin.transferPlaces.setActive',
      'admin.transferPlaces.update',
    ]);
  });
});
