/**
 * Asia/Manila time helpers.
 *
 * The Philippines is UTC+8 and does not currently observe DST — but that is
 * a fact about the current calendar, not something this code should assume.
 * Every helper here goes through `Intl.DateTimeFormat` with an explicit
 * `timeZone`, never hand-rolled offset arithmetic, so it keeps working if
 * that ever changes.
 */

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export interface ManilaParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0-59 */
  second: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
}

const manilaFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'long',
  hour12: false,
});

/** The Manila-local calendar date, clock time, and weekday for `date`. */
export function manilaParts(date: Date): ManilaParts {
  const parts = manilaFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Intl.DateTimeFormat did not produce a "${type}" part`);
    }
    return value;
  };

  const weekday = WEEKDAY_NAMES.indexOf(get('weekday') as (typeof WEEKDAY_NAMES)[number]);
  if (weekday === -1) {
    throw new Error(`Unrecognized Manila weekday name: "${get('weekday')}"`);
  }

  // Some ICU builds render midnight as hour "24" under hour12: false.
  // Normalize to 0 so callers never have to special-case it.
  const rawHour = Number(get('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday,
  };
}

/** `HH:MM`, 24-hour, zero-padded Manila clock time for `date`. */
export function manilaTimeHHMM(date: Date): string {
  const { hour, minute } = manilaParts(date);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` — the Manila CALENDAR day for `now`, never the UTC one. */
export function manilaCivilDate(now: Date): string {
  const { year, month, day } = manilaParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A `date()` column's value back to the `YYYY-MM-DD` string every caller
 * uses, passing `null` through.
 *
 * Extracted on its THIRD consumer (controller, 2026-10-14). The same three
 * lines were written privately in `routers/admin/vans.ts` and
 * `routers/admin/drivers.ts`, and Task 10 needs it again to hand
 * `booking.tourDate` to `vansFreeOn(tx, date: string, …)`. `CLAUDE.md` asks
 * for no duplicate data, and this project already set the precedent by
 * extracting `civilDateSchema` rather than writing a third copy of a regex.
 *
 * Why it is `manilaCivilDate` underneath and not `toISOString().slice(0,10)`:
 * the pool is configured `timezone: 'Z'`, so a `date` column comes back as
 * UTC midnight. Reading the calendar day in Manila (+8) from that instant
 * gives the same day — but the moment anything about that configuration
 * changes, a UTC slice would silently shift dates by one and this will not.
 * A tour date off by a day is a van sent on the wrong morning.
 */
export function civilDateFromDate(value: Date | null): string | null {
  return value === null ? null : manilaCivilDate(value);
}

/**
 * The three `booking` settings the bookable window is computed from
 * (settings, not schema — owner decision 2026-10-13, _proposed by developer,
 * not yet confirmed with R&G_). Shaped here, in @rg/shared, so the server
 * schema that validates them and the window function that consumes them
 * cannot drift.
 */
export interface BookingWindowSettings {
  /** 0 = today is bookable; 1 = tomorrow is the earliest. */
  minLeadDays: number;
  /** `HH:MM`, 24-hour, Asia/Manila. At or after it, the earliest date moves out one more day. */
  nextDayCutoffTime: string;
  /** How far ahead a guest may book, counted in days from the Manila today. */
  maxAdvanceDays: number;
}

/** Civil dates, inclusive at both ends. `YYYY-MM-DD`, never instants. */
export interface BookableDateRange {
  earliest: string;
  latest: string;
}

/**
 * Civil-date arithmetic: `date` plus `days`, as a calendar day.
 *
 * The anchor is deliberately `Date.UTC` — a civil date has no time zone, so
 * doing the arithmetic in UTC means no offset and no DST can move it. The
 * only place a time zone is involved is READING today's Manila date
 * (`manilaCivilDate`, via `Intl` with an explicit `timeZone`), which is the
 * discipline this module opened with. Adding days to a Manila-local `Date`
 * instead is what produces the 23:00/01:00 off-by-one-day bugs.
 *
 * Exported since Week 7 Task 12 (it was private until then, and its behaviour
 * did not change): the money reports turn a civil-date window into a half-open
 * INSTANT range for `payments.created_at`, whose upper bound is "00:00 Manila
 * on the day AFTER `to`". That is this function composed with
 * `manilaInstant()`, and the alternative — adding 86,400,000 ms to the last
 * day's midnight — is exactly the offset arithmetic this module exists to
 * avoid.
 */
export function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return [
    moved.getUTCFullYear(),
    String(moved.getUTCMonth() + 1).padStart(2, '0'),
    String(moved.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * **The one definition of "which dates may a guest book".**
 *
 * Callers today: `createHold()`, which is the authority and checks it inside
 * the locked transaction, and `checkout.availability`, the early friendly
 * answer. The resolved window is also published to the browser as
 * `SettingsPayload.bookingWindow` (see `server/src/content/settings.ts`) so
 * a date picker can bound itself, and **that wiring is live**: the date
 * input of the BOOKING flow — `client/src/components/home/HeroSection.tsx`,
 * the hero search that sends a guest to checkout — feeds
 * `bookingWindow.earliest` / `.latest` straight into the `min` / `max` of
 * its `<input type="date">`, and is `bookingWindow`'s only consumer. Named
 * here because this comment used to say the wiring did not exist, which is
 * how a value with exactly one consumer gets deleted as dead — and deleting
 * it would silently un-bound that picker.
 *
 * (The client's other date input, "preferred dates" on the package ENQUIRY
 * form, is deliberately unbounded: an enquiry is not a booking, and a guest
 * asking about next Christmas may legitimately name a date past
 * `maxAdvanceDays`. This window governs what may be BOOKED.)
 *
 * `checkout.quote` does not enforce the window: a quote for a closed date
 * still returns a price, and the hold refuses it. Said plainly here because
 * the opposite claim invites someone to treat the quote as a gate, or to
 * delete the hold's check as redundant.
 *
 * `now` is a parameter and this never calls `new Date()` itself: the cutoff
 * is a clock comparison, so a test for "17:59 versus 18:00 Manila" has to be
 * able to name the instant — the same discipline `validateCoupon()` follows.
 *
 * The cutoff comparison is a plain string compare, which is safe precisely
 * because both sides are zero-padded 24-hour `HH:MM` (`manilaTimeHHMM()`
 * produces that, and the settings schema's `clockTime` regex refuses
 * anything else): lexicographic order on that shape IS chronological order.
 * At or after the cutoff counts as after — a cutoff a guest can still beat
 * by booking at exactly 18:00:00 is not a cutoff.
 */
export function bookableDateRange(settings: BookingWindowSettings, now: Date): BookableDateRange {
  const today = manilaCivilDate(now);
  const pastCutoff = manilaTimeHHMM(now) >= settings.nextDayCutoffTime;
  return {
    earliest: addCivilDays(today, settings.minLeadDays + (pastCutoff ? 1 : 0)),
    latest: addCivilDays(today, settings.maxAdvanceDays),
  };
}

/**
 * Whether one civil date falls inside the window, inclusive at both ends.
 *
 * String comparison again, and again only because `YYYY-MM-DD` is
 * fixed-width and zero-padded, so lexicographic order is calendar order. It
 * fails CLOSED on a window that cannot contain anything (a `maxAdvanceDays`
 * below the lead): every date is refused rather than every date allowed.
 */
export function isDateBookable(date: string, range: BookableDateRange): boolean {
  return date >= range.earliest && date <= range.latest;
}

/**
 * Asia/Manila's UTC offset, in milliseconds, AT a given instant.
 *
 * Measured through `Intl` rather than hardcoded to +8, for the reason this
 * module opens with: the Philippines does not observe DST today, and that
 * is a fact about the current calendar rather than something to build on.
 */
function manilaOffsetMs(at: Date): number {
  const p = manilaParts(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - at.getTime();
}

/**
 * The INSTANT at which a Manila wall clock reads `civilDate` `hhmm`.
 *
 * The inverse of `manilaParts()`, and the only function here that goes that
 * way. Two passes rather than one: the first guesses the instant using the
 * offset in force at the naive UTC reading, the second re-measures the
 * offset at that guess. On a zone with no DST the two agree and the second
 * pass is free; across a DST boundary, which Manila could one day have
 * again, the second pass is what stops the answer being an hour out.
 */
export function manilaInstant(civilDate: string, hhmm: string): Date {
  const [year, month, day] = civilDate.split('-').map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const firstGuess = new Date(naive - manilaOffsetMs(new Date(naive)));
  return new Date(naive - manilaOffsetMs(firstGuess));
}

/**
 * **The instant a tour date stops being bookable.**
 *
 * The clock-time twin of `bookableDateRange()`, which answers the same
 * question in civil dates: with `minLeadDays = 1` and
 * `nextDayCutoffTime = '18:00'`, tour date `D` is bookable until 18:00
 * Manila on `D - 1`, and from that instant on it is not.
 *
 * It exists because Week 4 Task 7 needs a DEADLINE rather than a date: a
 * guest whose receipt is rejected gets twelve hours to re-upload, "never
 * extending past the booking-window cutoff for that tour date" (owner
 * decision 2026-10-13, Q8 — _proposed by developer, not yet confirmed with
 * R&G_). A receipt rejected at 23:00 the night before a tour must not buy
 * until 11:00 the next morning for a trip that has already left.
 *
 * Derived from the SAME two settings as the civil window, so the two cannot
 * disagree about where the line is. `now` is not a parameter and must not
 * become one: this is a property of the tour date, not of when you ask.
 */
export function bookingCutoffInstant(
  tourDate: string,
  settings: Pick<BookingWindowSettings, 'minLeadDays' | 'nextDayCutoffTime'>,
): Date {
  return manilaInstant(addCivilDays(tourDate, -settings.minLeadDays), settings.nextDayCutoffTime);
}
