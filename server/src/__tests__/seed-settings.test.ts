/**
 * Week 7, Task A2 — LAUNCH BLOCKER: `db:seed` must never overwrite an
 * existing settings row.
 *
 * ## The incident
 *
 * On 2026-10-28, `pnpm --filter @rg/server db:seed` against the live
 * `rg_travel` database reset the `payment_qr` block back to its seed default
 * (`isConfigured: false`, every field `null`), wiping a real configuration
 * somebody had entered through the admin Settings screens. The seed's
 * settings writer was an upsert, so every run overwrote every key — which is
 * exactly backwards for the one table whose rows an admin edits in place. A
 * re-seed on the production box at launch would have erased everything the
 * owner had configured.
 *
 * So the rule under test is the whole of it: **an existing settings row is
 * left alone, and a missing one is still inserted.** `payment_qr` is the
 * fixture because it is the block the incident actually destroyed.
 *
 * ## Why this does not need a test-context escape hatch
 *
 * `resetTestDb()` deletes every `settings` row BEFORE calling `seed('test')`,
 * so the insert-only seed still restores the canonical baseline in full on
 * every reset — there is never an existing row for it to skip. That is why
 * the fix needed no "but the tests need the overwrite" branch, and it is also
 * what this file relies on for cleanup.
 *
 * Test files run one at a time (`fileParallelism: false`), and this file ends
 * by restoring the baseline through `resetTestDb()`, like `settings.test.ts`
 * and `seed-itinerary.test.ts` before it.
 */
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { seed } from '../db/seed';
import { SEED_SETTINGS } from '../db/seed-data';
import { describeWithDb } from './helpers/db';
import { resetTestDb } from './helpers/test-db';

const KEY = 'payment_qr';

/**
 * A configured QR — the shape a real admin entry has, and nothing like
 * `SEED_SETTINGS.payment_qr`, whose every field is null with
 * `isConfigured: false`. If a re-seed clobbers the row, these values are the
 * ones that disappear.
 */
const ADMIN_ENTERED = {
  imagePath: '/uploads/payment-qr/a2-admin-entered.png',
  accountName: 'R&G Travel & Tours',
  accountNumber: '0917 000 0000',
  instructions: 'Scan with GCash, then upload your receipt.',
  isConfigured: true,
};

async function storedValue(): Promise<unknown> {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, KEY));
  return row?.value;
}

afterAll(async () => {
  await resetTestDb();
});

describeWithDb('the settings seed is insert-only', () => {
  it('does NOT overwrite a row an admin has edited, even back to the seed default', async () => {
    // The admin's edit, written straight to the row the seed also defines.
    await getDb().update(settings).set({ value: ADMIN_ENTERED }).where(eq(settings.key, KEY));

    await seed('test');

    expect(
      await storedValue(),
      'a re-seed reset an admin-entered settings row back to the seed default — this is the ' +
        '2026-10-28 launch blocker',
    ).toEqual(ADMIN_ENTERED);
    // Said the other way round too, so the assertion cannot pass by the
    // fixture happening to equal the default.
    expect(await storedValue()).not.toEqual(SEED_SETTINGS[KEY]);
  }, 60_000);

  /**
   * The other half, and the reason this is insert-only rather than
   * never-write: a key that is genuinely absent — a fresh clone, or a new key
   * added to `SEED_SETTINGS` after launch — must still be seeded, or
   * `readSettings()` throws naming it and the whole site fails to render.
   */
  it('DOES insert a key that is genuinely missing', async () => {
    await getDb().delete(settings).where(eq(settings.key, KEY));
    expect(await storedValue(), 'the row was not actually deleted').toBeUndefined();

    await seed('test');

    expect(await storedValue()).toEqual(SEED_SETTINGS[KEY]);
  }, 60_000);
});
