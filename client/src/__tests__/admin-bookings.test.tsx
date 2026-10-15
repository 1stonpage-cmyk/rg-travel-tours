/**
 * Week 4 plan, Task 11 — the admin bookings screens (BUILD_SPEC §9's 4D).
 *
 * `server/src/__tests__/admin-bookings.test.ts` proves the role rules and
 * the filtering. This file proves the screens: that the filters reach the
 * server rather than being applied in the browser, that the list is a
 * table on a laptop and cards on a phone, and — the one that matters — that
 * the approve and reject controls are offered to an owner or a finance
 * user and to nobody else.
 *
 * **Hiding a button is not access control**, and this file does not pretend
 * otherwise: the server refuses a dispatcher either way (proved on the
 * server side). What is asserted here is that the UI does not offer an
 * action it knows will be refused.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminBookingDetailPage from '@/pages/admin/AdminBookingDetailPage';
import AdminBookingsPage from '@/pages/admin/AdminBookingsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const LIST = {
  items: [
    {
      id: 1,
      ref: 'RG-AAAAA1',
      status: 'pending_verification',
      tourTitle: 'Oslob Whale Shark Watching',
      tourDate: '2026-12-25',
      pax: 3,
      leadName: 'Maria Santos',
      totalCentavos: 450_000,
      paidCentavos: 0,
      paymentReviewRequired: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: 2,
      ref: 'RG-BBBBB2',
      status: 'confirmed',
      tourTitle: 'Kawasan Falls Canyoneering',
      tourDate: '2026-12-28',
      pax: 2,
      leadName: 'Juan Dela Cruz',
      totalCentavos: 600_000,
      paidCentavos: 180_000,
      paymentReviewRequired: false,
      createdAt: new Date().toISOString(),
    },
  ],
  total: 2,
  limit: 25,
  offset: 0,
};

const DETAIL = {
  id: 1,
  ref: 'RG-AAAAA1',
  status: 'pending_verification',
  tourId: 9,
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-12-25',
  pax: 3,
  payMode: 'full',
  leadName: 'Maria Santos',
  leadEmail: 'maria@example.test',
  leadPhone: '09170000000',
  subtotalCentavos: 450_000,
  discountCentavos: 0,
  totalCentavos: 450_000,
  paidCentavos: 0,
  paymentReviewRequired: false,
  holdExpiresAt: null,
  driverId: null,
  vanId: null,
  createdAt: new Date().toISOString(),
  payments: [
    {
      id: 41,
      type: 'payment',
      provider: 'manual',
      method: 'gcash',
      amountCentavos: 450_000,
      status: 'pending',
      txnRef: 'GC1234567890',
      receiptPath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg',
      rejectReason: null,
      verifiedBy: null,
      verifiedAt: null,
      createdAt: new Date().toISOString(),
    },
  ],
  addons: [{ id: 5, name: 'Snorkel set', qty: 2, priceCentavos: 25_000, perPerson: true }],
  notes: [
    {
      id: 3,
      note: 'Guest asked for an early pickup.',
      userId: 1,
      createdAt: new Date().toISOString(),
    },
  ],
  audit: [
    {
      id: 77,
      actorType: 'customer',
      actorId: null,
      action: 'payment.receipt_submitted',
      entity: 'payments',
      entityId: 41,
      data: {},
      createdAt: new Date().toISOString(),
    },
  ],
  assignment: null,
};

function renderList() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/admin/bookings']}>
        <Routes>
          <Route path="/admin/bookings" element={<AdminBookingsPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function renderDetail() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/admin/bookings/RG-AAAAA1']}>
        <Routes>
          <Route path="/admin/bookings/:ref" element={<AdminBookingDetailPage />} />
          <Route path="/admin/bookings" element={<p>bookings list</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminBookingsPage', () => {
  it('lists bookings as a table and as cards, with the money as sent', async () => {
    mockTrpc({ 'admin.bookings.list': LIST });
    renderList();

    expect(await screen.findAllByText('RG-AAAAA1')).toHaveLength(2); // card + table row
    expect(screen.getAllByText(/oslob whale shark/i).length).toBeGreaterThan(0);
    // Paid / total, both formatted from what the server sent.
    expect(screen.getAllByText('₱0 / ₱4,500').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₱1,800 / ₱6,000').length).toBeGreaterThan(0);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  /**
   * **The filters go to the server.** A browser-side filter over a page of
   * twenty-five rows answers a different question from the one the admin
   * asked, so the assertion is on what was SENT.
   */
  it('sends the status filter to the server, and resets to the first page', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockTrpc({
      'admin.bookings.list': (input: unknown) => {
        sent.push(input as Record<string, unknown>);
        return { ...LIST, total: 60 };
      },
    });
    renderList();
    await screen.findByRole('table');

    /*
     * Page forward FIRST. The reset is invisible from page one — a mutation
     * run caught exactly that: deleting `setOffset(0)` left this test green
     * because the offset was already zero. An admin who filters from page
     * three and is shown page three of the NEW results is reading rows
     * nobody asked for.
     */
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(sent.at(-1)).toMatchObject({ offset: 25 });

    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'cancelled');

    expect(sent.at(-1)).toMatchObject({ status: 'cancelled', offset: 0 });
  });

  it('sends the date range and the verification filter', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockTrpc({
      'admin.bookings.list': (input: unknown) => {
        sent.push(input as Record<string, unknown>);
        return LIST;
      },
    });
    renderList();
    await screen.findByRole('table');

    await userEvent.type(screen.getByLabelText(/tour date from/i), '2026-12-01');
    await userEvent.click(screen.getByLabelText(/waiting for verification/i));

    expect(sent.at(-1)).toMatchObject({ from: '2026-12-01', awaitingVerification: true });
  });

  it('pages forwards and back, and disables what it cannot do', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockTrpc({
      'admin.bookings.list': (input: unknown) => {
        sent.push(input as Record<string, unknown>);
        return { ...LIST, total: 60 };
      },
    });
    renderList();
    await screen.findByRole('table');

    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(sent.at(-1)).toMatchObject({ offset: 25 });
  });

  it('says so plainly when nothing matches', async () => {
    mockTrpc({ 'admin.bookings.list': { items: [], total: 0, limit: 25, offset: 0 } });
    renderList();
    expect(await screen.findByText(/no bookings match those filters/i)).toBeInTheDocument();
  });

  it('shows an amber notice, never a crash, when the list is refused', async () => {
    mockTrpcError('admin.bookings.list', 'UNAUTHORIZED', 'Admin sign-in required.');
    renderList();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load the bookings/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('AdminBookingDetailPage', () => {
  it('shows the guest, the money, the payments, the notes and the trail', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.getByText('maria@example.test')).toBeInTheDocument();
    expect(screen.getByText('₱4,500')).toBeInTheDocument();
    expect(screen.getByText(/gcash/i)).toBeInTheDocument();
    expect(screen.getByText(/2 × snorkel set/i)).toBeInTheDocument();
    expect(screen.getByText(/early pickup/i)).toBeInTheDocument();
    expect(screen.getByText(/payment.receipt_submitted/)).toBeInTheDocument();
  });

  /** The receipt opens through the authenticated route, in its own tab. */
  it('links the receipt to the authenticated route', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    renderDetail();

    const link = await screen.findByRole('link', { name: /open receipt/i });
    expect(link).toHaveAttribute('href', '/api/receipts/a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('offers approve and reject to an owner', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    renderDetail();

    expect(await screen.findByRole('button', { name: /approve ₱4,500/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject and ask for another/i })).toBeInTheDocument();
  });

  it('offers them to a finance user too', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 2, role: 'finance' } });
    renderDetail();
    expect(await screen.findByRole('button', { name: /approve ₱4,500/i })).toBeInTheDocument();
  });

  /**
   * §9: a dispatcher runs the day and does not decide that money arrived.
   * The server refuses them; this is the UI not offering it.
   */
  it('offers NEITHER to a dispatcher', async () => {
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 3, role: 'dispatcher' },
    });
    renderDetail();

    // The page still loads — §9 gives a dispatcher the view.
    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('offers no decision when there is no pending receipt', async () => {
    mockTrpc({
      'admin.bookings.detail': {
        ...DETAIL,
        status: 'confirmed',
        paidCentavos: 450_000,
        payments: [{ ...DETAIL.payments[0], status: 'paid' }],
      },
      'staffAuth.me': { userId: 1, role: 'owner' },
    });
    renderDetail();

    await screen.findByRole('heading', { name: 'RG-AAAAA1' });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('sends the approval for the pending payment id', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.approveReceipt': (input: unknown) => {
        sent.push(input);
        return { bookingStatus: 'confirmed' };
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /approve ₱4,500/i }));
    expect(sent).toEqual([{ paymentId: 41 }]);
  });

  /** A rejection needs a reason — the guest reads it, and the server insists. */
  it('will not send a rejection with no reason', async () => {
    let calls = 0;
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.rejectReceipt': () => {
        calls += 1;
        return { bookingStatus: 'pending_payment', reuploadBy: null };
      },
    });
    renderDetail();

    const button = await screen.findByRole('button', { name: /reject and ask for another/i });
    expect(button).toBeDisabled();
    expect(calls).toBe(0);
  });

  it('sends the reason it was given, trimmed', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.rejectReceipt': (input: unknown) => {
        sent.push(input);
        return { bookingStatus: 'pending_payment', reuploadBy: null };
      },
    });
    renderDetail();

    await userEvent.type(
      await screen.findByLabelText(/reason, if you are rejecting it/i),
      '  The amount is short by 500 pesos.  ',
    );
    await userEvent.click(screen.getByRole('button', { name: /reject and ask for another/i }));

    expect(sent).toEqual([{ paymentId: 41, reason: 'The amount is short by 500 pesos.' }]);
  });

  it('shows the server refusal in amber rather than crashing', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    mockTrpcError(
      'admin.bookings.approveReceipt',
      'CONFLICT',
      'This receipt has already been handled (it is "paid"). Refresh the queue.',
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /approve ₱4,500/i }));

    /*
     * SCOPED to the verification section, not `screen`-wide.
     *
     * Task 12 mounted `AssignPanel` on this page (§9 lists "Assign van +
     * driver" under Bookings detail), and that panel raises its own
     * `role="alert"` when its van/driver options fail to load — which they
     * do here, because this test's mock does not define
     * `admin.calendar.dayOptions`. So the page now legitimately has two
     * alert regions and a bare `findByRole('alert')` is ambiguous.
     *
     * Scoping is the right fix rather than loosening to `findAllByRole`:
     * this test is about the APPROVAL refusal specifically, and it should
     * say which alert it means.
     */
    const verification = screen.getByRole('region', { name: /verify this receipt/i });
    expect(await within(verification).findByRole('alert')).toHaveTextContent(
      /already been handled/i,
    );
  });

  it('says so plainly when the booking cannot be loaded', async () => {
    mockTrpcError('admin.bookings.detail', 'NOT_FOUND', 'No booking with that reference.');
    renderDetail();

    expect(
      await screen.findByRole('heading', { name: /booking not available/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('maria@example.test')).not.toBeInTheDocument();
  });
});
