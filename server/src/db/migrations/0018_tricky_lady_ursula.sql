ALTER TABLE `bookings` DROP CONSTRAINT `bookings_product_type_shape`;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_product_type_shape` CHECK (
        (`bookings`.`product_type` = 'tour' AND `bookings`.`tour_id` IS NOT NULL
          AND `bookings`.`vehicle_type_requested` IS NULL AND `bookings`.`route_id` IS NULL)
        OR
        (`bookings`.`product_type` <> 'tour' AND `bookings`.`tour_id` IS NULL AND `bookings`.`vehicle_type_requested` IS NOT NULL)
      );