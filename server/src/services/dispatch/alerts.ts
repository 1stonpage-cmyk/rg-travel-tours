/**
 * Week 5, Task 13: BUILD_SPEC §9's five dashboard alerts.
 *
 * One exported function per alert, so a reviewer can check each against §9
 * line by line and reject one without touching the other four. Five legible
 * queries, deliberately, rather than one clever union.
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
 * **Two of the five do not take it**, deliberately narrowing Ruling 2:
 * `paymentsToVerify` and `vansInRepair` have no time dependence at all — a
 * pending receipt is pending and a van in repair is in repair, whatever the
 * clock says. Giving them a `now` they never read would tell the next reader
 * the clock matters here, and a parameter that lies about what a function
 * depends on is worse than an inconsistent signature.
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
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  PAPERS_EXPIRING_DAYS,
  SERVICE_DUE_DAYS,
  UNASSIGNED_ALERT_HOURS,
  civilDateFromDate,
  manilaCivilDate,
  type DashboardAlert,
} from '@rg/shared';
import type { Transaction } from '../../db/client';
import { bookings, drivers, payments, tours, vans } from '../../db/schema';

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
 * counted **back from the tour date**, `confirmed` only, missing a van
 * **OR** a driver.
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
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        sql`${bookings.tourDate} >= ${today}`,
        onOrBefore(bookings.tourDate, windowEnd),
        // OR, never AND: a van with no driver is just as stranded.
        or(isNull(bookings.vanId), isNull(bookings.driverId)),
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
 * All five, always — zeroes included.
 *
 * A dashboard that hides its empty alerts teaches an operator that an absent
 * card means "fine", which is indistinguishable from "the query broke". Five
 * cards, every load, each stating its number.
 */
export async function dashboardAlerts(tx: Transaction, now: Date): Promise<DashboardAlert[]> {
  return [
    await paymentsToVerify(tx),
    await unassignedSoon(tx, now),
    await vansInRepair(tx),
    await serviceDue(tx, now),
    await papersExpiring(tx, now),
  ];
}
