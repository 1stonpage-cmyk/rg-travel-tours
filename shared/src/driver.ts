/**
 * Shared driver-portal contracts (Week 6 plan, Task 1 — BUILD_SPEC §8).
 *
 * **In `shared/` and not in `server/`, and that is the whole point of the
 * file** (pre-flight ruling, 2026-10-15). Task 9's login screen builds a
 * compiler-exhaustive `Record<DriverLoginRefusal, string>` copy map, exactly
 * as Week 5's `AssignRefusal` / `REFUSAL_COPY` pair does — so the day a
 * sixth refusal is added, the build fails on the screen that has no words
 * for it rather than falling through to generic copy. The client cannot
 * import from `server/`, so the union has to live here for that to work.
 *
 * `shared/src/dispatch.ts` is the pattern this follows.
 */
import { z } from 'zod';
import type { BookingStatus } from './booking';

/**
 * What the driver types on the portal: their short code and a six-digit PIN.
 *
 * `.strict()` for the same reason the staff and checkout schemas use it — a
 * request carrying a `driverId`, an `isActive` or a `now` is refused at the
 * input stage rather than silently ignored. A login that quietly drops an
 * unexpected field is a login that looks like it might honour one.
 *
 * `.toUpperCase()` on the code because `drivers.code` is stored uppercase
 * (`D07`) and a driver typing `d07` on a phone keyboard — where the first
 * letter is often auto-lowercased — must not be told their code is wrong.
 * The PIN is matched as a STRING, never a number: `z.number()` would accept
 * `1234` for `001234` and drop the leading zeros a PIN is allowed to have.
 */
export const driverLoginSchema = z
  .object({
    code: z.string().trim().min(1).max(20).toUpperCase(),
    pin: z.string().regex(/^[0-9]{6}$/, 'A PIN is six digits'),
  })
  .strict();
export type DriverLoginInput = z.infer<typeof driverLoginSchema>;

/**
 * §8: "Session lasts 12 hours."
 *
 * This is NOT the shared session TTL (owner decision 2026-10-15, Q1). The
 * authority is `SESSION_TTL_MS_BY_SUBJECT` in
 * `server/src/services/sessions.ts`; this constant exists so the client can
 * say "12 hours" in copy without importing from the server, and
 * `driver-auth.test.ts` asserts the two agree.
 */
export const DRIVER_SESSION_HOURS = 12;

/**
 * Every way a driver login can be refused, and nothing else.
 *
 * `wrong_credentials` covers an unknown code AND a wrong PIN, deliberately
 * and indivisibly — the same rule §7's booking lookup follows. Two
 * distinguishable answers would tell an attacker which half of the pair
 * they already have, which on a portal whose codes are short and printed on
 * a van is the only half that is hard to get.
 *
 * `locked` and `needs_admin_unlock` are separate because the driver's next
 * action differs: wait fifteen minutes, or ring the office. Telling someone
 * to wait when only a dispatcher can help them is how a van leaves without
 * its manifest.
 */
export type DriverLoginRefusal =
  'wrong_credentials' | 'locked' | 'needs_admin_unlock' | 'driver_inactive';

/* ------------------------------------------------------------------ *
 * The driver's trip list (Week 6 plan, Task 2 — BUILD_SPEC §8)
 * ------------------------------------------------------------------ */

/** The three tabs the driver portal's trip list is divided into. */
export type DriverTripBucket = 'today' | 'upcoming' | 'history';

/**
 * Which tab a trip belongs in. PURE, and shared, so the tabs and the server
 * cannot disagree about what "today" means.
 *
 * **Both arguments are Manila CIVIL DATES (`YYYY-MM-DD`), and `todayManila`
 * comes from `manilaCivilDate(now)` on the server — never from the device.**
 * The comparison is then a plain string compare, which is exact for
 * zero-padded ISO civil dates and has no instant, zone or DST in it at all.
 *
 * Why that matters rather than being pedantry: Manila is UTC+8 with no DST,
 * so for the whole 00:00-07:59 Manila window the UTC calendar day is still
 * YESTERDAY. A driver opening the portal at 00:30 to check the morning's
 * pickup would be shown it under "Upcoming" and their finished trip under
 * "Today" — the one moment of the day when being wrong costs a departure.
 *
 * The client may re-bucket without a round trip (the server sends `bucket`
 * already resolved), but it must re-bucket against a Manila date it was
 * GIVEN, not one it computed from the handset's clock.
 */
export function driverTripBucket(tourDate: string, todayManila: string): DriverTripBucket {
  if (tourDate === todayManila) return 'today';
  return tourDate > todayManila ? 'upcoming' : 'history';
}

/**
 * One row of `driver.trips()` — everything the list needs and nothing a
 * driver has no business holding.
 *
 * `vanPlate` is nullable because `bookings.van_id` is: a trip can be
 * confirmed before dispatch has assigned a van, and the list must still
 * render rather than hide the trip. The guest's name, phone and e-mail are
 * deliberately NOT here: the list is a list, and the manifest (Task 3) is
 * where a driver is shown contact details for one trip at a time.
 *
 * `bucket` is resolved server-side from the Manila civil date and sent
 * with the row, so the first render needs no client clock.
 */
export interface DriverTripRow {
  bookingId: number;
  ref: string;
  tourTitle: string;
  /** Manila civil date, `YYYY-MM-DD`. */
  tourDate: string;
  pax: number;
  status: BookingStatus;
  vanPlate: string | null;
  bucket: DriverTripBucket;
}
