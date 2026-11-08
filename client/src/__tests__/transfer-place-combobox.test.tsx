/**
 * `TransferPlaceCombobox` (owner decision 2026-11-08: flexible places/
 * routes/vehicle types) — the type-to-search picker reused for both the
 * "From place" and "To place" fields of `AdminTransferRoutesPage.tsx`. This
 * file proves the component in isolation: typing filters the list,
 * selecting an option calls `onChange`, and the "+ Add new place" inline
 * create actually posts to `admin.transferPlaces.create` and selects the
 * new place — without ever leaving the host form (no navigation, no full
 * page).
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { TransferPlaceAdminListRow } from '@rg/shared';
import TransferPlaceCombobox from '@/components/admin/TransferPlaceCombobox';
import { TrpcProviders, trpc } from '@/lib/trpc';
import {
  mockTrpc,
  mockTrpcError,
  mockTrpcValidationError,
  resetTrpcMock,
} from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

const OSLOB: TransferPlaceAdminListRow = {
  id: 20,
  name: 'Oslob',
  isAirport: false,
  isActive: true,
  sortOrder: 0,
  destinationId: null,
};
const MACTAN: TransferPlaceAdminListRow = {
  id: 10,
  name: 'Mactan-Cebu International Airport',
  isAirport: true,
  isActive: true,
  sortOrder: 1,
  destinationId: null,
};
const RETIRED_PORT: TransferPlaceAdminListRow = {
  id: 30,
  name: 'Hagnaya Port',
  isAirport: false,
  isActive: false,
  sortOrder: 2,
  destinationId: null,
};

/**
 * Queries `admin.transferPlaces.list` live, the same way
 * `AdminTransferRoutesPage.tsx` feeds this component — so a successful
 * inline create (which invalidates that list) is reflected here exactly as
 * it would be in the real page, rather than this test asserting against a
 * frozen prop the component never actually owns.
 */
function Harness({ initialValue = null as number | null }) {
  const [value, setValue] = useState<number | null>(initialValue);
  const list = trpc.admin.transferPlaces.list.useQuery();
  return (
    <TransferPlaceCombobox
      label="From place"
      places={list.data ?? []}
      value={value}
      onChange={setValue}
    />
  );
}

/**
 * The backing array for `admin.transferPlaces.list`, mutated by the DEFAULT
 * `admin.transferPlaces.create` handler below — so a successful inline
 * create is visible on the very next `list` read, the same way a real
 * create+invalidate round-trip behaves. Returned alongside the render
 * result so a test can assert on exactly what was posted without having to
 * override (and thereby disable) that behaviour itself.
 */
function renderHarness(extra: Record<string, unknown> = {}, initialValue: number | null = null) {
  const places: TransferPlaceAdminListRow[] = [OSLOB, MACTAN, RETIRED_PORT];
  mockTrpc({
    'admin.transferPlaces.list': () => places,
    'admin.transferPlaces.create': (input: {
      name: string;
      isAirport: boolean;
      destinationId: number | null;
    }) => {
      const id = 90 + places.length;
      places.push({
        id,
        name: input.name,
        isAirport: input.isAirport,
        isActive: true,
        sortOrder: places.length,
        destinationId: input.destinationId,
      });
      return { id };
    },
    ...extra,
  });
  const result = render(
    <TrpcProviders>
      <Harness initialValue={initialValue} />
    </TrpcProviders>,
  );
  return { ...result, places };
}

describe('TransferPlaceCombobox', () => {
  it('is labelled with a real <label>', () => {
    renderHarness();
    expect(screen.getByLabelText('From place')).toBeTruthy();
  });

  it('opens a listbox of matching places on focus, typed query filters it', async () => {
    renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    expect(screen.getByRole('option', { name: 'Oslob' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Mactan-Cebu International Airport' }),
    ).toBeInTheDocument();

    await user.type(input, 'Mactan');
    expect(screen.queryByRole('option', { name: 'Oslob' })).toBeNull();
    expect(
      screen.getByRole('option', { name: 'Mactan-Cebu International Airport' }),
    ).toBeInTheDocument();
  });

  /** A route may already point at a place an admin later deactivated — it must stay visible, not be filtered out. */
  it('shows an inactive place as a choosable option, labelled (inactive)', async () => {
    renderHarness();
    await user.click(screen.getByLabelText('From place'));
    expect(screen.getByRole('option', { name: /Hagnaya Port \(inactive\)/ })).toBeInTheDocument();
  });

  it('selecting an option calls onChange and displays the chosen name', async () => {
    renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.click(screen.getByRole('option', { name: 'Oslob' }));
    expect(screen.getByLabelText('From place')).toHaveValue('Oslob');
  });

  /**
   * **The affordance the task brief calls out by name.** Choosing
   * "+ Add new place" must open an INLINE create panel — no navigation, no
   * new route, no unmount of the host form — and submitting it must call
   * `admin.transferPlaces.create` with the typed name, then select the
   * newly created place by id via `onChange`, without the admin ever
   * leaving the page they were on.
   */
  it('adds a new place inline and selects it, without navigating away', async () => {
    const { places } = renderHarness();
    const startCount = places.length;
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.type(input, 'Hilutungan');
    await user.click(screen.getByRole('button', { name: /\+ add new place/i }));

    // The inline panel, not a navigation — the original label is still on
    // the page, proving nothing unmounted it.
    expect(screen.getByLabelText('From place')).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/new place name/i);
    expect(nameInput).toHaveValue('Hilutungan');

    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    // The real create reached the mutation, which pushed into the backing
    // list — one new row, carrying exactly what was typed.
    expect(await screen.findByLabelText('From place')).toHaveValue('Hilutungan');
    expect(places).toHaveLength(startCount + 1);
    expect(places.at(-1)).toMatchObject({
      name: 'Hilutungan',
      isAirport: false,
      destinationId: null,
    });
  });

  it('marking "Is an airport" in the inline create reaches the mutation', async () => {
    const { places } = renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.type(input, 'New Airport');
    await user.click(screen.getByRole('button', { name: /\+ add new place/i }));
    await user.click(screen.getByLabelText(/is an airport/i));
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    await screen.findByDisplayValue('New Airport');
    expect(places.at(-1)).toMatchObject({ name: 'New Airport', isAirport: true });
  });

  it('shows a create failure inline, without losing the typed name', async () => {
    renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.type(input, 'Bad Place');
    await user.click(screen.getByRole('button', { name: /\+ add new place/i }));

    mockTrpcError(
      'admin.transferPlaces.create',
      'CONFLICT',
      'A transfer place named "Bad Place" already exists.',
    );
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    expect(
      await screen.findByText('A transfer place named "Bad Place" already exists.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/new place name/i)).toHaveValue('Bad Place');
  });

  /**
   * The checkbox input itself is excluded: this project's own convention
   * (`AdminToursPage.tsx`'s "Per person"/"Active" checkboxes) puts
   * `tap-target` on the WRAPPING `<label>`, not the 16px native checkbox box
   * — the label is what gives the control its 44px hit area. Checking the
   * raw checkbox input here would fail against an established, intentional
   * pattern rather than a real gap.
   */
  /**
   * CLAUDE.md: "No form, public or admin, may show raw Zod JSON." A
   * server-side input validation failure (the name exceeding
   * `transferPlaceCreateInputSchema`'s `max(120)`, say) arrives as a
   * `BAD_REQUEST` whose `data.zodError` carries the tidy field message and
   * whose bare `.message` is tRPC's own raw stringified issue list
   * (`mock-trpc.ts`'s own doc comment on `mockTrpcValidationError`). This
   * panel must read the former, the same way the sibling admin pages'
   * `firstValidationMessage()` already does, never the latter.
   */
  it('shows the Zod field message for a validation failure, never the raw issue JSON', async () => {
    renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.type(input, 'Some New Place');
    await user.click(screen.getByRole('button', { name: /\+ add new place/i }));

    mockTrpcValidationError('admin.transferPlaces.create', {
      fieldErrors: { name: ['Name must be 120 characters or fewer.'] },
    });
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    expect(await screen.findByText('Name must be 120 characters or fewer.')).toBeInTheDocument();
    expect(screen.queryByText(/"code":/)).toBeNull();
    expect(screen.queryByText(/\[\s*\{/)).toBeNull();
  });

  it('gives every control the tap-target utility', async () => {
    renderHarness();
    const input = screen.getByLabelText('From place');
    await user.click(input);
    await user.click(screen.getByRole('button', { name: /\+ add new place/i }));
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, input')).filter(
      (control) =>
        control.getAttribute('aria-hidden') !== 'true' &&
        control.getAttribute('type') !== 'checkbox',
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.className).toMatch(/tap-target/);
    }
    // The checkbox's own label carries the tap target instead.
    const checkboxLabel = screen.getByText(/is an airport/i).closest('label');
    expect(checkboxLabel?.className).toMatch(/tap-target/);
  });
});
