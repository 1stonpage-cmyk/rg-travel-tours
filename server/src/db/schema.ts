/**
 * Public content tables for the TravelSugbo website (phase 1 of the dynamic
 * site + SEO plan). Transcribed verbatim from the "Database schema" section
 * of docs/superpowers/plans/2026-10-09-dynamic-site-and-seo.md.
 *
 * Since the core-schema plan (docs/superpowers/plans/2026-10-10-core-schema.md)
 * this file also holds the transactional core, added one table per task —
 * `payments` (task 12) included, which completes the plan's 17 tables.
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
import {
  ADMIN_ROLES,
  BOOKING_STATUSES,
  DISCOUNT_TYPES,
  PAY_MODES,
  type PriceSnapshot,
} from '@rg/shared';

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
    /**
     * The tour reviewed, or null for a review of the operator as a whole.
     *
     * Made a real foreign key in task 11b (owner decision 2026-10-11): it
     * had been a bare int since the public-site plan, and a dangling
     * `tour_id` points a five-star review at a tour that does not exist —
     * which still raises the site-wide average while showing nowhere a
     * reader could check it. That is the fake social proof CLAUDE.md
     * forbids, arrived at by accident.
     *
     * Nullable stays, and nothing cascades: retiring a tour must not erase
     * what guests said about it.
     */
    tourId: int('tour_id').references(() => tours.id),
    /**
     * The booking this review came from, or null for an admin-entered one.
     * Retro-fitted as a real foreign key in the core-schema plan's Task 11,
     * once `bookings` existed: this column is what makes a review
     * "verified", and a review claiming a booking nobody ever took is
     * exactly the fake social proof CLAUDE.md forbids. Nullable stays —
     * an admin-entered review has no booking behind it.
     */
    bookingId: int('booking_id').references(() => bookings.id),
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
    /**
     * The package this enquiry is about; null for a general contact form.
     * Retro-fitted as a real foreign key in the core-schema plan's Task 11.
     * A dangling id renders as "enquiry about (nothing)" in the admin list,
     * which is how a real customer's question gets lost.
     */
    packageId: int('package_id').references(() => packages.id),
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
  (t) => [
    index('driver_leaves_driver_range_idx').on(t.driverId, t.startDate, t.endDate),
    /**
     * The range runs forwards (owner decision 2026-10-11, task 11b-2).
     *
     * A backwards row is not merely untidy: every availability query asks
     * `start_date <= :day AND end_date >= :day`, which a reversed range can
     * never satisfy — so the leave silently does nothing and the driver is
     * dispatched on a day they told dispatch they were off. `>=`, not `>`:
     * a single-day leave is `start_date = end_date` (the range is inclusive
     * at both ends).
     *
     * This constrains ONE row. Two leaves for the same driver that overlap
     * each other are still possible and are a service-layer concern — the
     * owner has logged that separately; it is deliberately not built here.
     */
    check('driver_leaves_date_order', sql`${t.endDate} >= ${t.startDate}`),
  ],
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
    /**
     * The RANGE, which the shape CHECK above does not constrain (owner
     * decision 2026-10-11, task 11b-1). `coupons_discount_shape` asks only
     * *which* column is set, so `percent_bp = 999999` — a 9999.99% discount
     * that pays the guest to travel — satisfies it perfectly, as does
     * `amount_centavos = -5000`, a "discount" that adds ₱50 to the bill.
     *
     * 1..10000 basis points is 0.01%..100%: a coupon must take something off
     * and cannot take off more than the whole price. The bound mirrors
     * `couponDiscountSchema` in `/shared` exactly — Zod guards the API, this
     * guards the seed script, the migration and the 2am UPDATE.
     *
     * `IS NULL OR` is explicit rather than relying on MySQL treating a NULL
     * CHECK result as satisfied: the null case is the normal one for a fixed
     * coupon, and it should be legible in the DDL rather than implied.
     */
    check(
      'coupons_percent_bp_range',
      sql`${t.percentBp} IS NULL OR (${t.percentBp} >= 1 AND ${t.percentBp} <= 10000)`,
    ),
    /**
     * A fixed discount is strictly positive centavos. Zero is not a coupon
     * (it would show as applied and take nothing off), and a negative one is
     * a surcharge wearing a coupon's name.
     */
    check('coupons_amount_positive', sql`${t.amountCentavos} IS NULL OR ${t.amountCentavos} > 0`),
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

/**
 * Who a session belongs to. Three subject types, one table (BUILD_SPEC §10;
 * §7 portal login, §8 driver login).
 *
 *   user      an admin signing in with email + password -> users.id
 *   customer  a guest in the portal -> bookings.id
 *   driver    a driver signing in with code + PIN -> drivers.id
 *
 * The staff type is `user`, matching the `users` table, NOT `admin`: a
 * second name for the same thing is how a role check ends up comparing
 * against a string nothing ever sets.
 *
 * `customer` points at a BOOKING, not at an account, because there are no
 * customer accounts — §7: a portal session is "scoped to that booking only"
 * (plan Q1). A customer with two bookings has two sessions, and neither can
 * see the other's trip.
 */
export const SESSION_SUBJECTS = ['user', 'customer', 'driver'] as const;

/**
 * Server-side session records for all three portals. The cookie carries an
 * opaque random token; this table carries only its SHA-256, so a stolen
 * database yields no usable session — there is nothing in here to replay.
 *
 * There is deliberately NO column that could hold a raw token, and no
 * `password`, `pin` or `secret` column either: a session row is a pointer to
 * a subject plus an expiry, and nothing else.
 */
export const sessions = mysqlTable(
  'sessions',
  {
    id: int('id').autoincrement().primaryKey(),
    /** Which table `subject_id` points at. No FK — see "Polymorphic columns" in the plan. */
    subjectType: mysqlEnum('subject_type', SESSION_SUBJECTS).notNull(),
    /**
     * users.id | bookings.id | drivers.id, per `subject_type`.
     *
     * Polymorphic, so it carries no foreign key: MySQL cannot express "this
     * int references one of three tables depending on a sibling column". A
     * pair of nullable FK columns would not fix it — it would let both be
     * set at once and still leave the customer case unconstrained. The
     * integrity a FK would have given is enforced in the session service and
     * pinned by the tests in `schema-sessions.test.ts`.
     */
    subjectId: int('subject_id').notNull(),
    /**
     * SHA-256 of the session token, as 64 hex characters. The raw token
     * exists only in the cookie and is never written anywhere — not to this
     * table, not to a log, not to an audit row.
     *
     * Unique, so one token can never resolve to two sessions, and so a
     * lookup is a single index hit on the hash rather than a scan.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    /**
     * Non-nullable on purpose: a session with no expiry is a permanent
     * credential. Every row says when it dies, in UTC.
     */
    expiresAt: datetime('expires_at', { mode: 'date' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    /** "Log this subject out everywhere", and "list a driver's live sessions". */
    index('sessions_subject_idx').on(t.subjectType, t.subjectId),
    /** The sweep that deletes expired rows (a §13 cron job). */
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * The central record of the whole system (BUILD_SPEC §10, §5, §6).
 *
 * Money, in four `int` centavos columns and no others:
 *
 *   subtotal_centavos      tier price x pax, plus add-ons
 *   discount_centavos      what the coupon took off
 *   total_centavos         subtotal - discount
 *   amount_paid_centavos   sum of verified payments so far
 *
 * **There is deliberately no `balance` column.** §5 defines balance as
 * `total - amount_paid`, computed at read time. Storing it would create two
 * places that have to agree about what a guest owes, and the day they
 * disagree is the day someone is charged twice or waved through for free.
 * If a query wants it, the query subtracts.
 *
 * Capacity is held by the five statuses in `CAPACITY_HOLDING_STATUSES`
 * (@rg/shared) — that constant, not a condition written out again here.
 *
 * `hold_expires_at` implements the 15-minute hold: set at creation, cleared
 * once the booking is paid, verified or finished. The §13 cron sweeps it
 * every minute via `bookings_hold_expiry_idx`.
 *
 * Nothing in this table cascades on delete (plan: `ON DELETE RESTRICT`
 * everywhere). Bookings are never hard-deleted, and a cascade is precisely
 * the mechanism that would quietly delete one.
 */
export const bookings = mysqlTable(
  'bookings',
  {
    id: int('id').autoincrement().primaryKey(),
    /**
     * The public reference: `RG-7KQ4M9`. Random and non-sequential, because
     * §7 logs a guest into the portal with ref + email — a sequential ref
     * would let anyone walk the next booking. Generated by
     * `generateBookingRef()` (plan Task 9); this task creates the column.
     *
     * Unique, so two guests can never be handed the same reference.
     * `id` is internal and is never shown to a guest.
     */
    ref: varchar('ref', { length: 12 }).notNull().unique(),
    tourId: int('tour_id')
      .notNull()
      .references(() => tours.id),
    /**
     * The tour DAY as a civil date in Asia/Manila — `date`, not `datetime`.
     * A trip on the 25th is on the 25th in Cebu regardless of the server's
     * clock, and an instant would make "which day is this" a timezone
     * question. Conversion lives in `shared/src/time.ts` only.
     */
    tourDate: date('tour_date').notNull(),
    pax: int('pax').notNull(),

    leadName: varchar('lead_name', { length: 160 }).notNull(),
    leadEmail: varchar('lead_email', { length: 200 }).notNull(),
    leadPhone: varchar('lead_phone', { length: 40 }).notNull(),
    pickup: varchar('pickup', { length: 400 }),
    pickupMapUrl: varchar('pickup_map_url', { length: 500 }),
    requests: text('requests'),

    status: mysqlEnum('status', BOOKING_STATUSES).notNull().default('pending_payment'),
    payMode: mysqlEnum('pay_mode', PAY_MODES).notNull(),

    /**
     * Frozen copy of everything the price AND the refund rights depend on
     * (owner decision 2026-10-11, Q5). Written once at booking time and
     * never updated.
     *
     * It freezes, explicitly:
     *   - the tier used and its price per person
     *   - every add-on taken, with its price and per_person flag
     *   - the coupon applied (code, type and value)
     *   - `depositPercent`, the deposit percent in force
     *   - `freeCancelHours`, the tour's `free_cancel_hours` window
     *   - the computed subtotal / discount / total
     *
     * **Refund and cancellation logic reads THIS, never the live tour.**
     * That is the whole point: an admin editing a tour's price or shortening
     * its cancellation window must not retroactively change what an existing
     * guest already agreed to. §5 says later price edits do not change
     * existing bookings; freezing `free_cancel_hours` extends the same
     * guarantee to their refund rights.
     *
     * The shape is `priceSnapshotSchema` / `PriceSnapshot` in @rg/shared, so
     * a writer that drops a field fails to typecheck rather than silently
     * storing a snapshot that cannot answer "may this guest cancel free?".
     *
     * The `*_centavos` columns below are a queryable SUMMARY of this blob,
     * not a second source of truth.
     */
    priceSnapshot: json('price_snapshot').$type<PriceSnapshot>().notNull(),
    subtotalCentavos: int('subtotal_centavos').notNull(),
    discountCentavos: int('discount_centavos').notNull().default(0),
    totalCentavos: int('total_centavos').notNull(),
    /** Sum of verified payments. Balance is `total - this`, never stored. */
    amountPaidCentavos: int('amount_paid_centavos').notNull().default(0),

    couponId: int('coupon_id').references(() => coupons.id),
    /** Assigned later by dispatch (§5 "Assignment rule"), so nullable. */
    vanId: int('van_id').references(() => vans.id),
    driverId: int('driver_id').references(() => drivers.id),

    /**
     * The 15-minute hold (§5). Null once the booking is paid, has a receipt
     * under verification, or is finished — a null here means "nothing to
     * expire", which is exactly what the cron's index query looks for.
     */
    holdExpiresAt: datetime('hold_expires_at', { mode: 'date' }),
    startedAt: datetime('started_at', { mode: 'date' }),
    completedAt: datetime('completed_at', { mode: 'date' }),
    cancelledAt: datetime('cancelled_at', { mode: 'date' }),
    cancelReason: varchar('cancel_reason', { length: 400 }),

    /**
     * Money landed on a booking that was already dead (owner decision
     * 2026-10-11, task 16b-3).
     *
     * A guest starts a GCash payment, the 15-minute hold lapses (or an admin
     * cancels the booking) and the gateway's webhook arrives a minute later.
     * The money is REAL, so `recordPayment()` still records the `payments`
     * row and still moves `amount_paid_centavos` — but it must **NOT**
     * change `status`, because the capacity that booking was holding has
     * been released and re-confirming it could overbook the day.
     *
     * So it sets this flag and writes an `audit_log` row naming the prior
     * status and the reason. An admin then decides: re-confirm if capacity
     * allows, or refund. **Nothing auto-confirms** — that is an explicit
     * owner DO-NOT, and the admin surface for this is a later week.
     *
     * A plain boolean rather than a status value: `BOOKING_STATUSES` is the
     * §5 lifecycle and a "needs review" member would have to be threaded
     * through every capacity query, portal view and driver filter that
     * switches on it. This is orthogonal to the lifecycle — a cancelled
     * booking with unreviewed money and an expired one are both still
     * cancelled and expired.
     *
     * It is cleared only by the admin decision that resolves it, never by
     * `recordPayment()`: a second late payment on an already-flagged booking
     * must not look resolved.
     */
    paymentReviewRequired: boolean('payment_review_required').notNull().default(false),

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
     * The three indexes BUILD_SPEC §10 names, verbatim.
     *
     * `bookings_tour_date_status_idx` is the capacity check's index: it
     * filters tour + date and then counts the capacity-holding statuses.
     *
     * `bookings_ref_idx` duplicates the index MySQL already builds for the
     * UNIQUE constraint on `ref`. It is kept because §10 names it and the
     * plan says "verbatim" — see the task report's concerns, where dropping
     * it is proposed as a separate, spec-amending change rather than a
     * silent deviation here.
     *
     * `bookings_driver_date_idx` is the driver portal's "my trips today".
     */
    index('bookings_tour_date_status_idx').on(t.tourId, t.tourDate, t.status),
    index('bookings_ref_idx').on(t.ref),
    index('bookings_driver_date_idx').on(t.driverId, t.tourDate),
    /** Added by the plan: the cron that expires holds scans this every minute. */
    index('bookings_hold_expiry_idx').on(t.status, t.holdExpiresAt),
  ],
);

/**
 * One add-on line on a booking (BUILD_SPEC §10).
 *
 * **The line snapshots the add-on's name and price instead of trusting the
 * foreign key** — the same reason `bookings.price_snapshot` exists. An
 * add-on gets renamed from "Island lunch" to "Lunch (buffet)" and repriced
 * from ₱350 to ₱500 next season; a booking taken this season must still say
 * what the guest actually agreed to pay for, and a join to `tour_addons`
 * would quietly rewrite it. `addon_id` is kept for reporting ("how often is
 * the lunch taken?"), never for money.
 *
 * `price_centavos` is written from server-side data only. The browser sends
 * which add-ons it wants and nothing else: never a price, never a quantity's
 * worth of pesos (CLAUDE.md — the server computes all money).
 *
 * `per_person` decides whether the price multiplies by `pax`, so it is part
 * of the snapshot too: the flag can be edited on the add-on as easily as the
 * price, and a line without it is unpriceable.
 */
export const bookingAddons = mysqlTable(
  'booking_addons',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** Which add-on this was. Kept for reporting; the row does not trust it for money. */
    addonId: int('addon_id')
      .notNull()
      .references(() => tourAddons.id),
    /** Snapshot: the add-on may be renamed later (§5 price snapshot). */
    name: varchar('name', { length: 200 }).notNull(),
    /** Snapshot, in centavos. Server-computed; never a browser-supplied value. */
    priceCentavos: int('price_centavos').notNull(),
    /** Snapshot: true when the price multiplies by `pax`, false when per booking. */
    perPerson: boolean('per_person').notNull(),
    qty: int('qty').notNull().default(1),
  },
  (t) => [
    /** The only way these rows are ever read: all the lines of one booking. */
    index('booking_addons_booking_idx').on(t.bookingId),
  ],
);

/**
 * An internal admin note on a booking (BUILD_SPEC §10, §9 Bookings).
 * Never shown to the guest.
 *
 * **`user_id` is NOT NULL.** A note is read months later to reconstruct why
 * a booking was moved, refunded or argued about, and an unattributed note
 * cannot be audited — "someone decided to waive the balance" records
 * nothing. Nullable would also be the path of least resistance for a bulk
 * import, which is exactly how a table fills up with anonymous notes.
 *
 * Notes are append-only in practice: there is no `updated_at`, because an
 * edited audit trail is not one. A correction is a new note.
 */
export const bookingNotes = mysqlTable(
  'booking_notes',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** The admin who wrote it. Never null — an unattributed note is not auditable. */
    userId: int('user_id')
      .notNull()
      .references(() => users.id),
    note: text('note').notNull(),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    /** One booking's note thread, in the order it is displayed. */
    index('booking_notes_booking_idx').on(t.bookingId, t.createdAt),
  ],
);

/**
 * One row per coupon use (BUILD_SPEC §10). This is what enforces a coupon's
 * `usage_limit`: `coupons.used_count` is a cached counter, these rows are
 * the record.
 *
 * **Unique on `(coupon_id, booking_id)`, in that order.** Not `booking_id`
 * alone — that would stop a booking ever using a second coupon, which is a
 * pricing decision this table has no business making. Not `coupon_id`
 * alone — that would cap every coupon at one redemption in total, which is
 * not what `usage_limit` means. The pair is the thing that must not repeat:
 * one booking must not count twice against one coupon's cap.
 */
export const couponRedemptions = mysqlTable(
  'coupon_redemptions',
  {
    id: int('id').autoincrement().primaryKey(),
    couponId: int('coupon_id')
      .notNull()
      .references(() => coupons.id),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_unique').on(t.couponId, t.bookingId),
    /** Counting a coupon's redemptions against its cap. */
    index('coupon_redemptions_coupon_idx').on(t.couponId),
  ],
);

/**
 * One itinerary check-in on a running trip (BUILD_SPEC §10, §8 "Itinerary
 * check-ins"). The driver taps Start, then each stop as the van reaches it,
 * and these rows are what the customer portal's live tracker reads.
 *
 * **`stop_id` is nullable, and null means "trip start".** The Start tap
 * happens before any itinerary stop is reached, so that event has no stop
 * behind it. The alternative — a synthetic "Trip start" row in
 * `tour_itinerary_stops` for every tour — would put a fake entry in the
 * itinerary guests read on the tour page.
 *
 * **`undone` is a boolean, not a DELETE.** §8: "Undo last check-in …
 * marked undone, not deleted". A driver who taps the wrong stop corrects it
 * without the trip's timeline losing the fact that a tap happened — and
 * that timeline is what answers "when did this van actually arrive?" months
 * later, in a complaint or a refund argument.
 *
 * **`checked_at` is server time, never the device's.** A phone clock is
 * settable, and a check-in timestamp is evidence that a trip ran. There is
 * deliberately no second column for a handset-supplied time: one would
 * immediately become the one everybody reads.
 */
export const tripCheckpoints = mysqlTable(
  'trip_checkpoints',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** Null = the "start trip" event, which has no itinerary stop behind it (§8). */
    stopId: int('stop_id').references(() => tourItineraryStops.id),
    /**
     * `COALESCE(stop_id, 0)` — the column that makes the UNIQUE index below
     * actually constrain the trip-start event (owner decision 2026-10-11,
     * task 16b-2).
     *
     * **Why it has to exist.** `UNIQUE (booking_id, stop_id)` does not stop
     * two trip-start rows for one booking, because `stop_id` is NULL for
     * "trip start" and **MySQL permits unlimited NULLs in a unique index**.
     * Mapping null to `0` gives every row a non-null key, so the two
     * trip-start rows collide the same way two "Arrived at Kawasan" rows do.
     *
     * `0` is safe as the sentinel: `tour_itinerary_stops.id` is an
     * AUTO_INCREMENT primary key and never issues 0, so no real stop can
     * ever share the trip-start key.
     *
     * **STORED, not VIRTUAL** — MySQL cannot build a unique index on a
     * virtual generated column in InnoDB without it being a secondary index
     * on an unindexable expression; stored is the form the UNIQUE needs and
     * the form task 11b proved on the test database.
     *
     * **Never written by application code.** It is `GENERATED ALWAYS`, so an
     * INSERT that names it is rejected by MySQL. Write `stop_id`; this
     * follows.
     */
    stopKey: int('stop_key')
      .notNull()
      .generatedAlwaysAs(sql`(coalesce(\`stop_id\`, 0))`, { mode: 'stored' }),
    /** Server time in UTC, never the driver's device clock. */
    checkedAt: datetime('checked_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** §8: "Undo last check-in … marked undone, not deleted". */
    undone: boolean('undone').notNull().default(false),
    /**
     * WHEN the undo happened, and WHO did it (owner decision 2026-10-11,
     * task 11b-2).
     *
     * `undone` alone records that a tap was retracted but not when — and
     * "the van arrived at 10:15, then that was retracted at 10:16" and
     * "… retracted three days later, after the complaint came in" are very
     * different facts in a refund argument. Both columns stay null while
     * `undone` is false.
     *
     * `undone_by` is a DRIVER, not an admin user: §8 scopes undo to the
     * driver portal ("Undo last check-in — only the most recent"). If the
     * admin/dispatch surface ever gains the same power it needs its own
     * column, not a second meaning for this one.
     */
    undoneAt: datetime('undone_at', { mode: 'date' }),
    undoneBy: int('undone_by').references(() => drivers.id),
  },
  (t) => [
    /** One trip's checkpoints, in the order they happened. */
    index('trip_checkpoints_booking_idx').on(t.bookingId, t.checkedAt),
    /**
     * One check-in per stop per trip, **trip start included** (owner
     * decisions 2026-10-11: task 11b-2, closed by task 16b-2). A driver on a
     * moving van double-taps "Arrived at Kawasan", or taps Start twice while
     * the first request is still in flight, and the tracker must not show
     * either event happening twice.
     *
     * It is keyed on `stop_key`, not `stop_id`. That is the whole fix: the
     * earlier `(booking_id, stop_id)` index constrained real stops only,
     * because null means "trip start" and MySQL permits unlimited NULLs in a
     * unique index. `stop_key` is `COALESCE(stop_id, 0)` (see the column
     * above), so the trip-start rows have a real key to collide on.
     *
     * The index name is deliberately unchanged — it is the same constraint,
     * now actually complete. `schema-trips.test.ts` proves both halves
     * against the real database, with raw INSERTs: a duplicate real stop is
     * refused, and so is a duplicate trip start.
     */
    uniqueIndex('trip_checkpoints_booking_stop_unique').on(t.bookingId, t.stopKey),
  ],
);

/**
 * One "was this helpful?" vote on a review (BUILD_SPEC §10, §4 Reviews).
 *
 * **The composite primary key `(review_id, voter_hash)` IS the one-vote
 * rule** (§4: "one per browser via cookie + IP rate limit"). There is no
 * surrogate `id`: the pair is the identity of the row, so a second vote is
 * refused by the key itself rather than by an index somebody could forget
 * to write an INSERT against. Keyed on the pair, not `voter_hash` alone —
 * one visitor gets one vote per review, not one vote for the whole site.
 *
 * **`voter_hash` is a hash of the cookie id plus the IP, never the IP.** A
 * raw address is personal data under RA 10173 (CLAUDE.md Security), and
 * this table has no admin screen, no retention rule and no subject-access
 * path behind it — so it must not hold one. The hash is enough: all it is
 * ever asked is "has this browser already voted here?".
 */
export const reviewHelpfulVotes = mysqlTable(
  'review_helpful_votes',
  {
    reviewId: int('review_id')
      .notNull()
      .references(() => reviews.id),
    /** SHA-256 of cookie id + IP. Never the address itself (RA 10173). */
    voterHash: varchar('voter_hash', { length: 64 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.voterHash] })],
);

/** Money IN or money OUT. A refund is a row here, never a booking status (BUILD_SPEC §6). */
export const PAYMENT_TYPES = ['payment', 'refund'] as const;

/**
 * HOW the guest paid — the instrument, never the processor (owner decision
 * 2026-10-11, plan Q2).
 *
 * `provider` and `method` are two different questions, and §10's single
 * `method` column conflated them: it listed `(paymongo/manual_qr/cash)`,
 * mixing who processed the money with how the guest handed it over. They are
 * split because GCash through PayMongo and GCash through Xendit are the same
 * instrument and different processors, and §9's "revenue by payment method"
 * report needs both axes.
 *
 * Note what is NOT here: `manual_qr`. That old spec value conflated the
 * instrument with the fact that a human verified it, and `provider` already
 * carries that — a QR transfer an admin approved by hand is
 * `provider='manual'` plus whichever instrument the guest actually used
 * (`gcash`, `maya`, `bank_transfer`, ...). Keeping both would give two ways
 * to record one payment, which is the drift the split exists to prevent.
 *
 * `bank_transfer` stays at launch: it is the manual receipt-upload flow.
 */
export const PAYMENT_METHODS = [
  'card',
  'gcash',
  'maya',
  'grab_pay',
  'qrph',
  'bank_transfer',
  'cash',
] as const;

/**
 * OUR normalised status, never a gateway's wording. The gateways disagree
 * with each other and with themselves over time ("succeeded", "paid",
 * "PAID", "settled"); mapping their string onto one of these five is the
 * payment service's job, and the raw original is kept verbatim in
 * `provider_status` for support and reconciliation.
 */
export const PAYMENT_STATUSES = ['pending', 'paid', 'rejected', 'failed', 'refunded'] as const;

/**
 * Every payment and every refund, for every provider (BUILD_SPEC §10, §6).
 *
 * **Provider-neutral by construction** (plan amendment B1a, Phase 3's design
 * rule): there is no `paymongo_id` column and no gateway name anywhere in
 * this declaration. A gateway's own identifiers go in `provider_ref` /
 * `provider_status`, and `provider` is an enum value. Adding Xendit later
 * touches a new file in `server/src/services/payments/` and one line in the
 * registry — never this table. `schema-payments.test.ts` reads the real
 * column list out of `information_schema` and fails on any name matching
 * /paymongo|xendit|stripe/, so that property is enforced rather than
 * remembered.
 *
 * **Never hard-deleted** (Global Constraints). Nothing cascades into this
 * table: every foreign key is RESTRICT, which is precisely the mechanism
 * that would otherwise delete a payment quietly along with its booking.
 */
export const payments = mysqlTable(
  'payments',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),

    /** Money IN or money OUT. A refund is a row here, never a booking status (§6). */
    type: mysqlEnum('type', PAYMENT_TYPES).notNull(),
    /** WHO processed it. Adding a gateway adds an enum value, not a column. */
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    /** HOW the guest paid. Orthogonal to `provider` — GCash exists on several. */
    method: mysqlEnum('method', PAYMENT_METHODS).notNull(),

    /**
     * ALWAYS POSITIVE, in centavos — refunds too. Direction comes from
     * `type`, never from a sign: a negative amount plus a `refund` type is
     * two ways of saying the same thing and they drift, and a `SUM()` that
     * silently mixes them is a reporting bug waiting to happen. A refund of
     * ₱1,500 is `type='refund', amount_centavos=150000`.
     */
    amountCentavos: int('amount_centavos').notNull(),
    /** OUR normalised status. Never the gateway's wording. */
    status: mysqlEnum('status', PAYMENT_STATUSES).notNull().default('pending'),

    /**
     * The gateway's own id for this charge or refund — opaque to us, so a
     * plain varchar rather than anything we parse. 191 characters for the
     * same indexable-prefix reason as `payment_events.provider_event_id`:
     * this column sits in an index.
     */
    providerRef: varchar('provider_ref', { length: 191 }),
    /** The gateway's raw status string, kept verbatim for support and reconciliation. */
    providerStatus: varchar('provider_status', { length: 80 }),

    /** Manual QR flow (§6): the guest-entered transaction reference. */
    txnRef: varchar('txn_ref', { length: 191 }),
    /**
     * A PATH under /uploads, which is OUTSIDE the web root and served
     * through an authenticated route (CLAUDE.md Security). Never a public
     * URL — a receipt carries a guest's name and amount, and this table
     * deliberately has no `*_url` column to put one in.
     */
    receiptPath: varchar('receipt_path', { length: 300 }),
    /** Why an admin rejected a manual payment, shown to the guest in the portal. */
    rejectReason: varchar('reject_reason', { length: 400 }),

    /** Set only by an admin approval path — null on every gateway payment. */
    verifiedBy: int('verified_by').references(() => users.id),
    verifiedAt: datetime('verified_at', { mode: 'date' }),
    /** Driver who took cash on tour day (§8). */
    collectedByDriverId: int('collected_by_driver_id').references(() => drivers.id),

    createdAt: datetime('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    /** The two indexes BUILD_SPEC §10 names. */
    index('payments_booking_idx').on(t.bookingId),
    index('payments_status_idx').on(t.status),
    /**
     * Added by the plan: reconciling an incoming webhook against an existing
     * row. It covers BOTH columns — `provider_ref` alone would let two
     * gateways' identical reference strings collide in the lookup, and the
     * webhook would reconcile against the wrong payment.
     */
    index('payments_provider_ref_idx').on(t.provider, t.providerRef),
    /**
     * The RANGE, in the database (owner decision 2026-10-11, task 16b-1).
     * Mirrors `coupons_amount_positive`, and for the same reason.
     *
     * `amount_centavos` is always-positive BY DESIGN — direction comes from
     * `type` (`payment` | `refund`), never from a sign (§6, Q11). The column
     * comment above says so and `recordPaymentInputSchema` enforces
     * `.positive()`, but neither is a constraint: a seed script, a migration
     * or a hand-written UPDATE at 2am all bypass Zod entirely, and
     * `type='refund', amount_centavos=-150000` would then satisfy every
     * declaration in this file while quietly inverting a `SUM()`.
     *
     * Zero is refused too, not only negatives: a ₱0.00 payment row would
     * read as money having landed and could mark a booking confirmed for
     * nothing. `schema-payments.test.ts` proves BOTH with raw INSERTs that
     * never touch Zod — the point is that MySQL refuses the row.
     */
    check('payments_amount_positive', sql`${t.amountCentavos} > 0`),
  ],
);
