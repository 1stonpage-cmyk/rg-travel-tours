/**
 * Task 8 (week 3 checkout plan): the checkout page.
 *
 * The page's only job is to render what the server says (`QuoteResult`) and
 * collect what the guest types — it never computes money itself. The first
 * test below is the one that actually proves that: the mocked
 * `checkout.quote` response is built so that `tier.pricePerPersonCentavos *
 * pax` (₱3,000) does NOT equal `subtotalCentavos` (₱5,000) — if the
 * component ever recomputed a total from the tier price and pax instead of
 * rendering the server's own fields, the wrong figure would appear and this
 * test would catch it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CheckoutPage from '@/pages/public/CheckoutPage';
import { RATE_LIMIT_MESSAGE } from '@/lib/mutation-errors';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, mockTrpcRateLimited } from './helpers/mock-trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';

/**
 * Deliberately NOT internally consistent with §5's pricing formula — see
 * the file header. A real server response always satisfies the formula;
 * this fixture does not, on purpose, so the test can tell "rendered
 * verbatim" apart from "recomputed client-side".
 */
const QUOTE_FIXTURE = {
  tier: { id: 7, minPax: 1, maxPax: 6, pricePerPersonCentavos: 100_000 },
  subtotalCentavos: 500_000,
  discountCentavos: 50_000,
  totalCentavos: 450_000,
  depositCentavos: 135_000,
  amountDueNowCentavos: { full: 450_000, deposit: 135_000 },
  balanceCentavos: { full: 0, deposit: 315_000 },
  quoteId: 'abcdef0123456789abcdef0123456789',
};

const HOLD_RESULT = {
  ref: 'RG-TEST01',
  bookingId: 42,
  holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

function renderCheckout(entry = '/checkout/oslob-tour?date=2026-11-20&pax=3') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/checkout/:tourSlug" element={<CheckoutPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

async function fillGuestDetails(user: ReturnType<typeof userEvent.setup>, form: HTMLElement) {
  await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
  await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
  await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
}

describe('CheckoutPage — renders the server quote verbatim', () => {
  it('shows the mocked peso figures exactly, never a recomputed total', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    renderCheckout();

    // From the fixture, verbatim.
    expect(await screen.findByText('₱5,000')).toBeInTheDocument(); // subtotal
    expect(screen.getByText('₱4,500')).toBeInTheDocument(); // total
    expect(screen.getByText('₱1,350')).toBeInTheDocument(); // deposit due now (default pay mode)

    // What a client-side recompute (tier price × pax = ₱1,000 × 3) would have
    // produced instead. It must never appear.
    expect(screen.queryByText('₱3,000')).not.toBeInTheDocument();
  });
});

describe('CheckoutPage — consent gate', () => {
  it('blocks submission with no consent, and never calls createHold', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    let called = false;
    mockTrpc({
      'checkout.createHold': () => {
        called = true;
        return HOLD_RESULT;
      },
    });
    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toMatch(/agree|consent/i);
    expect(called).toBe(false);
  });
});

describe('CheckoutPage — rate limit copy', () => {
  it('shows the calm rate-limit message on a 429 from createHold', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpcRateLimited('checkout.createHold');
    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(RATE_LIMIT_MESSAGE);
  });
});

describe('CheckoutPage — hold countdown', () => {
  it('renders after a successful hold and mutates nothing when it reaches zero', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    let createHoldCalls = 0;
    mockTrpc({
      'checkout.createHold': () => {
        createHoldCalls += 1;
        return { ...HOLD_RESULT, holdExpiresAt: new Date(Date.now() + 1100).toISOString() };
      },
    });
    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    expect(await screen.findByText(/RG-TEST01/)).toBeInTheDocument();
    expect(createHoldCalls).toBe(1);

    // Real wall-clock wait past the 1.1s expiry set above — no fake timers,
    // matching this repo's existing convention (trpc-wiring.test.tsx).
    expect(await screen.findByText(/run out/i, {}, { timeout: 4000 })).toBeInTheDocument();

    // A grace window, not a race: tRPC's batch link schedules the actual
    // network call a tick after `.mutate()` is invoked, so a wrongly-fired
    // mutation might not have reached the mock yet the instant the "run
    // out" text appears. Give it time to actually land before trusting the
    // count below.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Display-only: reaching zero must not have triggered a second call.
    expect(createHoldCalls).toBe(1);
  });
});

/**
 * Task 8b: the gap a code review found — the hold, `checkout.startPayment`
 * and the status page all existed and were each tested, but nothing in the
 * UI joined checkout → payment → status page. These tests prove the join
 * exists: after a successful hold, a "Pay now" trigger calls
 * `checkout.startPayment` with the new booking's ref and leaves for the
 * `redirectUrl` it returns — never a client-computed URL, never a crash on
 * refusal.
 */
describe('CheckoutPage — pay now (Task 8b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts payment with the held booking's ref and leaves for the redirect URL on success — and that click triggers startPayment, never a second createHold", async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    // `settings.get` is no longer optional for this page (task A5): the
    // Pay-now button appears only on an `onlinePaymentEnabled: true` the
    // server actually sent. SETTINGS_FIXTURE ships it true — the state a
    // correctly configured production box is in.
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    let createHoldCalls = 0;
    let startPaymentCalls = 0;
    mockTrpc({
      'checkout.createHold': () => {
        createHoldCalls += 1;
        return HOLD_RESULT;
      },
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/' });
    mockTrpc({
      'checkout.startPayment': (input: unknown) => {
        startPaymentCalls += 1;
        expect(input).toEqual({ ref: HOLD_RESULT.ref });
        return { redirectUrl: 'https://pay.example/session/abc123' };
      },
    });

    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    expect(createHoldCalls).toBe(1);
    expect(startPaymentCalls).toBe(0);

    const payButton = await screen.findByRole('button', { name: /^pay now$/i });
    await user.click(payButton);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://pay.example/session/abc123');
    });

    // The click on "Pay now" triggered exactly one mutation call total —
    // `checkout.startPayment`, once — and did NOT also fire a second
    // `checkout.createHold`. A future change that slipped a second
    // mutation into `<PayNowButton>` (or called createHold again) would
    // move either count and this would catch it; the URL assertion above
    // alone would not.
    expect(startPaymentCalls).toBe(1);
    expect(createHoldCalls).toBe(1);
  });

  /* ====================================================================
   * The manual-transfer alternative (Week 4 Task 8; owner decision
   * 2026-10-14, Q3 and Q5).
   *
   * Two rules, and the first is the one that could cost a guest money:
   * while `payment_qr` is unconfigured the option must not be offered at
   * all, because the screen behind it could only apologise. The second is
   * that it is a LINK — Week 3's checkout router has exactly two
   * mutations and that is a tested property, so choosing to pay by
   * transfer starts nothing on the server.
   * ==================================================================== */

  it('offers NO transfer link while manualTransferEnabled is false', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpc({ 'checkout.createHold': () => HOLD_RESULT });
    // SETTINGS_FIXTURE ships `manualTransferEnabled: false`, which is what
    // the seeded database says until R&G configure their QR.
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });

    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await screen.findByRole('button', { name: /^pay now$/i });
    expect(screen.queryByRole('link', { name: /bank transfer/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/gcash, maya or bank transfer/i)).not.toBeInTheDocument();
  });

  it('offers the transfer link, carrying the ref, once it IS enabled', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpc({ 'checkout.createHold': () => HOLD_RESULT });
    mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, manualTransferEnabled: true } });

    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    // Through the portal sign-in, which is where the guest session — and so
    // the amount and the account details — comes from.
    expect(link).toHaveAttribute('href', `/portal/login?ref=${HOLD_RESULT.ref}&next=/portal/pay`);
  });

  /* ====================================================================
   * Task A5 — the launch blocker: NEVER offer online payment that cannot
   * work.
   *
   * `settings.onlinePaymentEnabled` is computed on the server from two
   * facts the browser cannot see (a PayMongo secret key, and at least one
   * enabled payment method). Until this task, the page rendered Pay now
   * regardless, so a box with no key — this project's dev and staging
   * boxes, reproduced in a browser before the fix — handed a guest a
   * button whose only outcome was a refusal.
   *
   * The three states below are the whole contract. Each asserts the
   * ABSENCE of the Pay-now button by role AND by the text, because a
   * button rendered-but-disabled would still be the wrong answer: a guest
   * must not be shown a payment route that does not exist.
   * ==================================================================== */

  async function holdASpotWith(settings: typeof SETTINGS_FIXTURE) {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpc({ 'checkout.createHold': () => HOLD_RESULT });
    mockTrpc({ 'settings.get': settings });

    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    // The hold itself is NOT gated on any of this (the brief is explicit:
    // a hold with "come pay us however you can" is still a reservation).
    // Every state below waits on the same proof that it really happened.
    await screen.findByText(new RegExp(HOLD_RESULT.ref));
  }

  it('online ON: renders Pay now (today’s behaviour, unchanged)', async () => {
    await holdASpotWith({ ...SETTINGS_FIXTURE, onlinePaymentEnabled: true });
    expect(await screen.findByRole('button', { name: /^pay now$/i })).toBeInTheDocument();
  });

  it('online OFF, manual ON: no Pay-now button anywhere, and the transfer is the PRIMARY path with no "instead"', async () => {
    await holdASpotWith({
      ...SETTINGS_FIXTURE,
      onlinePaymentEnabled: false,
      manualTransferEnabled: true,
    });

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    expect(link).toHaveAttribute('href', `/portal/login?ref=${HOLD_RESULT.ref}&next=/portal/pay`);

    // Not rendered at all — not merely disabled.
    expect(screen.queryByRole('button', { name: /^pay now$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^pay now$/i)).not.toBeInTheDocument();

    // "instead" pointed at a button that, in this state, was never drawn.
    expect(link.textContent).not.toMatch(/instead/i);
    expect(screen.queryByText(/instead/i)).not.toBeInTheDocument();
  });

  it('BOTH off: neither payment route is offered, and the guest is pointed at the office', async () => {
    await holdASpotWith({
      ...SETTINGS_FIXTURE,
      onlinePaymentEnabled: false,
      manualTransferEnabled: false,
    });

    const notice = await screen.findByText(/online payment isn't available right now/i);
    expect(notice).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /^pay now$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /gcash, maya or bank transfer/i }),
    ).not.toBeInTheDocument();

    // The site's own contact route, not new copy invented for this screen.
    const whatsapp = screen.getAllByRole('link', { name: /message us on whatsapp/i })[0]!;
    expect(whatsapp).toHaveAttribute('href', expect.stringContaining('wa.me/'));
    expect(whatsapp.getAttribute('href')).toContain(encodeURIComponent(HOLD_RESULT.ref));
  });

  it("shows the server's own calm message, never a crash, when startPayment is refused", async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    mockTrpc({ 'checkout.createHold': () => HOLD_RESULT });
    mockTrpcError('checkout.startPayment');

    const user = userEvent.setup();
    renderCheckout();

    const form = await screen.findByRole('form', { name: /checkout/i });
    await fillGuestDetails(user, form);
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    const payButton = await screen.findByRole('button', { name: /^pay now$/i });
    await user.click(payButton);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/please try again|whatsapp/i);
  });
});

/**
 * Task 8b: the date picker upstream of this page can still offer a date
 * `createHold` will refuse (BUILD_SPEC §3D's own documented gap). Until
 * that is fully closed everywhere, this page itself calls the advisory
 * `checkout.availability` and shows its own amber hint — and
 * `date_not_bookable` must read differently from a capacity refusal, never
 * share its wording (the whole reason the server keeps the two reason
 * vocabularies separate).
 */
describe('CheckoutPage — availability banner (Task 8b)', () => {
  it('shows a date_not_bookable hint, distinct from a capacity refusal', async () => {
    mockTrpc({
      'checkout.quote': QUOTE_FIXTURE,
      'checkout.availability': { ok: false, reason: 'date_not_bookable' },
    });
    renderCheckout();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/not taking online bookings/i);
  });

  it('shows a different hint for a capacity refusal than for date_not_bookable', async () => {
    mockTrpc({
      'checkout.quote': QUOTE_FIXTURE,
      'checkout.availability': { ok: false, reason: 'tour_sold_out' },
    });
    renderCheckout();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/doesn't have space/i);
    expect(banner).not.toHaveTextContent(/not taking online bookings/i);
  });

  /**
   * Final whole-branch review, F4: `checkout.availability` now answers
   * `date_blocked` for a date in `tour_blocked_dates` (it used to answer
   * `{ ok: true }` and leave the refusal to submit). A blocked date needs
   * its own sentence for the same reason `date_not_bookable` does: "fully
   * booked" invites a guest to check back for a day that is never going to
   * open, and "we're not taking online bookings for that date" points at
   * the booking window, which is a different thing an admin controls
   * differently.
   */
  it('shows a date_blocked hint, distinct from both other refusals', async () => {
    mockTrpc({
      'checkout.quote': QUOTE_FIXTURE,
      'checkout.availability': { ok: false, reason: 'date_blocked' },
    });
    renderCheckout();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/isn't running/i);
    expect(banner).not.toHaveTextContent(/not taking online bookings/i);
    expect(banner).not.toHaveTextContent(/doesn't have space/i);
  });

  it('shows no banner at all once the date is available', async () => {
    mockTrpc({
      'checkout.quote': QUOTE_FIXTURE,
      'checkout.availability': { ok: true },
    });
    renderCheckout();

    await screen.findByRole('form', { name: /checkout/i });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * Task 8's own non-negotiable, scanned repo-wide (not just this page's new
 * files): no `*` or `+` touching a `*Centavos` identifier anywhere in
 * `client/`. The server computes all money; the client only renders it.
 */
describe('brand rule: the client never computes money', () => {
  const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const exempt = new Set(['src/__tests__/checkout-page.test.tsx']);

  function collectFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      if (entry === 'node_modules' || entry === 'dist') return [];
      const p = join(dir, entry);
      const stats = statSync(p);
      if (stats.isDirectory()) return collectFiles(p);
      return extname(p) === '.ts' || extname(p) === '.tsx' ? [p] : [];
    });
  }

  function stripComments(text: string): string {
    const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, (_m, prefix: string) => prefix);
  }

  const arithmeticOnCentavos = [/\b\w*Centavos\w*\s*[*+]\s*(?!=)/, /[*+]\s*(?!=)\w*Centavos\w*\b/];

  it('contains no arithmetic on a *Centavos value', () => {
    const files = collectFiles(join(clientRoot, 'src'));
    const offences: string[] = [];

    for (const file of files) {
      const rel = 'src/' + file.slice(join(clientRoot, 'src').length + 1).replace(/\\/g, '/');
      if (exempt.has(rel)) continue;

      const checked = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      checked.forEach((line, index) => {
        for (const re of arithmeticOnCentavos) {
          if (re.test(line)) {
            offences.push(`${rel}:${index + 1} ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }

    expect(
      offences,
      `Money is computed server-side only (CLAUDE.md):\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
