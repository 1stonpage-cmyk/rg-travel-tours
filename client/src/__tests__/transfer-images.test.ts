/**
 * `client/src/lib/transfer-images.ts` (Task 1E, "Real photos for transfers
 * from free, legal stock", owner decision 2026-11-10). Covers: every known
 * vehicle-type slug resolves to its own photo, an unknown/missing slug
 * falls back to the generic photo, and every file the module points at
 * actually exists on disk — the mapping and the asset list cannot drift
 * apart silently the way `VEHICLE_IMAGE_SLUGS` and `TILES` used to
 * (BUG-130).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERIC_VEHICLE_IMAGE, VEHICLE_IMAGE_SLUGS, vehicleImageFor } from '@/lib/transfer-images';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicDir = join(clientRoot, 'public');

function assertServed(path: string): void {
  // Every src this module hands out is public-root-relative (e.g.
  // "/images/transfers/van-800.jpg"); the served file sits at the matching
  // path under client/public/.
  expect(existsSync(join(publicDir, path.replace(/^\//, '')))).toBe(true);
}

describe('transfer-images', () => {
  it('resolves each known vehicle-type slug to its own distinct photo', () => {
    const images = VEHICLE_IMAGE_SLUGS.map((slug) => vehicleImageFor(slug));
    const src800s = images.map((image) => image.src800);
    expect(new Set(src800s).size).toBe(VEHICLE_IMAGE_SLUGS.length);
    for (const image of images) {
      expect(image.src800).not.toBe(GENERIC_VEHICLE_IMAGE.src800);
    }
  });

  it('falls back to the generic image for an unrecognised slug', () => {
    expect(vehicleImageFor('coaster')).toEqual(GENERIC_VEHICLE_IMAGE);
  });

  it('falls back to the generic image when no slug is given', () => {
    expect(vehicleImageFor(undefined)).toEqual(GENERIC_VEHICLE_IMAGE);
  });

  it('every vehicle image carries non-empty alt text that says "Sample vehicle"', () => {
    const images = [
      ...VEHICLE_IMAGE_SLUGS.map((slug) => vehicleImageFor(slug)),
      GENERIC_VEHICLE_IMAGE,
    ];
    for (const image of images) {
      expect(image.alt).toMatch(/^Sample vehicle/);
    }
  });

  it('every mapped file (480w and 800w, every slug plus the generic fallback) exists on disk', () => {
    const images = [
      ...VEHICLE_IMAGE_SLUGS.map((slug) => vehicleImageFor(slug)),
      GENERIC_VEHICLE_IMAGE,
    ];
    for (const image of images) {
      assertServed(image.src480);
      assertServed(image.src800);
    }
  });
});
