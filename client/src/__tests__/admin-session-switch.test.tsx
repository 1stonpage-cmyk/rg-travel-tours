/**
 * Staff accounts, 1H walkthrough finding: one browser, two people.
 *
 * `staffAuth.me` is cached for a minute. Before this was fixed, the owner
 * signed out, the dispatcher signed in on the same tab, and the layout drew
 * the OWNER's identity and Staff link from the cache - and, worse, did not
 * hold a dispatcher who owed a new password, because the cached owner owed
 * none. The server refused correctly throughout; the screen told the wrong
 * person who they were. Signing out and signing in must both drop the cache.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminChangePasswordPage from '@/pages/admin/AdminChangePasswordPage';
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import AdminLayout from '@/components/layout/AdminLayout';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

type Me = { userId: number; role: string; mustChangePassword: boolean };
const OWNER: Me = { userId: 1, role: 'owner', mustChangePassword: false };
const DISPATCHER_OWING: Me = { userId: 2, role: 'dispatcher', mustChangePassword: true };

function renderApp() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/admin/staff']}>
        <Routes>
          <Route path="admin/login" element={<AdminLoginPage />} />
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<p>dashboard body</p>} />
            <Route path="staff" element={<p>staff body</p>} />
            <Route path="change-password" element={<AdminChangePasswordPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('a different person signing in on the same tab', () => {
  it("does not inherit the previous person's identity, menu or exemption from a forced change", async () => {
    let signedInAs: Me = OWNER;
    mockTrpc({
      'staffAuth.me': () => signedInAs,
      'staffAuth.logout': () => ({ ok: true }),
      'staffAuth.login': () => {
        signedInAs = DISPATCHER_OWING;
        return { userId: 2, role: 'dispatcher', mustChangePassword: true };
      },
    });
    renderApp();

    // The owner is in, with the owner-only link.
    expect(await screen.findByRole('link', { name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await user.type(await screen.findByLabelText('Email'), 'walk-dispatch@example.test');
    await user.type(screen.getByLabelText('Password'), 'a-temporary-password-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The dispatcher is held on the forced screen as themselves.
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(screen.queryByText('Owner')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Staff' })).toBeNull();
    expect(screen.getByText('Dispatcher')).toBeInTheDocument();
  });
});
