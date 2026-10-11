CREATE TABLE `audit_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actor_type` enum('user','customer','driver','system','provider') NOT NULL,
	`actor_id` int,
	`action` varchar(80) NOT NULL,
	`entity` varchar(40) NOT NULL,
	`entity_id` int NOT NULL,
	`data` json,
	`created_at` datetime NOT NULL,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`discount_type` enum('percent','fixed') NOT NULL,
	`percent_bp` int,
	`amount_centavos` int,
	`min_spend_centavos` int,
	`starts_at` datetime,
	`ends_at` datetime,
	`usage_limit` int,
	`used_count` int NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupons_code_unique` UNIQUE(`code`),
	CONSTRAINT `coupons_discount_shape` CHECK((`coupons`.`discount_type` = 'percent' AND `coupons`.`percent_bp` IS NOT NULL AND `coupons`.`amount_centavos` IS NULL)
       OR (`coupons`.`discount_type` = 'fixed'   AND `coupons`.`amount_centavos` IS NOT NULL AND `coupons`.`percent_bp` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `driver_leaves` (
	`id` int AUTO_INCREMENT NOT NULL,
	`driver_id` int NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`reason` varchar(300),
	`created_at` datetime NOT NULL,
	CONSTRAINT `driver_leaves_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `drivers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`code` varchar(20) NOT NULL,
	`phone` varchar(40) NOT NULL,
	`pin_hash` varchar(255) NOT NULL,
	`failed_attempts` int NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`lockout_count` int NOT NULL DEFAULT 0,
	`lockout_window_started_at` datetime,
	`requires_admin_unlock` boolean NOT NULL DEFAULT false,
	`license_no` varchar(80),
	`license_expiry` date,
	`languages` json,
	`emergency_contact` varchar(200),
	`status` enum('available','on_trip','off_duty') NOT NULL DEFAULT 'available',
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `drivers_id` PRIMARY KEY(`id`),
	CONSTRAINT `drivers_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `fleet_date_slots` (
	`date` date NOT NULL,
	CONSTRAINT `fleet_date_slots_date` PRIMARY KEY(`date`)
);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider` enum('paymongo','xendit','manual') NOT NULL,
	`provider_event_id` varchar(191) NOT NULL,
	`type` varchar(80) NOT NULL,
	`payload` json,
	`received_at` datetime NOT NULL,
	`processed_at` datetime,
	CONSTRAINT `payment_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_events_provider_event_unique` UNIQUE(`provider`,`provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `tour_date_slots` (
	`tour_id` int NOT NULL,
	`date` date NOT NULL,
	CONSTRAINT `tour_date_slots_tour_id_date_pk` PRIMARY KEY(`tour_id`,`date`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`email` varchar(200) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('owner','dispatcher','finance') NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`last_login_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `vans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`plate` varchar(20) NOT NULL,
	`model` varchar(120) NOT NULL,
	`capacity` int NOT NULL,
	`status` enum('available','on_trip','for_repair') NOT NULL DEFAULT 'available',
	`odometer` int,
	`last_service` date,
	`next_service` date,
	`orcr_expiry` date,
	`franchise_no` varchar(80),
	`franchise_expiry` date,
	`repair_notes` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `vans_id` PRIMARY KEY(`id`),
	CONSTRAINT `vans_plate_unique` UNIQUE(`plate`)
);
--> statement-breakpoint
ALTER TABLE `driver_leaves` ADD CONSTRAINT `driver_leaves_driver_id_drivers_id_fk` FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tour_date_slots` ADD CONSTRAINT `tour_date_slots_tour_id_tours_id_fk` FOREIGN KEY (`tour_id`) REFERENCES `tours`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `coupons_active_window_idx` ON `coupons` (`is_active`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `driver_leaves_driver_range_idx` ON `driver_leaves` (`driver_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `drivers_active_status_idx` ON `drivers` (`is_active`,`status`);--> statement-breakpoint
CREATE INDEX `payment_events_unprocessed_idx` ON `payment_events` (`processed_at`);--> statement-breakpoint
CREATE INDEX `users_role_active_idx` ON `users` (`role`,`is_active`);--> statement-breakpoint
CREATE INDEX `vans_active_status_idx` ON `vans` (`is_active`,`status`,`capacity`);