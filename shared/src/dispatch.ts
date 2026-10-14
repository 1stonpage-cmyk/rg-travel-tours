/**
 * Shared dispatch schemas (Week 5 plan, Task 4 — the van half; later tasks
 * in this plan add drivers and assignment to this same file).
 *
 * `.strict()` on `vanInputSchema` is not decoration: it is the same guard
 * the checkout schemas use (`shared/src/checkout.ts`), and it is what stops
 * a client posting `isActive: true` or a `status` through the CRUD door
 * rather than through `admin.vans.setStatus`.
 *
 * The four civil-date fields reuse `civilDateSchema` from `./checkout`
 * (Ruling 8) rather than a third private copy of the same regex — the
 * pattern already existed twice in this tree (here and in
 * `server/src/services/capacity.ts`'s `CIVIL_DATE`, which backs a
 * programmer-error assertion and stays separate on purpose).
 */
import { z } from 'zod';
import type { BookingStatus } from './booking';
import { civilDateSchema, phPhoneSchema } from './checkout';

export const vanInputSchema = z
  .object({
    plate: z.string().trim().min(3).max(20).toUpperCase(),
    model: z.string().trim().min(2).max(120),
    capacity: z.number().int().min(1).max(30),
    odometer: z.number().int().min(0).max(5_000_000).nullable(),
    lastService: civilDateSchema.nullable(),
    nextService: civilDateSchema.nullable(),
    orcrExpiry: civilDateSchema.nullable(),
    franchiseNo: z.string().trim().max(80).nullable(),
    franchiseExpiry: civilDateSchema.nullable(),
    repairNotes: z.string().trim().max(2000).nullable(),
  })
  .strict();
export type VanInput = z.infer<typeof vanInputSchema>;

/**
 * One row of the fleet list (`admin.vans.list`).
 *
 * `status` is typed as `string` rather than importing the enum from
 * `server/src/db/schema.ts`'s `VAN_STATUSES`: that array is the server's
 * authoritative list (owner decision 2026-10-14, Task 2 of this plan), and
 * `@rg/shared` must not depend on `@rg/server` to re-type it. The router
 * validates `setStatus`'s input against the real `VAN_STATUSES` directly.
 */
export interface VanRow {
  id: number;
  plate: string;
  model: string;
  capacity: number;
  status: string;
  odometer: number | null;
  lastService: string | null;
  nextService: string | null;
  orcrExpiry: string | null;
  franchiseNo: string | null;
  franchiseExpiry: string | null;
  repairNotes: string | null;
  isActive: boolean;
}

/**
 * Driver CRUD input (Week 5 plan, Task 6; BUILD_SPEC §9 "Drivers"). `code` is
 * the short login code the driver types on the portal — `phPhoneSchema`
 * reused from `./checkout` rather than a private copy, same reasoning as
 * `vanInputSchema` reusing `civilDateSchema`.
 *
 * Deliberately excludes `pinHash`, the five lockout columns and `status`:
 * none of those are CRUD fields a client posts. The PIN is minted by the
 * server (`admin.drivers.create` / `.resetPin`); the lockout columns are
 * owned by the Week 6 login route and the admin unlock; `status` has no
 * admin-facing setter in this task (no `admin.drivers.setStatus` is listed in
 * the plan, unlike vans).
 */
export const driverInputSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    code: z.string().trim().min(1).max(20),
    phone: phPhoneSchema,
    licenseNo: z.string().trim().max(80).nullable(),
    licenseExpiry: civilDateSchema.nullable(),
    languages: z.array(z.string().trim().min(1).max(40)).max(20).nullable(),
    emergencyContact: z.string().trim().max(200).nullable(),
  })
  .strict();
export type DriverInput = z.infer<typeof driverInputSchema>;

/**
 * One row of the fleet-of-people list (`admin.drivers.list`).
 *
 * No `pinHash` field exists on this type — not "present but omitted at the
 * call site", structurally absent, so a `list` resolver that forgets the
 * explicit column projection fails to typecheck against this shape too.
 */
export interface DriverRow {
  id: number;
  name: string;
  code: string;
  phone: string;
  licenseNo: string | null;
  licenseExpiry: string | null;
  languages: string[] | null;
  emergencyContact: string | null;
  status: string;
  isActive: boolean;
  /**
   * This driver's leave rows, soonest first (controller fix, 2026-10-14).
   *
   * The plan shipped `addLeave` and `removeLeave` without any way to READ a
   * leave, which left two things broken at once: §9 asks the drivers screen
   * to show "on leave (with date ranges)" and it had nothing to show, and
   * **`removeLeave` takes a leave id the client had no way to obtain** — a
   * mutation unreachable from the only UI that calls it. Worse, `addLeave`
   * refuses an overlap, so a dispatcher would be told "that overlaps an
   * existing leave" while looking at a screen that could not name which one.
   *
   * Civil-date strings on the wire, like every other date in this API.
   */
  leaves: DriverLeaveRow[];
}

/**
 * BUILD_SPEC §9's driver availability model — **derived, not stored**
 * (controller fix, 2026-10-14).
 *
 * §9 describes a driver as `active / on leave (with date ranges) / inactive`.
 * The database has two unrelated things instead: `drivers.is_active` (the
 * soft-delete flag) and `drivers.status`, whose values are
 * `available | on_trip | off_duty` — a *dispatch* state, not §9's model. And
 * "on leave" is deliberately NOT a flag: Q4 settled that leave is a date
 * RANGE, because a flag set today would hide a driver from every future date
 * until somebody remembered to clear it.
 *
 * So §9's three states are computed from the two sources that actually
 * answer the question:
 *
 *  - `inactive`  — `is_active = 0`. Soft-deleted; nothing else matters.
 *  - `on_leave`  — a `driver_leaves` row covers TODAY in Asia/Manila.
 *  - `active`    — neither.
 *
 * `drivers.status` is left out on purpose: it is what the driver is doing
 * right now, which is a different question from whether they are on the
 * roster. The admin screen renders both, labelled differently.
 *
 * Inclusive at both ends, like every leave comparison in this codebase: a
 * one-day leave has `startDate === endDate`, and string comparison is safe
 * because both sides are zero-padded `YYYY-MM-DD`.
 */
export type DriverAvailability =
  { state: 'inactive' } | { state: 'on_leave'; until: string } | { state: 'active' };

export function driverAvailability(
  driver: { isActive: boolean; leaves: DriverLeaveRow[] },
  todayManila: string,
): DriverAvailability {
  if (!driver.isActive) return { state: 'inactive' };
  const covering = driver.leaves.find(
    (leave) => leave.startDate <= todayManila && leave.endDate >= todayManila,
  );
  return covering ? { state: 'on_leave', until: covering.endDate } : { state: 'active' };
}

/** One `driver_leaves` row as the admin screen receives it. */
export interface DriverLeaveRow {
  id: number;
  startDate: string;
  endDate: string;
  reason: string | null;
}

/**
 * A driver leave (`admin.drivers.addLeave`). `startDate` / `endDate` are
 * civil-date strings on the wire — the router converts to the `Date` the
 * `driver_leaves.start_date` / `.end_date` `date()` columns want.
 *
 * The `endDate >= startDate` refinement mirrors the DB CHECK
 * (`driver_leaves_date_order`) at the Zod boundary, so a backwards range is a
 * 400 before any query runs — string comparison on zero-padded `YYYY-MM-DD`,
 * the same discipline `isDriverVisible` (`shared/src/portal.ts`) already
 * uses for civil dates. The CHECK still exists for defense in depth; this is
 * the layer a client actually sees.
 */
export const driverLeaveInputSchema = z
  .object({
    driverId: z.number().int().positive(),
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    reason: z.string().trim().max(300).nullable(),
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });
export type DriverLeaveInput = z.infer<typeof driverLeaveInputSchema>;

/**
 * `admin.calendar.month({ year, month })` (Week 5 plan, Task 8; BUILD_SPEC
 * §5C / §9 "Calendar").
 *
 * Bounded on both fields rather than left as a bare `z.number().int()`:
 * `month` outside 1..12 cannot name a month at all, and `year` is bounded to
 * a sane operating window (2020..2100) so a typo'd four-digit year cannot
 * send the resolver off building a million-day range. There is no
 * `.strict()` object nesting to guard here — both fields are required and
 * there is nothing else to smuggle through.
 */
export const calendarMonthSchema = z
  .object({
    year: z.number().int().min(2020).max(2100),
    month: z.number().int().min(1).max(12),
  })
  .strict();
export type CalendarMonthInput = z.infer<typeof calendarMonthSchema>;

/**
 * One trip on the dispatch calendar (`admin.calendar.month`'s per-day
 * payload).
 *
 * Deliberately NOT `leadEmail` / `leadPhone`: this is the first admin read
 * whose rows are a list of *other people's* bookings rather than one a
 * dispatcher opened deliberately, and RA 10173 says contact details do not
 * belong in a list view. A ref and a tour title are enough to identify the
 * trip; the detail screen (`admin.bookings.detail`) is where contact
 * details live.
 */
export interface CalendarTrip {
  bookingId: number;
  ref: string;
  tourTitle: string;
  pax: number;
  status: BookingStatus;
  vanId: number | null;
  vanPlate: string | null;
  driverId: number | null;
  driverName: string | null;
  /**
   * `status IN ('confirmed', 'assigned') AND (vanId IS NULL OR driverId IS
   * NULL)`, computed once on the server. Both unpaid statuses
   * (`pending_payment`, `pending_verification`) are excluded on purpose —
   * see `awaitingPaymentCheck` below for why `pending_verification` still
   * shows up without lighting this.
   */
  needsAssignment: boolean;
  /**
   * `status === 'pending_verification'` — a receipt is in, nobody has
   * checked it yet (owner-decided 2026-10-14, Q2). The calendar SHOWS these
   * trips, labelled in TEXT ("awaiting payment check"), they never count
   * toward `needsAssignment`, and dispatch may still pre-assign them.
   */
  awaitingPaymentCheck: boolean;
}

/**
 * One day of the dispatch calendar. Every civil day of the requested month
 * gets a `CalendarDay`, including days with no trips at all — the calendar
 * is generated from the month first and trips are bucketed into it, not the
 * other way around, so an empty day still exists to be looked at.
 */
export interface CalendarDay {
  /** Civil date, `YYYY-MM-DD`, Asia/Manila. */
  date: string;
  trips: CalendarTrip[];
  needsAssignmentCount: number;
}

/**
 * `admin.dispatch.assign` (Week 5 plan, Task 10) — the assignment mutation.
 * The first input in this project's history that is allowed to write
 * `bookings.van_id` / `.driver_id`.
 *
 * `reason` is bounded here but **optional** in Zod, deliberately — Zod
 * cannot see the booking's status, so it cannot know whether a reason is
 * owed (that is a function of the row, read under the lock, not of the
 * input). `assignVanAndDriver()` decides, inside the transaction; the
 * refusal is `reason_required`. `.trim().min(3)` still means a
 * whitespace-only reason fails Zod before the service ever runs.
 */
/**
 * Why an assignment was refused (`admin.dispatch.assign`).
 *
 * Declared HERE, not in the server service that produces it (controller
 * ruling, 2026-10-15), so the admin UI can type its copy map as
 * `Record<AssignRefusal, string>` and the compiler refuses a build where a
 * reason has no words. Left server-side, the client would hand-write these
 * six strings and the seventh anyone adds later would fall through to
 * generic copy — a contract the consumer cannot see, which is the shape of
 * this week's most expensive defect.
 *
 * The tRPC code each arrives as is decided by `asTrpcError` in
 * `server/src/routers/admin/dispatch.ts`. Two of them share `CONFLICT` and
 * are NOT interchangeable: `driver_unavailable` covers both "someone just
 * took them" and "they are on leave that day", and telling a dispatcher the
 * first when the second is true sends them hunting for a colleague who did
 * nothing.
 */
export type AssignRefusal =
  | 'booking_not_found'
  | 'booking_not_assignable'
  | 'van_unavailable'
  | 'driver_unavailable'
  | 'van_too_small'
  /** An `in_progress` re-assignment arrived without a reason (owner Q3). */
  | 'reason_required';

export const assignInputSchema = z
  .object({
    bookingId: z.number().int().positive(),
    vanId: z.number().int().positive(),
    driverId: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type AssignInput = z.infer<typeof assignInputSchema>;

/**
 * `admin.dispatch.suggest` (Week 5 plan, Task 11) — auto-suggest. Read-only:
 * it names the booking to suggest for and nothing else, because the
 * resolver computes everything the suggestion needs (date, pax, the free
 * fleet) from that one id.
 */
export const suggestInputSchema = z
  .object({
    bookingId: z.number().int().positive(),
  })
  .strict();
export type SuggestInput = z.infer<typeof suggestInputSchema>;
