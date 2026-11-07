-- Flexible transfer places/routes/vehicle types (owner decision 2026-11-08).
-- Stage 2 of 2: drops the old columns migration 0023 kept alongside the new
-- ones, enforces NOT NULL, and swaps the three affected constraints.
--
-- `drizzle-kit generate`'s raw output for this diff got two orderings wrong
-- (caught in review before this file was finalized — see
-- docs/superpowers/plans/2026-11-08-flexible-routes.md §1.3/§1.4):
--
--  1. It dropped `transfer_routes_destination_id_unique` BEFORE dropping the
--     FK `transfer_routes_destination_id_destinations_id_fk` that backs onto
--     it. MySQL refuses to drop an index a foreign key still needs — the FK
--     must go first.
--  2. It issued `DROP PRIMARY KEY` on `transfer_route_vehicle_prices`
--     without first dropping `transfer_route_vehicle_prices_route_id_transfer_routes_id_fk`
--     — that FK was added by a later ALTER in migration 0016, after the PK
--     already existed, so InnoDB reused the PK as that FK's OWN backing
--     index rather than building a second one. Dropping the PK with that FK
--     still pointing at it fails with ERROR 1553 ("Cannot drop index
--     'PRIMARY': needed in a foreign key constraint"). The FK must be
--     dropped first and re-added after the new PK exists.
--
-- Both are fixed below by reordering; nothing else from the generated diff
-- was changed.
ALTER TABLE `transfer_routes` DROP FOREIGN KEY `transfer_routes_destination_id_destinations_id_fk`;--> statement-breakpoint
ALTER TABLE `transfer_routes` DROP INDEX `transfer_routes_destination_id_unique`;--> statement-breakpoint
ALTER TABLE `bookings` DROP CONSTRAINT `bookings_product_type_shape`;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` DROP FOREIGN KEY `transfer_route_vehicle_prices_route_id_transfer_routes_id_fk`;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` MODIFY COLUMN `vehicle_type_id` int NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` MODIFY COLUMN `from_place_id` int NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` MODIFY COLUMN `to_place_id` int NOT NULL;--> statement-breakpoint
ALTER TABLE `vans` MODIFY COLUMN `vehicle_type_id` int NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` ADD PRIMARY KEY(`route_id`,`vehicle_type_id`);--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` ADD CONSTRAINT `transfer_route_vehicle_prices_route_id_transfer_routes_id_fk` FOREIGN KEY (`route_id`) REFERENCES `transfer_routes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD CONSTRAINT `transfer_routes_from_to_unique` UNIQUE(`from_place_id`,`to_place_id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_product_type_shape` CHECK (
        (`bookings`.`product_type` = 'tour' AND `bookings`.`tour_id` IS NOT NULL
          AND `bookings`.`vehicle_type_id` IS NULL AND `bookings`.`route_id` IS NULL)
        OR
        (`bookings`.`product_type` <> 'tour' AND `bookings`.`tour_id` IS NULL AND `bookings`.`vehicle_type_id` IS NOT NULL)
      );--> statement-breakpoint
ALTER TABLE `bookings` DROP COLUMN `vehicle_type_requested`;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` DROP COLUMN `vehicle_type`;--> statement-breakpoint
ALTER TABLE `transfer_routes` DROP COLUMN `destination_id`;--> statement-breakpoint
ALTER TABLE `vans` DROP COLUMN `vehicle_type`;
