ALTER TABLE `trip_checkpoints` DROP INDEX `trip_checkpoints_booking_stop_unique`;--> statement-breakpoint
ALTER TABLE `bookings` ADD `payment_review_required` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD `stop_key` int GENERATED ALWAYS AS ((coalesce(`stop_id`, 0))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD CONSTRAINT `trip_checkpoints_booking_stop_unique` UNIQUE(`booking_id`,`stop_key`);--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_amount_positive` CHECK (`payments`.`amount_centavos` > 0);