/**
 * The vehicle-types admin screen (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). `admin.vehicleTypes.*`
 * is `adminProcedure('toursPricing')` server-side — owner only; this file
 * proves the screen: every field is labelled, a validation error lands
 * beside its field, status is never colour alone, and deactivating is a
 * two-step confirm that never pretends to delete anything.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminVehicleTypesPage from '@/pages/admin/AdminVehicleTypesPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

const VAN = {
  id: 1,
  name: 'Van',
  slug: 'van',
  defaultSeats: 10,
  defaultLuggage: 8,
  isActive: true,
  sortOrder: 0,
};
const SUV = {
  id: 2,
  name: 'SUV',
  slug: 'suv',
  defaultSeats: null,
  defaultLuggage: null,
  isActive: false,
  sortOrder: 1,
};

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.vehicleTypes.list': [VAN, SUV],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminVehicleTypesPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminVehicleTypesPage', () => {
  it('renders every type, active and inactive, with its prefill defaults in words', async () => {
    renderPage();
    await screen.findAllByText('Van');
    expect(screen.getAllByText('SUV').length).toBeGreaterThan(0);

    const states = screen.getAllByText(/^(Active|Inactive)$/).map((node) => node.textContent);
    expect(states).toContain('Active');
    expect(states).toContain('Inactive');

    expect(screen.getAllByText('10 seats by default').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No seat default yet').length).toBeGreaterThan(0);
  });

  it('labels every input with a real <label>', async () => {
    renderPage();
    await screen.findAllByText('Van');
    await user.click(screen.getByRole('button', { name: /add a vehicle type/i }));
    for (const name of ['Name', 'Slug']) {
      expect(screen.getByLabelText(new RegExp(`^${name}`, 'i'))).toBeTruthy();
    }
    // `defaultSeats`/`defaultLuggage` are optional, so `EntityForm` tucks
    // them behind "More details" (progressive disclosure) — open it before
    // asserting their labels exist.
    await user.click(screen.getByRole('button', { name: /more details/i }));
    for (const name of ['Default seats', 'Default luggage']) {
      expect(screen.getByLabelText(new RegExp(`^${name}`, 'i'))).toBeTruthy();
    }
  });

  /**
   * `described` may name TWO ids (hint + error) joined by a space —
   * `document.getElementById` cannot resolve a space-separated token list,
   * so this reads every named id and joins their text before matching,
   * rather than assuming a single id as other, hint-less fields can.
   */
  function describedText(field: Element): string {
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    return described!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
  }

  it('shows a field error beside the field, not only at the top', async () => {
    renderPage();
    await screen.findAllByText('Van');
    await user.click(screen.getByRole('button', { name: /add a vehicle type/i }));
    await user.type(screen.getByLabelText(/^slug/i), 'bad slug with spaces');
    await user.click(screen.getByRole('button', { name: /^add vehicle type$/i }));

    expect(describedText(screen.getByLabelText(/^slug/i))).toMatch(/lowercase|required/i);
  });

  /**
   * `defaultSeats`/`defaultLuggage` must reach the mutation as either a
   * number or `null` — never an empty string — and must be left blank-safe
   * (the owner never has to type a number for these two fields).
   */
  it('posts null for blank default-seats/luggage, and a number when typed', async () => {
    const createCalls: unknown[] = [];
    renderPage({
      'admin.vehicleTypes.create': (input: unknown) => {
        createCalls.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('Van');
    await user.click(screen.getByRole('button', { name: /add a vehicle type/i }));

    await user.type(screen.getByLabelText(/^name/i), 'MPV');
    await user.type(screen.getByLabelText(/^slug/i), 'mpv');
    await user.click(screen.getByRole('button', { name: /more details/i }));
    await user.type(screen.getByLabelText(/^default seats/i), '7');
    // Default luggage is left blank on purpose.
    await user.click(screen.getByRole('button', { name: /^add vehicle type$/i }));

    expect(await screen.findByText(/vehicle type added/i)).toBeTruthy();
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ defaultSeats: 7, defaultLuggage: null });
  });

  it('shows a duplicate-slug CONFLICT as a banner, not raw JSON', async () => {
    renderPage();
    await screen.findAllByText('Van');

    const duplicateMessage = 'A vehicle type with that slug already exists.';
    mockTrpcError('admin.vehicleTypes.create', 'CONFLICT', duplicateMessage);

    await user.click(screen.getByRole('button', { name: /add a vehicle type/i }));
    await user.type(screen.getByLabelText(/^name/i), 'Van 2');
    await user.type(screen.getByLabelText(/^slug/i), 'van');
    await user.click(screen.getByRole('button', { name: /^add vehicle type$/i }));

    expect(await screen.findByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.queryByText(/"code":/)).toBeNull();
  });

  /** Deactivate is a two-step confirm, and the word "Delete" never appears. */
  it('deactivates a type behind a two-step confirm, and never says Delete', async () => {
    renderPage();
    await screen.findAllByText('Van');
    expect(screen.queryByText(/delete/i)).toBeNull();

    const deactivateButtons = await screen.findAllByRole('button', { name: /^deactivate van$/i });
    await user.click(deactivateButtons[0]!);
    expect(screen.getByRole('button', { name: /yes, deactivate van/i })).toBeInTheDocument();
  });

  /**
   * B2 (DEMO POLISH batch, 2026-11-09): owner decision 1 — "Deactivate =
   * amber outline pill, never red [or blue]." Before this batch both the
   * trigger and the confirm button were blue (the generic `PRIMARY_BUTTON`/
   * `OUTLINE_BUTTON` constants every button on this page shared), so a
   * destructive action read identically to a safe one. Pinned here rather
   * than assumed from the component's own name.
   */
  it('Deactivate is amber, never blue — both the trigger and the confirm', async () => {
    renderPage();
    await screen.findAllByText('Van');

    const trigger = (await screen.findAllByRole('button', { name: /^deactivate van$/i }))[0]!;
    expect(trigger.className).toContain('border-brand-warning');
    expect(trigger.className).not.toContain('border-brand-blue-600');

    await user.click(trigger);
    const confirm = screen.getByRole('button', { name: /yes, deactivate van/i });
    expect(confirm.className).toContain('border-brand-warning');
    expect(confirm.className).not.toContain('bg-brand-blue-600');
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(await screen.findByText(/only the owner can manage vehicle types/i)).toBeInTheDocument();
    expect(screen.queryByText('Van')).toBeNull();
  });

  /**
   * B2 (DEMO POLISH batch, 2026-11-09): widened from a bare `tap-target`
   * match for the same reason `admin-vans-page.test.tsx` was — this screen
   * now uses the admin "Clean Pill" button system, whose
   * primary/secondary/admin-ghost/amber-pill variants size themselves with
   * a direct `h-11` rather than the `tap-target` utility, and whose
   * `row`/`row-amber` table-action variants stay a visually compact `h-8`
   * with a 44px hit area supplied by an invisible `::before` extension
   * (`before:-inset-y-1.5`) — bare `h-8` alone is a real 32px target and
   * must NOT pass this check on its own.
   */
  it('gives every control a real 44px tap target', async () => {
    renderPage();
    await screen.findAllByText('Van');
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('button, input, select, textarea'),
    ).filter((control) => control.getAttribute('aria-hidden') !== 'true');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const className = control.className;
      const hasTapTarget = /\btap-target\b/.test(className);
      const hasFixed44 = /\bh-11\b/.test(className);
      const hasCompactWithHitArea =
        /\bh-8\b/.test(className) && /before:-inset-y-1\.5/.test(className);
      expect(
        hasTapTarget || hasFixed44 || hasCompactWithHitArea,
        `${control.tagName}[${control.getAttribute('type') ?? 'n/a'}] class="${className}"`,
      ).toBe(true);
    }
  });
});
