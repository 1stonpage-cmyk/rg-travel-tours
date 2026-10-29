/**
 * The coupon screens (Week 7 plan, Task 8). `admin.coupons.*` is
 * `adminProcedure('toursPricing')` server-side — owner only; what is pinned
 * here is what the SCREEN itself promises: the discount and the usage in
 * words, a percentage typed as "2.5" reaching the mutation as integer basis
 * points and a peso amount as integer centavos, a Manila wall-clock window
 * reaching it as a UTC instant, a two-step confirm for deactivating that never
 * says "Delete", the redemption log showing a booking ref, and a denied state
 * rather than a blank screen for a refused role.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import AdminCouponsPage from '@/pages/admin/AdminCouponsPage';
import { TrpcProviders } from '@/lib/trpc';
import { manilaLocalToUtcIso, utcIsoToManilaLocal } from '@/lib/manila-datetime';
import {
  basisPointsToPercentInput,
  basisPointsToPercentLabel,
  percentToBasisPoints,
} from '@/lib/percent-input';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

/*
 * Radix's `Select` (the Discount type field) needs three DOM APIs jsdom does
 * not implement — see `assign-panel.test.tsx`'s identical shim, copied per
 * that file's own note rather than centralized.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

const PERCENT_COUPON = {
  id: 1,
  code: 'SAVE10',
  discountType: 'percent' as const,
  percentBp: 1000,
  amountCentavos: null,
  minSpendCentavos: 200000,
  // 2026-12-01 08:00 Manila.
  startsAt: '2026-12-01T00:00:00.000Z',
  endsAt: null,
  usageLimit: 50,
  usedCount: 3,
  redemptionCount: 3,
  isActive: true,
};

const FIXED_COUPON = {
  id: 2,
  code: 'FLAT250',
  discountType: 'fixed' as const,
  percentBp: null,
  amountCentavos: 25000,
  minSpendCentavos: null,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  usedCount: 3,
  redemptionCount: 3,
  isActive: false,
};

/** `couponCreateInput.code`'s own max — the longest code the screen can ever show. */
const LONG_CODE = 'A'.repeat(40);
const LONG_CODE_COUPON = {
  ...PERCENT_COUPON,
  id: 3,
  code: LONG_CODE,
};

const REDEMPTIONS = [
  {
    id: 11,
    bookingId: 501,
    bookingRef: 'RG-7KQ4M9',
    tourDate: '2026-12-05',
    bookingStatus: 'confirmed',
    discountCentavos: 10000,
    redeemedAt: '2026-11-20T02:00:00.000Z',
  },
];

/**
 * The page renders BOTH the phone card list and the laptop table at once (CSS
 * media queries do nothing in jsdom — `AdminToursPage.tsx`'s test has the same
 * shape), so a code appears twice. This picks the first match's row ancestor,
 * which works for either the `<li>` or the `<tr>`.
 */
async function firstRowFor(code: string): Promise<HTMLElement> {
  const matches = await screen.findAllByText(code);
  return matches[0]!.closest('li, tr') as HTMLElement;
}

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.coupons.list': [PERCENT_COUPON, FIXED_COUPON],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminCouponsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('percent and Manila conversions', () => {
  it('parses a fractional percentage into integer basis points', () => {
    expect(percentToBasisPoints('10')).toBe(1000);
    expect(percentToBasisPoints('2.5')).toBe(250);
    expect(percentToBasisPoints('1.25')).toBe(125);
  });

  it('rejects a third decimal digit rather than guessing a rounding', () => {
    expect(percentToBasisPoints('2.555')).toBeNull();
    expect(percentToBasisPoints('')).toBeNull();
    expect(percentToBasisPoints('ten')).toBeNull();
  });

  it('shows basis points as a percentage without trailing zeros', () => {
    expect(basisPointsToPercentLabel(1000)).toBe('10%');
    expect(basisPointsToPercentLabel(250)).toBe('2.5%');
    expect(basisPointsToPercentLabel(125)).toBe('1.25%');
    expect(basisPointsToPercentLabel(10000)).toBe('100%');
  });

  it('round-trips basis points through the edit field', () => {
    expect(percentToBasisPoints(basisPointsToPercentInput(250))).toBe(250);
  });

  /**
   * The whole point of `lib/manila-datetime.ts`: a `datetime-local` value is
   * Manila wall clock and the column is UTC. 08:00 in Cebu is 00:00Z — an
   * off-by-eight-hours here starts a coupon on the wrong day.
   */
  it('converts a Manila wall clock to the UTC instant, and back', () => {
    expect(manilaLocalToUtcIso('2026-12-01T08:00')).toBe('2026-12-01T00:00:00.000Z');
    expect(manilaLocalToUtcIso('2026-12-31T23:59')).toBe('2026-12-31T15:59:00.000Z');
    expect(utcIsoToManilaLocal('2026-12-01T00:00:00.000Z')).toBe('2026-12-01T08:00');
    // Seconds appended by some browsers are accepted and dropped.
    expect(manilaLocalToUtcIso('2026-12-01T08:00:00')).toBe('2026-12-01T00:00:00.000Z');
    expect(manilaLocalToUtcIso('')).toBeNull();
    expect(manilaLocalToUtcIso('2026-12-01')).toBeNull();
  });
});

describe('AdminCouponsPage', () => {
  it('shows the discount and the usage in words, and the state as a label', async () => {
    renderPage();
    await screen.findAllByText('SAVE10');

    expect(screen.getAllByText('10% off').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₱250 off').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3 of 50 used').length).toBeGreaterThan(0);
    // No cap on the fixed coupon, so no "of" and no invented ceiling.
    expect(screen.getAllByText('3 used').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Minimum spend ₱2,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No minimum spend').length).toBeGreaterThan(0);

    const states = screen.getAllByText(/^(Active|Inactive)$/).map((node) => node.textContent);
    expect(states).toContain('Active');
    expect(states).toContain('Inactive');
  });

  it('shows the validity window in Manila wall clock, not UTC', async () => {
    renderPage();
    await screen.findAllByText('SAVE10');
    // 2026-12-01T00:00:00Z is 08:00 in Cebu.
    expect(screen.getAllByText('From 2026-12-01 08:00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No date limit').length).toBeGreaterThan(0);
  });

  it('submits a percentage typed as 2.5 as integer basis points, with the other column null', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.coupons.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('SAVE10');

    await user.click(screen.getByRole('button', { name: /add a coupon/i }));
    await user.type(screen.getByLabelText(/^Code$/), 'SUMMER25');
    await user.type(screen.getByLabelText(/discount \(%\)/i), '2.5');
    await user.click(screen.getByRole('button', { name: /^add coupon$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      code: 'SUMMER25',
      discountType: 'percent',
      percentBp: 250,
      // The column the CHECK constraint requires to be empty.
      amountCentavos: null,
      minSpendCentavos: null,
      startsAt: null,
      endsAt: null,
      usageLimit: null,
    });
    expect(Number.isInteger((sent[0] as { percentBp: number }).percentBp)).toBe(true);
  });

  it('submits a fixed amount typed in pesos as integer centavos, and the window as UTC', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.coupons.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('SAVE10');

    await user.click(screen.getByRole('button', { name: /add a coupon/i }));
    await user.type(screen.getByLabelText(/^Code$/), 'FLAT500');
    await user.click(screen.getByLabelText('Discount type'));
    await user.click(await screen.findByRole('option', { name: 'Fixed amount off' }));
    await user.type(screen.getByLabelText(/discount \(pesos\)/i), '500.00');
    /*
     * `EntityForm` puts every OPTIONAL field behind its "More details"
     * disclosure, which is collapsed when `matchMedia` is unavailable — and
     * jsdom does not implement it at all (see `EntityForm.tsx`'s own note), so
     * the minimum-spend input is not in the DOM until this is opened. Radix
     * unmounts collapsed content rather than hiding it.
     */
    await user.click(screen.getByRole('button', { name: /more details/i }));
    await user.type(await screen.findByLabelText(/minimum spend/i), '2,000.00');
    // Typed as Manila wall clock by an owner in Cebu.
    const starts = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    await user.clear(starts);
    await user.type(starts, '2026-12-01T08:00');
    await user.click(screen.getByRole('button', { name: /^add coupon$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      code: 'FLAT500',
      discountType: 'fixed',
      amountCentavos: 50000,
      percentBp: null,
      minSpendCentavos: 200000,
      startsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('refuses a percentage above 100 at the field, without calling the server', async () => {
    const sent: unknown[] = [];
    renderPage({
      'admin.coupons.create': (input: unknown) => {
        sent.push(input);
        return { id: 99 };
      },
    });
    await screen.findAllByText('SAVE10');

    await user.click(screen.getByRole('button', { name: /add a coupon/i }));
    await user.type(screen.getByLabelText(/^Code$/), 'TOOMUCH');
    await user.type(screen.getByLabelText(/discount \(%\)/i), '150');
    await user.click(screen.getByRole('button', { name: /^add coupon$/i }));

    // The shared schema's own bound (1..10000 basis points), shown beside the
    // field rather than as a summary — and nothing posted.
    const errors = await screen.findAllByRole('alert');
    expect(errors.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
  });

  /**
   * The foot-gun half of 7N Task 8: a `10` typed as 10% must not silently
   * become ₱10.00 the moment the owner switches the discount type, with no
   * re-type and no warning. Clearing the field on the switch is the fix.
   */
  it('clears the discount value when the discount type changes units', async () => {
    renderPage();
    await screen.findAllByText('SAVE10');

    await user.click(screen.getByRole('button', { name: /add a coupon/i }));
    await user.type(screen.getByLabelText(/discount \(%\)/i), '10');
    expect(screen.getByLabelText(/discount \(%\)/i)).toHaveValue('10');

    await user.click(screen.getByLabelText('Discount type'));
    await user.click(await screen.findByRole('option', { name: 'Fixed amount off' }));

    // Same input, now labelled for pesos — the typed "10" must be gone, not
    // silently reinterpreted as ₱10.00.
    expect(screen.getByLabelText(/discount \(pesos\)/i)).toHaveValue('');
  });

  it('asks before deactivating, and says "Deactivate", never "Delete"', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.coupons.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const row = await firstRowFor('SAVE10');

    expect(screen.queryByText(/delete/i)).toBeNull();
    await user.click(within(row).getByRole('button', { name: /deactivate SAVE10/i }));
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /yes, deactivate SAVE10/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 1, isActive: false }]));
    expect(screen.queryByText(/delete/i)).toBeNull();
  });

  /**
   * A 40-character code (7N, Task 8) is the longest a coupon can carry
   * (`couponCreateInput.code`'s own max). `break-all` on the code text and
   * `whitespace-normal` on the confirm button are what keep both from
   * pushing past the phone card's edge at 360px — asserted on the class
   * strings the same way `'keeps the wide table inside its own horizontal
   * scroll container'` does, since jsdom does not compute real layout.
   */
  it('wraps a 40-character code instead of overflowing the phone card', async () => {
    renderPage({ 'admin.coupons.list': [LONG_CODE_COUPON] });
    const row = await firstRowFor(LONG_CODE);
    const codeText = within(row).getByText(LONG_CODE);
    expect(codeText.className).toMatch(/break-all/);

    await user.click(
      within(row).getByRole('button', { name: new RegExp(`deactivate ${LONG_CODE}`, 'i') }),
    );
    const confirmButton = screen.getByRole('button', {
      name: new RegExp(`yes, deactivate ${LONG_CODE}`, 'i'),
    });
    expect(confirmButton.className).toMatch(/whitespace-normal/);
  });

  it('opens the redemption log and shows the booking ref, date and discount', async () => {
    renderPage({ 'admin.coupons.redemptions': REDEMPTIONS });
    const row = await firstRowFor('SAVE10');

    await user.click(within(row).getByRole('button', { name: /show redemptions of SAVE10/i }));

    expect(await screen.findByText('RG-7KQ4M9')).toBeInTheDocument();
    expect(screen.getByText('2026-12-05')).toBeInTheDocument();
    expect(screen.getByText('₱100')).toBeInTheDocument();
  });

  it('says nobody has used a coupon rather than showing an empty table', async () => {
    renderPage({ 'admin.coupons.redemptions': [] });
    const row = await firstRowFor('FLAT250');
    await user.click(within(row).getByRole('button', { name: /show redemptions of FLAT250/i }));
    expect(await screen.findByText(/nobody has used this coupon yet/i)).toBeInTheDocument();
  });

  /**
   * `used_count` is a cache over `coupon_redemptions`; the two are written in
   * one transaction, so a mismatch means something went wrong elsewhere. The
   * screen that shows "3 of 50 used" is the only place an owner would ever
   * see it, so it says so in words.
   */
  it('says so when the cached counter and the redemption rows disagree', async () => {
    renderPage({
      'admin.coupons.list': [{ ...PERCENT_COUPON, usedCount: 3, redemptionCount: 2 }],
    });
    await screen.findAllByText('SAVE10');
    expect(screen.getAllByText(/counter says 3, the redemption log has 2/i).length).toBeGreaterThan(
      0,
    );
  });

  /**
   * Display only (owner decision, 2026-10-27, batch-3 answer 1) —
   * `validateCoupon` already refuses an inverted window cleanly at checkout,
   * so this is a sentence for the owner, not a new validation rule.
   */
  it('warns when a window ends before it starts, and says nothing when it does not', async () => {
    renderPage({
      'admin.coupons.list': [
        {
          ...PERCENT_COUPON,
          startsAt: '2026-12-10T00:00:00.000Z',
          endsAt: '2026-12-01T00:00:00.000Z',
        },
        {
          ...FIXED_COUPON,
          startsAt: '2026-12-01T00:00:00.000Z',
          endsAt: '2026-12-10T00:00:00.000Z',
        },
      ],
    });
    await screen.findAllByText('SAVE10');
    expect(screen.getAllByText(/this window ends before it starts/i).length).toBeGreaterThan(0);
    const fixedRow = await firstRowFor('FLAT250');
    expect(within(fixedRow).queryByText(/ends before it starts/i)).not.toBeInTheDocument();
  });

  it('shows the denied state, not a blank screen, when the role is refused', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(await screen.findByText(/only the owner can manage coupons/i)).toBeInTheDocument();
    expect(screen.queryByText('SAVE10')).toBeNull();
  });

  it('shows the denied state when the list call itself is refused with FORBIDDEN', async () => {
    mockTrpcError('admin.coupons.list', 'FORBIDDEN', 'Not allowed for your role.');
    mockTrpc({ 'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false } });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminCouponsPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(await screen.findByText(/only the owner can manage coupons/i)).toBeInTheDocument();
    expect(screen.queryByText('Not allowed for your role.')).toBeNull();
  });

  it("shows the server's own CONFLICT message when the code is already taken", async () => {
    renderPage();
    mockTrpcError('admin.coupons.create', 'CONFLICT', 'A coupon with that code already exists.');
    await screen.findAllByText('SAVE10');

    await user.click(screen.getByRole('button', { name: /add a coupon/i }));
    await user.type(screen.getByLabelText(/^Code$/), 'SAVE10');
    await user.type(screen.getByLabelText(/discount \(%\)/i), '10');
    await user.click(screen.getByRole('button', { name: /^add coupon$/i }));

    expect(await screen.findByText('A coupon with that code already exists.')).toBeInTheDocument();
  });

  it('keeps the wide table inside its own horizontal scroll container', async () => {
    renderPage();
    await screen.findAllByText('SAVE10');
    const wrapper = screen.getByTestId('coupons-table-wrapper');
    expect(wrapper.className).toMatch(/overflow-x-auto/);
  });
});
