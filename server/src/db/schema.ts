/**
 * Public content tables for the TravelSugbo website (phase 1 of the dynamic
 * site + SEO plan). Transcribed verbatim from the "Database schema" section
 * of docs/superpowers/plans/2026-10-09-dynamic-site-and-seo.md.
 *
 * Since the core-schema plan (docs/superpowers/plans/2026-10-10-core-schema.md)
 * this file also holds the transactional core, added one table per task.
 * Still out of scope: bookings, payments, sessions.
 *
 * Conventions:
 * - Money is integer centavos (`int`), never DECIMAL/float.
 * - created_at/updated_at are produced in JS (UTC), not MySQL's SYSTEM
 *   timezone: `$defaultFn` on insert, `$onUpdateFn` on update for updated_at.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { ADMIN_ROLES, DISCOUNT_TYPES } from '@rg/shared';

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: json('value').notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
});

export const destinations = mysqlTable('destinations', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 140 }).notNull().unique(),
  /**
   * Overrides `name` for the Most Visited section only (e.g. "Kawasan Falls"
   * for the "Badian / Kawasan" destination chip). Null means "use `name`".
   */
  displayName: varchar('display_name', { length: 120 }),
  blurb: varchar('blurb', { length: 400 }),
  imagePath: varchar('image_path', { length: 300 }),
  imageAlt: varchar('image_alt', { length: 300 }),
  sortOrder: int('sort_order').notNull().default(0),
  /**
   * Independent ordering for the Most Visited section — `sortOrder` drives
   * the destination chip row, which renders in a different order. Null
   * destinations are omitted from Most Visited.
   */
  featuredSortOrder: int('featured_sort_order'),
  isFeatured: boolean('is_featured').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: datetime('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: datetime('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
});

export const tours = mysqlTable(
  'tours',
  {
    id: int('id').autoincrement().primaryKey(),
    slug: varchar('slug', { length: 160 }).notNull().unique(),
    title: varchar('title', { length: 200 }).notNull(),
    destinationId: int('destination_id')
      .notNull()
      .references(() => destinations.id),
    summary: varchar('summary', { length: 400 }),
    about: text('about'),
    inclusions: json('inclusions'),
    exclusions: json('exclusions'),
    durationHours: int('duration_hours'),
    groupsPerDay: int('groups_per_day').notNull().default(1),
    maxGuests: int('max_guests').notNull().default(12),
    freeCancelHours: int('free_cancel_hours'),
    isFeatured: boolean('is_featured').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),
    badge: mysqlEnum('badge', ['none', 'best_seller', 'new', 'seasonal']).notNull().default('none'),
    alertNote: varchar('alert_note', { length: 300 }),
    historicalTripsCount: int('historical_trips_count'),
    seoTitle: varchar('seo_title', { length: 200 }),
    seoDescription: varchar('seo_description', { length: 400 }),
    ogImage: varchar('og_image', { length: 300 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('tours_active_featured_idx').on(t.isActive, t.isFeatured, t.sortOrder),
    index('tours_destination_idx').on(t.destinationId),
  ],
);

export const tourImages = mysqlTable(
  'tour_images',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id').notNull(),
    path: varchar('path', { length: 300 }).notNull(),
    alt: varchar('alt', { length: 300 }).notNull(),
    width: int('width'),
    height: int('height'),
    sortOrder: int('sort_order').notNull().default(0),
  },
  (t) => [index('tour_images_tour_sort_idx').on(t.tourId, t.sortOrder)],
);

export const tourPriceTiers = mysqlTable(
  'tour_price_tiers',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id').notNull(),
    minPax: int('min_pax').notNull(),
    maxPax: int('max_pax').notNull(),
    pricePerPerson: int('price_per_person').notNull(),
  },
  (t) => [index('tour_price_tiers_tour_min_idx').on(t.tourId, t.minPax)],
);

export const tourItineraryStops = mysqlTable(
  'tour_itinerary_stops',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id').notNull(),
    sortOrder: int('sort_order').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
  },
  (t) => [index('tour_itinerary_stops_tour_sort_idx').on(t.tourId, t.sortOrder)],
);

export const tourAddons = mysqlTable(
  'tour_addons',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    price: int('price').notNull(),
    perPerson: boolean('per_person').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('tour_addons_tour_idx').on(t.tourId)],
);

export const tourBlockedDates = mysqlTable(
  'tour_blocked_dates',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id').notNull(),
    date: date('date', { mode: 'date' }).notNull(),
    reason: varchar('reason', { length: 300 }),
  },
  (t) => [uniqueIndex('tour_blocked_dates_tour_date_unique').on(t.tourId, t.date)],
);

export const packages = mysqlTable('packages', {
  id: int('id').autoincrement().primaryKey(),
  slug: varchar('slug', { length: 160 }).notNull().unique(),
  title: varchar('title', { length: 200 }).notNull(),
  days: int('days').notNull(),
  oldPrice: int('old_price'),
  newPrice: int('new_price').notNull(),
  description: text('description'),
  imagePath: varchar('image_path', { length: 300 }),
  imageAlt: varchar('image_alt', { length: 300 }),
  highlights: json('highlights'),
  sortOrder: int('sort_order').notNull().default(0),
  seoTitle: varchar('seo_title', { length: 200 }),
  seoDescription: varchar('seo_description', { length: 400 }),
  ogImage: varchar('og_image', { length: 300 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: datetime('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: datetime('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
});

export const reviews = mysqlTable(
  'reviews',
  {
    id: int('id').autoincrement().primaryKey(),
    tourId: int('tour_id'),
    bookingId: int('booking_id'),
    name: varchar('name', { length: 120 }).notNull(),
    rating: tinyint('rating').notNull(),
    guide: tinyint('guide'),
    value: tinyint('value'),
    punctuality: tinyint('punctuality'),
    safety: tinyint('safety'),
    body: text('body').notNull(),
    status: mysqlEnum('status', ['pending', 'published', 'hidden']).notNull().default('pending'),
    isSample: boolean('is_sample').notNull().default(false),
    reply: text('reply'),
    repliedAt: datetime('replied_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('reviews_status_sample_idx').on(t.status, t.isSample),
    index('reviews_tour_idx').on(t.tourId, t.status),
  ],
);

export const inquiries = mysqlTable(
  'inquiries',
  {
    id: int('id').autoincrement().primaryKey(),
    type: mysqlEnum('type', ['contact', 'package']).notNull(),
    packageId: int('package_id'),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 200 }).notNull(),
    phone: varchar('phone', { length: 40 }),
    message: text('message').notNull(),
    status: mysqlEnum('status', ['new', 'read', 'replied', 'closed']).notNull().default('new'),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('inquiries_status_created_idx').on(t.status, t.createdAt)],
);

export const newsletterSubscribers = mysqlTable('newsletter_subscribers', {
  id: int('id').autoincrement().primaryKey(),
  email: varchar('email', { length: 200 }).notNull().unique(),
  createdAt: datetime('created_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Admin accounts. `role` drives every admin gate (BUILD_SPEC §9), and the
 * enum comes from `@rg/shared` so the database, the server middleware and
 * the client all read the same three values.
 *
 * Soft-deleted through `is_active`: an account that signed off a payment or
 * a refund still has to be nameable in the audit log, so a row is never
 * removed.
 */
export const users = mysqlTable(
  'users',
  {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 200 }).notNull().unique(),
    /**
     * argon2id or bcrypt output — 255 fits an argon2id encoded hash with room
     * to spare, and bcrypt's 60 fits trivially. The password itself is never
     * stored, never logged and never put in an audit row.
     */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: mysqlEnum('role', ADMIN_ROLES).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: datetime('last_login_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('users_role_active_idx').on(t.role, t.isActive)],
);

/**
 * Who did the thing (owner decision 2026-10-11, Q10).
 *
 *   user      an admin, `actor_id` -> users.id
 *   customer  a guest in the portal, `actor_id` -> bookings.id
 *   driver    `actor_id` -> drivers.id
 *   system    a cron job - hold expiry, reminders. No actor_id.
 *   provider  a payment gateway webhook. No actor_id; the provider NAME
 *             goes in `data.provider`, because a gateway is not a row in
 *             any table and inventing one would be worse.
 *
 * `system` and `provider` are separate on purpose: "the cron expired this
 * hold" and "PayMongo confirmed this payment" are different events, and
 * collapsing both into `system` makes a money trail unreadable.
 */
export const AUDIT_ACTOR_TYPES = ['user', 'customer', 'driver', 'system', 'provider'] as const;

/**
 * Every payment, refund, status change and assignment writes a row here
 * (CLAUDE.md Conventions), and only ever through `writeAudit()` in
 * `services/audit.ts` — which takes a transaction handle, so the row lives
 * and dies with the change it describes.
 *
 * Append-only by intent: nothing in this codebase updates or deletes an
 * audit row.
 */
export const auditLog = mysqlTable(
  'audit_log',
  {
    id: int('id').autoincrement().primaryKey(),
    /** Which table `actor_id` points at. No FK — see "Polymorphic columns" in the plan. */
    actorType: mysqlEnum('actor_type', AUDIT_ACTOR_TYPES).notNull(),
    /** Null for `system` and `provider` (cron, or a webhook with no human behind it). */
    actorId: int('actor_id'),
    /** Dotted verb: `payment.verified`, `booking.cancelled`, `driver.assigned`. */
    action: varchar('action', { length: 80 }).notNull(),
    entity: varchar('entity', { length: 40 }).notNull(),
    entityId: int('entity_id').notNull(),
    data: json('data'),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    index('audit_log_actor_idx').on(t.actorType, t.actorId),
    index('audit_log_created_idx').on(t.createdAt),
  ],
);

export const VAN_STATUSES = ['available', 'on_trip', 'for_repair'] as const;

/**
 * The fleet (BUILD_SPEC §9 "Vans"). `capacity` feeds the §5 capacity check,
 * which is why the index below leads with the two equality filters and ends
 * on `capacity` — see the index comment.
 *
 * Soft-deleted through `is_active`: a van that carried a completed booking
 * still has to be nameable on that booking and in the audit log, so a row is
 * retired rather than removed.
 *
 * `status` and `is_active` are different questions. `for_repair` is a van
 * that is temporarily out of service and will come back; `is_active = false`
 * is a van that has left the fleet.
 */
export const vans = mysqlTable(
  'vans',
  {
    id: int('id').autoincrement().primaryKey(),
    plate: varchar('plate', { length: 20 }).notNull().unique(),
    model: varchar('model', { length: 120 }).notNull(),
    /** Seats available to GUESTS, not including the driver. Feeds the §5 capacity check. */
    capacity: int('capacity').notNull(),
    status: mysqlEnum('status', VAN_STATUSES).notNull().default('available'),
    odometer: int('odometer'),
    /** Civil dates in Asia/Manila — a van's papers expire on a day, not at an instant. */
    lastService: date('last_service'),
    nextService: date('next_service'),
    orcrExpiry: date('orcr_expiry'),
    franchiseNo: varchar('franchise_no', { length: 80 }),
    franchiseExpiry: date('franchise_expiry'),
    repairNotes: text('repair_notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    /**
     * Column order is deliberate and must not be rearranged. The §5 capacity
     * query filters on `is_active` and `status` by equality and only then
     * needs `capacity >= pax` as a range. A composite index serves a range
     * only in its last position, so moving `capacity` earlier would stop
     * MySQL using the index for the equality filters at all.
     */
    index('vans_active_status_idx').on(t.isActive, t.status, t.capacity),
  ],
);

export const DRIVER_STATUSES = ['available', 'on_trip', 'off_duty'] as const;

/**
 * Drivers (BUILD_SPEC §9 "Drivers", §8 driver portal). A driver signs in to
 * the portal with a short `code` and a SIX-digit PIN (owner decision
 * 2026-10-11, Q9).
 *
 * A six-digit secret is a million guesses, so the five lockout columns below
 * are the control that actually protects the portal, not the PIN's own
 * entropy. They are all defined here, in Wave 1, precisely so that Task 21
 * implements one policy against one fixed shape rather than adding counters
 * as it discovers it needs them.
 *
 * Soft-deleted through `is_active`: a driver who drove a completed trip still
 * has to be nameable on that booking, its checkpoints and the audit log.
 */
export const drivers = mysqlTable(
  'drivers',
  {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    /** Short login code the driver types on the portal, e.g. "D07". */
    code: varchar('code', { length: 20 }).notNull().unique(),
    phone: varchar('phone', { length: 40 }).notNull(),
    /**
     * argon2id/bcrypt of the six-digit PIN. 255 fits an argon2id encoded
     * hash with room to spare. The PIN itself is never stored, never logged
     * and never put in an audit row — and no column here could hold one.
     */
    pinHash: varchar('pin_hash', { length: 255 }).notNull(),
    /** Resets to 0 on a successful login, and when a lockout expires. */
    failedAttempts: int('failed_attempts').notNull().default(0),
    /** now + 15 minutes, set on the 5th consecutive failure. Null = not locked. */
    lockedUntil: datetime('locked_until', { mode: 'date' }),
    /** Lockouts inside the current 24h window. At 3, an admin must unlock. */
    lockoutCount: int('lockout_count').notNull().default(0),
    /** When the current 24h lockout window opened; null when there is none. */
    lockoutWindowStartedAt: datetime('lockout_window_started_at', { mode: 'date' }),
    /**
     * True after the 3rd lockout in 24h. Only an admin clears it — never a
     * timer, which is why there is deliberately no expiry column beside it.
     * NOT NULL so there is no third, unknown state a check could read as
     * "probably fine".
     */
    requiresAdminUnlock: boolean('requires_admin_unlock').notNull().default(false),
    licenseNo: varchar('license_no', { length: 80 }),
    /** Civil date in Asia/Manila — a licence expires on a day, not at an instant. */
    licenseExpiry: date('license_expiry'),
    languages: json('languages'),
    emergencyContact: varchar('emergency_contact', { length: 200 }),
    status: mysqlEnum('status', DRIVER_STATUSES).notNull().default('available'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('drivers_active_status_idx').on(t.isActive, t.status)],
);

/**
 * A date range in which a driver is unavailable for dispatch.
 *
 * `start_date` and `end_date` are civil dates in Asia/Manila and INCLUSIVE
 * at both ends — "off from the 24th to the 26th" covers all three days. They
 * are `date`, not `datetime`, deliberately: a leave that ended at 00:00 on
 * its last day is a driver dispatched on a day they are not working.
 */
export const driverLeaves = mysqlTable(
  'driver_leaves',
  {
    id: int('id').autoincrement().primaryKey(),
    driverId: int('driver_id')
      .notNull()
      .references(() => drivers.id),
    /** Civil dates in Asia/Manila, inclusive both ends. */
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    reason: varchar('reason', { length: 300 }),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('driver_leaves_driver_range_idx').on(t.driverId, t.startDate, t.endDate)],
);

/**
 * Discount coupons (BUILD_SPEC §9 "Coupons").
 *
 * **The discount is three columns, not one (owner decision 2026-10-11, Q6).**
 * The spec's single `value` column — one `int` meaning percent points or
 * centavos depending on a sibling column — is replaced by `discount_type`
 * plus a nullable `percent_bp` and a nullable `amount_centavos`, with a
 * database CHECK that exactly one of the two is set and that it matches
 * `discount_type`.
 *
 * `percent_bp` is BASIS POINTS: 1000 = 10%, 250 = 2.5%, 10000 = 100%. Whole
 * percent, not basis points, is what forces a schema change the first time
 * marketing asks for 2.5% off — and a `decimal` or a float is forbidden
 * anywhere near money (CLAUDE.md).
 */
export const coupons = mysqlTable(
  'coupons',
  {
    id: int('id').autoincrement().primaryKey(),
    code: varchar('code', { length: 40 }).notNull().unique(),

    discountType: mysqlEnum('discount_type', DISCOUNT_TYPES).notNull(),
    /** Basis points: 1000 = 10%, 250 = 2.5%. Set iff discount_type='percent'. */
    percentBp: int('percent_bp'),
    /** Flat discount in centavos. Set iff discount_type='fixed'. */
    amountCentavos: int('amount_centavos'),

    /** Null means no minimum. Centavos, like every money column here. */
    minSpendCentavos: int('min_spend_centavos'),
    /** UTC instants; the admin UI converts to and from Asia/Manila. */
    startsAt: datetime('starts_at', { mode: 'date' }),
    endsAt: datetime('ends_at', { mode: 'date' }),
    /** Null means unlimited. Enforced against used_count / coupon_redemptions. */
    usageLimit: int('usage_limit'),
    usedCount: int('used_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('coupons_active_window_idx').on(t.isActive, t.startsAt, t.endsAt),
    /**
     * Exactly one discount column is set, and it matches discount_type.
     *
     * In the database, not only in Zod: a seed script, a migration or a
     * hand-written UPDATE all bypass application validation, and a coupon
     * row with neither column set would make every discount silently zero
     * while looking perfectly valid in the admin list.
     *
     * Enforced for real here — this server is MySQL 8.0.46 and CHECK has
     * been enforced since 8.0.16. On 8.0.15 and earlier MySQL parses a CHECK
     * and silently ignores it, which is why `schema-coupons.test.ts` asserts
     * the constraint exists in `information_schema.check_constraints` and
     * that four malformed rows are actually refused, rather than trusting
     * that writing it down was enough.
     */
    check(
      'coupons_discount_shape',
      sql`(${t.discountType} = 'percent' AND ${t.percentBp} IS NOT NULL AND ${t.amountCentavos} IS NULL)
       OR (${t.discountType} = 'fixed'   AND ${t.amountCentavos} IS NOT NULL AND ${t.percentBp} IS NULL)`,
    ),
  ],
);

/**
 * The PER-TOUR lock row (BUILD_SPEC §5 "Concurrency"). One row per
 * tour-day, and nothing but the key: it is a mutex, not data.
 *
 * §5: "run the check and the booking insert in one DB transaction with a row
 * lock on a `tour_date_slots` row (`SELECT … FOR UPDATE`)". It serialises the
 * `groups_per_day` check for ONE tour on ONE date, so two guests cannot both
 * read "one group slot left" and both take it.
 *
 * The row is created on demand (owner decision 2026-10-11, Q8) with
 * `INSERT … ON DUPLICATE KEY UPDATE tour_id = tour_id` — a no-op touch that
 * is safe when two requests race to create the same row — and then selected
 * `FOR UPDATE`.
 *
 * ALWAYS locked AFTER `fleetDateSlots`. See the lock-order note on that
 * table: this one alone cannot enforce a fleet-wide limit.
 */
export const tourDateSlots = mysqlTable(
  'tour_date_slots',
  {
    tourId: int('tour_id')
      .notNull()
      .references(() => tours.id),
    /** Civil date in Asia/Manila — the tour day, not an instant. */
    date: date('date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tourId, t.date] })],
);

/**
 * The DATE-level lock row (owner decision 2026-10-11, Q14 option A). One row
 * per bookable day, shared by every tour.
 *
 * Exists because the fleet is global: the Q7 capacity rule —
 * `MIN(groups_per_day, vans free that day across all tours)` — cannot be
 * enforced by a per-tour lock, since two bookings for DIFFERENT tours on the
 * same date lock different `tour_date_slots` rows, never wait for each
 * other, and can both take the last van.
 *
 * **Every booking transaction takes both locks, always in this order:**
 *
 *   1. `fleet_date_slots(date)`          SELECT … FOR UPDATE
 *   2. `tour_date_slots(tour_id, date)`  SELECT … FOR UPDATE
 *
 * Fleet first, tour second, with no exceptions. Two transactions that take
 * the same pair in opposite orders deadlock — A holds fleet and waits for
 * tour while B holds tour and waits for fleet — and InnoDB kills one of
 * them. A fixed global order makes that impossible rather than rare, and
 * "rare" is the worst kind of concurrency bug: it passes every test and
 * fails on a holiday weekend.
 *
 * Created on demand like `tour_date_slots` (Q8), with
 * `INSERT … ON DUPLICATE KEY UPDATE date = date`.
 *
 * No columns beyond the key, deliberately: a counter here would be a second
 * copy of a number the `bookings` rows already carry.
 */
export const fleetDateSlots = mysqlTable('fleet_date_slots', {
  /** Civil date in Asia/Manila. */
  date: date('date').primaryKey(),
});

/**
 * Every provider the payment layer knows by name. `manual` is the
 * bank-transfer / cash path an admin verifies by hand — it is a provider in
 * this enum so a manually approved payment is recorded the same way as a
 * gateway one, rather than as a special case with no event trail.
 */
export const PAYMENT_PROVIDERS = ['paymongo', 'xendit', 'manual'] as const;

/**
 * Webhook idempotency across ALL providers (BUILD_SPEC §10's
 * `paymongo_events`, renamed per the plan's owner-approved amendment B1b;
 * §6 "Idempotency").
 *
 * A gateway retries a webhook until it gets a 2xx, so the same event
 * arrives more than once. The unique index below is what makes replaying it
 * a no-op instead of a second payment.
 */
export const paymentEvents = mysqlTable(
  'payment_events',
  {
    id: int('id').autoincrement().primaryKey(),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    /**
     * The gateway's own event id. Unique PER PROVIDER, never globally —
     * nothing stops PayMongo and Xendit minting the same string, and a
     * global unique index would make the second gateway's event silently
     * look like a duplicate and be dropped.
     *
     * 191 characters, not 255: this column sits in a unique index, and
     * utf8mb4 at 4 bytes/char puts 255 over MySQL's 767-byte index prefix
     * limit on older row formats. 191 is the conventional safe maximum.
     */
    providerEventId: varchar('provider_event_id', { length: 191 }).notNull(),
    type: varchar('type', { length: 80 }).notNull(),
    payload: json('payload'),
    receivedAt: datetime('received_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Null until the event has been acted on; lets a crash mid-processing be retried. */
    processedAt: datetime('processed_at', { mode: 'date' }),
  },
  (t) => [
    uniqueIndex('payment_events_provider_event_unique').on(t.provider, t.providerEventId),
    index('payment_events_unprocessed_idx').on(t.processedAt),
  ],
);
