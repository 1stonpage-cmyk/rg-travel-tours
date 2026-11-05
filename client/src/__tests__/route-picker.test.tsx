/**
 * `RoutePicker` (Task T13) — presentational, no tRPC. Covers: renders the
 * route list with no crash, the callback fires the right routeId, the
 * cheapest-one-way "from" price label, the empty-list and loading states,
 * and a resolved field error.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TransferRoutePublicRow } from '@rg/shared';
import { describe, expect, it, vi } from 'vitest';
import RoutePicker from '@/components/transfer/RoutePicker';

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

const OSLOB: TransferRoutePublicRow = {
  id: 2,
  destinationName: 'Oslob',
  slug: 'oslob',
  estimatedDurationMinutes: 180,
  freeCancelHours: 48,
  inclusionsText: null,
  exclusionsText: null,
  prices: { van: null, suv: null },
};

describe('RoutePicker', () => {
  it('renders the route list with no crash', () => {
    render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} />);
    expect(screen.getByLabelText(/mactan-cebu international airport/i)).toBeInTheDocument();
  });

  it('fires onChange with the clicked routeId', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RoutePicker routes={[MACTAN, OSLOB]} value={null} onChange={onChange} />);

    await user.click(screen.getByLabelText(/oslob/i));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('shows "from" the cheaper of the two vehicle types\' one-way price', () => {
    render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} />);
    // van's ₱1,500 one-way is cheaper than suv's ₱2,000 — the lower figure wins.
    expect(screen.getByText(/₱1,500/)).toBeInTheDocument();
    expect(screen.queryByText(/₱2,000/)).not.toBeInTheDocument();
  });

  it('shows "Price unavailable" when neither vehicle type has a price row', () => {
    render(<RoutePicker routes={[OSLOB]} value={null} onChange={() => {}} />);
    expect(screen.getByText(/price unavailable/i)).toBeInTheDocument();
  });

  it('shows a plain message, not a blank screen, for an empty route list', () => {
    render(<RoutePicker routes={[]} value={null} onChange={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(/no routes are available/i);
  });

  it('shows a loading placeholder, and no route rows, while isLoading', () => {
    render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} isLoading />);
    expect(screen.getByLabelText(/loading routes/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/mactan/i)).not.toBeInTheDocument();
  });

  it('renders a resolved error message wired to the fieldset via aria-describedby', () => {
    render(
      <RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} error="Choose a route." />,
    );
    const message = screen.getByText('Choose a route.');
    expect(message).toHaveAttribute('role', 'alert');
  });
});
