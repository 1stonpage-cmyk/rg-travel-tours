/**
 * Week 6.5, Task 4 (D4, owner-decided 2026-10-16) — deactivating a driver
 * ends their sessions.
 *
 * `requireDriver` reads the session and never re-reads `drivers.is_active`,
 * so before this task a driver switched off mid-shift kept up to twelve hours
 * of access (measured on the wire 2026-10-16). The fix is revocation at the
 * write: `admin.drivers.setActive` deletes every session the driver holds in
 * the SAME transaction as the `is_active` write.
 *
 * This file is the end-to-end session story and is deliberately separate from
 * `admin-drivers.test.ts` (which owns the router's role, validation and audit
 * tests): it is the owner's named test and should be findable by name.
 *
 * The first test goes over real HTTP through `createApp()` — log in, prove the
 * cookie works, deactivate, prove the NEXT request with the same cookie is
 * refused. "Prove the cookie worked first" is not decoration: a test that only
 * asserts the 401 after deactivation passes just as happily for a cookie that
 * never worked.
 *
 * Fixtures are committed and removed in `afterAll`; `global-setup.ts` fails
 * the run by name if `drivers`, `users`, `bookings` or `vans` end with rows
 * nobody cleaned up.
 */
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createApp } from '../app';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, drivers, sessions, users } from '../db/schema';
import * as auditService from '../services/audit';
import { hashPassword } from '../services/password';
import { createSession, readSession, revokeSessionsForSubject } from '../services/sessions';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Every direct session decision is made against this instant, never the clock. */
const NOW = new Date('2026-10-15T04:00:00Z');

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  driverIds: [] as number[],
  userIds: [] as number[],
  /** `sessions.id`s inserted raw (the polymorphic-key fixture), so teardown can remove them. */
  rawSessionTokenHashes: [] as string[],
};

let ownerId = 0;

async function makeStaff(role: 'owner') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Deactivation ${role} ${suffix}`,
      email: `deact_${role}_${suffix}@example.test`,
      passwordHash: '__deactivation_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** A driver who can really sign in: random PIN, real scrypt hash. */
async function makeDriverWithPin() {
  const suffix = unique();
  const code = `DD${suffix}`.slice(0, 20);
  const pin = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Deactivation Fixture ${suffix}`,
      code,
      phone: '09170000000',
      pinHash: await hashPassword(pin),
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return { code, pin, driverId: row.insertId };
}

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);

async function isActive(driverId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (!row) throw new Error(`no driver ${driverId}`);
  return row.isActive;
}

async function sessionCount(subjectType: 'user' | 'driver' | 'customer', subjectId: number) {
  const rows = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)));
  return rows.length;
}

async function auditRowsFor(driverId: number) {
  return getDb()
    .select({ action: auditLog.action, actorId: auditLog.actorId, data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'driver'), eq(auditLog.entityId, driverId)))
    .orderBy(asc(auditLog.id));
}

/** Logs in over HTTP and returns the cookie header exactly as a browser would replay it. */
async function loginOverHttp(app: ReturnType<typeof createApp>, code: string, pin: string) {
  const res = await request(app)
    .post('/trpc/driver.login')
    // A browser's Origin: the CSRF check runs ahead of the router.
    .set('Origin', 'http://localhost:5180')
    .send({ code, pin });
  expect(res.status, 'the driver could not sign in at all').toBe(200);
  const cookie = res.headers['set-cookie'];
  expect(cookie, 'a successful login set no cookie').toBeDefined();
  return cookie as unknown as string[];
}

const getTrips = (app: ReturnType<typeof createApp>, cookie: string[]) =>
  request(app).get('/trpc/driver.trips').set('Cookie', cookie);

beforeAll(async () => {
  ownerId = await makeStaff('owner');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();
  if (created.rawSessionTokenHashes.length > 0) {
    await db.delete(sessions).where(inArray(sessions.tokenHash, created.rawSessionTokenHashes));
  }
  if (created.driverIds.length > 0) {
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'driver'), inArray(auditLog.entityId, created.driverIds)));
    await db
      .delete(sessions)
      .where(
        and(eq(sessions.subjectType, 'driver'), inArray(sessions.subjectId, created.driverIds)),
      );
    await db.delete(drivers).where(inArray(drivers.id, created.driverIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('deactivating a driver ends their sessions', () => {
  it('the very next request with the old cookie is UNAUTHORIZED', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    const app = createApp();
    const cookie = await loginOverHttp(app, code, pin);

    // Proof the cookie worked BEFORE, or the 401 below proves nothing.
    await getTrips(app, cookie).expect(200);

    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: false });

    const after = await getTrips(app, cookie);
    // tRPC maps UNAUTHORIZED to HTTP 401 (measured, not assumed).
    expect(after.status).toBe(401);
    expect(after.body.error?.data?.code).toBe('UNAUTHORIZED');
  }, 30_000);

  it('deletes every session that driver had, and only theirs', async () => {
    const { driverId } = await makeDriverWithPin();
    const { driverId: otherDriverId } = await makeDriverWithPin();

    const mine = [
      await createSession('driver', driverId, NOW),
      await createSession('driver', driverId, NOW),
    ];
    const otherDriver = await createSession('driver', otherDriverId, NOW);
    const staff = await createSession('user', ownerId, NOW);

    // `subject_id` is polymorphic and carries no FK, so a `user` row whose id
    // happens to equal the driver's id is a real possibility in production.
    // Plant one directly: the TYPE is half of the key, and this is the only
    // way to prove the delete respects it.
    const rawHash = `deact_${unique()}`.padEnd(64, '0').slice(0, 64);
    await getDb()
      .insert(sessions)
      .values({
        subjectType: 'user',
        subjectId: driverId,
        tokenHash: rawHash,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
      });
    created.rawSessionTokenHashes.push(rawHash);
    const userRowsBefore = await sessionCount('user', driverId);
    expect(userRowsBefore).toBe(1);

    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: false });

    for (const session of mine) expect(await readSession(session.token, NOW)).toBeNull();
    expect(await sessionCount('driver', driverId)).toBe(0);
    expect(await readSession(otherDriver.token, NOW)).not.toBeNull();
    expect(await readSession(staff.token, NOW)).not.toBeNull();
    expect(await sessionCount('user', driverId)).toBe(userRowsBefore);
  }, 30_000);

  it('revokes in the SAME transaction: a rollback after the delete revokes nothing (service level)', async () => {
    const { driverId } = await makeDriverWithPin();
    const session = await createSession('driver', driverId, NOW);

    await expect(
      getDb().transaction(async (tx) => {
        await revokeSessionsForSubject(tx, 'driver', driverId);
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');

    expect(await readSession(session.token, NOW)).not.toBeNull();
  }, 30_000);

  it('revokes in the SAME transaction: a failure after the revoke leaves the driver active AND signed in (router level)', async () => {
    const { driverId } = await makeDriverWithPin();
    const session = await createSession('driver', driverId, NOW);

    // Make the LAST statement of the transaction (the audit write) fail, after
    // the `is_active` update and the session delete have both run.
    const spy = vi.spyOn(auditService, 'writeAudit').mockRejectedValueOnce(new Error('audit down'));
    try {
      await expect(
        ownerApi().admin.drivers.setActive({ id: driverId, isActive: false }),
      ).rejects.toThrow('audit down');
    } finally {
      spy.mockRestore();
    }

    expect(await isActive(driverId)).toBe(true);
    expect(await readSession(session.token, NOW)).not.toBeNull();
    expect(await auditRowsFor(driverId)).toEqual([]);
  }, 30_000);

  it('audits how many sessions it ended, and who did it', async () => {
    const { driverId } = await makeDriverWithPin();
    await createSession('driver', driverId, NOW);
    await createSession('driver', driverId, NOW);

    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: false });

    const rows = await auditRowsFor(driverId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'driver.deactivated',
      actorId: ownerId,
      data: { isActive: false, sessionsRevoked: 2 },
    });
  }, 30_000);

  it('reactivation works, revokes nothing, and does not resurrect old sessions', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    const app = createApp();
    const oldCookie = await loginOverHttp(app, code, pin);
    await getTrips(app, oldCookie).expect(200);

    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: false });
    await getTrips(app, oldCookie).expect(401);

    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: true });
    expect(await isActive(driverId)).toBe(true);

    // The OLD cookie stays dead: reactivation does not bring sessions back.
    await getTrips(app, oldCookie).expect(401);

    // A fresh sign-in works.
    const freshCookie = await loginOverHttp(app, code, pin);
    await getTrips(app, freshCookie).expect(200);

    // And reactivating a driver who is ALREADY back must not log them out.
    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: true });
    await getTrips(app, freshCookie).expect(200);

    const rows = await auditRowsFor(driverId);
    expect(rows.map((r) => r.action)).toEqual([
      'driver.deactivated',
      'driver.reactivated',
      'driver.reactivated',
    ]);
    // Reactivation revoked zero sessions, both times.
    expect(rows[1]?.data).toMatchObject({ isActive: true, sessionsRevoked: 0 });
    expect(rows[2]?.data).toMatchObject({ isActive: true, sessionsRevoked: 0 });
  }, 60_000);

  it('a driver who was not signed in anywhere deactivates cleanly with zero revoked', async () => {
    const { driverId } = await makeDriverWithPin();
    await ownerApi().admin.drivers.setActive({ id: driverId, isActive: false });
    expect(await isActive(driverId)).toBe(false);
    expect((await auditRowsFor(driverId))[0]?.data).toMatchObject({ sessionsRevoked: 0 });
  }, 30_000);
});
