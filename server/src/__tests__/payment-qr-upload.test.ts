/**
 * `POST /api/payment-qr/upload` — owner decision 2026-10-28.
 *
 * R&G's owner has no way to copy a file onto the server, so the settings
 * screen's "QR image path" text field is replaced by an upload. This proves
 * the door, the same way `receipt-upload.test.ts` does for receipts: who may
 * push bytes through it, which bytes, how many, what gets stored, and what
 * gets audited.
 *
 * Driven through `createApp()` with `supertest`, never the router function
 * directly — the mount, the cookie parser, the origin check and the route
 * have to work together.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../app';
import { getDb, getPool } from '../db/client';
import { auditLog, settings, users } from '../db/schema';
import { paymentQrStorageDir } from '../routers/payment-qr';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { createSession } from '../services/sessions';
import { describeWithDb } from './helpers/db';

const ORIGIN = 'http://localhost:5180';

/** A real PNG header, so `storeQrImage`'s magic-byte check passes. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('qr-bytes'),
]);
/** PNG-shaped claim, nothing-shaped bytes. */
const NOT_PNG = Buffer.from('this is not an image at all');
/** A real PDF header — a legitimate receipt type, but not an allowed QR type. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('x'.repeat(64))]);

const created = { userIds: [] as number[] };

/** Stands in for the image R&G already had configured before any test runs. */
const OLD_NAME = 'existingoldqrfilenameaaaaaaaaaa.png';

/** The seeded `payment_qr` row, restored after every test that changes it. */
let before: unknown;

async function readQrRow(): Promise<unknown> {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'payment_qr'));
  return row?.value;
}

async function writeQrRow(value: unknown): Promise<void> {
  await getDb().update(settings).set({ value }).where(eq(settings.key, 'payment_qr'));
}

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `QR Upload ${role} ${unique}`,
      email: `qrupload_${role}_${unique}@example.test`,
      passwordHash: '__qrupload_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  const { token } = await createSession('user', row.insertId, new Date());
  return { userId: row.insertId, token };
}

/** One upload, shaped the way the browser will send it. */
function upload(
  app: ReturnType<typeof createApp>,
  token: string | null,
  body: Buffer = PNG,
  contentType = 'image/png',
  filename = 'qr.png',
) {
  const req = request(app)
    .post(`/api/payment-qr/upload?${new URLSearchParams({ filename }).toString()}`)
    .set('Origin', ORIGIN)
    .set('Content-Type', contentType);
  if (token) req.set('Cookie', `${SESSION_COOKIE}=${token}`);
  return req.send(body);
}

const storedFiles = async () => (await readdir(paymentQrStorageDir())).length;

async function qrAuditRows() {
  if (created.userIds.length === 0) return [];
  return getDb()
    .select({ action: auditLog.action, entityId: auditLog.entityId, data: auditLog.data })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'payment_qr.image_uploaded'),
        inArray(auditLog.actorId, created.userIds),
      ),
    )
    .orderBy(auditLog.id);
}

/** The known starting block every test begins from. */
const FIXTURE_BLOCK = {
  imagePath: OLD_NAME,
  accountName: 'R&G Travel & Tours',
  accountNumber: '0917-555-0134',
  instructions: null,
  isConfigured: true,
};

beforeAll(async () => {
  before = await readQrRow();
  // A known, deterministic starting block — configured, with an old image
  // actually ON DISK — so "kept, not deleted" and "audited old vs new" both
  // have something concrete to assert against.
  await writeQrRow(FIXTURE_BLOCK);
  await mkdir(paymentQrStorageDir(), { recursive: true });
  await writeFile(join(paymentQrStorageDir(), OLD_NAME), PNG);
}, 60_000);

afterEach(async () => {
  // Every test leaves the row exactly as `beforeAll` set it, so the next one
  // starts from the same known state.
  await writeQrRow(FIXTURE_BLOCK);
});

afterAll(async () => {
  if (before !== undefined) await writeQrRow(before);
  await rm(join(paymentQrStorageDir(), OLD_NAME), { force: true });

  const pool = getPool();
  if (created.userIds.length > 0) {
    await getDb()
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.action, 'payment_qr.image_uploaded'),
          inArray(auditLog.actorId, created.userIds),
        ),
      );
    for (const id of created.userIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'user',
        id,
      ]);
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
  }
});

describeWithDb('POST /api/payment-qr/upload', () => {
  it('REFUSES a body that is not an allowed image type, and stores nothing', async () => {
    const { token } = await makeStaff('owner');
    const before1 = await storedFiles();

    const res = await upload(createApp(), token, NOT_PNG, 'image/png');

    expect(res.status).toBe(415);
    expect(await storedFiles(), 'a refused upload left a file behind').toBe(before1);
    expect(await readQrRow()).toMatchObject({ imagePath: OLD_NAME });
  });

  /** A PDF is a legitimate receipt type, but a QR is always an image — no PDF here. */
  it('REFUSES a PDF, even though it is a real file of its claimed type', async () => {
    const { token } = await makeStaff('owner');
    const before1 = await storedFiles();

    const res = await upload(createApp(), token, PDF, 'application/pdf', 'qr.pdf');

    expect(res.status).toBe(415);
    expect(await storedFiles()).toBe(before1);
  });

  it('REFUSES an image over 5MB, and stores nothing', async () => {
    const { token } = await makeStaff('owner');
    const before1 = await storedFiles();
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5 * 1024 * 1024 + 500, 1),
    ]);

    const res = await upload(createApp(), token, big, 'image/png');

    expect(res.status).toBe(413);
    expect(await storedFiles(), 'an oversize upload left a file behind').toBe(before1);
  });

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES a ${role} with FORBIDDEN, and writes nothing`, async () => {
      const { token } = await makeStaff(role);
      const before1 = await storedFiles();

      const res = await upload(createApp(), token);

      expect(res.status).toBe(403);
      expect(await storedFiles()).toBe(before1);
      expect(await readQrRow()).toMatchObject({ imagePath: OLD_NAME });
    });
  }

  it('REFUSES an anonymous caller', async () => {
    const res = await upload(createApp(), null);
    expect(res.status).toBe(401);
  });

  it('ACCEPTS an owner upload, storing a bare random filename and keeping the OLD file', async () => {
    const { token } = await makeStaff('owner');

    const res = await upload(createApp(), token, PNG, 'image/png', 'my qr.png');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const newName = res.body.imagePath as string;
    expect(newName).toMatch(/^[0-9a-f]{32}\.png$/);

    // Points at the new file now.
    expect(await readQrRow()).toMatchObject({ imagePath: newName });

    // The OLD file was never touched, let alone deleted — it is simply no
    // longer the one `settings.payment_qr.imagePath` points at.
    const files = await readdir(paymentQrStorageDir());
    expect(files).toContain(OLD_NAME);
    expect(files).toContain(newName);

    await rm(join(paymentQrStorageDir(), newName), { force: true });
  });

  it('writes ONE audit row naming the actor, the old filename and the new one', async () => {
    const { token, userId } = await makeStaff('owner');
    const auditBefore = (await qrAuditRows()).length;

    const res = await upload(createApp(), token, PNG, 'image/png');
    expect(res.status).toBe(200);
    const newName = res.body.imagePath as string;

    const rows = await qrAuditRows();
    expect(rows.length).toBe(auditBefore + 1);
    const row = rows.at(-1)!;
    expect(row.action).toBe('payment_qr.image_uploaded');
    expect(row.entityId).toBe(0);
    expect(row.data).toEqual({
      oldImagePath: OLD_NAME,
      newImagePath: newName,
    });

    const attributed = await getDb()
      .select({ actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'payment_qr.image_uploaded'), eq(auditLog.actorId, userId)));
    expect(attributed.length).toBeGreaterThan(0);
    for (const entry of attributed) {
      expect(entry).toMatchObject({ actorType: 'user', actorId: userId });
    }

    await rm(join(paymentQrStorageDir(), newName), { force: true });
  });
});
