/**
 * Vehicle types for the van/SUV transfer product (owner decision 2026-10-28).
 * This file is seeded here minimally — a later task (the transfers booking
 * flow) extends it with quote/hold input schemas. Do not add anything else
 * here yet; keep this task's footprint to exactly what it needs.
 */
export const VEHICLE_TYPES = ['van', 'suv'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
