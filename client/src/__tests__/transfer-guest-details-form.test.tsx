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

/**
 * `flightDetailsRequirement` defaults to `'optional'` here, not `'hidden'`
 * — the tests that call `show()` without a third argument (the general
 * rendering tests below) predate the three-state prop and are checking
 * that the flight fields RENDER at all, which `'optional'` still does
 * (shown, not required) and `'hidden'` would not.
 */
function show(
  productType: 'transfer_one_way' | 'transfer_day_use',
  error?: unknown,
  flightDetailsRequirement: 'required' | 'optional' | 'hidden' = 'optional',
) {
  return render(
    <TransferGuestDetailsForm
      productType={productType}
      payMode="deposit"
      onPayModeChange={() => {}}
      amountDueNowCentavos={AMOUNT_DUE_NOW}
      flightDetailsRequirement={flightDetailsRequirement}
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
        flightDetailsRequirement="optional"
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
   * **Owner decision 3, 2026-11-09, narrowing decision 5 from 2026-11-08.**
   * The old rule had TWO states (required / optional-shown); this one has
   * THREE (required / optional-shown / hidden entirely). The 'required'
   * and 'optional' tests below are the direct descendants of the old
   * true/false tests — same assertions, renamed prop and values — and the
   * 'hidden' test is new: under the superseded rule the fields rendered
   * (optional) on EVERY one-way transfer regardless of airport-ness, so
   * there was no "not shown at all" state to test. All three states must
   * render visibly differently, or a guest could submit with no way to
   * tell which rule applied to the fields in front of them.
   */
  describe('flightDetailsRequirement (owner decision 2026-11-09)', () => {
    it('marks flightNumber/airline as required, with no "(optional)" suffix, when "required"', () => {
      show('transfer_one_way', undefined, 'required');
      const flightNumber = screen.getByLabelText(/^flight number$/i);
      const airline = screen.getByLabelText(/^airline$/i);
      expect(flightNumber).toBeRequired();
      expect(airline).toBeRequired();
      expect(screen.getByText(/touches the airport/i)).toBeInTheDocument();
    });

    it('leaves flightNumber/airline optional, suffixed "(optional)", when "optional"', () => {
      show('transfer_one_way', undefined, 'optional');
      const flightNumber = screen.getByLabelText(/flight number \(optional\)/i);
      const airline = screen.getByLabelText(/airline \(optional\)/i);
      expect(flightNumber).not.toBeRequired();
      expect(airline).not.toBeRequired();
      expect(screen.queryByText(/touches the airport/i)).not.toBeInTheDocument();
    });

    /**
     * New under decision 3: neither place is an airport, so the whole
     * block — not just the "required" marker — does not render at all on
     * a one-way transfer.
     */
    it('does not render flightNumber/airline at all when "hidden"', () => {
      show('transfer_one_way', undefined, 'hidden');
      expect(screen.queryByLabelText(/flight number/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/airline/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/touches the airport/i)).not.toBeInTheDocument();
    });

    it('still hides flightNumber/airline entirely on a day-use hire, even when flightDetailsRequirement is "required"', () => {
      show('transfer_day_use', undefined, 'required');
      expect(screen.queryByLabelText(/flight number/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/airline/i)).not.toBeInTheDocument();
    });
  });
});
