/**
 * `admin.newsletter.export` — the subscriber list as a file (Week 7 plan,
 * Task 13 — 7C; BUILD_SPEC §9 "Settings: Newsletter list export") — and, as
 * of the sign-up coupons plan's Task 1C, `admin.newsletter.list`, the same
 * subscriber list rendered ON SCREEN (now on `/admin/coupons`'s "Sign-up
 * coupons" section, rather than `/admin/packages` — see `export`'s own
 * screen reference below, which still names the export's original home).
 * Both share the one gate this file's header describes; `list`'s own doc
 * comment, beside its resolver, explains why it is a query rather than a
 * second mutation.
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
import {
  manilaCivilDate,
  NEWSLETTER_CSV_HEADER,
  type NewsletterExport,
  type SignupSubscriberRow,
} from '@rg/shared';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { bookings, couponRedemptions, coupons, newsletterSubscribers } from '../../db/schema';
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

  /**
   * `admin.newsletter.list` — the subscriber list rendered on screen, on the
   * Coupons page's "Sign-up coupons" section (sign-up coupons plan, Task 1C,
   * decision 5).
   *
   * **Same gate as `export`, for the same reason — this hands the browser
   * every subscriber's email address too.** It is NOT the disclosure event
   * `export` is: nothing here leaves the server as a file, and the owner
   * viewing their own screen is not a bulk hand-off the way a download is.
   * So, unlike `export`, this is a plain QUERY and writes no audit row
   * (CLAUDE.md: reports and read-only screens write no audit rows) — the
   * disclosure `export`'s own doc comment cares about is the CSV, not this
   * list.
   *
   * **`status` is computed here, once, rather than shipped as raw columns**
   * the client would have to re-derive (`endsAt`, `isActive`,
   * "does a redemption exist") — the same reasoning `admin.bookings.list`'s
   * own status-in-words fields already follow elsewhere in this codebase.
   * A sign-up coupon's `usageLimit` is always 1
   * (`services/signup-coupons.ts`), so at most one redemption row can ever
   * exist for it and the three-way LEFT JOIN below is safely one-to-one.
   */
  list: adminProcedure('usersSettings').query(async (): Promise<SignupSubscriberRow[]> => {
    // Read once, at the request boundary — see this file's own `export`
    // resolver for why.
    const now = new Date();

    const rows = await getDb()
      .select({
        email: newsletterSubscribers.email,
        createdAt: newsletterSubscribers.createdAt,
        code: coupons.code,
        couponIsActive: coupons.isActive,
        couponEndsAt: coupons.endsAt,
        redemptionId: couponRedemptions.id,
        bookingRef: bookings.ref,
      })
      .from(newsletterSubscribers)
      .leftJoin(coupons, eq(coupons.id, newsletterSubscribers.couponId))
      .leftJoin(couponRedemptions, eq(couponRedemptions.couponId, coupons.id))
      .leftJoin(bookings, eq(bookings.id, couponRedemptions.bookingId))
      // Newest sign-up first — an admin looking at this screen wants to see
      // who just signed up, the opposite ordering from `export`'s CSV
      // (oldest first, so a second export appends cleanly).
      .orderBy(desc(newsletterSubscribers.createdAt), desc(newsletterSubscribers.id));

    return rows.map((row) => {
      if (row.code === null) {
        return {
          email: row.email,
          createdAt: row.createdAt.toISOString(),
          code: null,
          status: 'none' as const,
          usedBookingRef: null,
        };
      }

      if (row.redemptionId !== null) {
        return {
          email: row.email,
          createdAt: row.createdAt.toISOString(),
          code: row.code,
          status: 'used' as const,
          usedBookingRef: row.bookingRef,
        };
      }

      const expired =
        row.couponIsActive === false ||
        (row.couponEndsAt !== null && row.couponEndsAt.getTime() < now.getTime());

      return {
        email: row.email,
        createdAt: row.createdAt.toISOString(),
        code: row.code,
        status: expired ? ('expired' as const) : ('unused' as const),
        usedBookingRef: null,
      };
    });
  }),
});
