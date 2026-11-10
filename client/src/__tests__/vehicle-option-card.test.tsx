/**
 * `VehicleOptionCard` (Task T13, rebuilt 2026-11-08 for the admin-managed
 * vehicle-types model) — presentational, no tRPC, and the component that
 * must never compute money. Covers: the three distinct states (loading /
 * unavailable / normal), the callback fires on select, the `payMode`-keyed
 * "due now" figure, a resolved field error, and that the card renders
 * whatever `vehicleTypeId`/`vehicleTypeName` it is given rather than a
 * hard-coded van/suv pair (a THIRD, arbitrary type renders correctly with
 * no code change needed).
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
        vehicleTypeId={1}
        vehicleTypeName="Van"
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
        vehicleTypeId={2}
        vehicleTypeName="SUV"
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
        vehicleTypeId={1}
        vehicleTypeName="Van"
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
        vehicleTypeId={1}
        vehicleTypeName="Van"
        quote={undefined}
        isLoading={true}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByTestId('vehicle-option-1-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/₱/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('renders a distinct "not available" state when quote is undefined and NOT loading', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={2}
        vehicleTypeName="SUV"
        quote={undefined}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByText(/not available for this route/i)).toBeInTheDocument();
    expect(screen.queryByTestId('vehicle-option-2-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('renders a resolved error message describing the radio', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
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
    // The radio also always points at its price/status block (see the
    // "accessible name" test below) — the error id is appended, not swapped in.
    const describedBy = screen.getByRole('radio').getAttribute('aria-describedby');
    expect(describedBy?.split(' ')).toContain(message.id);
  });

  it("gives the radio a stable accessible NAME (the vehicle type alone), never the card photo's alt text", () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        vehicleTypeSlug="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    // Before the real photo's alt text existed, the radio's accessible name
    // came implicitly from the surrounding <label>'s text content. An <img>
    // with meaningful alt text sitting in that same label would otherwise
    // leak into the name too (verified by temporarily removing the explicit
    // aria-label while building this test — the name then started with
    // "Sample vehicle — a white passenger van…" instead of "Van").
    expect(screen.getByRole('radio', { name: 'Van' })).toBeInTheDocument();
  });

  it('describes the radio with its price/status block, so the "due now" figure is still reachable by assistive tech', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    const radio = screen.getByRole('radio');
    const [firstDescribedById] = (radio.getAttribute('aria-describedby') ?? '').split(' ');
    const detailsEl = document.getElementById(firstDescribedById ?? '');
    expect(detailsEl).toHaveTextContent('₱450 due now');
  });

  it('renders a THIRD, arbitrary vehicle type with no code change — never a hard-coded van/suv pair', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={7}
        vehicleTypeName="Coaster"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByText('Coaster')).toBeInTheDocument();
  });

  it('uses the matching sample photo for a known vehicle-type slug', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        vehicleTypeSlug="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    const image = screen.getByTestId('vehicle-option-1-image');
    expect(image).toHaveAttribute('src', '/images/transfers/van-800.jpg');
    expect(image).toHaveAttribute(
      'srcset',
      '/images/transfers/van-480.jpg 480w, /images/transfers/van-800.jpg 800w',
    );
  });

  it('falls back to the generic image for an unrecognised slug, never a broken image', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={7}
        vehicleTypeName="Coaster"
        vehicleTypeSlug="coaster"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByTestId('vehicle-option-7-image')).toHaveAttribute(
      'src',
      '/images/transfers/generic-800.jpg',
    );
  });

  it('falls back to the generic image when no slug is given at all', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByTestId('vehicle-option-1-image')).toHaveAttribute(
      'src',
      '/images/transfers/generic-800.jpg',
    );
  });

  it('gives every vehicle image real alt text that says "Sample vehicle"', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        vehicleTypeSlug="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    const image = screen.getByTestId('vehicle-option-1-image');
    expect(image.getAttribute('alt')).toMatch(/^Sample vehicle/);
  });

  it('shows a visible "Sample vehicle" caption on the card', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        vehicleTypeSlug="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    expect(screen.getByText('Sample vehicle')).toBeInTheDocument();
  });

  it('lazy-loads the vehicle image (it is always below the fold)', () => {
    render(
      <VehicleOptionCard
        vehicleTypeId={1}
        vehicleTypeName="Van"
        vehicleTypeSlug="van"
        quote={QUOTE}
        isLoading={false}
        isSelected={false}
        onSelect={() => {}}
        payMode="deposit"
      />,
    );
    const image = screen.getByTestId('vehicle-option-1-image');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });
});
