/**
 * The dispatch month grid (Week 5 "Dispatch" plan, Task 9; BUILD_SPEC §5C /
 * §9 "Calendar", client half — the grid only).
 *
 * Presentational and query-free on purpose (the brief's own interface note):
 * `AdminCalendarPage` owns the month state, the `admin.calendar.month` query
 * and the selected-day trip list underneath. This component just renders
 * one month of `CalendarDay[]` as an accessible `<table role="grid">` and
 * reports a date back through `onSelect` — it never calls `trpc` itself, so
 * it is testable with no Provider (see the test file's module note on why
 * that is deliberate, not an oversight).
 *
 * ## §9's "gold dot" is not allowed to be the only signal
 *
 * A dot of colour alone is the WCAG 1.4.1 "don't convey information by
 * colour alone" failure (`ui-ux-pro-max` Accessibility guidance, severity
 * High — ran via `search.py "status dot color alone meaning"`), and it is
 * unreadable to a dispatcher squinting at a phone in sunlight. So every day
 * cell carries an explicit `aria-label` built entirely from text (never from
 * the dot) — `buildCellName()` below — and, for sighted users, the same
 * count that the dot represents is ALSO rendered as a literal visible
 * numeral beside it, not folded only into an attribute nobody not running a
 * screen reader will ever see. A day with trips but nothing needing
 * assignment renders neither the dot nor the numeral: absence is the
 * signal, and absence needs no colour (§9's `needsAssignmentCount === 0`
 * case).
 *
 * The dot is `brand-gold-600` (CLAUDE.md permits that shade for a
 * non-text decorative element); the numeral next to it is `brand-gold-800`,
 * which the house `contrast.test.ts` guard holds to AA for normal-size text
 * — `brand-gold-600` itself fails AA for text at this size.
 *
 * ## Roving tabindex, not 30+ tab stops
 *
 * One cell carries `tabIndex={0}` at a time (the selected day, or the
 * month's first day while nothing is selected yet) and every other cell
 * carries `tabIndex={-1}` — the roving-tabindex pattern the `ui-ux-pro-max`
 * keyboard-navigation guidance names (severity High: "keep tab order
 * aligned with visual order", and the skip-link guidance's "100 tabs to
 * reach content" anti-pattern is the same shape in miniature: crossing a
 * month should not cost 30+ Tab presses). Arrow keys move by day,
 * PageUp/PageDown by month, Home/End to the ends of the ISO week (Monday
 * first — Philippine business convention). Moving past the edge of the
 * rendered month (PageUp/PageDown, or an Arrow at month's end) still calls
 * `onSelect` with the computed date even though no cell for it exists in
 * THIS render — `AdminCalendarPage` is expected to respond by querying the
 * new month, which re-renders this component with that date inside `days`.
 *
 * ## Leading/trailing padding cells are never clickable, never read text
 *
 * "An `aria-hidden` untabbable cell still showing '31' is a cell a
 * dispatcher will try to click" (brief) — so padding cells
 * (`data-testid="pad-cell"`) render with no `tabIndex` attribute at all, no
 * `onClick`, and no text content. They exist purely to keep the 7-column
 * grid rectangular.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { CalendarDay } from '@rg/shared';

export interface MonthGridProps {
  days: CalendarDay[];
  selected: string | null;
  onSelect: (date: string) => void;
}

/** Monday first — Philippine business convention (§9). */
const WEEKDAYS = [
  { abbr: 'Mon', full: 'Monday' },
  { abbr: 'Tue', full: 'Tuesday' },
  { abbr: 'Wed', full: 'Wednesday' },
  { abbr: 'Thu', full: 'Thursday' },
  { abbr: 'Fri', full: 'Friday' },
  { abbr: 'Sat', full: 'Saturday' },
  { abbr: 'Sun', full: 'Sunday' },
] as const;

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat('en-PH', { month: 'long', timeZone: 'UTC' });

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` -> `[year, month(1-12), day]`. No timezone involved: these are civil dates. */
function parseCivilDate(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** A UTC instant back to `YYYY-MM-DD`. The anchor is always `Date.UTC`, so no offset can shift it. */
function isoFromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 0 = Monday .. 6 = Sunday, for the civil date `date`. */
function mondayIndex(date: string): number {
  const [y, m, d] = parseCivilDate(date);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return (utcDay + 6) % 7;
}

function addDays(date: string, delta: number): string {
  const [y, m, d] = parseCivilDate(date);
  return isoFromUtcMs(Date.UTC(y, m - 1, d) + delta * 86_400_000);
}

/** Same day-of-month, `delta` calendar months over — `Date.UTC` normalizes overflow. */
function addMonths(date: string, delta: number): string {
  const [y, m, d] = parseCivilDate(date);
  return isoFromUtcMs(Date.UTC(y, m - 1 + delta, d));
}

function startOfWeek(date: string): string {
  return addDays(date, -mondayIndex(date));
}

function endOfWeek(date: string): string {
  return addDays(date, 6 - mondayIndex(date));
}

/**
 * The cell's accessible name, built ENTIRELY from text — never from colour,
 * and never from the dot. `3 trips` / `1 trip` singularizes; a day with no
 * trips says so in words rather than "0 trips". The needs-assignment clause
 * only appears when there is something to report (§9: absence is silent).
 */
function buildCellName(
  day: number,
  monthLabel: string,
  tripCount: number,
  needsCount: number,
): string {
  const base =
    tripCount === 0
      ? `${day} ${monthLabel}, no trips`
      : `${day} ${monthLabel}, ${tripCount} ${tripCount === 1 ? 'trip' : 'trips'}`;
  return needsCount > 0 ? `${base}, ${needsCount} need assignment` : base;
}

type Cell = { kind: 'pad'; key: string } | { kind: 'day'; day: CalendarDay };

/** `days` padded at both ends to whole Monday-first weeks, then chunked into rows of 7. */
function buildRows(days: CalendarDay[]): Cell[][] {
  if (days.length === 0) return [];
  const leading = mondayIndex(days[0]!.date);
  const cells: Cell[] = [
    ...Array.from({ length: leading }, (_, i) => ({ kind: 'pad' as const, key: `lead-${i}` })),
    ...days.map((day) => ({ kind: 'day' as const, day })),
  ];
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < trailing; i += 1) {
    cells.push({ kind: 'pad', key: `trail-${i}` });
  }
  const rows: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }
  return rows;
}

export default function MonthGrid({ days, selected, onSelect }: MonthGridProps) {
  const containerRef = useRef<HTMLTableElement>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const isFirstRender = useRef(true);

  // The one tab stop in the grid: the selected day, or — while nothing is
  // selected yet — the month's first day, so the grid always has exactly
  // one focusable cell rather than none.
  const tabStopDate = selected ?? days[0]?.date ?? null;

  const [firstYear, firstMonth] = days[0] ? parseCivilDate(days[0].date) : [0, 0, 0];
  const monthLabel =
    days.length > 0
      ? MONTH_LABEL_FORMAT.format(new Date(Date.UTC(firstYear, firstMonth - 1, 1)))
      : '';

  /**
   * Keyboard-driven selection moves DOM focus to the newly selected cell,
   * but never on mount — a page load must not steal focus into the grid,
   * only a key press already inside it should move focus within it. Moving
   * past the rendered month (PageUp/PageDown) lands on a date with no cell
   * here yet; the `?.focus()` is then a no-op until `AdminCalendarPage`
   * re-queries and re-renders with that date included.
   */
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!selected) return;
    if (!containerRef.current?.contains(document.activeElement)) return;
    cellRefs.current.get(selected)?.focus();
  }, [selected]);

  function handleKeyDown(event: KeyboardEvent<HTMLTableCellElement>, date: string) {
    let next: string | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = addDays(date, 1);
        break;
      case 'ArrowLeft':
        next = addDays(date, -1);
        break;
      case 'ArrowDown':
        next = addDays(date, 7);
        break;
      case 'ArrowUp':
        next = addDays(date, -7);
        break;
      case 'PageDown':
        next = addMonths(date, 1);
        break;
      case 'PageUp':
        next = addMonths(date, -1);
        break;
      case 'Home':
        next = startOfWeek(date);
        break;
      case 'End':
        next = endOfWeek(date);
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(next);
  }

  const rows = buildRows(days);

  return (
    <table ref={containerRef} role="grid" className="w-full table-fixed border-collapse text-sm">
      <caption className="text-brand-blue-900 pb-3 text-left text-base font-semibold">
        {monthLabel} {firstYear || ''}
      </caption>
      <thead>
        <tr role="row">
          {WEEKDAYS.map((weekday) => (
            <th
              key={weekday.full}
              scope="col"
              className="text-brand-error pb-2 text-xs font-medium"
            >
              <abbr title={weekday.full} className="no-underline">
                {weekday.abbr}
              </abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr role="row" key={rowIndex}>
            {row.map((cell) => {
              if (cell.kind === 'pad') {
                return (
                  <td
                    key={cell.key}
                    data-testid="pad-cell"
                    aria-hidden="true"
                    className="border-border/40 border p-1"
                  />
                );
              }

              const { day } = cell;
              const [, , dayNum] = parseCivilDate(day.date);
              const needsCount = day.needsAssignmentCount;
              const tripCount = day.trips.length;
              const isTabStop = day.date === tabStopDate;
              const isSelected = day.date === selected;
              const name = buildCellName(dayNum, monthLabel, tripCount, needsCount);

              return (
                <td
                  key={day.date}
                  ref={(el) => {
                    if (el) cellRefs.current.set(day.date, el);
                    else cellRefs.current.delete(day.date);
                  }}
                  role="gridcell"
                  aria-label={name}
                  /*
                   * `aria-selected` tracks the USER'S selection, not the
                   * roving tab stop (Task 9 review).
                   *
                   * They coincide once a day is selected, which is why this
                   * looked right — but before any selection the grid still
                   * needs somewhere for the tab stop to live (day 1), and
                   * announcing that day as "selected" tells a screen-reader
                   * user they picked a day they never picked. `isTabStop`
                   * drives `tabIndex` alone; selection drives this.
                   */
                  aria-selected={isSelected ? 'true' : 'false'}
                  tabIndex={isTabStop ? 0 : -1}
                  data-date={day.date}
                  onClick={() => onSelect(day.date)}
                  onKeyDown={(event) => handleKeyDown(event, day.date)}
                  className={[
                    'tap-target border-border/40 cursor-pointer border p-1 text-center align-top transition-colors',
                    'focus-visible:ring-brand-blue-600 focus-visible:outline-none focus-visible:ring-2',
                    isSelected ? 'bg-brand-blue-50' : 'hover:bg-brand-blue-50/60',
                  ].join(' ')}
                >
                  <div className="flex flex-col items-center gap-0.5 py-1">
                    <span
                      aria-hidden="true"
                      className="text-brand-ink text-sm font-medium tabular-nums"
                    >
                      {dayNum}
                    </span>
                    {tripCount > 0 ? (
                      <span
                        aria-hidden="true"
                        className="text-brand-error text-[11px] tabular-nums"
                      >
                        {' '}
                        {tripCount}
                      </span>
                    ) : null}
                    {needsCount > 0 ? (
                      <span aria-hidden="true" className="flex items-center gap-1">
                        {' '}
                        <span
                          data-testid="needs-assignment-dot"
                          className="bg-brand-gold-600 inline-block size-1.5 rounded-full"
                        />
                        {/* `brand-gold-800`, not `-600`: CLAUDE.md records that
                            `brand-gold-600` measures below AA for normal-size
                            text. The DOT may be gold-600 — it is decorative and
                            carries no information on its own — but this numeral
                            IS the information, so it has to be readable.

                            Its own testid, so the "no dot" test can assert the
                            numeral is absent too. They are rendered by one
                            conditional today; a test that only checks the dot
                            would not notice if that ever stopped being true. */}
                        <span
                          data-testid="needs-assignment-count"
                          className="text-brand-gold-800 text-[11px] font-semibold tabular-nums"
                        >
                          {needsCount}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
