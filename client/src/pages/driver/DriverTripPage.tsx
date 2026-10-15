/**
 * One trip, as the driver who is driving it sees it — §8's trip detail
 * (Week 6 plan, Task 10).
 *
 * Order on the screen is the design decision, not an accident: **the
 * payment box sits above the itinerary**, because it is the loudest and
 * most consequential thing here. The manifest (who, where, which van) is
 * above both, and the office notes below the checklist, where a driver
 * reads them once rather than every time they tap a stop.
 *
 * ## Where "is it today" comes from
 *
 * `driver.recordCash` is today-only — the server answers `FORBIDDEN` for
 * any other date, and that refusal stays whatever this screen does
 * (CLAUDE.md: hiding a button is not access control). The button is hidden
 * anyway, so the UI does not offer an action it knows will be refused, and
 * the answer to "is it today" comes from `driver.trips` — whose rows carry
 * a `bucket` resolved on the SERVER from the Manila civil date. Not from
 * `new Date()` in a handset that may be eight hours out, and not from a
 * second copy of the bucket rule. If that row is missing the answer is
 * `null` — **not `false`** — and the button stays hidden: the fail-closed
 * direction is "do not offer to take money", but `false` is a claim about
 * what day it is, and claiming one nobody established is a different bug
 * (fix round 1, 2026-10-16; see `PaymentBox`'s `isToday`).
 *
 * That query is the same one `/driver` loaded a moment ago, and
 * `httpBatchLink` puts it in the same HTTP request as `driver.trip` on a
 * cold open, so in practice it costs nothing and is served from the React
 * Query cache (`staleTime: 60_000`) when arriving from `/driver`.
 *
 * ## Everything the guest's privacy allows and nothing more
 *
 * `driver.trip` is the most sensitive payload in the portal under RA 10173
 * — it carries the lead guest's phone so §8's call / text / WhatsApp
 * buttons can exist. It carries no e-mail, no other guest, no money beyond
 * the payment box and no payment instrument data, and this screen invents
 * none of those.
 */
import { ArrowLeft, MessageCircle, Navigation, Phone, StickyNote } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { type TripDetail } from '@rg/shared';
import PaymentBox from '@/components/driver/PaymentBox';
import StopList from '@/components/driver/StopList';
import { STATUS_LABEL } from '@/components/driver/trip-copy';
import { waNumber } from '@/lib/phone';
import { trpc } from '@/lib/trpc';

/** `'2026-12-25'` → a readable Manila date. Display only, no arithmetic. */
const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const CONTACT_CLASS =
  'tap-target press border-brand-blue-300 text-brand-blue-900 focus-visible:ring-brand-blue-600 flex h-14 flex-1 items-center justify-center gap-2 rounded-xl border-2 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2';

function BackLink() {
  return (
    <Link
      to="/driver"
      className="tap-target press text-brand-blue-900 focus-visible:ring-brand-blue-600 -ml-1 inline-flex items-center gap-1.5 rounded-md px-1 text-base font-semibold focus-visible:outline-none focus-visible:ring-2"
    >
      <ArrowLeft className="size-5" aria-hidden="true" />
      My trips
    </Link>
  );
}

function TripScreen({
  trip,
  isToday,
  onChanged,
}: {
  trip: TripDetail;
  isToday: boolean | null;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-5">
      <header>
        <BackLink />
        <h1 className="text-brand-blue-900 mt-2 text-2xl font-bold">{trip.tourTitle}</h1>
        <p className="text-brand-blue-900 mt-1 text-base font-medium">
          {dateFormatter.format(new Date(`${trip.tourDate}T00:00:00Z`))}
          <span aria-hidden="true"> · </span>
          {trip.pax === 1 ? '1 guest' : `${trip.pax} guests`}
        </p>
        <p className="text-brand-blue-900 mt-1 text-sm font-semibold">
          {trip.ref}
          <span aria-hidden="true"> · </span>
          {STATUS_LABEL[trip.status]}
          {trip.vanPlate === null ? null : (
            <>
              <span aria-hidden="true"> · </span>
              {trip.vanPlate}
            </>
          )}
        </p>
      </header>

      <section
        aria-labelledby="guest-heading"
        className="border-brand-blue-200 bg-background space-y-3 rounded-xl border p-4"
      >
        <h2 id="guest-heading" className="text-brand-blue-900 text-base font-bold">
          {trip.leadName}
        </h2>
        <div className="flex gap-2">
          <a href={`tel:${trip.leadPhone}`} className={CONTACT_CLASS}>
            <Phone className="size-5" aria-hidden="true" />
            Call
          </a>
          <a href={`sms:${trip.leadPhone}`} className={CONTACT_CLASS}>
            <MessageCircle className="size-5" aria-hidden="true" />
            Text
          </a>
        </div>
        {/*
         * WhatsApp's own green is a documented palette exception
         * (CLAUDE.md) and carries NO white text — so this control is the
         * same bordered shape as Call and Text, with the wording in brand
         * ink. A driver has one list of buttons, not two styles of button.
         */}
        <a
          href={`https://wa.me/${waNumber(trip.leadPhone)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={CONTACT_CLASS}
        >
          WhatsApp
        </a>
        {trip.pickup === null ? (
          <p className="text-brand-blue-900 text-base">
            No pickup point recorded. Ring the guest or the office.
          </p>
        ) : (
          <div>
            <p className="text-brand-blue-900 text-base font-semibold">Pickup</p>
            <p className="text-brand-blue-900 text-base">{trip.pickup}</p>
            {trip.pickupMapsUrl === null ? null : (
              <a
                href={trip.pickupMapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${CONTACT_CLASS} mt-2`}
              >
                <Navigation className="size-5" aria-hidden="true" />
                Open in Maps
              </a>
            )}
          </div>
        )}
      </section>

      {/* The loudest element, above the itinerary. */}
      <PaymentBox
        bookingId={trip.bookingId}
        status={trip.status}
        payment={trip.payment}
        isToday={isToday}
        onCollected={onChanged}
      />

      <StopList
        bookingId={trip.bookingId}
        status={trip.status}
        progress={trip.progress}
        onChanged={onChanged}
      />

      {trip.officeNotes.length === 0 ? null : (
        <section
          aria-labelledby="notes-heading"
          className="border-brand-blue-200 bg-background rounded-xl border p-4"
        >
          <h2
            id="notes-heading"
            className="text-brand-blue-900 flex items-center gap-2 text-base font-bold"
          >
            <StickyNote className="size-5" aria-hidden="true" />
            Office notes
          </h2>
          <ul className="mt-2 space-y-2">
            {trip.officeNotes.map((note, index) => (
              <li key={index} className="text-brand-blue-900 text-base">
                {note}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function DriverTripPage() {
  const { bookingId: raw } = useParams();
  const bookingId = Number(raw);
  const valid = Number.isInteger(bookingId) && bookingId > 0;

  const utils = trpc.useUtils();
  const trip = trpc.driver.trip.useQuery({ bookingId }, { enabled: valid });
  const trips = trpc.driver.trips.useQuery();

  /**
   * Nothing is optimistic: after any successful mutation the screen is
   * redrawn from what the server now says, not from what the tap intended.
   * `driver.trips` goes too — a completed trip changes its chip in the
   * list, and the cash claim does not, but refetching both is one request
   * either way and keeps the two surfaces from disagreeing.
   */
  function refetch() {
    void utils.driver.trip.invalidate({ bookingId });
    void utils.driver.trips.invalidate();
  }

  if (!valid) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p role="alert" className="text-brand-blue-900 text-base font-medium">
          That is not a trip. Go back to your trips.
        </p>
      </div>
    );
  }

  if (trip.isPending) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p role="status" className="text-brand-blue-900 text-base">
          Loading this trip…
        </p>
      </div>
    );
  }

  if (trip.data === undefined) {
    return (
      <div className="space-y-3">
        <BackLink />
        <p
          role="alert"
          className="border-brand-error text-brand-error bg-background rounded-lg border-l-4 p-3 text-base font-medium"
        >
          This trip could not be loaded. Check your signal, or sign in again.
        </p>
      </div>
    );
  }

  /*
   * `null`, not `false`, when there is no row to read it off — an
   * unresolved or failed `driver.trips`, or a trip that is somehow not on
   * the list this driver was handed (fix round 1, 2026-10-16). Both hide
   * the cash button, which is the fail-closed direction and is what the
   * server enforces anyway; what `false` must not do is let the box
   * ASSERT that the trip is not today when nobody has established it.
   */
  const row = trips.data?.find((entry) => entry.bookingId === bookingId);
  const isToday = row === undefined ? null : row.bucket === 'today';

  return <TripScreen trip={trip.data} isToday={isToday} onChanged={refetch} />;
}
