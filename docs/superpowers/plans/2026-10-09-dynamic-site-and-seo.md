# Dynamic Public Site + Per-Page SEO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `client/src/lib/placeholder-data.ts` with a real MySQL + Drizzle + tRPC data layer, add server-rendered per-page SEO, and make every home-page content block data-driven — with the rendered page identical to today.

**Architecture:** Express owns the database (Drizzle + mysql2) and exposes read queries plus two rate-limited mutations over tRPC. The client consumes them through `@trpc/react-query` + TanStack Query, replacing module-level constants with queries plus skeleton / error / empty states. A single `resolvePage(pathname)` module produces title, description, canonical, Open Graph and JSON-LD for a route; Express uses it in production and a Vite dev middleware uses the same module in development, so SEO is identical and testable in both. Content blocks with no natural table (announcement, business hours, payment methods, hero copy, FAQ, legal text) live as Zod-validated JSON values in the `settings` table.

**Tech Stack:** MySQL 8.0.46 · Drizzle ORM + drizzle-kit · mysql2 · tRPC v11 · TanStack Query v5 · Zod v4 · express-rate-limit · React 19 + Vite 7 + Tailwind v4

**Spec:** `docs/BUILD_SPEC.md` (sections 4, 10, 12) and the task list in the originating prompt. `CLAUDE.md` holds the standing conventions.

---

## Global Constraints

Copied from `CLAUDE.md` and the task prompt. Every task below implicitly includes these.

- **Ports:** client **5180**, server **3100**. Never 5173 or 3000.
- **Database:** only the `rg_travel` user against the `rg_travel` database. **Never root.** No SQL, migration or seed against any other database.
- **Never print or log `DATABASE_URL`, `DB_PASSWORD` or any secret** — not in errors, not in guard messages, not in test output.
- **Never touch** `C:\dev\kong-pms`, MySQL server settings, or the MySQL service.
- **Money:** integer **centavos** in DB, API and logic. Format only at display.
- **Time:** store **UTC**; compute and display business dates in **Asia/Manila**.
- **Soft deletes** via `is_active` / status columns.
- **Allowed new dependencies, and no others:** `drizzle-orm`, `drizzle-kit`, `mysql2`, `@trpc/*`, `@tanstack/react-query`, `zod`, `express-rate-limit`. (`drizzle-orm`, `drizzle-kit`, `mysql2`, `zod`, `@trpc/server` are already installed.)
- **NO RED ANYWHERE** — including errors, badges and destructive buttons. Warnings use amber/orange; errors use `#334155`. `client/src/__tests__/no-red.test.ts` enforces it.
- **No fake numbers.** No invented ratings, counts or permit numbers.
- **Out of scope:** bookings, payments, checkout, auth, portals, admin screens.
- **No design change.** Same layout, colours, section order, motion and copy — only the data source changes. The two deliberate exceptions are the hidden booking counters (Task 2.6) and the chip-row padding fix (Task 2.8).
- **Do not deploy.**
- **Verification before every push, in this order:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

### Decisions already made (do not re-litigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Seeded `is_sample` reviews **do render** (Reviews section + tour-card averages), so the UI is unchanged. They are **excluded from JSON-LD `AggregateRating`**, which is omitted entirely when no real review exists.                                                                                                                                                                         |
| D2  | The build guard is extended to fail a production build while any `is_sample` review is published, **and** while `settings.content_unverified` is true. Both overridable with `ALLOW_PLACEHOLDER_BUILD=1`. Both get a line in `docs/LAUNCH_CHECKLIST.md`.                                                                                                                                     |
| D3  | Guard behaviour with no database: **skip with a loud warning**, except when `NODE_ENV=production` or `SITE_ENV=production`, where an unreachable DB is a hard failure.                                                                                                                                                                                                                       |
| D4  | **No Lighthouse dependency.** Do all of 5E's performance work and report exactly what changed. Claim no scores.                                                                                                                                                                                                                                                                              |
| D5  | **No tour or package detail pages.** Build `tours.bySlug` and the route→resolver map so `/tours/:slug` plugs in with one line later. The sitemap lists `/`, `/tours`, `/privacy`, `/terms` only — never a URL with no page behind it. A note goes into BUILD_SPEC 2D to add detail URLs to the sitemap in that same task.                                                                    |
| D6  | SEO injection runs in **both** dev and production from **one shared resolver module**.                                                                                                                                                                                                                                                                                                       |
| D7  | Announcement, business hours and payment methods are **Zod-validated JSON in `settings`**, not new tables.                                                                                                                                                                                                                                                                                   |
| D8  | Both booking counters (`booked this week`, `trips run`) return 0/null and **hide**. `tours.historical_trips_count` is added, nullable, left NULL in the seed; when set, trips-run = `historical_trips_count + completed bookings`.                                                                                                                                                           |
| D9  | Seed today's content as-is. `settings.content_unverified = true` drives the existing amber banner. Permits stay empty and render `— pending —`.                                                                                                                                                                                                                                              |
| D10 | `client/src/lib/site.ts` **stays** the source of truth for phones, Facebook, motto, email and the other-services line, so `scripts/check-contact-parity.mjs` is untouched. The seed mirrors those values into `settings.contact`, and a new test fails on drift. A post-launch note is added to BUILD_SPEC and LAUNCH_CHECKLIST to retire the duplication once the coming-soon page is gone. |

### Execution protocol

- Four phases. **Push to `origin main` at the end of each phase**, after all five verification commands pass.
- Write **✅ DONE** after each numbered task. Write **✅ DYNAMIC SITE + SEO COMPLETE** at the very end.
- Only stop to ask about: a genuine deviation from this plan, a blocker, or **anything touching the DB-name guard**.
- Use **ui-ux-pro-max** for every UI surface touched (skeletons, error and empty states, announcement bar, `/privacy`, `/terms`).
- Use **emilkowalski-motion** for any new motion, after layout exists, respecting `prefers-reduced-motion`.
- Unrelated bugs: do not fix. Finish, then list them and wait.

---

## Environment facts (verified 2026-10-09)

- Connected successfully as `rg_travel@localhost` → database `rg_travel`, MySQL **8.0.46**, **0 tables**, `utf8mb4` / `utf8mb4_unicode_ci`, `time_zone = SYSTEM`, `sql_mode` includes `STRICT_TRANS_TABLES` and `ONLY_FULL_GROUP_BY`.
- `DATABASE_URL`, `DB_USER`, `DB_NAME`, `DB_PASSWORD` all present in `.env`. `DB_USER` is `rg_travel` — **not** root.
- `drizzle-orm@0.44.6`, `drizzle-kit@0.31.6`, `mysql2@3.15.2`, `zod@4.1.12`, `@trpc/server@11.6.0` installed. `server/src/db/` does not exist yet.
- `ONLY_FULL_GROUP_BY` is on: every aggregate query must group by all selected non-aggregate columns.
- BUILD_SPEC marks Week 1 tasks 1B/1C/1D and Week 2 tasks 2A–2E as ✅ DONE, but no schema, auth, tour detail page or meta injection exists. Task 4.6 corrects those markers.

---

## File Structure

### Server — new

| File                                     | Responsibility                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/db/guard.ts`                 | `REQUIRED_DATABASE_NAME`, `assertDatabaseName()`, `assertConnectedDatabase()`. Never interpolates URL or password into a message. |
| `server/src/db/client.ts`                | mysql2 pool (`timezone: 'Z'`) + Drizzle instance. Lazy singleton so importing never connects.                                     |
| `server/src/db/schema.ts`                | Every public-content table.                                                                                                       |
| `server/src/db/migrations/`              | drizzle-kit output. Committed.                                                                                                    |
| `server/src/db/seed.ts`                  | Idempotent seed of today's content.                                                                                               |
| `server/src/content/settings-schema.ts`  | Zod schema per settings key + `SettingsPayload` type.                                                                             |
| `server/src/content/settings.ts`         | `readSettings()`, `readSetting(key)` — parse + validate, typed.                                                                   |
| `server/src/services/hours.ts`           | `resolveOpenState(hours, now)` → `{ isOpen, message }` in Asia/Manila.                                                            |
| `server/src/services/schedule.ts`        | `isWithinWindow(startsAt, endsAt, now)` — instant comparison.                                                                     |
| `server/src/services/ratings.ts`         | `displayAggregate()` (all published) and `realAggregate()` (published AND `is_sample = 0`).                                       |
| `server/src/routers/public/*.ts`         | One file per router: settings, destinations, tours, packages, reviews, inquiries, newsletter.                                     |
| `server/src/middleware/rate-limit.ts`    | `createProcedureRateLimit(procedures, opts)` — express-rate-limit scoped to named tRPC procedures.                                |
| `server/src/middleware/robots-header.ts` | `X-Robots-Tag: noindex` for `/admin`, `/driver`, `/portal`, and the whole preview environment.                                    |
| `server/src/seo/types.ts`                | `PageMeta`, `Resolver`.                                                                                                           |
| `server/src/seo/resolvers.ts`            | `ROUTES`, `resolvePage(pathname)`, `matchRoute()`.                                                                                |
| `server/src/seo/jsonld.ts`               | `travelAgencyJsonLd()`, `faqPageJsonLd()`, `touristTripJsonLd()`.                                                                 |
| `server/src/seo/render.ts`               | `injectMeta(html, meta)`.                                                                                                         |
| `server/src/seo/sitemap.ts`              | `buildSitemap()`, `buildRobots(siteEnv)`.                                                                                         |
| `server/src/html.ts`                     | `serveHtml(req, res)` — resolve + inject + correct status. Production only.                                                       |
| `server/scripts/db-preflight.mjs`        | Runs before drizzle-kit migrate; aborts unless the target DB is `rg_travel`.                                                      |

### Server — modified

- `server/src/env.ts` — require `DATABASE_URL`; add `SITE_ENV`.
- `server/src/app.ts` — mount rate limiter, robots header, `/robots.txt`, `/sitemap.xml`, and (prod) the HTML handler.
- `server/src/index.ts` — boot-time DB guard before `listen`.
- `server/src/routers/_app.ts` — compose the public routers.
- `server/package.json` — add `express-rate-limit`, `db:seed`, preflight on `db:migrate`.

### Shared — new

- `shared/src/money.ts` — `formatPeso(centavos)`, moved out of `placeholder-data.ts` so it survives that file's deletion.
- `shared/src/time.ts` — `manilaParts(date)`, `MANILA_OFFSET_MINUTES`.
- `shared/src/schemas/public.ts` — Zod input schemas shared by client and server.

### Client — new

- `client/src/lib/query-client.ts` — the `QueryClient`.
- `client/src/components/common/Skeleton.tsx` — base shimmer block.
- `client/src/components/common/QueryBoundary.tsx` — loading / error / empty switch.
- `client/src/components/common/Markdown.tsx` — tiny dependency-free renderer (headings, paragraphs, lists, bold, links). React elements only, never `dangerouslySetInnerHTML`.
- `client/src/components/layout/AnnouncementBar.tsx` — 6A.
- `client/src/pages/public/PrivacyPage.tsx`, `client/src/pages/public/TermsPage.tsx` — 6I.
- `client/src/__tests__/helpers/mock-trpc.ts` — stubs `globalThis.fetch` for `/trpc/*` with canned payloads. No new dependency.

### Client — modified

Every file importing `placeholder-data`: `TourCard`, `CatalogPreview`, `FaqSection`, `HeroSection`, `HowItWorks`, `MostVisited`, `PackagesSection`, `PromoNewsletter`, `ReviewsSection`, `TrustBar`, `WhyBookDirect`, `PlaceholderBadge`; plus `ContactSection`, `SiteFooter`, `FloatingWhatsApp`, `PublicLayout`, `App.tsx`, `main.tsx`, `lib/trpc.ts`, `vite.config.ts`.

### Deleted at the end of Phase 3

- `client/src/lib/placeholder-data.ts`
- `client/src/__tests__/placeholder-data.test.ts`

---

## Settings keys

Stored as `(key VARCHAR(64) PK, value JSON, updated_at)`. Each has a Zod schema in `server/src/content/settings-schema.ts`; `readSettings()` fails loudly on a malformed value rather than silently defaulting.

| Key                  | Shape                                                                                                                                                             | Task       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `content_unverified` | `boolean`                                                                                                                                                         | 4A / D9    |
| `site_seo`           | `{ title, description, ogImage: string \| null }`                                                                                                                 | 5A         |
| `trust`              | `{ ratingAverage: number \| null, ratingCount: number \| null, guestsServed: number \| null, dotAccredited: boolean, depositPercent: number }`                    | trust line |
| `hero`               | `{ eyebrow, headline, subtitle, ctaLabel, imagePath, imageAlt }`                                                                                                  | 6B         |
| `announcement`       | `{ message, href: string \| null, style: 'info' \| 'warning', startsAt: string \| null, endsAt: string \| null, isActive: boolean }`                              | 6A         |
| `promo`              | `{ code, discountLabel, headline, body, startsAt, endsAt, isActive }`                                                                                             | 6C         |
| `business_hours`     | `Array<{ weekday: 0-6, opensAt: 'HH:MM' \| null, closesAt: 'HH:MM' \| null, isClosed: boolean }>`, exactly 7, weekday 0 = Sunday                                  | 6E         |
| `payment_methods`    | `Array<{ key, label, enabled: boolean, sortOrder: number }>`                                                                                                      | 6F         |
| `permits`            | `{ dot: string \| null, dti: string \| null, bir: string \| null }`                                                                                               | 6G         |
| `how_it_works`       | `Array<{ step: number, title, body }>`                                                                                                                            | 6H         |
| `why_book_direct`    | `Array<{ icon, title, body }>`                                                                                                                                    | 6H         |
| `faqs`               | `Array<{ q, a }>`                                                                                                                                                 | 6H         |
| `contact`            | `{ address, tagline, hoursNote, email, phoneDisplay, phoneTel, whatsapp, altPhoneDisplay, altPhoneTel, facebook, motto, otherServices: { before, link, after } }` | 6H / D10   |
| `legal_privacy`      | `{ markdown, updatedAt }`                                                                                                                                         | 6I         |
| `legal_terms`        | `{ markdown, updatedAt }`                                                                                                                                         | 6I         |

`startsAt` / `endsAt` are ISO-8601 UTC instants — `2026-10-01T16:00:00.000Z` is Manila midnight on 2 October. Comparison is instant-based, so Manila midnight needs no special casing at read time, but it **is** what the 8A edge-case tests assert.

---

## Database schema

`server/src/db/schema.ts`. All money `int` centavos, all timestamps `datetime` UTC, InnoDB, `utf8mb4`.

```
settings(key varchar(64) PK, value json NOT NULL, updated_at datetime NOT NULL)

destinations(
  id int PK AI, name varchar(120) NOT NULL, slug varchar(140) NOT NULL UNIQUE,
  blurb varchar(400) NULL, image_path varchar(300) NULL, image_alt varchar(300) NULL,
  sort_order int NOT NULL DEFAULT 0, is_featured boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at datetime NOT NULL, updated_at datetime NOT NULL)

tours(
  id int PK AI, slug varchar(160) NOT NULL UNIQUE, title varchar(200) NOT NULL,
  destination_id int NOT NULL REFERENCES destinations(id),
  summary varchar(400) NULL, about text NULL,
  inclusions json NULL, exclusions json NULL,
  duration_hours int NULL, groups_per_day int NOT NULL DEFAULT 1,
  max_guests int NOT NULL DEFAULT 12, free_cancel_hours int NULL,
  is_featured boolean NOT NULL DEFAULT false, sort_order int NOT NULL DEFAULT 0,
  badge enum('none','best_seller','new','seasonal') NOT NULL DEFAULT 'none',
  alert_note varchar(300) NULL,
  historical_trips_count int NULL,
  seo_title varchar(200) NULL, seo_description varchar(400) NULL, og_image varchar(300) NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at datetime NOT NULL, updated_at datetime NOT NULL,
  INDEX tours_active_featured_idx (is_active, is_featured, sort_order),
  INDEX tours_destination_idx (destination_id))

tour_images(id int PK AI, tour_id int NOT NULL, path varchar(300) NOT NULL,
  alt varchar(300) NOT NULL, width int NULL, height int NULL,
  sort_order int NOT NULL DEFAULT 0, INDEX (tour_id, sort_order))

tour_price_tiers(id int PK AI, tour_id int NOT NULL, min_pax int NOT NULL,
  max_pax int NOT NULL, price_per_person int NOT NULL, INDEX (tour_id, min_pax))

tour_itinerary_stops(id int PK AI, tour_id int NOT NULL, sort_order int NOT NULL,
  name varchar(200) NOT NULL, description text NULL, INDEX (tour_id, sort_order))

tour_addons(id int PK AI, tour_id int NOT NULL, name varchar(200) NOT NULL,
  price int NOT NULL, per_person boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true, INDEX (tour_id))

tour_blocked_dates(id int PK AI, tour_id int NOT NULL, date date NOT NULL,
  reason varchar(300) NULL, UNIQUE (tour_id, date))

packages(id int PK AI, slug varchar(160) NOT NULL UNIQUE, title varchar(200) NOT NULL,
  days int NOT NULL, old_price int NULL, new_price int NOT NULL, description text NULL,
  image_path varchar(300) NULL, image_alt varchar(300) NULL, highlights json NULL,
  sort_order int NOT NULL DEFAULT 0,
  seo_title varchar(200) NULL, seo_description varchar(400) NULL, og_image varchar(300) NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at datetime NOT NULL, updated_at datetime NOT NULL)

reviews(id int PK AI, tour_id int NULL, booking_id int NULL, name varchar(120) NOT NULL,
  rating tinyint NOT NULL, guide tinyint NULL, value tinyint NULL,
  punctuality tinyint NULL, safety tinyint NULL, body text NOT NULL,
  status enum('pending','published','hidden') NOT NULL DEFAULT 'pending',
  is_sample boolean NOT NULL DEFAULT false,
  reply text NULL, replied_at datetime NULL,
  created_at datetime NOT NULL, updated_at datetime NOT NULL,
  INDEX reviews_status_sample_idx (status, is_sample),
  INDEX reviews_tour_idx (tour_id, status))

inquiries(id int PK AI, type enum('contact','package') NOT NULL, package_id int NULL,
  name varchar(160) NOT NULL, email varchar(200) NOT NULL, phone varchar(40) NULL,
  message text NOT NULL, status enum('new','read','replied','closed') NOT NULL DEFAULT 'new',
  created_at datetime NOT NULL, INDEX (status, created_at))

newsletter_subscribers(id int PK AI, email varchar(200) NOT NULL UNIQUE,
  created_at datetime NOT NULL)
```

**Deviations from BUILD_SPEC §10 — all additive and deliberate.** §10 lists "key columns", not an exhaustive schema.

- `destinations` gains `blurb`, `image_path`, `image_alt`, `is_featured`, `is_active` to serve Most Visited (6H).
- `tours` gains `summary`, `duration_hours`, `is_featured`, `sort_order`, `badge`, `alert_note`, `historical_trips_count` and three SEO columns (6D, 5A, D8).
- `packages` gains `image_path`, `image_alt`, `highlights`, `sort_order` and three SEO columns.
- `reviews` gains `is_sample` (D1).
- `tour_date_slots`, `bookings`, `payments`, `users`, `sessions`, `vans`, `drivers`, `coupons`, `audit_log` are **out of scope** — Week 3 onward.

---

## API surface

```ts
settings.get()        -> SettingsPayload
destinations.list()   -> Destination[]
tours.list({ destination?: string })  -> TourListItem[]
tours.bySlug({ slug: string })        -> TourDetail        // throws NOT_FOUND
packages.list()       -> PackageListItem[]
reviews.published({ limit?: number; tourId?: number })
                      -> { items: Review[]; displayAggregate: Aggregate | null;
                           realAggregate: Aggregate | null }
inquiries.create(InquiryInput)        -> { ok: true }                            // rate limited
newsletter.subscribe({ email })       -> { ok: true; alreadySubscribed: boolean } // rate limited
```

```ts
type Aggregate = { average: number; count: number };

type SettingsPayload = {
  contentUnverified: boolean;
  siteSeo: { title: string; description: string; ogImage: string | null };
  trust: {
    ratingAverage: number | null;
    ratingCount: number | null;
    guestsServed: number | null;
    dotAccredited: boolean;
    depositPercent: number;
  };
  hero: {
    eyebrow: string;
    headline: string;
    subtitle: string;
    ctaLabel: string;
    imagePath: string;
    imageAlt: string;
  };
  /** null when inactive or outside its Asia/Manila window. Resolved server-side. */
  announcement: { message: string; href: string | null; style: 'info' | 'warning' } | null;
  /** null when inactive or outside its window. */
  promo: { code: string; discountLabel: string; headline: string; body: string } | null;
  openState: { isOpen: boolean; message: string };
  paymentMethods: Array<{ key: string; label: string }>; // enabled only, sorted
  permits: { dot: string | null; dti: string | null; bir: string | null };
  howItWorks: Array<{ step: number; title: string; body: string }>;
  whyBookDirect: Array<{ icon: string; title: string; body: string }>;
  faqs: Array<{ q: string; a: string }>;
  contact: {
    address: string;
    tagline: string;
    hoursNote: string;
    email: string;
    otherServices: { before: string; link: string; after: string };
  };
  legal: {
    privacy: { markdown: string; updatedAt: string };
    terms: { markdown: string; updatedAt: string };
  };
};

type TourListItem = {
  id: number;
  slug: string;
  title: string;
  destination: { id: number; name: string; slug: string };
  image: { path: string; alt: string; width: number | null; height: number | null } | null;
  fromPriceCentavos: number | null; // lowest tier price_per_person
  durationHours: number | null;
  rating: Aggregate | null; // ALL published reviews, samples included (D1)
  bookedThisWeek: number; // 0 until bookings exist (D8)
  tripsRun: number | null; // null until historical_trips_count or bookings exist
  freeCancellation: boolean; // free_cancel_hours != null && > 0
  badge: 'none' | 'best_seller' | 'new' | 'seasonal';
  alertNote: string | null;
  isFeatured: boolean;
};
```

`tours.list` orders by `is_featured DESC, sort_order ASC, id ASC` (6D).
`TourDetail` = `TourListItem` plus `about`, `inclusions`, `exclusions`, `images[]`, `priceTiers[]`, `itinerary[]`, `addons[]`, `maxGuests`, `freeCancelHours`, `seoTitle`, `seoDescription`, `ogImage`.

---

## Testing strategy

Three tiers, so `pnpm test` stays green on a machine with no MySQL:

1. **Pure unit tests** — guard, schedule windows, open/closed, SEO resolvers, meta injection, sitemap, robots, markdown renderer. No DB. Always run.
2. **DB-backed integration tests** — routers against the real `rg_travel` database. Wrapped in a shared `describeWithDb()` helper that probes the connection once and calls `describe.skip` with a printed warning when unreachable (consistent with D3). Each test inserts with a recognisable prefix and deletes its own rows in `afterEach`. **Never truncates a table.**
3. **Client component tests** — jsdom, with `globalThis.fetch` stubbed by `mock-trpc.ts`. No DB, no network.

`server/src/__tests__/helpers/db.ts` exports `describeWithDb` and `withCleanup`.

---

# PHASE 1 — Database & API

Delivers tasks 1A, 1B, 1C, 2A, 2B. At the end the API serves every piece of content the site needs, but the client still renders from `placeholder-data.ts`.

### Task 1.1: Database guard, pool and environment

**Files:**

- Create: `server/src/db/guard.ts`, `server/src/db/client.ts`, `server/scripts/db-preflight.mjs`
- Modify: `server/src/env.ts`, `server/src/index.ts`, `server/package.json`, `.env.example`
- Test: `server/src/__tests__/db-guard.test.ts`

**Interfaces:**

- Produces: `REQUIRED_DATABASE_NAME: 'rg_travel'`; `assertDatabaseName(name: string | null | undefined): void`; `databaseNameFromUrl(url: string): string | null`; `assertConnectedDatabase(): Promise<void>`; `getDb(): MySql2Database<typeof schema>`; `getPool(): Pool`; `closeDb(): Promise<void>`
- Consumed by: every later server task.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/db-guard.test.ts
import { describe, expect, it } from 'vitest';
import { REQUIRED_DATABASE_NAME, assertDatabaseName, databaseNameFromUrl } from '../db/guard';

describe('database name guard', () => {
  it('requires exactly rg_travel', () => {
    expect(REQUIRED_DATABASE_NAME).toBe('rg_travel');
    expect(() => assertDatabaseName('rg_travel')).not.toThrow();
  });

  it.each(['kong_pms', 'mysql', 'rg_travel_backup', 'RG_TRAVEL', '', null, undefined])(
    'aborts on %s',
    (name) => {
      expect(() => assertDatabaseName(name)).toThrow(/rg_travel/);
    },
  );

  it('never leaks the connection string or password in the message', () => {
    const secret = 'mysql://rg_travel:sup3rs3cret@localhost:3306/kong_pms';
    try {
      assertDatabaseName(databaseNameFromUrl(secret));
      throw new Error('should have aborted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('sup3rs3cret');
      expect(message).not.toContain('mysql://');
      expect(message).toContain('kong_pms');
    }
  });

  it('reads the database name out of a URL', () => {
    expect(databaseNameFromUrl('mysql://u:p@localhost:3306/rg_travel')).toBe('rg_travel');
    expect(databaseNameFromUrl('mysql://u:p@localhost:3306/rg_travel?ssl=true')).toBe('rg_travel');
    expect(databaseNameFromUrl('not a url')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && pnpm vitest run src/__tests__/db-guard.test.ts`
Expected: FAIL — `Cannot find module '../db/guard'`.

- [ ] **Step 3: Implement the guard**

```ts
// server/src/db/guard.ts
/**
 * The one database this project may ever touch. Kong PMS shares this MySQL
 * server, so a wrong DATABASE_URL is not a failed query — it is a migration
 * running against someone else's production data. Every entry point (server
 * boot, seed, migrate) asserts through here before issuing a statement.
 *
 * Messages name the OFFENDING DATABASE and nothing else: never the URL, never
 * the user, never the password (CLAUDE.md security rules).
 */
export const REQUIRED_DATABASE_NAME = 'rg_travel';

export function databaseNameFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

export function assertDatabaseName(name: string | null | undefined): void {
  if (name === REQUIRED_DATABASE_NAME) return;
  throw new Error(
    `Refusing to run against database ${name ? `"${name}"` : '(none)'}. ` +
      `This project may only touch "${REQUIRED_DATABASE_NAME}". ` +
      `Check DB_NAME in .env — Kong PMS shares this MySQL server.`,
  );
}
```

`assertConnectedDatabase()` runs `SELECT DATABASE() AS db` through the pool and passes the result to `assertDatabaseName` — so a URL that _claims_ `rg_travel` but resolves elsewhere is still caught.

- [ ] **Step 4: Implement the pool**

`server/src/db/client.ts`: lazy singleton, `mysql.createPool({ uri: env.DATABASE_URL, timezone: 'Z', connectionLimit: 10, supportBigNumbers: true })`, then `drizzle(pool, { schema, mode: 'default' })`. Importing the module must not connect — only `getDb()` does.

- [ ] **Step 5: Wire env and boot**

In `server/src/env.ts`: make `DATABASE_URL` required (`z.string().min(1)`), and add
`SITE_ENV: z.enum(['development', 'preview', 'production']).default('development')`.
On a validation failure the existing handler prints `z.treeifyError` — confirm it prints **keys only, never values**, and fix it if not.

In `server/src/index.ts`, before `listen`:

```ts
try {
  assertDatabaseName(databaseNameFromUrl(env.DATABASE_URL));
  await assertConnectedDatabase();
} catch (error) {
  console.error(`\n[rg-travel-tours] Database check failed.\n  ${(error as Error).message}\n`);
  process.exit(1);
}
```

An unreachable MySQL must produce `Cannot reach MySQL at localhost:3306 — is the service running?` with **no credentials in the text**.

- [ ] **Step 6: Migration preflight**

`server/scripts/db-preflight.mjs` reads `DATABASE_URL` via dotenv, applies the same name check, and exits 1 with the same style of message. Then in `server/package.json`:

```json
"db:migrate": "node scripts/db-preflight.mjs && drizzle-kit migrate",
"db:push":    "node scripts/db-preflight.mjs && drizzle-kit push",
"db:seed":    "node scripts/db-preflight.mjs && tsx src/db/seed.ts"
```

Also update `server/drizzle.config.ts` to drop its `?? 'mysql://root@localhost:3306/rg_travel'` fallback — **a root fallback must not exist in this repo.** Throw if `DATABASE_URL` is unset.

- [ ] **Step 7: Add SITE_ENV to `.env.example`**

```
# development | preview | production. Controls robots.txt and X-Robots-Tag (task 5D).
SITE_ENV=development
```

- [ ] **Step 8: Run tests and the full chain**

Run: `cd server && pnpm vitest run src/__tests__/db-guard.test.ts` → PASS.
Then from the repo root: `pnpm lint && pnpm typecheck && pnpm test`.

- [ ] **Step 9: Commit**

```bash
git add server/src/db server/scripts server/src/env.ts server/src/index.ts \
        server/drizzle.config.ts server/package.json .env.example \
        server/src/__tests__/db-guard.test.ts
git commit -m "feat(db): refuse any database but rg_travel, at boot and before every migration"
```

**✅ DONE 1.1** (covers task 1A)

---

### Task 1.2: Drizzle schema and first migration

**Files:**

- Create: `server/src/db/schema.ts`, `server/src/db/migrations/*`
- Test: `server/src/__tests__/schema.test.ts`

**Interfaces:**

- Produces: table objects `settings`, `destinations`, `tours`, `tourImages`, `tourPriceTiers`, `tourItineraryStops`, `tourAddons`, `tourBlockedDates`, `packages`, `reviews`, `inquiries`, `newsletterSubscribers`, exported from `server/src/db/schema.ts`, matching the **Database schema** section above exactly.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/schema.test.ts
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema';

const EXPECTED_TABLES = [
  'settings',
  'destinations',
  'tours',
  'tourImages',
  'tourPriceTiers',
  'tourItineraryStops',
  'tourAddons',
  'tourBlockedDates',
  'packages',
  'reviews',
  'inquiries',
  'newsletterSubscribers',
];

describe('public content schema', () => {
  it('exports every public content table and no booking tables yet', () => {
    for (const name of EXPECTED_TABLES) expect(schema).toHaveProperty(name);
    expect(schema).not.toHaveProperty('bookings');
    expect(schema).not.toHaveProperty('payments');
  });

  it('keeps money columns integral', () => {
    // price_per_person, new_price, old_price and addon price are centavos.
    expect(schema.tourPriceTiers.pricePerPerson.dataType).toBe('number');
    expect(schema.packages.newPrice.dataType).toBe('number');
  });

  it('carries the columns the public site depends on', () => {
    expect(schema.reviews.isSample).toBeDefined();
    expect(schema.tours.historicalTripsCount).toBeDefined();
    expect(schema.tours.badge).toBeDefined();
    expect(schema.tours.seoTitle).toBeDefined();
    expect(schema.packages.seoTitle).toBeDefined();
    expect(schema.destinations.blurb).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && pnpm vitest run src/__tests__/schema.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the schema**

Transcribe the **Database schema** section into `drizzle-orm/mysql-core` builders. Conventions: `mysqlTable`, `int().autoincrement().primaryKey()`, `varchar({ length: n })`, `boolean()`, `datetime({ mode: 'date' })`, `mysqlEnum`, `json()`. Timestamps default via `.$defaultFn(() => new Date())` and `updated_at` via `.$onUpdateFn(() => new Date())` so UTC is produced in JS, not by MySQL's `SYSTEM` timezone.

- [ ] **Step 4: Generate and apply the migration**

```bash
cd server
pnpm db:generate          # writes src/db/migrations/0000_*.sql
pnpm db:migrate           # preflight asserts rg_travel, then applies
```

Read the generated SQL before applying it. Confirm it contains **only** `CREATE TABLE` for the twelve tables above — no `DROP`, and nothing naming another database.

- [ ] **Step 5: Verify against the live database**

```bash
cd server && node -e "require('dotenv').config({path:'../.env',quiet:true});const m=require('mysql2/promise');(async()=>{const c=await m.createConnection(process.env.DATABASE_URL);const [t]=await c.query('SHOW TABLES');console.log(t.length,'tables');await c.end();})()"
```

Expected: `13 tables` (twelve plus drizzle's `__drizzle_migrations`).

- [ ] **Step 6: Run tests, then commit**

```bash
git add server/src/db/schema.ts server/src/db/migrations server/src/__tests__/schema.test.ts
git commit -m "feat(db): public content schema and first migration"
```

**✅ DONE 1.2** (covers task 1B)

---

### Task 1.3: Settings schemas and reader

**Files:**

- Create: `server/src/content/settings-schema.ts`, `server/src/content/settings.ts`
- Test: `server/src/__tests__/settings-schema.test.ts`

**Interfaces:**

- Produces: `SETTING_SCHEMAS` (a `Record<SettingKey, ZodType>`), `SettingKey`, `SettingsPayload`, `readSettings(): Promise<SettingsPayload>`, `readRawSettings(): Promise<Record<string, unknown>>`
- Consumes: `getDb()` from 1.1, `settings` from 1.2.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/settings-schema.test.ts
import { describe, expect, it } from 'vitest';
import { SETTING_SCHEMAS } from '../content/settings-schema';

describe('settings schemas', () => {
  it('rejects business hours that are not exactly seven days', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      weekday: i,
      opensAt: '07:00',
      closesAt: '21:00',
      isClosed: false,
    }));
    expect(SETTING_SCHEMAS.business_hours.safeParse(six).success).toBe(false);
  });

  it('rejects a malformed clock time', () => {
    const bad = Array.from({ length: 7 }, (_, i) => ({
      weekday: i,
      opensAt: '7am',
      closesAt: '21:00',
      isClosed: false,
    }));
    expect(SETTING_SCHEMAS.business_hours.safeParse(bad).success).toBe(false);
  });

  it('only allows info and warning announcement styles — never an error/red style', () => {
    const base = { message: 'x', href: null, startsAt: null, endsAt: null, isActive: true };
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'info' }).success).toBe(true);
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'warning' }).success).toBe(
      true,
    );
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'error' }).success).toBe(false);
    expect(SETTING_SCHEMAS.announcement.safeParse({ ...base, style: 'danger' }).success).toBe(
      false,
    );
  });

  it('permits may be null but never an empty string pretending to be a number', () => {
    expect(SETTING_SCHEMAS.permits.safeParse({ dot: null, dti: null, bir: null }).success).toBe(
      true,
    );
    expect(SETTING_SCHEMAS.permits.safeParse({ dot: '', dti: null, bir: null }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: module not found.

- [ ] **Step 3: Implement the schemas**

One Zod schema per key from the **Settings keys** table. Notes that matter:

- `business_hours`: `.length(7)` and `/^([01]\d|2[0-3]):[0-5]\d$/` for the clock strings.
- `announcement.style`: `z.enum(['info', 'warning'])` — there is no red style and never will be.
- `permits`: each field `z.string().min(1).nullable()` so `''` is rejected; an empty permit is `null`, which renders `— pending —`.
- `startsAt`/`endsAt`: `z.string().datetime().nullable()`.

- [ ] **Step 4: Implement `readSettings()`**

Select all rows, parse each through its schema, and **throw on a malformed value** naming the key (not the value). Missing keys throw too — the seed is responsible for completeness, and a silent default would mask a failed seed. Shape the result into `SettingsPayload`; `announcement`, `promo` and `openState` are resolved in Task 1.5, so for now return the raw blocks and leave the resolution to that task.

- [ ] **Step 5: Run tests, then commit**

```bash
git add server/src/content server/src/__tests__/settings-schema.test.ts
git commit -m "feat(content): typed settings schemas with a loud failure on malformed values"
```

**✅ DONE 1.3**

---

### Task 1.4: Seed today's content

**Files:**

- Create: `server/src/db/seed.ts`, `server/src/db/seed-data.ts`
- Test: `server/src/__tests__/seed-parity.test.ts`

**Interfaces:**

- Produces: `SEED_SETTINGS`, `SEED_DESTINATIONS`, `SEED_TOURS`, `SEED_PACKAGES`, `SEED_REVIEWS` from `seed-data.ts`; `seed(): Promise<void>` from `seed.ts`.

Every value comes from today's `client/src/lib/placeholder-data.ts` and `client/src/lib/site.ts`, verbatim, so the rendered page does not change (D9).

- [ ] **Step 1: Write the failing parity test**

This is the test that enforces D10 — the seeded contact block must never drift from `site.ts`, which the untouched `check-contact-parity.mjs` still guards against `coming-soon/index.html`.

```ts
// server/src/__tests__/seed-parity.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEED_SETTINGS } from '../db/seed-data';

const siteTs = readFileSync(join(process.cwd(), '../client/src/lib/site.ts'), 'utf8');

/** Same regex approach scripts/check-contact-parity.mjs uses, so the three
 *  surfaces (site.ts, coming-soon, seed) can never disagree. */
function firstQuoted(key: string): string {
  const m = new RegExp(`${key}:\\s*'([^']*)'`).exec(siteTs);
  if (!m) throw new Error(`site.ts no longer declares ${key}`);
  return m[1];
}

describe('seeded contact settings mirror site.ts', () => {
  const contact = SEED_SETTINGS.contact;

  it('matches the WhatsApp number', () => {
    expect(contact.whatsapp).toBe(firstQuoted('whatsapp'));
  });

  it('matches the Facebook URL and motto', () => {
    expect(contact.facebook).toBe(firstQuoted('facebook'));
    expect(contact.motto).toBe(firstQuoted('motto'));
  });

  it('matches both displayed numbers', () => {
    const displays = [...siteTs.matchAll(/display:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(contact.phoneDisplay).toBe(displays[0]);
    expect(contact.altPhoneDisplay).toBe(displays[1]);
  });

  it('matches the other-services sentence, part for part', () => {
    const parts = /otherServices:\s*{([\s\S]*?)}/.exec(siteTs)?.[1] ?? '';
    const [before, link, after] = [...parts.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(contact.otherServices).toEqual({ before, link, after });
  });
});

describe('seeded content honours the no-fake-numbers rule', () => {
  it('leaves every permit number empty', () => {
    expect(SEED_SETTINGS.permits).toEqual({ dot: null, dti: null, bir: null });
  });

  it('flags the content as unverified', () => {
    expect(SEED_SETTINGS.content_unverified).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: module not found.

- [ ] **Step 3: Write `seed-data.ts`**

Transcribe, verbatim:

- `DESTINATIONS` → six rows, with `blurb` / `image_path` / `image_alt` taken from today's `MOST_VISITED` (matching on slug; `badian-kawasan` is named "Kawasan Falls" in Most Visited but "Badian / Kawasan" as a destination — keep **both**: `name` from `DESTINATIONS`, and add the Most Visited display name as the blurb's heading is not needed, so store `name` as-is and let the UI render it. Confirm the rendered Most Visited labels are unchanged; if they differ, add a `display_name` column rather than changing copy).
- `TOURS` → six rows. `fromPriceCentavos` becomes the **lowest** `tour_price_tiers` row, not a column. Generate three tiers per tour so the lowest equals today's figure exactly: `(1-2, price+40000)`, `(3-6, price)`, `(7-12, price-20000)` — **lowest must equal today's `fromPriceCentavos`**, so instead use `(1-2, price)`, `(3-6, price)`, `(7-12, price)` if any adjustment would change the displayed "from" figure. The displayed number must not move.
- `historical_trips_count`: **NULL** for every tour (D8).
- `PACKAGES` → three rows with `highlights` JSON.
- `REVIEWS` → six rows, all `status: 'published'`, all `is_sample: true` (D1), `tour_id` matched by title.
- `SEED_SETTINGS` → every key in the **Settings keys** table, from `PLACEHOLDER_SETTINGS`, `FAQS`, `HOW_IT_WORKS`, `WHY_BOOK_DIRECT`, `SITE`.
- `legal_privacy` / `legal_terms` → placeholder markdown, each opening with `> **TODO: client legal review.** This text is a placeholder and is not legal advice.`

- [ ] **Step 4: Write `seed.ts`**

Idempotent: `assertDatabaseName` + `assertConnectedDatabase` first, then upsert by natural key (`slug`, settings `key`, review natural key `name + tour_id`). Re-running must not duplicate rows. Print a one-line summary per table. **Never print `DATABASE_URL`.**

- [ ] **Step 5: Run it**

```bash
cd server && pnpm db:seed
```

Expected: a per-table summary, and a second run reporting the same counts with no duplicates.

- [ ] **Step 6: Run tests, then commit**

```bash
git add server/src/db/seed.ts server/src/db/seed-data.ts server/src/__tests__/seed-parity.test.ts
git commit -m "feat(db): seed today's content, with a test pinning contact values to site.ts"
```

**✅ DONE 1.4** (covers task 1C)

---

### Task 1.4b: Test database isolation (`rg_travel_test`)

**Added 2026-10-09 at the user's instruction, after Task 1.4.** Supersedes the snapshot/restore approach introduced in Task 1.3's fix round.

**Files:**

- Modify: `server/src/db/guard.ts`, `server/src/db/client.ts`, `server/src/env.ts`, `server/scripts/db-preflight.mjs`, `server/vitest.config.ts`, `.env.example`, `server/package.json`
- Create: `server/src/__tests__/helpers/test-db.ts`, `server/src/__tests__/global-setup.ts`
- Modify: every DB-backed test file
- Delete: `snapshotRows` from `server/src/__tests__/helpers/db.ts` once nothing imports it

**Why:** tests were running against the live `rg_travel` database. That is the same database the dev server and the seed use, so a test could corrupt real content, and test fixtures collided with seeded rows on primary keys. A dedicated `rg_travel_test` database removes both problems and lets suites truncate freely.

**Interfaces:**

- `REQUIRED_DATABASE_NAME` becomes context-aware: `assertDatabaseName(name, context)` where `context` is `'app' | 'test'`. `'app'` accepts only `rg_travel`; `'test'` accepts only `rg_travel_test`. **Neither context ever accepts the other's database.**
- `TEST_DATABASE_URL` in `.env` / `.env.example`, same `rg_travel` user, database `rg_travel_test`.
- `getDb()` / `getPool()` select their URL from the context: `TEST_DATABASE_URL` when `process.env.VITEST` is set, `DATABASE_URL` otherwise.
- `resetTestDb(): Promise<void>` in `helpers/test-db.ts` — truncates every content table and re-applies the seed, leaving each suite a canonical baseline.

- [ ] **Step 1: Write the failing guard tests**

```ts
describe('context-aware database guard', () => {
  it('app context accepts only rg_travel', () => {
    expect(() => assertDatabaseName('rg_travel', 'app')).not.toThrow();
    expect(() => assertDatabaseName('rg_travel_test', 'app')).toThrow(/rg_travel/);
  });

  it('test context accepts only rg_travel_test', () => {
    expect(() => assertDatabaseName('rg_travel_test', 'test')).not.toThrow();
    expect(() => assertDatabaseName('rg_travel', 'test')).toThrow(/rg_travel_test/);
  });

  it.each(['kong_pms', 'mysql', '', null, undefined])('rejects %s in both contexts', (name) => {
    expect(() => assertDatabaseName(name, 'app')).toThrow();
    expect(() => assertDatabaseName(name, 'test')).toThrow();
  });

  it('still never leaks a connection string or password', () => {
    try {
      assertDatabaseName(databaseNameFromUrl('mysql://u:s3cret@h/kong_pms'), 'app');
    } catch (error) {
      expect((error as Error).message).not.toContain('s3cret');
      expect((error as Error).message).not.toContain('mysql://');
    }
  });
});
```

Note the asymmetry the second case protects: a test run must **fail loudly** if pointed at `rg_travel`, which is the whole point of this task.

- [ ] **Step 2: Write the failing isolation test**

```ts
it('the test suite is connected to rg_travel_test, never rg_travel', async () => {
  const [[row]] = await getPool().query('SELECT DATABASE() AS db');
  expect((row as { db: string }).db).toBe('rg_travel_test');
});
```

- [ ] **Step 3: Implement the context-aware guard and URL selection.** Keep `guard.ts` free of top-level imports (Task 1.1's property) and keep every message free of credentials.

- [ ] **Step 4: Global setup.** `server/src/__tests__/global-setup.ts`, wired via `globalSetup` in `server/vitest.config.ts`: assert the connected database is `rg_travel_test`, run migrations against it, seed it once. Migrations must run against the test database, not `rg_travel`.

- [ ] **Step 5: `resetTestDb()`.** Truncate all content tables and re-seed. `tours.destination_id` has a foreign key, so either truncate in dependency order or wrap in `SET FOREIGN_KEY_CHECKS = 0/1`. Prefer explicit ordering; if using the FK toggle, restore it in a `finally`.

- [ ] **Step 6: Repoint every DB-backed test** to the new baseline, calling `resetTestDb()` where a suite needs a clean slate.

- [ ] **Step 7: Delete `snapshotRows`** from `helpers/db.ts` and confirm nothing imports it (`grep -rn snapshotRows server/src`). Its reason for existing is gone.

- [ ] **Step 8: Verify the negative case by hand.** Temporarily point `TEST_DATABASE_URL` at `rg_travel` in a throwaway shell env (never edit `.env`) and confirm the suite **aborts** rather than running. Report the actual output.

- [ ] **Step 9:** Full chain, then commit.

**✅ DONE 1.4b**

---

### Task 1.5: Date-window, opening-hours and rating services

**Files:**

- Create: `server/src/services/schedule.ts`, `server/src/services/hours.ts`, `server/src/services/ratings.ts`, `shared/src/time.ts`
- Test: `server/src/__tests__/schedule.test.ts`, `server/src/__tests__/hours.test.ts`

**Interfaces:**

- Produces: `isWithinWindow(startsAt: string | null, endsAt: string | null, now: Date): boolean`; `resolveOpenState(hours: BusinessHours, now: Date): { isOpen: boolean; message: string }`; `displayAggregate(tourId?: number): Promise<Aggregate | null>`; `realAggregate(tourId?: number): Promise<Aggregate | null>`

- [ ] **Step 1: Write the failing tests — these are the 8A Manila edge cases**

```ts
// server/src/__tests__/schedule.test.ts
import { describe, expect, it } from 'vitest';
import { isWithinWindow } from '../services/schedule';

// Manila is UTC+8 with no DST. Midnight on 2 Oct 2026 in Manila is
// 2026-10-01T16:00:00Z — the window must open exactly then, not at 00:00 UTC.
const MANILA_MIDNIGHT_OCT_2 = '2026-10-01T16:00:00.000Z';
const MANILA_END_OCT_5 = '2026-10-05T15:59:59.000Z';

describe('promo and announcement windows', () => {
  it('is closed one second before Manila midnight', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-01T15:59:59.000Z')),
    ).toBe(false);
  });

  it('opens exactly at Manila midnight', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-01T16:00:00.000Z')),
    ).toBe(true);
  });

  it('is still open at the last second of the final Manila day', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-05T15:59:59.000Z')),
    ).toBe(true);
  });

  it('closes once the window has passed', () => {
    expect(
      isWithinWindow(MANILA_MIDNIGHT_OCT_2, MANILA_END_OCT_5, new Date('2026-10-05T16:00:00.000Z')),
    ).toBe(false);
  });

  it('treats a null bound as open-ended', () => {
    expect(isWithinWindow(null, null, new Date())).toBe(true);
    expect(isWithinWindow(null, MANILA_END_OCT_5, new Date('2020-01-01T00:00:00Z'))).toBe(true);
    expect(isWithinWindow(MANILA_MIDNIGHT_OCT_2, null, new Date('2030-01-01T00:00:00Z'))).toBe(
      true,
    );
  });
});
```

```ts
// server/src/__tests__/hours.test.ts
import { describe, expect, it } from 'vitest';
import { resolveOpenState } from '../services/hours';

const OPEN_7_TO_9 = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  opensAt: '07:00',
  closesAt: '21:00',
  isClosed: false,
}));

describe('open/closed state in Asia/Manila', () => {
  it('is open at 10:00 Manila (02:00 UTC)', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-09T02:00:00.000Z'));
    expect(state.isOpen).toBe(true);
    expect(state.message).toBe('Open now — we reply within minutes');
  });

  it('is closed at 06:00 Manila and names the opening time', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-08T22:00:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });

  it('is closed just after 21:00 Manila and points at tomorrow', () => {
    const state = resolveOpenState(OPEN_7_TO_9, new Date('2026-10-09T13:01:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });

  it('skips a fully closed day when naming the next opening', () => {
    const closedSunday = OPEN_7_TO_9.map((d) =>
      d.weekday === 0 ? { ...d, isClosed: true, opensAt: null, closesAt: null } : d,
    );
    // Saturday 22:00 Manila = Saturday 14:00 UTC. Next open is Monday 7:00 AM.
    const state = resolveOpenState(closedSunday, new Date('2026-10-10T14:00:00.000Z'));
    expect(state.isOpen).toBe(false);
    expect(state.message).toBe("Closed — we'll reply by 7:00 AM");
  });
});
```

- [ ] **Step 2: Run both and watch them fail.**

- [ ] **Step 3: Implement**

`shared/src/time.ts` exports `manilaParts(date)` using `Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', ... }).formatToParts` — **no manual offset arithmetic**, so the implementation stays correct if the Philippines ever adopts DST.

`isWithinWindow` compares instants: `(!startsAt || now >= new Date(startsAt)) && (!endsAt || now <= new Date(endsAt))`.

`resolveOpenState` reads the Manila weekday and `HH:MM`, finds that day's row, and returns the exact two strings asserted above. Message wording comes straight from task 6E.

`ratings.ts` — two queries over `reviews`, both `status = 'published'`, the real one adding `is_sample = 0`. Both `GROUP BY tour_id` (mind `ONLY_FULL_GROUP_BY`). Return `null`, never `{ average: 0, count: 0 }`, when there are no rows — a zero average would render as a zero-star rating.

- [ ] **Step 4: Run tests → PASS. Commit.**

```bash
git add server/src/services shared/src/time.ts server/src/__tests__/schedule.test.ts server/src/__tests__/hours.test.ts
git commit -m "feat(content): Manila-correct promo windows, opening hours and rating aggregates"
```

**✅ DONE 1.5**

---

### Task 1.6: Public tRPC queries

**Files:**

- Create: `server/src/routers/public/{settings,destinations,tours,packages,reviews}.ts`, `server/src/__tests__/helpers/db.ts`
- Modify: `server/src/routers/_app.ts`
- Test: `server/src/__tests__/public-queries.test.ts`

**Interfaces:**

- Produces the read half of the **API surface** section, verbatim.
- Consumes: `getDb()`, schema, `readSettings()`, the three services.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/public-queries.test.ts
import { beforeAll, expect, it } from 'vitest';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';

const caller = appRouter.createCaller({});

describeWithDb('public queries', () => {
  it('settings.get returns a complete, typed payload', async () => {
    const s = await caller.settings.get();
    expect(s.trust.depositPercent).toBe(30);
    expect(s.faqs.length).toBeGreaterThan(0);
    expect(s.permits).toEqual({ dot: null, dti: null, bir: null });
    expect(s.paymentMethods.every((m) => typeof m.label === 'string')).toBe(true);
    expect(typeof s.openState.isOpen).toBe('boolean');
  });

  it('tours.list returns a lowest-tier price and orders featured first', async () => {
    const tours = await caller.tours.list({});
    expect(tours.length).toBe(6);
    for (const t of tours) {
      expect(Number.isInteger(t.fromPriceCentavos)).toBe(true);
      expect(t.bookedThisWeek).toBe(0); // no bookings table yet (D8)
      expect(t.tripsRun).toBeNull(); // historical count seeded NULL
    }
    const featuredFirst = [...tours].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));
    expect(tours.map((t) => t.id)).toEqual(featuredFirst.map((t) => t.id));
  });

  it('tours.list filters by destination slug', async () => {
    const oslob = await caller.tours.list({ destination: 'oslob' });
    expect(oslob.length).toBeGreaterThan(0);
    expect(oslob.every((t) => t.destination.slug === 'oslob')).toBe(true);
  });

  it('tours.bySlug throws NOT_FOUND for an unknown slug', async () => {
    await expect(caller.tours.bySlug({ slug: 'no-such-tour' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('reviews.published separates the display and real aggregates', async () => {
    const r = await caller.reviews.published({});
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.isSample)).toBe(true);
    expect(r.displayAggregate).not.toBeNull(); // samples count for display (D1)
    expect(r.realAggregate).toBeNull(); // and never for structured data
  });

  it('packages.list returns active packages with integer centavos', async () => {
    const p = await caller.packages.list();
    expect(p.length).toBe(3);
    expect(p.every((x) => Number.isInteger(x.newPriceCentavos))).toBe(true);
  });
});
```

- [ ] **Step 2: Write `helpers/db.ts` first**

```ts
// server/src/__tests__/helpers/db.ts
import { describe } from 'vitest';
import { getPool } from '../../db/client';

let reachable: boolean | null = null;

async function probe(): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    await getPool().query('SELECT 1');
    reachable = true;
  } catch {
    console.warn(
      '\n[tests] MySQL is unreachable — skipping DB-backed suites. ' +
        'Start MySQL and re-run to exercise them.\n',
    );
    reachable = false;
  }
  return reachable;
}

export function describeWithDb(name: string, fn: () => void) {
  describe(name, async () => {
    if (!(await probe())) return describe.skip(name, fn);
    fn();
  });
}
```

- [ ] **Step 3: Run the test and watch it fail.**

- [ ] **Step 4: Implement the routers**

- `tours.list`: one query joining `tours` → `destinations`, left-joining the lowest `tour_price_tiers` row (`MIN(price_per_person)`, grouped by every selected tours/destinations column — `ONLY_FULL_GROUP_BY`), plus the first `tour_images` row by `sort_order`. Ratings come from `displayAggregate()` in one batched query keyed by `tour_id`, not N+1.
- `bookedThisWeek` is a literal `0` and `tripsRun` is `historical_trips_count` (so, NULL) until the bookings table exists. Leave a comment naming Week 3.
- `tours.bySlug`: `TRPCError({ code: 'NOT_FOUND' })` when missing or `is_active = false`.
- `reviews.published`: `status = 'published'`, newest first, `limit` default 6 max 50.
- Every input validated with Zod from `shared/src/schemas/public.ts`.

- [ ] **Step 5: Run tests → PASS. Run the full chain. Commit.**

```bash
git add server/src/routers server/src/__tests__
git commit -m "feat(api): public read queries for settings, destinations, tours, packages and reviews"
```

**✅ DONE 1.6** (covers task 2A)

---

### Task 1.7: Rate-limited public mutations

**Files:**

- Create: `server/src/routers/public/{inquiries,newsletter}.ts`, `server/src/middleware/rate-limit.ts`, `shared/src/schemas/public.ts`
- Modify: `server/src/app.ts`, `server/package.json`
- Test: `server/src/__tests__/public-mutations.test.ts`, `server/src/__tests__/rate-limit.test.ts`

**Interfaces:**

- Produces: `createProcedureRateLimit(procedures: string[], opts: { windowMs: number; max: number }): RequestHandler`; `inquiryInput`, `newsletterInput` Zod schemas.

- [ ] **Step 1: Install the one new server dependency**

```bash
cd server && pnpm add express-rate-limit
```

- [ ] **Step 2: Write the failing tests**

```ts
// server/src/__tests__/rate-limit.test.ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProcedureRateLimit } from '../middleware/rate-limit';

function appWith(max: number) {
  const app = express();
  app.use(createProcedureRateLimit(['inquiries.create'], { windowMs: 60_000, max }));
  app.all('/trpc/*splat', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('procedure-scoped rate limiting', () => {
  it('limits the named procedure', async () => {
    const app = appWith(2);
    await request(app).post('/trpc/inquiries.create').expect(200);
    await request(app).post('/trpc/inquiries.create').expect(200);
    await request(app).post('/trpc/inquiries.create').expect(429);
  });

  it('leaves unlisted procedures alone', async () => {
    const app = appWith(1);
    await request(app).post('/trpc/tours.list').expect(200);
    await request(app).post('/trpc/tours.list').expect(200);
    await request(app).post('/trpc/tours.list').expect(200);
  });

  it('still limits a batched call that includes the named procedure', async () => {
    const app = appWith(1);
    await request(app).post('/trpc/tours.list,inquiries.create').expect(200);
    await request(app).post('/trpc/tours.list,inquiries.create').expect(429);
  });
});
```

```ts
// server/src/__tests__/public-mutations.test.ts
import { afterEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';
import { getDb } from '../db/client';
import { inquiries, newsletterSubscribers } from '../db/schema';

const caller = appRouter.createCaller({});
const MARK = 'vitest+';

describeWithDb('public mutations', () => {
  afterEach(async () => {
    const db = getDb();
    await db.delete(inquiries).where(like(inquiries.email, `${MARK}%`));
    await db.delete(newsletterSubscribers).where(like(newsletterSubscribers.email, `${MARK}%`));
  });

  it('rejects a malformed email', async () => {
    await expect(
      caller.inquiries.create({
        type: 'contact',
        name: 'A',
        email: 'not-an-email',
        message: 'hello there',
        consent: true,
      }),
    ).rejects.toThrow();
  });

  it('rejects a missing consent checkbox (RA 10173)', async () => {
    await expect(
      caller.inquiries.create({
        type: 'contact',
        name: 'A',
        email: `${MARK}a@example.com`,
        message: 'hello there',
        consent: false,
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty message and an over-long one', async () => {
    const base = {
      type: 'contact' as const,
      name: 'A',
      email: `${MARK}a@example.com`,
      consent: true,
    };
    await expect(caller.inquiries.create({ ...base, message: '' })).rejects.toThrow();
    await expect(caller.inquiries.create({ ...base, message: 'x'.repeat(5001) })).rejects.toThrow();
  });

  it('stores a valid inquiry as new', async () => {
    await caller.inquiries.create({
      type: 'contact',
      name: 'Vitest',
      email: `${MARK}ok@example.com`,
      message: 'A valid enquiry.',
      consent: true,
    });
    const rows = await getDb()
      .select()
      .from(inquiries)
      .where(eq(inquiries.email, `${MARK}ok@example.com`));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('new');
  });

  it('treats a duplicate newsletter signup as success, not an error', async () => {
    const email = `${MARK}dupe@example.com`;
    const first = await caller.newsletter.subscribe({ email });
    const second = await caller.newsletter.subscribe({ email });
    expect(first.alreadySubscribed).toBe(false);
    expect(second.alreadySubscribed).toBe(true);
    const rows = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run both and watch them fail.**

- [ ] **Step 4: Implement**

`createProcedureRateLimit` wraps `express-rate-limit` with
`skip: (req) => !req.path.replace(/^\/trpc\//, '').split(',').some((p) => procedures.includes(p))`.
Mount in `app.ts` **before** the tRPC middleware:

```ts
app.use(
  '/trpc',
  createProcedureRateLimit(['inquiries.create', 'newsletter.subscribe'], {
    windowMs: 15 * 60_000,
    max: 5,
  }),
);
```

`inquiryInput`: `type` enum, optional `packageId`, `name` 1–160, `email` `z.email()`, optional `phone` ≤40, `message` 1–5000, `consent: z.literal(true)` (RA 10173 — a `false` consent must fail validation, not be stored).
`newsletter.subscribe`: insert, catch `ER_DUP_ENTRY`, return `alreadySubscribed: true`. Never reveal whether an address was already on the list beyond that flag.

- [ ] **Step 5: Run tests → PASS. Full chain. Commit.**

```bash
git add server shared/src/schemas
git commit -m "feat(api): rate-limited inquiry and newsletter mutations with server-side validation"
```

**✅ DONE 1.7** (covers task 2B)

---

### Task 1.8: Phase 1 verification and push

- [ ] **Step 1: Run all five, in order, from the repo root**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
ALLOW_PLACEHOLDER_BUILD=1 pnpm build
```

- [ ] **Step 2: Confirm the site is visually unchanged.** The client still reads `placeholder-data.ts`; nothing should look different yet.

- [ ] **Step 3: Push**

```bash
git push origin main
```

**✅ PHASE 1 COMPLETE**

---

### Task 1.9: Phase 1 rulings (rating threshold, approved copy, deploy notes)

**Added 2026-10-10 at the user's instruction**, resolving the three open items Phase 1 surfaced.

**Files:**

- Modify: `server/src/content/settings-schema.ts`, `server/src/db/seed-data.ts`, `server/src/routers/public/tours.ts`, `server/src/services/hours.ts`, `docs/LAUNCH_CHECKLIST.md`
- Test: `server/src/__tests__/public-queries.test.ts`, `server/src/__tests__/settings-schema.test.ts`

#### R1 — Rating display threshold

Phase 1 established that tour-card ratings would drop from the invented `4.9 (68)` to a real `5.0 (1)`, because the seed holds six sample reviews, one per tour. The user's ruling: **do not show a rating at all below a threshold.**

- A tour shows stars + count **only when it has 3 or more published reviews** — sample or real, i.e. the same population `displayAggregate` already counts.
- Below the threshold it shows a small **"New"** badge instead.
- The threshold lives in settings, not in code.
- **The JSON-LD `AggregateRating` rule is unchanged**: still built from `realAggregate` (published AND `is_sample = 0`), still omitted entirely when null. The threshold is a _display_ rule and must not leak into structured data.

Implementation:

- Add `minReviewsForRating: z.number().int().min(1)` to the **existing `trust` settings block**, seeded to `3`. (It sits with `ratingAverage`/`ratingCount` rather than in a sixteenth key — it is social-proof display policy, and every settings key must exist or `readSettings()` throws, so a new key costs schema + seed + fixtures for no gain.)
- In `tours.list` **and** `tours.bySlug`, return `rating: null` when the display count is below the threshold. Do not invent a separate flag: `rating === null` is the single signal, and the card renders "New" from it. That keeps "no reviews at all" and "too few reviews" rendering identically, which is the intent.
- Do **not** reuse the existing `badge` column's `'new'` value. That is admin-controlled per tour (6D) and would be overwritten by, or silently conflict with, a derived value.

Tests: a tour with 2 published reviews reports `rating: null`; with 3 it reports the aggregate; the threshold is read from settings rather than hardcoded (change it to 4 in a fixture and the 3-review tour goes null); and `realAggregate` is untouched by the threshold.

#### R2 — Approved copy

The all-week-closed fallback **`'Closed — we will reply as soon as we reopen'` is approved by the client.** Remove the "pending client sign-off" comment in `server/src/services/hours.ts` and replace it with a note that the wording is approved, so no one re-opens the question.

The **`24`-hour cancellation window stays a TODO** pending client confirmation. Leave the value and its comment as they are — it renders nowhere today, only the derived boolean does.

#### R3 — Deployment requirements

Add a **"Deployment requirements"** section to `docs/LAUNCH_CHECKLIST.md` recording what Phase 1 learned. These are prerequisites, not suggestions — each one silently breaks a security control if missed:

- **`trust proxy` must be set** behind nginx. The rate limiter keys on IP; without it Express sees the proxy's address and the whole limit applies to every visitor collectively — one person exhausts it for everyone.
- **`NODE_ENV=production` must be set.** tRPC's default error formatter includes `stack` when it is not, so a malformed request returns a stack trace to the caller.
- **PM2 must run a single instance (fork mode), not cluster mode.** `express-rate-limit`'s default `MemoryStore` is per-process, so N workers multiply the effective limit by N. If cluster mode is ever needed, the limiter needs a shared store first.

**✅ DONE 1.9**

---

# PHASE 2 — Client data layer and catalog

Delivers 3A, 3B and 6J. At the end the catalog, packages, reviews, hero and trust bar all render from the API. `placeholder-data.ts` still exists but only the content blocks of Phase 3 still import it.

**The acceptance bar for every task in this phase:** take a screenshot before and after. Apart from the two hidden booking counters (Task 2.3), the rendered page must be indistinguishable.

### Task 2.1: tRPC + TanStack Query wiring and the test harness

**Files:**

- Create: `client/src/lib/query-client.ts`, `client/src/__tests__/helpers/mock-trpc.ts`
- Modify: `client/src/lib/trpc.ts`, `client/src/main.tsx`, `client/package.json`
- Test: `client/src/__tests__/trpc-wiring.test.tsx`

**Interfaces:**

- Produces: `trpc` (a `createTRPCReact<AppRouter>()` proxy), `makeQueryClient()`, `TrpcProviders` component; `mockTrpc(responses)` / `resetTrpcMock()` from the test helper.
- Consumed by: every client task after this one.

- [ ] **Step 1: Install the two allowed client dependencies**

```bash
cd client && pnpm add @trpc/react-query @tanstack/react-query
```

- [ ] **Step 2: Write the test harness first**

Nothing else in this phase is testable without it. It stubs `globalThis.fetch` for `/trpc/*` and answers in tRPC v11's HTTP response shape, so no MSW (or any new dependency) is needed.

```ts
// client/src/__tests__/helpers/mock-trpc.ts
/**
 * Answers tRPC HTTP calls in tests without a server.
 *
 * tRPC v11 batches by default: the path is a comma-separated list of
 * procedures and the body is a JSON array of results in the same order.
 * Honouring that here means components under test exercise the real client,
 * real batching and real error paths — only the socket is faked.
 */
type Handlers = Record<string, unknown | (() => unknown)>;

let handlers: Handlers = {};
let originalFetch: typeof globalThis.fetch | undefined;

export function mockTrpc(next: Handlers) {
  handlers = { ...handlers, ...next };
  if (originalFetch) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const procedures = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const body = procedures.map((name) => {
      if (!(name in handlers)) {
        return {
          error: {
            json: {
              message: `No mock for ${name}`,
              code: -32004,
              data: { code: 'NOT_FOUND', httpStatus: 404 },
            },
          },
        };
      }
      const value = handlers[name];
      return {
        result: {
          data: { json: typeof value === 'function' ? (value as () => unknown)() : value },
        },
      };
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Makes one named procedure reject, so error states can be exercised. */
export function mockTrpcError(procedure: string) {
  mockTrpc({
    [procedure]: () => {
      throw new Error('mock failure');
    },
  });
}

export function resetTrpcMock() {
  handlers = {};
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
```

Add a matching `afterEach(resetTrpcMock)` to `client/src/setupTests.ts`.

Also add `client/src/__tests__/helpers/fixtures.ts` exporting `SETTINGS_FIXTURE`, `TOURS_FIXTURE`, `DESTINATIONS_FIXTURE`, `PACKAGES_FIXTURE`, `REVIEWS_FIXTURE` — shaped exactly like the API types and valued from today's placeholder content, so existing assertions in `home.test.tsx` keep passing unchanged.

- [ ] **Step 3: Write the failing wiring test**

```tsx
// client/src/__tests__/trpc-wiring.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrpcProviders, trpc } from '@/lib/trpc';
import { mockTrpc } from './helpers/mock-trpc';

function Probe() {
  const { data, isPending } = trpc.destinations.list.useQuery();
  if (isPending) return <p>loading</p>;
  return <p>{data?.map((d) => d.name).join(', ')}</p>;
}

describe('tRPC + React Query wiring', () => {
  it('resolves a query through the provider stack', async () => {
    mockTrpc({ 'destinations.list': [{ id: 1, name: 'Oslob', slug: 'oslob' }] });
    render(
      <TrpcProviders>
        <Probe />
      </TrpcProviders>,
    );
    expect(await screen.findByText('Oslob')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it and watch it fail.** Expected: `TrpcProviders` is not exported.

- [ ] **Step 5: Implement**

`client/src/lib/trpc.ts` becomes `export const trpc = createTRPCReact<AppRouter>()` plus a `TrpcProviders` component composing `QueryClientProvider` and `trpc.Provider` with an `httpBatchLink({ url: '/trpc' })`. Keep the existing comment about the Vite proxy.

`query-client.ts`: `staleTime: 60_000`, `retry: 1`, `refetchOnWindowFocus: false` — this is slow-moving marketing content, and refetch-on-focus would restart skeletons every time the guest switches tabs.

`main.tsx` wraps `<App />` in `<TrpcProviders>`.

- [ ] **Step 6: Run tests → PASS. Commit.**

```bash
git add client/src/lib client/src/main.tsx client/src/__tests__ client/package.json pnpm-lock.yaml
git commit -m "feat(client): tRPC react-query provider stack and a fetch-level test harness"
```

**✅ DONE 2.1**

---

### Task 2.2: Loading, error and empty primitives

**Files:**

- Create: `client/src/components/common/Skeleton.tsx`, `client/src/components/common/QueryBoundary.tsx`
- Test: `client/src/__tests__/query-boundary.test.tsx`

**Use ui-ux-pro-max before writing any markup here.** Query it for skeleton and empty-state guidance (`"skeleton loading no layout shift" --domain ux`, `"empty state messaging" --domain ux`).

**Interfaces:**

- Produces:

```tsx
<QueryBoundary
  query={someUseQueryResult}
  skeleton={<TourCardSkeleton />}
  empty={<EmptyState title="..." body="..." />}
  errorTitle="Tours could not load"
>
  {(data) => <TourGrid tours={data} />}
</QueryBoundary>
```

plus `isEmpty?: (data: T) => boolean` (defaults to `Array.isArray(data) && data.length === 0`).

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/__tests__/query-boundary.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import QueryBoundary from '@/components/common/QueryBoundary';

const base = { data: undefined, isPending: false, isError: false } as const;

describe('QueryBoundary', () => {
  it('shows the skeleton while pending', () => {
    render(
      <QueryBoundary
        query={{ ...base, isPending: true }}
        skeleton={<p>skeleton</p>}
        errorTitle="Nope"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('skeleton')).toBeInTheDocument();
  });

  it('shows a friendly error, not a stack trace, and offers a retry', () => {
    render(
      <QueryBoundary
        query={{ ...base, isError: true, refetch: () => {} }}
        skeleton={<p>s</p>}
        errorTitle="Tours could not load"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('Tours could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/mock failure/i)).not.toBeInTheDocument();
  });

  it('shows the empty slot for an empty array', () => {
    render(
      <QueryBoundary
        query={{ ...base, data: [] }}
        skeleton={<p>s</p>}
        empty={<p>nothing yet</p>}
        errorTitle="Nope"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
  });

  it('renders children with the data', () => {
    render(
      <QueryBoundary query={{ ...base, data: [1] }} skeleton={<p>s</p>} errorTitle="Nope">
        {(d) => <p>got {d.length}</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('got 1')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

Hard requirements:

- **No layout shift.** Each skeleton must occupy the real component's box. `TourCardSkeleton` mirrors `TourCard`'s aspect ratio and line count exactly; `ReviewCardSkeleton` likewise. Verify by toggling between states at 360px and watching nothing jump.
- **No red.** The error state uses `text-brand-error` (`#334155`) and `border-brand-blue-200`. Never a red token, never `--destructive` unmapped.
- The error message is generic and human — the raw `Error` never reaches the DOM.
- The retry button is a `tap-target` and calls `query.refetch()`.
- Skeleton shimmer is a `prefers-reduced-motion`-respecting animation. The global blanket rule in `index.css` already clamps it; verify rather than assume, and make the static state legible on its own.

- [ ] **Step 4: Run tests → PASS. Run `pnpm test` so `no-red.test.ts` sees the new files. Commit.**

```bash
git add client/src/components/common client/src/__tests__/query-boundary.test.tsx
git commit -m "feat(ui): shared loading, error and empty states with no layout shift and no red"
```

**✅ DONE 2.2**

---

### Task 2.3: Money helper and TourCard from API data

**Files:**

- Create: `shared/src/money.ts`
- Modify: `shared/src/index.ts`, `client/src/components/common/TourCard.tsx`
- Test: `shared/src/__tests__/money.test.ts`, `client/src/__tests__/tour-card.test.tsx`

This is where 3B lands: both booking counters disappear.

**Interfaces:**

- Produces: `formatPeso(centavos: number): string` from `@rg/shared`.
- `TourCard` takes `{ tour: TourListItem }` — the API type, not the placeholder type.

- [ ] **Step 1: Write the failing money test**

```ts
// shared/src/__tests__/money.test.ts
import { describe, expect, it } from 'vitest';
import { formatPeso } from '../money';

describe('formatPeso', () => {
  it('formats whole pesos from centavos with no space after the sign', () => {
    expect(formatPeso(189_000)).toBe('₱1,890');
    expect(formatPeso(98_000)).toBe('₱980');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('rounds to the nearest peso', () => {
    expect(formatPeso(189_049)).toBe('₱1,890');
    expect(formatPeso(189_050)).toBe('₱1,891');
  });
});
```

`shared` has no test runner yet — add `vitest` to `shared/devDependencies` and change its `test` script from the `echo` placeholder to `vitest run`, with a minimal `shared/vitest.config.ts`.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Move `formatPeso` verbatim** out of `placeholder-data.ts` into `shared/src/money.ts`, re-export from `shared/src/index.ts`, and have `placeholder-data.ts` re-export it so nothing breaks mid-phase. Keep the `.replace(/ /g, '')` — it is what produces `₱1,890` rather than `₱ 1,890`.

- [ ] **Step 4: Write the failing TourCard test**

```tsx
// client/src/__tests__/tour-card.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TourCard from '@/components/common/TourCard';
import { TOURS_FIXTURE } from './helpers/fixtures';

const tour = TOURS_FIXTURE[0];
const show = (t = tour) =>
  render(
    <MemoryRouter>
      <TourCard tour={t} />
    </MemoryRouter>,
  );

describe('TourCard', () => {
  it('shows the from-price formatted from centavos', () => {
    show();
    expect(screen.getByText(/₱1,890/)).toBeInTheDocument();
  });

  it('hides "booked this week" at zero', () => {
    show({ ...tour, bookedThisWeek: 0 });
    expect(screen.queryByText(/booked/i)).not.toBeInTheDocument();
  });

  it('hides the trips-run line when the count is null', () => {
    show({ ...tour, tripsRun: null });
    expect(screen.queryByText(/trips run/i)).not.toBeInTheDocument();
  });

  it('shows both counters once they carry real numbers', () => {
    show({ ...tour, bookedThisWeek: 7, tripsRun: 412 });
    expect(screen.getByText(/booked 7/i)).toBeInTheDocument();
    expect(screen.getByText(/412 trips run/i)).toBeInTheDocument();
  });

  it('omits the rating block entirely when a tour has no reviews', () => {
    show({ ...tour, rating: null });
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument();
  });

  it('renders the per-tour alert note and badge when set', () => {
    show({ ...tour, badge: 'best_seller', alertNote: 'Sea conditions permitting.' });
    expect(screen.getByText(/best seller/i)).toBeInTheDocument();
    expect(screen.getByText(/sea conditions permitting/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run it and watch it fail.**

- [ ] **Step 6: Rework `TourCard`** to take `TourListItem`. Keep every class name and element; only the data source and the three new conditionals change. Badge labels: `best_seller` → "Best seller", `new` → "New", `seasonal` → "Seasonal", `none` → nothing. The badge uses the existing gold badge styling; the alert note uses `text-brand-warning` (amber) — **never red**. Images get `width`/`height` from the API so no box shifts while loading (5E groundwork).

- [ ] **Step 7: Run tests → PASS. Commit.**

```bash
git add shared client/src/components/common/TourCard.tsx client/src/__tests__
git commit -m "feat(ui): TourCard renders API data and hides both booking counters until real"
```

**✅ DONE 2.3** (covers task 3B)

---

### Task 2.4: Catalog and destinations from the API

**Files:**

- Modify: `client/src/components/home/CatalogPreview.tsx`, `client/src/pages/public/HomePage.tsx`
- Test: `client/src/__tests__/catalog.test.tsx`

- [ ] **Step 1: Write the failing test** — keep the existing filter assertion from `home.test.tsx` (every chip yields a non-empty, matching grid), plus:

```tsx
it('shows skeletons first, then the grid', async () => {
  /* mockTrpc with a deferred resolve */
});
it('shows a friendly error when tours fail to load', async () => {
  /* mockTrpcError('tours.list') */
});
it('shows an empty state when a destination has no tours', async () => {
  /* tours.list -> [] */
});
it('orders featured tours before the rest', async () => {
  /* assert DOM order matches API order */
});
```

The catalog must **not** re-sort client-side — the API already orders by featured then `sort_order` (6D). Assert the DOM order equals the API order exactly.

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement.** `trpc.destinations.list.useQuery()` for the chips and `trpc.tours.list.useQuery({})` for the grid; filter client-side on the already-fetched list as today (one request, instant chips). Wrap both in `QueryBoundary`.

- [ ] **Step 4: Run tests → PASS. Commit.**

**✅ DONE 2.4**

---

### Task 2.5: Packages and reviews from the API

**Files:**

- Modify: `client/src/components/home/PackagesSection.tsx`, `client/src/components/home/ReviewsSection.tsx`
- Test: `client/src/__tests__/packages-reviews.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders every active package with old and new prices', async () => {});
it('strikes through the old price only when one exists', async () => {});
it('renders published reviews including seeded samples', async () => {});
it('shows an empty state when no reviews are published', async () => {});
it('never renders a review body as HTML', async () => {
  // a body containing "<img src=x onerror=alert(1)>" must appear as text
});
```

- [ ] **Step 2: Run, fail, implement, pass.** Both sections wrap in `QueryBoundary`. Review bodies are plain text children — never `dangerouslySetInnerHTML`.

- [ ] **Step 3: Commit.**

**✅ DONE 2.5**

---

### Task 2.6: Hero and trust bar from settings

**Files:**

- Modify: `client/src/components/home/HeroSection.tsx`, `client/src/components/home/TrustBar.tsx`
- Test: `client/src/__tests__/hero-trust.test.tsx`

This delivers 6B's data path. The hero image stays the real photo already in `client/public/hero/`; `settings.hero.imagePath` seeds to that exact path.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders the headline, subtitle and eyebrow from settings', async () => {});
it('fills the destination select from the API, not a constant', async () => {});
it('omits the review-count clause when ratingCount is null', async () => {});
it('omits the guests-served item when guestsServed is null', async () => {});
it('keeps the hero readable while settings are still loading', async () => {
  // the hero must render its photo and search form immediately; only the
  // copy may be skeletoned. A blank hero on a slow connection is not acceptable.
});
```

- [ ] **Step 2: Run, fail, implement, pass.**

The hero is above the fold, so it must **not** be gated behind a full-section skeleton. Render the photo, the overlay and the search form straight away; skeleton only the headline, subtitle and trust line. Keep `fetchPriority="high"` on the image.

- [ ] **Step 3: Commit.**

**✅ DONE 2.6** (covers task 6B's data path)

---

### Task 2.7: Chip row focus-ring padding

**Files:**

- Modify: `client/src/components/home/CatalogPreview.tsx`
- Test: `client/src/__tests__/catalog.test.tsx`

Task 6J. The row is `overflow-x-auto`, which also clips vertically, so a focused chip's ring is cut off at the top edge. It has `pb-2` and no top padding.

- [ ] **Step 1:** Change the row's `pb-2` to `py-2` so the ring has room on both edges. Confirm the `scroll-fade-x` mask (added in commit `719dabe`) still lines up — the mask is horizontal only, so vertical padding does not affect it.

- [ ] **Step 2:** Verify at 360px that the chips have not moved relative to the heading. If `py-2` shifts the grid below, compensate with `mt-7` instead of `mt-8` so the overall rhythm is unchanged.

- [ ] **Step 3: Commit.**

```bash
git commit -m "fix(a11y): give the chip row room so a focused chip's ring is not clipped"
```

**✅ DONE 2.7** (covers task 6J)

---

### Task 2.8: Phase 2 verification and push

- [ ] Run all five commands in order.
- [ ] Screenshot the home page at 360px and 1280px and compare against Phase 1. Only the two booking counters should be gone.
- [ ] `git push origin main`

**✅ PHASE 2 COMPLETE**

---

# PHASE 3 — Dynamic content blocks and forms

Delivers 6A, 6C–6I, 3C and 4A. At the end `placeholder-data.ts` is deleted.

### Task 3.1: Announcement bar

**Files:**

- Create: `client/src/components/layout/AnnouncementBar.tsx`
- Modify: `client/src/components/layout/PublicLayout.tsx`
- Test: `client/src/__tests__/announcement.test.tsx`, `server/src/__tests__/announcement-window.test.ts`

Task 6A. The server already resolves the Manila date window (Task 1.5) and returns `settings.announcement` as `null` when inactive or out of window — **the client never evaluates dates.** That is what makes the Manila-midnight behaviour testable in one place.

**Use ui-ux-pro-max** for the bar: query `"announcement banner dismissible accessible" --domain ux`.

- [ ] **Step 1: Write the failing server test**

```ts
// server/src/__tests__/announcement-window.test.ts
import { describe, expect, it } from 'vitest';
import { resolveAnnouncement } from '../content/settings';

const base = {
  message: 'Holiday schedule',
  href: '/tours',
  style: 'info' as const,
  isActive: true,
};

describe('announcement resolution', () => {
  it('is null when inactive, even inside its window', () => {
    expect(
      resolveAnnouncement({ ...base, isActive: false, startsAt: null, endsAt: null }, new Date()),
    ).toBeNull();
  });

  it('is null before the Manila start of day', () => {
    expect(
      resolveAnnouncement(
        { ...base, startsAt: '2026-10-01T16:00:00.000Z', endsAt: null },
        new Date('2026-10-01T15:59:59.000Z'),
      ),
    ).toBeNull();
  });

  it('appears from Manila midnight', () => {
    expect(
      resolveAnnouncement(
        { ...base, startsAt: '2026-10-01T16:00:00.000Z', endsAt: null },
        new Date('2026-10-01T16:00:00.000Z'),
      ),
    ).toEqual({ message: 'Holiday schedule', href: '/tours', style: 'info' });
  });

  it('never leaks the schedule fields to the client', () => {
    const resolved = resolveAnnouncement({ ...base, startsAt: null, endsAt: null }, new Date());
    expect(resolved).not.toHaveProperty('startsAt');
    expect(resolved).not.toHaveProperty('isActive');
  });
});
```

- [ ] **Step 2: Write the failing client test**

```tsx
// client/src/__tests__/announcement.test.tsx
it('renders nothing when settings.announcement is null', async () => {});
it('renders the message above the header', async () => {
  // assert the bar precedes <header> in document order
});
it('dismisses for the session and stays dismissed on remount', async () => {
  // click dismiss -> gone; re-render -> still gone; sessionStorage holds the key
});
it('uses amber for the warning style and never a red token', async () => {});
it('renders a link only when href is set', async () => {});
it('survives sessionStorage throwing', async () => {
  // private-mode browsers throw on access; the bar must still render
});
```

- [ ] **Step 3: Run both and watch them fail.**

- [ ] **Step 4: Implement**

- `resolveAnnouncement(raw, now)` in `server/src/content/settings.ts`, using `isWithinWindow` from Task 1.5, returning only `{ message, href, style }` or `null`.
- `AnnouncementBar` renders above `<SiteHeader />` in `PublicLayout`. `role="status"`. Dismiss is a 44px `tap-target` icon button with an accessible name ("Dismiss announcement").
- Dismissal key is `sessionStorage` keyed by a hash of the message, so a _new_ announcement reappears even if the previous one was dismissed. Wrap every `sessionStorage` read and write in `try/catch`.
- Styles: `info` → `bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200`; `warning` → `bg-brand-gold-100 text-brand-warning border-brand-warning/30`. There is no third style.
- The bar must not cause layout shift on the sticky header — check the `scroll-margin-top: 5rem` rule in `index.css` still lands section anchors correctly with the bar present, and adjust the offset if not.

- [ ] **Step 5: Run tests → PASS. Commit.**

**✅ DONE 3.1** (covers task 6A)

---

### Task 3.2: Promo band

**Files:**

- Modify: `client/src/components/home/PromoNewsletter.tsx`
- Test: `client/src/__tests__/promo.test.tsx`

Task 6C. Display only — coupon validation is Week 7. Same server-resolved pattern as 3.1: `settings.promo` is `null` outside its window.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders the headline, body and discount label from settings', async () => {});
it('hides the whole promo band when settings.promo is null', async () => {
  // the newsletter form must still render — only the promo copy goes
});
it('reveals the code only after a successful signup', async () => {});
it('never renders the code before signup, even though it is in the payload', async () => {});
```

Note the last one: `settings.promo.code` arrives with the page, so the existing "reveal after signup" behaviour is now a UI affordance, not a secret. That is fine for a public marketing code, but the test pins the behaviour so nobody "simplifies" it into always-visible.

- [ ] **Step 2: Run, fail, implement, pass.** Keep the gold reveal panel exactly as it is. Replace the hardcoded "Get 10% off your first tour" with `promo.headline` and the body with `promo.body`; both seed to today's strings.

- [ ] **Step 3: Commit.**

**✅ DONE 3.2** (covers task 6C)

---

### Task 3.3: How it works, Why book direct, Most visited, FAQ

**Files:**

- Modify: `client/src/components/home/HowItWorks.tsx`, `WhyBookDirect.tsx`, `MostVisited.tsx`, `FaqSection.tsx`
- Test: `client/src/__tests__/content-blocks.test.tsx`

Task 6H, first half.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders how-it-works steps in order from settings', async () => {});
it('renders why-book-direct reasons with their mapped icons', async () => {});
it('falls back to a neutral icon for an unknown icon key', async () => {
  // settings are admin-editable later; an unknown key must not crash the page
});
it('renders most-visited places from the destinations API', async () => {});
it('shows only featured destinations in most-visited', async () => {});
it('renders FAQ questions and answers from settings', async () => {});
it('keeps the FAQ accordion keyboard operable', async () => {});
```

- [ ] **Step 2: Run, fail, implement, pass.**

The icon mapping is the one thing that needs care: `why_book_direct[].icon` is a string key in the DB (`'tag' | 'wallet' | 'shield' | 'headset' | 'calendar' | 'map'`). Keep an explicit `Record<string, LucideIcon>` in the component and default to a neutral icon rather than crashing — the DB becomes admin-editable in Weeks 5–7.

Most Visited reads `destinations.list()` filtered to `isFeatured`, using `blurb`, `imagePath`, `imageAlt`. Seed all six as featured so the section looks identical.

- [ ] **Step 3: Commit.**

**✅ DONE 3.3** (covers task 6H, first half)

---

### Task 3.4: Contact, hours, payment methods and permits

**Files:**

- Modify: `client/src/components/home/ContactSection.tsx`, `client/src/components/layout/SiteFooter.tsx`, `client/src/components/layout/FloatingWhatsApp.tsx`
- Test: `client/src/__tests__/contact-footer.test.tsx`

Tasks 6E, 6F, 6G and the rest of 6H.

Per **D10**, phones, Facebook, motto, email and the other-services line keep coming from `site.ts` — the UI may read them from `settings.contact` (which Task 1.4's test pins to `site.ts`), but `site.ts` itself is not edited and `check-contact-parity.mjs` is not touched.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the open-now message from the server, not a client clock', async () => {
  // settings.openState.message is rendered verbatim; no Date() in the component
});
it('shows the closed message when the server says closed', async () => {});
it('renders the same open state on the WhatsApp button and the contact section', async () => {});
it('lists only enabled payment methods in the footer', async () => {});
it('omits a disabled method from the payment FAQ answer too', async () => {});
it('renders "— pending —" for every empty permit', async () => {});
it('renders a real permit number once settings supply one', async () => {});
it('credits R&G Travel & Tours, not TravelSugbo, beside the permits', async () => {});
```

The last one preserves the existing brand-vs-operator assertion in `layout.test.tsx` — keep that test passing unchanged.

- [ ] **Step 2: Run, fail, implement, pass.**

The open/closed string is computed **server-side** (Task 1.5) and rendered verbatim. Do not recompute it in the browser: a client clock would show a Manila-correct message only for guests already in that timezone.

Payment methods drive two surfaces — the footer chips and the "Which payment methods do you accept?" FAQ answer. Rather than two lists that can drift, the FAQ answer for that question is composed from `settings.paymentMethods` at render time. Seed the FAQ entry with a placeholder marker the component replaces, or keep the answer generic and append the method list; either way, assert in a test that disabling a method removes it from **both** places.

- [ ] **Step 3: Commit.**

**✅ DONE 3.4** (covers tasks 6E, 6F, 6G and the rest of 6H)

---

### Task 3.5: Wire the inquiry, contact and newsletter forms

**Files:**

- Modify: `client/src/components/home/ContactSection.tsx`, `PackagesSection.tsx`, `PromoNewsletter.tsx`
- Test: `client/src/__tests__/forms.test.tsx`

Task 3C.

- [ ] **Step 1: Write the failing tests**

```tsx
it('submits a contact inquiry and confirms success', async () => {});
it('submits a package inquiry carrying the package id', async () => {});
it('shows a friendly failure message, in brand error style, when the mutation fails', async () => {});
it('never claims an inquiry was sent when the mutation failed', async () => {
  // this preserves the existing guarantee in home.test.tsx
});
it('disables the submit button while in flight and re-enables after', async () => {});
it('blocks submission without the data-privacy consent checkbox', async () => {});
it('reports the rate-limit response as a distinct, calm message', async () => {
  // a 429 must read "Too many messages — please try again shortly", not a generic error
});
it('treats an already-subscribed address as success', async () => {});
```

- [ ] **Step 2: Run, fail, implement, pass.**

Requirements:

- Add the **RA 10173 consent checkbox** to both inquiry forms. The server already rejects `consent: false` (Task 1.7); the client must also prevent submission and say why.
- Error styling uses `text-brand-error` / `border-brand-blue-200`. **No red.**
- Success and error regions are `role="status"` and `role="alert"` respectively, so a screen reader hears the outcome.
- The two existing tests asserting the site "never claims an inquiry was sent" must still pass — now they pass because the claim is made only on a resolved mutation.

- [ ] **Step 3: Commit.**

**✅ DONE 3.5** (covers task 3C)

---

### Task 3.6: Privacy and terms pages

**Files:**

- Create: `client/src/components/common/Markdown.tsx`, `client/src/pages/public/PrivacyPage.tsx`, `client/src/pages/public/TermsPage.tsx`
- Modify: `client/src/App.tsx`, `client/src/components/layout/SiteFooter.tsx`
- Test: `client/src/__tests__/markdown.test.tsx`, `client/src/__tests__/legal-pages.test.tsx`

Task 6I. **No markdown library** — `react-markdown` is not on the allowed list, so this is a deliberately tiny renderer producing React elements.

**Use ui-ux-pro-max** for the legal page layout: query `"long form legal document readability" --domain ux`.

- [ ] **Step 1: Write the failing renderer test**

```tsx
// client/src/__tests__/markdown.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Markdown from '@/components/common/Markdown';

describe('Markdown', () => {
  it('renders headings at the right level', () => {
    render(<Markdown source={'## Data we collect'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Data we collect' })).toBeInTheDocument();
  });

  it('renders paragraphs, bold text and bullet lists', () => {
    render(<Markdown source={'Hello **world**\n\n- one\n- two'} />);
    expect(screen.getByText('world').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders links and marks external ones safely', () => {
    render(<Markdown source={'[site](https://example.com)'} />);
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('never executes or injects raw HTML', () => {
    render(<Markdown source={'<img src=x onerror="alert(1)"> and <script>bad()</script>'} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument(); // shown as literal text
  });

  it('refuses a javascript: link', () => {
    render(<Markdown source={'[bad](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, fail, implement, pass.**

Supported subset, and nothing else: `##`/`###` headings, blank-line-separated paragraphs, `-` bullet lists, `**bold**`, `[text](url)`, and `>` blockquotes (needed for the TODO banner). Everything else renders as literal text. Build React elements by parsing — **never** `dangerouslySetInnerHTML`. Reject any href whose scheme is not `http:`, `https:`, `mailto:` or a leading `/`.

- [ ] **Step 3: Write the failing page tests**

```tsx
it('renders the privacy markdown from settings', async () => {});
it('renders the terms markdown from settings', async () => {});
it('shows the TODO legal-review notice while the text is placeholder', async () => {});
it('shows the last-updated date', async () => {});
it('links to both pages from the footer', async () => {});
it('sets a single h1 per page', async () => {});
```

- [ ] **Step 4: Implement.** Routes `/privacy` and `/terms` inside `PublicLayout`. Footer gains both links next to the copyright. The seeded markdown opens with the blockquote `> **TODO: client legal review.** This text is a placeholder and is not legal advice.`, rendered in the amber warning style.

- [ ] **Step 5: Commit.**

**✅ DONE 3.6** (covers task 6I)

---

### Task 3.7: Delete placeholder-data.ts

**Files:**

- Delete: `client/src/lib/placeholder-data.ts`, `client/src/__tests__/placeholder-data.test.ts`
- Modify: `client/src/components/layout/PlaceholderBadge.tsx`, `CLAUDE.md`
- Test: `client/src/__tests__/placeholder-badge.test.tsx`

Task 4A.

- [ ] **Step 1: Prove nothing imports it**

```bash
grep -rn "placeholder-data" client/src || echo "clean"
```

Expected: `clean`. If anything remains, finish that component first — do not stub it.

- [ ] **Step 2: Write the failing badge test**

```tsx
it('shows the banner while settings.contentUnverified is true', async () => {});
it('hides the banner once settings.contentUnverified is false', async () => {});
it('hides the banner while settings are still loading', async () => {
  // a banner that flashes on every page load is worse than one that arrives late
});
it('keeps the banner out of the way of the announcement bar', async () => {});
```

- [ ] **Step 3: Rework `PlaceholderBadge`** to read `settings.contentUnverified` instead of the deleted `USING_PLACEHOLDER_DATA`, and drop the `import.meta.env.DEV` branch — the flag is now the single source of truth, and it lives in the database where the client can clear it.

- [ ] **Step 4: Delete both files.**

- [ ] **Step 5: Update the CLAUDE.md "Placeholder data (current state)" section.** Replace it with a short section describing the new arrangement: content lives in `rg_travel`, seeded by `pnpm db:seed` from `server/src/db/seed-data.ts`; `settings.content_unverified` drives the banner and blocks a production build; permit numbers still render `— pending —`; sample reviews are flagged `is_sample` and blocked from production by the build guard.

- [ ] **Step 6: Run the full chain.** `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` must still pass — the existing guard reads a file that no longer exists, which it already handles (`existsSync` check) and treats as success.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "refactor(content): delete placeholder-data.ts; the database is the only content source"
```

**✅ DONE 3.7** (covers task 4A)

---

### Task 3.8: Phase 3 verification and push

- [ ] Run all five commands in order.
- [ ] Walk the home page at 360px: announcement bar, hero, trust bar, catalog, how it works, why book direct, most visited, packages, reviews, promo, FAQ, contact, footer. Compare against the Phase 1 screenshots.
- [ ] Submit each of the three forms against the running server and confirm the rows land in `rg_travel`.
- [ ] `git push origin main`

**✅ PHASE 3 COMPLETE**

---

# PHASE 4 — SEO, performance and documentation

Delivers 5A–5E, 7A, the extended build guard (D2) and the documentation updates.

### Task 4.1: Page resolvers and meta injection

**Files:**

- Create: `server/src/seo/types.ts`, `server/src/seo/resolvers.ts`, `server/src/seo/render.ts`, `server/src/html.ts`
- Modify: `server/src/app.ts`, `client/vite.config.ts`
- Test: `server/src/__tests__/seo-resolvers.test.ts`, `server/src/__tests__/seo-render.test.ts`

Tasks 5A and 5B. **This is the task that makes dev and production behave identically (D6).**

**Interfaces:**

```ts
// server/src/seo/types.ts
export type PageMeta = {
  title: string;
  description: string;
  canonical: string;
  ogImage: string | null;
  ogType: 'website' | 'article';
  jsonLd: unknown[];
  status: 200 | 404;
  robots: 'index,follow' | 'noindex,nofollow';
};
export type Resolver = (params: Record<string, string>) => Promise<PageMeta>;

// server/src/seo/resolvers.ts
export const ROUTES: Array<{ pattern: string; resolve: Resolver }>;
export function matchRoute(
  pathname: string,
): { resolve: Resolver; params: Record<string, string> } | null;
export function resolvePage(pathname: string): Promise<PageMeta>;

// server/src/seo/render.ts
export function injectMeta(html: string, meta: PageMeta): string;
```

- [ ] **Step 1: Write the failing resolver test**

```ts
// server/src/__tests__/seo-resolvers.test.ts
import { describe, expect, it } from 'vitest';
import { matchRoute } from '../seo/resolvers';
import { describeWithDb } from './helpers/db';

describe('route matching', () => {
  it('matches static routes', () => {
    expect(matchRoute('/')).not.toBeNull();
    expect(matchRoute('/tours')).not.toBeNull();
    expect(matchRoute('/privacy')).not.toBeNull();
    expect(matchRoute('/terms')).not.toBeNull();
  });

  it('extracts a slug parameter', () => {
    expect(matchRoute('/tours/oslob-whale-shark-tumalog-falls')?.params).toEqual({
      slug: 'oslob-whale-shark-tumalog-falls',
    });
    expect(matchRoute('/packages/cebu-highlights-3d2n')?.params).toEqual({
      slug: 'cebu-highlights-3d2n',
    });
  });

  it('ignores a trailing slash and is case-insensitive on the path', () => {
    expect(matchRoute('/tours/')).not.toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('/nope')).toBeNull();
    expect(matchRoute('/tours/a/b')).toBeNull();
  });
});

describeWithDb('page resolution', () => {
  it('builds home meta from settings.site_seo', async () => {
    const meta = await resolvePage('/');
    expect(meta.status).toBe(200);
    expect(meta.canonical).toBe('http://localhost:5180/');
    expect(meta.title.length).toBeGreaterThan(10);
  });

  it('falls back to a generated title when a tour has no seo_title', async () => {
    // Title pattern: "<title> — <destination> day tour from ₱X | TravelSugbo"
    const meta = await resolvePage('/tours/oslob-whale-shark-tumalog-falls');
    expect(meta.title).toMatch(/Oslob/);
    expect(meta.title).toMatch(/₱/);
  });

  it('returns a 404 PageMeta for an unknown slug', async () => {
    const meta = await resolvePage('/tours/no-such-tour');
    expect(meta.status).toBe(404);
    expect(meta.robots).toBe('noindex,nofollow');
  });

  it('returns a 404 PageMeta for an unknown path', async () => {
    expect((await resolvePage('/nope')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Write the failing injection test**

```ts
// server/src/__tests__/seo-render.test.ts
import { describe, expect, it } from 'vitest';
import { injectMeta } from '../seo/render';

const HTML = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<title>TravelSugbo — Cebu Day Tours &amp; Packages</title>
<meta name="description" content="old description" />
</head><body><div id="root"></div></body></html>`;

const META = {
  title: 'Oslob Whale Sharks | TravelSugbo',
  description: 'Swim with whale sharks.',
  canonical: 'https://travelsugbo.com/tours/oslob',
  ogImage: 'https://travelsugbo.com/hero/hero-cebu-1920.jpg',
  ogType: 'website' as const,
  jsonLd: [{ '@context': 'https://schema.org', '@type': 'TravelAgency', name: 'TravelSugbo' }],
  status: 200 as const,
  robots: 'index,follow' as const,
};

describe('injectMeta', () => {
  const out = injectMeta(HTML, META);

  it('replaces the existing title rather than adding a second one', () => {
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).toContain('<title>Oslob Whale Sharks | TravelSugbo</title>');
  });

  it('replaces the existing description rather than adding a second one', () => {
    expect(out.match(/name="description"/g)).toHaveLength(1);
    expect(out).toContain('content="Swim with whale sharks."');
  });

  it('adds canonical, Open Graph and Twitter tags', () => {
    expect(out).toContain('<link rel="canonical" href="https://travelsugbo.com/tours/oslob">');
    expect(out).toContain('property="og:title"');
    expect(out).toContain('property="og:image"');
    expect(out).toContain('name="twitter:card"');
  });

  it('embeds JSON-LD as valid, parseable JSON', () => {
    const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out);
    expect(script).not.toBeNull();
    expect(() => JSON.parse(script![1])).not.toThrow();
  });

  it('escapes a quote or angle bracket in the title so markup cannot break out', () => {
    const evil = injectMeta(HTML, { ...META, title: 'He said "hi" <script>' });
    expect(evil).not.toContain('<script>He');
    expect(evil).toContain('&quot;hi&quot;');
  });

  it('escapes </script> inside JSON-LD', () => {
    const evil = injectMeta(HTML, {
      ...META,
      jsonLd: [{ name: '</script><script>alert(1)</script>' }],
    });
    expect(evil).not.toMatch(/<\/script><script>alert/);
  });

  it('emits a robots meta only when noindex', () => {
    expect(out).not.toContain('name="robots"');
    expect(injectMeta(HTML, { ...META, robots: 'noindex,nofollow' })).toContain(
      'content="noindex,nofollow"',
    );
  });
});
```

- [ ] **Step 3: Run both and watch them fail.**

- [ ] **Step 4: Implement**

`matchRoute` is a ~20-line matcher over `ROUTES` patterns (`/`, `/tours`, `/tours/:slug`, `/packages/:slug`, `/privacy`, `/terms`) — **no new dependency**. Split on `/`, compare segment by segment, collect `:name` segments as params.

**5A fallbacks**, applied when `seo_title` / `seo_description` are empty:

- Tour title → `"<title> — <destination> day tour from <formatPeso(fromPrice)> | TravelSugbo"`
- Tour description → first 155 chars of `summary`, else `about`, else `"Book the <title> day tour in <destination> with TravelSugbo. Private van, licensed driver, from <price> per person."`
- Package equivalents, using `days` and `new_price`.
- Home → `settings.site_seo`.
- `og_image` falls back to the tour's first image, then the site OG image, then the hero photo.

Escaping is mandatory: `escapeHtmlAttribute()` for every attribute value, and JSON-LD serialised with `</` replaced by `<\/` before embedding.

Per **D5**, `/tours/:slug` and `/packages/:slug` resolvers are built and tested, but no page renders them yet — they exist so Week 2D plugs in with one line.

- [ ] **Step 5: Wire production — `server/src/html.ts` + `app.ts`**

Mount **after** `/trpc` and `/api` so it never shadows them, and only when `env.NODE_ENV === 'production'`:

```ts
app.use(express.static(DIST, { index: false }));
app.get('*splat', serveHtml); // Express 5 wildcard syntax
```

`serveHtml` reads `dist/index.html` once at boot, calls `resolvePage`, `injectMeta`, and responds with `meta.status`.

- [ ] **Step 6: Wire dev — a Vite plugin in `client/vite.config.ts`**

```ts
// Dev-only SEO middleware. The import is dynamic and inside configureServer
// so that `vite build` — which also loads this config — never pulls in the
// server's database code or opens a MySQL pool.
function seoDevMiddleware(): Plugin {
  return {
    name: 'rg-seo-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.headers.accept?.includes('text/html')) return next();
        const { resolvePage } = await import('../server/src/seo/resolvers');
        const { injectMeta } = await import('../server/src/seo/render');
        try {
          const url = new URL(req.url, 'http://localhost');
          const meta = await resolvePage(url.pathname);
          const template = await server.transformIndexHtml(
            req.url,
            readFileSync(resolve(here, 'index.html'), 'utf8'),
          );
          res.statusCode = meta.status;
          res.setHeader('content-type', 'text/html');
          res.end(injectMeta(template, meta));
        } catch {
          next(); // never let an SEO failure take down the dev server
        }
      });
    },
  };
}
```

Also add `/robots.txt` and `/sitemap.xml` to the existing `server.proxy` block so Task 4.3's routes work in dev too.

- [ ] **Step 7: Verify by hand**

```bash
pnpm dev
curl -s http://localhost:5180/ | grep -E '<title>|canonical|og:title'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5180/tours/no-such-tour   # 404
```

- [ ] **Step 8: Run tests → PASS. Commit.**

```bash
git commit -m "feat(seo): one resolver module driving meta injection in dev and production"
```

**✅ DONE 4.1** (covers tasks 5A and 5B)

---

### Task 4.2: JSON-LD

**Files:**

- Create: `server/src/seo/jsonld.ts`
- Modify: `server/src/seo/resolvers.ts`
- Test: `server/src/__tests__/jsonld.test.ts`

Task 5C.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/jsonld.test.ts
describe('home JSON-LD', () => {
  it('describes a TravelAgency under the brand, operated by the legal entity', async () => {
    const [agency] = (await resolvePage('/')).jsonLd as any[];
    expect(agency['@type']).toBe('TravelAgency');
    expect(agency.name).toBe('TravelSugbo');
    expect(agency.parentOrganization?.name ?? agency.legalName).toBe('R&G Travel & Tours');
  });

  it('carries the real phone number and the Facebook page', async () => {
    const [agency] = (await resolvePage('/')).jsonLd as any[];
    expect(agency.telephone).toBe('+639084696246');
    expect(agency.sameAs).toContain('https://www.facebook.com/profile.php?id=61574390071362');
  });

  it('includes an FAQPage built from the FAQ settings', async () => {
    const faq = ((await resolvePage('/')).jsonLd as any[]).find((n) => n['@type'] === 'FAQPage');
    expect(faq.mainEntity.length).toBeGreaterThan(0);
    expect(faq.mainEntity[0].acceptedAnswer['@type']).toBe('Answer');
  });

  it('OMITS aggregateRating while only sample reviews exist', async () => {
    const [agency] = (await resolvePage('/')).jsonLd as any[];
    expect(agency.aggregateRating).toBeUndefined();
  });

  it('emits no invented permit or rating value anywhere in the graph', async () => {
    const json = JSON.stringify((await resolvePage('/')).jsonLd);
    expect(json).not.toMatch(/DOT-\d/);
    expect(json).not.toContain('4.9'); // the client-supplied figure is not a review average
  });
});

describe('tour JSON-LD', () => {
  it('describes a TouristTrip with a PHP offer at the lowest tier price', async () => {
    const node = (
      (await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).jsonLd as any[]
    ).find((n) => n['@type'] === 'TouristTrip');
    expect(node.offers.priceCurrency).toBe('PHP');
    expect(node.offers.price).toBe('1890.00'); // pesos, from 189000 centavos
  });

  it('omits aggregateRating when the tour has only sample reviews', async () => {
    const node = (
      (await resolvePage('/tours/oslob-whale-shark-tumalog-falls')).jsonLd as any[]
    ).find((n) => n['@type'] === 'TouristTrip');
    expect(node.aggregateRating).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, fail, implement, pass.**

The critical rule: `aggregateRating` is built **only** from `realAggregate()` (Task 1.5 — `status = 'published' AND is_sample = 0`) and the key is **omitted entirely**, not set to null or zero, when that returns `null`. A zero-count `AggregateRating` is a structured-data error and, with sample data behind it, a false claim.

Money in JSON-LD is pesos with two decimals (`price: '1890.00'`), not centavos — Schema.org expects a currency amount. Centavos remain the internal representation.

- [ ] **Step 3: Validate the output by hand** — paste the home page's JSON-LD into Google's Rich Results Test (manually, in a browser) or at minimum confirm `JSON.parse` succeeds and `@context`/`@type` are present on every node.

- [ ] **Step 4: Commit.**

**✅ DONE 4.2** (covers task 5C)

---

### Task 4.3: Sitemap, robots and noindex headers

**Files:**

- Create: `server/src/seo/sitemap.ts`, `server/src/middleware/robots-header.ts`
- Modify: `server/src/app.ts`, `client/vite.config.ts`
- Test: `server/src/__tests__/sitemap-robots.test.ts`

Task 5D.

- [ ] **Step 1: Write the failing test**

```ts
describe('/sitemap.xml', () => {
  it('lists home, /tours, /privacy and /terms', async () => {});
  it('does NOT list tour or package detail URLs yet (D5 — no page behind them)', async () => {
    const xml = await buildSitemap();
    expect(xml).not.toContain('/tours/oslob');
    expect(xml).not.toContain('/packages/');
  });
  it('uses updated_at for lastmod in W3C date format', async () => {});
  it('is well-formed XML with a urlset namespace', async () => {});
  it('omits inactive tours and packages once detail pages exist', async () => {
    // guards the Week 2D change: the helper that collects URLs already filters is_active
  });
});

describe('/robots.txt', () => {
  it('allows everything and names the sitemap in production', () => {
    const txt = buildRobots('production');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Sitemap: https://travelsugbo.com/sitemap.xml');
  });
  it('disallows everything in preview', () => {
    expect(buildRobots('preview')).toContain('Disallow: /');
    expect(buildRobots('preview')).not.toContain('Allow: /');
  });
});

describe('X-Robots-Tag', () => {
  it.each(['/admin', '/driver', '/portal', '/admin/bookings'])(
    'sets noindex on %s',
    async (path) => {},
  );
  it('sets noindex on every path in the preview environment', async () => {});
  it('does not set it on the public home page in production', async () => {});
});
```

- [ ] **Step 2: Run, fail, implement, pass.**

`buildSitemap()` collects from one helper that already filters `is_active` and sorts, so Week 2D's change is literally uncommenting the tour/package URL lines. Leave a comment saying exactly that, matching the BUILD_SPEC 2D note from Task 4.6.

`PUBLIC_BASE_URL` drives absolute URLs. Note it currently defaults to `http://localhost:5180`; the production value is set in the deploy `.env`, not here.

- [ ] **Step 3: Commit.**

**✅ DONE 4.3** (covers task 5D)

---

### Task 4.4: Performance pass

**Files:**

- Modify: `client/index.html`, `client/src/components/home/HeroSection.tsx`, `TourCard.tsx`, `MostVisited.tsx`, `PackagesSection.tsx`
- Test: `client/src/__tests__/performance-markup.test.tsx`

Task 5E. Per **D4** no Lighthouse dependency is added and **no scores are claimed** — the work is done and reported honestly.

- [ ] **Step 1: Write the failing test** — these assert the markup, which is what is actually testable here.

```tsx
it('preloads the hero image at both widths', () => {
  // client/index.html contains <link rel="preload" as="image"
  //   imagesrcset="/hero/hero-cebu-800.webp 800w, /hero/hero-cebu-1920.webp 1920w">
});
it('gives every content image explicit width and height', async () => {
  // walk the rendered home page; every <img> must have both attributes
});
it('lazy-loads images below the fold but not the hero', async () => {
  // hero: fetchpriority=high and NO loading=lazy
  // tour cards, most-visited, packages: loading=lazy decoding=async
});
it('has no render-blocking font link in index.html', () => {
  // no <link rel="stylesheet" href="fonts.googleapis.com">
});
```

- [ ] **Step 2: Run, fail, implement, pass.**

- Add the hero `<link rel="preload">` with `imagesrcset`/`imagesizes` matching the `<picture>` exactly, or the browser downloads the image twice.
- `width`/`height` on every image come from `tour_images.width`/`height` — seed them from the generated SVGs' intrinsic size so no box shifts.
- Below-the-fold images get `loading="lazy" decoding="async"`. The hero keeps `fetchPriority="high"` and must **not** be lazy.
- Fonts: `index.css` references `'Inter'` in `--font-sans` but `index.html` loads no font stylesheet, so the fallback stack is already in use and there is nothing render-blocking. **Confirm this rather than assume it** — if a font link exists anywhere, make it `preconnect` + `display=swap`.

- [ ] **Step 3: Report honestly.** In the final summary, list exactly what changed and state plainly that no Lighthouse scores were measured, per D4.

- [ ] **Step 4: Commit.**

**✅ DONE 4.4** (covers task 5E)

---

### Task 4.5: Extend the build guard

**Files:**

- Modify: `client/scripts/check-placeholders.mjs`
- Test: `client/src/__tests__/build-guard.test.ts` (or a server-side script test — the guard is a Node script, so test the exported predicate)

Implements **D2** and **D3**. The user explicitly authorised touching this guard; that overrides the standing "DO NOT touch the build guard" line for this task and this task only.

- [ ] **Step 1: Refactor the guard into a testable module** — extract `evaluateGuard({ sampleReviewCount, contentUnverified, dbReachable, isProduction, override })` returning `{ ok: boolean; message: string }`, with the script as a thin wrapper.

- [ ] **Step 2: Write the failing test**

```ts
describe('production build guard', () => {
  const ok = {
    sampleReviewCount: 0,
    contentUnverified: false,
    dbReachable: true,
    isProduction: true,
    override: false,
  };

  it('passes on clean, verified content', () => {
    expect(evaluateGuard(ok).ok).toBe(true);
  });

  it('blocks while a published sample review exists', () => {
    const r = evaluateGuard({ ...ok, sampleReviewCount: 6 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sample review/i);
  });

  it('blocks while content is flagged unverified', () => {
    const r = evaluateGuard({ ...ok, contentUnverified: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unverified/i);
  });

  it('is overridable with ALLOW_PLACEHOLDER_BUILD', () => {
    expect(
      evaluateGuard({ ...ok, sampleReviewCount: 6, contentUnverified: true, override: true }).ok,
    ).toBe(true);
  });

  it('skips with a warning when the DB is unreachable outside production (D3)', () => {
    const r = evaluateGuard({ ...ok, dbReachable: false, isProduction: false });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/warning/i);
  });

  it('hard-fails when the DB is unreachable in production (D3)', () => {
    const r = evaluateGuard({ ...ok, dbReachable: false, isProduction: true });
    expect(r.ok).toBe(false);
  });

  it('never puts the connection string in a message', () => {
    for (const r of [evaluateGuard({ ...ok, dbReachable: false, isProduction: true })]) {
      expect(r.message).not.toMatch(/mysql:\/\//);
    }
  });
});
```

- [ ] **Step 3: Implement.** `isProduction` is `NODE_ENV === 'production' || SITE_ENV === 'production'`. The DB probe is a short-timeout `SELECT` for `COUNT(*) FROM reviews WHERE status='published' AND is_sample=1` plus the `content_unverified` setting. Keep the existing `placeholder-data.ts` check — it is now a no-op since the file is gone, but removing it costs nothing to keep and documents the history. Actually **remove it** and say so in the message, since the file is deleted and a dead check is noise.

- [ ] **Step 4: Verify both paths by hand**

```bash
ALLOW_PLACEHOLDER_BUILD=1 pnpm build     # passes
pnpm --filter @rg/client build           # should BLOCK: samples published + unverified
```

- [ ] **Step 5: Commit.**

**✅ DONE 4.5**

---

### Task 4.6: Documentation

**Files:**

- Modify: `docs/BUILD_SPEC.md`, `docs/LAUNCH_CHECKLIST.md`, `CLAUDE.md`, `README.md`

Task 7A plus the documentation debts this plan incurred. **Document only — build none of these.**

- [ ] **Step 1: BUILD_SPEC roadmap notes (7A)** — add under the right weeks:
  - **Week 3** — "X slots left today" and "Next available date", from capacity (`tour_date_slots`).
  - **Week 3+** — real "booked this week" and guests-served from completed bookings; wire `tours.historical_trips_count` in as the baseline so the displayed total is history + live bookings (D8).
  - **Pricing engine** — peak and holiday pricing.
  - **Phase 2 upsell** — travel guides / blog for SEO.
  - **Weeks 5–7** — admin editing screens for every content block in this plan: announcement, hero, promo, business hours, payment methods, permits, how-it-works, why-book-direct, FAQ, contact, legal markdown, and per-tour featured/sort/badge/alert-note.

- [ ] **Step 2: BUILD_SPEC 2D note (D5)** — in Week 2's 2D entry, add: "When the tour and package detail pages are built, add their URLs to `/sitemap.xml` in the same task — `server/src/seo/sitemap.ts` already filters by `is_active` and has the lines commented out."

- [ ] **Step 3: BUILD_SPEC + LAUNCH_CHECKLIST post-launch note (D10)** — "Once the coming-soon page is retired, remove the contact constants from `client/src/lib/site.ts` and delete `scripts/check-contact-parity.mjs`, so `settings.contact` becomes the single, admin-editable source of truth."

- [ ] **Step 4: Purge and correct the ✅ DONE markers across the whole of BUILD_SPEC §13.**

  BUILD_SPEC §13 carries `✅ DONE` on tasks that were never built — the markers came from the template, not from an audit. **Remove every one of them**, then re-add `✅ DONE` only to tasks that are genuinely complete and verifiable in the repo today.

  Method, so this is evidence-based rather than guesswork:
  1. Strip all `✅ DONE` / `✅ WEEK X COMPLETE` markers from §13.
  2. Walk every task in §13 and check it against the actual tree (`git ls-files`, the test suite, the running app). A task counts as done only if the code exists and its tests pass.
  3. Re-add `✅ DONE` to exactly those, and `✅ WEEK X COMPLETE` only where every task in that week is done.
  4. Add a one-line note under the §13 heading: _"Markers audited and corrected 2026-10-09 — the previous ✅ DONE marks were template defaults, not completion records."_

  Expected outcome after this plan lands (verify, do not assume): Week 1 **1A**, **1B**, **1D**, **1E** done; **1C** (auth) **not** done. Week 2 **2A**, **2B**, **2C**, **2E** done; **2D** (tour detail page) **not** done. Weeks 3–8 entirely not done. No week earns `✅ WEEK X COMPLETE`.

- [ ] **Step 5: LAUNCH_CHECKLIST additions (D2, D9)** — under "Placeholder content must be gone":
  - [ ] Delete or unpublish every `is_sample` review. The build guard blocks a production build while any remains.
  - [ ] Client supplies real tours, prices and descriptions, then set `settings.content_unverified = false`. The build guard blocks a production build while it is true.
  - Replace the now-stale bullet about `client/src/lib/placeholder-data.ts` being deleted with the new arrangement.

- [ ] **Step 6: README** — add the migrate / seed / run commands from the final summary.

- [ ] **Step 7: Commit.**

```bash
git commit -m "docs: roadmap notes, corrected week markers, and the new launch gates"
```

**✅ DONE 4.6** (covers task 7A)

---

### Task 4.7: Final verification, push and handover

- [ ] **Step 1: Run all five commands in order.** Paste the real output into the summary — never report an unrun command.

- [ ] **Step 2: Confirm the full 8A test checklist is covered.** Walk the list and name the test file for each:
      procedure shapes · mutation rejection · rate limit · home renders from API · DB-name guard ·
      meta tags and canonical per route · JSON-LD parses · sitemap lists only active items ·
      robots switches on `SITE_ENV` · `is_sample` excluded from `AggregateRating` ·
      announcement and promo windows including Manila midnight · open/closed computation ·
      disabled payment methods hidden.

- [ ] **Step 3: Push.** `git push origin main`

- [ ] **Step 4: Produce the handover**, in the final message:
  - Commits as `hash - short label`.
  - Exact migrate / seed / run commands.
  - **The exact production-ready `CREATE TABLE` SQL for every table**, taken from the generated migration (not hand-written), so it can be applied on the server later.
  - What 5E changed, with the explicit statement that no Lighthouse scores were measured (D4).
  - Any unrelated bugs found, listed, not fixed.

- [ ] **Step 5: Write ✅ DYNAMIC SITE + SEO COMPLETE.**

**✅ PHASE 4 COMPLETE**

---

## Self-review

**Spec coverage.** Every task in the prompt maps to a task here:

| Prompt task                       | Plan task                          |
| --------------------------------- | ---------------------------------- |
| 1A DB connection + guard          | 1.1                                |
| 1B Drizzle schema                 | 1.2 (+ 1.3 settings)               |
| 1C Migration + seed               | 1.2, 1.4                           |
| 2A Public queries                 | 1.6                                |
| 2B Mutations + rate limit         | 1.7                                |
| 3A React Query + skeletons        | 2.1, 2.2, 2.4–2.6                  |
| 3B Hidden booking counters        | 2.3                                |
| 3C Forms wired                    | 3.5                                |
| 4A Delete placeholder-data        | 3.7                                |
| 5A SEO fields + fallbacks         | 1.2 (columns), 4.1 (fallbacks)     |
| 5B Meta injection + 404           | 4.1                                |
| 5C JSON-LD                        | 4.2                                |
| 5D Sitemap, robots, headers       | 4.3                                |
| 5E Performance                    | 4.4                                |
| 6A Announcement bar               | 3.1                                |
| 6B Hero content                   | 2.6                                |
| 6C Promo band                     | 3.2                                |
| 6D Tour featured/sort/badge/alert | 1.2, 1.6, 2.3, 2.4                 |
| 6E Business hours                 | 1.5, 3.4                           |
| 6F Payment methods                | 3.4                                |
| 6G Permits                        | 3.4                                |
| 6H Content blocks                 | 3.3, 3.4                           |
| 6I Privacy + terms                | 3.6                                |
| 6J Chip row padding               | 2.7                                |
| 7A Roadmap notes                  | 4.6                                |
| 8A Tests                          | distributed; audited in 4.7 Step 2 |

**Known gaps, stated rather than hidden:**

- `tours.bySlug` and the `/tours/:slug` resolver are built and tested but render no page (D5, agreed).
- No Lighthouse scores (D4, agreed).
- `bookedThisWeek` and `tripsRun` are hardcoded 0/NULL until the bookings table exists in Week 3 (D8, agreed).
- `shared` gains a test runner in Task 2.3; that is a new `vitest` devDependency in a workspace that had none. It is the same version already used by `client` and `server`, not a new library.

**Type consistency.** `TourListItem`, `SettingsPayload`, `PageMeta`, `Aggregate`, `Resolver` are defined once in the **API surface** and **Phase 4** sections and referenced by those exact names throughout. `formatPeso` is defined in Task 2.3 and used in Tasks 4.1 and 4.2. `describeWithDb` is defined in Task 1.6 and used in Tasks 1.7 and 4.1. `isWithinWindow` is defined in Task 1.5 and used in Task 3.1.

**Risk register:**

| Risk                                                                           | Mitigation                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Vite config importing server DB code slows dev start or crashes the dev server | Dynamic import inside `configureServer` only; the middleware swallows errors and calls `next()` (Task 4.1 Step 6) |
| DB-backed tests fail on a machine without MySQL                                | `describeWithDb` skips with a warning (Testing strategy)                                                          |
| Seeded tier prices change the displayed "from" figure                          | Task 1.4 Step 3 pins the lowest tier to today's exact value                                                       |
| The page drifts visually during the swap                                       | Before/after screenshots are an explicit step in Phases 2 and 3                                                   |
| Contact values drift between `site.ts`, the seed and the coming-soon page      | Task 1.4's parity test, plus the untouched existing guard                                                         |
