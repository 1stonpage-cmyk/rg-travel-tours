import { Building2, MapPin, Plane, Ship, type LucideIcon } from 'lucide-react';
import type { TransferPlaceType } from '@rg/shared';

/**
 * One icon per place type, shared by the admin places screen, the admin
 * route list, the public route picker, and the admin place combobox — a
 * second independent mapping is how these four surfaces would silently
 * drift (owner decision 2026-11-13, Task 1C).
 *
 * `MapPin` for `'destination'` reuses the pin already used throughout this
 * codebase for "a place on a map" (RoutePicker.tsx's own leg label) rather
 * than introducing a new, unrelated beach/travel icon.
 */
export const PLACE_TYPE_ICON: Record<TransferPlaceType, LucideIcon> = {
  airport: Plane,
  pier: Ship,
  city: Building2,
  destination: MapPin,
};

export const PLACE_TYPE_LABEL: Record<TransferPlaceType, string> = {
  airport: 'Airport',
  pier: 'Pier / port',
  city: 'City / hotel area',
  destination: 'Destination',
};

export const PLACE_TYPE_OPTIONS: ReadonlyArray<{ value: TransferPlaceType; label: string }> = [
  { value: 'airport', label: PLACE_TYPE_LABEL.airport },
  { value: 'pier', label: PLACE_TYPE_LABEL.pier },
  { value: 'city', label: PLACE_TYPE_LABEL.city },
  { value: 'destination', label: PLACE_TYPE_LABEL.destination },
];
