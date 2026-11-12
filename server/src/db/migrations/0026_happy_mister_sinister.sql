ALTER TABLE `coupons` ADD `restricted_to_email` varchar(200);--> statement-breakpoint
ALTER TABLE `newsletter_subscribers` ADD `coupon_id` int;--> statement-breakpoint
ALTER TABLE `newsletter_subscribers` ADD CONSTRAINT `newsletter_subscribers_coupon_id_coupons_id_fk` FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON DELETE no action ON UPDATE no action;