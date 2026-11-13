-- Place types, home-page route fields, ferry fields (owner decision
-- 2026-11-13). Stage 1 of 2: pure ADDITIONS only — the new `place_type`
-- enum column alongside the `is_airport` boolean it replaces, the four
-- `transfer_routes` home-page fields, and the two `booking_transfer_details`
-- ferry fields — plus the data backfill for `place_type`. Stage 2
-- (migration 0028) drops `is_airport` once every reader has moved to
-- `place_type`. Splitting this way, exactly as migrations 0023/0024 did for
-- the flexible-routes change, means every statement in BOTH files is
-- unambiguous for `drizzle-kit generate` (no column-rename prompt on the
-- boolean-to-enum swap).
ALTER TABLE `booking_transfer_details` ADD `ferry_vessel_name` varchar(120);--> statement-breakpoint
ALTER TABLE `booking_transfer_details` ADD `ferry_arrival_time` varchar(5);--> statement-breakpoint
ALTER TABLE `transfer_places` ADD `place_type` enum('airport','pier','city','destination') DEFAULT 'destination' NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `show_on_home_page` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `home_page_badge` varchar(20);--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `home_page_order` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `home_page_short_description` varchar(120);--> statement-breakpoint
-- Backfill (owner decision 2026-11-13). A no-op on an empty `transfer_places`
-- table — mirrors 0023/0024's own "no-op on a fresh/empty table" backfills.
UPDATE `transfer_places` SET `place_type` = 'airport' WHERE `is_airport` = true;--> statement-breakpoint
-- Owner-named overrides, by the normalized `name_key` (never a literal id —
-- same discipline `upsertTransferPlace()` uses). No-op if the named row
-- does not exist on this database.
UPDATE `transfer_places` SET `place_type` = 'pier' WHERE `name_key` = 'hagnaya port';--> statement-breakpoint
UPDATE `transfer_places` SET `place_type` = 'city' WHERE `name_key` = 'cebu city';