/**
 * `admin.reports.*` — the money reports and their CSV exports (Week 7 plan,
 * Task 12 — 7D; BUILD_SPEC §9 "Reports", server half).
 *
 * ## §9 gives reports to the owner and finance
 *
 * Every procedure here is `adminProcedure('reports')`, and
 * `ROLE_MATRIX.reports` is already `['owner', 'finance']` — §9's own row,
 * transcribed exactly once in this codebase. **A dispatcher is refused**, the
 * CSV included: an export is the same money in a different container, and a
 * surface that gated the three queries but not the file would be a gate in name
 * only. `admin-reports.test.ts` refuses a dispatcher on all four.
 *
 * ## This router decides nothing about money
 *
 * The four predicates live in `services/reports/money.ts` and the file format
 * in `services/reports/csv.ts`; this file is wiring. In particular there is no
 * `WHERE` clause here and no arithmetic on a centavo — "what counts as money
 * received" must have one answer, and a procedure that re-derived a figure for
 * its CSV is how an export comes to disagree with the screen above it.
 *
 * ## It writes nothing
 *
 * Four queries, no mutation, and no `writeAudit` call anywhere in the module
 * (CLAUDE.md Global Constraints: "Reports and read-only screens write no audit
 * rows"). Reading a revenue figure is not an event in the life of a booking.
 *
 * ## The CSV is a STRING, not a route
 *
 * `csv` is a tRPC query that returns `{ filename, csv }` and the browser turns
 * it into a download with a `Blob` and an object URL (plan, step 5). No Express
 * route, no streaming, no library: an Express route would need its own copy of
 * the role gate, and that second copy is the one that gets forgotten.
 */
import { dateRangeInput, reportCsvInput, type ReportCsv, type ReportName } from '@rg/shared';
import { byTourCsv, csvFilename, outstandingCsv, summaryCsv } from '../../services/reports/csv';
import { outstandingBookings, reportSummary, revenueByTour } from '../../services/reports/money';
import { adminProcedure, router } from '../../trpc';

/** The one place a report name maps to the file it renders. */
async function renderCsv(report: ReportName, range: { from: string; to: string }): Promise<string> {
  switch (report) {
    case 'summary':
      return summaryCsv(await reportSummary(range));
    case 'byTour':
      return byTourCsv(await revenueByTour(range));
    case 'outstanding':
      return outstandingCsv(await outstandingBookings(range));
  }
}

export const adminReportsRouter = router({
  /** The five headline figures for one Manila civil-date window. */
  summary: adminProcedure('reports')
    .input(dateRangeInput)
    .query(async ({ input }) => await reportSummary(input)),

  /** The same five figures per tour, over the union of both date buckets. */
  byTour: adminProcedure('reports')
    .input(dateRangeInput)
    .query(async ({ input }) => await revenueByTour(input)),

  /** Bookings in the window whose total and paid amount do not agree. */
  outstanding: adminProcedure('reports')
    .input(dateRangeInput)
    .query(async ({ input }) => await outstandingBookings(input)),

  /**
   * Any of the three as an RFC 4180 file, plus the name it should download as.
   *
   * A query rather than a mutation, because it changes nothing — the same
   * reason `summary` is. The `report` name is a Zod enum, so the `switch` in
   * `renderCsv` is exhaustive and a fourth report cannot be added without the
   * compiler asking for its file.
   */
  csv: adminProcedure('reports')
    .input(reportCsvInput)
    .query(async ({ input }): Promise<ReportCsv> => {
      const { report, ...range } = input;
      return { filename: csvFilename(report, range), csv: await renderCsv(report, range) };
    }),
});
