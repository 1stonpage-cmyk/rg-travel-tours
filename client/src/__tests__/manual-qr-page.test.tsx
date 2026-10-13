/**
 * Week 4 plan, Task 8 — the manual QR screen.
 *
 * Three properties, in order of how much they matter:
 *
 *  1. **No session, no details.** The owner's decision (2026-10-14, Q5) is
 *     that a booking reference alone reveals nothing, so a refused query
 *     must render a sign-in prompt carrying no amount and no account
 *     number — not a page that flashes them first.
 *  2. **Nothing here computes money.** The amount comes from the server
 *     and is only formatted. (The repo-wide `*Centavos` arithmetic guard in
 *     `checkout-page.test.tsx` covers the whole client tree, this file
 *     included; the test below is the behavioural half: the page shows what
 *     the server sent and not a figure it derived.)
 *  3. **Nothing is invented.** While `payment_qr` is unconfigured the page
 *     shows an amber pending notice, no QR, and no upload form.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import ManualQrPage from '@/pages/portal/ManualQrPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const FAR_FUTURE = new Date(Date.now() + 14 * 60_000).toISOString();

const CONFIGURED = {
  ref: 'RG-7KQ4M9',
  status: 'pending_payment' as const,
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-12-25',
  pax: 3,
  totalCentavos: 450_000,
  paidCentavos: 0,
  amountDueCentavos: 135_000,
  holdExpiresAt: FAR_FUTURE,
  uploadsRemaining: 5,
  qr: {
    imagePath: 'a1b2c3d4e5f60718293a4b5c6d7e8f90.png',
    accountName: 'R&G Travel and Tours',
    accountNumber: '0917 000 0000',
    instructions: 'Put your booking reference in the transfer note.',
  },
};

function renderPage() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/portal/pay']}>
        <Routes>
          <Route path="/portal/pay" element={<ManualQrPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('ManualQrPage — a signed-in guest', () => {
  /**
   * The amount, exactly as the server sent it. ₱1,350 is 30% of
   * ₱4,500, and the page is handed the 135000 rather than deriving it —
   * `totalCentavos` is deliberately present in the fixture so a page that
   * multiplied it by a deposit percent would show something else.
   */
  it('shows the server-computed amount due, formatted', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    expect(await screen.findByText('₱1,350')).toBeInTheDocument();
    expect(screen.getByText(/send exactly/i)).toBeInTheDocument();
    // Not the total, which a client-side deposit calculation would land on.
    expect(screen.queryByText('₱4,500')).not.toBeInTheDocument();
  });

  it('shows the booking reference and the instruction to put it in the note', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    expect(await screen.findByText('RG-7KQ4M9')).toBeInTheDocument();
    expect(screen.getByText(/put this in the notes/i)).toBeInTheDocument();
    expect(
      screen.getByText(/put your booking reference in the transfer note/i),
    ).toBeInTheDocument();
  });

  /** §6 step 1: the QR, from the authenticated route, with real alt text. */
  it('renders the QR image from the authenticated route', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    const image = await screen.findByRole('img', { name: /payment qr code/i });
    expect(image).toHaveAttribute('src', '/api/payment-qr');
  });

  /** §6 step 2: "Download QR". A real link, so the browser sends the cookie. */
  it('offers a Download QR link pointing at the same route', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    const link = await screen.findByRole('link', { name: /download qr/i });
    expect(link).toHaveAttribute('href', '/api/payment-qr');
    expect(link).toHaveAttribute('download');
  });

  it('shows the account name and number', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    expect(await screen.findByText('R&G Travel and Tours')).toBeInTheDocument();
    expect(screen.getByText('0917 000 0000')).toBeInTheDocument();
  });

  /** §6 step 2: the hold countdown, and §6 step 3: the upload control. */
  it('counts the hold down and offers the upload form', async () => {
    mockTrpc({ 'portal.manualPayment': CONFIGURED });
    renderPage();

    expect(await screen.findByText(/send us your receipt/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send receipt/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/how did you pay/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reference number from your transfer/i)).toBeInTheDocument();
    // The countdown renders mm:ss from holdExpiresAt.
    expect(screen.getByText(/\d+:\d{2}/)).toBeInTheDocument();
  });

  it('says how many uploads are left, and refuses the form at zero', async () => {
    mockTrpc({ 'portal.manualPayment': { ...CONFIGURED, uploadsRemaining: 2 } });
    renderPage();
    expect(await screen.findByText(/2 uploads left/i)).toBeInTheDocument();

    resetTrpcMock();
    mockTrpc({ 'portal.manualPayment': { ...CONFIGURED, uploadsRemaining: 0 } });
    renderPage();
    expect(await screen.findByText(/most we can accept/i)).toBeInTheDocument();
  });
});

describe('ManualQrPage — no session', () => {
  /**
   * **The test that matters most.** A refused query must leave the page
   * with nothing private on it at all.
   */
  it('shows a sign-in prompt and NO payment details', async () => {
    mockTrpcError('portal.manualPayment', 'UNAUTHORIZED', 'Sign in to your booking to see this.');
    renderPage();

    expect(await screen.findByRole('heading', { name: /sign in to pay/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in to your booking/i })).toHaveAttribute(
      'href',
      '/portal/login?next=/portal/pay',
    );

    // Nothing from a booking, and nothing from the account.
    expect(screen.queryByText('₱1,350')).not.toBeInTheDocument();
    expect(screen.queryByText('RG-7KQ4M9')).not.toBeInTheDocument();
    expect(screen.queryByText('0917 000 0000')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /payment qr/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send receipt/i })).not.toBeInTheDocument();
  });
});

describe('ManualQrPage — payment_qr not configured', () => {
  /** Owner decision Q3: never invent an account name or number. */
  it('shows the amber pending notice, with no QR and no upload form', async () => {
    mockTrpc({ 'portal.manualPayment': { ...CONFIGURED, qr: null } });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /payment details pending/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/our transfer details are not published yet/i)).toBeInTheDocument();
    // The amount and the ref are still the guest's own to see.
    expect(screen.getByText('₱1,350')).toBeInTheDocument();
    // But nothing that would be invented.
    expect(screen.queryByRole('img', { name: /payment qr/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download qr/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send receipt/i })).not.toBeInTheDocument();
  });
});

describe('ManualQrPage — the hold has run out', () => {
  /**
   * §6 step 2: at zero the page stops offering to pay. It does NOT claim
   * the booking is gone — the sweep may not have run — it just withdraws
   * the controls and says so in amber.
   */
  it('withdraws the QR and the upload form, and points at a new booking', async () => {
    mockTrpc({
      'portal.manualPayment': {
        ...CONFIGURED,
        holdExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /this hold has run out/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start a new booking/i })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('img', { name: /payment qr/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send receipt/i })).not.toBeInTheDocument();
    expect(screen.queryByText('0917 000 0000')).not.toBeInTheDocument();
  });

  /** A booking with no hold left (paid, or already under verification) is not "lapsed". */
  it('does not treat a null hold as a lapsed one', async () => {
    mockTrpc({ 'portal.manualPayment': { ...CONFIGURED, holdExpiresAt: null } });
    renderPage();

    expect(await screen.findByText('₱1,350')).toBeInTheDocument();
    expect(screen.queryByText(/this hold has run out/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send receipt/i })).toBeInTheDocument();
  });
});

describe('the page calls exactly one procedure, and it is a read', () => {
  /**
   * A structural guard, like `pay-now-button.test.tsx`'s. The upload is a
   * plain `fetch` to the receipts route (file bytes, not JSON), so a
   * `useMutation` appearing in this page would mean someone had routed
   * money-shaped work through it.
   */
  it('contains no useMutation at all', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../pages/portal/ManualQrPage.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/useMutation/);
    expect(src).toMatch(/trpc\.portal\.manualPayment\.useQuery/);
  });
});
