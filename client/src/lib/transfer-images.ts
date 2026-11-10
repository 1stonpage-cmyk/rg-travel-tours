/**
 * Shared source of truth for the transfer vehicle-card photos (Task 1C,
 * "Real photos for transfers from free, legal stock", owner decision
 * 2026-11-10; see `docs/IMAGE_CREDITS.md` and `HANDOVER-18`).
 *
 * **Resolves BUG-130.** `VehicleOptionCard.tsx` used to keep its own
 * `VEHICLE_IMAGE_SLUGS` set, agreeing only by hand with
 * `generate-placeholders.mjs`'s `TILES` array — two lists that could drift
 * with no build error if one changed and not the other. This module is now
 * the ONE place that knows which vehicle-type slugs have a photo of their
 * own; `VehicleOptionCard` imports `VEHICLE_IMAGE_SLUGS` and
 * `vehicleImageFor` directly. `generate-placeholders.mjs` is plain `.mjs`
 * and cannot import this `.ts` module, so it no longer generates vehicle
 * tiles at all — there is nothing left for it to generate, since every
 * vehicle-type slug this component can show now resolves to a real photo
 * below, including the fallback.
 *
 * **These are free stock photos, not R&G's fleet.** Owner decision
 * 2026-11-10: real photos are illustrative only, until R&G supplies its
 * own. Every entry's `alt` text says "Sample vehicle" for screen readers,
 * and `VehicleOptionCard` additionally renders a visible "Sample vehicle"
 * caption on the image — never let a vehicle image here read as a specific
 * promise about the van that shows up.
 *
 * **An unrecognised or missing slug renders `GENERIC_VEHICLE_IMAGE`, never
 * a broken image.** Vehicle types are an admin-managed list of arbitrary
 * size (owner decision 2026-11-08) — a type added tomorrow has no photo
 * this module could have known to include, so it falls through to the one
 * generic photo rather than a path nothing generated.
 */

export const VEHICLE_IMAGE_SLUGS = ['van', 'suv', 'mpv'] as const;

export type VehicleImageSlug = (typeof VEHICLE_IMAGE_SLUGS)[number];

export type VehicleImage = {
  /** 480w JPEG, for the `srcset` narrow candidate. */
  src480: string;
  /** 800w JPEG, for the `srcset` wide candidate and the plain `src` fallback. */
  src800: string;
  /** Describes the scene for screen readers, and says "Sample vehicle" explicitly. */
  alt: string;
};

const IMAGE_BASE = '/images/transfers';

/** The fallback for any vehicle-type slug with no photo of its own. */
export const GENERIC_VEHICLE_IMAGE: VehicleImage = {
  src480: `${IMAGE_BASE}/generic-480.jpg`,
  src800: `${IMAGE_BASE}/generic-800.jpg`,
  alt: 'Sample vehicle — a generic white car, shown for illustration only.',
};

const VEHICLE_IMAGES: Record<VehicleImageSlug, VehicleImage> = {
  van: {
    src480: `${IMAGE_BASE}/van-480.jpg`,
    src800: `${IMAGE_BASE}/van-800.jpg`,
    alt: 'Sample vehicle — a white passenger van, shown for illustration only.',
  },
  suv: {
    src480: `${IMAGE_BASE}/suv-480.jpg`,
    src800: `${IMAGE_BASE}/suv-800.jpg`,
    alt: 'Sample vehicle — a white SUV, shown for illustration only.',
  },
  mpv: {
    src480: `${IMAGE_BASE}/mpv-480.jpg`,
    src800: `${IMAGE_BASE}/mpv-800.jpg`,
    alt: 'Sample vehicle — a people-carrier minivan, shown for illustration only.',
  },
};

function isVehicleImageSlug(slug: string): slug is VehicleImageSlug {
  return (VEHICLE_IMAGE_SLUGS as readonly string[]).includes(slug);
}

/** The photo for a vehicle-type slug, or `GENERIC_VEHICLE_IMAGE` for anything unmapped. */
export function vehicleImageFor(vehicleTypeSlug: string | undefined): VehicleImage {
  if (vehicleTypeSlug && isVehicleImageSlug(vehicleTypeSlug)) {
    return VEHICLE_IMAGES[vehicleTypeSlug];
  }
  return GENERIC_VEHICLE_IMAGE;
}
