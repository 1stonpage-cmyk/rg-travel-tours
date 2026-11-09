ALTER TABLE `inquiries` MODIFY COLUMN `type` enum('contact','package','transfer_custom') NOT NULL;--> statement-breakpoint
ALTER TABLE `inquiries` ADD `requested_date` date;--> statement-breakpoint
ALTER TABLE `inquiries` ADD `pax` int;--> statement-breakpoint
ALTER TABLE `inquiries` ADD `route_description` varchar(300);--> statement-breakpoint
ALTER TABLE `inquiries` ADD `converted_booking_id` int;--> statement-breakpoint
ALTER TABLE `inquiries` ADD CONSTRAINT `inquiries_converted_booking_id_bookings_id_fk` FOREIGN KEY (`converted_booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;