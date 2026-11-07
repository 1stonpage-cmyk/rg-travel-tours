-- Flexible transfer places/routes/vehicle types (owner decision 2026-11-08).
-- Stage 1 of 2: pure ADDITIONS only (new tables, new nullable columns
-- alongside the old ones they replace), plus the data backfill for those
-- new columns. Stage 2 (migration 0024) drops the old columns, enforces
-- NOT NULL, and swaps the affected constraints (PK on
-- transfer_route_vehicle_prices, UNIQUE on transfer_routes, the CHECK on
-- bookings). Splitting this way means every statement in BOTH files is
-- unambiguous for `drizzle-kit generate` (no column-rename prompts) and
-- every data backfill runs strictly between the column existing (stage 1)
-- and the old column disappearing (stage 2) — see
-- docs/superpowers/plans/2026-11-08-flexible-routes.md §0.
--
-- Every backfill below is a no-op on a fresh/empty table (confirmed: no
-- `transfer_routes` rows exist in either rg_travel or rg_travel_test as of
-- this migration — HANDOVER-4). It only does real work on a dev box that
-- already created routes locally.
CREATE TABLE `transfer_places` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`name_key` varchar(160) NOT NULL,
	`is_airport` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`destination_id` int,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `transfer_places_id` PRIMARY KEY(`id`),
	CONSTRAINT `transfer_places_name_key_unique` UNIQUE(`name_key`)
);
--> statement-breakpoint
CREATE TABLE `vehicle_types` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(80) NOT NULL,
	`slug` varchar(40) NOT NULL,
	`default_seats` int,
	`default_luggage` int,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `vehicle_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `vehicle_types_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `booking_transfer_details` ADD `direction` enum('forward','reverse') DEFAULT 'forward' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `vehicle_type_id` int;--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` ADD `vehicle_type_id` int;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `from_place_id` int;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `to_place_id` int;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `reverse_enabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `vans` ADD `vehicle_type_id` int;--> statement-breakpoint
ALTER TABLE `transfer_places` ADD CONSTRAINT `transfer_places_destination_id_destinations_id_fk` FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `transfer_places_active_idx` ON `transfer_places` (`is_active`,`sort_order`);--> statement-breakpoint
CREATE INDEX `vehicle_types_active_idx` ON `vehicle_types` (`is_active`,`sort_order`);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_vehicle_type_id_vehicle_types_id_fk` FOREIGN KEY (`vehicle_type_id`) REFERENCES `vehicle_types`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Drizzle's auto-generated name for this FK
-- (`transfer_route_vehicle_prices_vehicle_type_id_vehicle_types_id_fk`) is 67
-- characters — over MySQL's 64-character identifier limit, confirmed by
-- measurement ("Identifier name ... is too long"). Shortened by hand; no
-- other file references this name.
ALTER TABLE `transfer_route_vehicle_prices` ADD CONSTRAINT `trvp_vehicle_type_id_fk` FOREIGN KEY (`vehicle_type_id`) REFERENCES `vehicle_types`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD CONSTRAINT `transfer_routes_from_place_id_transfer_places_id_fk` FOREIGN KEY (`from_place_id`) REFERENCES `transfer_places`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD CONSTRAINT `transfer_routes_to_place_id_transfer_places_id_fk` FOREIGN KEY (`to_place_id`) REFERENCES `transfer_places`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vans` ADD CONSTRAINT `vans_vehicle_type_id_vehicle_types_id_fk` FOREIGN KEY (`vehicle_type_id`) REFERENCES `vehicle_types`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Data backfill begins here. Everything above is structure; everything
-- below is content, run in dependency order.

-- vehicle_types: the two existing types, inserted in this order so 'van'
-- deterministically gets the lower id on a fresh table (both rg_travel and
-- rg_travel_test create this table for the first time right here — no
-- insert-order correctness dependency, just a readability nicety for "van
-- reads as the first type in an admin list"). `created_at`/`updated_at` are
-- NOT NULL with no SQL-level DEFAULT (Drizzle fills them via `$defaultFn` in
-- application code, never a database DEFAULT clause) — a raw-SQL INSERT
-- outside Drizzle's query builder must supply them explicitly, or MySQL
-- refuses the row with "doesn't have a default value" (confirmed by
-- measurement against the real local database before this file was
-- finalized).
INSERT INTO `vehicle_types` (`name`, `slug`, `is_active`, `sort_order`, `created_at`, `updated_at`)
VALUES ('Van', 'van', true, 0, NOW(), NOW());
--> statement-breakpoint
INSERT INTO `vehicle_types` (`name`, `slug`, `is_active`, `sort_order`, `created_at`, `updated_at`)
VALUES ('SUV', 'suv', true, 1, NOW(), NOW());
--> statement-breakpoint

-- transfer_places: the airport, only if at least one transfer_routes row
-- exists today (creates nothing on a fresh/empty table).
INSERT INTO `transfer_places` (`name`, `name_key`, `is_airport`, `is_active`, `sort_order`, `created_at`, `updated_at`)
SELECT 'Mactan-Cebu International Airport', 'mactan-cebu international airport', true, true, 0, NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM `transfer_routes`);
--> statement-breakpoint

-- transfer_places: one place per destination any existing route points at.
-- INSERT IGNORE, not a plain INSERT: two destinations differing only in
-- case/whitespace (or one colliding with the airport row above) would
-- otherwise abort the whole migration on the name_key UNIQUE — acceptable
-- at this one-off backfill, where a collision means two destinations would
-- have resolved to "the same place" anyway. The SERVICE
-- (`upsertTransferPlace()`) is the normalizer for every write after this
-- migration; this LOWER(TRIM(...)) is a one-off.
INSERT IGNORE INTO `transfer_places` (`name`, `name_key`, `is_airport`, `is_active`, `sort_order`, `destination_id`, `created_at`, `updated_at`)
SELECT d.`name`, LOWER(TRIM(d.`name`)), false, d.`is_active`, d.`sort_order`, d.`id`, NOW(), NOW()
FROM `destinations` d
WHERE d.`id` IN (SELECT DISTINCT `destination_id` FROM `transfer_routes`);
--> statement-breakpoint

-- transfer_routes: every existing route becomes airport -> its destination's
-- place, reverse enabled (matching how the 2026-10-31 plan already modeled
-- "either direction" as one row). No-op when transfer_routes is empty.
UPDATE `transfer_routes` r
JOIN `transfer_places` airport ON airport.`name_key` = 'mactan-cebu international airport'
JOIN `destinations` d ON d.`id` = r.`destination_id`
JOIN `transfer_places` dest ON dest.`name_key` = LOWER(TRIM(d.`name`))
SET r.`from_place_id` = airport.`id`, r.`to_place_id` = dest.`id`;
--> statement-breakpoint

-- transfer_route_vehicle_prices, vans, bookings: resolve the new FK by the
-- old enum's value as a natural-key lookup on vehicle_types.slug — never a
-- literal id.
UPDATE `transfer_route_vehicle_prices` p
JOIN `vehicle_types` vt ON vt.`slug` = p.`vehicle_type`
SET p.`vehicle_type_id` = vt.`id`;
--> statement-breakpoint
UPDATE `vans` v
JOIN `vehicle_types` vt ON vt.`slug` = v.`vehicle_type`
SET v.`vehicle_type_id` = vt.`id`;
--> statement-breakpoint
UPDATE `bookings` b
JOIN `vehicle_types` vt ON vt.`slug` = b.`vehicle_type_requested`
SET b.`vehicle_type_id` = vt.`id`
WHERE b.`vehicle_type_requested` IS NOT NULL;
