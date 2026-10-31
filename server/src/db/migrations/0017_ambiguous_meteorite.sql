CREATE TABLE `booking_transfer_details` (
	`booking_id` int NOT NULL,
	`pickup_time` varchar(5) NOT NULL,
	`day_use_end_time` varchar(5),
	`dropoff_address` varchar(400) NOT NULL,
	`dropoff_map_url` varchar(500),
	`luggage_count` int NOT NULL DEFAULT 0,
	`flight_number` varchar(20),
	`airline` varchar(80),
	`custom_route_description` varchar(300),
	`buffer_minutes_used` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `booking_transfer_details_booking_id` PRIMARY KEY(`booking_id`)
);
--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `tour_id` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `product_type` enum('tour','transfer_one_way','transfer_day_use') DEFAULT 'tour' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `route_id` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `vehicle_type_requested` enum('van','suv');--> statement-breakpoint
ALTER TABLE `booking_transfer_details` ADD CONSTRAINT `booking_transfer_details_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_product_type_shape` CHECK (
        (`bookings`.`product_type` = 'tour' AND `bookings`.`tour_id` IS NOT NULL AND `bookings`.`vehicle_type_requested` IS NULL)
        OR
        (`bookings`.`product_type` <> 'tour' AND `bookings`.`tour_id` IS NULL AND `bookings`.`vehicle_type_requested` IS NOT NULL)
      );--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_route_id_transfer_routes_id_fk` FOREIGN KEY (`route_id`) REFERENCES `transfer_routes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `bookings_product_type_date_idx` ON `bookings` (`product_type`,`tour_date`,`status`);