CREATE TABLE `transfer_route_vehicle_prices` (
	`route_id` int NOT NULL,
	`vehicle_type` enum('van','suv') NOT NULL,
	`one_way_price_centavos` int NOT NULL,
	`day_use_price_centavos` int NOT NULL,
	CONSTRAINT `transfer_route_vehicle_prices_route_id_vehicle_type_pk` PRIMARY KEY(`route_id`,`vehicle_type`)
);
--> statement-breakpoint
CREATE TABLE `transfer_routes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`destination_id` int NOT NULL,
	`slug` varchar(80) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`sort_order` int NOT NULL DEFAULT 0,
	`estimated_duration_minutes` int NOT NULL,
	`free_cancel_hours` int NOT NULL DEFAULT 24,
	`inclusions_text` text,
	`exclusions_text` text,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `transfer_routes_id` PRIMARY KEY(`id`),
	CONSTRAINT `transfer_routes_destination_id_unique` UNIQUE(`destination_id`),
	CONSTRAINT `transfer_routes_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `transfer_route_vehicle_prices` ADD CONSTRAINT `transfer_route_vehicle_prices_route_id_transfer_routes_id_fk` FOREIGN KEY (`route_id`) REFERENCES `transfer_routes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transfer_routes` ADD CONSTRAINT `transfer_routes_destination_id_destinations_id_fk` FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `transfer_routes_active_idx` ON `transfer_routes` (`is_active`,`sort_order`);