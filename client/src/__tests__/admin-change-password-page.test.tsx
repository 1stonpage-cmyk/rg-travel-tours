/**
 * Staff accounts, task 1F: "Set a new password" and the layout's hold on a
 * person who still owes one.
 *
 * The redirect is a convenience; the control is the server's refusal of every
 * admin procedure (`staff-must-change-gate.test.ts`). What the screen promises
 * is checked here: a mistyped confirmation or a too-short password costs no
 * request, the forced form names itself, a forced success moves on to the
 * dashboard, and the layout draws the Staff link for the owner only.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminChangePasswordPage from '@/pages/admin/AdminChangePasswordPage';
import AdminLayout from '@/components/layout/AdminLayout';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

function renderApp(path: string) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
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

async function fill(current: string, next: string, confirm: string) {
  await user.type(screen.getByLabelText(/^(temporary|current) password$/i), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Save new password' }));
}

describe('forced password change', () => {
  it('sends every admin route to the change screen while a new password is owed', async () => {
    mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: true } });
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(screen.queryByText('dashboard body')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('lets a person with nothing owed through to the dashboard', async () => {
    mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    renderApp('/admin');
    expect(await screen.findByText('dashboard body')).toBeInTheDocument();
  });

  it('sends nothing when the confirmation does not match', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: true },
      'staffAuth.changePassword': (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    });
    renderApp('/admin/change-password');
    await screen.findByRole('heading', { name: 'Set a new password' });
    await fill('temp-password-12345', 'brand-new-password-1', 'brand-new-password-2');
    expect(await screen.findByText('The two new passwords do not match.')).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the new password is the one already in use', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: true },
      'staffAuth.changePassword': (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    });
    renderApp('/admin/change-password');
    await screen.findByRole('heading', { name: 'Set a new password' });
    await fill('same-password-12345', 'same-password-12345', 'same-password-12345');
    expect(await screen.findByText('Choose a password you are not using now.')).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the new password is under twelve characters', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: true },
      'staffAuth.changePassword': (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    });
    renderApp('/admin/change-password');
    await screen.findByRole('heading', { name: 'Set a new password' });
    await fill('temp-password-12345', 'short', 'short');
    expect(await screen.findByText(/at least 12/i, { selector: 'p[role="alert"]' })).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  it('sends both passwords and moves on to the dashboard once the flag is cleared', async () => {
    const sent: unknown[] = [];
    let owed = true;
    mockTrpc({
      'staffAuth.me': () => ({ userId: 2, role: 'dispatcher', mustChangePassword: owed }),
      'staffAuth.changePassword': (input: unknown) => {
        sent.push(input);
        owed = false;
        return { ok: true };
      },
    });
    renderApp('/admin/change-password');
    await screen.findByRole('heading', { name: 'Set a new password' });
    await fill('temp-password-12345', 'brand-new-password-1', 'brand-new-password-1');
    await waitFor(() =>
      expect(sent).toEqual([
        { currentPassword: 'temp-password-12345', newPassword: 'brand-new-password-1' },
      ]),
    );
    expect(await screen.findByText('dashboard body')).toBeInTheDocument();
  });

  it("shows the server's sentence when the current password is wrong, and keeps the form", async () => {
    mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: true } });
    mockTrpcError(
      'staffAuth.changePassword',
      'UNAUTHORIZED',
      'Your current password is not right.',
    );
    renderApp('/admin/change-password');
    await screen.findByRole('heading', { name: 'Set a new password' });
    await fill('wrong-password-123', 'brand-new-password-1', 'brand-new-password-1');
    expect(await screen.findByText('Your current password is not right.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save new password' })).toBeInTheDocument();
  });
});

describe('AdminLayout account links', () => {
  it('shows Staff to the owner and a Change password link to everyone', async () => {
    mockTrpc({ 'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false } });
    renderApp('/admin');
    expect(await screen.findByRole('link', { name: 'Staff' })).toHaveAttribute(
      'href',
      '/admin/staff',
    );
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute(
      'href',
      '/admin/change-password',
    );
  });

  it.each(['finance', 'dispatcher'])('does not draw the Staff link for %s', async (role) => {
    mockTrpc({ 'staffAuth.me': { userId: 2, role, mustChangePassword: false } });
    renderApp('/admin');
    expect(await screen.findByRole('link', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Staff' })).toBeNull();
  });
});
