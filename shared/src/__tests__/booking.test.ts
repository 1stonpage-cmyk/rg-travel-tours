/**
 * `shared/src/booking.ts` — the transfer price snapshot and its display-label
 * helper (owner decision 2026-11-08, flexible places/routes/vehicle types —
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md` §1.8).
 *
 * **Why this file exists even though nothing in the codebase calls
 * `transferSnapshotVehicleTypeLabel` yet.** The design note's own "right-sized
 * acceptance criterion" (§1.8) says the label helper is "nice-to-have UI
 * correctness, tested alongside T22/T23/T24 when those tasks actually call
 * it" — but it is also pure and takes no database, so there is no reason to
 * leave it unproven until some later task happens to import it. This file is
 * that proof: both shapes a snapshot can hold resolve to a sensible string,
 * and the schema's own `.refine()` guard (a snapshot with NEITHER shape must
 * fail to parse) is pinned directly.
 */
import { describe, expect, it } from 'vitest';
import {
  TRANSFER_PRICE_SOURCES,
  transferPriceSnapshotSchema,
  transferSnapshotVehicleTypeLabel,
  type TransferPriceSnapshot,
} from '../booking';
import { TRANSFER_PRODUCT_TYPES } from '../transfers';

/** Every field `transferPriceSnapshotSchema` requires, minus the vehicle-type ones. */
const BASE = {
  productType: TRANSFER_PRODUCT_TYPES[0],
  routeId: 1,
  customRouteDescription: null,
  priceSource: TRANSFER_PRICE_SOURCES[0],
  priceCentavos: 250_000,
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 24,
  subtotalCentavos: 250_000,
  discountCentavos: 0,
  totalCentavos: 250_000,
} as const;

describe('transferPriceSnapshotSchema', () => {
  it('parses a PRE-MIGRATION-shaped snapshot — legacy vehicleType, no vehicleTypeId', () => {
    // Exactly what every transfer booking written before 2026-11-08 has
    // stored: the literal 'van'/'suv' string, nothing else about the type.
    const legacy: unknown = { ...BASE, vehicleType: 'van' };
    const result = transferPriceSnapshotSchema.safeParse(legacy);
    expect(result.success).toBe(true);
  });

  it('parses a NEW-shaped snapshot — vehicleTypeId + vehicleTypeName, no legacy vehicleType', () => {
    const current: unknown = { ...BASE, vehicleTypeId: 7, vehicleTypeName: 'Van' };
    expect(transferPriceSnapshotSchema.safeParse(current).success).toBe(true);
  });

  /**
   * The hardening `.refine()` added specifically because `vehicleType`,
   * `vehicleTypeId` and `vehicleTypeName` are ALL `.optional()` — without this
   * guard a snapshot carrying none of the three would still parse cleanly and
   * the label helper's fallback would hide that forever. Mutation-proved: see
   * the task report for the break/confirm-red/restore/confirm-green record.
   */
  it('REFUSES a snapshot carrying NEITHER a legacy vehicleType NOR a vehicleTypeId', () => {
    const neither: unknown = { ...BASE };
    const result = transferPriceSnapshotSchema.safeParse(neither);
    expect(result.success).toBe(false);
  });
});

describe('transferSnapshotVehicleTypeLabel', () => {
  const valid = (overrides: Partial<TransferPriceSnapshot>): TransferPriceSnapshot =>
    transferPriceSnapshotSchema.parse({ ...BASE, ...overrides });

  it('prefers the frozen vehicleTypeName when the NEW shape is present', () => {
    const snapshot = valid({ vehicleTypeId: 7, vehicleTypeName: 'Mini Van (10-seater)' });
    expect(transferSnapshotVehicleTypeLabel(snapshot)).toBe('Mini Van (10-seater)');
  });

  it('title-cases the legacy literal string for an old booking with no vehicleTypeId', () => {
    const vanSnapshot = valid({ vehicleType: 'van' });
    const suvSnapshot = valid({ vehicleType: 'suv' });
    expect(transferSnapshotVehicleTypeLabel(vanSnapshot)).toBe('Van');
    expect(transferSnapshotVehicleTypeLabel(suvSnapshot)).toBe('Suv');
  });

  it('prefers vehicleTypeName over a stray legacy vehicleType when BOTH happen to be present', () => {
    // Not a shape any real writer produces (buildTransferSnapshot never
    // writes `vehicleType`), but the schema does not forbid it, and the
    // helper's own fallback order is the thing under test here.
    const snapshot = valid({
      vehicleType: 'van',
      vehicleTypeId: 9,
      vehicleTypeName: 'SUV (7-seater)',
    });
    expect(transferSnapshotVehicleTypeLabel(snapshot)).toBe('SUV (7-seater)');
  });
});
