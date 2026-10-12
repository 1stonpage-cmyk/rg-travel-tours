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
 */
function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return [
    moved.getUTCFullYear(),
    String(moved.getUTCMonth() + 1).padStart(2, '0'),
    String(moved.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * **The one definition of "which dates may a guest book".** The date picker,
 * the quote and `createHold()` all answer that question from this function,
 * so the UI cannot offer a date the server will refuse.
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
