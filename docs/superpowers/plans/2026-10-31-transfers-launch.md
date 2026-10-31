# Van & SUV Transfers Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan requires owner approval before execution begins — see the owner decisions and QUESTIONS sections below.**

**Goal:** Make private van/SUV **transfers** (airport one-way, day-use, custom trip request) the product R&G launches with, built on top of the existing tours/booking/dispatch/driver/admin machinery, while **tours stay fully built but hidden** behind a settings switch the owner can flip on later with no further build.

**Architecture:** Transfers are a second **product type** on the existing `bookings` row, not a parallel system. `bookings.tour_id` becomes nullable and a new `product_type` column (`tour` / `transfer_one_way` / `transfer_day_use`) discriminates the two. A transfer booking carries a `route_id` (→ a new `transfer_routes` table, itself anchored on the existing `destinations` table — no duplicate place names) and a `vehicle_type_requested` (`van`/`suv`). Everything downstream — statuses, holds, deposit + driver-cash payment, check-ins, refunds, audit log, reviews, driver portal, admin bookings/dispatch/reports — keeps working on the same `bookings` row with no rewrite, only additive reads that branch on `product_type`. Vehicle availability reuses the exact fleet-lock pattern (`fleet_date_slots` → a new `transfer_date_slots` row, mirroring `tour_date_slots`) rather than inventing new concurrency machinery. Tours hide behind a new `show_tours` settings boolean, read the same way `content_unverified` already gates indexing — no new gating mechanism, just a second, independent gate.

**Tech Stack:** React + TypeScript + Vite + Tailwind v4 + shadcn/ui + React Router · Express + tRPC · Drizzle + MySQL 8 · Zod (shared) · scrypt sessions · PayMongo · node-cron · PM2. **No new libraries.**

**Spec:** `docs/BUILD_SPEC.md` — §5 (pricing/capacity/holds), §6 (checkout/payments), §8 (driver portal), §9 (admin/dispatch/roles), §10 (schema), §11 (notifications). The spec currently says (line 64) "Business: Day tours + multi-day packages (**not van rentals**)" — **this plan supersedes that line by the owner's 2026-10-28 decision below; Task T1 corrects the spec text in the same commit that records the decision**, per CLAUDE.md's "stale prose describing a now-fixed/changed decision gets corrected in the same commit" convention.

**Base commit:** `0035a72` on `main`, clean tree.

---

## Owner decisions, recorded 2026-10-28

1. **Three transfer products**, all private vehicle + driver, no shared/joiner departures:
   a. **Airport transfer** — one-way, either direction (airport→destination or destination→airport).
   b. **Day use** — same-day round trip: vehicle + driver to a destination and back.
   c. **Custom trip request** — guest sends route/date/group/notes as a lead; staff reply with a quote off-system. Reuses the existing inquiries area.
2. Price is **per vehicle, per route, per product type**. Admin manages routes/destinations (Moalboal, Oslob, Badian/Kawasan, Alegria, Argao/Dalaguete, Hagnaya Port, Maya Port, Cebu City, …) with a one-way price and a day-use price **for each vehicle type**. Admin can change prices anytime; price is **locked on the booking at hold time**. Server computes all money, centavos only. No competitor text/photos/prices copied.
3. Vehicle types: **VAN** and **SUV**, each with seat and luggage capacity. Fleet vehicles get a type. Guest picks the type; only types that fit passengers/luggage are offered.
4. Payment: deposit (online or QR transfer, as today) + balance in cash to the driver — the **existing** deposit/driver-cash flow, unchanged. No new payment path. Existing ₱100 gateway minimum and ₱0-booking refusals apply unchanged.
5. Guest fields: transfer type, route, date, pickup time, passengers, luggage count, pickup address/hotel, drop-off address, flight number + airline (airport transfers only), notes. Friendly per-field validation via the existing `field-errors.ts` helper.
6. Inclusions/exclusions (vehicle, driver, fuel, tolls included; ferry tickets, entrance fees excluded) are admin-editable text **per route**, not hard-coded.
7. Settings switch **"Show tours on the website"**, default **OFF**. OFF: tour catalog, tour detail, tour nav links, tour cards and the tour sitemap entries are hidden, **and the server refuses new tour holds**. Existing tour bookings and admin tour editing keep working regardless of the switch. ON: everything as today.
8. Home page leads with transfers: choose type → route → date → passengers → see vehicle options with prices. `frontend-design` + `ui-ux-pro-max`, 360px first.

These decisions **supersede** the pre-launch-fixes batch's "do not build van transfers" constraint (`docs/superpowers/plans/2026-10-30-prelaunch-fixes.md`'s Global Constraints line) and the spec's "not van rentals" line (§1, line 64) — both are artifacts of a pre-pivot plan, corrected by Task T1.

---

## Global Constraints

Every task's requirements implicitly include this section, copied from `CLAUDE.md` and sharpened for this plan.

- **Money is integers in centavos everywhere.** The server computes every total, deposit and discount; the browser sends only the guest's choices (route, vehicle type, date, pax). `bookings.amount_paid_centavos` is written **only** by the two allow-listed functions in `server/src/services/payments/record-payment.ts` (`CREDITING_FUNCTIONS` in `schema-conventions.test.ts`) — this plan adds none.
- **A refund is never a subtraction.** Unchanged for transfers: a separate positive `payments` row, `type = 'refund'`.
- **Soft deletes only.** `transfer_routes`, `transfer_route_vehicle_prices` rows deactivate (`is_active`), never delete. Vans/drivers already soft-delete.
- **`audit_log` on every money movement, status change, assignment, and price change** — a route price edit audits exactly like a tour price edit does today.
- **Price-at-booking.** A transfer's price snapshot freezes the vehicle type, route, product type, the price used, the deposit percent and the route's free-cancellation window, in `bookings.price_snapshot` — identical contract to tours' snapshot, so refund/cancellation logic needs no branch to read it.
- **NO RED anywhere.** Guard tests (`no-red.test.ts`, `contrast.test.ts`) apply to every new screen.
- **Mobile-first at 360px**, 44px tap targets, visible focus, AA contrast, alt text.
- **Store UTC, compute business dates/times in Asia/Manila.** A transfer's `pickup_time` is a civil time-of-day **label** (`"HH:mm"` string) for the driver to read, like a civil date is a string — it is never used in timezone arithmetic and never feeds the capacity lock (see Availability below).
- **Zod on every input, shared from `/shared`.** No form shows raw Zod JSON — reuse `client/src/lib/field-errors.ts`.
- **Every admin procedure is an `adminProcedure(area)`.** This plan adds **zero new `ROLE_MATRIX` areas** — see the Admin & roles section for why the existing areas already cover every new screen. That also means **no edit to `docs/BUILD_SPEC.md`'s §9 role table or `role-isolation.test.ts`'s pinned counts is needed** — confirm this remains true before shipping; if a task discovers it needs a new area, stop and ask rather than widening one of the existing seven silently.
- **No new npm libraries.** Ports 5180/3100 only. Never touch Kong PMS, production, the VPS, or `C:\dev\travelsugbo-explainer`.
- **Every task:** `✅ DONE` immediately on finishing · its own commit · all five checks with exit codes (`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`) · every new test proven able to fail · leak detector silent · browser check at 1440px and 360px where client-facing.
- **A schema-changing task reminds the owner to apply the migration to the server database** (per `CLAUDE.md`'s standing instruction) and to run the same migration against `rg_travel_test` locally before any test touches the new columns.
- **Unrelated bugs found along the way:** finish the task, list the bug, don't fix it unless it blocks the task — except the two correctness bugs this plan's design work already found and is therefore in scope to fix (see "Must-fix while here," below).

### Must-fix while here (found during this plan's research, not optional)

1. **`server/src/services/reports/money.ts:317`** — `outstandingBookings()` does `INNER JOIN tours`. Once `bookings.tour_id` is nullable, this silently **drops every transfer booking from "still to collect"** — real money a finance user would stop seeing. Must become a `LEFT JOIN` with a title fallback (the pattern at `revenueByTour`'s `titles.get(...) ?? 'Tour #' + id` already shows the shape; the transfer equivalent reads the route name). This is a **money-visibility bug**, not a style note — it is Task T16's first acceptance criterion, not an afterthought.
2. Any other `innerJoin(tours, ...)` or `eq(tours.id, bookings.tourId)` across `server/src/` must be audited the same way once `tour_id` is nullable: grep for both and classify each as "tour-only, correctly excludes transfers" (e.g. `revenueByTour` itself — fine, it's a tour-specific report) or "must handle `tour_id IS NULL`" (fix). This audit is Task T7's acceptance criterion, run immediately after the schema migration lands, before any later task can rely on "transfers are invisible to tour-shaped code paths" being safe.

---

## What already exists — reuse map (read before T2)

Measured at `0035a72`. Build on this; do not rebuild it.

| Capability | Where | Reused as-is for transfers? |
| --- | --- | --- |
| Booking statuses, hold expiry, capacity-holding set | `shared/src/booking.ts` `CAPACITY_HOLDING_STATUSES`; `bookings.status` | Yes, unchanged |
| Deposit math, ₱100 gateway floor, ₱0 refusal | `shared/src/money.ts` (`depositCentavos`, `PAYMONGO_MIN_CENTAVOS`), `shared/src/checkout.ts` (`gatewayMinimumMessage`) | Yes, called from the new transfer quote/hold functions |
| Online payment (PayMongo) + manual QR + driver cash | `checkout.ts` `startPayment`, `routers/webhooks`, `driver.recordCash`, `record-payment.ts` | Yes, unchanged — a transfer booking is a booking |
| Fleet-wide date lock, per-product date lock, lock ORDER | `fleet_date_slots(date)` → `tour_date_slots(tour_id, date)` → booking row | Pattern reused: add `transfer_date_slots(date, vehicle_type)` as the new per-product lock, taken in the same position as `tour_date_slots` (after fleet, before the booking row) |
| "Which van/driver are free on this date" | `server/src/services/dispatch/availability.ts` (`vansFreeOn`, `driversFreeOn`) | Yes, unchanged — it already excludes a van "assigned to another booking on this date whose status holds capacity," regardless of what kind of booking. No edit needed once `vans.vehicle_type` exists, because this module doesn't filter by type; the admin calendar's dropdown will show both types and the dispatcher picks one that fits |
| `assessCapacity` (tours' own group-per-day math) | `server/src/services/capacity.ts` | **Untouched.** It counts the whole sellable fleet regardless of vehicle type, exactly as it does today. A new, separate function handles transfer capacity — see Availability below |
| Driver login, lockout, sessions, PIN | Everything in "Driver portal (current state)" | Yes, unchanged |
| Check-in / trip_checkpoints, start/finish trip, `on_trip` van status | `server/src/services/trips/checkins.ts` | Reused, with one thing to verify in T13: a transfer booking has **zero** itinerary stops (no `tour_itinerary_stops` row, because `tour_id` is null), so the trip is "start" then "complete" with nothing in between — confirm `tripProgress`/`checkins.ts` already tolerates a booking whose stop count is 0 (the CLAUDE.md note on `tour_itinerary_stops` says a tour CAN ship zero stops in the test DB, so this path is believed to exist already; T13 proves it rather than assuming it) |
| Payment box, cash collection, refusal | `client/src/components/driver/PaymentBox.tsx`, `admin.bookings.rejectCash` | Yes, unchanged |
| Receipts, refunds, cancellation, coupon release | `server/src/services/dispatch/*`, `admin.refunds.cancelBooking` | Yes, unchanged — cancelling a transfer releases its van exactly like cancelling a tour does, because `releaseVanFromTrip` isn't tour-specific |
| Reviews, driver rating via `booking_id → driver_id` | `server/src/services/reviews/*` | Yes, unchanged — review submission never reads `tour_id` for the driver-rating path. A transfer *can* collect a review the same way; whether it should show a "tour" review form is Task T18 |
| Reports money math (`moneyMoved`, `bookingTotals`) | `server/src/services/reports/money.ts` | Confirmed tour-agnostic (no `tours` join) for the top-level summary. `outstandingBookings` is **not** — see Must-fix #1 |
| `admin.vans.*` CRUD | `server/src/routers/admin/vans.ts`, `client/src/pages/admin/AdminVansPage.tsx` | Extended with one new field (`vehicleType`), not replaced |
| `admin.packages.*` / `admin.inquiries.*` | `server/src/routers/admin/packages.ts` | Extended for the new inquiry type, not replaced |
| Settings read/write, `content_unverified`-style SEO gating | `server/src/content/settings*.ts`, `server/src/seo/resolvers.ts`, `sitemap.ts` | The `show_tours` gate is built as a **second, independent** gate next to `content_unverified`, reusing the identical mechanism (a boolean settings block, a cache, a resolver check, a sitemap filter) |
| Site/brand copy separation | `client/src/lib/site.ts` (`SITE.name` = TravelSugbo, `SITE.legalOperator` = R&G Travel & Tours) | Unchanged; transfer copy follows the same brand/legal split |

**Confirmed empty — zero `ROLE_MATRIX` changes needed.** `toursPricing` (owner-only) already reads "Tours, pricing, coupons" and covers transfer routes/prices by the same logic (money-sensitive, owner-only). `packagesInquiries` (owner + dispatcher) already covers the new inquiry type. `vansDrivers` (owner + dispatcher) already covers the vehicle-type field. `usersSettings` (owner-only) already covers the new settings block. This matters because §9's role table in `BUILD_SPEC.md` is parsed by `role-isolation.test.ts` with pinned counts (12 areas, 23 allowed, 13 denied) — adding a row would require editing the spec table, the mapping, and the counts together. **This plan needs none of that.**

---

## Architecture decisions

### 1. Schema: one `bookings` row, a discriminator, two new small tables, one child table

```
vans
  + vehicle_type  enum('van','suv')  NOT NULL DEFAULT 'van'   -- migration backfills every existing row to 'van'

transfer_routes                                    -- new table, anchored on the EXISTING destinations table
  id                    PK
  destination_id        FK -> destinations.id, UNIQUE   -- one transfer route per destination; no duplicate place names
  slug                  varchar(80) unique
  is_active             boolean default true
  sort_order            int
  estimated_duration_minutes  int
  free_cancel_hours     int               -- mirrors tours.free_cancel_hours; frozen into the booking's price snapshot
  inclusions_text       text
  exclusions_text       text
  created_at / updated_at

transfer_route_vehicle_prices                       -- new table, mirrors tour_price_tiers' role
  route_id              FK -> transfer_routes.id
  vehicle_type          enum('van','suv')
  one_way_price_centavos  int NOT NULL
  day_use_price_centavos  int NOT NULL
  PK (route_id, vehicle_type)

transfer_date_slots                                 -- new lock/count row, mirrors tour_date_slots exactly
  date                  date
  vehicle_type          enum('van','suv')
  PK (date, vehicle_type)

bookings
  tour_id               becomes NULLABLE (was NOT NULL)
  + product_type        enum('tour','transfer_one_way','transfer_day_use') NOT NULL DEFAULT 'tour'
  + route_id             FK -> transfer_routes.id, NULLABLE
  + vehicle_type_requested  enum('van','suv'), NULLABLE
  + CHECK (                                          -- mirrors the coupons CHECK-mirrored-by-Zod pattern
      (product_type = 'tour' AND tour_id IS NOT NULL AND route_id IS NULL AND vehicle_type_requested IS NULL)
      OR
      (product_type <> 'tour' AND tour_id IS NULL AND route_id IS NOT NULL AND vehicle_type_requested IS NOT NULL)
    )

booking_transfer_details                            -- new 1:1 child table (pattern: booking_notes, booking_addons)
  booking_id            PK, FK -> bookings.id
  pickup_time           varchar(5)   -- "HH:mm", civil label only, never parsed as a timezone instant
  dropoff_address        varchar(400) NOT NULL
  dropoff_map_url         varchar(500)
  luggage_count          int NOT NULL default 0
  flight_number          varchar(20)   -- airport transfers only; null for day-use
  airline                varchar(80)   -- airport transfers only; null for day-use
  created_at / updated_at

inquiries
  type enum gains 'transfer_custom'
  + requested_date       date, nullable
  + pax                  int, nullable
  + route_description    varchar(300), nullable
```

**What is deliberately reused, not duplicated:**
- `bookings.pickup` / `pickup_map_url` already exist and serve the transfer's pickup address/map link — no new column.
- `bookings.requests` already exists (free text) and serves "notes" — no new column.
- `destinations` already exists and is not duplicated by `transfer_routes` — the new table only adds the transfer-specific attributes a destination doesn't have (duration, route-level cancellation window, inclusions/exclusions, pricing).
- `price_snapshot` (JSON) already exists on `bookings` and takes the same shape discipline tours use — no new money column.

**Migration numbers.** Next is `0015` (`0014_hot_the_stranger.sql` is the newest on disk). Each schema-changing task below runs `pnpm --filter @rg/server db:generate` once, in task order, so the exact mapping (0015 → vans.vehicle_type, 0016 → transfer_routes + prices, 0017 → transfer_date_slots, 0018 → bookings columns + CHECK, 0019 → booking_transfer_details, 0020 → inquiries columns) is fixed by execution order, not by this document. **Every one of these six migrations must be applied to both `rg_travel` and `rg_travel_test`, and the owner reminded to apply each to the server database at next deploy** — do not batch them into one migration file; Drizzle generates one per `db:generate` run and this plan does not override that.

### 2. Availability: whole-day vehicle blocking (recommended default), not time-window overlap

The owner's prompt asks for a real design choice here, so here is the actual tradeoff:

**Option A — whole-day block (recommended for launch).** A transfer, one-way OR day-use, consumes **one vehicle of the requested type for the entire civil day**, exactly like a tour consumes one van for the day today. A one-way transfer that physically only takes two hours still occupies that vehicle's whole day in the booking system. This is conservative (undersells real fleet throughput) but requires **zero new interval/overlap logic** — it reuses the identical per-day counting shape `tour_date_slots` already uses, just keyed by `vehicle_type` instead of `tour_id`:

```
transferCapacity(vehicleType, date, now):
  lock fleet_date_slots(date)                         -- same global lock, same order, first
  lock transfer_date_slots(date, vehicleType)          -- created on demand, mirrors tour_date_slots
  sellable = COUNT(vans WHERE is_active AND status = VAN_STATUS_SELLABLE AND vehicle_type = :vehicleType)
  booked   = COUNT(bookings WHERE tour_date = :date AND vehicle_type_requested = :vehicleType
                             AND status IN CAPACITY_HOLDING_STATUSES)
  allowed  = booked < sellable
```

**Known, accepted gap at launch:** this formula does **not** subtract tour bookings from the transfer pool or vice versa, even though both draw from the same physical fleet. Since tours ship **hidden** at launch (`show_tours = false`), this gap is inert on day one — every vehicle effectively serves transfers only. It only becomes a real double-booking risk the day the owner flips `show_tours` back on *and* tours and transfers are both actively taking bookings against the same physical vans. That is flagged in QUESTIONS below rather than solved speculatively now (YAGNI) — solving it precisely would require either (a) letting `assessCapacity` and the new transfer function share one fleet-wide counter keyed by vehicle type (a real redesign of `assessCapacity`, which `CLAUDE.md` explicitly says not to loosen casually — "the test database keeps an EMPTY fleet... do not loosen that assertion to fit a seed"), or (b) the owner manually partitioning the fleet into a "tours reserve" vs "transfers pool" via vehicle tagging, which needs its own decision.

**Option B — time-window overlap** (duration + a configurable buffer between jobs, true multi-trip-per-vehicle-per-day scheduling) is more accurate and more complex: it needs an interval-overlap query (not a simple COUNT) and a real decision on buffer minutes, which the owner has not given. **Not built in this plan.** If the owner wants it, it is a follow-up plan, not a task added here under time pressure.

### 3. Quote & hold: parallel procedures, not one unified function

`checkout.quote` / `checkout.createHold` for tours are already intricate (coupons, add-ons, tiers, the booking-window check, the ₱0/₱100 refusals). Rather than bolting a second shape onto that function with a growing set of "if transfer" branches, this plan adds **parallel, structurally similar** procedures — `checkout.quoteTransfer` and `checkout.createHoldTransfer` — that:
- call the **same** shared helpers (`depositCentavos`, `gatewayMinimumMessage`, `PAYMONGO_MIN_CENTAVOS`, `bookableDateRange()`, `generateBookingRef()`, coupon validation if a coupon is offered on a transfer — see QUESTIONS) rather than re-implementing any of them;
- write into the **same** `bookings` table, so every downstream admin/driver/reports/reviews/notify consumer needs no new type to understand, only a `product_type` branch where display copy differs;
- take the fleet lock in the same fixed global order (`fleet_date_slots` → `transfer_date_slots` → booking row) as tours take (`fleet_date_slots` → `tour_date_slots` → booking row) — never both locks in one transaction (a booking is either a tour or a transfer, never both), so there is no new deadlock surface to reason about between the two lock chains.

### 4. The `show_tours` switch: a second, independent gate next to `content_unverified`

Add `show_tours: z.boolean()` to `SETTING_SCHEMAS` (default `false` in `SEED_SETTINGS`) — same shape as `content_unverified`'s own bare-boolean block, same writer (`writeSettingBlock`), same reader pattern (`readSettingBlock('show_tours')`). Exposed on `SettingsPayload` as `showTours`, computed server-side exactly like `onlinePaymentEnabled` is — the client never re-derives it.

Consulted in four places, each additive:
- `tours.list` / `tours.bySlug` (public router): return `[]` / refuse `NOT_FOUND` when `showTours` is false. The server is the authority — "hidden" means a guest cannot reach tour data through any public procedure, not merely that a nav link is missing.
- `checkout.quote` / `checkout.createHold` (tours): refuse with a clear, friendly, guest-safe message when `showTours` is false — this is "the server refuses new tour holds" from the owner's decision, word for word.
- `server/src/seo/resolvers.ts`: `/tours`, `/tours/:slug` resolve `noindex,nofollow` when `showTours` is false, **independently of `content_unverified`** — the same two-gates-both-fail-closed shape the spec already documents for `content_unverified` + `SITE_ENV`.
- `server/src/seo/sitemap.ts`: tour/package detail URLs are dropped from the sitemap when `showTours` is false (packages are unaffected — packages are not tours and the owner's decision does not mention hiding them).
- Client: `HomePage`, the header nav, and `TourCard`/catalog links read `settings.showTours` and render nothing when false — cosmetic, and explicitly **not** the access control (the server-side refusals above are).

**Admin tour editing is NOT gated by `show_tours`.** `admin.tours.*` stays reachable to the owner regardless of the switch, per the owner's explicit "admin tour editing keep[s] working" instruction — this is the one place the plan deliberately does *not* add a check.

### 5. Admin & roles: no new `ROLE_MATRIX` area (see reuse map above)

- **Routes & prices:** new `admin.transferRoutes.*` router, gated `adminProcedure('toursPricing')` — owner-only, same area as tour pricing and coupons.
- **Vehicle type on vans:** one new field on the existing `admin.vans.update` input, gated `adminProcedure('vansDrivers')` — unchanged area.
- **The tours switch:** one more block in the existing `admin.settings.*` writer, gated `adminProcedure('usersSettings')` — unchanged area.
- **Custom trip request quoting:** extended `admin.inquiries.*`, gated `adminProcedure('packagesInquiries')` — unchanged area.

### 6. Custom Trip Request: lead capture only, with an honest limit (see QUESTIONS)

There is no "admin creates a booking manually" capability anywhere in the codebase today (`server/src/routers/admin/` has no `bookings.create`). Building one is real new scope (a staff-priced, still-centavos, still-audited booking-creation path) that the owner's prompt did not ask for. So for this plan: a custom trip request becomes an `inquiries` row (`type = 'transfer_custom'`) with `requestedDate`/`pax`/`routeDescription`/`message`; staff reply with a quote **off-system** (phone, email, or the existing WhatsApp/Viber deep links), exactly as the owner's prompt describes ("staff reply with a quote"). If the guest accepts and the trip maps to one of R&G's standard routes, staff point them at that route's normal booking flow. **If it doesn't map to a standard route (a genuinely custom multi-stop itinerary), there is currently no in-system way to turn that into a trackable, paid, audited booking** — this is called out explicitly in QUESTIONS rather than silently worked around.

---

## File Structure

**New server files**

| File | Responsibility |
| --- | --- |
| `server/src/services/transfers/pricing.ts` | `quoteTransfer()` — the one place a transfer's subtotal/discount/total/deposit is computed, mirroring `services/checkout`'s tour pricing shape |
| `server/src/services/transfers/capacity.ts` | `assessTransferCapacity()` — the whole-day vehicle-type counting formula (Architecture §2), taking the fleet lock then `transfer_date_slots` |
| `server/src/routers/public/transfers.ts` | `transferRoutes.list` (public, for the home-page picker and route pages) |
| `server/src/routers/admin/transfer-routes.ts` | `admin.transferRoutes.*` — CRUD over routes + their per-vehicle-type prices |
| `server/src/services/transfers/upsert-route.ts` | The transactional write for a route plus its two price rows |

**Modified server files** (additive branches, not rewrites)

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | Six schema changes from Architecture §1 |
| `server/src/routers/public/checkout.ts` | + `quoteTransfer`, `createHoldTransfer` procedures (new exports, existing tour procedures untouched) |
| `server/src/routers/admin/vans.ts` | `vehicleType` added to the update/create input |
| `server/src/routers/admin/packages.ts` | Inquiries list/detail handle `type = 'transfer_custom'` fields |
| `server/src/content/settings-schema.ts` | `show_tours: z.boolean()` added to `SETTING_SCHEMAS` |
| `server/src/routers/public/tours.ts` | `showTours` refusal branch on `list`/`bySlug` |
| `server/src/seo/resolvers.ts`, `server/src/seo/sitemap.ts` | `showTours` gate, independent of `content_unverified` |
| `server/src/services/reports/money.ts` | Must-fix #1 (`outstandingBookings` → LEFT JOIN); new `revenueByRoute()` parallel to `revenueByTour()` |
| `server/src/routers/public/driver.ts`, `shared/src/driver.ts` | `TripDetail` carries the transfer fields (pickup time, luggage, flight info, dropoff) when `productType !== 'tour'` |
| `server/src/services/notify/templates.ts` | Existing `NotifyPayload` fields (`tourTitle`, `tourDate`) populated with the route name/date for a transfer booking — no new template keys unless T19 finds a genuine copy mismatch |

**New client files**

| File | Responsibility |
| --- | --- |
| `client/src/pages/public/TransferBookingPage.tsx` | The transfer picker + vehicle-option + quote flow (home page leads here per owner decision 8) |
| `client/src/components/transfer/TransferTypePicker.tsx` | Airport / day-use / custom-request chooser |
| `client/src/components/transfer/RoutePicker.tsx` | Destination/route selector, reusing the existing `destinations` data |
| `client/src/components/transfer/VehicleOptionCard.tsx` | Van vs SUV, price, seat/luggage capacity, selection |
| `client/src/components/transfer/TransferGuestDetailsForm.tsx` | Pickup time, luggage, addresses, flight/airline (conditional), notes |
| `client/src/pages/admin/AdminTransferRoutesPage.tsx` | Routes + per-vehicle-type prices + inclusions/exclusions editor |

**Modified client files**

| File | Change |
| --- | --- |
| `client/src/pages/public/HomePage.tsx`, `client/src/components/layout/*` | Transfer-first hero; tour nav/cards gated on `settings.showTours` |
| `client/src/pages/portal/*` (My Booking) | Transfer-specific fields rendered when `productType !== 'tour'` |
| `client/src/pages/admin/AdminBookingsPage.tsx`, `AdminBookingDetailPage.tsx` | Product-type column/badge; transfer fields in the detail view |
| `client/src/pages/admin/AdminCalendarPage.tsx`, `AdminDeparturesPage.tsx` | Transfers appear alongside tours; vehicle-type badge |
| `client/src/pages/admin/AdminVansPage.tsx` | Vehicle-type field |
| `client/src/pages/admin/AdminSettingsPage.tsx` | "Show tours on the website" toggle |
| `client/src/pages/admin/AdminPackagesPage.tsx` | Custom-trip-request fields in the inquiries list/detail |
| `client/src/pages/admin/AdminReportsPage.tsx` | Revenue-by-route table + CSV, alongside revenue-by-tour |
| `client/src/pages/driver/*` | Pickup time, luggage, dropoff address, flight/airline shown on a transfer trip |

**Shared**

| File | Responsibility |
| --- | --- |
| `shared/src/transfers.ts` | `VEHICLE_TYPES`, Zod inputs for quote/hold/route-admin, the transfer detail/quote result types |

---

## Tasks

Batches of ~4. **Schema tasks (T2–T6) are strictly sequential** (each migration depends on the schema.ts state the last one left); UI tasks within a batch can run in parallel across different files once their schema dependency has landed. Model: **Sonnet** for UI/cleanup/admin-CRUD-plumbing, **Opus** for anything touching money, availability/locking, or schema. Review: **own dedicated Opus reviewer** for every money/availability/schema task, matching this project's standing rule; combined review for pure-UI tasks.

### Batch 1 — Spec correction, vehicle types, routes & pricing schema

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T1** | Correct `BUILD_SPEC.md` line 64 ("not van rentals") and record the 2026-10-28 owner decision in the spec's decision log; correct `docs/superpowers/plans/2026-10-30-prelaunch-fixes.md`'s now-superseded "do not build van transfers" line with a pointer to this plan | Sonnet | No | combined |
| **T2** | `vans.vehicle_type` column + migration; `admin.vans.*` accepts/returns it; `AdminVansPage.tsx` gets the field | Sonnet | **Yes** | combined (schema is additive/low-risk: one nullable-free enum with a safe default, no money, no lock) |
| **T3** | `transfer_routes` + `transfer_route_vehicle_prices` tables + migration; `server/src/services/transfers/upsert-route.ts` (transactional write, mirrors `services/tours/upsert.ts`'s pattern); `admin.transferRoutes.*` router (`toursPricing` area) | **Opus** | **Yes** | dedicated Opus (money: prices) |
| **T4** | `AdminTransferRoutesPage.tsx` — list + editor for routes, their two per-vehicle-type prices, inclusions/exclusions text, active toggle | Sonnet | No | combined |

### Batch 2 — `bookings` schema, availability, pricing/quote core

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T5** | `bookings.tour_id` nullable + `product_type`/`route_id`/`vehicle_type_requested` columns + CHECK constraint + migration; `booking_transfer_details` table + migration | **Opus** | **Yes** | dedicated Opus (changes the central money/booking table; the CHECK constraint is the load-bearing invariant) |
| **T6** | **Must-fix audit** (Global Constraints): grep every `tours` join/reference to `bookings.tourId` in `server/src/`, classify each, fix every one that must handle `tour_id IS NULL` (starting with `outstandingBookings`, `money.ts:317`) | **Opus** | No | dedicated Opus (money correctness) |
| **T7** | `transfer_date_slots` table + migration; `server/src/services/transfers/capacity.ts` (`assessTransferCapacity`), unit-tested for the exact concurrency race `capacity.test.ts` already proves for tours (two guests, one slot, one wins) | **Opus** | **Yes** | dedicated Opus (locking/concurrency) |
| **T8** | `server/src/services/transfers/pricing.ts` (`quoteTransfer`) — subtotal/discount/total/deposit, the ₱100/₱0 refusals, the price snapshot shape; `checkout.quoteTransfer` procedure | **Opus** | No | dedicated Opus (money) |

### Batch 3 — Hold creation, public booking UI, home page

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T9** | `checkout.createHoldTransfer` — takes the fleet lock then `transfer_date_slots`, re-checks capacity and the booking window inside the lock, writes the booking + `booking_transfer_details` row in one transaction, generates the ref via the existing `generateBookingRef()` | **Opus** | No | dedicated Opus (money + concurrency) |
| **T10** | `shared/src/transfers.ts` — Zod inputs for quote/hold (route, product type, vehicle type, date, pax, luggage, pickup time, addresses, flight/airline conditional on airport transfers), friendly messages via the field-errors pattern | Sonnet | No | combined |
| **T11** | `TransferTypePicker`, `RoutePicker`, `VehicleOptionCard`, `TransferGuestDetailsForm` components; the quote-and-hold flow calling T9/T8 | Sonnet | No | combined |
| **T12** | `TransferBookingPage.tsx` wired into the home page per owner decision 8 (type → route → date → passengers → vehicle options with prices); nav/home updated to lead with transfers | Sonnet | No | combined |

### Batch 4 — Tours-hidden switch, admin settings, inquiries extension

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T13** | `show_tours` settings block + `SettingsPayload.showTours`; `tours.list`/`bySlug` refusal; `checkout.quote`/`createHold` (tours) refusal; SEO resolver + sitemap gate | **Opus** | No | dedicated Opus (a money/booking-refusal gate + an SEO gate, both fail-closed-sensitive) |
| **T14** | Client: `AdminSettingsPage.tsx` toggle; home/nav/catalog hide tour surfaces when off; **regression proof**: existing tour tests stay green with `show_tours = true` (the seed default once this ships), and a new test proves every hidden surface with `show_tours = false` | Sonnet | No | combined |
| **T15** | `inquiries` schema extension (`transfer_custom` type + 3 nullable columns) + migration; `admin.inquiries.*`/`AdminPackagesPage.tsx` show the new fields; public inquiry form gains the "Custom trip request" option | Sonnet | **Yes** | combined (no money, no lock; schema is three nullable columns) |
| **T16** | Must-fix #1 verification + `revenueByRoute()` in `reports/money.ts`; `AdminReportsPage.tsx` revenue-by-route table + CSV, alongside revenue-by-tour | **Opus** | No | dedicated Opus (money) |

### Batch 5 — Driver portal, admin bookings/calendar, My Booking, notifications

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T17** | `TripDetail` (shared + `driver.ts`) carries transfer fields; driver portal trip screen renders pickup time, luggage, dropoff, flight/airline for a transfer; T13's zero-stops path confirmed structurally (not assumed) in `checkins.ts`/`tripProgress` | **Opus** | No | dedicated Opus (driver-portal data exposure touches the same role-isolation care as the rest of the driver portal) |
| **T18** | `AdminBookingsPage.tsx`/`AdminBookingDetailPage.tsx`/`AdminCalendarPage.tsx`/`AdminDeparturesPage.tsx` show product type, vehicle type requested, route, and the transfer-only guest fields | Sonnet | No | combined |
| **T19** | Portal (My Booking) renders transfer fields; `notify()` templates populate correctly for a transfer booking (route name where `tourTitle` was, no itinerary-stop language); review-request email copy checked for tour-only language | Sonnet | No | combined |
| **T20** | End-to-end regression proof: full test suite green, leak detector silent, a transfer booking walked through hold → deposit → assignment → check-ins (start + complete, no stops) → review-eligible, **and** a tour booking walked through the same lifecycle with `show_tours = true` to prove nothing broke | **Opus** (verification task) | No | dedicated Opus |

### Batch 6 — Content, legal, final polish

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| **T21** | Seed data: 2–3 real-named demo routes with both vehicle-type prices in `seedDemo` (dev-only, same upsert discipline as tours); placeholder imagery for transfer vehicle cards, same PLACEHOLDER-labelled gradient pattern as tours | Sonnet | No | combined |
| **T22** | `frontend-design` + `ui-ux-pro-max` pass on the transfer booking flow at 360px and 1440px — the home-page sequence is the highest-traffic surface in the whole relaunch | Sonnet | No | combined |
| **T23** | Legal/content to-dos filed as a checklist for the owner (see below) — **text not written by this task**, only the list of what must change | Sonnet | No | combined |
| **T24** | Full five-check pass across the whole batch, `docs/BUGS_LOG.md` updated for anything found, plan's "Execution status" section closed out | — (controller) | No | — |

---

## Legal & content to-dos for the owner (not written by this plan)

The Terms of Service / Refund policy / Privacy notice currently describe a tour business. Flag for the owner, as a to-do list, **not drafted here**:

1. **No-show / waiting-time policy** for airport transfers — how long does the driver wait at a canceled or delayed pickup before it counts as a no-show, and what (if anything) is forfeited.
2. **Flight-delay handling** — does a delayed flight automatically extend the free wait, and is there a cutoff.
3. **Luggage limits** — what happens if a guest's actual luggage exceeds what they declared and the vehicle genuinely can't fit it.
4. **Day-use overrun** — what happens if a day-use round trip runs past the agreed return time (driver overtime, additional charge, or absorbed).
5. **Cancellation window for transfers** specifically — the existing tour cancellation language (`free_cancel_hours`) needs a transfer-appropriate number and wording (see QUESTIONS, below — this is also a build question, not purely legal).
6. **"Operated by R&G Travel & Tours"** regulatory/accreditation language should be checked against transfer-specific DOT/LTFRB requirements if those differ from the tour operator permit already shown.

---

## Self-review

- **Spec coverage:** every owner decision (1–8) maps to at least one task above; §5/§6/§8/§9/§10/§11 of `BUILD_SPEC.md` are each touched by name in Architecture §1–6 and the task table.
- **Placeholder scan:** no task says "add validation" or "handle edge cases" without naming the edge case (the CHECK constraint, the ₱0/₱100 refusals, the zero-stops check-in path, the nullable-join audit are all named explicitly).
- **Type/name consistency:** `product_type`, `route_id`, `vehicle_type_requested`, `transfer_routes`, `transfer_route_vehicle_prices`, `transfer_date_slots`, `booking_transfer_details` are used identically everywhere they appear across Architecture and the task table.
- **Gap found and fixed during self-review:** the first draft of T9 did not say which lock order a transfer hold takes — corrected to match Architecture §3 explicitly (fleet → `transfer_date_slots`, never both chains in one transaction).

---

## ✅ TRANSFERS PLAN WRITTEN

| Task | Delivers | Model | Schema? | Review |
| --- | --- | --- | --- | --- |
| T1 | Spec/plan correction | Sonnet | No | combined |
| T2 | Van vehicle type | Sonnet | Yes | combined |
| T3 | Routes + prices schema/service/router | Opus | Yes | dedicated Opus |
| T4 | Admin routes/prices UI | Sonnet | No | combined |
| T5 | `bookings` + `booking_transfer_details` schema | Opus | Yes | dedicated Opus |
| T6 | Nullable-`tour_id` join audit | Opus | No | dedicated Opus |
| T7 | `transfer_date_slots` + capacity service | Opus | Yes | dedicated Opus |
| T8 | Transfer pricing/quote | Opus | No | dedicated Opus |
| T9 | Transfer hold creation | Opus | No | dedicated Opus |
| T10 | Shared transfer Zod inputs | Sonnet | No | combined |
| T11 | Booking-flow components | Sonnet | No | combined |
| T12 | Home page + transfer page | Sonnet | No | combined |
| T13 | `show_tours` gate (server) | Opus | No | dedicated Opus |
| T14 | `show_tours` gate (client) + regression | Sonnet | No | combined |
| T15 | Inquiries extension | Sonnet | Yes | combined |
| T16 | Reports money fix + revenue-by-route | Opus | No | dedicated Opus |
| T17 | Driver portal transfer fields | Opus | No | dedicated Opus |
| T18 | Admin bookings/calendar UI | Sonnet | No | combined |
| T19 | Portal + notifications | Sonnet | No | combined |
| T20 | End-to-end regression proof | Opus | No | dedicated Opus |
| T21 | Seed/placeholder content | Sonnet | No | combined |
| T22 | Design/UX pass | Sonnet | No | combined |
| T23 | Legal to-do list | Sonnet | No | combined |
| T24 | Final verification sweep | — | No | — |

---

## QUESTIONS FOR THE OWNER

1. **Booking lead time for airport transfers.** The existing tour booking window (`settings.booking`: `minLeadDays = 1`, `nextDayCutoffTime = "18:00"`) blocks same-day bookings entirely. Real airport-transfer demand is often same-day or next-flight. Should transfers use a **separate, shorter** lead-time setting (e.g. minimum 2–4 hours' notice), or share the tours window as-is for launch?
2. **Buffer / back-to-back jobs.** This plan's recommended default (Option A, Architecture §2) blocks a vehicle for the **whole day** per transfer, even a 2-hour airport run — simple, safe against double-booking, but wastes fleet capacity. Is that acceptable at launch volume, or is true time-window scheduling (Option B: duration + a buffer you specify in minutes) worth building as a fast follow-up before or shortly after launch?
3. **Night / late-flight surcharge.** Is there a surcharge for very early/late pickups, and if so is it per-route (another column on `transfer_route_vehicle_prices`) or a flat percentage?
4. **Free waiting time at pickup.** How many minutes does the driver wait free before a no-show applies (feeds to-do #1 above, and possibly a `free_wait_minutes` column)?
5. **Excess luggage.** Is there a hard per-vehicle-type luggage cap the guest selection enforces at booking time (blocking the SUV option if luggage count exceeds it), or is it handled by the driver on the day?
6. **Child seats.** Offered as a free inclusion, a paid add-on (reusing the existing `tour_addons`-style per-route add-on concept), or not offered at all for transfers?
7. **Minimum notice to book a day-use trip** — same question as Q1 but for the day-use product specifically, since it ties up a vehicle for a full day.
8. **Cancellation window for transfers.** What should `transfer_routes.free_cancel_hours` default to — the same value as tours, or a transfer-specific number (and does it differ between one-way and day-use)?
9. **Coupons on transfers.** Should the existing coupon system apply to transfer bookings at all, or are transfers deliberately coupon-free at launch (simpler quote function, one fewer interaction to test)?
10. **Custom Trip Request → real booking.** Confirmed in Architecture §6: there is no "staff creates a manual booking" feature today, so an accepted custom quote that doesn't match a standard route has no in-system way to become a trackable, paid, audited booking. Is that acceptable for launch (handled entirely off-system), or should a scoped "admin-priced manual booking" feature be added to this batch?
11. **Tours/transfers sharing the fleet once `show_tours` is flipped back on.** Architecture §2's accepted gap: once tours are live again, the whole-day-block formula doesn't cross-check against tour bookings on the same vehicle. Acceptable to revisit only when that day actually arrives, or should capacity-sharing be designed now even though it won't be exercised at launch?

Stopping here for approval, per the prompt. No code, schema, or test changes have been made; only this plan file exists on disk.
