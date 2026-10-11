ALTER TABLE `bookings` ADD CONSTRAINT `bookings_subtotal_non_negative` CHECK (`bookings`.`subtotal_centavos` >= 0);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_discount_non_negative` CHECK (`bookings`.`discount_centavos` >= 0);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_total_non_negative` CHECK (`bookings`.`total_centavos` >= 0);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_amount_paid_non_negative` CHECK (`bookings`.`amount_paid_centavos` >= 0);