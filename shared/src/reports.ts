/**
 * The money report contract (Week 7 plan, Task 12 — 7D; BUILD_SPEC §9
 * "Reports", §9's `reports` role row).
 *
 * **Every figure here is integer centavos**, the same as every other money
 * payload in this project (CLAUDE.md § Conventions: "integers in centavos
 * everywhere — DB, API, logic. Format only at display"). The browser formats;
 * the one exception is the CSV STRING `admin.reports.csv` returns, which is a
 * file a human opens in a spreadsheet and therefore carries pesos — see
 * `server/src/services/reports/csv.ts`, which is the only place in the stack
 * that divides by 100.
 *
 * ## Two buckets, on purpose (owner decision 2026-10-23, Q7)
 *
 * The figures are NOT all bucketed by the same column, and that is the whole
 * substance of the owner's ruling:
 *
 *  - **`receivedCentavos` / `refundedCentavos`** bucket by the `payments`
 *    row's OWN `created_at`, converted to Asia/Manila. A refund that lands in
 *    November belongs to November even when the payment it reverses was taken
 *    in September.
 *  - **`stillToCollectCentavos` / `bookingCount`** bucket by
 *    `bookings.tour_date`, the civil date the trip runs on.
 *
 * So a single range answers two different questions — "what moved through the
 * account in this window" and "what is owed on the trips in this window" —
 * and those two are not expected to reconcile. The screen says so in words.
 *
 * ## `netReceivedCentavos` is received − refunded, and nothing else
 *
 * Never `bookings.amount_paid_centavos`. A refund in this codebase is a
 * separate POSITIVE `payments` row and never a subtraction from what was paid
 * (CLAUDE.md § Conventions), so `amount_paid_centavos` is a running total of
 * money IN and knows nothing about money back out. Deriving "net" from it
 * would silently report refunds as never having happened.
 *
 * And for the same reason, in the other direction:
 * **`stillToCollectCentavos` does not subtract refunds.** It is
 * `total − amount_paid` over the bookings that are still live, and a refund
 * leaves both of those columns exactly where they were. That is correct: a
 * refund is money returned, not a balance the guest now owes again. It is also
 * the line of this whole task most likely to be "fixed" into a bug, so
 * `server/src/__tests__/admin-reports.test.ts` pins it from both sides.
 */
import { z } from 'zod';
import { civilDateSchema } from './checkout';
import { type BookingStatus } from './booking';

/**
 * The booking statuses that owe nothing, ever.
 *
 * A cancelled or expired booking holds no capacity (§5's status table) and
 * nobody is going to collect its balance, so it is excluded from
 * `stillToCollectCentavos` and from the outstanding list. It is NOT excluded
 * from `bookingCount`, which the plan defines as a plain count over the
 * bookings in the range — the figure answers "how many bookings sit on these
 * tour dates", cancellations included.
 */
export const REPORT_NON_COLLECTABLE_STATUSES = [
  'cancelled',
  'expired',
] as const satisfies readonly BookingStatus[];

/* ------------------------------------------------------------------- Input */

/**
 * The two civil-date ends of a report window, INCLUSIVE at both ends.
 *
 * Civil dates (`YYYY-MM-DD`), never instants: a report of "March" means the
 * Manila calendar days, and the server is the only thing that may turn those
 * into the UTC instants `payments.created_at` is compared against. `from` and
 * `to` are reused by the CSV input, so the fields live in a bare shape object
 * that both schemas spread — a `.refine()` on one of them makes it a
 * `ZodEffects`, which cannot be `.extend()`ed.
 */
const dateRangeShape = {
  from: civilDateSchema,
  to: civilDateSchema,
} as const;

/**
 * An inverted range is REFUSED, not silently emptied.
 *
 * `from > to` is a caller bug — a picker wired backwards, a hand-built URL —
 * and a report that answers it with four confident zeros is worse than one
 * that says the question was malformed. String comparison is exact here
 * because `civilDateSchema` only admits zero-padded `YYYY-MM-DD`, whose
 * lexicographic order IS calendar order.
 */
const notInverted = (range: { from: string; to: string }) => range.from <= range.to;
const INVERTED_MESSAGE = 'The start date must not be after the end date';

export const dateRangeInput = z
  .object(dateRangeShape)
  .strict()
  .refine(notInverted, { message: INVERTED_MESSAGE, path: ['to'] });
export type DateRangeInput = z.infer<typeof dateRangeInput>;

/** Which report a CSV export is of. One name per shape below. */
export const REPORT_NAMES = ['summary', 'byTour', 'outstanding'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export const reportNameSchema = z.enum(REPORT_NAMES);

export const reportCsvInput = z
  .object({ ...dateRangeShape, report: reportNameSchema })
  .strict()
  .refine(notInverted, { message: INVERTED_MESSAGE, path: ['to'] });
export type ReportCsvInput = z.infer<typeof reportCsvInput>;

/* ------------------------------------------------------------------ Output */

/**
 * The five headline figures for one window.
 *
 * `from` and `to` are echoed back so a CSV header, a screen title and a
 * cached payload can all say which window they describe without the caller
 * having to pair them up again.
 *
 * Every number is present and zero on an empty window — never `null`, never
 * absent. "Nothing came in" is a fact worth stating, and a nullable money
 * figure is how a dash ends up where a zero belongs.
 */
export interface ReportSummary {
  from: string;
  to: string;
  /** `payments`: `type='payment' AND status='paid'`, by the row's own Manila date. */
  receivedCentavos: number;
  /** `payments`: `type='refund' AND status='refunded'`, by the row's own Manila date. */
  refundedCentavos: number;
  /** `receivedCentavos − refundedCentavos`. Can be negative in a refund-heavy window. */
  netReceivedCentavos: number;
  /** `SUM(total − amount_paid)` over live bookings, by `tour_date`. Refund-blind by design. */
  stillToCollectCentavos: number;
  /** `COUNT(*)` over bookings by `tour_date`, every status included. */
  bookingCount: number;
}

/**
 * One tour's row of the same five figures.
 *
 * A tour appears when it has EITHER money movement in the window (by payment
 * date) or bookings in it (by tour date) — the two buckets select different
 * sets of tours and the row set is their union, so a tour paid for in March
 * for an April trip is in both months' reports with the half of the figures
 * that belongs to each.
 */
export interface TourRevenueRow {
  tourId: number;
  tourTitle: string;
  receivedCentavos: number;
  refundedCentavos: number;
  netReceivedCentavos: number;
  stillToCollectCentavos: number;
  bookingCount: number;
}

/**
 * One booking that does not add up to its total, by tour date.
 *
 * Rows whose balance is exactly zero are left out, so the list SUMS to the
 * summary's `stillToCollectCentavos` by construction. A negative
 * `outstandingCentavos` — an overpayment — is kept rather than hidden: it is
 * money the business holds that nobody has claimed, which is precisely the
 * row finance wants in front of them, and dropping it would break that sum.
 *
 * `leadName` is here and the guest's email and phone are not. §9 gives this
 * area to owner and finance only, and chasing a balance needs a name; the
 * contact details are one click away on the booking itself (RA 10173, data
 * minimisation).
 */
export interface OutstandingRow {
  bookingId: number;
  ref: string;
  tourTitle: string;
  /** Civil date, `YYYY-MM-DD`. */
  tourDate: string;
  status: BookingStatus;
  leadName: string;
  totalCentavos: number;
  /**
   * `bookings.amount_paid_centavos`, read.
   *
   * Named `paidCentavos` rather than `amountPaidCentavos` ON PURPOSE, and
   * please leave it: `schema-conventions.test.ts` parses every server source
   * file and fails the build on an object-literal key spelled
   * `amountPaidCentavos` outside the two crediting functions in
   * `record-payment.ts`. That guard is what makes "only a verified webhook or
   * an admin approval marks a booking paid" structural, so a read-only report
   * stays out of its way instead of being added to its allow-list.
   */
  paidCentavos: number;
  /** `totalCentavos − paidCentavos`. Negative means overpaid. */
  outstandingCentavos: number;
}

/** What `admin.reports.csv` hands the browser to turn into a download. */
export interface ReportCsv {
  /** Already safe as a filename: the report name and the two civil dates. */
  filename: string;
  /** RFC 4180 text, CRLF line endings, one header row. */
  csv: string;
}
