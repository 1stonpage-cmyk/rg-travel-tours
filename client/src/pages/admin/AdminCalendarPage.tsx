/**
 * The dispatch calendar (Week 5 "Dispatch" plan, Task 9; BUILD_SPEC §5C /
 * §9 "Calendar", client half). Owns the month state, the
 * `admin.calendar.month` query and the selected-day trip list —
 * `MonthGrid` itself takes no query (its own module note explains why) and
 * is handed already-resolved data here.
 *
 * ## Progressive disclosure, not a cell crammed with trips
 *
 * At 360px seven columns leave about 45px each — nowhere near enough to
 * list trips inside a cell. So the grid shows only a date, a trip count and
 * the needs-assignment marker; picking a day renders that day's trips in a
 * list BELOW the grid, never inside it.
 *
 * ## What this page does NOT do
 *
 * `admin.calendar.dayOptions` (the assign-panel dropdown contents) is
 * `assignVanDriver`-gated and belongs to Task 12, which mounts its panel
 * into the trip list below — this page never calls it. Every list item
 * here already carries what that panel will need: `bookingId`, `pax` and
 * `status` (plus `ref`, `tourTitle`, and the current van/driver, so a
 * re-assign panel can show what a trip already holds).
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { manilaParts } from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import MonthGrid from '@/components/admin/MonthGrid';
import AssignPanel from '@/components/admin/AssignPanel';
import { trpc } from '@/lib/trpc';

/** Mirrors `AdminBookingsPage`'s own small label map — a dictionary this short isn't worth sharing. */
const STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  pending_verification: 'Checking receipt',
  confirmed: 'Confirmed',
  assigned: 'Driver assigned',
  in_progress: 'On tour',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

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

function monthLabel(year: number, month: number): string {
  return MONTH_YEAR_FORMAT.format(new Date(Date.UTC(year, month - 1, 1)));
}

function dayHeading(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return DAY_HEADING_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
}

function prevMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year: number, month: number) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export default function AdminCalendarPage() {
  const today = manilaParts(new Date());
  const [{ year, month }, setPeriod] = useState({ year: today.year, month: today.month });
  const [selected, setSelected] = useState<string | null>(null);

  const query = trpc.admin.calendar.month.useQuery({ year, month }, { retry: false });

  /**
   * A keyboard move inside `MonthGrid` (PageUp/PageDown by month, or an
   * Arrow key crossing the edge of the rendered month) can name a date
   * outside `{year, month}` — `MonthGrid` calls back with it anyway (its
   * own module note), and this is where that gets honoured: switch the
   * displayed month so the next query covers it.
   */
  function handleSelect(date: string) {
    const [y, m] = date.split('-').map(Number) as [number, number];
    if (y !== year || m !== month) {
      setPeriod({ year: y, month: m });
    }
    setSelected(date);
  }

  function changeMonth(next: { year: number; month: number }) {
    setPeriod(next);
    setSelected(null);
  }

  const days = query.data?.days ?? [];
  const selectedDay = selected ? days.find((d) => d.date === selected) : undefined;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold">Calendar</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        What is running this month, and what still needs a van and a driver.
      </p>

      <div className="mt-6 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          className="tap-target"
          onClick={() => changeMonth(prevMonth(year, month))}
        >
          Previous month
        </Button>
        <p className="text-brand-blue-900 text-sm font-semibold" aria-hidden="true">
          {monthLabel(year, month)}
        </p>
        <Button
          type="button"
          variant="outline"
          className="tap-target"
          onClick={() => changeMonth(nextMonth(year, month))}
        >
          Next month
        </Button>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading the calendar…
          </p>
        ) : query.isError ? (
          <p
            role="alert"
            className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
          >
            We could not load the calendar. Sign in again, or try once more in a moment.
          </p>
        ) : (
          <MonthGrid days={days} selected={selected} onSelect={handleSelect} />
        )}
      </div>

      {selected ? (
        <section aria-labelledby="calendar-day-heading" className="mt-8">
          <h2 id="calendar-day-heading" className="text-brand-blue-900 text-lg font-semibold">
            {dayHeading(selected)}
          </h2>

          {!selectedDay || selectedDay.trips.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">No trips scheduled this day.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {selectedDay.trips.map((trip) => (
                <li
                  key={trip.bookingId}
                  data-testid="calendar-trip"
                  className="border-border bg-background rounded-xl border p-4 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-brand-blue-900 font-mono font-semibold">{trip.ref}</span>
                    <span className="text-muted-foreground tabular-nums">{trip.pax} pax</span>
                  </div>
                  <p className="text-brand-blue-900 mt-1 font-medium">{trip.tourTitle}</p>
                  <p className="text-muted-foreground mt-1">
                    {STATUS_LABELS[trip.status] ?? trip.status}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {trip.awaitingPaymentCheck ? (
                      <Badge className="bg-muted text-foreground border-0">
                        Awaiting payment check
                      </Badge>
                    ) : null}
                    {trip.needsAssignment ? (
                      <Badge className="bg-brand-gold-100 text-brand-gold-800 border-0">
                        Needs assignment
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        {trip.vanPlate ?? 'No van'} · {trip.driverName ?? 'No driver'}
                      </span>
                    )}
                  </div>

                  {/*
                   * Task 12: the assign panel, mounted per trip. The SAME
                   * component also mounts on the booking detail page, because
                   * §9 lists "Assign van + driver" in both places and two
                   * copies would drift.
                   *
                   * It renders nothing for finance and issues no `dayOptions`
                   * query for them — finance can read this calendar
                   * (`bookingsView`) but cannot assign (`assignVanDriver`),
                   * so showing the panel would hand them a FORBIDDEN for an
                   * action never offered.
                   */}
                  <AssignPanel
                    bookingId={trip.bookingId}
                    pax={trip.pax}
                    status={trip.status}
                    currentVanId={trip.vanId}
                    currentDriverId={trip.driverId}
                    onAssigned={() => void query.refetch()}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  );
}
