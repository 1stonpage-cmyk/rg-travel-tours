/**
 * Week 5, Task 13: BUILD_SPEC §9's five dashboard alerts, plus the sixth
 * (`orphanedOnTripVans`, owner decision 2026-10-16 D5) and the seventh
 * (`driverLocked`, owner decision 2026-10-23 Q1).
 *
 * One exported function per alert, so a reviewer can check each against §9
 * line by line and reject one without touching the others. Legible queries,
 * deliberately, rather than one clever union.
 *
 * ## Every function takes an explicit `now`
 *
 * Not a convenience — the reason the owner's Manila boundary tests can exist
 * at all (controller Ruling 2). A time-dependent query that reads the system
 * clock internally cannot be tested AT a boundary without faking timers
 * globally, which is how a timezone bug survives its own test suite. The
 * router passes `new Date()`; the procedure takes no input, so **no browser
 * can move the alert window**.
 *
 * **Three of the seven do not take it**, deliberately narrowing Ruling 2:
 * `paymentsToVerify`, `vansInRepair` and `orphanedOnTripVans` have no time
 * dependence at all — a
 * pending receipt is pending and a van in repair is in repair, whatever the
 * clock says. Giving them a `now` they never read would tell the next reader
 * the clock matters here, and a parameter that lies about what a function
 * depends on is worse than an inconsistent signature. `driverLocked` is on
 * the other side of that line for the same reason: a lockout has an instant
 * it ends at, and whether it has passed is the whole question.
 *
 * Same discipline as `isDriverVisible(status, tourDate, now)` and
 * `bookableDateRange(settings, now)` in `/shared`.
 *
 * ## Dates here are civil dates, compared as strings
 *
 * `vans.next_service`, `.orcr_expiry`, `.franchise_expiry`,
 * `drivers.license_expiry` and `bookings.tour_date` are all Drizzle `date()`
 * columns, which type as `Date` — while every threshold computed here is a
 * `YYYY-MM-DD` string. So comparisons go through raw `sql` on civil-date
 * strings (the house pattern from `capacity.ts:222` and
 * `availability.ts:104`), and values read back out go through
 * `civilDateFromDate`. Never `eq()`/`lte()` against a string: it does not
 * compile, and converting the threshold to a `Date` to make it compile
 * reintroduces the eight-hour shift this convention exists to avoid.
 */
import { and, asc, desc, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  PAPERS_EXPIRING_DAYS,
  SERVICE_DUE_DAYS,
  UNASSIGNED_ALERT_HOURS,
  civilDateFromDate,
  manilaCivilDate,
  type DashboardAlert,
} from '@rg/shared';
import type { Transaction } from '../../db/client';
import { VAN_STATUSES, bookings, drivers, payments, tours, vans } from '../../db/schema';

/** §9: the card shows a secondary line, not a list. */
const MAX_EXAMPLES = 5;

/**
 * `now` → the civil date that many days later, in Asia/Manila.
 *
 * Day arithmetic on the Manila CALENDAR day, not on the instant: adding
 * 14 × 86_400_000 ms to a UTC instant and then reading its Manila date is
 * correct only until it is not, and a service window that slips a day is a
 * van that quietly stops being flagged.
 */
function manilaDatePlusDays(now: Date, days: number): string {
  const today = manilaCivilDate(now);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** `column <= :civilDate`, both sides civil-date strings. */
function onOrBefore(column: unknown, civilDate: string) {
  return sql`${column} <= ${civilDate}`;
}

/**
 * §9 "Payments to verify" — manual receipts waiting on an admin.
 *
 * Counts BOOKINGS, not payment rows: a guest who uploaded twice has one
 * trip needing a decision, and a count of rows would tell the operator to
 * do the same job twice. `payments.status = 'pending'` with
 * `provider = 'manual'` is the queue `admin.bookings.list` already shows.
 */
export async function paymentsToVerify(tx: Transaction): Promise<DashboardAlert> {
  const rows = await tx
    .selectDistinct({
      id: bookings.id,
      ref: bookings.ref,
      tourDate: bookings.tourDate,
    })
    .from(bookings)
    .innerJoin(payments, eq(payments.bookingId, bookings.id))
    .where(and(eq(payments.provider, 'manual'), eq(payments.status, 'pending')))
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return {
    kind: 'payments_to_verify',
    count: rows.length,
    examples: rows.slice(0, MAX_EXAMPLES).map((row) => ({
      id: row.id,
      label: row.ref,
      date: civilDateFromDate(row.tourDate),
    })),
  };
}

/**
 * §9 "Unassigned trips within 48 hours" — owner-decided 2026-10-14 (Q7):
 * counted **back from the tour date**, `confirmed` or `assigned`, missing a van
 * **OR** a driver **OR** holding a driver who has since been deactivated
 * (D4, 2026-10-16 — `assigned` was added to the status set for that).
 *
 * The window is Manila-local and compared civil date to civil date. A naive
 * `now + 48h` against a civil `tour_date` is out by eight hours, which for
 * tours that leave at dawn is a whole tour day — the alert would nag a day
 * early or, worse, stay silent on the morning that matters.
 *
 * `>= today` as well as `<= today + 2`: a trip that departed yesterday
 * unstaffed is not something a dispatcher can still fix, and leaving it in
 * the count makes the number grow forever.
 */
export async function unassignedSoon(tx: Transaction, now: Date): Promise<DashboardAlert> {
  const today = manilaCivilDate(now);
  // 48 hours of tour DAYS: today and the next two civil dates. Expressed
  // from the constant so the screen and the query cannot disagree.
  const windowEnd = manilaDatePlusDays(now, Math.ceil(UNASSIGNED_ALERT_HOURS / 24));

  const rows = await tx
    .select({
      id: bookings.id,
      ref: bookings.ref,
      tourDate: bookings.tourDate,
      tourTitle: tours.title,
    })
    .from(bookings)
    .innerJoin(tours, eq(tours.id, bookings.tourId))
    /*
     * LEFT, never inner: a booking with a null `driver_id` has no drivers row
     * to join, and an inner join would drop exactly the alert's original and
     * most important case.
     */
    .leftJoin(drivers, eq(drivers.id, bookings.driverId))
    .where(
      and(
        inArray(bookings.status, ['confirmed', 'assigned']),
        sql`${bookings.tourDate} >= ${today}`,
        onOrBefore(bookings.tourDate, windowEnd),
        /*
         * OR, never AND: a van with no driver is just as stranded.
         *
         * A trip whose driver has been DEACTIVATED needs assigning, even
         * though `driver_id` is set (owner decision 2026-10-16, D4).
         * Deactivation does not clear `bookings.driver_id` — deliberately,
         * because that id is the record of who was assigned and an audit
         * trail that forgets is not one — so the alert asks about the
         * driver's state rather than the column's nullity.
         *
         * `assigned` joins `confirmed` in the status filter for the same
         * decision (assignment moves a booking `confirmed` to `assigned`, so
         * without it this term could never fire). It changes no count on a
         * healthy fleet: an `assigned` booking has BOTH ids by construction,
         * so the only term it can match is the inactive-driver one. Pinned by
         * `dashboard-alerts.test.ts`.
         *
         * `isActive = false` on a NULL `drivers.is_active` (no joined row) is
         * NULL, not true — and the null-driver case is already caught by
         * `isNull(bookings.driverId)` above.
         */
        or(isNull(bookings.vanId), isNull(bookings.driverId), eq(drivers.isActive, false)),
      ),
    )
    .orderBy(asc(bookings.tourDate), asc(bookings.id));

  return {
    kind: 'unassigned_soon',
    count: rows.length,
    examples: rows.slice(0, MAX_EXAMPLES).map((row) => ({
      id: row.id,
      label: `${row.ref} · ${row.tourTitle}`,
      date: civilDateFromDate(row.tourDate),
    })),
  };
}

/** §9 "Vans in repair". Soft-deleted vans are not the fleet's problem. */
export async function vansInRepair(tx: Transaction): Promise<DashboardAlert> {
  const rows = await tx
    .select({ id: vans.id, plate: vans.plate, notes: vans.repairNotes })
    .from(vans)
    .where(and(eq(vans.isActive, true), eq(vans.status, 'for_repair')))
    .orderBy(asc(vans.plate), asc(vans.id));

  return {
    kind: 'vans_in_repair',
    count: rows.length,
    examples: rows.slice(0, MAX_EXAMPLES).map((row) => ({
      id: row.id,
      label: row.notes ? `${row.plate} — ${row.notes}` : row.plate,
      date: null,
    })),
  };
}

/**
 * §9 "Van service due within 14 days".
 *
 * `next_service <= today + 14`, with **no lower bound** — so a van whose
 * service date has already passed is still counted. An OVERDUE service is
 * more urgent, not less, and a naive `BETWEEN today AND today + 14` silently
 * drops exactly the vans that most need the garage. Both read correctly;
 * only one is right.
 */
export async function serviceDue(tx: Transaction, now: Date): Promise<DashboardAlert> {
  const windowEnd = manilaDatePlusDays(now, SERVICE_DUE_DAYS);
  const rows = await tx
    .select({ id: vans.id, plate: vans.plate, nextService: vans.nextService })
    .from(vans)
    .where(and(eq(vans.isActive, true), onOrBefore(vans.nextService, windowEnd)))
    .orderBy(asc(vans.nextService), asc(vans.id));

  return {
    kind: 'service_due',
    count: rows.length,
    examples: rows.slice(0, MAX_EXAMPLES).map((row) => ({
      id: row.id,
      label: row.plate,
      date: civilDateFromDate(row.nextService),
    })),
  };
}

/**
 * §9 "Driver license, OR/CR, and LTFRB franchise expiring within 30 days".
 *
 * Three sources, one alert, because that is how §9 words it and how an
 * operator thinks about it: paperwork that is about to stop a vehicle or a
 * person being legal. Like `serviceDue` there is no lower bound — already
 * expired is the worst case, not an excluded one.
 */
export async function papersExpiring(tx: Transaction, now: Date): Promise<DashboardAlert> {
  const windowEnd = manilaDatePlusDays(now, PAPERS_EXPIRING_DAYS);

  const vanRows = await tx
    .select({
      id: vans.id,
      plate: vans.plate,
      orcrExpiry: vans.orcrExpiry,
      franchiseExpiry: vans.franchiseExpiry,
    })
    .from(vans)
    .where(
      and(
        eq(vans.isActive, true),
        or(onOrBefore(vans.orcrExpiry, windowEnd), onOrBefore(vans.franchiseExpiry, windowEnd)),
      ),
    )
    .orderBy(asc(vans.plate), asc(vans.id));

  const driverRows = await tx
    .select({ id: drivers.id, name: drivers.name, licenseExpiry: drivers.licenseExpiry })
    .from(drivers)
    .where(and(eq(drivers.isActive, true), onOrBefore(drivers.licenseExpiry, windowEnd)))
    .orderBy(asc(drivers.licenseExpiry), asc(drivers.id));

  /*
   * One van can have BOTH papers expiring and is one row in the examples,
   * but §9's alert counts things that need chasing — so a van needing two
   * documents renewed is counted once with both named. Counting documents
   * instead would tell the operator to chase a van twice.
   */
  const examples = [
    ...vanRows.map((row) => {
      const parts: string[] = [];
      const orcr = civilDateFromDate(row.orcrExpiry);
      const franchise = civilDateFromDate(row.franchiseExpiry);
      if (orcr !== null && orcr <= windowEnd) parts.push('OR/CR');
      if (franchise !== null && franchise <= windowEnd) parts.push('franchise');
      return {
        id: row.id,
        label: `${row.plate} — ${parts.join(' and ')}`,
        date: [orcr, franchise].filter((d): d is string => d !== null).sort()[0] ?? null,
      };
    }),
    ...driverRows.map((row) => ({
      id: row.id,
      label: `${row.name} — licence`,
      date: civilDateFromDate(row.licenseExpiry),
    })),
  ].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));

  return {
    kind: 'papers_expiring',
    count: vanRows.length + driverRows.length,
    examples: examples.slice(0, MAX_EXAMPLES),
  };
}

/**
 * The status `startTrip` writes and only a completion (or the cancellation of
 * a running trip) clears — `services/trips/checkins.ts` is its sole writer.
 * Checked against `VAN_STATUSES` at compile time, so a rename cannot leave
 * this query asking about a status that no longer exists.
 *
 * It is, by definition, one of the statuses `VAN_STATUS_SELLABLE` does NOT
 * allow; that relationship is the reason this alert exists, not something
 * to re-derive here.
 */
const VAN_STATUS_ON_TRIP = 'on_trip' as const satisfies (typeof VAN_STATUSES)[number];

/**
 * The sixth dashboard alert, added by owner decision 2026-10-16 (D5) — NOT
 * from BUILD_SPEC §9: **a van sitting in `on_trip` with no running trip to
 * explain it.**
 *
 * `vans.status` is not date-scoped, so a van left here is refused on every
 * future date at once (`VAN_STATUS_SELLABLE`, CLAUDE.md's Dispatch section).
 * Nothing puts it back except a completion or the cancellation of a running
 * trip. A driver whose phone dies at the last stop therefore removes a van
 * from sale indefinitely, and the symptom arrives weeks later as "we are
 * fully booked" on a day with idle vans.
 *
 * **This function is an OBSERVATION, and the alert is the whole fix.**
 * Nothing here or in `jobs/orphaned-vans.ts` writes a van status. That is the
 * owner's instruction, not an omission: on the one day a trip genuinely
 * overruns past midnight, an automatic sweep would put a van with guests in
 * it back on sale. A dispatcher looking at the alert knows which of the two
 * it is; a cron job never can.
 *
 * No `now`, for the reason in the module note: "is there an `in_progress`
 * booking for this van" is a question about state, not about the clock.
 *
 * Soft-deleted vans are left out, like every other van alert here.
 *
 * The alert's shape is the existing `DashboardAlert`, not a new one: a van
 * has no date, so `date` is null; `id` is the van's, and the plate and the
 * last booking that named it go into `label`. That booking is the most recent
 * by tour date, whatever its status — a LEAD for the dispatcher's first
 * question ("which trip was this?"), not a claim that it stranded the van.
 *
 * Two statements however many vans match, never one per van: the stranded
 * vans, then the last booking for the (at most five) vans the card names.
 * Longest-stranded first (`updated_at` ascending — the status write is what
 * last touched the row, short of a hand edit).
 */
export async function orphanedOnTripVans(tx: Transaction): Promise<DashboardAlert> {
  const running = alias(bookings, 'running');
  const rows = await tx
    .select({ id: vans.id, plate: vans.plate })
    .from(vans)
    .where(
      and(
        eq(vans.isActive, true),
        eq(vans.status, VAN_STATUS_ON_TRIP),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(running)
            .where(and(sql`${running.vanId} = ${vans.id}`, eq(running.status, 'in_progress'))),
        ),
      ),
    )
    .orderBy(asc(vans.updatedAt), asc(vans.id));

  const shown = rows.slice(0, MAX_EXAMPLES);
  const lastByVan = new Map<number, { ref: string; tourDate: Date }>();
  if (shown.length > 0) {
    const later = alias(bookings, 'later');
    const latest = await tx
      .select({ vanId: bookings.vanId, ref: bookings.ref, tourDate: bookings.tourDate })
      .from(bookings)
      .where(
        and(
          inArray(
            bookings.vanId,
            shown.map((row) => row.id),
          ),
          eq(
            bookings.id,
            tx
              .select({ id: later.id })
              .from(later)
              .where(sql`${later.vanId} = ${bookings.vanId}`)
              .orderBy(desc(later.tourDate), desc(later.id))
              .limit(1),
          ),
        ),
      );
    for (const row of latest) {
      if (row.vanId !== null) lastByVan.set(row.vanId, row);
    }
  }

  return {
    kind: 'orphaned_on_trip',
    count: rows.length,
    examples: shown.map((row) => {
      const last = lastByVan.get(row.id);
      return {
        id: row.id,
        label: last
          ? `${row.plate} · last trip ${last.ref} on ${civilDateFromDate(last.tourDate)}`
          : row.plate,
        date: null,
      };
    }),
  };
}

/**
 * The seventh dashboard alert, added by owner decision 2026-10-23 (Q1, option
 * C+E) — NOT from BUILD_SPEC §9: **an active driver whose PIN lockout is still
 * running.**
 *
 * It ships with the backing-off lockout for a reason the decision is explicit
 * about: the lockout now lifts itself by the clock, so the office does not
 * HAVE to act — but it should be able to see that a driver cannot sign in
 * without that driver ringing to say so, because the person this most often
 * happens to is standing at a van before dawn. The card links to
 * `/admin/drivers`, where `admin.drivers.unlock` lifts it immediately and
 * without issuing a new PIN.
 *
 * Unlike `orphanedOnTripVans` this one DOES take `now`: "is the lockout still
 * running" is a question about the clock, compared against the same instant as
 * every other time-aware alert on the board. A lapsed lockout is not news.
 *
 * `is_active` only, like every other driver and van alert here — a
 * soft-deleted driver cannot sign in regardless, and saying so would send a
 * dispatcher to unlock an account nobody is using.
 *
 * `locked_until` is a real `datetime`, not one of this file's civil-date
 * columns, so it is compared with `gt()` against a `Date` — no `sql` template
 * and no `manilaDatePlusDays` here. Longest-locked first, so the driver who
 * has been stuck the longest is the one named on a card that shows five.
 */
export async function driverLocked(tx: Transaction, now: Date): Promise<DashboardAlert> {
  const rows = await tx
    .select({ id: drivers.id, name: drivers.name, lockedUntil: drivers.lockedUntil })
    .from(drivers)
    .where(and(eq(drivers.isActive, true), gt(drivers.lockedUntil, now)))
    .orderBy(asc(drivers.lockedUntil), asc(drivers.id));

  return {
    kind: 'driver_locked',
    count: rows.length,
    examples: rows.slice(0, MAX_EXAMPLES).map((row) => ({
      id: row.id,
      label: row.name,
      // Deliberately null, like `vansInRepair`'s: `DashboardAlert.date` is a
      // civil DATE and this is a time of day an hour from now. Putting a
      // truncated date here would read as "locked until the 24th".
      date: null,
    })),
  };
}

/**
 * All seven, always — zeroes included.
 *
 * A dashboard that hides its empty alerts teaches an operator that an absent
 * card means "fine", which is indistinguishable from "the query broke". Seven
 * cards, every load, each stating its number. The sixth and seventh are LAST,
 * in the order they were added, so the existing five keep theirs.
 */
export async function dashboardAlerts(tx: Transaction, now: Date): Promise<DashboardAlert[]> {
  return [
    await paymentsToVerify(tx),
    await unassignedSoon(tx, now),
    await vansInRepair(tx),
    await serviceDue(tx, now),
    await papersExpiring(tx, now),
    await orphanedOnTripVans(tx),
    await driverLocked(tx, now),
  ];
}
