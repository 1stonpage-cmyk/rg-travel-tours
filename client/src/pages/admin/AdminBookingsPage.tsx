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
import { BOOKING_STATUS_LABELS, BOOKING_STATUSES, formatPeso } from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import BookingStatusPill from '@/components/admin/BookingStatusPill';

const PAGE_SIZE = 25;

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';
const OUTLINE_BUTTON =
  'tap-target border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 hover:text-brand-blue-800 rounded-[10px] font-semibold transition-colors';

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
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Operations
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Bookings</h1>
        <p className="text-brand-error text-sm">Soonest tour first. Open a booking to act on it.</p>
      </header>

      <form
        aria-label="Filter bookings"
        className={`${CARD} grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4`}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="space-y-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <select
            id="filter-status"
            value={status}
            onChange={(event) => change(() => setStatus(event.target.value))}
            className={`${FIELD} focus-visible:ring-brand-blue-600 w-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2`}
          >
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((value) => (
              <option key={value} value={value}>
                {BOOKING_STATUS_LABELS[value]}
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
            className={FIELD}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="filter-to">Tour date to</Label>
          <Input
            id="filter-to"
            type="date"
            value={to}
            onChange={(event) => change(() => setTo(event.target.value))}
            className={FIELD}
          />
        </div>

        <div className="flex items-end">
          <label className="tap-target flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={awaiting}
              onChange={(event) => change(() => setAwaiting(event.target.checked))}
              className="accent-brand-blue-600 size-5 shrink-0"
            />
            Waiting for verification
          </label>
        </div>
      </form>

      {query.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading bookings…
        </p>
      ) : query.isError || !query.data ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium"
        >
          We could not load the bookings. Sign in again, or try once more in a moment.
        </p>
      ) : query.data.items.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>No bookings match those filters.</p>
      ) : (
        <>
          {/* Phone: one card per booking. */}
          <ul className="space-y-3 md:hidden">
            {query.data.items.map((booking) => (
              <li key={booking.ref} className={`${CARD} p-4 text-sm`}>
                <Link
                  to={`/admin/bookings/${booking.ref}`}
                  className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-mono font-semibold underline underline-offset-4 transition-colors"
                >
                  {booking.ref}
                </Link>
                <p className="text-brand-ink font-semibold">{booking.tourTitle}</p>
                <p className="text-brand-error">
                  {booking.tourDate} · {booking.pax} pax · {booking.leadName}
                </p>
                <p className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <BookingStatusPill status={booking.status} />
                  <span className="text-brand-ink font-medium tabular-nums">
                    {formatPeso(booking.paidCentavos)} / {formatPeso(booking.totalCentavos)}
                  </span>
                </p>
              </li>
            ))}
          </ul>

          {/* Laptop: the table. */}
          <div className={`${CARD} hidden overflow-x-auto md:block`}>
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Reference
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Tour
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Guest
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    Paid / total
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((booking) => (
                  <tr
                    key={booking.ref}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="px-4 py-1">
                      <Link
                        to={`/admin/bookings/${booking.ref}`}
                        className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-mono font-semibold underline underline-offset-4 transition-colors"
                      >
                        {booking.ref}
                      </Link>
                    </td>
                    <td className="text-brand-ink px-4 py-3 font-medium">{booking.tourTitle}</td>
                    <td className="text-brand-ink px-4 py-3 tabular-nums">{booking.tourDate}</td>
                    <td className="text-brand-ink px-4 py-3">{booking.leadName}</td>
                    <td className="px-4 py-3">
                      <BookingStatusPill status={booking.status} />
                    </td>
                    <td className="text-brand-ink px-4 py-3 text-right tabular-nums">
                      {formatPeso(booking.paidCentavos)} / {formatPeso(booking.totalCentavos)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-brand-error text-sm" role="status">
              Showing {query.data.offset + 1}–{query.data.offset + query.data.items.length} of{' '}
              {query.data.total}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className={OUTLINE_BUTTON}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                className={OUTLINE_BUTTON}
                disabled={query.data.offset + query.data.items.length >= query.data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
