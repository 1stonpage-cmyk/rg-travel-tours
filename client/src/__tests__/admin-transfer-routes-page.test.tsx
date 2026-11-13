/**
 * The transfer-routes admin screen, rebuilt 2026-11-08 (owner decision:
 * flexible places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`) to replace the old
 * "one route per destination, van/SUV" shape. `admin.transferRoutes.*` is
 * `adminProcedure('toursPricing')` server-side — owner only; what is pinned
 * here is what the SCREEN itself promises: both places rendered for every
 * route, a price typed in pesos reaching the mutation as integer CENTAVOS,
 * and — the single most important behaviour on this screen — that saving a
 * route ALWAYS posts a COMPLETE price card keyed by every active vehicle
 * type's id, never a hand-trimmed subset (`shared/src/transfers-admin.ts`'s
 * own completeness contract).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminTransferRoutesPage from '@/pages/admin/AdminTransferRoutesPage';
import { TrpcProviders } from '@/lib/trpc';
import { pesosToCentavos } from '@/lib/money-input';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

/*
 * No Radix component is mounted directly by this page any more — both place
 * pickers are the plain-HTML `TransferPlaceCombobox`, and the vehicle-type
 * list is a flat set of rows, not a `Select`. No jsdom shim is needed here.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
});

const MACTAN_AIRPORT = {
  id: 10,
  name: 'Mactan-Cebu International Airport',
  placeType: 'airport',
  isActive: true,
  sortOrder: 0,
  destinationId: null,
  routeCount: 2,
};
const OSLOB = {
  id: 20,
  name: 'Oslob',
  placeType: 'destination',
  isActive: true,
  sortOrder: 1,
  destinationId: 5,
  routeCount: 1,
};
const CEBU_CITY = {
  id: 30,
  name: 'Cebu City',
  placeType: 'destination',
  isActive: false,
  sortOrder: 2,
  destinationId: 6,
  routeCount: 1,
};

const PLACES = [MACTAN_AIRPORT, OSLOB, CEBU_CITY];

const VAN_TYPE = {
  id: 1,
  name: 'Van',
  slug: 'van',
  defaultSeats: null,
  defaultLuggage: null,
  isActive: true,
  sortOrder: 0,
};
const SUV_TYPE = {
  id: 2,
  name: 'SUV',
  slug: 'suv',
  defaultSeats: null,
  defaultLuggage: null,
  isActive: true,
  sortOrder: 1,
};
const MPV_TYPE = {
  id: 3,
  name: 'MPV',
  slug: 'mpv',
  defaultSeats: null,
  defaultLuggage: null,
  isActive: false,
  sortOrder: 2,
};

const VEHICLE_TYPES = [VAN_TYPE, SUV_TYPE, MPV_TYPE];

const AIRPORT_OSLOB_ROUTE = {
  id: 1,
  fromPlace: {
    id: 10,
    name: 'Mactan-Cebu International Airport',
    placeType: 'airport',
    isActive: true,
  },
  toPlace: { id: 20, name: 'Oslob', placeType: 'destination', isActive: true },
  reverseEnabled: true,
  slug: 'mactan-oslob',
  isActive: true,
  sortOrder: 0,
  estimatedDurationMinutes: 150,
  freeCancelHours: 24,
  inclusionsText: 'Fuel, driver, tolls',
  exclusionsText: 'Meals',
  prices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      price: { oneWayPriceCentavos: 250_000, dayUsePriceCentavos: 500_000 },
    },
    {
      vehicleTypeId: 2,
      vehicleTypeName: 'SUV',
      slug: 'suv',
      price: { oneWayPriceCentavos: 300_000, dayUsePriceCentavos: 600_000 },
    },
  ],
};

const AIRPORT_CEBU_ROUTE = {
  id: 2,
  fromPlace: {
    id: 10,
    name: 'Mactan-Cebu International Airport',
    placeType: 'airport',
    isActive: true,
  },
  toPlace: { id: 30, name: 'Cebu City', placeType: 'destination', isActive: false },
  reverseEnabled: false,
  slug: 'mactan-cebu-city',
  isActive: true,
  sortOrder: 1,
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  prices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      price: { oneWayPriceCentavos: 120_000, dayUsePriceCentavos: 300_000 },
    },
    { vehicleTypeId: 2, vehicleTypeName: 'SUV', slug: 'suv', price: null },
  ],
};

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.transferPlaces.list': PLACES,
    'admin.vehicleTypes.list': VEHICLE_TYPES,
    'admin.transferRoutes.list': [AIRPORT_OSLOB_ROUTE, AIRPORT_CEBU_ROUTE],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminTransferRoutesPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

/** Opens the "Add a transfer route" form and waits for it to be on screen. */
async function openAddForm() {
  await user.click(await screen.findByRole('button', { name: /add a transfer route/i }));
  await screen.findByRole('button', { name: /^add route$/i });
}

/** Fills in a From/To combobox by typing a query and clicking the matching option. */
async function pickPlace(label: string, query: string, optionName: string) {
  const input = screen.getByLabelText(label);
  await user.click(input);
  await user.type(input, query);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

describe('AdminTransferRoutesPage', () => {
  it('renders every route, active and inactive, with both place names and a price summary', async () => {
    renderPage();
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);
    expect(
      screen.getAllByText(/Mactan-Cebu International Airport → Cebu City/).length,
    ).toBeGreaterThan(0);

    // Oslob route: both active types priced.
    expect(screen.getAllByText('2 of 2 vehicle types priced').length).toBeGreaterThan(0);
    // Cebu City route: only Van priced (SUV price is null).
    expect(screen.getAllByText('1 of 2 vehicle types priced').length).toBeGreaterThan(0);

    expect(screen.queryByText('250000')).toBeNull();
  });

  it('shows the amber inactive-place label only for the route whose place is retired', async () => {
    renderPage();
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);

    const labels = screen.getAllByTestId('inactive-place-label');
    // One per surface (phone card + table row) for the Cebu City route only.
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label).toHaveTextContent(/Cebu City is inactive — hidden from guests/);
    }

    // The Oslob route's own containers must carry no such label.
    const oslobContainers = screen
      .getAllByText(/Mactan-Cebu International Airport → Oslob/)
      .map((node) => node.closest('li') ?? node.closest('tr'));
    for (const container of oslobContainers) {
      expect(container).not.toBeNull();
      expect(within(container as HTMLElement).queryByTestId('inactive-place-label')).toBeNull();
    }
  });

  /**
   * **The most important test in this file.** The design note's own
   * completeness contract: a present `prices` object is read as the COMPLETE
   * replacement card. A trimmed card would silently un-offer a vehicle type
   * the admin never intended to touch. This proves the OUTER `prices` key
   * always carries one entry per ACTIVE vehicle type — SUV's blank boxes
   * must still produce an explicit `null`, not an absent key — on a plain
   * CREATE where only Van is priced.
   *
   * Provably able to fail: deleting the `for (const type of
   * activeVehicleTypes)` loop's `prices[key] = null` branch in
   * `AdminTransferRoutesPage.tsx` (so an untouched type's key is simply
   * omitted instead) makes this test red, because `prices` would then be
   * `{ "1": {...} }` with no `"2"` key at all rather than `"2": null`.
   */
  it('always posts a complete price card — every active vehicle type gets a key, blank ones get null', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);
    await openAddForm();

    await pickPlace('From place', 'Mactan', 'Mactan-Cebu International Airport');
    await pickPlace('To place', 'Oslob', 'Oslob');
    await user.type(screen.getByLabelText('Slug'), 'mactan-oslob-2');
    await user.clear(screen.getByLabelText('Duration — minutes'));
    await user.type(screen.getByLabelText('Duration — hours'), '2');
    await user.clear(screen.getByLabelText('Free cancellation window (hours)'));
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '24');
    // Only Van is priced — SUV's two boxes are left blank on purpose.
    await user.type(
      screen.getByLabelText('One-way (pesos)', { selector: '#route-price-1-oneway' }),
      '1500.00',
    );
    await user.type(
      screen.getByLabelText('Day-use (pesos)', { selector: '#route-price-1-dayuse' }),
      '3500.00',
    );

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as { prices: Record<string, unknown> };

    // Every ACTIVE type (Van id 1, SUV id 2) has a key. MPV (id 3, inactive)
    // never appears — it is not offered as a row on this screen at all.
    expect(Object.keys(payload.prices).sort()).toEqual(['1', '2']);
    expect(payload.prices['1']).toEqual({
      oneWayPriceCentavos: 150_000,
      dayUsePriceCentavos: 350_000,
    });
    expect(payload.prices['2']).toBeNull();
  });

  /**
   * The inverse of the test above, on an EDIT: a type that already has a
   * stored price and is left untouched must still be restated in full, not
   * dropped. This is what makes "every active type always has a key" safe —
   * it never means "forget what was already offered."
   */
  it('restates an untouched type’s stored price in full on an edit', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.update': (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    });
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);

    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);
    await screen.findByRole('button', { name: /save changes/i });

    // Change only the slug — never touch either price box.
    const slugInput = screen.getByLabelText('Slug');
    await user.clear(slugInput);
    await user.type(slugInput, 'mactan-oslob-renamed');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as { patch: { prices: Record<string, unknown> } };
    expect(payload.patch.prices['1']).toEqual({
      oneWayPriceCentavos: 250_000,
      dayUsePriceCentavos: 500_000,
    });
    expect(payload.patch.prices['2']).toEqual({
      oneWayPriceCentavos: 300_000,
      dayUsePriceCentavos: 600_000,
    });
  });

  /**
   * 0B (DEMO POLISH batch, 2026-11-09): proves a CHANGED price reaches the
   * mutation, not only an untouched one restated. 0B found the "Save
   * changes" button (`EntityForm`'s own submit button) rendering ABOVE the
   * "Prices per vehicle type" section — a real layout concern flagged
   * during read-only admin QA, the "no duplicate saves above content"
   * CLAUDE.md names for this exact screen — though `submit()` reads price
   * input state directly rather than serializing a DOM `<form>`, so the
   * button's visual position never affected correctness. B2 (same batch)
   * fixed the layout itself: `EntityForm`'s `hideSubmit` plus a
   * `FormActions` footer now place the one Save button AFTER the price
   * table, in a proper form footer (owner decision 1). This test still
   * exercises the same claim — a changed price reaches the payload — now
   * from the button's correct, post-table position.
   */
  it('a changed price typed into the edit form reaches the save payload, from the footer button below the price table', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.update': (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    });
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);

    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);
    const saveButton = await screen.findByRole('button', { name: /save changes/i });

    // Change the VAN's one-way price; leave its day-use and the SUV's whole
    // card untouched.
    const vanOneWay = screen.getByLabelText('One-way (pesos)', {
      selector: '#route-price-1-oneway',
    });
    await user.clear(vanOneWay);
    await user.type(vanOneWay, '2750.00');

    await user.click(saveButton);

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as { patch: { prices: Record<string, unknown> } };
    expect(payload.patch.prices['1']).toEqual({
      oneWayPriceCentavos: 275_000,
      dayUsePriceCentavos: 500_000,
    });
    expect(payload.patch.prices['2']).toEqual({
      oneWayPriceCentavos: 300_000,
      dayUsePriceCentavos: 600_000,
    });
  });

  /**
   * B2's actual layout fix, asserted directly: the Save button must sit
   * AFTER the price table in document order, not above it — the DOM
   * position is what "no duplicate saves above content" (CLAUDE.md) is
   * about, and the previous test proves only the payload, not the layout.
   */
  it('places the Save changes button AFTER the price table, not above it', async () => {
    renderPage();
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);

    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i });
    await user.click(editButtons[0]!);

    const priceHeading = await screen.findByText('Prices per vehicle type');
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    // DOCUMENT_POSITION_FOLLOWING means saveButton comes AFTER priceHeading.
    expect(
      priceHeading.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('converts duration hours + minutes into total minutes, and prices in pesos into centavos', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);
    await openAddForm();

    await pickPlace('From place', 'Mactan', 'Mactan-Cebu International Airport');
    await pickPlace('To place', 'Oslob', 'Oslob');
    await user.type(screen.getByLabelText('Slug'), 'mactan-oslob-3');
    await user.clear(screen.getByLabelText('Duration — minutes'));
    await user.type(screen.getByLabelText('Duration — hours'), '2');
    await user.type(screen.getByLabelText('Duration — minutes'), '30');
    await user.clear(screen.getByLabelText('Free cancellation window (hours)'));
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '24');
    await user.type(document.getElementById('route-price-1-oneway')!, '1,800.50');
    await user.type(document.getElementById('route-price-1-dayuse')!, '4,000.00');

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as {
      estimatedDurationMinutes: number;
      prices: Record<string, { oneWayPriceCentavos: number; dayUsePriceCentavos: number } | null>;
    };
    expect(payload.estimatedDurationMinutes).toBe(150);
    expect(payload.prices['1']!.oneWayPriceCentavos).toBe(pesosToCentavos('1,800.50'));
    expect(payload.prices['1']!.oneWayPriceCentavos).toBe(180_050);
    expect(Number.isInteger(payload.prices['1']!.oneWayPriceCentavos)).toBe(true);
  });

  it('shows the server’s own ambiguous duplicate CONFLICT as a friendly banner, not raw JSON', async () => {
    renderPage();
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);

    const duplicateMessage =
      'A transfer route already exists for that from/to pair, or that slug is already taken. ' +
      'A retired route still holds both — reactivate it instead of creating a second one.';
    mockTrpcError('admin.transferRoutes.create', 'CONFLICT', duplicateMessage);

    await openAddForm();
    await pickPlace('From place', 'Mactan', 'Mactan-Cebu International Airport');
    await pickPlace('To place', 'Oslob', 'Oslob');
    await user.type(screen.getByLabelText('Slug'), 'mactan-oslob-4');
    await user.clear(screen.getByLabelText('Duration — minutes'));
    await user.type(screen.getByLabelText('Duration — hours'), '2');
    await user.clear(screen.getByLabelText('Free cancellation window (hours)'));
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '24');

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    expect(await screen.findByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.queryByText(/"code":/)).toBeNull();
  });

  /*
   * -------------------------------------------------------------------- *
   * Task 1D — "Show on home page" section + live preview.
   * -------------------------------------------------------------------- */

  it('shows the home-page section fields only when the toggle is on', async () => {
    renderPage();
    await openAddForm();

    expect(screen.getByLabelText(/Adds this route to/i)).not.toBeChecked();
    expect(screen.queryByLabelText('Badge (optional)')).toBeNull();
    expect(screen.queryByLabelText('Order on home page')).toBeNull();
    expect(screen.queryByLabelText(/Short description/)).toBeNull();

    await user.click(screen.getByLabelText(/Adds this route to/i));

    expect(screen.getByLabelText('Badge (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Order on home page')).toBeInTheDocument();
    expect(screen.getByLabelText(/Short description/)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Adds this route to/i));
    expect(screen.queryByLabelText('Badge (optional)')).toBeNull();
  });

  it('shows a live preview reflecting the typed badge and description', async () => {
    renderPage();
    await openAddForm();
    await user.click(screen.getByLabelText(/Adds this route to/i));

    await pickPlace('From place', 'Mactan', 'Mactan-Cebu International Airport');
    await pickPlace('To place', 'Oslob', 'Oslob');

    await user.type(screen.getByLabelText('Badge (optional)'), 'Most booked');
    await user.type(screen.getByLabelText(/Short description/), 'Fast and comfortable.');

    // Both typed into the LOCAL form state, with no save and no tRPC call —
    // the preview is a pure function of the unsaved form, not a query.
    // `{ selector: 'p' }` on the description: jsdom mirrors a <textarea>'s
    // live value into its own textContent, so a bare `getByText` would also
    // match the textarea itself as a second, ambiguous node.
    expect(await screen.findByText('Most booked')).toBeInTheDocument();
    expect(screen.getByText('Fast and comfortable.', { selector: 'p' })).toBeInTheDocument();

    // Clearing the badge removes it from the preview immediately.
    await user.clear(screen.getByLabelText('Badge (optional)'));
    expect(screen.queryByText('Most booked')).toBeNull();
  });

  it('posts the home-page fields on save, null when left blank', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.transferRoutes.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText(/Mactan-Cebu International Airport → Oslob/);
    await openAddForm();

    await pickPlace('From place', 'Mactan', 'Mactan-Cebu International Airport');
    await pickPlace('To place', 'Oslob', 'Oslob');
    await user.type(screen.getByLabelText('Slug'), 'mactan-oslob-home');
    await user.clear(screen.getByLabelText('Duration — minutes'));
    await user.type(screen.getByLabelText('Duration — hours'), '2');
    await user.clear(screen.getByLabelText('Free cancellation window (hours)'));
    await user.type(screen.getByLabelText('Free cancellation window (hours)'), '24');
    await user.type(
      screen.getByLabelText('One-way (pesos)', { selector: '#route-price-1-oneway' }),
      '1500.00',
    );
    await user.type(
      screen.getByLabelText('Day-use (pesos)', { selector: '#route-price-1-dayuse' }),
      '3500.00',
    );

    await user.click(screen.getByLabelText(/Adds this route to/i));
    await user.type(screen.getByLabelText('Badge (optional)'), 'Most booked');
    const orderInput = screen.getByLabelText('Order on home page');
    await user.clear(orderInput);
    await user.type(orderInput, '5');

    await user.click(screen.getByRole('button', { name: /^add route$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = sent[0] as {
      showOnHomePage: boolean;
      homePageBadge: string | null;
      homePageOrder: number;
      homePageShortDescription: string | null;
    };
    expect(payload.showOnHomePage).toBe(true);
    expect(payload.homePageBadge).toBe('Most booked');
    expect(payload.homePageOrder).toBe(5);
    expect(payload.homePageShortDescription).toBeNull();
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner can manage transfer routes/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Mactan-Cebu International Airport/)).toBeNull();
  });
});
