/**
 * `SiteHeader.tsx` (Task T14, owner decision 8 — transfers lead). Covers:
 * the new "Transfers" nav entry exists ahead of "Tours" (which stays fully
 * reachable, unchanged href), and the primary CTA now points at
 * `/transfer`. No existing test file covered this component before this
 * task.
 *
 * Task T16 added a `trpc.settings.get.useQuery()` call to this component (to
 * read `show_tours`), so every render here now needs `TrpcProviders` and a
 * `settings.get` mock — the nav/footer `show_tours` regression itself is
 * covered through `PublicLayout` in `layout.test.tsx`, where all three real
 * render sites (desktop nav, mobile nav, footer) are proven together; this
 * file keeps its original, narrower job (Transfers-leads-Tours ordering, the
 * CTA) with `showTours: true` so "Tours" stays reachable as before.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import SiteHeader from '@/components/layout/SiteHeader';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

function renderHeader() {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE }); // SETTINGS_FIXTURE.showTours is true.
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('SiteHeader — transfers lead the nav and the CTA (Task T14)', () => {
  it('lists "Transfers" ahead of "Tours" in the main nav, with Tours unchanged and still reachable', async () => {
    renderHeader();
    const nav = screen.getByRole('navigation', { name: /^main$/i });
    expect(await within(nav).findByRole('link', { name: 'Tours' })).toBeInTheDocument();
    const links = within(nav).getAllByRole('link');
    const labels = links.map((link) => link.textContent);

    const transfersIndex = labels.indexOf('Transfers');
    const toursIndex = labels.indexOf('Tours');
    expect(transfersIndex).toBeGreaterThanOrEqual(0);
    expect(toursIndex).toBeGreaterThan(transfersIndex);

    expect(within(nav).getByRole('link', { name: 'Tours' })).toHaveAttribute('href', '/tours');
    expect(within(nav).getByRole('link', { name: 'Transfers' })).toHaveAttribute(
      'href',
      '/transfer',
    );
  });

  it('points the primary header CTA at /transfer, labelled "Book a transfer"', () => {
    renderHeader();
    const cta = screen.getByRole('link', { name: /^book a transfer$/i });
    expect(cta).toHaveAttribute('href', '/transfer');
    // The old CTA text/destination must be gone, not merely relabelled
    // elsewhere — Tours is reachable via the nav link only now.
    expect(screen.queryByRole('link', { name: /^book a tour$/i })).not.toBeInTheDocument();
  });
});
