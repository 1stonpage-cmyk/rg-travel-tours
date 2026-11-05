/**
 * `VehicleOptionCard` (Task T13) — presentational, no tRPC, and the
 * component that must never compute money. Covers: the three distinct
 * states (loading / unavailable / normal), the callback fires on select,
 * the `payMode`-keyed "due now" figure, and a resolved field error.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QuoteTransferResult } from '@rg/shared';
import { describe, expect, it, vi } from 'vitest';
import VehicleOptionCard from '@/components/transfer/VehicleOptionCard';

const QUOTE: QuoteTransferResult = {
  subtotalCentavos: 150_000,
  discountCentavos: 0,
  totalCentavos: 150_000,
  depositCentavos: 45_000,
  amountDueNowCentavos: { full: 150_000, deposit: 45_000 },
  balanceCentavos: { full: 0, deposit: 105_000 },
  freeCancelHours: 24,
};

describe('VehicleOptionCard', () => {
  it('renders the normal state with the total and the deposit-mode due-now figure, no crash', () => {
    render(
      <VehicleOptionCard
        vehicleType="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByText('Van')).toBeInTheDocument();
    expect(screen.getByText('₱1,500')).toBeInTheDocument();
    expect(screen.getByText(/₱450 due now/)).toBeInTheDocument();
  });

  it('shows the FULL amountDueNowCentavos figure when payMode is full', () => {
    render(
      <VehicleOptionCard
        vehicleType="suv"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="full"
      />,
    );
    expect(screen.getByText(/₱1,500 due now/)).toBeInTheDocument();
  });

  it('fires onSelect when the card is chosen', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <VehicleOptionCard
        vehicleType="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={onSelect}
        payMode="deposit"
      />,
    );
    await user.click(screen.getByRole('radio'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders a loading state (skeleton), with no price and no crash', () => {
    render(
      <VehicleOptionCard
        vehicleType="van"
        quote={undefined}
        isLoading={true}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByTestId('vehicle-option-van-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/₱/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('renders a distinct "not available" state when quote is undefined and NOT loading', () => {
    render(
      <VehicleOptionCard
        vehicleType="suv"
        quote={undefined}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByText(/not available for this route/i)).toBeInTheDocument();
    expect(screen.queryByTestId('vehicle-option-suv-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('renders a resolved error message describing the radio', () => {
    render(
      <VehicleOptionCard
        vehicleType="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
        error="Choose a vehicle."
      />,
    );
    const message = screen.getByText('Choose a vehicle.');
    expect(message).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('radio')).toHaveAttribute('aria-describedby', message.id);
  });
});
