/**
 * B3 (DEMO POLISH batch, 2026-11-09, owner decision 1) — `AdminNotFoundPage`
 * in isolation. The route-wiring behaviour (that an unmatched `/admin/*`
 * path actually reaches this component inside `AdminLayout`, rather than
 * the public catch-all) is covered separately in
 * `not-found-page.test.tsx`'s admin-subpath test.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import AdminNotFoundPage from '@/pages/admin/AdminNotFoundPage';

describe('AdminNotFoundPage', () => {
  it('renders the branded 404 body', () => {
    render(
      <MemoryRouter>
        <AdminNotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });

  it('links back to the admin dashboard, never to a guest page', () => {
    render(
      <MemoryRouter>
        <AdminNotFoundPage />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /back to dashboard/i });
    expect(link).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('link', { name: /book a transfer/i })).not.toBeInTheDocument();
  });

  it('uses the primary-pill admin button variant for its one action', () => {
    render(
      <MemoryRouter>
        <AdminNotFoundPage />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /back to dashboard/i });
    expect(link.className).toContain('h-11');
    expect(link.className).toContain('bg-brand-blue-600');
  });
});
