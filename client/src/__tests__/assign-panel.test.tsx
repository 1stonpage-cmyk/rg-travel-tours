/**
 * Week 5, Task 12: `AssignPanel` — the dropdowns, the suggest button, the
 * unpaid label (owner Q2), the required reason (owner Q3) and the role gate.
 *
 * The panel calls `trpc.*` hooks, so every render goes through
 * `TrpcProviders` — the house pattern from `admin-bookings.test.tsx:124-134`.
 * No `MemoryRouter`: this component has no links and no router hooks.
 *
 * Nothing here is a substitute for the server's enforcement.
 * `admin.dispatch.assign` re-checks every exclusion inside a locked
 * transaction (Task 10); these tests cover what the dispatcher SEES,
 * including each refusal the server can send back.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AssignPanel from '@/components/admin/AssignPanel';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent;

/*
 * Radix's `Select` needs three DOM APIs jsdom does not implement, and
 * without them the listbox never opens — every `getByRole('option')` fails
 * with "unable to find an accessible element", which looks exactly like a
 * component bug and is not one. This is the first test in the project to
 * open a Radix Select, so the shims live here; if a second file needs them,
 * they belong in a shared setup file rather than copied.
 *
 * They are shims, not stubs of behaviour under test: pointer capture and
 * scrolling are things a real browser does and this component never asks
 * about.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

/*
 * `luggageCapacity` arrives on every van from pre-task 0C's `dayOptions`.
 * NULL on these two = "not recorded", which is the state that makes the
 * panel's luggage warning skip — so every test written before 0C keeps
 * seeing exactly what it saw.
 */
const VAN_10 = { id: 10, plate: 'ABC 123', model: 'HiAce', capacity: 10, luggageCapacity: null };
const VAN_15 = { id: 15, plate: 'DEF 456', model: 'Urvan', capacity: 15, luggageCapacity: null };
/** Four seats against the panel's `pax={6}` — undersized on purpose. */
const VAN_4 = { id: 4, plate: 'GHI 789', model: 'Innova', capacity: 4, luggageCapacity: null };
const DRIVER_A = { id: 7, name: 'Maria Santos', code: 'D07' };
const DRIVER_B = { id: 8, name: 'Arturo Abella', code: 'D08' };

interface Overrides {
  role?: 'owner' | 'dispatcher' | 'finance';
  status?: 'confirmed' | 'assigned' | 'pending_verification' | 'in_progress';
  vans?: Array<{
    id: number;
    plate: string;
    model: string;
    capacity: number;
    luggageCapacity: number | null;
  }>;
  drivers?: Array<typeof DRIVER_A>;
  /** The booking's bag count: a number on a transfer, NULL on a tour. */
  luggageCount?: number | null;
  /** Records every `assign` call, so "called nothing" is assertable. */
  onAssign?: (input: unknown) => void;
  /** Records every `dayOptions` call — the finance gate must issue none. */
  onDayOptions?: () => void;
  assignError?: { message: string };
  suggestion?: { van: typeof VAN_10 | null; driver: typeof DRIVER_A | null; note: string };
  currentVanId?: number | null;
  currentDriverId?: number | null;
}

function renderPanel(overrides: Overrides = {}) {
  mockTrpc({
    'staffAuth.me': { role: overrides.role ?? 'dispatcher' },
    'admin.calendar.dayOptions': () => {
      overrides.onDayOptions?.();
      return {
        vans: overrides.vans ?? [VAN_10, VAN_15],
        drivers: overrides.drivers ?? [DRIVER_A, DRIVER_B],
        luggageCount: overrides.luggageCount ?? null,
      };
    },
    'admin.dispatch.suggest': () =>
      overrides.suggestion ?? { van: VAN_10, driver: DRIVER_A, note: 'ok' },
    'admin.dispatch.assign': (input: unknown) => {
      overrides.onAssign?.(input);
      if (overrides.assignError) throw new Error(overrides.assignError.message);
      return { ok: true };
    },
  });

  return render(
    <TrpcProviders>
      <AssignPanel
        bookingId={42}
        pax={6}
        status={overrides.status ?? 'confirmed'}
        currentVanId={overrides.currentVanId ?? null}
        currentDriverId={overrides.currentDriverId ?? null}
        onAssigned={() => {}}
      />
    </TrpcProviders>,
  );
}

async function pickBoth() {
  await user.click(await screen.findByRole('combobox', { name: /van/i }));
  await user.click(await screen.findByRole('option', { name: /ABC 123/ }));
  await user.click(await screen.findByRole('combobox', { name: /driver/i }));
  await user.click(await screen.findByRole('option', { name: /Maria Santos/ }));
}

afterEach(resetTrpcMock);

describe('AssignPanel', () => {
  it('offers only the vans and drivers the server returned', async () => {
    renderPanel({ vans: [VAN_10], drivers: [DRIVER_A] });
    await user.click(await screen.findByRole('combobox', { name: /van/i }));

    // EXACTLY one — the server said one van is free, so a second option
    // would mean the panel invented one.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toMatch(/ABC 123/);
  });

  it('explains the absences rather than leaving them mysterious', async () => {
    renderPanel();
    expect(
      await screen.findByText(/only vans and drivers free on this date are listed/i),
    ).toBeTruthy();
  });

  it('puts no button inside a listbox', async () => {
    renderPanel();
    await user.click(await screen.findByRole('combobox', { name: /van/i }));
    const listboxes = document.querySelectorAll('[role="listbox"]');
    expect(listboxes.length).toBeGreaterThan(0);
    for (const box of listboxes) {
      expect(box.querySelector('button')).toBeNull();
    }
  });

  it('suggest fills the dropdowns and assigns nothing', async () => {
    const assigns: unknown[] = [];
    renderPanel({ onAssign: (input) => assigns.push(input) });

    await user.click(await screen.findByRole('button', { name: /suggest/i }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /van/i }).textContent).toMatch(/ABC 123/),
    );
    // The whole point: a suggestion is not an assignment.
    expect(assigns).toEqual([]);
  });

  it('explains a suggestion that found nothing', async () => {
    renderPanel({ suggestion: { van: null, driver: null, note: 'no_van_fits' } });
    await user.click(await screen.findByRole('button', { name: /suggest/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/no van free .* big enough/i);
  });

  it('confirms an assignment by naming the van and the driver', async () => {
    renderPanel();
    await pickBoth();
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/ABC 123.*Maria Santos/);
  });

  /* ---- owner Q2: pre-assigning an unverified receipt ---- */

  it('labels a pending_verification trip as unpaid, in words', async () => {
    renderPanel({ status: 'pending_verification' });
    const label = await screen.findByTestId('unpaid-label');
    expect(label.textContent).toMatch(/unpaid/i);
    expect(label.textContent).toMatch(/receipt not yet checked/i);

    /*
     * Amber, asserted POSITIVELY. An earlier version asserted
     * `not.toMatch(/red|rose|destructive/)` and failed — shadcn's `Badge`
     * carries `bg-destructive` and friends in its own variant string, so a
     * negative regex on `className` trips on a vendored token that paints
     * nothing here. The project-wide "no red" rule has a proper home: the
     * `no-red` guard test reads real source and is run in this task's
     * verification. This assertion's job is narrower and checkable — the
     * label is the amber one.
     */
    expect(label.className).toMatch(/bg-amber-100/);
    expect(label.className).toMatch(/text-amber-900/);
  });

  it('shows no unpaid label for a confirmed trip', async () => {
    renderPanel({ status: 'confirmed' });
    await screen.findByRole('combobox', { name: /van/i });
    expect(screen.queryByTestId('unpaid-label')).toBeNull();
  });

  it('says the trip is still unpaid in the confirmation itself', async () => {
    // The label above is visible before assigning; this is the sentence
    // after — a dispatcher who has just staffed an unverified trip should
    // not walk away thinking the money is settled.
    renderPanel({ status: 'pending_verification' });
    await pickBoth();
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/still unpaid/i);
  });

  /* ---- owner Q3: the reason, only where it is required ---- */

  it('requires a reason before assigning a trip under way', async () => {
    renderPanel({ status: 'in_progress' });
    await pickBoth();
    const reason = screen.getByLabelText(/reason for changing a trip under way/i);
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
    await user.type(reason, 'Broke down at Carcar');
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeEnabled();
  });

  it('offers no reason field at all for a confirmed trip', async () => {
    renderPanel({ status: 'confirmed' });
    await screen.findByRole('combobox', { name: /van/i });
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
  });

  /* ---- the role gate ---- */

  it('renders nothing for finance, and issues no dayOptions query', async () => {
    const calls: string[] = [];
    renderPanel({ role: 'finance', onDayOptions: () => calls.push('dayOptions') });

    await waitFor(() => expect(screen.queryByTestId('assign-panel')).toBeNull());
    expect(screen.queryByRole('button', { name: /^assign$/i })).toBeNull();
    // Not merely hidden: the query must never be sent, or finance meets a
    // FORBIDDEN for an action never offered to them.
    expect(calls).toEqual([]);
  });

  it('renders the panel for owner and for dispatcher', async () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      const { unmount } = renderPanel({ role });
      expect(await screen.findByRole('button', { name: /^assign$/i })).toBeTruthy();
      unmount();
      resetTrpcMock();
    }
  });

  /* ---- every refusal reason reaches the dispatcher as words ---- */

  it.each([
    ['van_unavailable', /someone just took that van/i],
    ['driver_unavailable', /not available on this date/i],
    ['van_too_small', /too small for this group/i],
    ['booking_not_assignable', /cannot take a van and driver yet/i],
    ['booking_not_found', /no longer there/i],
    ['reason_required', /needs a reason/i],
  ])('turns the %s refusal into something a dispatcher can act on', async (reason, expected) => {
    renderPanel({ assignError: { message: reason } });
    await pickBoth();
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(expected);
  });

  it('passes an unrecognised CONFLICT through as its own words', async () => {
    // Task 10's deadlock give-up. Forcing it into one of the six would tell
    // a dispatcher the wrong thing about why their click failed.
    renderPanel({
      assignError: { message: 'This date is busy with other assignments right now.' },
    });
    await pickBoth();
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/busy with other assignments/i);
  });

  it('keeps Assign disabled while the options failed to load', async () => {
    renderPanel({ vans: [], drivers: [] });
    await screen.findByRole('combobox', { name: /van/i });
    // Nothing selectable means nothing selected means nothing to submit.
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
  });

  /* ---- pre-task 0C: the undersized-vehicle warning and its override ---- */

  /** Picks the named van and `DRIVER_A`, so only the van choice varies. */
  async function pickVan(plate: RegExp) {
    await user.click(await screen.findByRole('combobox', { name: /van/i }));
    await user.click(await screen.findByRole('option', { name: plate }));
    await user.click(await screen.findByRole('combobox', { name: /driver/i }));
    await user.click(await screen.findByRole('option', { name: /Maria Santos/ }));
  }

  it('shows no fit warning for a van that fits', async () => {
    renderPanel({ vans: [VAN_10] });
    await pickVan(/ABC 123/);
    expect(screen.queryByTestId('vehicle-fit-warning')).toBeNull();
  });

  it('warns with the ACTUAL numbers when the chosen van is short on seats', async () => {
    renderPanel({ vans: [VAN_4] });
    await pickVan(/GHI 789/);

    const warning = await screen.findByTestId('vehicle-fit-warning');
    // The numbers, not a verdict: "4 seats, 6 passengers" is a judgement a
    // dispatcher can make and "too small" is not.
    expect(warning.textContent).toMatch(/seats 4/i);
    expect(warning.textContent).toMatch(/6 passengers/i);
    // Amber, asserted POSITIVELY — the same reasoning as the unpaid label
    // above. The project-wide "no red" rule has its own guard test.
    expect(warning.className).toMatch(/bg-amber-100/);
    expect(warning.className).toMatch(/text-amber-900/);
  });

  it('warns on LUGGAGE when the seats fit but the recorded bags do not', async () => {
    renderPanel({
      vans: [{ ...VAN_10, luggageCapacity: 2 }],
      luggageCount: 6,
    });
    await pickVan(/ABC 123/);

    const warning = await screen.findByTestId('vehicle-fit-warning');
    expect(warning.textContent).toMatch(/2 bags/i);
    expect(warning.textContent).toMatch(/this booking has 6/i);
    // The seats fit (10 >= 6), so the seat sentence must be absent — one
    // warning box, only the sentences that are true.
    expect(warning.textContent).not.toMatch(/passengers/i);
  });

  it('shows no luggage warning when the van has no recorded luggage capacity', async () => {
    // NULL = not measured yet. Guessing a zero here would warn on the whole
    // fleet on day one; the server skips the same comparison.
    renderPanel({ vans: [VAN_10], luggageCount: 99 });
    await pickVan(/ABC 123/);
    expect(screen.queryByTestId('vehicle-fit-warning')).toBeNull();
  });

  it('blocks Assign until the override box is ticked AND a reason is typed', async () => {
    renderPanel({ vans: [VAN_4] });
    await pickVan(/GHI 789/);

    const button = () => screen.getByRole('button', { name: /^assign$/i });
    // Both ids are chosen, so without the override gate this would be ready.
    expect(button()).toBeDisabled();

    await user.click(screen.getByLabelText(/assign anyway/i));
    expect(button()).toBeDisabled();

    const box = screen.getByLabelText(/why this vehicle is still the right one/i);
    await user.type(box, 'four');
    expect(button()).toBeDisabled();
    await user.type(box, ' toddlers');
    expect(button()).toBeEnabled();
  });

  it('sends override and overrideReason only when the box is ticked', async () => {
    const assigns: unknown[] = [];
    renderPanel({ vans: [VAN_4], onAssign: (input) => assigns.push(input) });
    await pickVan(/GHI 789/);

    await user.click(screen.getByLabelText(/assign anyway/i));
    await user.type(
      screen.getByLabelText(/why this vehicle is still the right one/i),
      '  Four of the six are toddlers.  ',
    );
    await user.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() => expect(assigns).toHaveLength(1));
    expect(assigns[0]).toMatchObject({
      vanId: 4,
      override: true,
      // Trimmed on the way out, so the server's `.min(5)` sees what a human
      // actually wrote.
      overrideReason: 'Four of the six are toddlers.',
    });
  });

  it('sends no override field at all for a van that fits', async () => {
    const assigns: Array<Record<string, unknown>> = [];
    renderPanel({ vans: [VAN_10], onAssign: (input) => assigns.push(input as never) });
    await pickVan(/ABC 123/);
    await user.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() => expect(assigns).toHaveLength(1));
    expect(assigns[0]).not.toHaveProperty('override');
    expect(assigns[0]).not.toHaveProperty('overrideReason');
  });

  it('turns the vehicle_too_small refusal into something a dispatcher can act on', async () => {
    // The stale-dropdown fallback: the panel's own warning did not fire
    // (VAN_10 fits what the panel was told), but the server refused anyway.
    renderPanel({ vans: [VAN_10], assignError: { message: 'vehicle_too_small' } });
    await pickVan(/ABC 123/);
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/may not fit the group/i);
  });
});
