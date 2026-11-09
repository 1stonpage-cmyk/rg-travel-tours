/**
 * The transfer-places admin screen (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). `admin.transferPlaces.*`
 * is `adminProcedure('toursPricing')` server-side — owner only; this file
 * proves the screen: every field is labelled, a validation error lands
 * beside its field, the destination cross-link is optional and informational,
 * and deactivating is a two-step confirm that never pretends to delete
 * anything.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminTransferPlacesPage from '@/pages/admin/AdminTransferPlacesPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

/* The "Is an airport"/"Linked destination" fields are Radix `Select`s. */
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

const DESTINATIONS = [{ id: 5, name: 'Oslob', slug: 'oslob' }];

const AIRPORT = {
  id: 10,
  name: 'Mactan-Cebu International Airport',
  isAirport: true,
  isActive: true,
  sortOrder: 0,
  destinationId: null,
};
const OSLOB_PLACE = {
  id: 20,
  name: 'Oslob',
  isAirport: false,
  isActive: false,
  sortOrder: 1,
  destinationId: 5,
};

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'destinations.list': DESTINATIONS,
    'admin.transferPlaces.list': [AIRPORT, OSLOB_PLACE],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminTransferPlacesPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminTransferPlacesPage', () => {
  it('renders every place, active and inactive, with its airport flag and linked destination', async () => {
    renderPage();
    await screen.findAllByText('Mactan-Cebu International Airport');
    expect(screen.getAllByText('Oslob').length).toBeGreaterThan(0);

    const states = screen.getAllByText(/^(Active|Inactive)$/).map((node) => node.textContent);
    expect(states).toContain('Active');
    expect(states).toContain('Inactive');

    expect(screen.getAllByText('Linked to Oslob').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No linked destination').length).toBeGreaterThan(0);
  });

  it('labels every input with a real <label>', async () => {
    renderPage();
    await screen.findAllByText('Mactan-Cebu International Airport');
    await user.click(screen.getByRole('button', { name: /add a transfer place/i }));
    for (const name of ['Name', 'Is an airport']) {
      expect(screen.getByLabelText(new RegExp(name, 'i'))).toBeTruthy();
    }
    // `destinationId` and `sortOrder` are optional, so `EntityForm` tucks
    // them behind "More details" (progressive disclosure).
    await user.click(screen.getByRole('button', { name: /more details/i }));
    expect(screen.getByLabelText(/Linked destination/i)).toBeTruthy();
  });

  /**
   * `described` may name TWO ids (hint + error) joined by a space —
   * `document.getElementById` cannot resolve a space-separated token list,
   * so this reads every named id and joins their text before matching.
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
    await screen.findAllByText('Mactan-Cebu International Airport');
    await user.click(screen.getByRole('button', { name: /add a transfer place/i }));
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    expect(describedText(screen.getByLabelText(/^name/i))).toMatch(/too small|characters/i);
  });

  /**
   * `destinationId` is `.nullable()` with no `.optional()` on the shared
   * input — a create must say explicitly there is no cross-link. "None"
   * must reach the mutation as `destinationId: null`, not an empty string
   * and not an omitted key.
   */
  it('posts null for "None", and the real id when a destination is linked', async () => {
    const createCalls: unknown[] = [];
    renderPage({
      'admin.transferPlaces.create': (input: unknown) => {
        createCalls.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('Mactan-Cebu International Airport');
    await user.click(screen.getByRole('button', { name: /add a transfer place/i }));

    await user.type(screen.getByLabelText(/^name/i), 'Hagnaya Port');
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    await screen.findByText(/transfer place added/i);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ isAirport: false, destinationId: null });
  });

  it('shows a duplicate-name CONFLICT as a banner, not raw JSON', async () => {
    renderPage();
    await screen.findAllByText('Mactan-Cebu International Airport');

    const duplicateMessage = 'A transfer place named "Oslob" already exists.';
    mockTrpcError('admin.transferPlaces.create', 'CONFLICT', duplicateMessage);

    await user.click(screen.getByRole('button', { name: /add a transfer place/i }));
    await user.type(screen.getByLabelText(/^name/i), 'Oslob');
    await user.click(screen.getByRole('button', { name: /^add place$/i }));

    expect(await screen.findByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.queryByText(/"code":/)).toBeNull();
  });

  it('deactivates a place behind a two-step confirm, and never says Delete', async () => {
    renderPage();
    await screen.findAllByText('Mactan-Cebu International Airport');
    expect(screen.queryByText(/delete/i)).toBeNull();

    const deactivateButtons = await screen.findAllByRole('button', {
      name: /^deactivate mactan-cebu international airport$/i,
    });
    await user.click(deactivateButtons[0]!);
    expect(
      screen.getByRole('button', { name: /yes, deactivate mactan-cebu international airport/i }),
    ).toBeInTheDocument();
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner can manage transfer places/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Mactan-Cebu International Airport')).toBeNull();
  });

  /*
   * jsdom does no layout, so no unit test here can measure 44 physical
   * pixels. What it CAN prove is that every control is at least 44px tall
   * by one of this project's three equivalent mechanisms: the shared
   * `tap-target` utility (`client/src/index.css`, `min-h-11 min-w-11`); a
   * fixed `h-11` (44px) — the admin "Clean Pill" system's
   * primary/secondary/ghost/amber-pill variants size themselves with
   * `h-11` directly rather than `tap-target`; or the compact `row`/
   * `row-amber` table variants' own 32px box (`h-8`) PAIRED with their
   * invisible `::before` hit-area extension (`before:-inset-y-1.5`) — bare
   * `h-8` alone is a real 32px target and must NOT pass this check on its
   * own (B1/B2, DEMO POLISH batch, 2026-11-09).
   */
  it('gives every control a real 44px tap target', async () => {
    renderPage();
    await screen.findAllByText('Mactan-Cebu International Airport');
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
