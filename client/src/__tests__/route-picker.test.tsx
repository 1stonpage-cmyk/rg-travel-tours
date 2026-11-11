/**
 * `RoutePicker` (Task T13, rebuilt 2026-11-08 for the flexible
 * places/routes model) — presentational, no tRPC. Covers: renders the route
 * list with no crash, the callback fires the right `{routeId, direction}`
 * pair, the cheapest-offered-vehicle "from" price label, the empty-list and
 * loading states, a resolved field error, AND the new direction behaviour:
 * a reversible route offers both legs, a non-reversible one offers only the
 * forward leg, and picking the reverse leg reports `direction: 'reverse'`
 * for the SAME `routeId` — never a fabricated second route.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TransferRoutePublicRow } from '@rg/shared';
import { describe, expect, it, vi } from 'vitest';
import RoutePicker from '@/components/transfer/RoutePicker';

const MACTAN: TransferRoutePublicRow = {
  id: 1,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
  toPlace: { id: 11, name: 'Moalboal', isAirport: false },
  reverseEnabled: false,
  slug: 'mactan-airport-moalboal',
  estimatedDurationMinutes: 45,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 150_000,
      dayUsePriceCentavos: 400_000,
    },
    {
      vehicleTypeId: 2,
      vehicleTypeName: 'SUV',
      slug: 'suv',
      oneWayPriceCentavos: 200_000,
      dayUsePriceCentavos: 500_000,
    },
  ],
};

const OSLOB: TransferRoutePublicRow = {
  id: 2,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
  toPlace: { id: 12, name: 'Oslob', isAirport: false },
  reverseEnabled: false,
  slug: 'oslob',
  estimatedDurationMinutes: 180,
  freeCancelHours: 48,
  inclusionsText: null,
  exclusionsText: null,
  vehiclePrices: [],
};

/** A reversible route — Mactan ↔ Cebu City — used only by the direction tests below. */
const REVERSIBLE: TransferRoutePublicRow = {
  id: 3,
  fromPlace: { id: 10, name: 'Mactan-Cebu International Airport', isAirport: true },
  toPlace: { id: 13, name: 'Cebu City', isAirport: false },
  reverseEnabled: true,
  slug: 'mactan-cebu-city',
  estimatedDurationMinutes: 30,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  vehiclePrices: [
    {
      vehicleTypeId: 1,
      vehicleTypeName: 'Van',
      slug: 'van',
      oneWayPriceCentavos: 100_000,
      dayUsePriceCentavos: 300_000,
    },
  ],
};

describe('RoutePicker', () => {
  it('renders the route list with no crash', () => {
    render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} />);
    expect(screen.getByLabelText(/mactan-cebu international airport/i)).toBeInTheDocument();
  });

  it('fires onChange with the clicked routeId and direction: forward', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RoutePicker routes={[MACTAN, OSLOB]} value={null} onChange={onChange} />);

    await user.click(screen.getByLabelText(/oslob/i));
    expect(onChange).toHaveBeenCalledWith({ routeId: 2, direction: 'forward' });
  });

  it('shows "from" the cheapest OFFERED vehicle type\'s one-way price', () => {
    render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} />);
    // Van's ₱1,500 one-way is cheaper than SUV's ₱2,000 — the lower figure wins.
    expect(screen.getByText(/₱1,500/)).toBeInTheDocument();
    expect(screen.queryByText(/₱2,000/)).not.toBeInTheDocument();
  });

  it('shows "Price unavailable" when no vehicle type is offered', () => {
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

  describe('direction (owner decision 2026-11-08)', () => {
    it('offers only the forward leg for a non-reversible route', () => {
      render(<RoutePicker routes={[MACTAN]} value={null} onChange={() => {}} />);
      expect(screen.getAllByRole('radio')).toHaveLength(1);
      expect(screen.getByLabelText(/^mactan-cebu international airport/i)).toBeInTheDocument();
    });

    it('offers BOTH legs for a reversible route, same routeId, swapped labels', () => {
      render(<RoutePicker routes={[REVERSIBLE]} value={null} onChange={() => {}} />);
      const radios = screen.getAllByRole('radio');
      expect(radios).toHaveLength(2);
      // Forward: Mactan → Cebu City.
      expect(screen.getByLabelText(/^mactan-cebu international airport/i)).toBeInTheDocument();
      // Reverse: Cebu City → Mactan — the SAME route, swapped for display.
      expect(screen.getByLabelText(/^cebu city/i)).toBeInTheDocument();
    });

    it('reports direction: "reverse" for the reverse leg, with the SAME routeId as the forward leg', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<RoutePicker routes={[REVERSIBLE]} value={null} onChange={onChange} />);

      await user.click(screen.getByLabelText(/^cebu city/i));
      expect(onChange).toHaveBeenCalledWith({ routeId: 3, direction: 'reverse' });
    });

    it('marks only the leg matching BOTH routeId and direction as selected', () => {
      render(
        <RoutePicker
          routes={[REVERSIBLE]}
          value={{ routeId: 3, direction: 'reverse' }}
          onChange={() => {}}
        />,
      );
      expect(screen.getByLabelText(/^mactan-cebu international airport/i)).not.toBeChecked();
      expect(screen.getByLabelText(/^cebu city/i)).toBeChecked();
    });

    it('shows the SAME "from" price on both legs of a reversible route — price does not change by direction', () => {
      render(<RoutePicker routes={[REVERSIBLE]} value={null} onChange={() => {}} />);
      expect(screen.getAllByText(/₱1,000/)).toHaveLength(2);
    });
  });

  describe('duration is shown as a friendly estimate (Decision 6)', () => {
    it('shows "about 45 min" and "about 3 hr" for the two seeded durations', () => {
      render(<RoutePicker routes={[MACTAN, OSLOB]} value={null} onChange={() => {}} />);
      expect(screen.getByText('about 45 min')).toBeInTheDocument();
      expect(screen.getByText('about 3 hr')).toBeInTheDocument();
      expect(screen.queryByText(/~/)).not.toBeInTheDocument();
    });
  });
});
