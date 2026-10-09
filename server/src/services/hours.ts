/**
 * Open/closed state for the `business_hours` settings block, resolved in
 * Asia/Manila. Message copy is customer-facing text from spec task 6E —
 * match it exactly, including the em dash and the straight apostrophe in
 * "we'll".
 */
import { manilaParts } from '@rg/shared';

export interface BusinessHourEntry {
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  /** `HH:MM`, 24-hour, or null when `isClosed`. */
  opensAt: string | null;
  /** `HH:MM`, 24-hour, or null when `isClosed`. */
  closesAt: string | null;
  isClosed: boolean;
}

export type BusinessHours = BusinessHourEntry[];

export interface OpenState {
  isOpen: boolean;
  message: string;
}

const OPEN_MESSAGE = 'Open now — we reply within minutes';

function closedMessage(opensAt: string): string {
  return `Closed — we'll reply by ${formatClockTime12(opensAt)}`;
}

function parseClockTime(hhmm: string): { hours: number; minutes: number } {
  const [hoursPart, minutesPart] = hhmm.split(':');
  return { hours: Number(hoursPart), minutes: Number(minutesPart) };
}

function toMinutes(hhmm: string): number {
  const { hours, minutes } = parseClockTime(hhmm);
  return hours * 60 + minutes;
}

/** `'07:00'` -> `'7:00 AM'`. `'00:00'` -> `'12:00 AM'`. `'13:30'` -> `'1:30 PM'`. */
function formatClockTime12(hhmm: string): string {
  const { hours, minutes } = parseClockTime(hhmm);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
}

function entryFor(hours: BusinessHours, weekday: number): BusinessHourEntry | undefined {
  return hours.find((entry) => entry.weekday === weekday);
}

/**
 * The opening time of the next day (starting today) that is not closed.
 * Walks at most 7 days forward; throws if every day is closed, which the
 * `business_hours` schema's 7-entries-one-per-weekday shape should never
 * actually produce in practice.
 */
function nextOpeningTime(hours: BusinessHours, fromWeekday: number, nowMinutes: number): string {
  const today = entryFor(hours, fromWeekday);
  if (today && !today.isClosed && today.opensAt && nowMinutes < toMinutes(today.opensAt)) {
    return today.opensAt;
  }

  for (let offset = 1; offset <= 7; offset++) {
    const day = entryFor(hours, (fromWeekday + offset) % 7);
    if (day && !day.isClosed && day.opensAt) {
      return day.opensAt;
    }
  }

  throw new Error('No opening hours configured for any day of the week.');
}

export function resolveOpenState(hours: BusinessHours, now: Date): OpenState {
  const { weekday, hour, minute } = manilaParts(now);
  const nowMinutes = hour * 60 + minute;

  const today = entryFor(hours, weekday);
  if (today && !today.isClosed && today.opensAt && today.closesAt) {
    const opensMinutes = toMinutes(today.opensAt);
    const closesMinutes = toMinutes(today.closesAt);
    if (nowMinutes >= opensMinutes && nowMinutes <= closesMinutes) {
      return { isOpen: true, message: OPEN_MESSAGE };
    }
  }

  return { isOpen: false, message: closedMessage(nextOpeningTime(hours, weekday, nowMinutes)) };
}
