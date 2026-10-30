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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import BookingStatusPage from '@/pages/public/BookingStatusPage';
import { bookingPagePath, BOOKING_PAGE_ROUTE } from '@rg/shared';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';

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

  it('contains no useMutation hook directly in this file — the one retry action is delegated to <PayNowButton>', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../pages/public/BookingStatusPage.tsx',
    );
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/useMutation/);
  });
});

/**
 * Task 8b: the gap a code review found — this page's cancelled copy used to
 * SAY "you can try paying again" with no actual way to do it. These prove
 * the real affordance: the button only appears for a cancelled,
 * still-pending booking, calls `checkout.startPayment` with the booking's
 * own ref, and leaves for the redirect URL on success — the exact same
 * action `CheckoutPage` wires up, via the shared `<PayNowButton>`.
 */
describe('BookingStatusPage — cancelled retry (Task 8b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a working "try paying again" button in the cancelled notice, and leaves for the redirect URL — triggering exactly one mutation, never createHold', async () => {
    mockTrpc({ 'checkout.bookingStatus': { ...BASE_STATUS, status: 'pending_payment' } });
    // Task A5: the retry button appears only on an `onlinePaymentEnabled:
    // true` the server actually sent, so this page now needs `settings.get`
    // answered. SETTINGS_FIXTURE ships it true.
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/' });
    let createHoldCalls = 0;
    let startPaymentCalls = 0;
    mockTrpc({
      // This page must never be able to create a hold (§6) — registered
      // here so that if a future change ever wired this up, it would be
      // counted rather than silently uncovered.
      'checkout.createHold': () => {
        createHoldCalls += 1;
        throw new Error('BookingStatusPage must never call createHold');
      },
      'checkout.startPayment': (input: unknown) => {
        startPaymentCalls += 1;
        expect(input).toEqual({ ref: BASE_STATUS.ref });
        return { redirectUrl: 'https://pay.example/session/retry1' };
      },
    });

    const user = userEvent.setup();
    renderStatusPage(BASE_STATUS.ref, '?cancelled=1');

    const retryButton = await screen.findByRole('button', { name: /try paying again/i });
    await user.click(retryButton);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://pay.example/session/retry1');
    });

    // Exactly one mutation call total resulted from this click — never a
    // second startPayment call, and never createHold. The URL assertion
    // above alone would not catch an extra mutation added inside
    // <PayNowButton> or a sibling call added next to it.
    expect(startPaymentCalls).toBe(1);
    expect(createHoldCalls).toBe(0);
  });

  /* ====================================================================
   * Task A5 — the retry affordance obeys the SAME three states the
   * checkout does.
   *
   * This page is reached precisely BECAUSE a payment did not finish, so a
   * retry button that cannot work is the worst place for one: the guest
   * has already had one failure and is being invited into a second.
   * `<PaymentOptions>` is shared with `CheckoutPage` so neither screen can
   * drift from the other's answer; these tests pin that it is actually
   * wired HERE.
   * ==================================================================== */

  async function cancelledNoticeWith(settings: typeof SETTINGS_FIXTURE) {
    mockTrpc({ 'checkout.bookingStatus': { ...BASE_STATUS, status: 'pending_payment' } });
    mockTrpc({ 'settings.get': settings });
    renderStatusPage(BASE_STATUS.ref, '?cancelled=1');
    await screen.findByText(/payment cancelled/i);
  }

  it('online ON: still offers "try paying again"', async () => {
    await cancelledNoticeWith({ ...SETTINGS_FIXTURE, onlinePaymentEnabled: true });
    expect(await screen.findByRole('button', { name: /try paying again/i })).toBeInTheDocument();
  });

  it('online OFF, manual ON: no retry button, the manual transfer instead', async () => {
    await cancelledNoticeWith({
      ...SETTINGS_FIXTURE,
      onlinePaymentEnabled: false,
      manualTransferEnabled: true,
    });

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    expect(link).toHaveAttribute('href', `/portal/login?ref=${BASE_STATUS.ref}&next=/portal/pay`);
    expect(screen.queryByRole('button', { name: /try paying again/i })).not.toBeInTheDocument();
  });

  it('BOTH off: no retry button, no transfer link — the office instead', async () => {
    await cancelledNoticeWith({
      ...SETTINGS_FIXTURE,
      onlinePaymentEnabled: false,
      manualTransferEnabled: false,
    });

    expect(
      await screen.findByText(/online payment isn't available right now/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try paying again/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /gcash, maya or bank transfer/i }),
    ).not.toBeInTheDocument();
  });

  it('never shows the retry button without ?cancelled=1', async () => {
    mockTrpc({ 'checkout.bookingStatus': { ...BASE_STATUS, status: 'pending_payment' } });
    renderStatusPage(BASE_STATUS.ref);

    await screen.findByText(/waiting for your payment/i);
    expect(screen.queryByRole('button', { name: /try paying again/i })).not.toBeInTheDocument();
  });
});
