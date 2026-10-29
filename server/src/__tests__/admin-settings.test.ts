/**
 * Week 7 plan, Task 9 — `admin.settings.*`: the first writer of a `settings`
 * row outside the seed (BUILD_SPEC §9 "Users, settings", server half).
 *
 * **Three things this suite exists to pin.**
 *
 *  1. **One validator, and it is `SETTING_SCHEMAS[key]`.** A block written past
 *     its own Zod shape is a block `readSettings()` then THROWS on — and
 *     `tours.list` throws with it, which is how BUG-023 took the public site
 *     down against the dev database. So every refusal test below also reads the
 *     row back and asserts it is byte-for-byte what it was: a refusal that
 *     wrote half a block is not a refusal.
 *  2. **`content_unverified` is cached for 60 seconds and gates whether Google
 *     may index this site at all.** The write must drop that cache in the SAME
 *     request, so the test primes the cache with the old answer first — without
 *     that priming the test would pass against a writer that never resets
 *     anything, because a cold cache reads the database anyway.
 *  3. **The audit row carries the KEY and never the VALUE.** `payment_qr` holds
 *     the account number a guest's money is sent to. `audit_log` is read by
 *     every admin in the UI and exported in reports (see `services/audit.ts`),
 *     so an account number in `data` is an account number published to
 *     everyone with any admin role — including the dispatcher this area
 *     refuses outright.
 *
 * **Teardown restores, it does not delete.** The test database is seeded with
 * all seventeen settings rows and `settings.test.ts`, `seo-*.test.ts`,
 * `sitemap-robots.test.ts` and `public-queries.test.ts` all read them;
 * `readSettings()` throws naming the first MISSING key, so deleting a row this
 * file touched would take those suites down with it. Every key is therefore
 * snapshotted before it is first mutated and written back in `afterAll` —
 * together with a final `resetContentUnverifiedCache()`, because the cached
 * flag outlives the row it was read from.
 *
 * Role refusals assert on `code`, never on the message: `requireRole()`'s
 * sentences name neither UNAUTHORIZED nor FORBIDDEN, so a regex on prose can
 * pass against broken code (the pattern `admin-coupons.test.ts` follows).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { SETTING_KEYS as SHARED_SETTING_KEYS } from '@rg/shared';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import { auditLog, settings, users } from '../db/schema';
import { readContentUnverified, resetContentUnverifiedCache } from '../content/settings';
import { SETTING_KEYS } from '../content/settings-schema';
import { writeSettingBlock } from '../content/settings-write';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const created = { userIds: [] as number[] };

/**
 * The stored value of every key this file has mutated, read BEFORE the first
 * mutation and written back in `afterAll`. Keyed by setting key; the value is
 * whatever the `json` column held.
 */
const originals = new Map<string, unknown>();

const unique = () => `${Math.floor(Math.random() * 1e9)}-${Date.now()}`;

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Admin ${role} ${suffix}`,
      email: `admset_${role}_${suffix}@example.test`,
      passwordHash: '__admset_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const publicApi = () => appRouter.createCaller(testContext(null) as never);

/** The raw stored JSON for one key, exactly as the column holds it. */
async function storedValue(key: string): Promise<unknown> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
  return row?.value;
}

/** The raw stored `updated_at` for one key. */
async function storedUpdatedAt(key: string): Promise<Date | undefined> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
  return row?.updatedAt;
}

/**
 * Remembers a key's stored value the first time it is about to change.
 *
 * Called by every test that writes, rather than snapshotting all seventeen in
 * `beforeAll`: the restore then covers exactly what was touched, and a key a
 * BROKEN build wrote through a refusal is still covered, because the refusal
 * tests snapshot before they attempt the write.
 */
async function remember(key: string): Promise<unknown> {
  const value = await storedValue(key);
  if (!originals.has(key)) originals.set(key, value);
  return value;
}

/** Every `setting` audit row this file's staff fixtures could have written. */
async function settingAuditRows() {
  if (created.userIds.length === 0) return [];
  return getDb()
    .select({ action: auditLog.action, entityId: auditLog.entityId, data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'setting'), inArray(auditLog.actorId, created.userIds)))
    .orderBy(asc(auditLog.id));
}

/** Seven valid `business_hours` entries, all open — a block with a `.length(7)`. */
const SEVEN_DAYS = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  opensAt: '07:00',
  closesAt: '20:00',
  isClosed: false,
}));

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
}, 60_000);

afterAll(async () => {
  const db = getDb();

  /*
   * Restore, never delete. `readSettings()` throws naming the first key that
   * is MISSING from the table, so a deleted row here is a red
   * `seo-resolvers.test.ts` in the same run — and an unrelated-looking one.
   */
  for (const [key, value] of originals) {
    if (value === undefined) {
      // Nothing was there to begin with, which the seed makes impossible for
      // the seventeen real keys. Only an unknown key a broken build wrote can
      // reach here, and that row must go.
      await db.delete(settings).where(eq(settings.key, key));
      continue;
    }
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  }
  // The cached flag outlives the row: restoring the value is not restoring the
  // answer until the cache is dropped too.
  resetContentUnverifiedCache();

  if (created.userIds.length > 0) {
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'setting'), inArray(auditLog.actorId, created.userIds)));
  }

  const pool = getPool();
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/* ------------------------------------------------------------------ *
 * The key list, in two places — pinned to one answer.
 * ------------------------------------------------------------------ */

/**
 * `@rg/shared`'s `SETTING_KEYS` is what the tRPC input and the admin screen
 * are built from; `SETTING_SCHEMAS` in the server is what validates a block.
 * The shared list cannot be derived from the schemas (the client must not
 * import the server), so this is the seam that keeps them one list: a
 * seventeenth-and-a-half key added to one side and not the other fails here,
 * rather than becoming an editing screen for a key nothing validates.
 *
 * No database — a pure test, outside `describeWithDb`.
 */
it('offers the shared key list and the server schemas the SAME seventeen keys', () => {
  expect([...SHARED_SETTING_KEYS].sort()).toEqual([...SETTING_KEYS].sort());
  expect(SHARED_SETTING_KEYS).toHaveLength(17);
});

describeWithDb('admin.settings', () => {
  /* ------------------------------------------------------------------ *
   * The round trip: an owner writes, the PUBLIC query reads it back
   * ------------------------------------------------------------------ */

  /**
   * Through `settings.get` rather than by reading the row: the row proves the
   * INSERT landed, and the public query proves the site serves it. Those are
   * different claims, and the second is the one an owner is making when they
   * press Save.
   */
  it('lets an owner write faqs, and the PUBLIC settings.get serves them', async () => {
    await remember('faqs');
    const faqs = [
      { q: 'How do I pay the balance?', a: 'Cash to your driver, or online before the trip.' },
      { q: 'Can I change the date?', a: 'Yes, up to 48 hours before departure.' },
    ];

    await expect(ownerApi().admin.settings.write({ key: 'faqs', value: faqs })).resolves.toEqual({
      ok: true,
    });

    const payload = await publicApi().settings.get();
    expect(payload.faqs).toEqual(faqs);
  });

  /**
   * 7N (Task 9): `trust` was the one block with no dedicated round-trip test
   * of its own — every assertion that touched it lived in
   * `settings-schema.test.ts` (the schema in isolation) or
   * `public-queries.test.ts` (reading the seeded value), never "an owner
   * writes it, and it comes back exactly". Same shape as the `faqs` test
   * above: through the PUBLIC query, not the row, because that is the claim
   * an owner is making when they press Save.
   */
  it('lets an owner write trust, and the PUBLIC payload serves it back', async () => {
    await remember('trust');
    const trust = {
      ratingAverage: null,
      ratingCount: null,
      guestsServed: 2400,
      dotAccredited: true,
      depositPercent: 25,
      minReviewsForRating: 5,
    };

    await expect(ownerApi().admin.settings.write({ key: 'trust', value: trust })).resolves.toEqual({
      ok: true,
    });

    const payload = await publicApi().settings.get();
    expect(payload.trust).toEqual(trust);
  });

  /**
   * 7N (Task 9): `writeSettingBlock` used to call `new Date()` twice — once
   * for the `INSERT`'s `updatedAt` and once more for
   * `onDuplicateKeyUpdate`'s — instead of reading `now` once at the request
   * boundary (CLAUDE.md). Driving the function directly with an injected
   * `now` far from the real clock is the only way to prove the STORED
   * `updated_at` is that exact instant rather than whatever `new Date()`
   * happened to read inside the service.
   */
  it('stamps updated_at from the single `now` it was given, not a clock read inside the service', async () => {
    await remember('trust');
    const now = new Date('2031-06-15T03:04:05.000Z');

    await writeSettingBlock(
      'trust',
      {
        ratingAverage: null,
        ratingCount: null,
        guestsServed: 500,
        dotAccredited: false,
        depositPercent: 30,
        minReviewsForRating: 3,
      },
      { subjectId: ownerId },
      now,
    );

    expect((await storedUpdatedAt('trust'))?.toISOString()).toBe(now.toISOString());
  });

  /** The raw blocks, as stored — the shape the editing screen loads. */
  it('returns every settings key from admin.settings.all', async () => {
    const all = await ownerApi().admin.settings.all();
    expect(Object.keys(all).sort()).toEqual([...SETTING_KEYS].sort());
    expect(typeof all.content_unverified).toBe('boolean');
  });

  /* ------------------------------------------------------------------ *
   * Refusals — and each one reads the row back
   * ------------------------------------------------------------------ */

  /**
   * `announcement.style` is `z.enum(['info', 'warning'])`: there is no error
   * or danger style, because this project forbids red in the UI. A block that
   * got past its own schema here would be a `readSettings()` that throws on
   * every public page.
   */
  it('REFUSES a block that fails its own schema, and writes NOTHING', async () => {
    const before = await remember('announcement');
    const auditBefore = await settingAuditRows();

    await expect(
      ownerApi().admin.settings.write({
        key: 'announcement',
        value: {
          message: 'Typhoon advisory',
          href: null,
          // Not a style this project has, and never will.
          style: 'error',
          startsAt: null,
          endsAt: null,
          isActive: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await storedValue('announcement')).toEqual(before);
    // A refusal audits nothing either: an audit row for a change that did not
    // happen is worse than no row.
    expect(await settingAuditRows()).toEqual(auditBefore);
  });

  /**
   * `payment_qr`'s cross-field refinement, which comes free from
   * `SETTING_SCHEMAS` — this test proves the writer actually CALLS it rather
   * than that the refinement exists. `isConfigured` is the switch that offers
   * the manual-transfer flow at checkout; turning it on with no account number
   * behind it would show a guest payment instructions that are not there.
   */
  it('REFUSES payment_qr with isConfigured true and no account number', async () => {
    const before = await remember('payment_qr');

    await expect(
      ownerApi().admin.settings.write({
        key: 'payment_qr',
        value: {
          imagePath: '/uploads/qr/rg-gcash.png',
          accountName: 'R&G Travel & Tours',
          accountNumber: null,
          instructions: null,
          isConfigured: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await storedValue('payment_qr')).toEqual(before);
  });

  /**
   * `booking`'s cross-field refinement. `maxAdvanceDays` below `minLeadDays`
   * leaves NO bookable date at all — a typo, not a policy — and the site would
   * quietly sell nothing.
   */
  it('REFUSES booking with maxAdvanceDays below minLeadDays', async () => {
    const before = await remember('booking');

    await expect(
      ownerApi().admin.settings.write({
        key: 'booking',
        value: { minLeadDays: 7, nextDayCutoffTime: '17:00', maxAdvanceDays: 3 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await storedValue('booking')).toEqual(before);
  });

  /**
   * An unknown key, both ways in.
   *
   * Two layers on purpose: `settingWriteInput`'s `z.enum` refuses it at the
   * tRPC boundary, and `writeSettingBlock` refuses it again for any future
   * caller that is not a tRPC request (a job, a migration helper). Neither may
   * create a row — a `settings` row nothing validates is a row `readSettings()`
   * ignores and the next developer trusts.
   */
  it('REFUSES an unknown key, at the router AND at the writer, creating no row', async () => {
    await remember('not_a_setting');

    await expect(
      ownerApi().admin.settings.write({ key: 'not_a_setting' as never, value: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      writeSettingBlock('not_a_setting' as never, true, { subjectId: ownerId }, new Date()),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await storedValue('not_a_setting')).toBeUndefined();
  });

  /* ------------------------------------------------------------------ *
   * content_unverified — the site-wide indexing gate
   * ------------------------------------------------------------------ */

  /**
   * Clearing `content_unverified` is the act that publishes this site to
   * search engines. `readContentUnverified()` caches for
   * `CONTENT_UNVERIFIED_TTL_MS` (60 seconds), so a write that does not drop
   * that cache leaves every request for up to a minute answering with the old
   * flag — and nobody can tell which way.
   *
   * The cache is PRIMED first, deliberately: against a cold cache the read
   * would hit the database and pass no matter what the writer did, which is a
   * test that cannot fail.
   */
  it('makes a content_unverified write visible IMMEDIATELY, not after the 60s TTL', async () => {
    await remember('content_unverified');

    // Prime: set the flag true, then read it so the cache holds `true` with a
    // full minute to live.
    resetContentUnverifiedCache();
    await ownerApi().admin.settings.write({ key: 'content_unverified', value: true });
    expect(await readContentUnverified()).toBe(true);

    // Now clear it. No `resetContentUnverifiedCache()` in the test — that is
    // the writer's job, and the whole point of this assertion.
    await ownerApi().admin.settings.write({ key: 'content_unverified', value: false });
    expect(await readContentUnverified()).toBe(false);

    // And back, through the same path, so the gate is not left open for the
    // rest of this test's own file either.
    await ownerApi().admin.settings.write({ key: 'content_unverified', value: true });
    expect(await readContentUnverified()).toBe(true);
  });

  /* ------------------------------------------------------------------ *
   * The role gate — §9's `usersSettings` row is OWNER ONLY
   * ------------------------------------------------------------------ */

  for (const role of ['dispatcher', 'finance'] as const) {
    it(`REFUSES a ${role} on both settings procedures, and writes nothing`, async () => {
      const before = await remember('hero');
      const id = role === 'dispatcher' ? dispatcherId : financeId;
      const api = appRouter.createCaller(staffContext(id, role) as never);

      const refusals = await Promise.all([
        api.admin.settings.all().catch((e: unknown) => e),
        api.admin.settings
          .write({
            key: 'hero',
            value: {
              eyebrow: `${role} was here`,
              headline: `${role} was here`,
              subtitle: '',
              ctaLabel: 'Book',
              imagePath: '/placeholders/hero.svg',
              imageAlt: 'Hijacked',
            },
          })
          .catch((e: unknown) => e),
      ]);

      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
      }
      // Hiding a button is not access control: the refused write must have
      // changed nothing.
      expect(await storedValue('hero')).toEqual(before);
    });
  }

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.settings.all()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  /* ------------------------------------------------------------------ *
   * Audit — the key, never the value
   * ------------------------------------------------------------------ */

  /**
   * `payment_qr` is the block that makes this rule load-bearing: its
   * `accountNumber` is where a guest's money goes. `audit_log` is read by every
   * admin in the UI and exported in reports, so a value in `data` is a value
   * published to everyone with any admin role.
   *
   * The assertion is in both directions — `data` IS `{ key }` exactly, and the
   * account number appears nowhere in any of this file's `setting` audit rows.
   * The first alone would pass a writer that also stored a second copy; the
   * second alone would pass a writer that logged the image path instead.
   */
  it('audits the KEY and never the VALUE, so an account number cannot land in audit_log', async () => {
    await remember('payment_qr');
    const accountNumber = '0917-555-0134';

    await expect(
      ownerApi().admin.settings.write({
        key: 'payment_qr',
        value: {
          imagePath: '/uploads/qr/rg-gcash.png',
          accountName: 'R&G Travel & Tours',
          accountNumber,
          instructions: 'GCash, exact amount please.',
          isConfigured: true,
        },
      }),
    ).resolves.toEqual({ ok: true });

    const rows = await settingAuditRows();
    const mine = rows.filter((row) => (row.data as { key?: string } | null)?.key === 'payment_qr');
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      expect(row.action).toBe('setting.updated');
      // `settings` has a varchar primary key and no numeric id. 0 says "no
      // numeric id"; the key that identifies the row is in `data`.
      expect(row.entityId).toBe(0);
      expect(row.data).toEqual({ key: 'payment_qr' });
    }
    expect(JSON.stringify(rows)).not.toContain(accountNumber);
    expect(JSON.stringify(rows)).not.toContain('rg-gcash.png');
    expect(JSON.stringify(rows)).not.toContain('GCash');
  });

  /**
   * One row per write, naming the actor — the question an owner asks of this
   * log is "who changed the deposit percentage", and that needs the actor and
   * the key and nothing else.
   */
  it('writes ONE audit row per accepted write, attributed to the owner who made it', async () => {
    await remember('business_hours');
    const before = (await settingAuditRows()).length;

    await ownerApi().admin.settings.write({ key: 'business_hours', value: SEVEN_DAYS });
    await ownerApi().admin.settings.write({ key: 'business_hours', value: SEVEN_DAYS });

    const rows = await settingAuditRows();
    expect(rows.length).toBe(before + 2);
    expect(rows.slice(-2).map((row) => row.data)).toEqual([
      { key: 'business_hours' },
      { key: 'business_hours' },
    ]);

    const attributed = await getDb()
      .select({ actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'setting'), inArray(auditLog.actorId, [ownerId])))
      .orderBy(asc(auditLog.id));
    expect(attributed.length).toBeGreaterThan(0);
    for (const row of attributed) {
      expect(row).toMatchObject({ actorType: 'user', actorId: ownerId });
    }
  });

  /* ------------------------------------------------------------------ *
   * Upsert, not insert
   * ------------------------------------------------------------------ */

  /**
   * Seventeen keys, one row each. A second save of the same key must REPLACE
   * the row rather than add one — `readRawSettings()` keys by `key` and would
   * silently take whichever duplicate came back last.
   */
  it('REPLACES the one row for a key rather than adding a second', async () => {
    await remember('site_seo');
    await ownerApi().admin.settings.write({
      key: 'site_seo',
      value: { title: 'First', description: 'One', ogImage: null },
    });
    await ownerApi().admin.settings.write({
      key: 'site_seo',
      value: { title: 'Second', description: 'Two', ogImage: null },
    });

    const rows = await getDb().select().from(settings).where(eq(settings.key, 'site_seo'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ title: 'Second', description: 'Two', ogImage: null });
  });
});
