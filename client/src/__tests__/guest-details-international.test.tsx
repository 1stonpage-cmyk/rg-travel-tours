/**
 * Task 5: International phone number support for guest details forms.
 *
 * Tests that the phone field shows an international WhatsApp/Viber note
 * only when the guest enters a non-PH number.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import GuestDetails from '@/components/checkout/GuestDetails';
import TransferGuestDetailsForm from '@/components/transfer/TransferGuestDetailsForm';

const AMOUNT_DUE_NOW = { full: 150_000, deposit: 45_000 };

describe('GuestDetails — international phone note', () => {
  it('shows the WhatsApp/Viber note only for a non-PH number', async () => {
    const user = userEvent.setup();
    render(
      <GuestDetails
        payMode="deposit"
        onPayModeChange={() => {}}
        amountDueNowCentavos={AMOUNT_DUE_NOW}
      />,
    );
    const phone = screen.getByLabelText(/whatsapp.*mobile number/i);

    // Start with a PH number — no note
    await user.type(phone, '0917 123 4567');
    expect(screen.queryByText(/whatsapp or viber installed/i)).not.toBeInTheDocument();

    // Clear and type an international number — note appears
    await user.clear(phone);
    await user.type(phone, '+1 555 123 4567');
    expect(screen.getByText(/whatsapp or viber installed/i)).toBeInTheDocument();
  });
});

describe('TransferGuestDetailsForm — international phone note', () => {
  it('shows the WhatsApp/Viber note only for a non-PH number', async () => {
    const user = userEvent.setup();
    render(
      <TransferGuestDetailsForm
        productType="transfer_one_way"
        payMode="deposit"
        onPayModeChange={() => {}}
        amountDueNowCentavos={AMOUNT_DUE_NOW}
        flightDetailsRequirement="optional"
        ferryDetailsVisible={false}
      />,
    );
    const phone = screen.getByLabelText(/whatsapp.*mobile number/i);

    // Start with a PH number — no note
    await user.type(phone, '0917 123 4567');
    expect(screen.queryByText(/whatsapp or viber installed/i)).not.toBeInTheDocument();

    // Clear and type an international number — note appears
    await user.clear(phone);
    await user.type(phone, '+1 555 123 4567');
    expect(screen.getByText(/whatsapp or viber installed/i)).toBeInTheDocument();
  });
});
