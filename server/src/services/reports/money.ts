/**
 * **What counts as money, for every report.** (Week 7 plan, Task 12 — 7D;
 * BUILD_SPEC §9 "Reports".)
 *
 * All four of the plan's predicates live in this one module, and deliberately:
 * "what counts as money received" has exactly one answer in this codebase, and
 * the summary cards, the per-tour table and all three CSV exports read it from
 * here rather than each writing a `WHERE` of their own. Three copies of that
 * question is how the dashboard and the export come to disagree about a month,
 * which is worse than either being wrong — nobody can tell which to believe.
 *
 * Nothing here writes. There is no `INSERT`, no `UPDATE` and no `writeAudit`
 * call in this file or in anything it imports, because a report is a read
 * (CLAUDE.md Global Constraints: "Reports and read-only screens write no audit
 * rows"), and `admin-reports.test.ts` scans the source to keep that true.
 *
 * ## The two buckets, and why they are two (owner decision 2026-10-23, Q7)
 *
 *  - **Money movement** — received and refunds — is bucketed by the `payments`
 *    row's OWN `created_at`. That column is a UTC `datetime`, so the civil-date
 *    window is converted to an INSTANT range first (see `manilaWindow`).
 *  - **Bookings and balances** are bucketed by `bookings.tour_date`, which is
 *    already a civil date in Asia/Manila and is compared as a STRING.
 *
 * The two never meet in a single join, and `revenueByTour` is the proof: a
 * booking paid for in March for an April trip contributes its money to March
 * and its balance to April, so the per-tour row set is the UNION of the tours
 * each bucket selects, not an inner join between them. A tour with March money
 * and no March trips would vanish from a `tour_date`-joined query, taking real
 * revenue with it.
 *
 * ## `SUM()` arrives as a string
 *
 * MySQL widens `SUM()` over an `INT` to `DECIMAL`, and mysql2 hands a DECIMAL
 * back as a JS string to avoid lying about precision. Every figure below is
 * therefore pushed through `Number()` at the boundary — without it the sums
 * would CONCATENATE and the API would answer `"100000200000"`.
 */
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  REPORT_NON_COLLECTABLE_STATUSES,
  addCivilDays,
  civilDateFromDate,
  manilaInstant,
  type DateRangeInput,
  type OutstandingRow,
  type ReportSummary,
  type TourRevenueRow,
} from '@rg/shared';
import { getDb } from '../../db/client';
import { bookings, payments, tours } from '../../db/schema';

/* ------------------------------------------------------------- Date windows */

/**
 * The half-open INSTANT range a Manila civil-date window covers.
 *
 * `[from 00:00 Manila, the day after `to` 00:00 Manila)` — inclusive at the
 * start, EXCLUSIVE at the end, which is what makes "23:59:59.999 on the last
 * day" belong to the window without anyone having to name that instant. Both
 * ends go through `manilaInstant()` rather than an offset subtraction, so a
 * future Philippine DST change moves the boundary with the zone instead of
 * silently shifting every report by an hour.
 */
function manilaWindow(range: DateRangeInput): { start: Date; endExclusive: Date } {
  return {
    start: manilaInstant(range.from, '00:00'),
    endExclusive: manilaInstant(addCivilDays(range.to, 1), '00:00'),
  };
}

/** `created_at >= :start AND created_at < :endExclusive`. */
function createdInWindow(range: DateRangeInput) {
  const { start, endExclusive } = manilaWindow(range);
  return sql`${payments.createdAt} >= ${start} AND ${payments.createdAt} < ${endExclusive}`;
}

/**
 * `tour_date BETWEEN :from AND :to`, comparing a civil-date column to two
 * civil-date STRINGS.
 *
 * Raw `sql`, not `eq()`/`between()`: `bookings.tourDate` is Drizzle's `date`
 * column, whose default mode types the value as a JS `Date`, so either
 * operator would force a `Date` here and reopen the midnight-shift hazard.
 * Identical in shape to `betweenDates()` (`routers/admin/calendar.ts`),
 * `onDate()` (`services/dispatch/availability.ts`) and `on()`
 * (`services/capacity.ts`) — kept local for the same reason all three of those
 * are kept local: this module's date comparison is not any of their jobs.
 */
function tourDateInWindow(range: DateRangeInput) {
  return sql`${bookings.tourDate} BETWEEN ${range.from} AND ${range.to}`;
}

/* ------------------------------------------- The four predicates, once each */

/**
 * **Money received.** `type = 'payment' AND status = 'paid'`, and nothing else.
 *
 * A conditional `SUM` rather than a `WHERE`, because the refund sum below is
 * read from the same scan and the per-tour query groups both at once. The
 * statuses this excludes are not hypothetical: a driver's cash tap writes a
 * `pending` row and finance refusing it writes a `rejected` one, and both would
 * inflate revenue by a sum nobody ever received.
 */
export const RECEIVED_CENTAVOS = sql<number>`COALESCE(SUM(CASE WHEN ${payments.type} = 'payment' AND ${payments.status} = 'paid' THEN ${payments.amountCentavos} ELSE 0 END), 0)`;

/**
 * **Refunds.** `type = 'refund' AND status = 'refunded'`.
 *
 * `amount_centavos` is ALWAYS POSITIVE — a database CHECK enforces it, and
 * direction comes from `type`, never from a sign (schema, §6 Q11). So this is
 * a positive total that the caller SUBTRACTS; summing the two types together
 * would read a refund as income.
 */
export const REFUNDED_CENTAVOS = sql<number>`COALESCE(SUM(CASE WHEN ${payments.type} = 'refund' AND ${payments.status} = 'refunded' THEN ${payments.amountCentavos} ELSE 0 END), 0)`;

/**
 * **Still to collect.** `SUM(total_centavos − amount_paid_centavos)` over the
 * bookings that are not cancelled or expired.
 *
 * **It does not subtract refunds, and must not be "fixed" to.** A refund in
 * this codebase never decrements `amount_paid_centavos` (CLAUDE.md
 * § Conventions: it is a separate positive `payments` row, never a
 * subtraction), so both columns here are exactly where they were before the
 * refund — and that is the right answer. A guest who was refunded does not
 * suddenly owe the money back. Netting refunds in here would turn a
 * ₱400 goodwill refund into ₱400 of invented debt on a booking that is square.
 */
export const STILL_TO_COLLECT_CENTAVOS = sql<number>`COALESCE(SUM(CASE WHEN ${bookings.status} NOT IN ('cancelled', 'expired') THEN ${bookings.totalCentavos} - ${bookings.amountPaidCentavos} ELSE 0 END), 0)`;

/**
 * **Bookings.** A plain `COUNT(*)` over the bookings in the window, by tour
 * date — every status, cancellations included. The plan describes no status
 * filter, so there is none: this figure answers "how many bookings sit on
 * these tour dates", and a report that quietly dropped the cancelled ones
 * would make a bad week look like a quiet one.
 */
export const BOOKING_COUNT = sql<number>`COUNT(*)`;

/* ------------------------------------------------------------ The aggregates */

interface MoneyMoved {
  receivedCentavos: number;
  refundedCentavos: number;
}

/** The window's money movement, from the `payments` rows' own instants. */
async function moneyMoved(range: DateRangeInput): Promise<MoneyMoved> {
  const [row] = await getDb()
    .select({ received: RECEIVED_CENTAVOS, refunded: REFUNDED_CENTAVOS })
    .from(payments)
    .where(createdInWindow(range));
  return {
    receivedCentavos: Number(row?.received ?? 0),
    refundedCentavos: Number(row?.refunded ?? 0),
  };
}

/** The window's bookings and balances, from their tour dates. */
async function bookingTotals(
  range: DateRangeInput,
): Promise<{ stillToCollectCentavos: number; bookingCount: number }> {
  const [row] = await getDb()
    .select({ still: STILL_TO_COLLECT_CENTAVOS, count: BOOKING_COUNT })
    .from(bookings)
    .where(tourDateInWindow(range));
  return {
    stillToCollectCentavos: Number(row?.still ?? 0),
    bookingCount: Number(row?.count ?? 0),
  };
}

/**
 * The five headline figures.
 *
 * Two statements, sequential rather than `Promise.all`: the pool is
 * `connectionLimit: 10` and this is a screen one person opens, so a
 * deterministic statement order in a slow-query log is worth more than the
 * few milliseconds.
 */
export async function reportSummary(range: DateRangeInput): Promise<ReportSummary> {
  const moved = await moneyMoved(range);
  const booked = await bookingTotals(range);
  return {
    from: range.from,
    to: range.to,
    ...moved,
    // Received MINUS refunds, from the two sums — never from
    // `amount_paid_centavos`, which knows nothing about money going back out.
    netReceivedCentavos: moved.receivedCentavos - moved.refundedCentavos,
    ...booked,
  };
}

/**
 * The same five figures per tour, over the UNION of the two buckets.
 *
 * Three statements: the grouped money, the grouped bookings, and one title
 * lookup for whichever tour ids the first two between them produced. Ordered
 * by net received descending — the figure an owner opens this table to read —
 * with the title and then the id as tie-breakers, so a window in which nothing
 * moved still has a stable order.
 */
export async function revenueByTour(range: DateRangeInput): Promise<TourRevenueRow[]> {
  const db = getDb();

  const moneyRows = await db
    .select({
      tourId: bookings.tourId,
      received: RECEIVED_CENTAVOS,
      refunded: REFUNDED_CENTAVOS,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(createdInWindow(range))
    .groupBy(bookings.tourId);

  const bookingRows = await db
    .select({
      tourId: bookings.tourId,
      still: STILL_TO_COLLECT_CENTAVOS,
      count: BOOKING_COUNT,
    })
    .from(bookings)
    .where(tourDateInWindow(range))
    .groupBy(bookings.tourId);

  const merged = new Map<number, Omit<TourRevenueRow, 'tourTitle'>>();
  const blank = (tourId: number): Omit<TourRevenueRow, 'tourTitle'> => ({
    tourId,
    receivedCentavos: 0,
    refundedCentavos: 0,
    netReceivedCentavos: 0,
    stillToCollectCentavos: 0,
    bookingCount: 0,
  });

  for (const row of moneyRows) {
    const entry = merged.get(row.tourId) ?? blank(row.tourId);
    entry.receivedCentavos = Number(row.received);
    entry.refundedCentavos = Number(row.refunded);
    entry.netReceivedCentavos = entry.receivedCentavos - entry.refundedCentavos;
    merged.set(row.tourId, entry);
  }
  for (const row of bookingRows) {
    const entry = merged.get(row.tourId) ?? blank(row.tourId);
    entry.stillToCollectCentavos = Number(row.still);
    entry.bookingCount = Number(row.count);
    merged.set(row.tourId, entry);
  }

  if (merged.size === 0) return [];

  const titleRows = await db
    .select({ id: tours.id, title: tours.title })
    .from(tours)
    .where(inArray(tours.id, [...merged.keys()]));
  const titles = new Map(titleRows.map((row) => [row.id, row.title]));

  return [...merged.values()]
    .map((entry) => ({
      ...entry,
      // A tour row can only exist here because a booking points at it, so a
      // missing title would mean a broken foreign key rather than a deleted
      // tour (tours are soft-deleted). The fallback keeps the row readable
      // instead of dropping revenue on the floor.
      tourTitle: titles.get(entry.tourId) ?? `Tour #${entry.tourId}`,
    }))
    .sort(
      (a, b) =>
        b.netReceivedCentavos - a.netReceivedCentavos ||
        a.tourTitle.localeCompare(b.tourTitle) ||
        a.tourId - b.tourId,
    );
}

/**
 * Every booking in the window whose total and paid amount disagree, by tour
 * date.
 *
 * `<>` rather than `>`: a row is listed when it does not BALANCE, in either
 * direction. An overpayment is money the business is holding that nobody has
 * claimed — exactly the row finance wants in front of them — and keeping it
 * also means this list always sums to the summary's `stillToCollectCentavos`,
 * which is a property a test can check and a `> 0` filter would quietly break.
 */
export async function outstandingBookings(range: DateRangeInput): Promise<OutstandingRow[]> {
  const rows = await getDb()
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      tourDate: bookings.tourDate,
      status: bookings.status,
      leadName: bookings.leadName,
      totalCentavos: bookings.totalCentavos,
      /*
       * Aliased `paidCentavos`, not `amountPaidCentavos`:
       * `schema-conventions.test.ts` parses this tree and refuses an
       * object-literal key of that name outside `record-payment.ts`'s two
       * crediting functions — the guard that makes "only a verified webhook or
       * an admin approval marks a booking paid" structural. A read-only report
       * keeps out of its way rather than being added to its allow-list. See
       * `OutstandingRow.paidCentavos` in @rg/shared.
       */
      paidCentavos: bookings.amountPaidCentavos,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    .where(
      and(
        tourDateInWindow(range),
        notInArray(bookings.status, [...REPORT_NON_COLLECTABLE_STATUSES]),
        sql`${bookings.totalCentavos} <> ${bookings.amountPaidCentavos}`,
      ),
    )
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return rows.map((row) => ({
    ...row,
    /*
     * A `date()` column comes back as a `Date`; every caller of this payload
     * wants the civil-date STRING it was stored as. `civilDateFromDate` is the
     * one conversion in this project allowed to answer that, and it never
     * returns null for a `notNull` column.
     */
    tourDate: civilDateFromDate(row.tourDate) ?? range.from,
    outstandingCentavos: row.totalCentavos - row.paidCentavos,
  }));
}
