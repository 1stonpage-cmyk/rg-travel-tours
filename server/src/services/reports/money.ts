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
import { and, asc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  REPORT_NON_COLLECTABLE_STATUSES,
  addCivilDays,
  civilDateFromDate,
  manilaCivilDate,
  manilaInstant,
  type DashboardMoneySummary,
  type DateRangeInput,
  type OutstandingRow,
  type ReportSummary,
  type RouteRevenueRow,
  type TourRevenueRow,
  type TransferDirection,
} from '@rg/shared';
import { getDb } from '../../db/client';
import {
  bookingTransferDetails,
  bookings,
  payments,
  tours,
  transferPlaces,
  transferRoutes,
  vehicleTypes,
} from '../../db/schema';
import { routeDisplayName, transferTitle } from '../transfers/display';

/** Two aliases onto the same `transfer_places` table — one per report function below. */
const outstandingFromPlace = alias(transferPlaces, 'outstandingFromPlace');
const outstandingToPlace = alias(transferPlaces, 'outstandingToPlace');
const routeRevenueFromPlace = alias(transferPlaces, 'routeRevenueFromPlace');
const routeRevenueToPlace = alias(transferPlaces, 'routeRevenueToPlace');

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
 *
 * **"Not cancelled or expired" is `REPORT_NON_COLLECTABLE_STATUSES`** (7N,
 * Task 12), the same constant `outstandingBookings`'s `notInArray` below
 * reads — not a second, hand-typed `('cancelled', 'expired')` literal. Two
 * copies of this rule is how the summary card and the per-booking list end
 * up answering a different question about the same window; `notInArray`
 * embeds the same condition object this module's `.where()` clauses use, so
 * the two statuses live in exactly one place.
 */
export const STILL_TO_COLLECT_CENTAVOS = sql<number>`COALESCE(SUM(CASE WHEN ${notInArray(bookings.status, [...REPORT_NON_COLLECTABLE_STATUSES])} THEN ${bookings.totalCentavos} - ${bookings.amountPaidCentavos} ELSE 0 END), 0)`;

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
 * **"Pending verification."** `SUM(amount_centavos)` over the exact same
 * population `paymentsToVerify()` (`services/dispatch/alerts.ts`) already
 * COUNTS — `type='payment' AND provider='manual' AND status='pending'` —
 * just summed instead of counted. Deliberately NOT date-scoped: a manual
 * receipt uploaded yesterday and still unverified is still pending today,
 * and scoping this to a window would hide it from the one screen built to
 * surface it (Task 1B, `DashboardMoneySummary`'s own doc comment).
 *
 * A fresh predicate, not `alerts.ts`'s own query reused: that file is
 * explicitly frozen (owner instruction, Task 1B) and this needs a `SUM`,
 * not the `SELECT DISTINCT bookings…` shape `paymentsToVerify()` returns —
 * but the WHERE clause is the same population by construction, and the two
 * must never drift (a payment `type` other than `'payment'` here would
 * double-count a refund waiting on the same manual-review status, which
 * cannot happen today but would be silent if it ever did).
 */
const PENDING_VERIFICATION_CENTAVOS = sql<number>`COALESCE(SUM(CASE WHEN ${payments.type} = 'payment' AND ${payments.provider} = 'manual' AND ${payments.status} = 'pending' THEN ${payments.amountCentavos} ELSE 0 END), 0)`;

/**
 * The admin dashboard's money block (Task 1B, Direction B). Two statements,
 * sequential — same reasoning as `reportSummary`'s own pair. `now` is a
 * parameter, never read internally, so "today" is exactly assertable at a
 * Manila-midnight boundary (the same discipline every `now`-taking function
 * in `services/dispatch/alerts.ts` uses).
 */
export async function dashboardMoneySummary(now: Date): Promise<DashboardMoneySummary> {
  const today = manilaCivilDate(now);
  const db = getDb();

  const [collected] = await db
    .select({ received: RECEIVED_CENTAVOS })
    .from(payments)
    .where(createdInWindow({ from: today, to: today }));

  const [pending] = await db.select({ pending: PENDING_VERIFICATION_CENTAVOS }).from(payments);

  return {
    collectedTodayCentavos: Number(collected?.received ?? 0),
    pendingVerificationCentavos: Number(pending?.pending ?? 0),
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

  /*
   * `bookings.tour_id` is nullable since migration 0017, so both GROUP BYs can
   * now produce a NULL bucket holding every transfer booking's money. This
   * report is revenue BY TOUR and there is no tour to name it with, so the
   * bucket is skipped rather than merged into a bogus tour id.
   *
   * **Audited in Task T6: skipping is correct, and no change belongs here.**
   * `tour-only`, in the audit's own vocabulary — a per-tour table that invented
   * a row for revenue belonging to no tour would be lying in a way no later
   * task could unpick.
   *
   * **The real gap, stated so nobody re-litigates it as a null bug.**
   * `reportSummary` (this file's other export, composing `moneyMoved` and
   * `bookingTotals`) is not scoped by tour at all, so its top-line figures
   * WILL include transfer money the moment transfers exist while this per-tour
   * table will not. The two owner-facing numbers then disagree by exactly the
   * transfer revenue. That is a reporting-COMPLETENESS gap — there is no
   * transfer breakdown yet — and it closes when **T18** adds
   * `revenueByRoute()`, the transfer-side counterpart, alongside this. Not a
   * reason to change the skip.
   */
  for (const row of moneyRows) {
    if (row.tourId === null) continue;
    const entry = merged.get(row.tourId) ?? blank(row.tourId);
    entry.receivedCentavos = Number(row.received);
    entry.refundedCentavos = Number(row.refunded);
    entry.netReceivedCentavos = entry.receivedCentavos - entry.refundedCentavos;
    merged.set(row.tourId, entry);
  }
  for (const row of bookingRows) {
    if (row.tourId === null) continue;
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
 * The same five figures, grouped by (route, direction, vehicle type) instead
 * of by tour — `revenueByTour`'s transfer-side counterpart (Task T18), and
 * the fix for the reporting-completeness gap that function's own comment
 * names: `reportSummary` already includes transfer money; this is what lets
 * the per-route table (and the per-tour one) sum back to it.
 *
 * **`LEFT JOIN booking_transfer_details`, deliberately, even though every
 * `product_type <> 'tour'` row has exactly one today** (written together with
 * the booking in `createTransferBooking()`). An `INNER JOIN` here would trust
 * a cross-table invariant no CHECK can express — exactly the reasoning
 * `services/transfers/capacity.ts` and `services/dispatch/availability.ts`
 * give for the same join elsewhere — so a missing details row (a future
 * writer's bug, not today's) drops that booking's money from this report with
 * no error, rather than failing loudly. `requireDirection()` below is the loud
 * failure: it throws rather than silently defaulting, the same choice
 * `requireVehicleTypeId()` makes a few lines down.
 *
 * **Grouped by route + direction + vehicle type, not by product type.** A
 * route's row therefore mixes one-way and day-use revenue — the plan's own
 * granularity, not a bug; a fourth axis was deliberately not added.
 *
 * **No status filter beyond `product_type <> 'tour'`**, on either query —
 * copying `outstandingBookings`'s `notInArray(status, …)` in here would
 * silently drop cancelled transfers from `bookingCount` and break the sum
 * against `reportSummary`, which counts every status. `STILL_TO_COLLECT_CENTAVOS`
 * already excludes the non-collectable statuses from the BALANCE, same as
 * `revenueByTour`.
 */
export async function revenueByRoute(range: DateRangeInput): Promise<RouteRevenueRow[]> {
  const db = getDb();
  const notTour = ne(bookings.productType, 'tour');

  const moneyRows = await db
    .select({
      routeId: bookings.routeId,
      direction: bookingTransferDetails.direction,
      vehicleTypeId: bookings.vehicleTypeId,
      received: RECEIVED_CENTAVOS,
      refunded: REFUNDED_CENTAVOS,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .where(and(createdInWindow(range), notTour))
    .groupBy(bookings.routeId, bookingTransferDetails.direction, bookings.vehicleTypeId);

  const bookingRows = await db
    .select({
      routeId: bookings.routeId,
      direction: bookingTransferDetails.direction,
      vehicleTypeId: bookings.vehicleTypeId,
      still: STILL_TO_COLLECT_CENTAVOS,
      count: BOOKING_COUNT,
    })
    .from(bookings)
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .where(and(tourDateInWindow(range), notTour))
    .groupBy(bookings.routeId, bookingTransferDetails.direction, bookings.vehicleTypeId);

  /**
   * `bookings.vehicle_type_id` reads back `number | null` from Drizzle
   * (the column itself is nullable, for a tour), but `bookings_product_type_shape`
   * guarantees it is NOT NULL for every row these two queries select — both are
   * filtered to `product_type <> 'tour'`. Throwing rather than coercing: a null
   * here would mean the CHECK itself failed, which is loud-bug territory, not a
   * `?? 0` to paper over.
   */
  function requireVehicleTypeId(id: number | null): number {
    if (id === null) {
      throw new Error('revenueByRoute: a non-tour booking has a null vehicle_type_id.');
    }
    return id;
  }

  /**
   * `direction` reads back `TransferDirection | null` only because of the
   * `LEFT JOIN` above — the column itself is NOT NULL. A null here means the
   * join found no `booking_transfer_details` row at all, which the comment
   * above this function explains is a real (if latent) bug to surface loudly,
   * not paper over.
   */
  function requireDirection(direction: TransferDirection | null): TransferDirection {
    if (direction === null) {
      throw new Error('revenueByRoute: a non-tour booking has no booking_transfer_details row.');
    }
    return direction;
  }

  /**
   * A routeless custom trip has no two places to travel between in two
   * directions — `createTransferBooking()`'s `reverseEnabled` check only runs
   * when a route actually exists (design note §1.7), so a custom booking's
   * `direction` column can legitimately read either value and means nothing.
   * Normalised to `'forward'` here so every custom transfer lands in ONE
   * bucket: without this, two money-bearing rows could render with the
   * byte-identical label "Custom transfer (Van)" — indistinguishable on
   * screen from a duplicate or a double-count, in a report about money.
   */
  function normalizedDirection(
    routeId: number | null,
    direction: TransferDirection,
  ): TransferDirection {
    return routeId === null ? 'forward' : direction;
  }

  type Entry = Omit<RouteRevenueRow, 'routeLabel'>;
  const keyOf = (routeId: number | null, direction: TransferDirection, vehicleTypeId: number) =>
    `${routeId ?? 'custom'}|${direction}|${vehicleTypeId}`;
  const blank = (
    routeId: number | null,
    direction: TransferDirection,
    vehicleTypeId: number,
  ): Entry => ({
    routeId,
    direction,
    vehicleTypeId,
    receivedCentavos: 0,
    refundedCentavos: 0,
    netReceivedCentavos: 0,
    stillToCollectCentavos: 0,
    bookingCount: 0,
  });

  const merged = new Map<string, Entry>();
  for (const row of moneyRows) {
    const vehicleTypeId = requireVehicleTypeId(row.vehicleTypeId);
    const direction = normalizedDirection(row.routeId, requireDirection(row.direction));
    const key = keyOf(row.routeId, direction, vehicleTypeId);
    const entry = merged.get(key) ?? blank(row.routeId, direction, vehicleTypeId);
    entry.receivedCentavos = Number(row.received);
    entry.refundedCentavos = Number(row.refunded);
    entry.netReceivedCentavos = entry.receivedCentavos - entry.refundedCentavos;
    merged.set(key, entry);
  }
  for (const row of bookingRows) {
    const vehicleTypeId = requireVehicleTypeId(row.vehicleTypeId);
    const direction = normalizedDirection(row.routeId, requireDirection(row.direction));
    const key = keyOf(row.routeId, direction, vehicleTypeId);
    const entry = merged.get(key) ?? blank(row.routeId, direction, vehicleTypeId);
    entry.stillToCollectCentavos = Number(row.still);
    entry.bookingCount = Number(row.count);
    merged.set(key, entry);
  }

  if (merged.size === 0) return [];

  const entries = [...merged.values()];
  const routeIds = [
    ...new Set(entries.map((e) => e.routeId).filter((id): id is number => id !== null)),
  ];
  const vehicleTypeIds = [...new Set(entries.map((e) => e.vehicleTypeId))];

  const routeRows =
    routeIds.length === 0
      ? []
      : await db
          .select({
            id: transferRoutes.id,
            fromName: routeRevenueFromPlace.name,
            toName: routeRevenueToPlace.name,
          })
          .from(transferRoutes)
          .innerJoin(
            routeRevenueFromPlace,
            eq(routeRevenueFromPlace.id, transferRoutes.fromPlaceId),
          )
          .innerJoin(routeRevenueToPlace, eq(routeRevenueToPlace.id, transferRoutes.toPlaceId))
          .where(inArray(transferRoutes.id, routeIds));
  const routeNames = new Map(
    routeRows.map((r) => [r.id, { fromName: r.fromName, toName: r.toName }]),
  );

  const vehicleRows = await db
    .select({ id: vehicleTypes.id, name: vehicleTypes.name })
    .from(vehicleTypes)
    .where(inArray(vehicleTypes.id, vehicleTypeIds));
  const vehicleNames = new Map(vehicleRows.map((r) => [r.id, r.name]));

  return entries
    .map((entry) => {
      const vehicleName =
        vehicleNames.get(entry.vehicleTypeId) ?? `Vehicle type #${entry.vehicleTypeId}`;
      const names = entry.routeId === null ? null : routeNames.get(entry.routeId);
      // `names` can only be missing for a route id that no longer exists, which
      // a RESTRICT foreign key does not allow — same reasoning as `revenueByTour`'s
      // `Tour #${id}` fallback just above, kept here for the same broken-FK case.
      const routeTitle =
        entry.routeId === null
          ? 'Custom transfer'
          : names
            ? routeDisplayName(names.fromName, names.toName, entry.direction)
            : `Route #${entry.routeId}`;
      return { ...entry, routeLabel: `${routeTitle} (${vehicleName})` };
    })
    .sort(
      (a, b) =>
        b.netReceivedCentavos - a.netReceivedCentavos ||
        a.routeLabel.localeCompare(b.routeLabel) ||
        keyOf(a.routeId, a.direction, a.vehicleTypeId).localeCompare(
          keyOf(b.routeId, b.direction, b.vehicleTypeId),
        ),
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
 *
 * **`LEFT JOIN tours`, not `INNER JOIN` (Task T18, Must-fix #1).** `bookings.tour_id`
 * is nullable since migration 0017, so an inner join silently dropped every
 * transfer booking from this list — the exact hazard `bookings.tour_id`'s own
 * doc comment in `schema.ts` names. `tourTitle` is `tours.title` for a tour,
 * or the transfer's route ("Mactan Airport → Oslob") / "Custom transfer" for
 * a staff-quoted one with no catalog route — the same fallback
 * `revenueByRoute()` below uses, computed in `transferTitle()`.
 */
export async function outstandingBookings(range: DateRangeInput): Promise<OutstandingRow[]> {
  const rows = await getDb()
    .select({
      bookingId: bookings.id,
      ref: bookings.ref,
      tourTitle: tours.title,
      fromPlaceName: outstandingFromPlace.name,
      toPlaceName: outstandingToPlace.name,
      direction: bookingTransferDetails.direction,
      customRouteDescription: bookingTransferDetails.customRouteDescription,
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
    .leftJoin(tours, eq(tours.id, bookings.tourId))
    .leftJoin(bookingTransferDetails, eq(bookingTransferDetails.bookingId, bookings.id))
    .leftJoin(transferRoutes, eq(transferRoutes.id, bookings.routeId))
    .leftJoin(outstandingFromPlace, eq(outstandingFromPlace.id, transferRoutes.fromPlaceId))
    .leftJoin(outstandingToPlace, eq(outstandingToPlace.id, transferRoutes.toPlaceId))
    .where(
      and(
        tourDateInWindow(range),
        notInArray(bookings.status, [...REPORT_NON_COLLECTABLE_STATUSES]),
        sql`${bookings.totalCentavos} <> ${bookings.amountPaidCentavos}`,
      ),
    )
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return rows.map((row) => ({
    bookingId: row.bookingId,
    ref: row.ref,
    tourTitle:
      row.tourTitle ??
      transferTitle({
        fromName: row.fromPlaceName,
        toName: row.toPlaceName,
        direction: row.direction,
        customRouteDescription: row.customRouteDescription,
      }),
    tourDate: civilTourDateOrThrow(row),
    status: row.status,
    leadName: row.leadName,
    totalCentavos: row.totalCentavos,
    paidCentavos: row.paidCentavos,
    outstandingCentavos: row.totalCentavos - row.paidCentavos,
  }));
}

/**
 * A `date()` column comes back as a `Date`; every caller of `OutstandingRow`
 * wants the civil-date STRING it was stored as. `civilDateFromDate` is the
 * one conversion in this project allowed to answer that, and `tour_date` is
 * `NOT NULL`, so this should never read back null.
 *
 * It used to fall back to `range.from` — the window's own START date —
 * silently substituted in for a per-row date that is supposed to be real
 * (7N, Task 12). That fallback could never fire today, and that is exactly
 * the problem: if a future change (a migration, a hand-written `UPDATE`)
 * ever let `tour_date` go null, finance would be shown someone else's
 * booking under the window's start date instead of being told the row is
 * broken. Throwing, naming the booking, is the loud version of a bug that
 * would otherwise look like correct data.
 *
 * A standalone function — rather than inlined in the `.map()` above —
 * because that is what lets a test construct the null case directly,
 * without needing a `NOT NULL` column in the real database to ever hold one.
 */
export function civilTourDateOrThrow(row: {
  bookingId: number;
  ref: string;
  tourDate: Date | null;
}): string {
  const tourDate = civilDateFromDate(row.tourDate);
  if (tourDate === null) {
    throw new Error(
      `outstandingBookings: booking ${row.bookingId} (ref ${row.ref}) has a null ` +
        'tour_date, which the NOT NULL column should never produce.',
    );
  }
  return tourDate;
}
