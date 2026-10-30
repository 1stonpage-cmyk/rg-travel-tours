/**
 * `admin.newsletter.export` — the subscriber list as a file (Week 7 plan,
 * Task 13 — 7C; BUILD_SPEC §9 "Settings: Newsletter list export").
 *
 * ## Its own file because it has its own GATE
 *
 * `adminProcedure('usersSettings')` — **OWNER ONLY**. The screen it sits on is
 * `/admin/packages`, whose other procedures are `packagesInquiries` (owner and
 * dispatcher), and the split is the point of **owner decision 2026-10-23 (Q3,
 * option c)**: a dispatcher who answers one guest's enquiry is doing
 * operational work, while taking every subscriber's address away in one file is
 * a bulk disclosure of personal data. §9 already lists "Newsletter list export"
 * under Settings, so it is gated there rather than given a row of its own.
 *
 * Two gates on one screen is easy to lose track of in a shared file, which is
 * why this one is not shared. `admin-packages.test.ts` refuses a dispatcher AND
 * a finance user here, and admits both of them next door.
 *
 * ## It is a MUTATION, and that is deliberate
 *
 * `admin.reports.csv` is a query, because reading a revenue figure changes
 * nothing and writes no audit row (CLAUDE.md: reports and read-only screens
 * write no audit rows). This one is different in exactly that respect: an
 * export of every subscriber's address IS an event in the life of that data —
 * a disclosure under RA 10173 — so it writes an audit row, and a query that
 * writes would be a query that must never be retried, prefetched or cached.
 * Being a mutation also puts it on a POST through the CSRF origin check rather
 * than on a GET whose URL could be put in an `<img>` tag.
 *
 * ## The audit row records WHO and HOW MANY, never an address
 *
 * `writeAudit`'s own warning is that anything in `data` is effectively
 * published to every admin — including, here, the dispatcher and finance roles
 * this procedure refuses. Putting the addresses in the log would hand them to
 * precisely the people the gate exists to keep them from. So the row carries
 * the count and nothing else; the addresses are in the file the owner
 * downloaded, and nowhere on the server.
 *
 * `entity_id` is `0` for the same reason `settings` uses zero
 * (`content/settings-write.ts`): the subscriber LIST has no numeric id, and
 * zero says "this entity has no id" rather than looking joinable.
 *
 * ## No export of a subset, and no second column
 *
 * One query, every row, one column. A date-range filter would be a feature
 * nobody asked for over a table whose only other column is `created_at`, and a
 * second column would put more personal data in the file than the job needs
 * (RA 10173, data minimisation: §9 asks for the list, not a profile).
 */
import { manilaCivilDate, NEWSLETTER_CSV_HEADER, type NewsletterExport } from '@rg/shared';
import { asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { newsletterSubscribers } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { csvText, toCsv } from '../../services/reports/csv';
import { adminProcedure, router } from '../../trpc';

/** `audit_log.entity` for the subscriber list. */
const NEWSLETTER_ENTITY = 'newsletter';

/** `audit_log.entity_id`: the list has no numeric id. See this file's header. */
const NEWSLETTER_ENTITY_ID = 0;

export const adminNewsletterRouter = router({
  export: adminProcedure('usersSettings').mutation(async ({ ctx }): Promise<NewsletterExport> => {
    /*
     * The `now` is read ONCE, here at the request boundary, like every other
     * instant in this codebase — it only names the file, but a clock read
     * deeper in would be a clock read a test could not pin.
     */
    const now = new Date();

    const rows = await getDb()
      .select({ email: newsletterSubscribers.email })
      .from(newsletterSubscribers)
      // Oldest first, so a second export appends the new addresses at the
      // bottom and two files diff cleanly. `id` after `created_at` because the
      // column is a `DATETIME` with second precision.
      .orderBy(asc(newsletterSubscribers.createdAt), asc(newsletterSubscribers.id));

    /*
     * `toCsv` and `csvText` come from `services/reports/csv.ts` rather than
     * being re-implemented: that module is where this project's ONE tested
     * escaping boundary lives (`admin-reports.test.ts` exercises `csvField`
     * with a comma, a quote and a newline directly), and a second copy of CSV
     * quoting is a second copy to get wrong.
     *
     * `csvText` is not decoration here. An email local part may legitimately
     * contain `=` and `+`, so `=foo@example.com` is an address a spreadsheet
     * would evaluate as a FORMULA on import — CSV formula injection, over a
     * value a stranger typed into a public signup box.
     */
    const csv = toCsv(
      [NEWSLETTER_CSV_HEADER],
      rows.map((row) => [csvText(row.email)]),
    );

    await getDb().transaction(async (tx) => {
      await writeAudit(tx, {
        actorType: 'user',
        actorId: ctx.adminSession.subjectId,
        action: 'newsletter.exported',
        entity: NEWSLETTER_ENTITY,
        entityId: NEWSLETTER_ENTITY_ID,
        // The count and nothing else — never an address.
        data: { count: rows.length },
      });
    });

    return {
      filename: `travelsugbo-newsletter-${manilaCivilDate(now)}.csv`,
      csv,
      count: rows.length,
    };
  }),
});
