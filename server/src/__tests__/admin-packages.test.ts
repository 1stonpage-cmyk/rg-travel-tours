/**
 * Week 7 plan, Task 13 — 7C: `admin.packages.*`, `admin.inquiries.*` and
 * `admin.newsletter.export` (BUILD_SPEC §9 "Packages, inquiries" and
 * "Users, settings", server half).
 *
 * **The load-bearing assertions are the two role boundaries**, because this
 * task is the one that added a `ROLE_MATRIX` row:
 *
 *  1. Owner and dispatcher both work on packages and enquiries; **finance is
 *     refused on every one of them** — and refused by the GATE, so nothing
 *     moves and nothing is audited.
 *  2. **Dispatcher AND finance are both refused on the newsletter export**, which
 *     is a different area (`usersSettings`, owner only). The same screen, two
 *     gates: a dispatcher who may read one guest's enquiry may not take the
 *     whole subscriber list away in a file (RA 10173; owner decision
 *     2026-10-23, Q3, option c).
 *
 * Everything else here is the fence around those two: the enquiry list joins
 * the package title and is newest first, a status change audits exactly once, a
 * package is deactivated and never deleted, and **the export's audit row
 * records who exported how many addresses and not one address**.
 *
 * Role refusals are asserted on `code`, never on the message — the pattern
 * `admin-coupons.test.ts` and `reviews-moderation.test.ts` already follow,
 * because `requireRole()` throws messages that name neither UNAUTHORIZED nor
 * FORBIDDEN and a regex on prose can pass against broken code.
 *
 * **Teardown.** None of `packages`, `inquiries` or `newsletter_subscribers` is
 * in the leak detector's `LEAK_TABLES`, so every row this file makes is tracked
 * by id AND swept by prefix. The two catch different failures: the ids catch the
 * rows the tests meant to make, and the prefix sweep catches the ones a BROKEN
 * build made — a role gate that let a refused `create` through writes a package
 * nothing tracked, and `packages.slug` is UNIQUE, so one stray row makes the
 * next run's duplicate test pass for the wrong reason. Removal is in FK order:
 * audit rows, inquiries (they reference packages), packages, subscribers, users.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { manilaCivilDate, NEWSLETTER_CSV_HEADER, type InquiryStatus } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, inquiries, newsletterSubscribers, packages, users } from '../db/schema';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** Every package this file creates carries it, so the sweep in `afterAll` finds them. */
const SLUG_PREFIX = 'admpkg-';

/** Every enquiry and subscriber this file creates carries it, for the same reason. */
const EMAIL_PREFIX = 'admpkg_';

/** An id no package and no enquiry in this database ever has. */
const NOT_FOUND_SENTINEL_ID = 2_000_000_200;

/** `audit_log.entity` for a package, an enquiry, and the subscriber list. */
const PACKAGE_ENTITY = 'packages';
const INQUIRY_ENTITY = 'inquiries';
const NEWSLETTER_ENTITY = 'newsletter';

/**
 * The resolvers' own refusal sentences, asserted beside the `NOT_FOUND` code.
 *
 * Both are needed because an UNMOUNTED tRPC procedure throws `NOT_FOUND` too,
 * so a code-only assertion passes against a router that does not have this
 * surface on it at all — measured while this suite was red.
 */
const PACKAGE_NOT_FOUND_MESSAGE = 'No package with that id.';
const INQUIRY_NOT_FOUND_MESSAGE = 'No enquiry with that id.';

const created = {
  userIds: [] as number[],
  packageIds: [] as number[],
  inquiryIds: [] as number[],
  subscriberIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const dispatcherApi = () =>
  appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
const financeApi = () => appRouter.createCaller(staffContext(financeId, 'finance') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Packages ${role} ${suffix}`,
      email: `${EMAIL_PREFIX}${role}_${suffix}@example.test`,
      passwordHash: '__admpkg_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** Every field `packageCreateInput` requires, as a plausible 3-day package. */
function packageInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: `${SLUG_PREFIX}${unique()}`,
    title: 'Camotes Islands Escape',
    days: 3,
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
    description: 'Three days across Camotes, with the van and the ferry included.',
    imagePath: '/placeholders/package-camotes.svg',
    imageAlt: 'A white sand beach on Camotes with a parked van behind it',
    highlights: ['Santiago Bay', 'Bukilat Cave', 'Lake Danao'],
    sortOrder: 10,
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
    ...overrides,
  };
}

/** Creates a package through the real mutation and tracks it for teardown. */
async function createPackage(overrides: Record<string, unknown> = {}) {
  const input = packageInput(overrides);
  const { id } = await ownerApi().admin.packages.create(input as never);
  created.packageIds.push(id);
  return { id, input };
}

/**
 * An enquiry row written through the PUBLIC mutation that already owns this
 * table — never a direct INSERT where the public path can be used instead.
 * This task adds no writer to `inquiries`, and a fixture that invented one
 * would be testing a path nothing ships.
 */
async function createInquiry(
  opts: { packageId?: number | null; name?: string; message?: string } = {},
) {
  const suffix = unique();
  const email = `${EMAIL_PREFIX}guest_${suffix}@example.test`;
  await publicApi().inquiries.create({
    type: opts.packageId ? 'package' : 'contact',
    // `inquiryInput.packageId` is OPTIONAL, not nullable — a general contact
    // enquiry omits it rather than sending null.
    ...(opts.packageId ? { packageId: opts.packageId } : {}),
    name: opts.name ?? 'Maria Santos',
    email,
    phone: '09170000000',
    message: opts.message ?? `Is the van air-conditioned? ${suffix}`,
    // RA 10173: the public form cannot submit without it.
    consent: true,
  });
  const [row] = await getDb()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.email, email));
  const id = row?.id ?? 0;
  created.inquiryIds.push(id);
  return { id, email };
}

/** A subscriber row, likewise through the public mutation that owns the table. */
async function subscribe() {
  const email = `${EMAIL_PREFIX}sub_${unique()}@example.test`;
  await publicApi().newsletter.subscribe({ email });
  const [row] = await getDb()
    .select({ id: newsletterSubscribers.id })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email));
  created.subscriberIds.push(row?.id ?? 0);
  return email;
}

async function packageRow(id: number) {
  const [row] = await getDb().select().from(packages).where(eq(packages.id, id));
  return row;
}

async function inquiryRow(id: number) {
  const [row] = await getDb().select().from(inquiries).where(eq(inquiries.id, id));
  return row;
}

async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(auditLog.id);
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();

  const packageEntityIds = [...created.packageIds, NOT_FOUND_SENTINEL_ID];
  const inquiryEntityIds = [...created.inquiryIds, NOT_FOUND_SENTINEL_ID];
  await db
    .delete(auditLog)
    .where(and(eq(auditLog.entity, PACKAGE_ENTITY), inArray(auditLog.entityId, packageEntityIds)));
  await db
    .delete(auditLog)
    .where(and(eq(auditLog.entity, INQUIRY_ENTITY), inArray(auditLog.entityId, inquiryEntityIds)));
  /*
   * The export's audit rows carry no entity id of their own (the list has no
   * numeric id), so they are keyed by ACTOR — this file's three staff users,
   * which nothing else in the run shares.
   */
  if (created.userIds.length > 0) {
    await db
      .delete(auditLog)
      .where(
        and(eq(auditLog.entity, NEWSLETTER_ENTITY), inArray(auditLog.actorId, created.userIds)),
      );
  }

  // Inquiries before packages: `inquiries.package_id` references `packages.id`.
  await db.delete(inquiries).where(like(inquiries.email, `${EMAIL_PREFIX}%`));
  await db.delete(packages).where(like(packages.slug, `${SLUG_PREFIX}%`));
  await db
    .delete(newsletterSubscribers)
    .where(like(newsletterSubscribers.email, `${EMAIL_PREFIX}%`));

  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/* ------------------------------------------------------------------ *
 * admin.packages — the editing surface
 * ------------------------------------------------------------------ */

describeWithDb('admin.packages.list', () => {
  it('lists every package, inactive ones included, with its enquiry count', async () => {
    const { id, input } = await createPackage({ sortOrder: 11 });
    await createInquiry({ packageId: id });
    await createInquiry({ packageId: id });

    const mine = (await ownerApi().admin.packages.list()).find((row) => row.id === id);
    expect(mine, 'the package must be in the admin list').toBeDefined();
    expect(mine).toMatchObject({
      slug: input.slug,
      title: 'Camotes Islands Escape',
      days: 3,
      oldPriceCentavos: 1_250_000,
      newPriceCentavos: 980_000,
      isActive: true,
      inquiryCount: 2,
      highlights: ['Santiago Bay', 'Bukilat Cave', 'Lake Danao'],
    });
  });

  it('is the only place a DEACTIVATED package is visible at all', async () => {
    const { id, input } = await createPackage();
    await ownerApi().admin.packages.setActive({ id, isActive: false });

    // The public catalog cannot see it.
    expect((await publicApi().packages.list()).some((row) => row.slug === input.slug)).toBe(false);
    await expect(publicApi().packages.bySlug({ slug: input.slug })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // The admin list still can, which is how it gets switched back on.
    const mine = (await ownerApi().admin.packages.list()).find((row) => row.id === id);
    expect(mine).toMatchObject({ isActive: false });
  });

  it('reports zero enquiries for a package nobody has asked about', async () => {
    const { id } = await createPackage();
    const mine = (await ownerApi().admin.packages.list()).find((row) => row.id === id);
    expect(mine).toMatchObject({ inquiryCount: 0 });
  });
});

describeWithDb('admin.packages.create and .update', () => {
  it('creates a package the public catalog then serves, and audits it once', async () => {
    const { id, input } = await createPackage();

    const row = await packageRow(id);
    expect(row).toMatchObject({ slug: input.slug, newPriceCentavos: 980_000, isActive: true });

    const published = await publicApi().packages.bySlug({ slug: input.slug });
    expect(published).toMatchObject({ title: 'Camotes Islands Escape', newPriceCentavos: 980_000 });

    const audit = await auditRowsFor(PACKAGE_ENTITY, id);
    expect(audit.map((entry) => entry.action)).toEqual(['package.created']);
    expect(audit[0]).toMatchObject({ actorType: 'user', actorId: ownerId });
    expect(audit[0]!.data).toMatchObject({
      slug: input.slug,
      newPriceCentavos: 980_000,
      oldPriceCentavos: 1_250_000,
    });
  });

  it('replaces every editable column on a save, and audits the new money', async () => {
    const { id, input } = await createPackage();

    await expect(
      ownerApi().admin.packages.update({
        ...packageInput({ slug: input.slug }),
        id,
        title: 'Camotes Islands Escape (4 days)',
        days: 4,
        oldPriceCentavos: null,
        newPriceCentavos: 1_150_000,
        description: null,
        highlights: null,
      } as never),
    ).resolves.toEqual({ ok: true });

    expect(await packageRow(id)).toMatchObject({
      title: 'Camotes Islands Escape (4 days)',
      days: 4,
      oldPriceCentavos: null,
      newPriceCentavos: 1_150_000,
      description: null,
    });

    const audit = await auditRowsFor(PACKAGE_ENTITY, id);
    expect(audit.map((entry) => entry.action)).toEqual(['package.created', 'package.updated']);
    expect(audit[1]!.data).toMatchObject({ newPriceCentavos: 1_150_000, oldPriceCentavos: null });
  });

  it('REFUSES a price that is not integer centavos', async () => {
    for (const newPriceCentavos of [9_800.5, -100, '980000']) {
      await expect(
        ownerApi().admin.packages.create(packageInput({ newPriceCentavos }) as never),
        `a price of ${String(newPriceCentavos)} was accepted`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('REFUSES a "was" price that is not higher than the price charged', async () => {
    await expect(
      ownerApi().admin.packages.create(
        packageInput({ oldPriceCentavos: 980_000, newPriceCentavos: 980_000 }) as never,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('REFUSES an image with no alt text', async () => {
    await expect(
      ownerApi().admin.packages.create(
        packageInput({ imagePath: '/placeholders/p.svg', imageAlt: null }) as never,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('REFUSES an unknown field, so isActive cannot be smuggled into a save', async () => {
    await expect(
      ownerApi().admin.packages.create(packageInput({ isActive: false }) as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers CONFLICT for a slug another package already holds, and writes nothing', async () => {
    const { input } = await createPackage();
    const before = (await ownerApi().admin.packages.list()).length;

    await expect(
      ownerApi().admin.packages.create(packageInput({ slug: input.slug }) as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await ownerApi().admin.packages.list()).length).toBe(before);
  });

  /**
   * The message is asserted as well as the code, and that is not belt-and-braces:
   * an UNMOUNTED tRPC procedure also throws `NOT_FOUND`, so a test that checked
   * the code alone would pass against a router with no `admin.packages` on it at
   * all. (It did, while this suite was red.)
   */
  it('answers NOT_FOUND for an update to a package that does not exist, and audits nothing', async () => {
    await expect(
      ownerApi().admin.packages.update({
        ...packageInput(),
        id: NOT_FOUND_SENTINEL_ID,
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: PACKAGE_NOT_FOUND_MESSAGE });
    expect(await auditRowsFor(PACKAGE_ENTITY, NOT_FOUND_SENTINEL_ID)).toEqual([]);
  });
});

describeWithDb('a package can be deactivated but not deleted', () => {
  /** The brief's own words, and the rule CLAUDE.md states for every catalog row. */
  it('offers no delete mutation at all', () => {
    const paths = Object.keys(
      (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    );
    const packagePaths = paths.filter((path) => path.startsWith('admin.packages.'));
    expect(packagePaths.length, 'the packages namespace is not mounted').toBeGreaterThan(0);
    expect(packagePaths.filter((path) => /delete|remove|destroy/i.test(path))).toEqual([]);
  });

  it('keeps the row, its prices and its enquiries when it is switched off', async () => {
    const { id } = await createPackage();
    const inquiry = await createInquiry({ packageId: id });

    await expect(ownerApi().admin.packages.setActive({ id, isActive: false })).resolves.toEqual({
      ok: true,
    });

    const row = await packageRow(id);
    expect(row, 'the package row was removed rather than deactivated').toBeDefined();
    expect(row).toMatchObject({ isActive: false, newPriceCentavos: 980_000 });
    // The enquiry that pointed at it is untouched and still joined.
    const listed = (await ownerApi().admin.inquiries.list()).find((r) => r.id === inquiry.id);
    expect(listed).toMatchObject({ packageId: id, packageTitle: 'Camotes Islands Escape' });
  });

  it('is reversible, and audits each direction with its own action', async () => {
    const { id } = await createPackage();
    await ownerApi().admin.packages.setActive({ id, isActive: false });
    await ownerApi().admin.packages.setActive({ id, isActive: true });

    expect(await packageRow(id)).toMatchObject({ isActive: true });
    const audit = await auditRowsFor(PACKAGE_ENTITY, id);
    expect(audit.map((entry) => entry.action)).toEqual([
      'package.created',
      'package.deactivated',
      'package.reactivated',
    ]);
  });

  it('answers NOT_FOUND for a package that does not exist, and audits nothing', async () => {
    await expect(
      ownerApi().admin.packages.setActive({ id: NOT_FOUND_SENTINEL_ID, isActive: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: PACKAGE_NOT_FOUND_MESSAGE });
    expect(await auditRowsFor(PACKAGE_ENTITY, NOT_FOUND_SENTINEL_ID)).toEqual([]);
  });

  /**
   * 7N item 6, the same bug `admin.staffUsers.setActive` had: the `UPDATE`
   * and the audit row were both unconditional, so asking for the state the
   * row is already in wrote a `package.reactivated` or
   * `package.deactivated` row claiming a change that did not happen.
   * CLAUDE.md audits "every status change"; a non-change is not one, and a
   * trail that records non-events is one a reader stops believing.
   *
   * Both directions, because the bug was in both: a fresh package is active,
   * so `isActive: true` is the no-op for it, and `isActive: false` becomes
   * the no-op once it has been switched off.
   */
  it('writes NO audit row when the package is ALREADY in the state asked for', async () => {
    const { id } = await createPackage();
    expect(await packageRow(id)).toMatchObject({ isActive: true });

    await expect(ownerApi().admin.packages.setActive({ id, isActive: true })).resolves.toEqual({
      ok: true,
    });
    expect((await auditRowsFor(PACKAGE_ENTITY, id)).map((e) => e.action)).toEqual([
      'package.created',
    ]);

    await ownerApi().admin.packages.setActive({ id, isActive: false });
    await ownerApi().admin.packages.setActive({ id, isActive: false });
    expect((await auditRowsFor(PACKAGE_ENTITY, id)).map((e) => e.action)).toEqual([
      'package.created',
      'package.deactivated',
    ]);
    expect(await packageRow(id)).toMatchObject({ isActive: false });
  });
});

/* ------------------------------------------------------------------ *
 * admin.inquiries
 * ------------------------------------------------------------------ */

describeWithDb('admin.inquiries.list', () => {
  it('joins the package title when the enquiry names one, and leaves it null otherwise', async () => {
    const { id: packageId } = await createPackage({ title: 'Bantayan Island Weekend' });
    const about = await createInquiry({ packageId, name: 'Package Asker' });
    const general = await createInquiry({ packageId: null, name: 'General Asker' });

    const rows = await ownerApi().admin.inquiries.list();

    expect(rows.find((row) => row.id === about.id)).toMatchObject({
      type: 'package',
      packageId,
      packageTitle: 'Bantayan Island Weekend',
      name: 'Package Asker',
      status: 'new',
    });
    expect(rows.find((row) => row.id === general.id)).toMatchObject({
      type: 'contact',
      packageId: null,
      packageTitle: null,
      name: 'General Asker',
    });
  });

  /**
   * The ORDER is load-bearing: an office works the newest enquiry first.
   * `inquiries.created_at` is a MySQL `DATETIME` with second precision, so two
   * fixtures made in the same second share an instant and `id DESC` is the
   * only tiebreak that can make this assertion hold.
   */
  it('returns newest first', async () => {
    const first = await createInquiry({ name: 'Asked First' });
    const second = await createInquiry({ name: 'Asked Second' });

    const ids = (await ownerApi().admin.inquiries.list()).map((row) => row.id);
    expect(second).toBeDefined();
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    // And the fixture order really is what it claims to be.
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('carries the guest message, email and phone — the reason the screen exists', async () => {
    const { id, email } = await createInquiry({ message: 'Can you collect us from the pier?' });
    const mine = (await ownerApi().admin.inquiries.list()).find((row) => row.id === id);
    expect(mine).toMatchObject({
      email,
      phone: '09170000000',
      message: 'Can you collect us from the pier?',
    });
    expect(Number.isNaN(Date.parse(mine!.createdAt))).toBe(false);
  });
});

describeWithDb('admin.inquiries.setStatus', () => {
  it('walks an enquiry through read, replied and closed, and audits each move once', async () => {
    const { id } = await createInquiry();
    expect(await inquiryRow(id)).toMatchObject({ status: 'new' });

    for (const status of ['read', 'replied', 'closed'] as InquiryStatus[]) {
      await expect(ownerApi().admin.inquiries.setStatus({ id, status })).resolves.toEqual({
        ok: true,
      });
      expect(await inquiryRow(id)).toMatchObject({ status });
    }

    const audit = await auditRowsFor(INQUIRY_ENTITY, id);
    expect(audit.map((entry) => entry.action)).toEqual([
      'inquiry.status_changed',
      'inquiry.status_changed',
      'inquiry.status_changed',
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ actorType: 'user', actorId: ownerId });
    }
    expect(audit[0]!.data).toMatchObject({ from: 'new', to: 'read' });
    expect(audit[2]!.data).toMatchObject({ from: 'replied', to: 'closed' });
  });

  /**
   * Back to `new` is allowed, unlike a review's `pending` — see
   * `inquiryStatusInput`. It is the only way the "waiting" count can be put
   * right after somebody closes the wrong row.
   */
  it('can put a closed enquiry back to new', async () => {
    const { id } = await createInquiry();
    await ownerApi().admin.inquiries.setStatus({ id, status: 'closed' });
    await ownerApi().admin.inquiries.setStatus({ id, status: 'new' });
    expect(await inquiryRow(id)).toMatchObject({ status: 'new' });
  });

  /** RA 10173: the log is the record of who acted, not a second copy of the enquiry. */
  it('keeps the guest name, email, phone and message OUT of the audit row', async () => {
    const { id, email } = await createInquiry({
      name: 'Juan Dela Cruz',
      message: 'My number is 09170000000, please text me.',
    });
    await ownerApi().admin.inquiries.setStatus({ id, status: 'read' });

    const [entry] = await auditRowsFor(INQUIRY_ENTITY, id);
    const serialised = JSON.stringify(entry!.data);
    expect(serialised).not.toContain('Juan');
    expect(serialised).not.toContain(email);
    expect(serialised).not.toContain('09170000000');
    expect(serialised).not.toContain('please text me');
  });

  it('REFUSES a status outside the enum, at the Zod boundary', async () => {
    const { id } = await createInquiry();
    await expect(
      ownerApi().admin.inquiries.setStatus({ id, status: 'archived' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await inquiryRow(id)).toMatchObject({ status: 'new' });
  });

  it('answers NOT_FOUND for an enquiry that does not exist, and audits nothing', async () => {
    await expect(
      ownerApi().admin.inquiries.setStatus({ id: NOT_FOUND_SENTINEL_ID, status: 'read' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: INQUIRY_NOT_FOUND_MESSAGE });
    expect(await auditRowsFor(INQUIRY_ENTITY, NOT_FOUND_SENTINEL_ID)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The role gate — §9's `packagesInquiries` row is owner + dispatcher
 * ------------------------------------------------------------------ */

describeWithDb('admin.packages / admin.inquiries — who may work on them', () => {
  it('lets a DISPATCHER do all of it, because §9 gives them this row', async () => {
    const api = dispatcherApi();

    const input = packageInput();
    const { id } = await api.admin.packages.create(input as never);
    created.packageIds.push(id);

    await expect(api.admin.packages.update({ ...input, id, days: 5 } as never)).resolves.toEqual({
      ok: true,
    });
    await expect(api.admin.packages.setActive({ id, isActive: false })).resolves.toEqual({
      ok: true,
    });
    await expect(api.admin.packages.list()).resolves.toBeInstanceOf(Array);

    const inquiry = await createInquiry();
    await expect(api.admin.inquiries.list()).resolves.toBeInstanceOf(Array);
    await expect(
      api.admin.inquiries.setStatus({ id: inquiry.id, status: 'read' }),
    ).resolves.toEqual({ ok: true });

    // And the audit rows name the dispatcher, not the owner.
    const audit = await auditRowsFor(PACKAGE_ENTITY, id);
    for (const entry of audit) {
      expect(entry).toMatchObject({ actorType: 'user', actorId: dispatcherId });
    }
  });

  it('REFUSES a FINANCE user on every packages and inquiries procedure, and writes nothing', async () => {
    const { id: packageId, input } = await createPackage();
    const inquiry = await createInquiry({ packageId });
    const api = financeApi();

    const refusals = await Promise.all([
      api.admin.packages.list().catch((e: unknown) => e),
      api.admin.packages.create(packageInput() as never).catch((e: unknown) => e),
      api.admin.packages
        .update({ ...input, id: packageId, days: 9 } as never)
        .catch((e: unknown) => e),
      api.admin.packages.setActive({ id: packageId, isActive: false }).catch((e: unknown) => e),
      api.admin.inquiries.list().catch((e: unknown) => e),
      api.admin.inquiries.setStatus({ id: inquiry.id, status: 'closed' }).catch((e: unknown) => e),
    ]);

    expect(refusals).toHaveLength(6);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    }

    // Hiding a button is not access control: nothing moved.
    expect(await packageRow(packageId)).toMatchObject({ isActive: true, days: 3 });
    expect(await inquiryRow(inquiry.id)).toMatchObject({ status: 'new' });
    expect(await auditRowsFor(INQUIRY_ENTITY, inquiry.id)).toEqual([]);
    expect((await auditRowsFor(PACKAGE_ENTITY, packageId)).map((e) => e.action)).toEqual([
      'package.created',
    ]);
  });

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.packages.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(publicApi().admin.inquiries.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

/* ------------------------------------------------------------------ *
 * admin.newsletter.export — a DIFFERENT area: usersSettings, owner only
 * ------------------------------------------------------------------ */

describeWithDb('admin.newsletter.export', () => {
  it('returns a header row and one address per line, and says how many', async () => {
    const mine = [await subscribe(), await subscribe(), await subscribe()];

    const file = await ownerApi().admin.newsletter.export();

    const lines = file.csv.split(/\r?\n/);
    expect(lines[0], 'the file must start with a header row').toBe(NEWSLETTER_CSV_HEADER);
    const addresses = lines.slice(1);
    for (const email of mine) {
      expect(addresses, `${email} is missing from the export`).toContain(email);
    }
    // One address per line, and `count` is the number of lines after the header.
    expect(file.count).toBe(addresses.length);
    expect(file.count).toBeGreaterThanOrEqual(mine.length);
    expect(addresses.every((line) => line.includes('@'))).toBe(true);
    expect(file.filename).toBe(`travelsugbo-newsletter-${manilaCivilDate(new Date())}.csv`);
  });

  /**
   * THE one that matters most here. An export of every subscriber's address is
   * a disclosure of personal data (RA 10173), so it is an EVENT and it is
   * logged — but the log is read by a wider admin audience than the file, so it
   * records the actor and the count and not a single address.
   */
  it('audits WHO exported HOW MANY, and never the addresses themselves', async () => {
    const email = await subscribe();

    const file = await ownerApi().admin.newsletter.export();

    const rows = await getDb()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        data: auditLog.data,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entity, NEWSLETTER_ENTITY), eq(auditLog.actorId, ownerId)))
      .orderBy(auditLog.id);

    expect(rows.length, 'the export wrote no audit row').toBeGreaterThan(0);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ action: 'newsletter.exported', actorType: 'user' });
    expect(last.data).toMatchObject({ count: file.count });

    for (const row of rows) {
      const serialised = JSON.stringify(row.data);
      expect(serialised, 'an audit row carries a subscriber address').not.toContain(email);
      expect(serialised, 'an audit row carries an email address').not.toContain('@');
    }
  });

  /**
   * The second gate, and the reason this task was reviewed on its own. The
   * dispatcher who may read one guest's enquiry a line above is refused here.
   */
  it('REFUSES a dispatcher AND a finance user — §9 keeps this under Settings', async () => {
    await subscribe();

    for (const api of [dispatcherApi(), financeApi()]) {
      await expect(api.admin.newsletter.export()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    // Refused by the gate, so neither of them wrote an "exported" row either.
    const rows = await getDb()
      .select({ actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, NEWSLETTER_ENTITY),
          inArray(auditLog.actorId, [dispatcherId, financeId]),
        ),
      );
    expect(rows).toEqual([]);
  });

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.newsletter.export()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  /**
   * The export is gated on a different area from the screen it sits on, and
   * that is asserted against `ROLE_MATRIX` rather than against a literal — if
   * somebody moves the procedure to `packagesInquiries`, this goes red.
   */
  it('declares usersSettings, not packagesInquiries, in its procedure metadata', () => {
    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, { _def?: { meta?: unknown } }> };
      }
    )._def.procedures;
    const meta = procedures['admin.newsletter.export']?._def?.meta as
      { access?: string; area?: string } | undefined;
    expect(meta, 'admin.newsletter.export is not mounted').toBeDefined();
    expect(meta).toMatchObject({ access: 'admin', area: 'usersSettings' });

    const packagesMeta = procedures['admin.packages.list']?._def?.meta as
      { area?: string } | undefined;
    expect(packagesMeta).toMatchObject({ area: 'packagesInquiries' });
  });
});
