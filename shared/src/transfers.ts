/**
 * Shared discriminators for the van/SUV transfer product (owner decision
 * 2026-10-28/31). Both constants are plain data with no Zod and no database
 * anywhere near them, so every surface — schema, server, client — reads the
 * same vocabulary.
 *
 * A later task (the transfers booking flow) adds the quote/hold input
 * schemas here. Keep this file to the shared vocabulary itself: anything
 * admin-shaped belongs in `transfers-admin.ts`.
 */
export const VEHICLE_TYPES = ['van', 'suv'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * What a booking IS — the `bookings.product_type` discriminator.
 *
 * `'tour'` is first and is the column's default, because every booking that
 * existed before the column did was a tour. The two transfer members are the
 * two products the plan sells: a one-way point-to-point trip and a day-use
 * hire (the same vehicle held for the day), which price from different
 * columns of `transfer_route_vehicle_prices`.
 */
export const PRODUCT_TYPES = ['tour', 'transfer_one_way', 'transfer_day_use'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
