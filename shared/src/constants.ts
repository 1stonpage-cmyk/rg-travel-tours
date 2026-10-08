/**
 * Project-wide constants shared by client and server.
 *
 * Money is handled in integer CENTAVOS everywhere (DB, API, logic) and
 * formatted only at display time. Timestamps are stored in UTC; business
 * dates are computed and displayed in Asia/Manila.
 */

/** Deposit percentage offered at checkout. Overridable from `settings` later. */
export const DEPOSIT_PERCENT = 30;

/** Minutes a booking hold survives before the expiry cron releases capacity. */
export const HOLD_MINUTES = 15;

/** Business timezone for all date display and business-day calculations. */
export const TIMEZONE = 'Asia/Manila';

/** ISO currency code. Amounts are centavos of this currency. */
export const CURRENCY = 'PHP';

/** Prefix for public, non-sequential booking references, e.g. RG-7KQ4M9. */
export const BOOKING_REF_PREFIX = 'RG';
