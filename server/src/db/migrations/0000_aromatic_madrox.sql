CREATE TABLE `destinations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`slug` varchar(140) NOT NULL,
	`blurb` varchar(400),
	`image_path` varchar(300),
	`image_alt` varchar(300),
	`sort_order` int NOT NULL DEFAULT 0,
	`is_featured` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `destinations_id` PRIMARY KEY(`id`),
	CONSTRAINT `destinations_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `inquiries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('contact','package') NOT NULL,
	`package_id` int,
	`name` varchar(160) NOT NULL,
	`email` varchar(200) NOT NULL,
	`phone` varchar(40),
	`message` text NOT NULL,
	`status` enum('new','read','replied','closed') NOT NULL DEFAULT 'new',
	`created_at` datetime NOT NULL,
	CONSTRAINT `inquiries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `newsletter_subscribers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(200) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `newsletter_subscribers_id` PRIMARY KEY(`id`),
	CONSTRAINT `newsletter_subscribers_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(160) NOT NULL,
	`title` varchar(200) NOT NULL,
	`days` int NOT NULL,
	`old_price` int,
	`new_price` int NOT NULL,
	`description` text,
	`image_path` varchar(300),
	`image_alt` varchar(300),
	`highlights` json,
	`sort_order` int NOT NULL DEFAULT 0,
	`seo_title` varchar(200),
	`seo_description` varchar(400),
	`og_image` varchar(300),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `packages_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int,
	`booking_id` int,
	`name` varchar(120) NOT NULL,
	`rating` tinyint NOT NULL,
	`guide` tinyint,
	`value` tinyint,
	`punctuality` tinyint,
	`safety` tinyint,
	`body` text NOT NULL,
	`status` enum('pending','published','hidden') NOT NULL DEFAULT 'pending',
	`is_sample` boolean NOT NULL DEFAULT false,
	`reply` text,
	`replied_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `tour_addons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`price` int NOT NULL,
	`per_person` boolean NOT NULL DEFAULT true,
	`is_active` boolean NOT NULL DEFAULT true,
	CONSTRAINT `tour_addons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tour_blocked_dates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int NOT NULL,
	`date` date NOT NULL,
	`reason` varchar(300),
	CONSTRAINT `tour_blocked_dates_id` PRIMARY KEY(`id`),
	CONSTRAINT `tour_blocked_dates_tour_date_unique` UNIQUE(`tour_id`,`date`)
);
--> statement-breakpoint
CREATE TABLE `tour_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int NOT NULL,
	`path` varchar(300) NOT NULL,
	`alt` varchar(300) NOT NULL,
	`width` int,
	`height` int,
	`sort_order` int NOT NULL DEFAULT 0,
	CONSTRAINT `tour_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tour_itinerary_stops` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int NOT NULL,
	`sort_order` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	CONSTRAINT `tour_itinerary_stops_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tour_price_tiers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tour_id` int NOT NULL,
	`min_pax` int NOT NULL,
	`max_pax` int NOT NULL,
	`price_per_person` int NOT NULL,
	CONSTRAINT `tour_price_tiers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tours` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(160) NOT NULL,
	`title` varchar(200) NOT NULL,
	`destination_id` int NOT NULL,
	`summary` varchar(400),
	`about` text,
	`inclusions` json,
	`exclusions` json,
	`duration_hours` int,
	`groups_per_day` int NOT NULL DEFAULT 1,
	`max_guests` int NOT NULL DEFAULT 12,
	`free_cancel_hours` int,
	`is_featured` boolean NOT NULL DEFAULT false,
	`sort_order` int NOT NULL DEFAULT 0,
	`badge` enum('none','best_seller','new','seasonal') NOT NULL DEFAULT 'none',
	`alert_note` varchar(300),
	`historical_trips_count` int,
	`seo_title` varchar(200),
	`seo_description` varchar(400),
	`og_image` varchar(300),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `tours_id` PRIMARY KEY(`id`),
	CONSTRAINT `tours_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `tours` ADD CONSTRAINT `tours_destination_id_destinations_id_fk` FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `inquiries_status_created_idx` ON `inquiries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_status_sample_idx` ON `reviews` (`status`,`is_sample`);--> statement-breakpoint
CREATE INDEX `reviews_tour_idx` ON `reviews` (`tour_id`,`status`);--> statement-breakpoint
CREATE INDEX `tour_addons_tour_idx` ON `tour_addons` (`tour_id`);--> statement-breakpoint
CREATE INDEX `tour_images_tour_sort_idx` ON `tour_images` (`tour_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `tour_itinerary_stops_tour_sort_idx` ON `tour_itinerary_stops` (`tour_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `tour_price_tiers_tour_min_idx` ON `tour_price_tiers` (`tour_id`,`min_pax`);--> statement-breakpoint
CREATE INDEX `tours_active_featured_idx` ON `tours` (`is_active`,`is_featured`,`sort_order`);--> statement-breakpoint
CREATE INDEX `tours_destination_idx` ON `tours` (`destination_id`);