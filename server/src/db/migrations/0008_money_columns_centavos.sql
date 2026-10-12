ALTER TABLE `packages` RENAME COLUMN `old_price` TO `old_price_centavos`;--> statement-breakpoint
ALTER TABLE `packages` RENAME COLUMN `new_price` TO `new_price_centavos`;--> statement-breakpoint
ALTER TABLE `tour_addons` RENAME COLUMN `price` TO `price_centavos`;--> statement-breakpoint
ALTER TABLE `tour_price_tiers` RENAME COLUMN `price_per_person` TO `price_per_person_centavos`;