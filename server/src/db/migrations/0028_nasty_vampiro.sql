-- Stage 2 of 2 — see migration 0027's header. Drops `is_airport` now that every reader has moved to `place_type`.
ALTER TABLE `transfer_places` DROP COLUMN `is_airport`;