/**
 * Bug 1B: a direct unit test of `<PaymentOptions>`'s `justHeld` prop.
 *
 * `checkout-page.test.tsx` and `transfer-booking-page.test.tsx` already cover
 * this through the two just-created-hold screens that pass `justHeld`, and
 * `booking-status.test.tsx` covers the retry screen that must keep omitting
 * it. This file isolates the component itself: `justHeld` sends the
 * manual-transfer link straight to `/portal/pay`, and omitting the prop (or
 * passing `justHeld={false}`) keeps the existing `/portal/login?ref=...`
 * round trip unchanged — the exact two states `manualPayPath()` now branches
 * on.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PaymentOptions from '@/components/checkout/PaymentOptions';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const REF = 'RG-UNIT01';

function renderPaymentOptions(props: { justHeld?: boolean } = {}) {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <PaymentOptions bookingRef={REF} {...props} />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PaymentOptions — manual-transfer link target (Bug 1B)', () => {
  it('justHeld sends the manual-transfer link straight to /portal/pay', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        onlinePaymentEnabled: true,
        manualTransferEnabled: true,
      },
    });
    renderPaymentOptions({ justHeld: true });

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    expect(link).toHaveAttribute('href', '/portal/pay');
  });

  it('omitting justHeld keeps the existing portal sign-in round trip', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        onlinePaymentEnabled: true,
        manualTransferEnabled: true,
      },
    });
    renderPaymentOptions();

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    expect(link).toHaveAttribute('href', `/portal/login?ref=${REF}&next=/portal/pay`);
  });

  it('justHeld={false} is identical to omitting the prop', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        onlinePaymentEnabled: true,
        manualTransferEnabled: true,
      },
    });
    renderPaymentOptions({ justHeld: false });

    const link = await screen.findByRole('link', { name: /gcash, maya or bank transfer/i });
    expect(link).toHaveAttribute('href', `/portal/login?ref=${REF}&next=/portal/pay`);
  });
});
