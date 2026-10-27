/**
 * The dispatch calendar (Week 5 "Dispatch" plan, Task 9; BUILD_SPEC §5C /
 * §9 "Calendar", client half). Owns the week and month state, the
 * `admin.calendar.month` queries and the selected-day trip list -
 * `MonthGrid` itself takes no query (its own module note explains why) and
 * is handed already-resolved data here.
 *
 * ## A week strip first, the month on request
 *
 * A dispatcher's question is "who drives what in the next few days", so the
 * page opens on the week and keeps the whole month a click away in a
 * disclosure (`MonthGrid`, unchanged, with its keyboard behaviour). The strip
 * needs no new data: a week can straddle two months, so it reads
 * `admin.calendar.month` for the month of its first day and, only when the
 * week crosses into another, for that one too.
 *
 * ## Meaning is never carried by colour alone
 *
 * Every day button states its count in words ("3 trips", "No trips", "2 need
 * a van or driver") and the amber dot is `aria-hidden` decoration beside that
 * text; the full sentence is also the button's accessible name.
 *
 * ## What this page does NOT do
 *
 * `admin.calendar.dayOptions` (the assign-panel dropdown contents) is
 * `assignVanDriver`-gated and belongs to the `AssignPanel`, which this page
 * mounts for the SELECTED trip - the page never calls it. The panel is the
 * same component, with the same behaviour, that the booking detail page
 * mounts; finance can read this calendar (`bookingsView`) but the panel
 * renders nothing for them, and the server refuses them regardless.
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { BOOKING_STATUS_LABELS, manilaParts, type CalendarDay } from '@rg/shared';
import MonthGrid from '@/components/admin/MonthGrid';
import AssignPanel from '@/components/admin/AssignPanel';
import { trpc } from '@/lib/trpc';

const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat('en-PH', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const DAY_HEADING_FORMAT = new Intl.DateTimeFormat('en-PH', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const WEEKDAY_SHORT_FORMAT = new Intl.DateTimeFormat('en-PH', {
  weekday: 'short',
  timeZone: 'UTC',
});
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('en-PH', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function parseCivil(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function toCivil(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = parseCivil(date);
  next.setUTCDate(next.getUTCDate() + days);
  return toCivil(next);
}

/** The Monday on or before `date` - the week starts Monday (§9, Philippine business convention). */
function mondayOf(date: string): string {
  const weekday = parseCivil(date).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function monthOf(date: string): { year: number; month: number } {
  const [year, month] = date.split('-').map(Number) as [number, number];
  return { year, month };
}

function monthLabel(year: number, month: number): string {
  return MONTH_YEAR_FORMAT.format(new Date(Date.UTC(year, month - 1, 1)));
}

function dayHeading(date: string): string {
  return DAY_HEADING_FORMAT.format(parseCivil(date));
}

function prevMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year: number, month: number) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The words on a day button; the dot beside them is decoration. */
function dayCaption(day: CalendarDay | undefined): string {
  const trips = day?.trips.length ?? 0;
  if (trips === 0) return 'No trips';
  const needs = day?.needsAssignmentCount ?? 0;
  if (needs > 0) return `${needs} need a van or driver`;
  return `${trips} ${plural(trips, 'trip', 'trips')}`;
}

const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium';

const SQUARE_BUTTON =
  'border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 focus-visible:ring-brand-gold-500 flex size-11 items-center justify-center rounded-[10px] border bg-white transition-colors focus-visible:outline-none focus-visible:ring-[3px]';

export default function AdminCalendarPage() {
  const today = manilaParts(new Date());
  const todayCivil = toCivil(new Date(Date.UTC(today.year, today.month - 1, today.day)));

  const [weekStart, setWeekStart] = useState(() => mondayOf(todayCivil));
  const [selected, setSelected] = useState<string | null>(todayCivil);
  const [pickedTrip, setPickedTrip] = useState<number | null>(null);
  const [{ year, month }, setPeriod] = useState(() => monthOf(todayCivil));

  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const first = monthOf(weekDates[0] as string);
  const last = monthOf(weekDates[6] as string);
  const crossesMonths = first.month !== last.month;

  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const canAssign = me.data?.role === 'owner' || me.data?.role === 'dispatcher';

  const weekQuery = trpc.admin.calendar.month.useQuery(first, { retry: false });
  const weekTail = trpc.admin.calendar.month.useQuery(last, {
    retry: false,
    enabled: crossesMonths,
  });
  const gridQuery = trpc.admin.calendar.month.useQuery({ year, month }, { retry: false });

  const weekDays = new Map<string, CalendarDay>();
  for (const day of [...(weekQuery.data?.days ?? []), ...(weekTail.data?.days ?? [])]) {
    weekDays.set(day.date, day);
  }
  const weekPending = weekQuery.isPending || (crossesMonths && weekTail.isPending);
  const weekFailed = weekQuery.isError || (crossesMonths && weekTail.isError);

  function goToWeek(start: string) {
    setWeekStart(start);
    setSelected(null);
    setPickedTrip(null);
    setPeriod(monthOf(start));
  }

  /**
   * A keyboard move inside `MonthGrid` (PageUp/PageDown by month, or an
   * Arrow key crossing the edge of the rendered month) can name a date
   * outside `{year, month}` - `MonthGrid` calls back with it anyway (its
   * own module note), and this is where that gets honoured: switch the
   * displayed month so the next query covers it, and bring the week strip
   * to the same day.
   */
  function handleSelect(date: string) {
    const target = monthOf(date);
    if (target.year !== year || target.month !== month) setPeriod(target);
    setWeekStart(mondayOf(date));
    setSelected(date);
    setPickedTrip(null);
  }

  function changeMonth(next: { year: number; month: number }) {
    setPeriod(next);
    setSelected(null);
    setPickedTrip(null);
  }

  const selectedDay = selected ? weekDays.get(selected) : undefined;
  const trips = selectedDay?.trips ?? [];
  const activeTrip =
    trips.find((trip) => trip.bookingId === pickedTrip) ??
    trips.find((trip) => trip.needsAssignment) ??
    trips[0];

  function refetchAll() {
    void weekQuery.refetch();
    if (crossesMonths) void weekTail.refetch();
    void gridQuery.refetch();
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
            Dispatch
          </p>
          <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Who drives what</h1>
          <p className="text-brand-error text-sm">
            What is running this week, and what still needs a van and a driver.{' '}
            <span className="tabular-nums">
              {DAY_MONTH_FORMAT.format(parseCivil(weekDates[0] as string))} –{' '}
              {DAY_MONTH_FORMAT.format(parseCivil(weekDates[6] as string))}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Previous week"
            className={SQUARE_BUTTON}
            onClick={() => goToWeek(addDays(weekStart, -7))}
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next week"
            className={SQUARE_BUTTON}
            onClick={() => goToWeek(addDays(weekStart, 7))}
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {weekPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading the calendar…
        </p>
      ) : weekFailed ? (
        <p role="alert" className={ALERT}>
          We could not load the calendar. Sign in again, or try once more in a moment.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <ul className="grid min-w-[700px] grid-cols-7 gap-2.5" aria-label="This week">
            {weekDates.map((date) => {
              const day = weekDays.get(date);
              const isSelected = date === selected;
              const needs = day?.needsAssignmentCount ?? 0;
              const tripCount = day?.trips.length ?? 0;
              return (
                <li key={date}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${dayHeading(date)}: ${
                      tripCount === 0
                        ? 'no trips'
                        : `${tripCount} ${plural(tripCount, 'trip', 'trips')}${
                            needs > 0 ? `, ${needs} need a van or driver` : ''
                          }`
                    }`}
                    onClick={() => {
                      setSelected(date);
                      setPickedTrip(null);
                      setPeriod(monthOf(date));
                    }}
                    className={[
                      'focus-visible:ring-brand-gold-500 text-brand-ink flex min-h-[88px] w-full flex-col items-start gap-1.5 rounded-xl p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px]',
                      isSelected
                        ? 'border-brand-blue-700 bg-brand-blue-100 border-2'
                        : 'border-brand-blue-100 hover:border-brand-blue-300 border bg-white',
                    ].join(' ')}
                  >
                    <span aria-hidden="true" className="text-brand-error text-xs">
                      {WEEKDAY_SHORT_FORMAT.format(parseCivil(date))}
                    </span>
                    <span aria-hidden="true" className="text-xl font-bold tabular-nums">
                      {Number(date.slice(8))}
                    </span>
                    <span
                      aria-hidden="true"
                      className={[
                        'flex items-center gap-1.5 text-xs',
                        needs > 0 ? 'text-brand-gold-800 font-semibold' : 'text-brand-error',
                      ].join(' ')}
                    >
                      {needs > 0 ? (
                        <span className="bg-brand-gold-500 size-2 shrink-0 rounded-full" />
                      ) : null}
                      {dayCaption(day)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selected && !weekPending && !weekFailed ? (
        <div className="flex flex-wrap items-start gap-6">
          <section
            aria-labelledby="calendar-day-heading"
            className="flex min-w-0 flex-[2_1_480px] flex-col gap-3"
          >
            <h2 id="calendar-day-heading" className="text-brand-ink text-lg font-bold">
              {dayHeading(selected)}
            </h2>

            {trips.length === 0 ? (
              <p className="text-brand-error text-sm">No trips scheduled this day.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {trips.map((trip) => {
                  const active = trip.bookingId === activeTrip?.bookingId;
                  return (
                    <li key={trip.bookingId} data-testid="calendar-trip">
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => setPickedTrip(trip.bookingId)}
                        className={[
                          'focus-visible:ring-brand-gold-500 flex w-full flex-wrap items-center justify-between gap-3 rounded-[14px] bg-white p-[18px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px]',
                          active
                            ? 'border-brand-blue-700 border-2'
                            : 'border-brand-blue-100 hover:border-brand-blue-300 border',
                        ].join(' ')}
                      >
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="text-brand-ink text-base font-bold">
                            {trip.tourTitle}
                          </span>
                          <span className="text-brand-error text-sm">
                            <span className="font-mono">{trip.ref}</span> · {trip.pax}{' '}
                            {trip.pax === 1 ? 'guest' : 'guests'} ·{' '}
                            {BOOKING_STATUS_LABELS[trip.status]}
                            {trip.awaitingPaymentCheck ? ' · awaiting payment check' : ''}
                            {trip.needsAssignment
                              ? ''
                              : ` · ${trip.vanPlate ?? 'No van'} · ${trip.driverName ?? 'No driver'}`}
                          </span>
                        </span>
                        {trip.needsAssignment ? (
                          <span className="text-brand-gold-800 bg-brand-gold-50 rounded-full border border-amber-200 px-2.5 py-1 text-xs font-semibold">
                            Needs assignment
                          </span>
                        ) : (
                          <span className="bg-brand-blue-100 text-brand-blue-800 rounded-full px-2.5 py-1 text-xs font-semibold">
                            Assigned
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/*
           * The assign panel for the SELECTED trip - the same component, with
           * the same behaviour, the booking detail page mounts (§9 lists
           * "Assign van + driver" in both places and two copies would drift).
           * Keyed on the booking so choosing another trip starts it fresh.
           * Rendering it only for owner and dispatcher keeps finance from
           * seeing an empty column; the panel and the server gate it too.
           */}
          {activeTrip && canAssign ? (
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2">
              <p className="text-brand-error text-sm">
                For <span className="font-mono">{activeTrip.ref}</span> · {activeTrip.tourTitle}
              </p>
              <AssignPanel
                key={activeTrip.bookingId}
                bookingId={activeTrip.bookingId}
                pax={activeTrip.pax}
                status={activeTrip.status}
                currentVanId={activeTrip.vanId}
                currentDriverId={activeTrip.driverId}
                onAssigned={refetchAll}
                className="mt-0"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="border-brand-blue-100 rounded-[14px] border bg-white">
        <summary className="text-brand-blue-700 tap-target focus-visible:ring-brand-gold-500 flex cursor-pointer items-center px-5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-[3px]">
          Show the whole month
        </summary>
        <div className="border-brand-blue-100 border-t p-5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 focus-visible:ring-brand-gold-500 tap-target rounded-[10px] border bg-white px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-[3px]"
              onClick={() => changeMonth(prevMonth(year, month))}
            >
              Previous month
            </button>
            <p className="text-brand-ink text-sm font-semibold" aria-hidden="true">
              {monthLabel(year, month)}
            </p>
            <button
              type="button"
              className="border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 focus-visible:ring-brand-gold-500 tap-target rounded-[10px] border bg-white px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-[3px]"
              onClick={() => changeMonth(nextMonth(year, month))}
            >
              Next month
            </button>
          </div>

          <div className="mt-4">
            {gridQuery.isPending ? (
              <p className="text-brand-error flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading the calendar…
              </p>
            ) : gridQuery.isError ? (
              <p role="alert" className={ALERT}>
                We could not load the calendar. Sign in again, or try once more in a moment.
              </p>
            ) : (
              <MonthGrid
                days={gridQuery.data?.days ?? []}
                selected={selected}
                onSelect={handleSelect}
              />
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
