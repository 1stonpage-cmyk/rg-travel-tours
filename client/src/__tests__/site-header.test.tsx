/**
 * `SiteHeader.tsx` (Task T14, owner decision 8 — transfers lead). Covers:
 * the new "Transfers" nav entry exists ahead of "Tours" (which stays fully
 * reachable, unchanged href), and the primary CTA now points at
 * `/transfer`. No existing test file covered this component before this
 * task.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import SiteHeader from '@/components/layout/SiteHeader';

function renderHeader() {
  return render(
    <MemoryRouter>
      <SiteHeader />
    </MemoryRouter>,
  );
}

describe('SiteHeader — transfers lead the nav and the CTA (Task T14)', () => {
  it('lists "Transfers" ahead of "Tours" in the main nav, with Tours unchanged and still reachable', () => {
    renderHeader();
    const nav = screen.getByRole('navigation', { name: /^main$/i });
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
