/**
 * Task T14, rebuilt 2026-11-08 for the flexible places/routes/vehicle-types
 * model (owner decision 2026-11-08). Covers the happy path (type → route →
 * vehicle → guest details → submit → `<PaymentOptions>`), the "vehicle
 * unavailable for this route" rendering when one offered vehicle's
 * `quoteTransfer` throws, the bad-coupon recovery (Critical 1, generalized),
 * the stale-placeholder guard (Critical 2), AND the new direction behaviour
 * — picking the reverse leg of a reversible route sends
 * `direction: 'reverse'` on hold, the single most important correctness
 * point of this rebuild.
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { seatCapMessage, type TransferRoutePublicRow } from '@rg/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TransferBookingPage from '@/pages/public/TransferBookingPage';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, trpcError, trpcValidationError } from './helpers/mock-trpc';

const MACTAN: TransferRoutePublicRow = {
  id: 1,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
  toPlace: { id: 11, name: 'Moalboal', placeType: 'destination' },
  reverseEnabled: false,
  slug: 'mactan-airport-moalboal',
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  pricingMode: 'per_vehicle',
  minPayingPax: 1,
  pageTitle: 'Mactan-Cebu International Airport to Moalboal Private Transfer',
  reversePageTitle: null,
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 150_000,
      dayUsePriceCentavos: 400_000,
      defaultSeats: null,
    },
    {
      vehicleTypeId: 2,
      vehicleTypeName: 'SUV',
      slug: 'suv',
      oneWayPriceCentavos: 200_000,
      dayUsePriceCentavos: 500_000,
      defaultSeats: null,
    },
  ],
};

/** A reversible route, used only by the direction test below. */
const REVERSIBLE: TransferRoutePublicRow = {
  ...MACTAN,
  id: 5,
  toPlace: { id: 13, name: 'Cebu City', placeType: 'destination' },
  reverseEnabled: true,
  slug: 'mactan-cebu-city',
  pageTitle: 'Mactan-Cebu International Airport to Cebu City Private Transfer',
  reversePageTitle: 'Cebu City to Mactan-Cebu International Airport Private Transfer',
};

const VAN_QUOTE = {
  subtotalCentavos: 150_000,
  discountCentavos: 0,
  totalCentavos: 150_000,
  depositCentavos: 45_000,
  amountDueNowCentavos: { full: 150_000, deposit: 45_000 },
  balanceCentavos: { full: 0, deposit: 105_000 },
  freeCancelHours: 24,
  pricingMode: 'per_vehicle' as const,
  paxCharged: 1,
};

const SUV_QUOTE = {
  ...VAN_QUOTE,
  subtotalCentavos: 200_000,
  totalCentavos: 200_000,
  amountDueNowCentavos: { full: 200_000, deposit: 60_000 },
};

const HOLD_RESULT = {
  ref: 'RG-TRF001',
  bookingId: 99,
  holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

function renderPage(entry = '/transfer') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/transfer" element={<TransferBookingPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

async function selectTypeAndRoute(
  user: ReturnType<typeof userEvent.setup>,
  routeName: RegExp = /^mactan-cebu international airport/i,
) {
  await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
  await user.click(await screen.findByRole('radio', { name: routeName }));
}

/** `quoteTransfer` handler keyed on `vehicleTypeId` (1 = van, 2 = suv), matching the fixtures above. */
function quoteByVehicleTypeId(input: unknown) {
  const { vehicleTypeId } = input as { vehicleTypeId: number };
  return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
}

describe('TransferBookingPage — happy path', () => {
  it('walks type → route → vehicle → guest details → submit → shows PaymentOptions, sending vehicleTypeId and direction: forward', async () => {
    let capturedHoldInput: Record<string, unknown> | undefined;
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
      'checkout.createHoldTransfer': (input: unknown) => {
        capturedHoldInput = input as Record<string, unknown>;
        return HOLD_RESULT;
      },
      'settings.get': SETTINGS_FIXTURE,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    // Settles out of its skeleton once the quote resolves. Checked via the
    // radio's own disabled state, not the price text, which also appears
    // in `RoutePicker`'s own "from ₱1,500" line on this same screen.
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    fireEvent.change(within(form).getByLabelText(/pickup date/i), {
      target: { value: '2026-12-15' },
    });
    fireEvent.change(within(form).getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    fireEvent.change(within(form).getByLabelText(/^passengers$/i), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText(/luggage \(bags\)/i), { target: { value: '1' } });
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');
    // MACTAN's fromPlace is an airport, so flightNumber/airline are now
    // REQUIRED client-side (owner decision 2026-11-08, decision 5) — filled
    // in so the native `required` attribute does not block this submit.
    await user.type(within(form).getByLabelText(/^flight number$/i), 'PR123');
    await user.type(within(form).getByLabelText(/^airline$/i), 'Philippine Airlines');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/whatsapp.*mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));

    await user.click(within(form).getByRole('button', { name: /book now/i }));

    expect(await screen.findByText(/RG-TRF001/)).toBeInTheDocument();
    // Review fix (Important 3): the ref string alone also renders in a
    // plain sibling <span> unconditionally, so it proves nothing about
    // whether <PaymentOptions> itself mounted — "Pay now" is PayNowButton's
    // own text, reachable only through PaymentOptions (SETTINGS_FIXTURE
    // ships onlinePaymentEnabled: true).
    expect(await screen.findByRole('button', { name: /^pay now$/i })).toBeInTheDocument();

    // The most important correctness point of this rebuild: the HOLD
    // carries vehicleTypeId (never a `van`/`suv` string) and direction —
    // 'forward' here, since the route has no reverse leg to pick.
    expect(capturedHoldInput?.routeId).toBe(1);
    expect(capturedHoldInput?.vehicleTypeId).toBe(1);
    expect(capturedHoldInput?.direction).toBe('forward');
  });
});

/**
 * Task 6 — "clicking Book now does nothing visible", closed. A submit whose
 * payload fails the SAME schema the server enforces
 * (`createHoldTransferInput`) never reaches `createHoldTransfer.mutate()` at
 * all: it shows an `<ErrorSummary>` and scrolls/focuses the first invalid
 * field instead.
 */
describe('TransferBookingPage — client-side pre-submit validation (Task 6)', () => {
  beforeEach(() => {
    // jsdom implements no `Element.prototype.scrollIntoView` — see this
    // file's existing "route picked before type" describe block.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows an error summary and focuses the first invalid field instead of calling the server', async () => {
    let createHoldTransferCalls = 0;
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
      'checkout.createHoldTransfer': () => {
        createHoldTransferCalls += 1;
        return HOLD_RESULT;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    fireEvent.change(within(form).getByLabelText(/pickup date/i), {
      target: { value: '2026-12-15' },
    });
    fireEvent.change(within(form).getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    fireEvent.change(within(form).getByLabelText(/^passengers$/i), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText(/luggage \(bags\)/i), { target: { value: '1' } });
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');
    // MACTAN's fromPlace is an airport, so these are required (same as the
    // happy-path test above) — filled in so they are not the invalid field.
    await user.type(within(form).getByLabelText(/^flight number$/i), 'PR123');
    await user.type(within(form).getByLabelText(/^airline$/i), 'Philippine Airlines');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    // Non-blank but not a real mobile number — the native `required`
    // attribute would otherwise block the submit event before React ever
    // sees it, which would prove nothing about THIS validation.
    await user.type(within(form).getByLabelText(/whatsapp.*mobile number/i), '123');
    await user.click(within(form).getByLabelText(/i agree/i));

    await user.click(within(form).getByRole('button', { name: /book now/i }));

    // Query by the summary's own sentence, not by role="alert" alone —
    // `FieldError` ALSO renders role="alert" per field.
    expect(screen.getByText(/check \d+ field/i)).toBeInTheDocument();
    const phoneInput = within(form).getByLabelText(/whatsapp.*mobile number/i);
    expect(document.activeElement).toBe(phoneInput);
    expect(phoneInput.className).toMatch(/border-brand-warning/);
    expect(createHoldTransferCalls).toBe(0);
  });
});

describe('TransferBookingPage — reversible route (owner decision 2026-11-08)', () => {
  it('sends direction: "reverse" and the SAME routeId when the guest picks the reverse leg', async () => {
    let capturedHoldInput: Record<string, unknown> | undefined;
    mockTrpc({
      'transferRoutes.list': [REVERSIBLE],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
      'checkout.createHoldTransfer': (input: unknown) => {
        capturedHoldInput = input as Record<string, unknown>;
        return HOLD_RESULT;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    // The REVERSE leg's label starts with the to-place name ("Cebu City"),
    // not the from-place name — picking it is what proves the picker can
    // offer the trip the other way round, same route id.
    await user.click(await screen.findByRole('radio', { name: /^cebu city/i }));

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    fireEvent.change(within(form).getByLabelText(/pickup date/i), {
      target: { value: '2026-12-15' },
    });
    fireEvent.change(within(form).getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    fireEvent.change(within(form).getByLabelText(/^passengers$/i), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText(/luggage \(bags\)/i), { target: { value: '1' } });
    await user.type(within(form).getByLabelText(/drop-off address/i), 'Mactan Airport');
    /*
     * Retargeted comment (owner decision 3, 2026-11-09): under the
     * superseded "either end" rule this WAS required regardless of
     * direction. Under the new pickup-only rule, the reverse leg's pickup
     * is `toPlace` ("Cebu City", not an airport per REVERSIBLE's fixture),
     * so flight details are merely OPTIONAL here, not required — see the
     * dedicated "flight details, decision 3" describe block below for the
     * three-state assertions. They are still filled in here because this
     * test's own point is the `direction` value on the hold payload, not
     * the fields' required-ness, and an optional field still accepts input.
     */
    await user.type(within(form).getByLabelText(/flight number/i), 'PR123');
    await user.type(within(form).getByLabelText(/airline/i), 'Philippine Airlines');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/whatsapp.*mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));

    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await screen.findByText(/RG-TRF001/);
    expect(capturedHoldInput?.routeId).toBe(5);
    expect(capturedHoldInput?.direction).toBe('reverse');
  });

  it('keeps the vehicle selection when only direction changes (same route, same vehiclePrices)', async () => {
    mockTrpc({
      'transferRoutes.list': [REVERSIBLE],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    await user.click(
      await screen.findByRole('radio', { name: /^mactan-cebu international airport/i }),
    );
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);
    expect(vanRadio).toBeChecked();

    // Flip direction only — the route id is unchanged.
    await user.click(await screen.findByRole('radio', { name: /^cebu city/i }));

    expect(await screen.findByRole('radio', { name: /^van/i })).toBeChecked();
  });
});

describe('TransferBookingPage — flight details required on an airport route', () => {
  /**
   * Still valid, unretargeted: MACTAN's `fromPlace` is an airport, and
   * `selectTypeAndRoute`'s default regex picks the FORWARD leg — forward
   * pickup is `fromPlace` — so under decision 3's pickup-only rule this is
   * still the 'required' case, same as it was under the superseded
   * either-end rule.
   */
  it('marks flightNumber/airline as required once a vehicle is selected on an airport-touching route', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).getByLabelText(/^flight number$/i)).toBeRequired();
    expect(within(form).getByLabelText(/^airline$/i)).toBeRequired();
  });
});

/**
 * Owner decision 3, 2026-11-09 — narrows decision 5 (2026-11-08) from
 * "either end is an airport" to "the PICKUP place is an airport", where
 * pickup depends on `direction`. The describe block above already covers
 * the REQUIRED case (pickup is an airport, forward direction); these cover
 * the two states that are NEW relative to the superseded rule: optional
 * (drop-off-only) and hidden (neither place), plus the direction flip that
 * makes the SAME two-place route answer differently depending on which way
 * it is travelled.
 */
describe('TransferBookingPage — flight details, decision 3 (pickup-only, direction-dependent)', () => {
  /** Only the drop-off is an airport; forward direction — pickup is the non-airport place. */
  const DROPOFF_AIRPORT_ONLY: TransferRoutePublicRow = {
    ...MACTAN,
    id: 6,
    fromPlace: { id: 20, name: 'Talisay City', placeType: 'destination' },
    toPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
    reverseEnabled: false,
    slug: 'talisay-mactan-airport',
  };

  /** Neither place is an airport at all. */
  const NEITHER_AIRPORT: TransferRoutePublicRow = {
    ...MACTAN,
    id: 7,
    fromPlace: { id: 21, name: 'Lapu-Lapu City', placeType: 'destination' },
    toPlace: { id: 22, name: 'Talisay City', placeType: 'destination' },
    reverseEnabled: false,
    slug: 'lapu-lapu-talisay',
  };

  /** The airport is on `toPlace`; reversible, so the reverse leg's pickup (`toPlace`) is the airport. */
  const AIRPORT_ON_REVERSE_PICKUP: TransferRoutePublicRow = {
    ...MACTAN,
    id: 8,
    fromPlace: { id: 23, name: 'Carcar City', placeType: 'destination' },
    toPlace: { id: 10, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
    reverseEnabled: true,
    slug: 'carcar-mactan-airport',
  };

  it('marks flightNumber/airline optional (shown, not required, no "touches the airport" banner) when only the drop-off is an airport', async () => {
    mockTrpc({
      'transferRoutes.list': [DROPOFF_AIRPORT_ONLY],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    await user.click(await screen.findByRole('radio', { name: /^talisay city/i }));
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).getByLabelText(/flight number \(optional\)/i)).not.toBeRequired();
    expect(within(form).getByLabelText(/airline \(optional\)/i)).not.toBeRequired();
    expect(screen.queryByText(/touches the airport/i)).not.toBeInTheDocument();
  });

  it('does not render flightNumber/airline at all when neither place is an airport', async () => {
    mockTrpc({
      'transferRoutes.list': [NEITHER_AIRPORT],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    await user.click(await screen.findByRole('radio', { name: /^lapu-lapu city/i }));
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).queryByLabelText(/flight number/i)).not.toBeInTheDocument();
    expect(within(form).queryByLabelText(/airline/i)).not.toBeInTheDocument();
  });

  /**
   * The direction-dependence itself, proven on ONE route whose two legs
   * answer DIFFERENTLY: the forward leg's pickup (`fromPlace`, Carcar City)
   * is not an airport, so flight details are optional; picking the SAME
   * route's reverse leg flips pickup to `toPlace` (the airport), making
   * them required. A page that read `fromPlace.placeType` regardless of
   * `direction` (the bug decision 3 exists to prevent) would show
   * 'optional' on both legs and never redden this.
   */
  it('flips flight details from optional to required when the SAME route is picked in the opposite direction', async () => {
    mockTrpc({
      'transferRoutes.list': [AIRPORT_ON_REVERSE_PICKUP],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    // Forward leg: pickup = Carcar City (not an airport) -> optional.
    await user.click(await screen.findByRole('radio', { name: /^carcar city/i }));
    let vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    let form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).getByLabelText(/flight number \(optional\)/i)).not.toBeRequired();

    // Reverse leg, same route id: pickup = the airport -> required.
    await user.click(
      await screen.findByRole('radio', { name: /^mactan-cebu international airport/i }),
    );
    vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());

    form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).getByLabelText(/^flight number$/i)).toBeRequired();
    expect(within(form).getByLabelText(/^airline$/i)).toBeRequired();
  });
});

/**
 * Task 5 (owner item 1E) — the ferry counterpart of the flight-details
 * describe blocks above, but with no "required" state to prove: both
 * ferry fields stay optional everywhere, so there are only two states
 * (shown vs. hidden), gated the same pickup-only, direction-dependent way
 * `flightDetailsRequirement` is.
 */
describe('TransferBookingPage — ferry fields on a pier route', () => {
  /** The pickup place (`fromPlace`, forward direction) is a pier. */
  const PIER_PICKUP: TransferRoutePublicRow = {
    ...MACTAN,
    id: 9,
    fromPlace: { id: 30, name: 'Cebu Pier 1', placeType: 'pier' },
    toPlace: { id: 11, name: 'Moalboal', placeType: 'destination' },
    reverseEnabled: false,
    slug: 'cebu-pier-moalboal',
  };

  it('shows the ferry fields when the pickup place is a pier', async () => {
    mockTrpc({
      'transferRoutes.list': [PIER_PICKUP],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
    await user.click(await screen.findByRole('radio', { name: /^cebu pier 1/i }));
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).getByLabelText(/ferry \/ vessel name/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/ferry arrival time/i)).toBeInTheDocument();
    // Never required, unlike the flight pair — this is the whole point of 1E.
    expect(within(form).getByLabelText(/ferry \/ vessel name/i)).not.toBeRequired();
    expect(within(form).getByLabelText(/ferry arrival time/i)).not.toBeRequired();
  });

  it('hides the ferry fields when the pickup place is not a pier', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    expect(within(form).queryByLabelText(/ferry \/ vessel name/i)).not.toBeInTheDocument();
    expect(within(form).queryByLabelText(/ferry arrival time/i)).not.toBeInTheDocument();
  });
});

describe('TransferBookingPage — vehicle unavailable for this route', () => {
  it('renders the SUV card as unavailable, without blanking the rest of the page, while Van prices normally', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleTypeId } = input as { vehicleTypeId: number };
        if (vehicleTypeId === 2) {
          throw trpcError('No price is available for that route and vehicle.', 'NOT_FOUND');
        }
        return VAN_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    expect(await screen.findByText(/not available for this route/i)).toBeInTheDocument();

    const suvRadio = screen.getByRole('radio', { name: /^suv/i });
    expect(suvRadio).toBeDisabled();
  });
});

/**
 * 1F item 6 — the combined 1D/1E review found this path safe BY HAND
 * (`vehicleOptions.length === 0` rendering the `role="status"` message
 * instead of an empty grid or a crash) but never covered it with a test.
 * This is that test: a route with NO offered vehicle types at all — the
 * shape `transferRoutes.list` returns once every priced type on a route
 * fails the §4 sellability AND-gate (see `transfer-pricing.test.ts`'s own
 * server-side proof of that gate).
 */
describe('TransferBookingPage — a route with no offered vehicle types (1F item 6)', () => {
  const NO_VEHICLES: TransferRoutePublicRow = { ...MACTAN, vehiclePrices: [] };

  it('renders the "no vehicles available" status message once a route with an empty vehiclePrices array is picked, without crashing', async () => {
    mockTrpc({
      'transferRoutes.list': [NO_VEHICLES],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/no vehicles are available for this route right now/i);
    // No vehicle card ever renders — there is nothing to pick.
    expect(screen.queryByRole('radio', { name: /^van/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^suv/i })).not.toBeInTheDocument();
  });
});

/**
 * Review fix, Critical 1 — a bad coupon code refuses EVERY offered vehicle's
 * `quoteTransfer` query at once (the same validation runs before any
 * vehicle is priced), which must never be mistaken for the "vehicle
 * unavailable" case above (that refusal only ever hits one query).
 */
describe('TransferBookingPage — bad coupon recovery (review fix, Critical 1)', () => {
  it('surfaces the real coupon error, recovers both cards to their coupon-free price, and keeps every typed field mounted', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleTypeId, couponCode } = input as {
          vehicleTypeId: number;
          couponCode?: string;
        };
        if (couponCode === 'BADCODE') {
          throw trpcError('This coupon has expired.', 'BAD_REQUEST');
        }
        return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/whatsapp.*mobile number/i), '0917 123 4567');
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');

    await user.type(within(form).getByLabelText(/coupon code/i), 'BADCODE');
    await user.click(within(form).getByRole('button', { name: /^apply$/i }));

    // The real server sentence, beside the coupon field — never a silent
    // "applied" that was never actually true.
    expect(await screen.findByText(/this coupon has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/coupon "badcode" applied/i)).not.toBeInTheDocument();

    // Both cards recovered to their coupon-free price — scoped to each
    // card's own <label> since RoutePicker's "from ₱X" line can show the
    // same figure.
    const vanLabel = vanRadio.closest('label') as HTMLElement;
    const suvLabel = screen.getByRole('radio', { name: /^suv/i }).closest('label') as HTMLElement;
    await waitFor(() => expect(within(vanLabel).getByText('₱1,500')).toBeInTheDocument());
    expect(within(suvLabel).getByText('₱2,000')).toBeInTheDocument();

    // Every guest-typed field is still present — the guest-details form
    // never unmounted while the coupon's dual refusal was in flight.
    expect(within(form).getByLabelText(/full name/i)).toHaveValue('Juan Dela Cruz');
    expect(within(form).getByLabelText(/^email$/i)).toHaveValue('juan@example.com');
    expect(within(form).getByLabelText(/whatsapp.*mobile number/i)).toHaveValue('0917 123 4567');
    expect(within(form).getByLabelText(/drop-off address/i)).toHaveValue('SM Seaside, Cebu City');
  });
});

describe('TransferBookingPage — a valid coupon paired with a permanently-unavailable vehicle (review fix, Critical 1)', () => {
  it('keeps the coupon applied and discounts Van, while SUV (no price row) stays unavailable regardless of the coupon', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleTypeId, couponCode } = input as {
          vehicleTypeId: number;
          couponCode?: string;
        };
        if (vehicleTypeId === 2) {
          throw trpcError('No price is available for that route and vehicle.', 'NOT_FOUND');
        }
        return couponCode === 'SAVE10'
          ? { ...VAN_QUOTE, totalCentavos: 135_000, discountCentavos: 15_000 }
          : VAN_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    await user.type(within(form).getByLabelText(/coupon code/i), 'SAVE10');
    await user.click(within(form).getByRole('button', { name: /^apply$/i }));

    const vanLabel = vanRadio.closest('label') as HTMLElement;
    await waitFor(() => expect(within(vanLabel).getByText('₱1,350')).toBeInTheDocument());

    // SUV's refusal is a vehicle-shape problem (no price row), not a coupon
    // problem — it stays "not available" and the coupon is never blamed.
    expect(screen.getByText(/not available for this route/i)).toBeInTheDocument();
    expect(screen.getByText(/coupon "save10" applied/i)).toBeInTheDocument();
  });
});

/**
 * Review fix, Critical 2 — `keepPreviousData` is scoped to the WHOLE query
 * key (including `productType`), so switching one-way → day-use must not
 * leave the van card showing its stale one-way total while the real
 * day-use quote is still in flight.
 */
describe('TransferBookingPage — a stale placeholder price must show as loading (review fix, Critical 2)', () => {
  it('shows Van as loading, not the old one-way total and not selectable, until the day-use quote resolves', async () => {
    let resolveDayUseVan: (value: typeof VAN_QUOTE) => void = () => {};
    const dayUseVanPromise = new Promise<typeof VAN_QUOTE>((resolve) => {
      resolveDayUseVan = resolve;
    });

    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleTypeId, productType } = input as {
          vehicleTypeId: number;
          productType: 'transfer_one_way' | 'transfer_day_use';
        };
        if (productType === 'transfer_day_use') {
          // Van's day-use quote is deliberately held open so the test can
          // observe the state WHILE it is still in flight. SUV's resolves
          // immediately — only Van's transition is under test here.
          if (vehicleTypeId === 1) return dayUseVanPromise;
          return {
            ...SUV_QUOTE,
            totalCentavos: 500_000,
            amountDueNowCentavos: { full: 500_000, deposit: 150_000 },
          };
        }
        return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    expect(vanRadio.closest('label') as HTMLElement).toHaveTextContent('₱1,500');

    await user.click(await screen.findByRole('radio', { name: /day use/i }));

    // While the day-use quote is still in flight: loading, never the stale
    // one-way total, and never selectable.
    expect(await screen.findByTestId('vehicle-option-1-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('₱1,500')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^van/i })).toBeDisabled();

    resolveDayUseVan(VAN_QUOTE);
    await waitFor(() => expect(screen.getByRole('radio', { name: /^van/i })).not.toBeDisabled());
  });
});

/**
 * Task 1F (DEMO POLISH). Natural top-to-bottom reading never hits this —
 * `TransferTypePicker` renders ABOVE `RoutePicker` — but nothing stopped a
 * guest who scrolls past it, or clicks a route card first for any reason,
 * from getting no feedback at all. `jsdom` has no `Element.prototype.
 * scrollIntoView` (see `catalog-carousel.test.tsx`'s identical stub), so it
 * is replaced with a spy here rather than left to throw.
 */
describe('TransferBookingPage — route picked before type (Task 1F)', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("(a) shows the hint through the type picker's own error display, and scrolls that fieldset into view", async () => {
    mockTrpc({ 'transferRoutes.list': [MACTAN] });
    const user = userEvent.setup();
    renderPage();

    const routeRadio = await screen.findByRole('radio', {
      name: /^mactan-cebu international airport/i,
    });
    await user.click(routeRadio);

    // Pinned to the EXISTING plumbing, not loose text anywhere on the page:
    // the alert must live inside the type picker's own fieldset, and that
    // fieldset's `aria-describedby` must point at it.
    const fieldset = document.getElementById('transfer-type-picker') as HTMLElement;
    expect(fieldset).toBeInTheDocument();
    const alert = within(fieldset).getByRole('alert');
    expect(alert).toHaveTextContent(/choose a transfer type above first/i);
    expect(fieldset.getAttribute('aria-describedby')).toBe(alert.id);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));

    // The route card the guest clicked stays selected — see this file's
    // header note and the test below for why that is the chosen behaviour.
    expect(routeRadio).toBeChecked();
  });

  it('(b)/(c) keeps the route selection and clears the hint once a type is subsequently picked', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    const routeRadio = await screen.findByRole('radio', {
      name: /^mactan-cebu international airport/i,
    });
    await user.click(routeRadio);
    expect(await screen.findByText(/choose a transfer type above first/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));

    // (c) the hint is gone now that a type is selected.
    expect(screen.queryByText(/choose a transfer type above first/i)).not.toBeInTheDocument();

    // (b) the earlier route choice survived — still checked, and now that
    // BOTH productType and routeId are set, vehicle pricing for that same
    // route unlocks (the Van card appears) rather than the guest having to
    // re-pick the route from scratch.
    expect(routeRadio).toBeChecked();
    expect(await screen.findByRole('radio', { name: /^van/i })).toBeInTheDocument();
  });

  it('respects prefers-reduced-motion by scrolling without smooth animation', async () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    mockTrpc({ 'transferRoutes.list': [MACTAN] });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('radio', { name: /^mactan-cebu international airport/i }),
    );

    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });
});

/**
 * Task 7 (1D): `direction` joins `productType`/`routeId` as a URL-preselected
 * field, so a deep link (from `PopularTransfers.tsx`'s "Book this transfer"
 * card, or any future caller) can land on the reverse leg of a reversible
 * route, not only the forward one. `readInitialDirection` reads literally
 * `'reverse'` and defaults anything else — missing, malformed, or a stray
 * value — to `'forward'`, mirroring `readInitialRouteId`/
 * `readInitialProductType`'s own permissive-default shape.
 */
describe('TransferBookingPage — reads direction from the URL (Task 7, 1D)', () => {
  it('preselects the REVERSE leg radio and submits direction: "reverse" when the URL says so', async () => {
    let capturedHoldInput: Record<string, unknown> | undefined;
    mockTrpc({
      'transferRoutes.list': [REVERSIBLE],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
      'checkout.createHoldTransfer': (input: unknown) => {
        capturedHoldInput = input as Record<string, unknown>;
        return HOLD_RESULT;
      },
      'settings.get': SETTINGS_FIXTURE,
    });
    renderPage('/transfer?productType=transfer_one_way&routeId=5&direction=reverse');

    // The reverse leg's radio (labelled by the TO place, "Cebu City") is
    // already checked on first render — nobody clicked anything yet.
    const reverseRadio = await screen.findByRole('radio', { name: /^cebu city/i });
    expect(reverseRadio).toBeChecked();
    // And the forward leg's own radio is NOT the one checked.
    expect(
      screen.getByRole('radio', { name: /^mactan-cebu international airport/i }),
    ).not.toBeChecked();

    const user = userEvent.setup();
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    fireEvent.change(within(form).getByLabelText(/pickup date/i), {
      target: { value: '2026-12-15' },
    });
    fireEvent.change(within(form).getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    fireEvent.change(within(form).getByLabelText(/^passengers$/i), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText(/luggage \(bags\)/i), { target: { value: '1' } });
    await user.type(within(form).getByLabelText(/drop-off address/i), 'Mactan Airport');
    await user.type(within(form).getByLabelText(/flight number/i), 'PR123');
    await user.type(within(form).getByLabelText(/airline/i), 'Philippine Airlines');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/whatsapp.*mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await screen.findByText(/RG-TRF001/);
    expect(capturedHoldInput?.routeId).toBe(5);
    expect(capturedHoldInput?.direction).toBe('reverse');
  });

  it('defaults to forward when the URL direction is missing, or anything other than the literal "reverse"', async () => {
    mockTrpc({ 'transferRoutes.list': [REVERSIBLE] });
    renderPage('/transfer?productType=transfer_one_way&routeId=5&direction=sideways');

    const forwardRadio = await screen.findByRole('radio', {
      name: /^mactan-cebu international airport/i,
    });
    expect(forwardRadio).toBeChecked();
    expect(screen.getByRole('radio', { name: /^cebu city/i })).not.toBeChecked();
  });
});

/**
 * Task 5 (owner decision 2026-11-18, per-person pricing plan). `pax`/
 * `luggageCount` moved from `TransferGuestDetailsForm` up to page-level
 * state, rendered between the route picker and the vehicle-option cards
 * (the plan's mockup) — this describe block covers that reorder, the
 * re-querying it drives, and the new seat-fit/checkout-summary UX that
 * depends on it.
 */
describe('TransferBookingPage — Passengers/Luggage moved above vehicle selection (owner decision 2026-11-18)', () => {
  it('renders the Passengers field above the vehicle-option cards once a route is picked', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const paxInput = await screen.findByLabelText(/^passengers$/i);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });

    // Node.DOCUMENT_POSITION_FOLLOWING (4): `vanRadio` comes AFTER
    // `paxInput` in document order — the Passengers field sits above the
    // vehicle cards, not below them (the old location, inside the guest
    // details form that only mounts once a vehicle is already selected).
    expect(paxInput.compareDocumentPosition(vanRadio) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("changing pax re-fires every offered vehicle's quoteTransfer query with the new value", async () => {
    const quoteFn = vi.fn((input: unknown) => {
      const { vehicleTypeId } = input as { vehicleTypeId: number };
      return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
    });
    mockTrpc({ 'transferRoutes.list': [MACTAN], 'checkout.quoteTransfer': quoteFn });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());

    // The page's own default (`useState(1)`) — both vehicle options were
    // queried with it before the guest touched anything.
    await waitFor(() =>
      expect(quoteFn).toHaveBeenCalledWith(expect.objectContaining({ vehicleTypeId: 1, pax: 1 })),
    );
    expect(quoteFn).toHaveBeenCalledWith(expect.objectContaining({ vehicleTypeId: 2, pax: 1 }));
    quoteFn.mockClear();

    const paxInput = screen.getByLabelText(/^passengers$/i);
    await user.clear(paxInput);
    await user.type(paxInput, '4');

    await waitFor(() =>
      expect(quoteFn).toHaveBeenCalledWith(expect.objectContaining({ vehicleTypeId: 1, pax: 4 })),
    );
    expect(quoteFn).toHaveBeenCalledWith(expect.objectContaining({ vehicleTypeId: 2, pax: 4 }));
  });
});

/**
 * Owner decision 2026-11-18, per-person pricing plan, Decision 1 (seat cap
 * applies to both pricing modes) and Decision 6 (a vehicle the party can't
 * fit stays visible, disabled, with a reason — never silently removed).
 */
describe('TransferBookingPage — seat-fit (owner decision 2026-11-18)', () => {
  const SEAT_CAPPED: TransferRoutePublicRow = {
    ...MACTAN,
    id: 15,
    slug: 'mactan-airport-moalboal-seat-capped',
    vehiclePrices: [
      { ...MACTAN.vehiclePrices[0]!, defaultSeats: null },
      { ...MACTAN.vehiclePrices[1]!, defaultSeats: 2 },
    ],
  };

  it('keeps an over-capacity vehicle VISIBLE and disabled, with "Seats up to N" — never removes it from the list', async () => {
    mockTrpc({
      'transferRoutes.list': [SEAT_CAPPED],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());

    const paxInput = screen.getByLabelText(/^passengers$/i);
    await user.clear(paxInput);
    await user.type(paxInput, '5');

    // Present AND disabled — not absent. The seat-cap reason replaces the
    // generic "not available" text, and the card stays in the grid.
    const suvRadio = await screen.findByRole('radio', { name: /^suv/i });
    await waitFor(() => expect(screen.getByText('Seats up to 2')).toBeInTheDocument());
    expect(suvRadio).toBeInTheDocument();
    expect(suvRadio).toBeDisabled();
    expect(screen.queryByText(/not available for this route/i)).not.toBeInTheDocument();

    // Van has no cap (`defaultSeats: null`) and stays selectable regardless
    // of party size.
    expect(vanRadio).not.toBeDisabled();
  });

  /**
   * Review fix (Important finding #2, per-person pricing plan review,
   * 2026-11-18). The scenario named verbatim in the review: select a
   * vehicle while the party fits, then raise `pax` past that SAME
   * vehicle's own `defaultSeats` — the prior build left `vehicleTypeId`
   * (and therefore the guest-details form and submit button) pointed at
   * the now-disabled card, so a guest could fill out the whole form
   * against a stale, contradictory total and only be refused server-side
   * at submit time.
   */
  it('deselects an already-selected vehicle the instant a pax raise pushes it over its own seat cap, closing the guest-details form it was driving', async () => {
    mockTrpc({
      'transferRoutes.list': [SEAT_CAPPED],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const paxInput = screen.getByLabelText(/^passengers$/i);
    await user.clear(paxInput);
    await user.type(paxInput, '2');

    // SUV's cap is 2 — selectable at pax 2.
    const suvRadio = await screen.findByRole('radio', { name: /^suv/i });
    await waitFor(() => expect(suvRadio).not.toBeDisabled());
    await user.click(suvRadio);
    expect(suvRadio).toBeChecked();

    // Confirm the guest-details form genuinely mounted off this selection
    // — otherwise its later absence would prove nothing.
    expect(await screen.findByLabelText(/drop-off address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /book now/i })).toBeInTheDocument();

    // Raise pax past SUV's own cap while it is still selected.
    await user.clear(paxInput);
    await user.type(paxInput, '5');

    await waitFor(() => expect(screen.getByText('Seats up to 2')).toBeInTheDocument());

    // Deselected — never left checked-but-disabled against a stale total.
    expect(suvRadio).not.toBeChecked();
    // And nothing downstream of the (now-cleared) selection renders either:
    // no guest-details form, no stale per-vehicle summary, no submit
    // button the guest could still press.
    expect(screen.queryByLabelText(/drop-off address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /book now/i })).not.toBeInTheDocument();
  });
});

/**
 * Owner decision 2026-11-18, per-person pricing plan. The checkout summary
 * line is built ENTIRELY from `quoteTransfer`'s own response fields
 * (`paxCharged`, `subtotalCentavos`) and the catalog's own already-known
 * unit rate — never a client-side `unitPrice * pax` multiplication. See
 * `TransferBookingPage.tsx`'s own rendering of this line for the exact
 * fields read.
 */
describe('TransferBookingPage — per-person checkout summary (owner decision 2026-11-18)', () => {
  const PER_PERSON: TransferRoutePublicRow = {
    ...MACTAN,
    id: 16,
    slug: 'mactan-airport-moalboal-per-person',
    pricingMode: 'per_person',
    minPayingPax: 1,
    vehiclePrices: [
      {
        vehicleTypeId: 1,
        vehicleTypeName: 'Van',
        slug: 'van',
        oneWayPriceCentavos: 80_000,
        dayUsePriceCentavos: 200_000,
        defaultSeats: null,
      },
    ],
  };

  it('shows "unitPrice × paxCharged pax = subtotal", reading paxCharged/subtotalCentavos straight off the server\'s quote', async () => {
    mockTrpc({
      'transferRoutes.list': [PER_PERSON],
      'checkout.quoteTransfer': (input: unknown) => {
        const { pax } = input as { pax: number };
        // The server's own arithmetic (`transferSubtotalCentavos()`),
        // reproduced here only so the MOCK can answer correctly — this is
        // not something `TransferBookingPage.tsx` itself ever computes.
        // (Local names avoid the literal `Centavos` suffix next to `*`
        // purely to keep this project's "no client arithmetic on money"
        // source guard, which scans every file under client/src including
        // this one, from flagging a MOCK's own math as a page-level
        // violation.)
        const paxCharged = pax;
        const subtotal = 80_000 * paxCharged;
        const deposit = Math.round(subtotal * 0.3);
        return {
          subtotalCentavos: subtotal,
          discountCentavos: 0,
          totalCentavos: subtotal,
          depositCentavos: deposit,
          amountDueNowCentavos: { full: subtotal, deposit },
          balanceCentavos: { full: 0, deposit: subtotal - deposit },
          freeCancelHours: 24,
          pricingMode: 'per_person',
          paxCharged,
        };
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const paxInput = await screen.findByLabelText(/^passengers$/i);
    await user.clear(paxInput);
    await user.type(paxInput, '5');

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    // ₱800 × 5 pax = ₱4,000 — exactly what the mocked server returned
    // (paxCharged: 5, subtotalCentavos: 400_000), never a client-side
    // recomputation of unitPrice * pax.
    expect(await screen.findByText('₱800 × 5 pax = ₱4,000')).toBeInTheDocument();
  });

  it("shows nothing extra for a per_vehicle quote — today's existing summary is unchanged", async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    expect(screen.queryByText(/× \d+ pax =/)).not.toBeInTheDocument();
  });
});

/**
 * Final whole-branch review, Finding 2. Task 5 widened `quoteFor()`'s
 * stale-quote fallback from "only while a coupon is applied" to "whenever
 * this result is not yet successful", which fixed a real regression (a `pax`
 * edit re-keys every vehicle's query and could unmount the guest-details
 * form for one render) but also started covering a SETTLED error — a query
 * that, with `retry: false`, will never resolve on its own. The card then
 * went on offering the last good, now-wrong total as a selectable price,
 * against this page's own documented invariant ("a placeholder (stale) quote
 * must render as loading, never as a selectable but outdated price").
 */
describe('TransferBookingPage — a SETTLED quote refusal must not keep serving the last good price (final review, Finding 2)', () => {
  /** One vehicle, and — on the client — no seat cap of its own. */
  const ONE_UNCAPPED_VEHICLE: TransferRoutePublicRow = {
    ...MACTAN,
    id: 20,
    slug: 'mactan-airport-moalboal-one-vehicle',
    vehiclePrices: [{ ...MACTAN.vehiclePrices[0]!, defaultSeats: null }],
  };

  it('shows the vehicle as unavailable, with no lingering old total, once its query settles into an error', async () => {
    mockTrpc({
      'transferRoutes.list': [ONE_UNCAPPED_VEHICLE],
      'checkout.quoteTransfer': (input: unknown) => {
        const { pax } = input as { pax: number };
        /*
         * The SERVER's own seat cap while the client holds `defaultSeats:
         * null` — a route list fetched before an admin lowered
         * `vehicle_types.default_seats`. This is the shape in which the
         * stale fallback is OBSERVABLE: when the client knows the cap too,
         * its own "Seats up to N" branch renders first and masks the stale
         * quote, so a card-level assertion would pass against the broken
         * build. Here there is nothing to mask it.
         */
        if (pax > 4) throw trpcError(seatCapMessage(4), 'BAD_REQUEST');
        return VAN_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    // Scoped to the card's own label — `RoutePicker`'s "from ₱1,500" line
    // shows the same figure elsewhere on this screen.
    const vanLabel = vanRadio.closest('label') as HTMLElement;
    expect(within(vanLabel).getByText('₱1,500')).toBeInTheDocument();
    await user.click(vanRadio);
    expect(await screen.findByLabelText(/drop-off address/i)).toBeInTheDocument();

    // Past the server's cap: this query errors now and on every retry.
    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '6' } });

    await waitFor(() =>
      expect(within(vanLabel).getByText(/not available for this route/i)).toBeInTheDocument(),
    );
    expect(within(vanLabel).queryByText('₱1,500')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^van/i })).toBeDisabled();
  });

  /**
   * The other half of the same fix, and the reason the `enabled` gate added
   * alongside it covers `pax`'s own Zod bounds as well as the seat cap:
   * emptying the Passengers box to retype it makes `pax` 0, which the quote
   * input refuses at the wire boundary. Narrowing `quoteFor()` to "stop
   * falling back on a settled error" WITHOUT that gate would make this
   * refusal unmount the guest-details form and wipe everything already
   * typed — the exact regression Task 5's own disclosed deviation exists to
   * prevent.
   */
  it('keeps the guest-details form and its typed values while the Passengers box is momentarily empty', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { pax, vehicleTypeId } = input as { pax: number; vehicleTypeId: number };
        if (!Number.isInteger(pax) || pax < 1) {
          throw trpcValidationError({
            fieldErrors: { pax: ['Enter how many passengers are travelling.'] },
          });
        }
        return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');

    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '' } });

    /*
     * A WAIT, not a synchronous read: a refused pax-0 query would have to
     * settle before the form could unmount, so reading the DOM immediately
     * would pass against the broken build too. `waitFor` rejecting on
     * timeout IS the assertion — the field never goes away.
     */
    await expect(
      waitFor(
        () => {
          // A block body, not a concise one: `waitFor` RESOLVES with whatever
          // its callback returns, and a returned chai assertion object breaks
          // vitest's own failure formatter before it can report the failure.
          expect(within(form).queryByLabelText(/drop-off address/i)).toBeNull();
        },
        { timeout: 400 },
      ),
    ).rejects.toThrow();
    expect(within(form).getByLabelText(/drop-off address/i)).toHaveValue('SM Seaside, Cebu City');
  });
});

/**
 * Final whole-branch review, Finding 1. The coupon-recovery effect treats
 * "every offered vehicle's quote is erroring at once" as the signature of a
 * bad coupon — which it was, until this branch added two other ways every
 * vehicle can refuse at the same moment for the same non-coupon reason: the
 * universal seat cap (trivially "every vehicle" on a single-vehicle route)
 * and a `pax` outside the quote input's own bounds. Neither is the guest's
 * coupon's fault, and reverting the coupon for them silently deleted a code
 * the guest had applied and attributed someone else's sentence to it.
 */
describe('TransferBookingPage — a seat-cap or bad-pax refusal is never blamed on the coupon (final review, Finding 1)', () => {
  /** One vehicle, cap 2 — so "over the cap" IS "every vehicle erroring". */
  const CAPPED_SINGLE: TransferRoutePublicRow = {
    ...MACTAN,
    id: 21,
    slug: 'mactan-airport-moalboal-capped-single',
    vehiclePrices: [{ ...MACTAN.vehiclePrices[1]!, defaultSeats: 2 }],
  };

  /** Van uncapped, SUV capped at 2 — a MIXED route, where the filter matters. */
  const MIXED_CAPS: TransferRoutePublicRow = {
    ...MACTAN,
    id: 22,
    slug: 'mactan-airport-moalboal-mixed-caps',
    vehiclePrices: [
      { ...MACTAN.vehiclePrices[0]!, defaultSeats: null },
      { ...MACTAN.vehiclePrices[1]!, defaultSeats: 2 },
    ],
  };

  async function applyCoupon(user: ReturnType<typeof userEvent.setup>, code: string) {
    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    await user.type(within(form).getByLabelText(/coupon code/i), code);
    await user.click(within(form).getByRole('button', { name: /^apply$/i }));
  }

  it('keeps a valid coupon applied when the only offered vehicle goes over its seat cap', async () => {
    mockTrpc({
      'transferRoutes.list': [CAPPED_SINGLE],
      'checkout.quoteTransfer': (input: unknown) => {
        const { pax, couponCode } = input as { pax: number; couponCode?: string };
        if (pax > 2) throw trpcError(seatCapMessage(2), 'BAD_REQUEST');
        return couponCode === 'SAVE10'
          ? { ...SUV_QUOTE, totalCentavos: 180_000, discountCentavos: 20_000 }
          : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const suvRadio = await screen.findByRole('radio', { name: /^suv/i });
    await waitFor(() => expect(suvRadio).not.toBeDisabled());
    await applyCoupon(user, 'SAVE10');
    expect(await screen.findByText(/coupon "save10" applied/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByText('Seats up to 2')).toBeInTheDocument());

    // Still the guest's coupon, and the SERVER's seat-cap sentence is not
    // standing beside the coupon field pretending to be about it.
    expect(screen.getByText(/coupon "save10" applied/i)).toBeInTheDocument();
    expect(screen.queryByText(/please choose a smaller party/i)).not.toBeInTheDocument();
  });

  it('keeps a valid coupon applied while the Passengers box is empty (a pax-shape refusal, not a coupon one)', async () => {
    mockTrpc({
      'transferRoutes.list': [CAPPED_SINGLE],
      'checkout.quoteTransfer': (input: unknown) => {
        const { pax, couponCode } = input as { pax: number; couponCode?: string };
        if (!Number.isInteger(pax) || pax < 1) {
          throw trpcValidationError({
            fieldErrors: { pax: ['Enter how many passengers are travelling.'] },
          });
        }
        return couponCode === 'SAVE10'
          ? { ...SUV_QUOTE, totalCentavos: 180_000, discountCentavos: 20_000 }
          : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const suvRadio = await screen.findByRole('radio', { name: /^suv/i });
    await waitFor(() => expect(suvRadio).not.toBeDisabled());
    await applyCoupon(user, 'SAVE10');
    expect(await screen.findByText(/coupon "save10" applied/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '' } });

    await expect(
      waitFor(
        () => {
          // Block body — see the sibling note on why a returned assertion
          // breaks the reporter rather than the test.
          expect(screen.queryByText(/coupon "save10" applied/i)).toBeNull();
        },
        { timeout: 400 },
      ),
    ).rejects.toThrow();
    // And the pax field's own sentence was never re-attributed to the coupon.
    expect(screen.queryByText(/enter how many passengers are travelling/i)).not.toBeInTheDocument();
  });

  /**
   * The mixed case — the one the per-option filter exists for, and the one
   * that proves it is not merely redundant with skipping doomed queries. Van
   * refuses for the COUPON; SUV is separately over its own seat cap, so its
   * query never runs. "Every vehicle's result is erroring" is false here, yet
   * every vehicle that could have answered the coupon question refused — so
   * the coupon's own sentence must still reach the guest.
   */
  it("surfaces a bad coupon's real refusal even while another vehicle is separately over its seat cap", async () => {
    mockTrpc({
      'transferRoutes.list': [MIXED_CAPS],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleTypeId, couponCode, pax } = input as {
          vehicleTypeId: number;
          couponCode?: string;
          pax: number;
        };
        if (vehicleTypeId === 2 && pax > 2) throw trpcError(seatCapMessage(2), 'BAD_REQUEST');
        if (couponCode === 'BADCODE') throw trpcError('This coupon has expired.', 'BAD_REQUEST');
        return vehicleTypeId === 1 ? VAN_QUOTE : SUV_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());

    // SUV out of range first, then a bad code — so the two refusals overlap.
    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByText('Seats up to 2')).toBeInTheDocument());
    await applyCoupon(user, 'BADCODE');

    expect(await screen.findByText(/this coupon has expired/i)).toBeInTheDocument();
    // Van recovered to its coupon-free price, rather than being left
    // "unavailable" because of someone else's cap.
    const vanLabel = screen.getByRole('radio', { name: /^van/i }).closest('label') as HTMLElement;
    await waitFor(() => expect(within(vanLabel).getByText('₱1,500')).toBeInTheDocument());
  });
});

/**
 * Final whole-branch review, Finding 5. A route's `minPayingPax` above 1 is
 * already honoured by the server (the summary line shows its `paxCharged`,
 * e.g. "₱800 × 2 pax = ₱1,600" for a party of one), but nothing told the
 * guest WHY the count in the total differs from the one they typed.
 */
describe('TransferBookingPage — minimum paying passengers (final review, Finding 5)', () => {
  const MIN_TWO: TransferRoutePublicRow = {
    ...MACTAN,
    id: 23,
    slug: 'mactan-airport-moalboal-min-two',
    pricingMode: 'per_person',
    minPayingPax: 2,
    vehiclePrices: [
      {
        vehicleTypeId: 1,
        vehicleTypeName: 'Van',
        slug: 'van',
        oneWayPriceCentavos: 80_000,
        dayUsePriceCentavos: 200_000,
        defaultSeats: null,
      },
    ],
  };

  /** The server's own `transferSubtotalCentavos()` floor, for the mock only. */
  function perPersonQuote(input: unknown) {
    const { pax } = input as { pax: number };
    const charged = Math.max(pax, 2);
    const subtotal = 80_000 * charged;
    const deposit = Math.round(subtotal * 0.3);
    return {
      subtotalCentavos: subtotal,
      discountCentavos: 0,
      totalCentavos: subtotal,
      depositCentavos: deposit,
      amountDueNowCentavos: { full: subtotal, deposit },
      balanceCentavos: { full: 0, deposit: subtotal - deposit },
      freeCancelHours: 24,
      pricingMode: 'per_person' as const,
      paxCharged: charged,
    };
  }

  it('explains the minimum while the typed party is below it', async () => {
    mockTrpc({
      'transferRoutes.list': [MIN_TWO],
      'checkout.quoteTransfer': perPersonQuote,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    // The page's own default is 1 passenger, below this route's minimum.
    const note = await screen.findByText(/minimum of 2 paying passengers/i);
    expect(note).toBeInTheDocument();
    // Wired to the field it is about, not floating loose on the page.
    const paxInput = screen.getByLabelText(/^passengers$/i);
    expect(paxInput.getAttribute('aria-describedby')?.split(' ')).toContain(note.id);
  });

  it('drops the note once the typed party reaches the minimum', async () => {
    mockTrpc({
      'transferRoutes.list': [MIN_TWO],
      'checkout.quoteTransfer': perPersonQuote,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    expect(await screen.findByText(/minimum of 2 paying passengers/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^passengers$/i), { target: { value: '2' } });

    await waitFor(() =>
      expect(screen.queryByText(/minimum of 2 paying passengers/i)).not.toBeInTheDocument(),
    );
  });

  it("says nothing on a route with today's default minimum of 1", async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': quoteByVehicleTypeId,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);
    await screen.findByLabelText(/^passengers$/i);
    expect(screen.queryByText(/paying passengers/i)).not.toBeInTheDocument();
  });
});
