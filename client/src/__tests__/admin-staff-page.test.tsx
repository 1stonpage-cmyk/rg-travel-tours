/**
 * Staff accounts, task 1E: the owner's Staff screen.
 *
 * The server is the real guard (`admin-staff-users*.test.ts` on the server
 * side); what is pinned here is what the screen itself promises: the
 * temporary password goes to the server exactly as typed and is gone from the
 * field afterwards, deactivating and resetting are two-step, the owner's own
 * row offers neither, role and status are spelled out in words, and a refusal
 * from the server reads as a refusal rather than as data.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminStaffPage from '@/pages/admin/AdminStaffPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

const OWNER = {
  id: 1,
  name: 'Olivia Owner',
  email: 'olivia@example.test',
  role: 'owner',
  isActive: true,
  mustChangePassword: false,
  lastLoginAt: '2026-10-22T02:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
};
const DISPATCHER = {
  id: 2,
  name: 'Dan Dispatcher',
  email: 'dan@example.test',
  role: 'dispatcher',
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
};
const FORMER = {
  id: 3,
  name: 'Fiona Former',
  email: 'fiona@example.test',
  role: 'finance',
  isActive: false,
  mustChangePassword: false,
  lastLoginAt: '2026-09-01T02:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'admin.staffUsers.list': [OWNER, DISPATCHER, FORMER],
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminStaffPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

async function rowFor(name: string) {
  const heading = await screen.findByText(name);
  return heading.closest('li') as HTMLElement;
}

describe('AdminStaffPage', () => {
  it('spells out each role and status in words, not colour alone', async () => {
    renderPage();
    const dan = await rowFor('Dan Dispatcher');
    expect(within(dan).getByText('Role: Dispatcher')).toBeInTheDocument();
    expect(within(dan).getByText('Active')).toBeInTheDocument();
    expect(within(dan).getByText(/must set a new password/i)).toBeInTheDocument();
    expect(within(dan).getByText(/has not signed in yet/i)).toBeInTheDocument();

    const fiona = await rowFor('Fiona Former');
    expect(within(fiona).getByText('Inactive')).toBeInTheDocument();
    expect(within(fiona).getByText('Role: Finance')).toBeInTheDocument();
  });

  it('offers the owner neither Deactivate nor Reset password on their own row', async () => {
    renderPage();
    const olivia = await rowFor('Olivia Owner');
    await waitFor(() => expect(within(olivia).getByText('(You)')).toBeInTheDocument());
    expect(within(olivia).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(olivia).queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(within(olivia).queryByRole('button', { name: /reset password/i })).toBeNull();

    const dan = await rowFor('Dan Dispatcher');
    expect(within(dan).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(dan).getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
  });

  it('sends the create form exactly as typed, then empties the password field', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.staffUsers.create': (input: unknown) => {
        sent.push(input);
        return { id: 9 };
      },
    });
    await rowFor('Dan Dispatcher');

    await user.type(screen.getByLabelText('Name'), 'Nora New');
    await user.type(screen.getByLabelText('Email'), 'Nora@Example.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'finance');
    const password = screen.getByLabelText('Temporary password') as HTMLInputElement;
    await user.type(password, 'a-long-temporary-pass');
    await user.click(screen.getByRole('button', { name: 'Add staff member' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      name: 'Nora New',
      role: 'finance',
      tempPassword: 'a-long-temporary-pass',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/Nora New was added/);
    expect(password.value).toBe('');
  });

  it('refuses a short temporary password before anything is sent', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.staffUsers.create': (input: unknown) => {
        sent.push(input);
        return { id: 9 };
      },
    });
    await rowFor('Dan Dispatcher');

    await user.type(screen.getByLabelText('Name'), 'Nora New');
    await user.type(screen.getByLabelText('Email'), 'nora@example.test');
    await user.type(screen.getByLabelText('Temporary password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Add staff member' }));

    expect(await screen.findByText(/at least 12/i, { selector: 'p[role="alert"]' })).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  it("shows the server's own sentence for a duplicate email and clears the password", async () => {
    renderPage({
      'admin.staffUsers.create': () => {
        throw new Error('unused');
      },
    });
    mockTrpcError('admin.staffUsers.create', 'CONFLICT', 'That email is already used.');
    await rowFor('Dan Dispatcher');

    await user.type(screen.getByLabelText('Name'), 'Dup Person');
    await user.type(screen.getByLabelText('Email'), 'dan@example.test');
    const password = screen.getByLabelText('Temporary password') as HTMLInputElement;
    await user.type(password, 'a-long-temporary-pass');
    await user.click(screen.getByRole('button', { name: 'Add staff member' }));

    expect(await screen.findByText('That email is already used.')).toBeInTheDocument();
    expect(password.value).toBe('');
  });

  it('asks before deactivating, and sends nothing until the owner confirms', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.staffUsers.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const dan = await rowFor('Dan Dispatcher');

    await user.click(within(dan).getByRole('button', { name: 'Deactivate' }));
    const group = within(dan).getByRole('group', { name: 'Confirm deactivating Dan Dispatcher' });
    expect(calls).toHaveLength(0);
    expect(within(group).getByRole('button', { name: 'Keep Dan Dispatcher active' })).toHaveFocus();

    await user.click(within(group).getByRole('button', { name: 'Keep Dan Dispatcher active' }));
    expect(within(dan).queryByRole('group')).toBeNull();
    expect(calls).toHaveLength(0);

    await user.click(within(dan).getByRole('button', { name: 'Deactivate' }));
    await user.click(screen.getByRole('button', { name: 'Yes, deactivate Dan Dispatcher' }));
    await waitFor(() => expect(calls).toEqual([{ id: 2, isActive: false }]));
    expect(await screen.findByRole('status')).toHaveTextContent(/deactivated and signed out/);
  });

  it('reactivates an inactive account in one tap, since it signs nobody out', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.staffUsers.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const fiona = await rowFor('Fiona Former');
    await user.click(within(fiona).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(calls).toEqual([{ id: 3, isActive: true }]));
  });

  it('resets a password only through the panel, with the typed temporary password', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.staffUsers.resetPassword': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const dan = await rowFor('Dan Dispatcher');
    await user.click(within(dan).getByRole('button', { name: 'Reset password' }));
    expect(calls).toHaveLength(0);

    const form = within(dan).getByRole('form', { name: 'Reset password for Dan Dispatcher' });
    await user.type(within(form).getByLabelText('New temporary password'), 'another-long-temp-pw');
    await user.click(
      within(form).getByRole('button', { name: 'Reset and sign out Dan Dispatcher' }),
    );
    await waitFor(() => expect(calls).toEqual([{ id: 2, tempPassword: 'another-long-temp-pw' }]));
  });

  it("locks the owner's own role in the edit form", async () => {
    renderPage();
    const olivia = await rowFor('Olivia Owner');
    await waitFor(() => expect(within(olivia).getByText('(You)')).toBeInTheDocument());
    await user.click(within(olivia).getByRole('button', { name: 'Edit' }));
    expect(within(olivia).getByLabelText('Role')).toBeDisabled();
    expect(within(olivia).getByText(/cannot change your own role/i)).toBeInTheDocument();
  });

  it('shows a calm refusal, and no staff rows, when the list call itself is refused', async () => {
    // The viewer looks like an owner to the page, so the list query IS issued
    // and its refusal is what the screen has to render (the page-level role
    // check is a separate case, below).
    mockTrpcError('admin.staffUsers.list', 'FORBIDDEN', 'Not allowed for your role.');
    mockTrpc({ 'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false } });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminStaffPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(
      await screen.findByText('Only the owner can manage staff accounts.', {
        selector: 'p[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Dan Dispatcher')).toBeNull();
    expect(screen.queryByText('Not allowed for your role.')).toBeNull();
  });
});

describe('someone who is not the owner', () => {
  it('is told so, and is not shown the form or the list', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(
      await screen.findByText('Only the owner can manage staff accounts.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff member' })).toBeNull();
    expect(screen.queryByText('Olivia Owner')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });
});
