CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int NOT NULL,
	`type` enum('payment','refund') NOT NULL,
	`provider` enum('paymongo','xendit','manual') NOT NULL,
	`method` enum('card','gcash','maya','grab_pay','qrph','bank_transfer','cash') NOT NULL,
	`amount_centavos` int NOT NULL,
	`status` enum('pending','paid','rejected','failed','refunded') NOT NULL DEFAULT 'pending',
	`provider_ref` varchar(191),
	`provider_status` varchar(80),
	`txn_ref` varchar(191),
	`receipt_path` varchar(300),
	`reject_reason` varchar(400),
	`verified_by` int,
	`verified_at` datetime,
	`collected_by_driver_id` int,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_collected_by_driver_id_drivers_id_fk` FOREIGN KEY (`collected_by_driver_id`) REFERENCES `drivers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `payments_booking_idx` ON `payments` (`booking_id`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`);--> statement-breakpoint
CREATE INDEX `payments_provider_ref_idx` ON `payments` (`provider`,`provider_ref`);