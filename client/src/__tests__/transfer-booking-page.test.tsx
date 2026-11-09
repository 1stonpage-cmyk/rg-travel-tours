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
import type { TransferRoutePublicRow } from '@rg/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TransferBookingPage from '@/pages/public/TransferBookingPage';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, trpcError } from './helpers/mock-trpc';

const MACTAN: TransferRoutePublicRow = {
  id: 1,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
  toPlace: { id: 11, name: 'Moalboal', isAirport: false },
  reverseEnabled: false,
  slug: 'mactan-airport-moalboal',
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 150_000,
      dayUsePriceCentavos: 400_000,
    },
    {
      vehicleTypeId: 2,
      vehicleTypeName: 'SUV',
      slug: 'suv',
      oneWayPriceCentavos: 200_000,
      dayUsePriceCentavos: 500_000,
    },
  ],
};

/** A reversible route, used only by the direction test below. */
const REVERSIBLE: TransferRoutePublicRow = {
  ...MACTAN,
  id: 5,
  toPlace: { id: 13, name: 'Cebu City', isAirport: false },
  reverseEnabled: true,
  slug: 'mactan-cebu-city',
};

const VAN_QUOTE = {
  subtotalCentavos: 150_000,
  discountCentavos: 0,
  totalCentavos: 150_000,
  depositCentavos: 45_000,
  amountDueNowCentavos: { full: 150_000, deposit: 45_000 },
  balanceCentavos: { full: 0, deposit: 105_000 },
  freeCancelHours: 24,
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
    await user.clear(within(form).getByLabelText(/^passengers$/i));
    await user.type(within(form).getByLabelText(/^passengers$/i), '2');
    await user.clear(within(form).getByLabelText(/^bags$/i));
    await user.type(within(form).getByLabelText(/^bags$/i), '1');
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');
    // MACTAN's fromPlace is an airport, so flightNumber/airline are now
    // REQUIRED client-side (owner decision 2026-11-08, decision 5) — filled
    // in so the native `required` attribute does not block this submit.
    await user.type(within(form).getByLabelText(/^flight number$/i), 'PR123');
    await user.type(within(form).getByLabelText(/^airline$/i), 'Philippine Airlines');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
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
    await user.clear(within(form).getByLabelText(/^passengers$/i));
    await user.type(within(form).getByLabelText(/^passengers$/i), '2');
    await user.clear(within(form).getByLabelText(/^bags$/i));
    await user.type(within(form).getByLabelText(/^bags$/i), '1');
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
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
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
    fromPlace: { id: 20, name: 'Talisay City', isAirport: false },
    toPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
    reverseEnabled: false,
    slug: 'talisay-mactan-airport',
  };

  /** Neither place is an airport at all. */
  const NEITHER_AIRPORT: TransferRoutePublicRow = {
    ...MACTAN,
    id: 7,
    fromPlace: { id: 21, name: 'Lapu-Lapu City', isAirport: false },
    toPlace: { id: 22, name: 'Talisay City', isAirport: false },
    reverseEnabled: false,
    slug: 'lapu-lapu-talisay',
  };

  /** The airport is on `toPlace`; reversible, so the reverse leg's pickup (`toPlace`) is the airport. */
  const AIRPORT_ON_REVERSE_PICKUP: TransferRoutePublicRow = {
    ...MACTAN,
    id: 8,
    fromPlace: { id: 23, name: 'Carcar City', isAirport: false },
    toPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
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
   * them required. A page that read `fromPlace.isAirport` regardless of
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
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
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
    expect(within(form).getByLabelText(/mobile number/i)).toHaveValue('0917 123 4567');
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
