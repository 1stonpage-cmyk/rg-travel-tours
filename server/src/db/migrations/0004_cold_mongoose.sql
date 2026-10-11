ALTER TABLE `trip_checkpoints` ADD `undone_at` datetime;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD `undone_by` int;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD CONSTRAINT `trip_checkpoints_booking_stop_unique` UNIQUE(`booking_id`,`stop_id`);--> statement-breakpoint
ALTER TABLE `coupons` ADD CONSTRAINT `coupons_percent_bp_range` CHECK (`coupons`.`percent_bp` IS NULL OR (`coupons`.`percent_bp` >= 1 AND `coupons`.`percent_bp` <= 10000));--> statement-breakpoint
ALTER TABLE `coupons` ADD CONSTRAINT `coupons_amount_positive` CHECK (`coupons`.`amount_centavos` IS NULL OR `coupons`.`amount_centavos` > 0);--> statement-breakpoint
ALTER TABLE `driver_leaves` ADD CONSTRAINT `driver_leaves_date_order` CHECK (`driver_leaves`.`end_date` >= `driver_leaves`.`start_date`);--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_tour_id_tours_id_fk` FOREIGN KEY (`tour_id`) REFERENCES `tours`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD CONSTRAINT `trip_checkpoints_undone_by_drivers_id_fk` FOREIGN KEY (`undone_by`) REFERENCES `drivers`(`id`) ON DELETE no action ON UPDATE no action;