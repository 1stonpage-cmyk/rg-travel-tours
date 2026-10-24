/**
 * `writeSettingBlock()` — the ONLY writer of a `settings` row outside the seed
 * (Week 7 plan, Task 9; BUILD_SPEC §9 "Users, settings").
 *
 * `content/settings.ts` beside this file is the reader and is untouched. This
 * is the other half of that pair, and it is deliberately one function: an
 * admin screen, a future import tool and anything else that ever needs to
 * change a settings row goes through here, because three of the rules below
 * are easy to not know about.
 *
 * ## One validator, and it is `SETTING_SCHEMAS[key]`
 *
 * Never a second schema, never a looser one, never a cast. `readSettings()`
 * parses every key through `SETTING_SCHEMAS` on the way out and THROWS naming
 * the key when a stored block does not match — and `tours.list` throws with
 * it, which is how BUG-023 took the public site down against the dev database.
 * A write validated by anything other than the exact schema the read uses is a
 * write that can take the site down later, from a screen that said "Saved".
 *
 * Two of the seventeen schemas carry cross-field refinements — `payment_qr`
 * (`isConfigured` needs a real image, name and number behind it) and `booking`
 * (`maxAdvanceDays` must not sit below `minLeadDays`, or no date is bookable).
 * They come free from using `SETTING_SCHEMAS`, which is most of the argument
 * for using it.
 *
 * ## `content_unverified` drops its cache in the SAME request
 *
 * `readContentUnverified()` caches for `CONTENT_UNVERIFIED_TTL_MS` (60
 * seconds) because every page and every asset request under the SPA shell asks
 * it. That flag gates the site-wide `noindex`, `robots.txt`'s `Disallow: /`
 * and the production build guard — so clearing it is the act that publishes
 * this site to search engines. A write that left the cache standing would
 * leave the site either indexed or un-indexed for up to a minute with nobody
 * able to tell which, so the reset happens here rather than being remembered
 * by each caller.
 *
 * It is taken AFTER the transaction commits, deliberately: a reset inside a
 * transaction that then rolls back would have dropped a cache entry that was
 * right, forcing one extra read — harmless — while a reset that happened only
 * on commit but was written before it would be skipped by the rollback path
 * entirely. Only the committed value may invalidate.
 *
 * ## The audit row carries the KEY and never the VALUE
 *
 * `payment_qr.accountNumber` is where a guest's money is sent; `contact` holds
 * phone numbers; `legal_privacy` holds a document. `audit_log` is read by
 * every admin in the UI and exported in reports (`services/audit.ts`'s own
 * warning), so a value in `data` is a value published to everyone holding any
 * admin role — including the dispatcher and finance roles this area refuses
 * outright. `data` is therefore `{ key }`, and the previous value is not
 * logged either: "who changed the deposit percentage, and when" is the
 * question this log answers.
 */
import { TRPCError } from '@trpc/server';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { writeAudit } from '../services/audit';
import { resetContentUnverifiedCache } from './settings';
import { SETTING_SCHEMAS, type SettingKey } from './settings-schema';

/** `audit_log.entity` for a settings change. `varchar(40)`, so it fits twice over. */
export const SETTING_AUDIT_ENTITY = 'setting';

/**
 * `audit_log.entity_id` for a settings change.
 *
 * `settings` is keyed by a `varchar(64)` and has no numeric id at all, while
 * `writeAudit`'s `entityId` is a non-nullable `number`. Zero is the honest
 * answer: it says "this entity has no numeric id" and it is the same for every
 * key, so nobody reads it as something joinable. A hash of the key was the
 * alternative and was rejected — it would LOOK like an id, invite a join
 * against a table that has no such column, and still need `data.key` to be
 * readable by a human. The key itself is in `data`, which is where the
 * identity of the changed row lives.
 */
export const SETTING_AUDIT_ENTITY_ID = 0;

/** Who made the change — `users.id`, from the validated staff session. */
export interface SettingActor {
  subjectId: number;
}

/**
 * The message for a block that failed its own schema.
 *
 * Names the key and the failing FIELD PATHS, never the submitted value: an
 * owner needs to know which field was refused, and the value is the one thing
 * that must not travel back out through an error (the same rule
 * `content/settings.ts`'s reader follows — "errors name the key, never the
 * value"). Zod's own issue messages describe the EXPECTED shape ("expected
 * string, received number", or a refinement's hand-written sentence), so they
 * are safe to pass through and are what makes the screen usable.
 */
function refusalMessage(
  key: SettingKey,
  issues: readonly { path: PropertyKey[]; message: string }[],
) {
  const described = issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
  return `settings.${key} was not saved — ${described || 'the value does not match this setting.'}`;
}

/**
 * Validates `value` against `key`'s own schema and, if it passes, upserts the
 * one row for that key and audits the change in the same transaction.
 *
 * Throws `BAD_REQUEST` and writes nothing for an unknown key or a block that
 * fails its schema. The unknown-key guard is the second of two: the tRPC input
 * (`settingWriteInput`) already refuses a key outside the enum, and this one
 * catches any caller that is not an HTTP request. It fails closed — an
 * unrecognised key can never reach the `INSERT` — because a `settings` row
 * nothing validates is a row `readSettings()` ignores and the next reader
 * trusts.
 */
export async function writeSettingBlock(
  key: SettingKey,
  value: unknown,
  actor: SettingActor,
): Promise<void> {
  /*
   * The lookup and the parse are one expression's worth of logic on purpose:
   * this is the single place a settings value is judged, so there is one place
   * to read when asking "what is allowed in this row".
   */
  const schema = Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, key)
    ? SETTING_SCHEMAS[key]
    : undefined;
  if (!schema) {
    // Named, not echoed: the key is a caller-supplied string, so it is
    // reported as "not a setting" rather than interpolated into prose.
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not a settings key.' });
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: refusalMessage(key, parsed.error.issues),
    });
  }

  /*
   * One row per key, replaced wholesale. A transaction for a single-row write
   * because the audit row has to land with it or not at all — an audit row
   * that survived a rollback would claim a settings change that never
   * happened, and `settings` is where the deposit percentage lives.
   *
   * `onDuplicateKeyUpdate` rather than select-then-insert-or-update: two
   * owners saving the same block at once both pass an existence check and one
   * of them gets `ER_DUP_ENTRY` on a `varchar` primary key. Letting MySQL
   * arbitrate makes the last writer win, which is the right answer for a
   * settings row and needs no retry.
   */
  const stored = parsed.data;
  await getDb().transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key, value: stored, updatedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { value: stored, updatedAt: new Date() } });

    await writeAudit(tx, {
      actorType: 'user',
      actorId: actor.subjectId,
      action: 'setting.updated',
      entity: SETTING_AUDIT_ENTITY,
      entityId: SETTING_AUDIT_ENTITY_ID,
      // The KEY only. See this file's header.
      data: { key },
    });
  });

  /*
   * After the commit, and only for the one key that is cached. See the header:
   * this is the difference between "the site is now indexable" and "the site
   * will be indexable within a minute, probably".
   */
  if (key === 'content_unverified') {
    resetContentUnverifiedCache();
  }
}
