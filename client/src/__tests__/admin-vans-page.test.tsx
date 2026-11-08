/**
 * Week 5 plan, Task 5 — the vans admin screen (BUILD_SPEC §9 "Vans" / §5A,
 * client half). `server/src/__tests__/admin-vans.test.ts` proves the role
 * rules and the write paths; this file proves the screen: every field is
 * really labelled, a validation error lands beside its field (not only in
 * a summary), status is never colour alone, and the wide table rides
 * inside its own horizontal scroll container rather than the page body.
 *
 * **Updated 2026-11-08 (flexible-routes plan, Task 1D):** `van`/`suv` used
 * to be a hard-coded two-member enum (`vehicleType: 'van' | 'suv'`); it is
 * now an admin-managed list (`vehicleTypeId: number`, read from
 * `admin.vehicleTypes.list`). Every fixture and assertion below is updated
 * for that shape — a van now carries `vehicleTypeId` + `vehicleTypeName`,
 * and the "Vehicle type" dropdown's options come from the mocked vehicle-
 * types list rather than two hardcoded strings.
 *
 * `renderPage` wraps the component in `TrpcProviders` only. `AdminVansPage`
 * calls `trpc.*` hooks directly (a Provider is required, same reasoning as
 * `admin-bookings.test.tsx`'s `renderList`), but it renders no `<Link>` or
 * `<NavLink>` and calls no router hook of its own — unlike
 * `AdminBookingsPage`, which links out to a detail route — so no
 * `MemoryRouter` is needed here.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminVansPage from '@/pages/admin/AdminVansPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

/*
 * This page's own form mounts a Radix `Select` field (vehicle type). Radix
 * needs three DOM APIs jsdom does not implement, and without them the
 * listbox never opens — see `assign-panel.test.tsx` for the first use of
 * this exact shim in this tree.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

afterEach(() => {
  resetTrpcMock();
});

const user = userEvent;

const VEHICLE_TYPES = [
  {
    id: 1,
    name: 'Van',
    slug: 'van',
    defaultSeats: null,
    defaultLuggage: null,
    isActive: true,
    sortOrder: 0,
  },
  {
    id: 2,
    name: 'SUV',
    slug: 'suv',
    defaultSeats: null,
    defaultLuggage: null,
    isActive: true,
    sortOrder: 1,
  },
];

const VAN = {
  id: 1,
  plate: 'ABC123',
  model: 'Toyota Hiace',
  capacity: 10,
  luggageCapacity: null,
  vehicleTypeId: 1,
  vehicleTypeName: 'Van',
  status: 'available',
  odometer: 50_000,
  lastService: '2026-01-01',
  nextService: '2026-07-01',
  orcrExpiry: '2027-01-01',
  franchiseNo: 'FR-2026-001',
  franchiseExpiry: '2027-01-01',
  repairNotes: null,
  isActive: true,
};

function renderPage(overrides?: {
  vans?: Array<typeof VAN>;
  vehicleTypes?: Array<(typeof VEHICLE_TYPES)[number]>;
}) {
  mockTrpc({
    'admin.vans.list': overrides?.vans ?? [VAN],
    'admin.vehicleTypes.list': overrides?.vehicleTypes ?? VEHICLE_TYPES,
    'admin.vans.create': () => ({ id: 99 }),
    'admin.vans.update': () => ({ ok: true }),
    'admin.vans.setStatus': () => ({ ok: true }),
  });
  return render(
    <TrpcProviders>
      <AdminVansPage />
    </TrpcProviders>,
  );
}

describe('AdminVansPage', () => {
  it('labels every input with a real <label>', async () => {
    renderPage();
    // Wait for the vehicle-types query to resolve so the Vehicle type
    // control's label is actually reachable (its options only render once
    // the query settles).
    await screen.findByRole('combobox', { name: /vehicle type/i });
    for (const name of ['Plate', 'Model', 'Seats for guests', 'Vehicle type']) {
      expect(screen.getByLabelText(new RegExp(name, 'i'))).toBeTruthy();
    }

    // No input may rely on a placeholder for its name. `.labels` is the DOM's
    // own answer to "is there a <label> pointing at this control", so an
    // input that merely HAS an id — with no label anywhere — fails here.
    const textboxes = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(textboxes.length).toBeGreaterThan(0);
    for (const input of textboxes) {
      const labelled = input.labels !== null && input.labels.length > 0;
      expect(labelled || input.getAttribute('aria-label') !== null).toBe(true);
    }
  });

  /**
   * The server REJECTS a patch with no fields: an empty patch used to skip
   * the update, skip the only existence check with it, and still commit a
   * `van_updated` audit row for a change that never happened. The client's
   * job is to never send one — so opening the edit form and saving without
   * touching anything must show a notice and make NO mutation call at all.
   */
  it('saves nothing, and calls nothing, when the edit form is unchanged', async () => {
    const updateCalls: unknown[] = [];
    mockTrpc({
      'admin.vans.list': [VAN],
      'admin.vehicleTypes.list': VEHICLE_TYPES,
      'admin.vans.create': () => ({ id: 99 }),
      'admin.vans.update': (input: unknown) => {
        updateCalls.push(input);
        return { ok: true };
      },
      'admin.vans.setStatus': () => ({ ok: true }),
    });
    render(
      <TrpcProviders>
        <AdminVansPage />
      </TrpcProviders>,
    );

    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i });
    await userEvent.click(editButtons[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/no changes to save/i)).toBeTruthy();
    expect(updateCalls).toEqual([]);
  });

  it('shows a field error beside the field, not only at the top', async () => {
    renderPage();
    await user.clear(screen.getByLabelText(/plate/i));
    await user.click(screen.getByRole('button', { name: /add van/i }));
    const field = screen.getByLabelText(/plate/i);
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/required|at least/i);
  });

  /**
   * `vehicleTypeId` is a required Zod field with no default — the admin must
   * explicitly choose a vehicle type, never have one silently assumed.
   * Filling every other required field and submitting without ever touching
   * the vehicle-type control must refuse, with the message beside that
   * control, same as every other required field above.
   */
  it('requires an explicit vehicle type, with no default silently chosen', async () => {
    renderPage();
    await user.type(screen.getByLabelText(/^plate/i), 'NEW111');
    await user.type(screen.getByLabelText(/model/i), 'Nissan Urvan');
    await user.type(screen.getByLabelText(/seats for guests/i), '12');
    await user.click(screen.getByRole('button', { name: /add van/i }));

    const field = screen.getByRole('combobox', { name: /vehicle type/i });
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/required/i);
  });

  /**
   * Proves the SUV choice actually reaches the mutation, not just that the
   * control renders — selecting "SUV" and submitting must send
   * `vehicleTypeId: 2` (the mocked SUV type's id) to `admin.vans.create`.
   */
  it('sends the chosen vehicle type id to admin.vans.create', async () => {
    const createCalls: unknown[] = [];
    mockTrpc({
      'admin.vans.list': [VAN],
      'admin.vehicleTypes.list': VEHICLE_TYPES,
      'admin.vans.create': (input: unknown) => {
        createCalls.push(input);
        return { id: 99 };
      },
      'admin.vans.update': () => ({ ok: true }),
      'admin.vans.setStatus': () => ({ ok: true }),
    });
    render(
      <TrpcProviders>
        <AdminVansPage />
      </TrpcProviders>,
    );

    await user.type(screen.getByLabelText(/^plate/i), 'SUV111');
    await user.type(screen.getByLabelText(/model/i), 'Toyota Fortuner');
    await user.type(screen.getByLabelText(/seats for guests/i), '6');
    await user.click(screen.getByRole('combobox', { name: /vehicle type/i }));
    await user.click(await screen.findByRole('option', { name: /^suv$/i }));
    await user.click(screen.getByRole('button', { name: /add van/i }));

    expect(await screen.findByText(/van added/i)).toBeTruthy();
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ vehicleTypeId: 2 });
  });

  /**
   * An inactive vehicle type must not be offered as a choice for a NEW van —
   * the same reasoning `transferRoutes.list` applies to an inactive type's
   * price. Only active types are mocked as options here, so this also
   * proves the page filters rather than trusting the server to.
   */
  it('offers only active vehicle types as choices on the Add form', async () => {
    renderPage({
      vehicleTypes: [
        ...VEHICLE_TYPES,
        {
          id: 3,
          name: 'MPV',
          slug: 'mpv',
          defaultSeats: null,
          defaultLuggage: null,
          isActive: false,
          sortOrder: 2,
        },
      ],
    });
    await screen.findAllByText(VAN.plate);
    await user.click(screen.getByRole('combobox', { name: /vehicle type/i }));
    expect(screen.getByRole('option', { name: /^van$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^suv$/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^mpv$/i })).toBeNull();
  });

  /**
   * `getByText`/`findByText` (singular) assumes exactly one match — but this
   * screen follows the same card-plus-table convention
   * `admin-bookings.test.tsx` proves and names explicitly ("card + table
   * row", asserted with `toHaveLength(2)`, not a singular query).
   */
  it('renders the repair status as text, not only a colour', async () => {
    renderPage({ vans: [{ ...VAN, status: 'for_repair' }] });
    const matches = await screen.findAllByText(/for repair/i);
    expect(matches).toHaveLength(2);
  });

  /**
   * NOTE ON WHAT THIS TEST CAN AND CANNOT PROVE. jsdom does no layout: it
   * cannot measure a scroll width, so no unit test here can honestly claim
   * "the page never scrolls sideways at 360px". What it CAN prove is that the
   * wide element is inside a scroll container of its own.
   */
  it('wraps the table in its own horizontal scroll container', async () => {
    renderPage({ vans: [VAN, { ...VAN, id: 2, plate: 'DEF456' }] });
    await screen.findAllByText(VAN.plate);
    const wrapper = document.querySelector('[data-testid="vans-table-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toMatch(/overflow-x-auto/);
    expect(wrapper!.querySelector('table')).not.toBeNull();
  });

  /**
   * jsdom does no layout, so no unit test here can measure 44 physical
   * pixels. What it CAN prove is that every control carries the project's
   * own `tap-target` utility (`client/src/index.css`).
   */
  it('gives every control the tap-target utility', async () => {
    renderPage();
    await screen.findAllByText(VAN.plate);
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('button, input, select, textarea'),
    ).filter((control) => control.getAttribute('aria-hidden') !== 'true');
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      expect(
        control.className,
        `${control.tagName}[${control.getAttribute('type') ?? 'n/a'}]`,
      ).toMatch(/tap-target/);
    }
  });

  /**
   * The CONFLICT path called out by name as "the most common real failure on
   * this screen" — a duplicate plate must land on the plate field, not as a
   * bare toast disconnected from the control that caused it.
   */
  it('surfaces a duplicate-plate CONFLICT on the plate field, not a bare toast', async () => {
    renderPage();
    await screen.findAllByText(VAN.plate);

    mockTrpcError('admin.vans.create', 'CONFLICT', 'A van with that plate number already exists.');

    await user.clear(screen.getByLabelText(/^plate/i));
    await user.type(screen.getByLabelText(/^plate/i), 'XYZ999');
    await user.clear(screen.getByLabelText(/model/i));
    await user.type(screen.getByLabelText(/model/i), 'Another Hiace');
    await user.clear(screen.getByLabelText(/seats for guests/i));
    await user.type(screen.getByLabelText(/seats for guests/i), '10');
    await user.click(screen.getByRole('combobox', { name: /vehicle type/i }));
    await user.click(await screen.findByRole('option', { name: /^van$/i }));
    await user.click(screen.getByRole('button', { name: /add van/i }));

    const field = await screen.findByLabelText(/^plate/i);
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/already exists/i);
  });
});
