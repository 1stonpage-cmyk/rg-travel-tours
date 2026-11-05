/**
 * Task T14 — `TransferBookingPage.tsx`. Covers the happy path (type → route
 * → vehicle → guest details → submit → `<PaymentOptions>`) and the "vehicle
 * unavailable for this route" rendering when one of the two `quoteTransfer`
 * queries throws (BAD_REQUEST/NOT_FOUND both render the same state — this
 * exercises NOT_FOUND, mirroring `VehicleOptionCard`'s own test).
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TransferRoutePublicRow } from '@rg/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TransferBookingPage from '@/pages/public/TransferBookingPage';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, trpcError } from './helpers/mock-trpc';

const MACTAN: TransferRoutePublicRow = {
  id: 1,
  destinationName: 'Mactan-Cebu International Airport',
  slug: 'mactan-airport',
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  prices: {
    van: { oneWayPriceCentavos: 150_000, dayUsePriceCentavos: 400_000 },
    suv: { oneWayPriceCentavos: 200_000, dayUsePriceCentavos: 500_000 },
  },
};

const VAN_QUOTE = {
  subtotalCentavos: 150_000,
  discountCentavos: 0,
  totalCentavos: 150_000,
  depositCentavos: 45_000,
  amountDueNowCentavos: { full: 150_000, deposit: 45_000 },
  balanceCentavos: { full: 0, deposit: 105_000 },
  freeCancelHours: 24,
};

const SUV_QUOTE = {
  ...VAN_QUOTE,
  subtotalCentavos: 200_000,
  totalCentavos: 200_000,
  amountDueNowCentavos: { full: 200_000, deposit: 60_000 },
};

const HOLD_RESULT = {
  ref: 'RG-TRF001',
  bookingId: 99,
  holdExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

function renderPage(entry = '/transfer') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/transfer" element={<TransferBookingPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

async function selectTypeAndRoute(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: /airport transfer/i }));
  await user.click(
    await screen.findByRole('radio', { name: /mactan-cebu international airport/i }),
  );
}

describe('TransferBookingPage — happy path', () => {
  it('walks type → route → vehicle → guest details → submit → shows PaymentOptions', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleType } = input as { vehicleType: 'van' | 'suv' };
        return vehicleType === 'van' ? VAN_QUOTE : SUV_QUOTE;
      },
      'checkout.createHoldTransfer': () => HOLD_RESULT,
      'settings.get': SETTINGS_FIXTURE,
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    // Settles out of its skeleton once the quote resolves. Checked via the
    // radio's own disabled state, not the price text, which also appears
    // in `RoutePicker`'s own "from ₱1,500" line on this same screen.
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    await user.click(vanRadio);

    const form = await screen.findByRole('form', { name: /transfer booking form/i });
    fireEvent.change(within(form).getByLabelText(/pickup date/i), {
      target: { value: '2026-12-15' },
    });
    fireEvent.change(within(form).getByLabelText(/pickup time/i), {
      target: { value: '08:30' },
    });
    await user.clear(within(form).getByLabelText(/^passengers$/i));
    await user.type(within(form).getByLabelText(/^passengers$/i), '2');
    await user.clear(within(form).getByLabelText(/^bags$/i));
    await user.type(within(form).getByLabelText(/^bags$/i), '1');
    await user.type(within(form).getByLabelText(/drop-off address/i), 'SM Seaside, Cebu City');
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));

    await user.click(within(form).getByRole('button', { name: /book now/i }));

    expect(await screen.findByText(/RG-TRF001/)).toBeInTheDocument();
  });
});

describe('TransferBookingPage — vehicle unavailable for this route', () => {
  it('renders the SUV card as unavailable, without blanking the rest of the page, while Van prices normally', async () => {
    mockTrpc({
      'transferRoutes.list': [MACTAN],
      'checkout.quoteTransfer': (input: unknown) => {
        const { vehicleType } = input as { vehicleType: 'van' | 'suv' };
        if (vehicleType === 'suv') {
          throw trpcError('No price is available for that route and vehicle.', 'NOT_FOUND');
        }
        return VAN_QUOTE;
      },
    });
    const user = userEvent.setup();
    renderPage();

    await selectTypeAndRoute(user);

    const vanRadio = await screen.findByRole('radio', { name: /^van/i });
    await waitFor(() => expect(vanRadio).not.toBeDisabled());
    expect(await screen.findByText(/not available for this route/i)).toBeInTheDocument();

    const suvRadio = screen.getByRole('radio', { name: /^suv/i });
    expect(suvRadio).toBeDisabled();
  });
});
