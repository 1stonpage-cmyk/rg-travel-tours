/**
 * Typed reader for the `settings` table.
 *
 * `readSettings()` fails loudly — never silently defaults — when a key is
 * missing or its stored JSON doesn't match its schema. A missing setting
 * means the seed (Task 1.4) didn't run or ran wrong; substituting a default
 * would put invented content on a live marketing page, which this project
 * forbids. Errors name the key, never the value.
 */
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { SETTING_KEYS, SETTING_SCHEMAS, type SettingsBlocks } from './settings-schema';

/** All rows, unvalidated — key -> whatever JSON is stored. */
export async function readRawSettings(): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db.select().from(settings);
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    raw[row.key] = row.value;
  }
  return raw;
}

/**
 * Every settings key, parsed through its schema. Throws naming the key if
 * it is missing from the table or its value fails validation.
 */
export async function readSettings(): Promise<SettingsBlocks> {
  const raw = await readRawSettings();
  const blocks: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    if (!(key in raw)) {
      throw new Error(`Missing setting: "${key}"`);
    }

    const result = SETTING_SCHEMAS[key].safeParse(raw[key]);
    if (!result.success) {
      throw new Error(`Invalid setting: "${key}"`);
    }

    blocks[key] = result.data;
  }

  return blocks as SettingsBlocks;
}
