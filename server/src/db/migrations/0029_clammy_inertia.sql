ALTER TABLE `packages` ADD `pricing_mode` enum('per_person','per_group') DEFAULT 'per_group' NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `pricing_mode` enum('per_vehicle','per_person') DEFAULT 'per_vehicle' NOT NULL;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD `min_paying_pax` int DEFAULT 1 NOT NULL;