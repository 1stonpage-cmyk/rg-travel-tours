/**
 * The payment-checks screen: a queue of bookings waiting on a human, the
 * selected booking's money in figures and in words, and the same decision
 * controls the booking screen offers.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminPaymentsPage from '@/pages/admin/AdminPaymentsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const row = (ref: string, leadName: string, overrides: Record<string, unknown> = {}) => ({
  id: ref === 'RG-AAAAA1' ? 1 : 2,
  ref,
  status: 'pending_verification',
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-12-25',
  pax: 3,
  leadName,
  totalCentavos: 450_000,
  paidCentavos: 0,
  paymentReviewRequired: false,
  createdAt: new Date().toISOString(),
  pendingPaymentCreatedAt: TWO_HOURS_AGO,
  attemptNumber: 1,
  method: 'GCash',
  phoneMasked: '•••••••4567',
  ...overrides,
});

const QUEUE = {
  items: [
    row('RG-AAAAA1', 'Maria Santos', { attemptNumber: 2, method: 'Bank transfer' }),
    row('RG-BBBBB2', 'Jun Reyes'),
  ],
  total: 2,
  limit: 100,
  offset: 0,
};

const DETAIL = {
  id: 1,
  ref: 'RG-AAAAA1',
  status: 'pending_verification',
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-12-25',
  pax: 3,
  payMode: 'full',
  leadName: 'Maria Santos',
  totalCentavos: 450_000,
  paidCentavos: 0,
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
    },
  ],
};

function renderPage(path = '/admin/payments') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <AdminPaymentsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function mockFor(role: string, extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role, mustChangePassword: false },
    'admin.bookings.list': QUEUE,
    'admin.bookings.detail': DETAIL,
    ...extra,
  });
}

afterEach(resetTrpcMock);

describe('AdminPaymentsPage', () => {
  it('lists every waiting booking and opens the first one', async () => {
    mockFor('finance');
    renderPage();
    const queue = await screen.findByRole('region', { name: /waiting receipts/i });
    expect(within(queue).getAllByRole('link')).toHaveLength(2);
    expect(within(queue).getByText('Jun Reyes', { exact: false })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /RG-AAAAA1 · Maria Santos/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/2 bookings are waiting/i);
  });

  it('marks the selected booking with aria-current, and honours ?ref=', async () => {
    mockFor('finance');
    renderPage('/admin/payments?ref=RG-BBBBB2');
    const queue = await screen.findByRole('region', { name: /waiting receipts/i });
    const links = within(queue).getAllByRole('link');
    expect(links[0]?.getAttribute('aria-current')).toBeNull();
    expect(links[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('states the expected amount in figures and in words', async () => {
    mockFor('finance');
    renderPage();
    const box = (await screen.findByText(/amount the system expects/i)).parentElement!;
    expect(box.textContent).toMatch(/₱4,500/);
    expect(box.textContent).toMatch(/four thousand five hundred pesos/i);
  });

  it('sends the approval for the pending payment id', async () => {
    const sent: unknown[] = [];
    mockFor('owner', {
      'admin.bookings.approveReceipt': (input: unknown) => {
        sent.push(input);
        return { bookingStatus: 'confirmed' };
      },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /approve ₱4,500/i }));
    expect(sent).toEqual([{ paymentId: 41 }]);
  });

  it('shows a dispatcher the queue but no approve or reject button', async () => {
    mockFor('dispatcher');
    renderPage();
    await screen.findByRole('heading', { name: /RG-AAAAA1 · Maria Santos/ });
    expect(await screen.findByText(/only the owner and finance can approve/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  /**
   * **The receipt link, by role** (owner decision 2026-10-23, Q2).
   *
   * `/api/receipts/:name` admits owner and finance and answers everyone else
   * the same 404 it answers a stranger — `server/src/__tests__/
   * receipts-route.test.ts` is where that is proved, and it is the guard.
   * What is pinned here is that this screen does not DANGLE the link at a
   * dispatcher, which matters more than it sounds: the dashboard's
   * `payments_to_verify` alert is drawn for all three roles and links
   * straight here, and the queue itself is `bookingsView`, so a dispatcher
   * arrives on this page by clicking their own dashboard rather than by
   * guessing a URL. An unconditional link is a dead end they reach in normal
   * use.
   *
   * Asserted in both directions, because a gate that hides it from everyone
   * would satisfy the dispatcher half on its own.
   */
  it('offers the receipt link to a finance user', async () => {
    mockFor('finance');
    renderPage();
    expect(await screen.findByRole('link', { name: /open receipt/i })).toHaveAttribute(
      'href',
      '/api/receipts/a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg',
    );
  });

  it('offers it to an owner too', async () => {
    mockFor('owner');
    renderPage();
    expect(await screen.findByRole('link', { name: /open receipt/i })).toBeTruthy();
  });

  it('offers a dispatcher the queue and the payment reference but NO receipt link', async () => {
    mockFor('dispatcher');
    renderPage();

    await screen.findByRole('heading', { name: /RG-AAAAA1 · Maria Santos/ });
    // Still the queue they are allowed to read (§9's `bookingsView`).
    expect(screen.getByText('GC1234567890'), 'the dispatcher lost the payment trail').toBeTruthy();
    expect(screen.queryByRole('link', { name: /open receipt/i })).toBeNull();
  });

  /**
   * Task 15 (7L) — the queue card carries upload age, attempt number, method
   * and a masked phone, server-computed and never the full number.
   */
  it('shows the method, attempt number and upload age on each queue card', async () => {
    mockFor('finance');
    renderPage();
    const queue = await screen.findByRole('region', { name: /waiting receipts/i });

    const firstCard = within(queue).getAllByRole('link')[0]!;
    expect(firstCard.textContent).toMatch(/Bank transfer/);
    expect(firstCard.textContent).toMatch(/2nd try/);
    expect(firstCard.textContent).toMatch(/2 hours ago/i);
    expect(firstCard.textContent).toMatch(/•••••••4567/);

    const secondCard = within(queue).getAllByRole('link')[1]!;
    expect(secondCard.textContent).toMatch(/1st try/);
  });

  /** The masked phone is server data on the row — the screen never sees the real number. */
  it('never renders the full phone number anywhere on the page', async () => {
    mockFor('finance');
    renderPage();
    await screen.findByRole('heading', { name: /RG-AAAAA1 · Maria Santos/ });
    expect(document.body.textContent).not.toMatch(/9171234567/);
  });

  /**
   * The inline preview (Task 15, 7L): an `<img>` at the authenticated
   * receipt route, beside the existing "Open receipt" link, for an image
   * receipt only.
   */
  it('renders an inline preview for an image receipt, beside the link', async () => {
    mockFor('finance');
    renderPage();
    const img = await screen.findByRole('img', { name: /receipt/i });
    expect(img).toHaveAttribute('src', '/api/receipts/a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg');
    expect(await screen.findByRole('link', { name: /open receipt/i })).toBeTruthy();
  });

  it('renders NO inline preview for a PDF receipt, only the link', async () => {
    mockFor('finance', {
      'admin.bookings.detail': {
        ...DETAIL,
        payments: [{ ...DETAIL.payments[0], receiptPath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.pdf' }],
      },
    });
    renderPage();
    await screen.findByRole('link', { name: /open receipt/i });
    expect(screen.queryByRole('img', { name: /receipt/i })).toBeNull();
  });

  it('offers neither the inline preview nor the link to a dispatcher', async () => {
    mockFor('dispatcher');
    renderPage();
    await screen.findByRole('heading', { name: /RG-AAAAA1 · Maria Santos/ });
    expect(screen.queryByRole('img', { name: /receipt/i })).toBeNull();
  });

  it('says so when nothing is waiting', async () => {
    mockFor('finance', { 'admin.bookings.list': { items: [], total: 0, limit: 100, offset: 0 } });
    renderPage();
    expect(await screen.findByText(/nothing is waiting for a payment check/i)).toBeTruthy();
  });

  it('shows an alert, not a blank page, when the queue cannot load', async () => {
    mockFor('finance');
    mockTrpcError('admin.bookings.list', 'INTERNAL_SERVER_ERROR', 'boom');
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not load the payment checks/i,
    );
  });
});
