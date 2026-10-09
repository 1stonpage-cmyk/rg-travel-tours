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
