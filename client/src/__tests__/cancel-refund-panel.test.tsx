/**
 * Week 6, Task 13: `CancelRefundPanel` — the two irreversible controls on
 * the booking screen (BUILD_SPEC §6 "Refunds & cancellations", §9's
 * "Cancel / refund" row).
 *
 * The panel calls `trpc.*` hooks, so every render goes through
 * `TrpcProviders` — the house pattern from `admin-bookings.test.tsx` and
 * `assign-panel.test.tsx`. No `MemoryRouter`: this component has no links.
 *
 * **Nothing here is access control, and nothing here is a money rule.** The
 * server refuses a dispatcher (`adminProcedure('cancelRefund')`) and caps
 * every refund inside `recordPayment()` under the booking row lock; both are
 * tested in `server/src/__tests__/admin-refunds.test.ts`. What these tests
 * cover is what an admin SEES and what the panel SENDS:
 *
 *  1. a dispatcher is offered nothing at all;
 *  2. neither control fires on one click — each confirms first, and the
 *     confirmation states the amount in **figures and in words**, which is
 *     the whole defence against a mistyped zero on a control with no undo;
 *  3. "Keep it" calls nothing;
 *  4. pesos typed by a human leave as CENTAVOS (money is centavos
 *     everywhere — CLAUDE.md), and a manual payment carries §6's offline
 *     method and reference while a gateway payment carries neither.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import CancelRefundPanel, { type RefundablePayment } from '@/components/admin/CancelRefundPanel';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent;

/** A paid gateway deposit — ₱1,200.00. */
const CARD_PAYMENT: RefundablePayment = {
  id: 501,
  type: 'payment',
  provider: 'paymongo',
  method: 'gcash',
  amountCentavos: 120_000,
  status: 'paid',
};

/** A paid manual transfer an admin verified by hand. */
const MANUAL_PAYMENT: RefundablePayment = {
  id: 502,
  type: 'payment',
  provider: 'manual',
  method: 'bank_transfer',
  amountCentavos: 120_000,
  status: 'paid',
};

interface Overrides {
  role?: 'owner' | 'dispatcher' | 'finance';
  status?: string;
  paidCentavos?: number;
  payments?: RefundablePayment[];
  /** Records every `cancelBooking` call, so "called nothing" is assertable. */
  onCancel?: (input: unknown) => void;
  onRefund?: (input: unknown) => void;
  cancelError?: string;
  refundError?: string;
}

function renderPanel(overrides: Overrides = {}) {
  mockTrpc({
    'staffAuth.me': { role: overrides.role ?? 'finance' },
    'admin.refunds.cancelBooking': (input: unknown) => {
      overrides.onCancel?.(input);
      if (overrides.cancelError) throw new Error(overrides.cancelError);
      return { ref: 'RG-7KQ4M9', previousStatus: 'confirmed', vanReleased: false };
    },
    'admin.refunds.refundPayment': (input: unknown) => {
      overrides.onRefund?.(input);
      if (overrides.refundError) throw new Error(overrides.refundError);
      return { paymentId: 900, bookingId: 42, provider: 'paymongo', calledGateway: true };
    },
  });

  return render(
    <TrpcProviders>
      <CancelRefundPanel
        bookingId={42}
        bookingRef="RG-7KQ4M9"
        status={overrides.status ?? 'confirmed'}
        paidCentavos={overrides.paidCentavos ?? 120_000}
        payments={overrides.payments ?? [CARD_PAYMENT]}
        onChanged={() => {}}
      />
    </TrpcProviders>,
  );
}

afterEach(resetTrpcMock);

describe('CancelRefundPanel', () => {
  /**
   * §9's row, on the screen. The server is what refuses a dispatcher — this
   * is only the courtesy of not offering an action that will be refused, and
   * the test states it that way round.
   */
  it('offers a dispatcher nothing at all', async () => {
    renderPanel({ role: 'dispatcher' });
    // The finance render below proves this query resolves, so an absent
    // heading here is the role gate and not a pending query.
    expect(await screen.findByText(/paid.*already refunded/i).catch(() => null)).toBeNull();
    expect(screen.queryByRole('heading', { name: /cancel or refund/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel this booking/i })).toBeNull();
  });

  it('shows finance what has gone back already, and calls it a guide', async () => {
    renderPanel({
      payments: [
        CARD_PAYMENT,
        { ...CARD_PAYMENT, id: 601, type: 'refund', amountCentavos: 20_000 },
      ],
    });
    const summary = await screen.findByText(/already refunded/i);
    expect(summary.textContent).toMatch(/₱1,200/);
    expect(summary.textContent).toMatch(/₱200/);
    // 1,200 paid minus 200 already refunded.
    expect(summary.textContent).toMatch(/₱1,000/);
    expect(summary.textContent).toMatch(/guide/i);
  });

  /* ---- the cancel, which is irreversible ---- */

  it('will not offer the cancel until a reason is typed', async () => {
    renderPanel();
    const button = await screen.findByRole('button', { name: /cancel this booking/i });
    expect(button.getAttribute('disabled')).not.toBeNull();

    await user.type(screen.getByLabelText(/why is it being cancelled/i), 'Typhoon signal 3.');
    expect(
      screen.getByRole('button', { name: /cancel this booking/i }).getAttribute('disabled'),
    ).toBeNull();
  });

  it('confirms the cancel by naming the booking and the amount paid, in figures and words', async () => {
    const cancels: unknown[] = [];
    renderPanel({ onCancel: (input) => cancels.push(input) });

    await user.type(
      await screen.findByLabelText(/why is it being cancelled/i),
      'Typhoon signal 3.',
    );
    await user.click(screen.getByRole('button', { name: /cancel this booking/i }));

    // Step two names the booking — the mistake this catches is cancelling
    // the booking next to the one you meant.
    expect(screen.getByText(/cancel RG-7KQ4M9\?/i)).toBeTruthy();
    const paid = screen.getByText(/has been paid on it/i);
    expect(paid.textContent).toMatch(/₱1,200/);
    expect(paid.textContent).toMatch(/One thousand two hundred pesos/);
    // And it says what the cancel does NOT do.
    expect(paid.textContent).toMatch(/does not send that back/i);
    // Nothing has fired yet.
    expect(cancels).toEqual([]);

    await user.click(screen.getByRole('button', { name: /yes — cancel RG-7KQ4M9/i }));
    expect(cancels).toEqual([{ bookingId: 42, reason: 'Typhoon signal 3.' }]);
  });

  it('calls nothing when the cancel is backed out of', async () => {
    const cancels: unknown[] = [];
    renderPanel({ onCancel: (input) => cancels.push(input) });

    await user.type(await screen.findByLabelText(/why is it being cancelled/i), 'Changed my mind.');
    await user.click(screen.getByRole('button', { name: /cancel this booking/i }));
    await user.click(screen.getByRole('button', { name: /keep it/i }));

    expect(cancels).toEqual([]);
    // Back to step one, so the admin is not left stuck.
    expect(screen.getByRole('button', { name: /cancel this booking/i })).toBeTruthy();
  });

  it('offers no cancel for a trip that has finished, and still offers the refund', async () => {
    renderPanel({ status: 'completed' });
    expect(await screen.findByText(/cannot be cancelled from here/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel this booking/i })).toBeNull();
    // §6: a refund is never a booking status, so money can still go back.
    expect(screen.getByLabelText(/amount to refund/i)).toBeTruthy();
  });

  it('shows the server’s refusal rather than swallowing it', async () => {
    renderPanel({ cancelError: 'This booking is "cancelled", so it cannot be cancelled.' });
    await user.type(await screen.findByLabelText(/why is it being cancelled/i), 'Again.');
    await user.click(screen.getByRole('button', { name: /cancel this booking/i }));
    await user.click(screen.getByRole('button', { name: /yes — cancel/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/cannot be cancelled/i);
  });

  /* ---- the refund, which is more irreversible still ---- */

  it('sends a gateway refund as centavos, with no offline record, after confirming in words', async () => {
    const refunds: unknown[] = [];
    renderPanel({ onRefund: (input) => refunds.push(input) });

    await user.type(await screen.findByLabelText(/amount to refund/i), '450');
    await user.type(screen.getByLabelText(/^why$/i), 'requested_by_customer');
    await user.click(screen.getByRole('button', { name: /refund ₱450/i }));

    expect(screen.getByText(/send ₱450 back from RG-7KQ4M9/i)).toBeTruthy();
    expect(screen.getByText(/Four hundred fifty pesos/)).toBeTruthy();
    expect(refunds, 'the refund fired without a confirmation').toEqual([]);

    await user.click(screen.getByRole('button', { name: /yes — refund ₱450/i }));
    // Pesos in, CENTAVOS out, and no `offline` key on a gateway payment.
    expect(refunds).toEqual([
      { paymentId: 501, amountCentavos: 45_000, reason: 'requested_by_customer' },
    ]);
  });

  it('requires §6’s method and reference for a payment taken by hand, then sends both', async () => {
    const refunds: unknown[] = [];
    renderPanel({ payments: [MANUAL_PAYMENT], onRefund: (input) => refunds.push(input) });

    await user.type(await screen.findByLabelText(/amount to refund/i), '1200');
    await user.type(screen.getByLabelText(/^why$/i), 'Guest cancelled in time.');
    // No reference yet, so there is nothing to click.
    expect(
      screen.getByRole('button', { name: /refund ₱1,200/i }).getAttribute('disabled'),
    ).not.toBeNull();

    await user.selectOptions(screen.getByLabelText(/how it went back/i), 'bank_transfer');
    await user.type(screen.getByLabelText(/reference/i), 'BPI 0098123');
    await user.click(screen.getByRole('button', { name: /refund ₱1,200/i }));
    await user.click(screen.getByRole('button', { name: /yes — refund ₱1,200/i }));

    expect(refunds).toEqual([
      {
        paymentId: 502,
        amountCentavos: 120_000,
        reason: 'Guest cancelled in time.',
        offline: { method: 'bank_transfer', reference: 'BPI 0098123' },
      },
    ]);
  });

  /**
   * Fix round 1, finding 5. `step={1}` on a number input does not stop
   * someone typing `450.75` — there is no form submit to validate against —
   * and both `formatPeso` and `pesosInWords` round to whole pesos, so the
   * confirmation would have read "₱451 / Four hundred fifty-one pesos" for a
   * 45,075-centavo payout. The figures-and-words line exists precisely so the
   * amount confirmed is the amount sent, so a fractional peso is refused
   * before the confirmation can appear.
   */
  it('will not confirm a fractional peso amount', async () => {
    const refunds: unknown[] = [];
    renderPanel({ onRefund: (input) => refunds.push(input) });

    await user.type(await screen.findByLabelText(/amount to refund/i), '450.75');
    await user.type(screen.getByLabelText(/^why$/i), 'requested_by_customer');

    const button = screen.getByRole('button', { name: /refund/i });
    expect(button.getAttribute('disabled')).not.toBeNull();
    await user.click(button);
    // No confirmation step, and nothing sent.
    expect(screen.queryByRole('button', { name: /yes — refund/i })).toBeNull();
    expect(refunds).toEqual([]);

    // The whole-peso amount beside it goes through, so this is the fraction
    // being refused and not the field being broken.
    await user.clear(screen.getByLabelText(/amount to refund/i));
    await user.type(screen.getByLabelText(/amount to refund/i), '450');
    await user.click(screen.getByRole('button', { name: /refund ₱450/i }));
    await user.click(screen.getByRole('button', { name: /yes — refund ₱450/i }));
    expect(refunds).toEqual([
      { paymentId: 501, amountCentavos: 45_000, reason: 'requested_by_customer' },
    ]);
  });

  it('keeps each payment’s refund form to itself', async () => {
    // A booking can carry a gateway deposit and cash verified on tour day.
    // An amount typed against one must not appear under the other.
    renderPanel({ payments: [CARD_PAYMENT, { ...MANUAL_PAYMENT, method: 'cash' }] });
    const amounts = await screen.findAllByLabelText(/amount to refund/i);
    expect(amounts).toHaveLength(2);

    await user.type(amounts[0]!, '300');
    expect((amounts[0] as HTMLInputElement).value).toBe('300');
    expect((amounts[1] as HTMLInputElement).value).toBe('');
  });

  it('says so in words when there is nothing to refund', async () => {
    renderPanel({ paidCentavos: 0, payments: [] });
    expect(await screen.findByText(/nothing to refund/i)).toBeTruthy();
  });
});
