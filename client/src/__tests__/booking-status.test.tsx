/**
 * Task 9, week 3 checkout plan — the booking-status / payment-redirect page.
 *
 * §6: "The success redirect page only reads status (polls until the
 * webhook lands). It never confirms anything itself." The second describe
 * block below is the test that actually proves that on the client: the
 * mock hands back `pending_payment` on the first poll and `confirmed` on
 * the second, and the assertion is that NEITHER `checkout.createHold` NOR
 * `checkout.startPayment` was ever called while that happened — not merely
 * that the right text appeared.
 */
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import App from '@/App';
import BookingStatusPage from '@/pages/public/BookingStatusPage';
import { bookingPagePath, BOOKING_PAGE_ROUTE } from '@rg/shared';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const BASE_STATUS = {
  ref: 'RG-7KQ4M9',
  tourTitle: 'Oslob Whale Shark Watching',
  date: '2026-12-25',
  pax: 3,
  payMode: 'deposit' as const,
  totalCentavos: 450_000,
  paidCentavos: 0,
  balanceCentavos: 450_000,
  paymentReviewRequired: false,
};

function renderStatusPage(ref = BASE_STATUS.ref, search = '') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[`/booking/${ref}${search}`]}>
        <Routes>
          <Route path="/booking/:ref" element={<BookingStatusPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('BookingStatusPage — mounted at the exact route Ruling 25 names', () => {
  it('mounts App at the path bookingPagePath() builds, derived from BOOKING_PAGE_ROUTE', async () => {
    // Pinned by value, mirroring checkout-payment.test.ts's own Ruling 25
    // assertion — if this ever drifts from the literal `startPayment`
    // sends, both go red together.
    expect(BOOKING_PAGE_ROUTE).toBe('/booking/:ref');

    mockTrpc({ 'checkout.bookingStatus': { ...BASE_STATUS, status: 'confirmed' } });

    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={[bookingPagePath(BASE_STATUS.ref)]}>
          <App />
        </MemoryRouter>
      </TrpcProviders>,
    );

    // Proof the route actually matched BookingStatusPage, not a 404/blank
    // route: its own content rendered.
    expect(await screen.findByText(/booking confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(BASE_STATUS.ref)).toBeInTheDocument();
  });
});

describe('BookingStatusPage — read only (§6)', () => {
  it('polls pending_payment through to confirmed, and never calls a mutation', async () => {
    let bookingStatusCalls = 0;
    let mutationCalls = 0;
    mockTrpc({
      'checkout.bookingStatus': () => {
        bookingStatusCalls += 1;
        return bookingStatusCalls === 1
          ? { ...BASE_STATUS, status: 'pending_payment' }
          : {
              ...BASE_STATUS,
              status: 'confirmed',
              paidCentavos: 450_000,
              balanceCentavos: 0,
            };
      },
      // Neither of the router's two real mutations should ever be reached
      // from this page. If one ever is, this fails loudly instead of
      // quietly returning something plausible.
      'checkout.createHold': () => {
        mutationCalls += 1;
        throw new Error('BookingStatusPage must never call a mutation');
      },
      'checkout.startPayment': () => {
        mutationCalls += 1;
        throw new Error('BookingStatusPage must never call a mutation');
      },
    });

    renderStatusPage();

    expect(await screen.findByText(/waiting for your payment/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/booking confirmed/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(bookingStatusCalls).toBeGreaterThanOrEqual(2);
    expect(mutationCalls).toBe(0);
  });

  it('shows a calm, specific message for a cancelled payment, not a generic failure', async () => {
    mockTrpc({ 'checkout.bookingStatus': { ...BASE_STATUS, status: 'pending_payment' } });
    renderStatusPage(BASE_STATUS.ref, '?cancelled=1');

    expect(await screen.findByText(/payment cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/\bfailed\b|\berror\b/i)).not.toBeInTheDocument();
  });

  it('shows the same generic not-found whether the mock fails for any reason — never a specific leak', async () => {
    mockTrpcError('checkout.bookingStatus');
    renderStatusPage('RG-ZZZZZZ');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/mock failure/i);
  });

  it('contains no useMutation hook at all — a structural guard on top of the behavioural one above', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../pages/public/BookingStatusPage.tsx',
    );
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/useMutation/);
  });
});
