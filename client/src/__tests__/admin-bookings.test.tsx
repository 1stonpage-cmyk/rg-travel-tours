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
import { render, screen, waitFor, within } from '@testing-library/react';
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
      visibleToDriver: true,
      userId: 1,
      createdAt: new Date().toISOString(),
    },
    {
      id: 4,
      note: 'Guest disputed the price, do not discuss.',
      visibleToDriver: false,
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

/**
 * Week 6 plan, Task 11 — the CASH half of the same screen (§8 item 5).
 *
 * A guest's receipt and a driver's cash both wait in this queue, and they ask
 * different questions: "does this screenshot match the amount" versus "did
 * this person actually hand the money over". So the panel is its own panel,
 * and the driver is NAMED in it — an id nobody resolves is not an answer to
 * the second question.
 *
 * `server/src/__tests__/admin-cash-verify.test.ts` proves the refusals and
 * the credited-once guarantee. What is asserted here is only what the screen
 * does: it names the claimant, it sends the right payment id, and it offers a
 * dispatcher nothing.
 */
const CASH_DETAIL = {
  ...DETAIL,
  status: 'in_progress',
  paidCentavos: 135_000,
  payments: [
    {
      id: 77,
      type: 'payment',
      provider: 'manual',
      method: 'cash',
      amountCentavos: 315_000,
      status: 'pending',
      txnRef: null,
      receiptPath: null,
      rejectReason: null,
      verifiedBy: null,
      verifiedAt: null,
      collectedByDriverId: 12,
      collectedByDriverName: 'Noel Cuizon',
      createdAt: new Date().toISOString(),
    },
  ],
};

describe('AdminBookingDetailPage — the cash a driver says they took', () => {
  it('names the driver and offers finance the confirmation', async () => {
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    renderDetail();

    const panel = await screen.findByRole('region', { name: /cash a driver says they collected/i });
    /*
     * The claimant, in the panel and on the payment line, so the name
     * survives the approval.
     *
     * Matched on the whole sentence rather than the bare name (D2): the
     * refusal button added below names the driver too, so `/Noel Cuizon/`
     * inside this panel is now two matches. Narrowing is the right fix —
     * `getAllByText` would have kept passing if the panel's own line lost
     * the name altogether, which is the thing this asserts.
     */
    expect(within(panel).getByText(/Noel Cuizon recorded ₱3,150 on tour day/)).toBeInTheDocument();
    expect(screen.getByText(/collected by Noel Cuizon/i)).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: /confirm ₱3,150 received/i }),
    ).toBeInTheDocument();
  });

  it('sends the claim id it was shown', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
      'admin.bookings.approveCash': (input: unknown) => {
        sent.push(input);
        return { bookingStatus: 'in_progress', paymentReviewRequired: false };
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /confirm ₱3,150 received/i }));
    expect(sent).toEqual([{ paymentId: 77 }]);
  });

  /** §9: a dispatcher runs the day and does not decide that money arrived. */
  it('offers a dispatcher nothing to click', async () => {
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 3, role: 'dispatcher' },
    });
    renderDetail();

    // The page still loads, and still SAYS a claim is outstanding — a
    // dispatcher may need to know that; they may not act on it.
    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.getByText(/collected by Noel Cuizon/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /cash a driver says they collected/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('shows a refused confirmation in amber rather than crashing', async () => {
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    mockTrpcError(
      'admin.bookings.approveCash',
      'CONFLICT',
      'This cash has already been handled (it is "paid"). Refresh the queue.',
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: /confirm ₱3,150 received/i }));

    // Scoped to the cash panel: `AssignPanel` raises its own alert here.
    const panel = screen.getByRole('region', { name: /cash a driver says they collected/i });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/already been handled/i);
  });

  /**
   * Task 11 review, fix 3. `recordPendingCash()` deliberately does NOT
   * merge two taps of the driver's button — they are "two genuinely
   * separate claims of cash, which finance must see as two rows and
   * resolve". The screen used `find`, so the second claim was invisible
   * and un-approvable: money missing from the screen rather than from the
   * till.
   */
  it('shows one panel per claim when a driver recorded cash twice', async () => {
    const [first] = CASH_DETAIL.payments;
    mockTrpc({
      'admin.bookings.detail': {
        ...CASH_DETAIL,
        payments: [first, { ...first, id: 78, amountCentavos: 120_000 }],
      },
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    renderDetail();

    const panels = await screen.findAllByRole('region', {
      name: /cash a driver says they collected/i,
    });
    expect(panels).toHaveLength(2);
    // Each with its OWN amount and its own button, so each id can be
    // approved separately.
    expect(screen.getByRole('button', { name: /confirm ₱3,150 received/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm ₱1,200 received/i })).toBeInTheDocument();
  });

  /**
   * Task 11 review, fix 2. The server scopes its lookup to `type='payment'
   * AND provider='manual' AND method='cash'`; this finder carried only two
   * of the four. Nothing writes a pending manual cash REFUND today, so
   * there was no live risk — but a screen offering a button the server
   * then refuses is the shape of the defect, not the absence of one.
   */
  /* ==================================================================
   * D2 — refusing a claim whose money never arrived.
   *
   * The screen half of the server-side guarantee: a refusal needs a typed
   * reason, it names the driver and the amount so the wrong claim is not
   * refused by accident, and each claim is refused on its own.
   *
   * `server/src/__tests__/admin-cash-verify.test.ts` proves the money and
   * the roles. What is asserted here is only what the screen does.
   * ================================================================== */
  const REJECT_BUTTON = /record that noel cuizon.s ₱3,150 never arrived/i;

  it('offers the refusal to finance, naming the driver and the amount', async () => {
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    renderDetail();

    const panel = await screen.findByRole('region', { name: /cash a driver says they collected/i });
    expect(within(panel).getByRole('button', { name: REJECT_BUTTON })).toBeInTheDocument();
    // A visible label, not a placeholder standing in for one.
    expect(within(panel).getByLabelText(/why the cash was not received/i)).toBeInTheDocument();
  });

  /** §9 again: a dispatcher may read the claim and may not decide about it. */
  it('offers a dispatcher no way to refuse it either', async () => {
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 3, role: 'dispatcher' },
    });
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /never arrived/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/why the cash was not received/i)).not.toBeInTheDocument();
  });

  /** A refusal is a finding about a person, so it may not be anonymous. */
  it('will not send a refusal with no reason', async () => {
    let calls = 0;
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
      'admin.bookings.rejectCash': () => {
        calls += 1;
        return { ref: 'RG-AAAAA1' };
      },
    });
    renderDetail();

    const button = await screen.findByRole('button', { name: REJECT_BUTTON });
    expect(button).toBeDisabled();

    // Whitespace is not a reason either — the server trims before it checks.
    await userEvent.type(screen.getByLabelText(/why the cash was not received/i), '   ');
    expect(screen.getByRole('button', { name: REJECT_BUTTON })).toBeDisabled();
    expect(calls).toBe(0);
  });

  it('sends the claim id and the reason it was given, trimmed', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': CASH_DETAIL,
      'staffAuth.me': { userId: 2, role: 'finance' },
      'admin.bookings.rejectCash': (input: unknown) => {
        sent.push(input);
        return { ref: 'RG-AAAAA1' };
      },
    });
    renderDetail();

    await userEvent.type(
      await screen.findByLabelText(/why the cash was not received/i),
      '  The driver never handed this in.  ',
    );
    await userEvent.click(screen.getByRole('button', { name: REJECT_BUTTON }));

    expect(sent).toEqual([{ paymentId: 77, reason: 'The driver never handed this in.' }]);
  });

  /**
   * Two claims, refused independently — the same reason the panels are one
   * per claim. A shared reason box or an unscoped error would attach one
   * claim's evidence to the other's refusal.
   */
  it('keeps two claims’ reasons and errors apart', async () => {
    const [first] = CASH_DETAIL.payments;
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': {
        ...CASH_DETAIL,
        payments: [first, { ...first, id: 78, amountCentavos: 120_000 }],
      },
      'staffAuth.me': { userId: 2, role: 'finance' },
      'admin.bookings.rejectCash': (input: unknown) => {
        sent.push(input);
        return { ref: 'RG-AAAAA1' };
      },
    });
    renderDetail();

    const panels = await screen.findAllByRole('region', {
      name: /cash a driver says they collected/i,
    });
    expect(panels).toHaveLength(2);

    // Typing in the second claim's box must not arm the first claim's button.
    await userEvent.type(
      within(panels[1]!).getByLabelText(/why the cash was not received/i),
      'Only ₱800 came in.',
    );
    expect(within(panels[0]!).getByRole('button', { name: /never arrived/i })).toBeDisabled();

    await userEvent.click(within(panels[1]!).getByRole('button', { name: /never arrived/i }));
    expect(sent).toEqual([{ paymentId: 78, reason: 'Only ₱800 came in.' }]);
  });

  /*
   * The title says what the body checks and no more (review finding 3,
   * 2026-10-16): an `alert` carrying the server's sentence, under the claim
   * whose mutation failed and not the other one. The COLOUR is not asserted
   * here and does not need to be — `no-red.test.ts` and `contrast.test.ts`
   * read the real source for every class string in the tree, so a red or
   * AA-failing pairing fails the build whatever this file says.
   */
  it('shows a failed refusal as an alert, only under the claim it belongs to', async () => {
    const [first] = CASH_DETAIL.payments;
    mockTrpc({
      'admin.bookings.detail': {
        ...CASH_DETAIL,
        payments: [first, { ...first, id: 78, amountCentavos: 120_000 }],
      },
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    mockTrpcError(
      'admin.bookings.rejectCash',
      'CONFLICT',
      'This cash has already been handled (it is "paid"). Refresh the queue.',
    );
    renderDetail();

    const panels = await screen.findAllByRole('region', {
      name: /cash a driver says they collected/i,
    });
    await userEvent.type(
      within(panels[0]!).getByLabelText(/why the cash was not received/i),
      'Never arrived.',
    );
    await userEvent.click(within(panels[0]!).getByRole('button', { name: /never arrived/i }));

    expect(await within(panels[0]!).findByRole('alert')).toHaveTextContent(/already been handled/i);
    expect(within(panels[1]!).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers nothing for a pending row that is not a manual cash payment', async () => {
    const [first] = CASH_DETAIL.payments;
    mockTrpc({
      'admin.bookings.detail': {
        ...CASH_DETAIL,
        payments: [{ ...first, type: 'refund' }],
      },
      'staffAuth.me': { userId: 2, role: 'finance' },
    });
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /cash a driver says they collected/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });
});

/* ====================================================================
 * D6 — writing a staff note, and choosing whether the driver reads it.
 *
 * `server/src/__tests__/booking-notes.test.ts` proves the filter, the
 * default in the database and the audit row. What is asserted here is only
 * what the screen does: the safe default, the decision reaching the server
 * as stated, visibility readable as words, and no form for a role that may
 * not write notes.
 * ================================================================== */
describe('AdminBookingDetailPage — staff notes', () => {
  const CHECKBOX = /show this note to the driver/i;

  it('says in words which notes the driver can see', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    renderDetail();

    const shared = (await screen.findByText(/early pickup/i)).closest('li')!;
    const office = screen.getByText(/disputed the price/i).closest('li')!;
    expect(within(shared).getByText('Driver can see this')).toBeInTheDocument();
    expect(within(office).getByText('Office only')).toBeInTheDocument();
    // Each note carries exactly one of the two phrases.
    expect(within(shared).queryByText('Office only')).not.toBeInTheDocument();
    expect(within(office).queryByText('Driver can see this')).not.toBeInTheDocument();
  });

  it('starts with the box unticked and says what that means', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    renderDetail();

    const box = await screen.findByLabelText(CHECKBOX);
    expect(box).not.toBeChecked();
    expect(screen.getByText(/office-only unless this is ticked/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/add a note/i)).toBeInTheDocument();
  });

  it('sends visibleToDriver false when the box is left alone', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.addNote': (input: unknown) => {
        sent.push(input);
        return { id: 9 };
      },
    });
    renderDetail();

    await userEvent.type(await screen.findByLabelText(/add a note/i), '  Call the guest first.  ');
    await userEvent.click(screen.getByRole('button', { name: /save note/i }));

    expect(sent).toEqual([{ bookingId: 1, note: 'Call the guest first.', visibleToDriver: false }]);
  });

  it('sends visibleToDriver true when the box is ticked', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 3, role: 'dispatcher' },
      'admin.bookings.addNote': (input: unknown) => {
        sent.push(input);
        return { id: 9 };
      },
    });
    renderDetail();

    await userEvent.type(await screen.findByLabelText(/add a note/i), 'Waiting at gate two.');
    await userEvent.click(screen.getByLabelText(CHECKBOX));
    await userEvent.click(screen.getByRole('button', { name: /save note/i }));

    expect(sent).toEqual([{ bookingId: 1, note: 'Waiting at gate two.', visibleToDriver: true }]);
  });

  it('will not send an empty or whitespace note', async () => {
    let calls = 0;
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.addNote': () => {
        calls += 1;
        return { id: 9 };
      },
    });
    renderDetail();

    const button = await screen.findByRole('button', { name: /save note/i });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/add a note/i), '   ');
    expect(screen.getByRole('button', { name: /save note/i })).toBeDisabled();
    expect(calls).toBe(0);
  });

  it('clears the text and puts the box back to unticked after a save', async () => {
    mockTrpc({
      'admin.bookings.detail': DETAIL,
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.bookings.addNote': { id: 9 },
    });
    renderDetail();

    const text = await screen.findByLabelText(/add a note/i);
    await userEvent.type(text, 'Shared note.');
    await userEvent.click(screen.getByLabelText(CHECKBOX));
    expect(screen.getByLabelText(CHECKBOX)).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /save note/i }));

    await waitFor(() => expect(screen.getByLabelText(/add a note/i)).toHaveValue(''));
    // The safe default is re-asserted after every write, not only on first load.
    expect(screen.getByLabelText(CHECKBOX)).not.toBeChecked();
  });

  it('shows the server refusal in an alert and keeps what was typed', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 1, role: 'owner' } });
    mockTrpcError('admin.bookings.addNote', 'NOT_FOUND', 'No booking with that id.');
    renderDetail();

    await userEvent.type(await screen.findByLabelText(/add a note/i), 'Lost note?');
    await userEvent.click(screen.getByRole('button', { name: /save note/i }));

    // Scoped to the note form: other panels on this page raise their own alerts.
    const form = screen.getByLabelText(/add a note/i).closest('form')!;
    expect(await within(form).findByRole('alert')).toHaveTextContent(/no booking with that id/i);
    expect(screen.getByLabelText(/add a note/i)).toHaveValue('Lost note?');
  });

  it('draws no form for a role that may not write notes', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 8, role: 'driver' } });
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/add a note/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(CHECKBOX)).not.toBeInTheDocument();
    // The notes themselves still read.
    expect(screen.getByText(/early pickup/i)).toBeInTheDocument();
  });

  it('draws no form while who you are is unknown', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL });
    mockTrpcError('staffAuth.me', 'UNAUTHORIZED', 'Admin sign-in required.');
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'RG-AAAAA1' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/add a note/i)).not.toBeInTheDocument();
  });

  it('offers finance the form too', async () => {
    mockTrpc({ 'admin.bookings.detail': DETAIL, 'staffAuth.me': { userId: 2, role: 'finance' } });
    renderDetail();
    expect(await screen.findByLabelText(/add a note/i)).toBeInTheDocument();
  });
});
