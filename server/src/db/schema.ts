/**
 * Public content tables for the TravelSugbo website (phase 1 of the dynamic
 * site + SEO plan). Transcribed verbatim from the "Database schema" section
 * of docs/superpowers/plans/2026-10-09-dynamic-site-and-seo.md.
 *
 * Out of scope here (Week 3+): bookings, payments, users, sessions, vans,
 * drivers, coupons, audit_log, tour_date_slots.
 *
 * Conventions:
 * - Money is integer centavos (`int`), never DECIMAL/float.
 * - created_at/updated_at are produced in JS (UTC), not MySQL's SYSTEM
 *   timezone: `$defaultFn` on insert, `$onUpdateFn` on update for updated_at.
 */
import {
  boolean,
  date,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

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
  blurb: varchar('blurb', { length: 400 }),
  imagePath: varchar('image_path', { length: 300 }),
  imageAlt: varchar('image_alt', { length: 300 }),
  sortOrder: int('sort_order').notNull().default(0),
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
