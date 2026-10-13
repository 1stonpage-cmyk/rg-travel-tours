/**
 * Week 4 plan, Task 9 — the portal booking page (BUILD_SPEC §7).
 *
 * The tracker's table and the polling rule are proved exhaustively in
 * `shared/src/portal.test.ts`; `server/src/__tests__/portal-booking.test.ts`
 * proves what the server publishes. This file proves what a guest SEES: the
 * five steps, the balance, the rejection reason and the re-upload form, the
 * driver's two ways to be reached, and a sign-in prompt with nothing on it
 * when there is no session.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { portalTracker } from '@rg/shared';
import PortalBookingPage from '@/pages/portal/PortalBookingPage';
import { waNumber } from '@/lib/phone';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const BASE = {
  ref: 'RG-7KQ4M9',
  status: 'pending_payment' as const,
  leadName: 'Maria Santos',
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-12-25',
  pax: 4,
  totalCentavos: 1_000_000,
  paidCentavos: 0,
  balanceCentavos: 1_000_000,
  amountDueCentavos: 300_000,
  holdExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  tracker: portalTracker({ status: 'pending_payment', paidCentavos: 0, hasReceipt: false }),
  receipt: null as null | { status: string; rejectReason: string | null; submittedAt: string },
  uploadsRemaining: 5,
  driver: null as null | {
    name: string;
    phone: string;
    vanModel: string | null;
    vanPlate: string | null;
  },
  canReview: false,
};

function renderPage() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/portal/booking']}>
        <Routes>
          <Route path="/portal/booking" element={<PortalBookingPage />} />
          <Route path="/portal/pay" element={<p>payment screen</p>} />
          <Route path="/portal/login" element={<p>sign-in screen</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PortalBookingPage — the booking', () => {
  it('shows the reference, the tour, the date and the guests', async () => {
    mockTrpc({ 'portal.booking': BASE });
    renderPage();

    // Twice on the page by design: the header and the "quote this when you
    // message us" footer, so `findAllByText` rather than a single match.
    expect(await screen.findAllByText(/RG-7KQ4M9/)).not.toHaveLength(0);
    expect(screen.getByRole('heading', { name: /oslob whale shark/i })).toBeInTheDocument();
    expect(screen.getByText(/2026-12-25 · 4 guests · Maria Santos/)).toBeInTheDocument();
  });

  /** §7's five steps, by their own names, with the done ones marked. */
  it('renders all five tracker steps and marks the ones that are done', async () => {
    mockTrpc({
      'portal.booking': {
        ...BASE,
        status: 'confirmed',
        paidCentavos: 300_000,
        balanceCentavos: 700_000,
        amountDueCentavos: 0,
        tracker: portalTracker({ status: 'confirmed', paidCentavos: 300_000, hasReceipt: true }),
      },
    });
    renderPage();

    const list = await screen.findByRole('list', { name: /booking progress/i });
    const items = screen.getAllByRole('listitem');
    expect(list).toBeInTheDocument();
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Booked — done');
    expect(items[1]).toHaveTextContent('Payment sent — done');
    expect(items[2]).toHaveTextContent('Verified by admin — done');
    expect(items[3]).toHaveTextContent('Driver assigned — not done yet');
    expect(items[4]).toHaveTextContent('Tour day — not done yet');
    // The step a guest is waiting on is the one marked current.
    expect(items[3]).toHaveAttribute('aria-current', 'step');
  });

  /**
   * §7's "balance due on tour day", read from the server. The fixture's
   * total and paid are deliberately NOT a pair the page could derive the
   * balance from by subtracting on screen — the balance is sent.
   */
  it('shows the total, the paid amount and the balance, all from the server', async () => {
    mockTrpc({
      'portal.booking': { ...BASE, paidCentavos: 300_000, balanceCentavos: 700_000 },
    });
    renderPage();

    expect(await screen.findByText('₱10,000')).toBeInTheDocument();
    expect(screen.getByText('₱3,000')).toBeInTheDocument();
    expect(screen.getByText('₱7,000')).toBeInTheDocument();
    expect(screen.getByText(/balance on tour day/i)).toBeInTheDocument();
  });

  it('offers the payment screen while something is still due', async () => {
    mockTrpc({ 'portal.booking': BASE });
    renderPage();

    const link = await screen.findByRole('link', { name: /pay ₱3,000 now/i });
    expect(link).toHaveAttribute('href', '/portal/pay');
  });

  it('offers no payment link once nothing is due', async () => {
    mockTrpc({
      'portal.booking': {
        ...BASE,
        status: 'confirmed',
        paidCentavos: 300_000,
        amountDueCentavos: 0,
      },
    });
    renderPage();

    await screen.findByText(/your booking is confirmed/i);
    expect(screen.queryByRole('link', { name: /pay .* now/i })).not.toBeInTheDocument();
  });

  it('says in words where the booking stands, including when it is cancelled', async () => {
    mockTrpc({ 'portal.booking': { ...BASE, status: 'cancelled' } });
    renderPage();
    expect(await screen.findByText(/this booking has been cancelled/i)).toBeInTheDocument();
  });
});

describe('PortalBookingPage — a rejected receipt', () => {
  const REJECTED = {
    ...BASE,
    status: 'pending_payment' as const,
    receipt: {
      status: 'rejected',
      rejectReason: 'The amount is short by 500 pesos.',
      submittedAt: new Date().toISOString(),
    },
    uploadsRemaining: 4,
    tracker: portalTracker({ status: 'pending_payment', paidCentavos: 0, hasReceipt: true }),
  };

  /** §7: "with the rejection reason shown". The admin's own words. */
  it('shows the admin reason and the re-upload form', async () => {
    mockTrpc({ 'portal.booking': REJECTED });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The amount is short by 500 pesos.');
    expect(screen.getByText(/we could not confirm your payment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send receipt/i })).toBeInTheDocument();
    expect(screen.getByText(/4 uploads left/i)).toBeInTheDocument();
    // Still held, not cancelled — the owner's Q7 answer, in the guest's words.
    expect(screen.getByText(/your booking is still held/i)).toBeInTheDocument();
  });

  it('shows no rejection notice when the newest receipt is only pending', async () => {
    mockTrpc({
      'portal.booking': {
        ...REJECTED,
        status: 'pending_verification',
        receipt: { status: 'pending', rejectReason: null, submittedAt: new Date().toISOString() },
      },
    });
    renderPage();

    expect(
      await screen.findByText(/we have your receipt and are checking it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/we could not confirm your payment/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send receipt/i })).not.toBeInTheDocument();
  });

  /** The page says it refreshes itself, so a guest does not sit reloading. */
  it('tells the guest the page updates itself while the receipt is being checked', async () => {
    mockTrpc({
      'portal.booking': {
        ...BASE,
        status: 'pending_verification',
        receipt: { status: 'pending', rejectReason: null, submittedAt: new Date().toISOString() },
      },
    });
    renderPage();
    expect(await screen.findByText(/this page updates itself/i)).toBeInTheDocument();
  });
});

describe('PortalBookingPage — the driver card', () => {
  const ASSIGNED = {
    ...BASE,
    status: 'assigned' as const,
    paidCentavos: 300_000,
    balanceCentavos: 700_000,
    amountDueCentavos: 0,
    tracker: portalTracker({ status: 'assigned', paidCentavos: 300_000, hasReceipt: true }),
    driver: {
      name: 'Pedro Reyes',
      phone: '09170001234',
      vanModel: 'Toyota Hiace Commuter',
      vanPlate: 'ABC 1234',
    },
  };

  it('shows the driver, the van and the plate', async () => {
    mockTrpc({ 'portal.booking': ASSIGNED });
    renderPage();

    expect(await screen.findByRole('heading', { name: /your driver/i })).toBeInTheDocument();
    expect(screen.getByText('Pedro Reyes')).toBeInTheDocument();
    expect(screen.getByText(/toyota hiace commuter · abc 1234/i)).toBeInTheDocument();
  });

  it('offers a call link on the real number', async () => {
    mockTrpc({ 'portal.booking': ASSIGNED });
    renderPage();

    const call = await screen.findByRole('link', { name: /call pedro/i });
    expect(call).toHaveAttribute('href', 'tel:09170001234');
  });

  /**
   * The documented brand-colour exception: the WhatsApp pill is icon-only
   * with an `aria-label`, and the word "WhatsApp" is OUTSIDE it. White text
   * on `#25D366` measures 1.98:1 and fails AA at any size, which is why the
   * pill may carry only the glyph.
   */
  it('offers an icon-only WhatsApp pill with the wording outside it', async () => {
    mockTrpc({ 'portal.booking': ASSIGNED });
    renderPage();

    const pill = await screen.findByRole('link', { name: /message pedro reyes on whatsapp/i });
    expect(pill).toHaveAttribute('href', 'https://wa.me/639170001234');
    // The pill itself carries no text; the label sits beside it.
    expect(pill).toHaveTextContent('');
    expect(screen.getByText('WhatsApp')).not.toBe(pill);
  });

  it('shows no driver card when the server sent none', async () => {
    mockTrpc({ 'portal.booking': { ...ASSIGNED, driver: null } });
    renderPage();

    await screen.findByText(/your driver is assigned/i);
    expect(screen.queryByRole('heading', { name: /your driver/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /whatsapp/i })).not.toBeInTheDocument();
  });
});

describe('waNumber', () => {
  /** `wa.me` wants the international number with no plus and no spaces. */
  it('converts a Philippine local number to the wa.me form', () => {
    expect(waNumber('09170001234')).toBe('639170001234');
    expect(waNumber('0917 000 1234')).toBe('639170001234');
    expect(waNumber('+63 917 000 1234')).toBe('639170001234');
    expect(waNumber('639170001234')).toBe('639170001234');
  });
});

describe('PortalBookingPage — no session', () => {
  it('shows a sign-in prompt and nothing about any booking', async () => {
    mockTrpcError('portal.booking', 'UNAUTHORIZED', 'Sign in to your booking to see this.');
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /sign in to your booking/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/portal/login?next=/portal/booking',
    );
    expect(screen.queryByText('RG-7KQ4M9')).not.toBeInTheDocument();
    expect(screen.queryByText('₱10,000')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /booking progress/i })).not.toBeInTheDocument();
  });
});

describe('the page delegates its decisions', () => {
  /**
   * A structural guard. The tracker's table, the polling rule and the money
   * are all the server's or `@rg/shared`'s; a `useMutation` or a status
   * comparison building a tracker in here would mean a second copy of a
   * business rule in the browser.
   */
  it('calls one query, no mutation, and builds no tracker of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../pages/portal/PortalBookingPage.tsx'),
      'utf8',
    );

    expect(src).not.toMatch(/useMutation/);
    expect(src).toMatch(/trpc\.portal\.booking\.useQuery/);
    // The poll interval comes from the shared rule, not a literal here.
    expect(src).toMatch(/portalPollMs/);
    expect(src).not.toMatch(/20_000|20000/);
  });
});
