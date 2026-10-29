/**
 * `admin.settings.*` — the editing surface for all seventeen `settings` rows
 * (Week 7 plan, Task 9; BUILD_SPEC §9 "Users, settings").
 *
 * Both procedures are `adminProcedure('usersSettings')` — §9's "Users,
 * settings" row, which is **owner only**. A dispatcher and a finance user are
 * both refused by the gate, not by a resolver finding nothing to do, and that
 * narrowness is deliberate: `trust.depositPercent` is the fraction of a
 * guest's total that is taken at checkout, `payment_qr` is the account their
 * money is transferred to, and `content_unverified` decides whether this site
 * appears in a search engine at all.
 *
 * **The resolvers hold no validation of their own.** `write` hands the key and
 * the value to `writeSettingBlock()` and nothing else — the one validator is
 * `SETTING_SCHEMAS[key]`, called in there, including the two cross-field
 * refinements (`payment_qr.isConfigured` needing real values behind it, and
 * `booking.maxAdvanceDays` not sitting below `minLeadDays`). A check repeated
 * here would be a second opinion about what a settings row may contain, and a
 * second opinion is how the two drift.
 *
 * **`all` reads RAW rows, not `readSettings()`.** `readSettings()` parses all
 * seventeen and throws naming the first bad one, so one block broken by a
 * hand-written `UPDATE` or an old seed would make the single screen that can
 * FIX it unloadable. The editor shows what is stored; validity is decided on
 * the way in. There is deliberately no delete: `settings` has exactly these
 * seventeen rows for the life of the site, `readSettings()` throws on a
 * missing one, and an empty block is expressed inside a block's own schema
 * (`announcement.isActive: false`, `permits.dot: null`) rather than by
 * removing a row.
 */
import { settingWriteInput } from '@rg/shared';
import { readRawSettings } from '../../content/settings';
import { writeSettingBlock } from '../../content/settings-write';
import { adminProcedure, router } from '../../trpc';

export const adminSettingsRouter = router({
  /**
   * Every settings row as stored, keyed by key. The editing screen's one load.
   *
   * It returns the blocks RAW — the `announcement` schedule fields and the
   * `payment_methods` `enabled` flags that the public `settings.get` resolves
   * away are exactly what an owner is here to edit, so this is not that
   * payload and must not be confused with it.
   */
  all: adminProcedure('usersSettings').query((): Promise<Record<string, unknown>> =>
    readRawSettings(),
  ),

  /**
   * One block, replaced wholesale — never patched.
   *
   * A block is one JSON document and a partial write has no safe meaning: an
   * omitted `announcement.endsAt` could mean "leave it" or "clear it", and the
   * two differ by whether a banner is still on the site next week. The screen
   * loads the block, the owner edits it, the whole block comes back.
   */
  write: adminProcedure('usersSettings')
    .input(settingWriteInput)
    .mutation(async ({ input, ctx }) => {
      // Read once, at the request boundary, and handed to the service — see
      // `writeSettingBlock`'s own doc comment.
      await writeSettingBlock(
        input.key,
        input.value,
        { subjectId: ctx.session.subjectId },
        new Date(),
      );
      return { ok: true as const };
    }),
});
