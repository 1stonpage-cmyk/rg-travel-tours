CREATE TABLE `booking_addons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int NOT NULL,
	`addon_id` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`price_centavos` int NOT NULL,
	`per_person` boolean NOT NULL,
	`qty` int NOT NULL DEFAULT 1,
	CONSTRAINT `booking_addons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `booking_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int NOT NULL,
	`user_id` int NOT NULL,
	`note` text NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `booking_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ref` varchar(12) NOT NULL,
	`tour_id` int NOT NULL,
	`tour_date` date NOT NULL,
	`pax` int NOT NULL,
	`lead_name` varchar(160) NOT NULL,
	`lead_email` varchar(200) NOT NULL,
	`lead_phone` varchar(40) NOT NULL,
	`pickup` varchar(400),
	`pickup_map_url` varchar(500),
	`requests` text,
	`status` enum('pending_payment','pending_verification','confirmed','assigned','in_progress','completed','cancelled','expired') NOT NULL DEFAULT 'pending_payment',
	`pay_mode` enum('full','deposit') NOT NULL,
	`price_snapshot` json NOT NULL,
	`subtotal_centavos` int NOT NULL,
	`discount_centavos` int NOT NULL DEFAULT 0,
	`total_centavos` int NOT NULL,
	`amount_paid_centavos` int NOT NULL DEFAULT 0,
	`coupon_id` int,
	`van_id` int,
	`driver_id` int,
	`hold_expires_at` datetime,
	`started_at` datetime,
	`completed_at` datetime,
	`cancelled_at` datetime,
	`cancel_reason` varchar(400),
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookings_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `coupon_redemptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`coupon_id` int NOT NULL,
	`booking_id` int NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `coupon_redemptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupon_redemptions_unique` UNIQUE(`coupon_id`,`booking_id`)
);
--> statement-breakpoint
CREATE TABLE `review_helpful_votes` (
	`review_id` int NOT NULL,
	`voter_hash` varchar(64) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `review_helpful_votes_review_id_voter_hash_pk` PRIMARY KEY(`review_id`,`voter_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subject_type` enum('user','customer','driver') NOT NULL,
	`subject_id` int NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `trip_checkpoints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`booking_id` int NOT NULL,
	`stop_id` int,
	`checked_at` datetime NOT NULL,
	`undone` boolean NOT NULL DEFAULT false,
	CONSTRAINT `trip_checkpoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `booking_addons` ADD CONSTRAINT `booking_addons_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_addons` ADD CONSTRAINT `booking_addons_addon_id_tour_addons_id_fk` FOREIGN KEY (`addon_id`) REFERENCES `tour_addons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_notes` ADD CONSTRAINT `booking_notes_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_notes` ADD CONSTRAINT `booking_notes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_tour_id_tours_id_fk` FOREIGN KEY (`tour_id`) REFERENCES `tours`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_coupon_id_coupons_id_fk` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_van_id_vans_id_fk` FOREIGN KEY (`van_id`) REFERENCES `vans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_driver_id_drivers_id_fk` FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_coupon_id_coupons_id_fk` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `review_helpful_votes` ADD CONSTRAINT `review_helpful_votes_review_id_reviews_id_fk` FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD CONSTRAINT `trip_checkpoints_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trip_checkpoints` ADD CONSTRAINT `trip_checkpoints_stop_id_tour_itinerary_stops_id_fk` FOREIGN KEY (`stop_id`) REFERENCES `tour_itinerary_stops`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `booking_addons_booking_idx` ON `booking_addons` (`booking_id`);--> statement-breakpoint
CREATE INDEX `booking_notes_booking_idx` ON `booking_notes` (`booking_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bookings_tour_date_status_idx` ON `bookings` (`tour_id`,`tour_date`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_ref_idx` ON `bookings` (`ref`);--> statement-breakpoint
CREATE INDEX `bookings_driver_date_idx` ON `bookings` (`driver_id`,`tour_date`);--> statement-breakpoint
CREATE INDEX `bookings_hold_expiry_idx` ON `bookings` (`status`,`hold_expires_at`);--> statement-breakpoint
CREATE INDEX `coupon_redemptions_coupon_idx` ON `coupon_redemptions` (`coupon_id`);--> statement-breakpoint
CREATE INDEX `sessions_subject_idx` ON `sessions` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `trip_checkpoints_booking_idx` ON `trip_checkpoints` (`booking_id`,`checked_at`);--> statement-breakpoint
ALTER TABLE `inquiries` ADD CONSTRAINT `inquiries_package_id_packages_id_fk` FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_booking_id_bookings_id_fk` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;