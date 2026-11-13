/**
 * Guard for a measured bug: `/transfer` overflowed horizontally at 360px
 * because the route-label text span used `truncate`, which sets
 * `white-space: nowrap` — an unbreakable line as wide as the full
 * "<from> → <to>" string (e.g. "Mactan-Cebu International Airport → Cebu
 * City"), bleeding past its ancestors regardless of any `min-w-0` upstream
 * (`document.documentElement.scrollWidth` measured 506 vs `clientWidth` 345
 * in the QA pass that found this).
 *
 * jsdom does not reflow, so this cannot measure pixel overflow the way the
 * QA browser pass did. What it DOES prove: the specific text-bearing span no
 * longer carries `truncate` / `whitespace-nowrap` (the class that forced the
 * unbreakable line), and instead carries a wrap-enabling class
 * (`break-words`, i.e. `overflow-wrap: break-word`) so the browser is free
 * to break the place-name text onto multiple lines inside a narrow card. It
 * is a structural/class-presence assertion, not a layout measurement.
 */
import { render, screen } from '@testing-library/react';
import type { TransferRoutePublicRow } from '@rg/shared';
import { describe, expect, it } from 'vitest';
import RoutePicker from '@/components/transfer/RoutePicker';

/** Deliberately long place names, matching the QA report's example. */
const LONG_NAMES_ROUTE: TransferRoutePublicRow = {
  id: 99,
  fromPlace: { id: 1, name: 'Mactan-Cebu International Airport', placeType: 'airport' },
  toPlace: { id: 2, name: 'Cebu City', placeType: 'destination' },
  reverseEnabled: false,
  slug: 'mactan-airport-cebu-city-long',
  estimatedDurationMinutes: 40,
  freeCancelHours: 24,
  inclusionsText: null,
  exclusionsText: null,
  vehiclePrices: [],
};

describe('RoutePicker — 360px overflow guard (route-label text wrapping)', () => {
  it('does not force the place-name text onto one unbreakable line', () => {
    render(<RoutePicker routes={[LONG_NAMES_ROUTE]} value={null} onChange={() => {}} />);

    const nameSpan = screen.getByText(
      (content, element) =>
        element?.tagName.toLowerCase() === 'span' &&
        content.includes('Mactan-Cebu International Airport'),
    );

    // The bug: `truncate` applies `white-space: nowrap`, which is what made
    // this span's intrinsic width the full unbroken string. Its absence,
    // plus a wrap-enabling class, is the fix — not merely `min-w-0`
    // upstream, which the broken markup already had.
    expect(nameSpan.className).not.toMatch(/\btruncate\b/);
    expect(nameSpan.className).not.toMatch(/whitespace-nowrap/);
    expect(nameSpan.className).toMatch(/break-words|whitespace-normal/);
  });
});
