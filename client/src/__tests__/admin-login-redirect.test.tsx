/**
 * Task 2 (owner item 1B). `AdminLayout` sends an expired/missing session to
 * `/admin/login?redirect=<encoded path>`, with router state
 * `{ sessionExpired: true }` (see `admin-layout.test.tsx`'s own redirect
 * tests for that half). This file covers what `AdminLoginPage` does with
 * both: it round-trips a SAFE `?redirect=` back to the browser on a
 * successful sign-in, refuses to round-trip an unsafe one (the open-redirect
 * case `sanitizeAdminRedirect` itself already refuses, exercised here
 * through the real login flow rather than only as a unit), and shows the
 * "session expired" notice when it arrives with that router state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

/** Stand-in for a real admin route, so a successful redirect is provable by what rendered. */
function BookingIdEcho() {
  const { id } = useParams();
  return <p>booking detail body {id}</p>;
}

function renderAdminLogin(initialEntry: string | { pathname: string; state?: unknown }) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="admin/login" element={<AdminLoginPage />} />
          <Route path="admin/change-password" element={<p>change password body</p>} />
          <Route path="admin" element={<p>admin dashboard body</p>} />
          <Route path="admin/bookings/:id" element={<BookingIdEcho />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

async function fillAndSubmit() {
  await user.type(screen.getByLabelText('Email'), 'owner@example.test');
  await user.type(screen.getByLabelText('Password'), 'a-correct-password-1');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('AdminLoginPage redirect handling', () => {
  it('sends the guest to the ?redirect= path after a successful login', async () => {
    mockTrpc({ 'staffAuth.login': { role: 'owner', mustChangePassword: false } });
    renderAdminLogin('/admin/login?redirect=%2Fadmin%2Fbookings%2F42');
    await fillAndSubmit();
    expect(await screen.findByText('booking detail body 42')).toBeInTheDocument();
  });

  it('falls back to /admin when the redirect value is unsafe', async () => {
    mockTrpc({ 'staffAuth.login': { role: 'owner', mustChangePassword: false } });
    renderAdminLogin('/admin/login?redirect=https%3A%2F%2Fevil.example.com');
    await fillAndSubmit();
    expect(await screen.findByText('admin dashboard body')).toBeInTheDocument();
  });

  it('shows "Your session expired" when navigated here with sessionExpired router state', () => {
    renderAdminLogin({ pathname: '/admin/login', state: { sessionExpired: true } });
    expect(screen.getByRole('status')).toHaveTextContent(/your session expired/i);
  });
});
