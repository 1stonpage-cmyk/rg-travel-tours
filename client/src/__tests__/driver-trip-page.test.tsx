/**
 * Week 6, Task 10 — one trip's screen: the payment box and the itinerary
 * checklist.
 *
 * The server side is proved elsewhere: `driver-trip-detail.test.ts` decides
 * the three payment states, `driver-checkins.test.ts` the start / stop /
 * complete rules and `driver-undo.test.ts` the one-event undo. This file
 * proves the SCREEN, and the four things it proves hardest are the four
 * rulings that came out of those tasks' reviews:
 *
 *  1. **A trip that is not live shows no collection instruction.**
 *     `PaymentBoxState` is computed from the money alone and ignores
 *     `bookings.status`, so a `cancelled` booking with an outstanding
 *     balance still arrives here as `collect_cash` with a real amount on
 *     it. The test below hands the screen exactly that and requires the
 *     amount never to appear as something to collect.
 *  2. **The undo control is labelled for what it will actually do** —
 *     "Reopen trip" on a `completed` booking, "Undo last check-in" naming
 *     the stop on an `in_progress` one. Both labels are asserted against
 *     both booking states.
 *  3. **The cash button is today-only and confirms in place.** Hidden when
 *     the server's own bucket says the trip is not today (the server still
 *     refuses it — hiding a button is not access control), and a first tap
 *     submits nothing.
 *  4. **Nothing is optimistic.** A failed check-in leaves the stop
 *     unchecked and says so.
 *
 * Fix round 1 (2026-10-16) added three more, each from a real defect: the
 * undo names the check-in the server would retract - the most recent in
 * TIME, which is not the last one in itinerary order; a cash claim's three
 * possible answers are three different sentences, because telling a driver
 * whose claim committed that it did not save invites the office to record
 * the same cash twice; and the box asks for a reload rather than asserting
 * "not today" when nobody has established what day it is.
 *
 * ## What jsdom cannot see, and this file therefore does not claim
 *
 * jsdom performs no layout and loads no stylesheet. It can read a class
 * attribute, a role, a label, copy and DOM order; it cannot measure a box.
 * So where this file talks about size or position it asserts the PRESENCE
 * of `tap-target` (the 44px floor), `h-14`/`h-16` (the 56px/64px driver
 * targets) and DOM order — never that anything is 56px on a screen, never
 * that the payment box is visually the loudest element, and never that the
 * undo control is far enough from an "Arrived" button for a thumb on a
 * bumpy road. Those are Task 14's walkthrough in a real browser.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { BookingStatus, PaymentBoxState, TripProgressStop } from '@rg/shared';
import DriverTripPage from '@/pages/driver/DriverTripPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

/** 01:15Z is 09:15 Manila; 02:30Z is 10:30. The screen shows Manila. */
const STOPS: TripProgressStop[] = [
  {
    stopId: null,
    name: 'Start trip',
    sortOrder: 0,
    checkedAt: '2026-10-16T01:15:00.000Z',
    undone: false,
  },
  {
    stopId: 11,
    name: 'Oslob viewing deck',
    sortOrder: 1,
    checkedAt: '2026-10-16T02:30:00.000Z',
    undone: false,
  },
  { stopId: 12, name: 'Kawasan Falls', sortOrder: 2, checkedAt: null, undone: false },
  { stopId: 13, name: 'Drop-off', sortOrder: 3, checkedAt: null, undone: false },
];

function trip(
  overrides: {
    status?: BookingStatus;
    payment?: PaymentBoxState;
    stops?: TripProgressStop[];
  } = {},
) {
  const status = overrides.status ?? 'in_progress';
  const stops = overrides.stops ?? STOPS;
  return {
    bookingId: 7,
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Shark Watching',
    tourDate: '2026-10-16',
    pax: 4,
    status,
    leadName: 'Maria Santos',
    leadPhone: '09170000000',
    pickup: 'Radisson Blu lobby, Cebu City',
    pickupMapsUrl: 'https://maps.example.test/radisson',
    vanPlate: 'ABC 123',
    officeNotes: ['Guest is waiting at the second gate.'],
    payment: overrides.payment ?? ({ kind: 'collect_cash', amountCentavos: 150_000 } as const),
    progress: {
      bookingId: 7,
      status,
      stops,
      done: stops.filter((stop) => stop.checkedAt !== null && !stop.undone).length,
      total: stops.length,
    },
  };
}

/** The `bucket` the SERVER resolved. `today` unless a test says otherwise. */
function tripsRow(bucket: 'today' | 'upcoming' | 'history' = 'today') {
  return [
    {
      bookingId: 7,
      ref: 'RG-7KQ4M9',
      tourTitle: 'Oslob Whale Shark Watching',
      tourDate: '2026-10-16',
      pax: 4,
      status: 'in_progress',
      vanPlate: 'ABC 123',
      bucket,
    },
  ];
}

function renderTrip() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/driver/trip/7']}>
        <Routes>
          <Route path="/driver/trip/:bookingId" element={<DriverTripPage />} />
          <Route path="/driver" element={<p>my trips</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('DriverTripPage — the manifest', () => {
  it('shows the guest, the pickup and a way to reach them, and nothing more', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    expect(await screen.findByText('Maria Santos')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^call$/i })).toHaveAttribute(
      'href',
      'tel:09170000000',
    );
    expect(screen.getByRole('link', { name: /^text$/i })).toHaveAttribute(
      'href',
      'sms:09170000000',
    );
    expect(screen.getByRole('link', { name: /whatsapp/i })).toHaveAttribute(
      'href',
      'https://wa.me/639170000000',
    );
    expect(screen.getByText('Radisson Blu lobby, Cebu City')).toBeInTheDocument();
    expect(screen.getByText('Guest is waiting at the second gate.')).toBeInTheDocument();
    // §8 gives the driver a phone and no address. There is no e-mail here.
    expect(document.body.textContent).not.toMatch(/@example/);
  });
});

describe('PaymentBox — the three states, in words', () => {
  it('states the amount to collect in figures and in words', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    expect(await screen.findByRole('heading', { name: 'Collect ₱1,500 cash' })).toBeInTheDocument();
    // The words exist so a mis-read digit is caught.
    expect(screen.getByText('One thousand five hundred pesos')).toBeInTheDocument();
  });

  it('tells a driver to collect nothing when the trip is paid for', async () => {
    mockTrpc({
      'driver.trip': trip({ payment: { kind: 'fully_paid' } }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    expect(
      await screen.findByRole('heading', { name: /paid in full — collect nothing/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record cash/i })).not.toBeInTheDocument();
  });

  /**
   * The amber is not the message — the WORDS are. Colour alone is a WCAG
   * 1.4.1 failure, and this is the state where a misread costs real money.
   */
  it('says "do not collect" in words on the unverified state, not only in amber', async () => {
    mockTrpc({
      'driver.trip': trip({ payment: { kind: 'unverified_do_not_collect' } }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    const heading = await screen.findByRole('heading', {
      name: /do not collect — call the office/i,
    });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/has not been verified/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record cash/i })).not.toBeInTheDocument();
    // The amber is there too — as well as the words, never instead of them.
    expect(heading.closest('section')!.className).toMatch(/amber/);
  });
});

describe('PaymentBox — a trip that is not live gives no instruction', () => {
  /**
   * Ruling 2026-10-15, from Task 4's review. The server reports the money
   * truth and is right to: `collect_cash` with ₱1,500 on a `cancelled`
   * booking is what the arithmetic says. This screen must not turn it into
   * something to do.
   */
  it('renders a cancelled booking as cancelled and never shows its balance', async () => {
    mockTrpc({
      'driver.trip': trip({
        status: 'cancelled',
        payment: { kind: 'collect_cash', amountCentavos: 150_000 },
      }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    expect(await screen.findByRole('heading', { name: /booking cancelled/i })).toBeInTheDocument();
    expect(screen.getByText(/do not collect anything — ring the office/i)).toBeInTheDocument();
    // The amount is not rendered at all — not as a figure, not in words.
    expect(screen.queryByText(/₱1,500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/one thousand five hundred/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record cash/i })).not.toBeInTheDocument();
  });

  it('renders an expired booking as expired, with no balance either', async () => {
    mockTrpc({
      'driver.trip': trip({
        status: 'expired',
        payment: { kind: 'collect_cash', amountCentavos: 150_000 },
      }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    expect(await screen.findByRole('heading', { name: /booking expired/i })).toBeInTheDocument();
    expect(screen.queryByText(/₱1,500/)).not.toBeInTheDocument();
  });
});

describe('PaymentBox — a completed trip still shows what is owed', () => {
  /**
   * D1, owner-decided 2026-10-16. Cash is the BALANCE, handed over at the
   * END of a trip — a driver who taps Complete (or whose last check-in
   * completes the trip automatically) before the guest has paid must still
   * read an instruction to collect it. Before this decision the box
   * suppressed itself on `completed` and printed "There is nothing to
   * collect here", which was false whenever money was still owed.
   */
  it('shows the collect box on a completed trip that still owes money', async () => {
    mockTrpc({
      'driver.trip': trip({
        status: 'completed',
        payment: { kind: 'collect_cash', amountCentavos: 450_000 },
      }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    // The figure AND the words — rule 3 is not suspended because the trip ended.
    expect(await screen.findByRole('heading', { name: /Collect ₱4,500 cash/ })).toBeInTheDocument();
    expect(screen.getByText(/Four thousand five hundred pesos/)).toBeInTheDocument();
    // The button is offered, because the server accepts the claim.
    expect(screen.getByRole('button', { name: /Record cash collected/ })).toBeInTheDocument();
    // And the false sentence is gone.
    expect(screen.queryByText(/nothing to collect/i)).not.toBeInTheDocument();
  });

  it('still hides the amount on a cancelled and on an expired booking', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      mockTrpc({
        'driver.trip': trip({
          status,
          payment: { kind: 'collect_cash', amountCentavos: 450_000 },
        }),
        'driver.trips': tripsRow(),
      });
      const { unmount } = renderTrip();

      expect(await screen.findByText(/do not collect/i)).toBeInTheDocument();
      expect(screen.queryByText(/4,500/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('a completed trip that is fully paid says so, and offers no cash button', async () => {
    mockTrpc({
      'driver.trip': trip({ status: 'completed', payment: { kind: 'fully_paid' } }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    const heading = await screen.findByRole('heading', { name: /Paid in full/ });
    // Scoped to the payment box itself: the page's separate undo control
    // ("Reopen trip" on a completed booking) is a different box entirely.
    const box = heading.closest('section')!;
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PaymentBox — the cash claim', () => {
  it('submits nothing on the first tap and nothing at all if it is cancelled', async () => {
    const calls: unknown[] = [];
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.recordCash': (input: unknown) => {
        calls.push(input);
        return { paymentId: 99, amountCentavos: 150_000 };
      },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /record cash collected/i }));
    // Step two, in place — no modal, and nothing sent yet.
    expect(screen.getByText(/only confirm once the guest has handed you ₱1,500/i)).toBeVisible();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(calls).toEqual([]);
    expect(screen.getByRole('button', { name: /record cash collected/i })).toBeInTheDocument();
  });

  it('sends the booking id and no amount once the second tap confirms', async () => {
    const calls: unknown[] = [];
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.recordCash': (input: unknown) => {
        calls.push(input);
        return { paymentId: 99, amountCentavos: 150_000 };
      },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /record cash collected/i }));
    await user.click(screen.getByRole('button', { name: /i have taken ₱1,500/i }));

    // The browser never says how much. The server derives it.
    await waitFor(() => expect(calls).toEqual([{ bookingId: 7 }]));
  });

  /**
   * The server answers `FORBIDDEN` for a trip that is not today, and that
   * refusal is the control. This only keeps the screen from offering an
   * action it knows will be refused — and the "is it today" answer comes
   * from the server's own `bucket`, never from the handset's clock.
   */
  it('offers no cash button when the server says the trip is not today', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow('upcoming') });
    renderTrip();

    expect(await screen.findByRole('heading', { name: 'Collect ₱1,500 cash' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /record cash collected/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/only be recorded on the day of the trip/i)).toBeInTheDocument();
  });

  /**
   * `false` is a CLAIM about what day it is. When the list has not
   * resolved - or does not carry this trip - nobody has established that,
   * so the box asks for a reload instead of asserting a fact. The button
   * is hidden either way, which is the fail-closed direction.
   */
  it('asks for a reload, rather than claiming a day, when the list carries no row', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': [] });
    renderTrip();

    expect(await screen.findByRole('heading', { name: 'Collect ₱1,500 cash' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /record cash collected/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Reload this trip to record cash.')).toBeInTheDocument();
    expect(screen.queryByText(/only be recorded on the day of the trip/i)).not.toBeInTheDocument();
  });

  it('asks for a reload while the trip list is still failing to answer', async () => {
    mockTrpc({ 'driver.trip': trip() });
    mockTrpcError('driver.trips', 'INTERNAL_SERVER_ERROR');
    renderTrip();

    expect(await screen.findByRole('heading', { name: 'Collect ₱1,500 cash' })).toBeInTheDocument();
    expect(screen.getByText('Reload this trip to record cash.')).toBeInTheDocument();
    expect(screen.queryByText(/only be recorded on the day of the trip/i)).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- *
   * What a claim's answer is allowed to say (fix round 1).
   *
   * `recordCash` refuses two ways and can also succeed; all three used to
   * render the same "did not save" sentence, so a claim that COMMITTED but
   * whose refetch failed told the driver the money was not recorded and
   * invited a retry. `mockTrpcError` honours its code, so each branch is
   * testable.
   * ---------------------------------------------------------------- */

  async function claim() {
    const user = userEvent.setup();
    renderTrip();
    await user.click(await screen.findByRole('button', { name: /record cash collected/i }));
    await user.click(screen.getByRole('button', { name: /i have taken ₱1,500/i }));
    return user;
  }

  it('acknowledges a recorded claim with the amount the server says it took', async () => {
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.recordCash': { paymentId: 99, amountCentavos: 150_000 },
    });
    await claim();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Recorded: ₱1,500 taken in cash. The office will verify it.',
    );
  });

  it('says a claim may already be recorded when the server answers CONFLICT', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    mockTrpcError('driver.recordCash', 'CONFLICT', 'nothing to collect');
    await claim();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/may already be recorded.*reload this trip/i);
    // It must NOT tell a driver whose claim committed that it did not save.
    expect(alert).not.toHaveTextContent(/did not save/i);
  });

  it('says cash is day-of-trip only when the server answers FORBIDDEN', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    mockTrpcError('driver.recordCash', 'FORBIDDEN', 'not today');
    await claim();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cash can only be recorded on the day of the trip.',
    );
  });

  it('keeps the generic sentence for a claim that never reached the server', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    mockTrpcError('driver.recordCash', 'INTERNAL_SERVER_ERROR');
    await claim();

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not save.*check your signal/i);
  });
});

describe('StopList — a checklist, not a form', () => {
  it('lists the stops in itinerary order with trip start first', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    const list = (await screen.findByRole('heading', { name: 'Itinerary' })).closest('section')!;
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Start trip'),
      expect.stringContaining('Oslob viewing deck'),
      expect.stringContaining('Kawasan Falls'),
      expect.stringContaining('Drop-off'),
    ]);
  });

  it('shows each tapped stop its Manila check-in time instead of a button', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    expect(await screen.findByText('09:15')).toBeInTheDocument(); // trip start
    expect(screen.getByText('10:30')).toBeInTheDocument(); // Oslob
    expect(screen.queryByRole('button', { name: /arrived at oslob/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /arrived at kawasan falls/i })).toBeInTheDocument();
  });

  /**
   * `total` counts the trip-start pseudo-stop, deliberately — it is what
   * makes the dispatcher's bar move when the van leaves. Stated in text,
   * never as a bar alone.
   */
  it('states progress in words, counting trip start in the total', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    expect(await screen.findByText('2 of 4 stops')).toBeInTheDocument();
  });

  it('keeps a retracted check-in visible and its stop tappable again', async () => {
    const stops: TripProgressStop[] = [
      STOPS[0]!,
      { ...STOPS[1]!, undone: true },
      STOPS[2]!,
      STOPS[3]!,
    ];
    mockTrpc({ 'driver.trip': trip({ stops }), 'driver.trips': tripsRow() });
    renderTrip();

    expect(await screen.findByText(/checked in at 10:30, then retracted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /arrived at oslob viewing deck/i })).toBeEnabled();
    expect(screen.getByText('1 of 4 stops')).toBeInTheDocument();
  });

  it('sends the stop id the driver tapped, and only that one', async () => {
    const calls: unknown[] = [];
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.checkIn': (input: unknown) => {
        calls.push(input);
        return { ok: true, progress: trip().progress };
      },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /arrived at kawasan falls/i }));
    await waitFor(() => expect(calls).toEqual([{ bookingId: 7, stopId: 12 }]));
  });

  it('shows the server-named reason when a check-in is refused', async () => {
    mockTrpc({
      'driver.trip': trip({
        status: 'assigned',
        stops: STOPS.map((stop) => ({ ...stop, checkedAt: null })),
      }),
      'driver.trips': tripsRow(),
      'driver.startTrip': { ok: false, reason: 'trip_not_startable' },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /start trip/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /cannot be started yet — the office still has to assign a van and driver/i,
    );
  });

  /**
   * The house guard (`AssignPanel`, `DriverLoginPage`) on a value that
   * arrived over the wire: the compiler cannot vouch for a `reason` string,
   * and an unrecognised one used to leave the notice `undefined` - a tap
   * that silently did nothing, which is the worst thing this screen can do.
   */
  it('still says something when the server names a reason this screen does not know', async () => {
    mockTrpc({
      'driver.trip': trip({
        status: 'assigned',
        stops: STOPS.map((stop) => ({ ...stop, checkedAt: null })),
      }),
      'driver.trips': tripsRow(),
      // Not a `CheckInRefusal` - which is exactly the point.
      'driver.startTrip': { ok: false, reason: 'a_reason_from_a_later_release' },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /start trip/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not save.*check your signal/i);
  });
});

describe('StopList — nothing is optimistic', () => {
  /**
   * The whole rule, in one test. A stop that appeared checked-in and later
   * is not is worse than a half-second wait, because the driver has
   * already driven away.
   */
  it('leaves a stop unchecked when the check-in does not save', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    mockTrpcError('driver.checkIn', 'INTERNAL_SERVER_ERROR');
    const user = userEvent.setup();
    renderTrip();

    const arrived = await screen.findByRole('button', { name: /arrived at kawasan falls/i });
    await user.click(arrived);

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not save.*check your signal/i);
    // Still a button, still unchecked, and no time against it.
    expect(screen.getByRole('button', { name: /arrived at kawasan falls/i })).toBeInTheDocument();
    expect(screen.getByText('2 of 4 stops')).toBeInTheDocument();
  });

  it('shows the tapped stop as saving, and disables every other tap while it is', async () => {
    let release: ((value: unknown) => void) | undefined;
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.checkIn': async () => {
        await inFlight;
        return { ok: true, progress: trip().progress };
      },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(await screen.findByRole('button', { name: /arrived at kawasan falls/i }));

    const saving = await screen.findByRole('button', { name: /saving/i });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: /arrived at drop-off/i })).toBeDisabled();

    release!(null);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /arrived at kawasan falls/i })).toBeEnabled(),
    );
  });
});

describe('StopList — the undo says what it will do', () => {
  /**
   * Ruling 2026-10-15, from Task 6's review. An undo reverses ONE event,
   * and a trip closed by a last-stop check-in took two — so a completed
   * booking's next undo reopens the trip, and only the one after that
   * un-checks a stop. The label is what makes that legible mid-trip.
   */
  it('reads "Reopen trip" on a completed booking', async () => {
    mockTrpc({
      'driver.trip': trip({ status: 'completed' }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    expect(await screen.findByRole('button', { name: 'Reopen trip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo last check-in/i })).not.toBeInTheDocument();
  });

  it('reads "Undo last check-in" and names the stop on a trip under way', async () => {
    mockTrpc({ 'driver.trip': trip({ status: 'in_progress' }), 'driver.trips': tripsRow() });
    renderTrip();

    expect(
      await screen.findByRole('button', { name: 'Undo last check-in — Oslob viewing deck' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen trip' })).not.toBeInTheDocument();
  });

  /**
   * The server accepts an undo only against the most recent un-undone
   * check-in, so that is the only one the screen offers it against — ONE
   * control, not one per stop, and not beside the "Arrived" buttons.
   */
  it('offers exactly one undo, against the newest un-undone check-in', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    await screen.findByText('Itinerary');
    const undos = screen.getAllByRole('button', { name: /undo last check-in/i });
    expect(undos).toHaveLength(1);
    expect(undos[0]).toHaveAccessibleName('Undo last check-in — Oslob viewing deck');

    // Not inside the checklist's own list of stops.
    expect(undos[0]!.closest('li')).toBeNull();
  });

  /**
   * **The one the server would actually retract.** `undoLastCheckIn` orders
   * by `checked_at DESC, id DESC`, and nothing forces check-ins into
   * itinerary order: `driver.checkIn` accepts any stop on the tour and this
   * screen keeps every un-checked stop live, because a driver may genuinely
   * reach stops out of order.
   *
   * Here Drop-off (the LAST stop in the itinerary) was tapped at 10:00 and
   * the Oslob deck (earlier in the itinerary) at 10:30 - so the server's
   * next undo retracts Oslob. A screen that picked the last standing stop
   * in ARRAY order would confidently promise to retract Drop-off, which
   * falsifies the trip record the undo exists to protect.
   */
  it('names the stop the server would retract when stops were tapped out of order', async () => {
    const stops: TripProgressStop[] = [
      STOPS[0]!, // Start trip, 09:15
      { ...STOPS[1]!, checkedAt: '2026-10-16T02:30:00.000Z' }, // Oslob deck, 10:30
      STOPS[2]!, // Kawasan Falls, never checked
      { ...STOPS[3]!, checkedAt: '2026-10-16T02:00:00.000Z' }, // Drop-off, 10:00
    ];
    mockTrpc({ 'driver.trip': trip({ stops }), 'driver.trips': tripsRow() });
    renderTrip();

    expect(
      await screen.findByRole('button', { name: 'Undo last check-in — Oslob viewing deck' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /undo last check-in — drop-off/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * `trip_checkpoints.checked_at` is a MySQL `datetime` with no sub-second
   * precision, so two check-ins in the same second are ordinary. The server
   * breaks that tie on the checkpoint id (insertion order), which this
   * payload does not carry; the array index stands in, deterministically.
   * What matters is that it picks ONE, and the same one every render.
   */
  it('breaks a same-second tie deterministically, on the later itinerary stop', async () => {
    const sameSecond = '2026-10-16T02:30:00.000Z';
    const stops: TripProgressStop[] = [
      STOPS[0]!,
      { ...STOPS[1]!, checkedAt: sameSecond },
      { ...STOPS[2]!, checkedAt: sameSecond },
      STOPS[3]!,
    ];
    mockTrpc({ 'driver.trip': trip({ stops }), 'driver.trips': tripsRow() });
    renderTrip();

    expect(
      await screen.findByRole('button', { name: 'Undo last check-in — Kawasan Falls' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /undo last check-in/i })).toHaveLength(1);
  });

  it('names trip start when that is the only check-in still standing', async () => {
    const stops: TripProgressStop[] = [
      STOPS[0]!,
      { ...STOPS[1]!, checkedAt: null },
      STOPS[2]!,
      STOPS[3]!,
    ];
    mockTrpc({ 'driver.trip': trip({ stops }), 'driver.trips': tripsRow() });
    renderTrip();

    expect(
      await screen.findByRole('button', { name: 'Undo last check-in — Start trip' }),
    ).toBeInTheDocument();
  });

  it('offers no undo at all before anything has been checked in', async () => {
    const stops: TripProgressStop[] = STOPS.map((stop) => ({ ...stop, checkedAt: null }));
    mockTrpc({
      'driver.trip': trip({ status: 'assigned', stops }),
      'driver.trips': tripsRow(),
    });
    renderTrip();

    await screen.findByText('Itinerary');
    expect(screen.queryByRole('button', { name: /undo last check-in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen trip' })).not.toBeInTheDocument();
  });

  it('needs a reason before it will submit, and sends the one that was typed', async () => {
    const calls: unknown[] = [];
    mockTrpc({
      'driver.trip': trip(),
      'driver.trips': tripsRow(),
      'driver.undoCheckIn': (input: unknown) => {
        calls.push(input);
        return { ok: true, stopId: 11 };
      },
    });
    const user = userEvent.setup();
    renderTrip();

    await user.click(
      await screen.findByRole('button', { name: 'Undo last check-in — Oslob viewing deck' }),
    );

    const confirm = screen.getByRole('button', { name: /^confirm — undo last check-in/i });
    expect(confirm).toBeDisabled(); // No reason yet, so nothing to send.
    expect(calls).toEqual([]);

    await user.type(screen.getByLabelText(/why\?/i), 'Tapped it before we got there');
    await user.click(confirm);

    await waitFor(() =>
      expect(calls).toEqual([{ bookingId: 7, reason: 'Tapped it before we got there' }]),
    );
  });
});

describe('DriverTripPage — reachable by one thumb', () => {
  it('puts the 44px floor and the driver-sized height on every control', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    await screen.findByText('Itinerary');
    const controls = [...screen.getAllByRole('button'), ...screen.getAllByRole('link')].filter(
      // The back link is navigation chrome, not one of the trip's actions.
      (el) => el.textContent?.trim() !== 'My trips',
    );
    expect(controls.length).toBeGreaterThan(5);

    const missingFloor = controls
      .filter((el) => !el.className.split(/\s+/).includes('tap-target'))
      .map((el) => el.textContent);
    expect(missingFloor).toEqual([]);

    const missingHeight = controls
      .filter((el) => !/\bh-1[46]\b/.test(el.className))
      .map((el) => el.textContent);
    expect(missingHeight).toEqual([]);
  });

  it('puts the payment box above the itinerary', async () => {
    mockTrpc({ 'driver.trip': trip(), 'driver.trips': tripsRow() });
    renderTrip();

    const box = await screen.findByRole('heading', { name: 'Collect ₱1,500 cash' });
    const itinerary = screen.getByRole('heading', { name: 'Itinerary' });
    // DOM order is assertable; which is visually louder is not.
    expect(box.compareDocumentPosition(itinerary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('refuses a bookingId that is not a booking, without asking the server', async () => {
    mockTrpc({ 'driver.trips': tripsRow() });
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/driver/trip/not-a-number']}>
          <Routes>
            <Route path="/driver/trip/:bookingId" element={<DriverTripPage />} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a trip/i);
  });
});
