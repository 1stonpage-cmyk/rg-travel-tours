/**
 * `TransferGuestDetailsForm` (Task T13) — presentational, no tRPC. Modelled
 * on `GuestDetails.tsx`'s own untested-in-isolation shape, so this is the
 * first direct unit test of that pattern: plain uncontrolled inputs, a
 * controlled `payMode` pair, conditional fields keyed on `productType`, and
 * `getNestedFieldError`/`getFieldErrors` wiring built with a real
 * `TRPCClientError` — the same construction `field-errors-lib.test.ts` uses,
 * so this exercises the real reader rather than a hand-shaped stand-in.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';
import TransferGuestDetailsForm from '@/components/transfer/TransferGuestDetailsForm';

const AMOUNT_DUE_NOW = { full: 150_000, deposit: 45_000 };

function refusal(data: Record<string, unknown>, message = 'nope'): TRPCClientError<never> {
  return TRPCClientError.from({ error: { message, code: -32600, data } } as never);
}

function validationError(opts: {
  fieldErrors?: Record<string, string[]>;
  nestedFieldErrors?: Record<string, string[]>;
}) {
  return refusal({
    code: 'BAD_REQUEST',
    httpStatus: 400,
    zodError: {
      formErrors: [],
      fieldErrors: opts.fieldErrors ?? {},
      nestedFieldErrors: opts.nestedFieldErrors ?? {},
    },
  });
}

function show(
  productType: 'transfer_one_way' | 'transfer_day_use',
  error?: unknown,
  requiresFlightDetails = false,
) {
  return render(
    <TransferGuestDetailsForm
      productType={productType}
      payMode="deposit"
      onPayModeChange={() => {}}
      amountDueNowCentavos={AMOUNT_DUE_NOW}
      requiresFlightDetails={requiresFlightDetails}
      error={error}
    />,
  );
}

describe('TransferGuestDetailsForm', () => {
  it('renders the common fields for a one-way transfer with no crash', () => {
    show('transfer_one_way');
    expect(screen.getByLabelText(/pickup date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pickup time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^passengers$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^bags$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/drop-off address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/i agree/i)).toBeInTheDocument();
  });

  it('shows flightNumber/airline and hides dayUseEndTime for a one-way transfer', () => {
    show('transfer_one_way');
    expect(screen.getByLabelText(/flight number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/airline/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/vehicle needed until/i)).not.toBeInTheDocument();
  });

  it('shows dayUseEndTime and hides flightNumber/airline for a day-use hire', () => {
    show('transfer_day_use');
    expect(screen.getByLabelText(/vehicle needed until/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/flight number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/airline/i)).not.toBeInTheDocument();
  });

  it('fires onPayModeChange with the clicked mode', async () => {
    const onPayModeChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TransferGuestDetailsForm
        productType="transfer_one_way"
        payMode="deposit"
        onPayModeChange={onPayModeChange}
        amountDueNowCentavos={AMOUNT_DUE_NOW}
        requiresFlightDetails={false}
      />,
    );
    await user.click(screen.getByLabelText(/pay in full/i));
    expect(onPayModeChange).toHaveBeenCalledWith('full');
  });

  it('shows the amountDueNowCentavos figure for each pay-mode radio', () => {
    show('transfer_one_way');
    expect(screen.getByText('₱450 due now')).toBeInTheDocument();
    expect(screen.getByText('₱1,500 due now')).toBeInTheDocument();
  });

  it('puts the phone leaf message under the mobile input, via getNestedFieldError, and not under name/email', () => {
    const PHONE_MESSAGE = 'Enter a valid PH mobile number, like 0917 123 4567';
    show(
      'transfer_one_way',
      validationError({
        fieldErrors: { lead: [PHONE_MESSAGE] },
        nestedFieldErrors: { 'lead.phone': [PHONE_MESSAGE] },
      }),
    );
    const phone = screen.getByLabelText(/mobile number/i);
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(PHONE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText(/^email$/i)).not.toHaveAttribute('aria-invalid');
  });

  it('puts a top-level field message (dropoffAddress) under its own input', () => {
    const MESSAGE = 'Enter where you are going.';
    show('transfer_one_way', validationError({ fieldErrors: { dropoffAddress: [MESSAGE] } }));
    const dropoff = screen.getByLabelText(/drop-off address/i);
    expect(dropoff).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });

  it("shows createHoldTransferInput's own consent refusal via ConsentCheckbox", () => {
    show(
      'transfer_one_way',
      validationError({ fieldErrors: { consent: ['Consent is required'] } }),
    );
    expect(screen.getByText('Consent is required')).toBeInTheDocument();
  });

  /**
   * Owner decision 2026-11-08, decision 5 — flight fields are required
   * client-side when the SELECTED ROUTE touches an airport at either end.
   * This is UX polish only (the component's own header note); the server
   * enforces the real rule post-catalog-read. Both states must render
   * visibly differently, or a guest on an airport route could submit with
   * no way to tell the fields were ever optional.
   */
  describe('requiresFlightDetails (owner decision 2026-11-08)', () => {
    it('marks flightNumber/airline as required, with no "(optional)" suffix, when true', () => {
      show('transfer_one_way', undefined, true);
      const flightNumber = screen.getByLabelText(/^flight number$/i);
      const airline = screen.getByLabelText(/^airline$/i);
      expect(flightNumber).toBeRequired();
      expect(airline).toBeRequired();
      expect(screen.getByText(/touches the airport/i)).toBeInTheDocument();
    });

    it('leaves flightNumber/airline optional, suffixed "(optional)", when false', () => {
      show('transfer_one_way', undefined, false);
      const flightNumber = screen.getByLabelText(/flight number \(optional\)/i);
      const airline = screen.getByLabelText(/airline \(optional\)/i);
      expect(flightNumber).not.toBeRequired();
      expect(airline).not.toBeRequired();
      expect(screen.queryByText(/touches the airport/i)).not.toBeInTheDocument();
    });

    it('still hides flightNumber/airline entirely on a day-use hire, even when requiresFlightDetails is true', () => {
      show('transfer_day_use', undefined, true);
      expect(screen.queryByLabelText(/flight number/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/airline/i)).not.toBeInTheDocument();
    });
  });
});
