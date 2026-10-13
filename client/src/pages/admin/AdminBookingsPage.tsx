/**
 * The admin bookings list (BUILD_SPEC §9's 4D screen, Week 4 Task 11).
 *
 * A diary rather than a log: soonest tour first, with the three filters an
 * operations day actually needs — status, a date range, and "waiting on
 * us". Every one of those is a server-side filter, because filtering a
 * page of twenty-five rows in the browser answers the wrong question.
 *
 * ## Cards on a phone, a table on a laptop
 *
 * A six-column table at 360px either scrolls sideways or truncates, and
 * the responsive guidance is explicit that a horizontal scrollbar on
 * mobile is the thing to avoid. So the same rows render as cards below
 * `md` and as a table above it — one data source, two shapes, no
 * duplicated logic.
 *
 * ## It shows no money decisions
 *
 * The list links to the detail screen and does nothing else. Approving or
 * rejecting a receipt is `verifyPayments` and lives there, which is also
 * why a dispatcher can open this page: §9 gives all three roles the view.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { BOOKING_STATUSES, formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

const PAGE_SIZE = 25;

/** The statuses, in the order §5 lists them, with readable labels. */
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

export default function AdminBookingsPage() {
  const [status, setStatus] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [offset, setOffset] = useState(0);

  const query = trpc.admin.bookings.list.useQuery(
    {
      ...(status ? { status: status as (typeof BOOKING_STATUSES)[number] } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(awaiting ? { awaitingVerification: true } : {}),
      limit: PAGE_SIZE,
      offset,
    },
    { retry: false },
  );

  /** Any filter change starts at the first page again. */
  function change(apply: () => void) {
    apply();
    setOffset(0);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold">Bookings</h1>

      <form
        aria-label="Filter bookings"
        className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="space-y-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <select
            id="filter-status"
            value={status}
            onChange={(event) => change(() => setStatus(event.target.value))}
            className="border-input bg-background tap-target w-full rounded-md border px-3 text-sm"
          >
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value] ?? value}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-from">Tour date from</Label>
          <Input
            id="filter-from"
            type="date"
            value={from}
            onChange={(event) => change(() => setFrom(event.target.value))}
            className="tap-target"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-to">Tour date to</Label>
          <Input
            id="filter-to"
            type="date"
            value={to}
            onChange={(event) => change(() => setTo(event.target.value))}
            className="tap-target"
          />
        </div>

        <div className="flex items-end">
          <label className="tap-target flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={awaiting}
              onChange={(event) => change(() => setAwaiting(event.target.checked))}
              className="size-4"
            />
            Waiting for verification
          </label>
        </div>
      </form>

      {query.isPending ? (
        <p className="text-muted-foreground mt-8 flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading bookings…
        </p>
      ) : query.isError || !query.data ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-8 rounded-lg border p-3 text-sm font-medium"
        >
          We could not load the bookings. Sign in again, or try once more in a moment.
        </p>
      ) : query.data.items.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">No bookings match those filters.</p>
      ) : (
        <>
          {/* Phone: one card per booking. */}
          <ul className="mt-6 space-y-3 md:hidden">
            {query.data.items.map((booking) => (
              <li
                key={booking.ref}
                className="border-border bg-background rounded-xl border p-4 text-sm"
              >
                <Link
                  to={`/admin/bookings/${booking.ref}`}
                  className="text-brand-blue-900 font-mono font-semibold underline"
                >
                  {booking.ref}
                </Link>
                <p className="text-brand-blue-900 mt-1 font-medium">{booking.tourTitle}</p>
                <p className="text-muted-foreground">
                  {booking.tourDate} · {booking.pax} pax · {booking.leadName}
                </p>
                <p className="mt-2 flex justify-between">
                  <span className="text-brand-blue-900 font-semibold">
                    {STATUS_LABELS[booking.status] ?? booking.status}
                  </span>
                  <span className="tabular-nums">
                    {formatPeso(booking.paidCentavos)} / {formatPeso(booking.totalCentavos)}
                  </span>
                </p>
              </li>
            ))}
          </ul>

          {/* Laptop: the table. */}
          <table className="mt-6 hidden w-full text-left text-sm md:table">
            <thead className="text-muted-foreground border-b">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Reference
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Tour
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Guest
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Paid / total
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((booking) => (
                <tr key={booking.ref} className="border-b last:border-0">
                  <td className="py-3 pr-3">
                    <Link
                      to={`/admin/bookings/${booking.ref}`}
                      className="text-brand-blue-700 hover:text-brand-blue-900 font-mono font-semibold underline transition-colors"
                    >
                      {booking.ref}
                    </Link>
                  </td>
                  <td className="text-brand-blue-900 py-3 pr-3">{booking.tourTitle}</td>
                  <td className="py-3 pr-3 tabular-nums">{booking.tourDate}</td>
                  <td className="py-3 pr-3">{booking.leadName}</td>
                  <td className="py-3 pr-3">{STATUS_LABELS[booking.status] ?? booking.status}</td>
                  <td className="py-3 text-right tabular-nums">
                    {formatPeso(booking.paidCentavos)} / {formatPeso(booking.totalCentavos)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-6 flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm" role="status">
              Showing {query.data.offset + 1}–{query.data.offset + query.data.items.length} of{' '}
              {query.data.total}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="tap-target"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                className="tap-target"
                disabled={query.data.offset + query.data.items.length >= query.data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
