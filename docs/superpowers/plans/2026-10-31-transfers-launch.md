# Van & SUV Transfers Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **✅ APPROVED by the owner, 2026-10-31 (commit `a119286`), subject to the driver-capacity addendum below, which must land in T7/T8 before T1 starts.**

**Revision log:** 2026-10-31 — owner answered the four open-design questions (availability model, notice window, coupons, custom-trip-request conversion) and gave defaults for the rest. This revision replaces the whole-day-block availability design with a time-window design, adds a staff-priced booking-conversion feature with a new role boundary, and renumbers tasks T1–T29 accordingly. See "Owner answers, 2026-10-31" below for the decisions and "What changed in this revision" for a diff against the first draft. **Second addendum, same day, after approval:** the owner added a driver-overwork guardrail (max transfer jobs per driver per day) — see "Owner decision, recorded 2026-10-31 (second round) — driver capacity" and "What changed in the driver-capacity addendum," both below. T7 and T8 are revised again to carry it; no other task changes.

**Goal:** Make private van/SUV **transfers** (airport one-way, day-use, custom trip request) the product R&G launches with, built on top of the existing tours/booking/dispatch/driver/admin machinery, while **tours stay fully built but hidden** behind a settings switch the owner can flip on later with no further build.

**Architecture:** Transfers are a second **product type** on the existing `bookings` row, not a parallel system. `bookings.tour_id` becomes nullable and a new `product_type` column (`tour` / `transfer_one_way` / `transfer_day_use`) discriminates the two. A transfer booking carries a `vehicle_type_requested` (`van`/`suv`) and, usually, a `route_id` (→ a new `transfer_routes` table anchored on the existing `destinations` table — a staff-created custom quote may instead carry a free-text route description with no catalog route at all). Everything downstream — statuses, holds, deposit + driver-cash payment, check-ins, refunds, audit log, reviews, driver portal, admin bookings/dispatch/reports — keeps working on the same `bookings` row with no rewrite, only additive reads that branch on `product_type`. **Vehicle availability is now time-window based** (revised in this round): a transfer blocks its vehicle type from pickup time to an estimated end plus an admin-configurable buffer, and a tour still blocks a vehicle for the whole civil day — both checked under the single existing `fleet_date_slots(date)` lock, using a standard interval-scheduling result (see Architecture §2) rather than a new per-vehicle schedule table. Tours hide behind a new `show_tours` settings boolean, read the same way `content_unverified` already gates indexing.

**Tech Stack:** React + TypeScript + Vite + Tailwind v4 + shadcn/ui + React Router · Express + tRPC · Drizzle + MySQL 8 · Zod (shared) · scrypt sessions · PayMongo · node-cron · PM2. **No new libraries.**

**Spec:** `docs/BUILD_SPEC.md` — §5 (pricing/capacity/holds), §6 (checkout/payments), §8 (driver portal), §9 (admin/dispatch/roles), §10 (schema), §11 (notifications). The spec currently says (line 64) "Business: Day tours + multi-day packages (**not van rentals**)" — **this plan supersedes that line; Task T1 corrects the spec text**.

**Base commit:** `0035a72` on `main`, clean tree. (Unchanged since the first draft — no code has been written yet.)

---

## What changed in this revision

1. **Availability (owner answer 1): time windows, not whole-day blocking.** Architecture §2 is rewritten. A transfer now blocks its vehicle type for `[pickup time, estimated end + buffer)`, not the whole day, and one vehicle can serve several jobs a day. This needed real design work — a peak-overlap (interval scheduling) feasibility rule — because tours (whole-day) and transfers (windowed) now share one fleet and must never conflict (owner answer 9). The separate `transfer_date_slots` lock table from the first draft is **removed** — the existing `fleet_date_slots(date)` lock is sufficient and is now the single serialization point for every capacity decision, tour or transfer, on a given date.
2. **`assessCapacity()` (tours) is no longer "untouched."** It gains one additive term: the pool of vehicles "available for a tour today" now subtracts whatever each vehicle type's transfer peak-overlap has already claimed. This is required by owner answer 9 and is new scope — Task T7.
3. **Dispatch-time assignment (`vansFreeOn`/`driversFreeOn`) also needs a window-aware change**, not just the hold-time pool math — once a specific van is actually assigned, two transfers on the same van the same day must not have overlapping windows, while a tour assigned to a van still excludes it for the whole day. New Task T8.
4. **Notice window (owner answer 2): a new, transfer-specific, hour-based minimum-notice setting** (default 6h, admin-editable), replacing tours' day-based `minLeadDays`/`cutoffTime` for the transfer path only. Tours are unchanged.
5. **Coupons (owner answer 3): now in scope**, using the existing `validateCoupon`/`recordRedemption`/`releaseRedemption` machinery and the existing ₱0/₱100 refusals, unchanged. Removed from QUESTIONS.
6. **Custom Trip Request → real booking (owner answer 4): new feature**, not a deferred limitation. Owner/finance can convert a custom-request inquiry into a real, staff-priced transfer booking; the guest then pays through the normal flow. This needs:
   - a new, shared `createTransferBooking()` service (Task T10) so the guest path and the staff path write the exact same booking shape through the exact same capacity check — no second code path to drift;
   - **one new `ROLE_MATRIX` area, `transferQuoting` (owner + finance only)** — the plan's first draft claimed zero new areas; that claim no longer holds, because "dispatcher can view the request but not set the price" is a real permission split the existing `packagesInquiries` (owner+dispatcher) area cannot express. `BUILD_SPEC.md`'s §9 table and `role-isolation.test.ts`'s pinned counts must be edited together, in the same commit, per that test's own convention (Task T19).
7. **Owner defaults recorded for the rest** (no automation needed): no night/late-flight surcharge; free-waiting-time stays Terms-page placeholder text, not code; excess luggage is enforced only by vehicle-type capacity (no surcharge logic); transfer cancellation window reuses the same Refund Policy placeholder tours already have. The legal to-do list is shorter as a result (see below).
8. Tasks renumbered **T1–T29** (was T1–T24) to fit the new scope. The model/schema/review table at the end is rebuilt from scratch — use it, not the first draft's.

## What changed in the driver-capacity addendum (same day, after approval)

9. **Drivers get their own capacity guardrail, separate from vehicles.** The plan's Architecture §2 covered vehicle (van/suv) capacity but never gave drivers their own cap beyond the pre-existing, binary "is a driver free that day" gate §5 already describes for tours. The owner's addendum adds a real per-day job cap per driver (default 2, per-driver override), enforced two ways: a simple job-count pool check at HOLD time (Architecture §2a, new), and a count-**and**-window overlap check at DISPATCH time (Task T8, extended). This surfaced a genuine gap in the first revision — drivers were implicitly assumed to have unlimited transfer jobs per day as long as "a driver is free," which was never actually true once transfers can be windowed.
10. **`drivers.max_transfer_jobs_per_day`** (nullable int, override) is a new column — **T7 is now a schema task** (it wasn't, in the previous revision). Migration numbering shifts: T17's inquiries migration moves from `0018` to `0019`.
11. **The feasibility math for drivers is a different, correct-by-exchange-argument formula from the vehicles' peak-overlap one** — drivers are a single, undifferentiated pool (no type), and the HOLD-time check is a job **count**, not a time-window peak (the owner's own wording: "driver capacity left that day," not "driver capacity free at this hour"). See Architecture §2a for the exact rule and why assigning tours to the _smallest_-cap drivers first is the provably optimal (not just "safe") choice.
12. `transfer_operations` gains a fourth field, `maxTransferJobsPerDriverPerDay` (default 2); `AdminDriversPage.tsx` gains the per-driver override field. Both fold into Task T16 (no new task needed for the UI half).

---

## Owner decisions, recorded 2026-10-28

1. **Three transfer products**, all private vehicle + driver, no shared/joiner departures:
   a. **Airport transfer** — one-way, either direction (airport→destination or destination→airport).
   b. **Day use** — same-day round trip: vehicle + driver to a destination and back.
   c. **Custom trip request** — guest sends route/date/group/notes as a lead; staff reply with a quote, **and can now convert it into a real booking** (owner answer 4, below).
2. Price is **per vehicle, per route, per product type**. Admin manages routes/destinations (Moalboal, Oslob, Badian/Kawasan, Alegria, Argao/Dalaguete, Hagnaya Port, Maya Port, Cebu City, …) with a one-way price and a day-use price **for each vehicle type**. Admin can change prices anytime; price is **locked on the booking at hold time**. Server computes all money, centavos only. No competitor text/photos/prices copied.
3. Vehicle types: **VAN** and **SUV**, each with seat and luggage capacity. Fleet vehicles get a type. Guest picks the type; only types that fit passengers/luggage are offered.
4. Payment: deposit (online or QR transfer, as today) + balance in cash to the driver — the **existing** deposit/driver-cash flow, unchanged. No new payment path. Existing ₱100 gateway minimum and ₱0-booking refusals apply unchanged.
5. Guest fields: transfer type, route, date, pickup time, passengers, luggage count, pickup address/hotel, drop-off address, flight number + airline (airport transfers only), notes. Friendly per-field validation via the existing `field-errors.ts` helper.
6. Inclusions/exclusions (vehicle, driver, fuel, tolls included; ferry tickets, entrance fees excluded) are admin-editable text **per route**, not hard-coded.
7. Settings switch **"Show tours on the website"**, default **OFF**. OFF: tour catalog, tour detail, tour nav links, tour cards and the tour sitemap entries are hidden, **and the server refuses new tour holds**. Existing tour bookings and admin tour editing keep working regardless of the switch. ON: everything as today.
8. Home page leads with transfers: choose type → route → date → passengers → see vehicle options with prices. `frontend-design` + `ui-ux-pro-max`, 360px first.

These decisions **supersede** the pre-launch-fixes batch's "do not build van transfers" constraint and the spec's "not van rentals" line (§1, line 64) — both corrected by Task T1.

## Owner answers, recorded 2026-10-31

1. **Availability: time windows, not whole-day.** A transfer blocks its vehicle from pickup time to an estimated end — the route's one-way duration for airport transfers, or a guest/staff-entered end time for day use — plus a buffer. **Buffer is an admin setting, default 60 minutes.** One vehicle can do several jobs a day. Must remain concurrency-safe under simultaneous holds. → Architecture §2, Task T7 (revised, dedicated Opus review as the owner required).
2. **Notice: same-day transfers are allowed**, subject to a minimum notice before pickup — **admin setting, default 6 hours.** Tours keep their existing day-based booking window unchanged. → Architecture §2/§3, Tasks T7/T11.
3. **Coupons apply to transfers**, with the existing rules, including the ₱0 and below-₱100 refusals. → Architecture §3, Task T9.
4. **Custom Trip Request → staff creates a booking.** Owner/finance can turn a custom request into a real transfer booking with a staff-entered, server-validated, per-vehicle, centavos price, audited with the acting staff id and the price. The guest then pays through the normal flow (My Booking → deposit online/QR, balance cash to driver). **Dispatcher can view requests but not set prices.** → Architecture §5/§6, Tasks T10, T19, T20, T21 (new; dedicated Opus review as the owner required, plus a role-boundary review).

**Defaults for the remaining questions** (admin-editable where noted; R&G will confirm later — none of these block building to the default):

5. Night/late-flight surcharge: **none at launch.**
6. Free waiting time: **Terms-page placeholder text only, no automated enforcement.**
7. Excess luggage: **enforced only by vehicle-type luggage capacity at booking time; no surcharge logic.**
8. Transfer cancellation window: **same Refund Policy placeholder wording tours already use** — no transfer-specific copy needed at launch; `transfer_routes.free_cancel_hours` still exists as a real, enforced number (mirroring `tours.free_cancel_hours`), defaulted the same way tours are.
9. **Fleet sharing is designed now, not deferred:** a tour booking blocks its vehicle for the whole day; a transfer uses a time window; availability checks — both at hold time (pool math) and at dispatch time (specific-vehicle assignment) — must respect both so a van can never be on a tour and a transfer at once. → Architecture §2, Tasks T7 and T8.

## Owner decision, recorded 2026-10-31 (second round) — driver capacity

Approved alongside the plan itself, to be built into T7/T8 before T1 starts:

**Drivers must not be overworked.** Add an admin setting **"Max transfer jobs per driver per day"** (default **2**), plus an **optional per-driver override** (blank = use the default). Enforce it two ways:

1. **At hold time (T7):** a transfer can only be sold if, besides a free vehicle window, there is driver capacity left that day — sum over active, not-on-leave drivers of their daily max, minus transfer jobs already held/confirmed that day. **A driver assigned to a tour counts as fully used that day.** Concurrency-safe, the same way the vehicle check is.
2. **At dispatch time (T8):** assigning a driver who already has their max transfer jobs that day, or whose jobs would overlap including the buffer, is refused with a clear message.

**Buffer between a driver's jobs uses the same admin buffer setting** as vehicles (default 60 minutes) — not a second buffer setting. **Dedicated Opus review on T7 and T8**, per the owner's explicit instruction.

## Owner decisions, given directly by the owner on 2026-11-03

1. **Frozen route duration on the booking (migration 0020) is CONFIRMED.** T7's dedicated review found that `transferWindowsByType` was reading `transfer_routes.estimated_duration_minutes` LIVE for an already-booked transfer — an admin shortening a route's duration after a booking was taken would silently shrink that booking's reserved window, an oversell. The fix (freezing the duration onto `booking_transfer_details.route_duration_minutes_used` at hold time) is approved and stays, on the same principle as the price lock: a booking's capacity-affecting inputs are frozen at hold time, never re-read live from a catalog an admin can edit later. This closes handover QUESTIONS #2 (2026-11-03 handover doc).
2. **Vehicle seat/luggage check at transfer dispatch: SOFT CHECK WITH OVERRIDE.** Closing handover QUESTIONS #1 — a transfer's vehicle selection is by TYPE only (van vs SUV) at both hold time and dispatch time, and a van of the matching type can be smaller than the party or short on luggage room with no warning today. The owner's answer: when staff assign a vehicle to a transfer booking and the chosen van's seats or luggage capacity fall short of the booking's passengers/bags, show an amber warning naming the actual numbers; the assignment is blocked unless staff tick "Assign anyway" and give a reason (5+ characters); the server enforces this independently of the client (hiding a button is not access control); every override writes to `audit_log` with the booking, the vehicle, the passengers/bags-vs-capacity numbers, the reason, and the staff user; only roles that can already dispatch (`assignVanDriver`) may override — no new `ROLE_MATRIX` area. Built in pre-task 0C (2026-11-03 batch), ahead of T9.

---

## Global Constraints

Every task's requirements implicitly include this section, copied from `CLAUDE.md` and sharpened for this plan.

- **Money is integers in centavos everywhere.** The server computes every total, deposit and discount; the browser sends only the guest's choices. `bookings.amount_paid_centavos` is written **only** by the two allow-listed functions in `server/src/services/payments/record-payment.ts` — this plan adds none, including the staff-conversion path (which creates a booking at `pending_payment`, same as any other hold; crediting still happens only through the existing verified-webhook/admin-approval paths).
- **A refund is never a subtraction.** Unchanged for transfers.
- **Soft deletes only.** `transfer_routes`, `transfer_route_vehicle_prices` rows deactivate (`is_active`), never delete.
- **`audit_log` on every money movement, status change, assignment, and price change** — including the new staff-quoted-price event (Task T19): actor id, the price, the inquiry id.
- **Price-at-booking.** A transfer's price snapshot freezes the vehicle type, route (or custom description), product type, the price used, its source (catalog vs. staff quote), the deposit percent, the route's free-cancellation window and the buffer-minutes value in force at hold time.
- **NO RED anywhere.** Guard tests apply to every new screen, including the new convert-to-booking admin screen.
- **Mobile-first at 360px**, 44px tap targets, visible focus, AA contrast, alt text.
- **Store UTC, compute business dates/times in Asia/Manila.** A transfer's `pickup_time` (and, for day-use, `day_use_end_time`) is stored as a civil `"HH:mm"` label, exactly like a civil date is stored as a string. It is converted to a real UTC instant in exactly **one** place — the minimum-notice check (owner answer 2) — through a new, explicit helper alongside `civilDateFromDate()`/`manilaCivilDate()` in `shared/src/time.ts`, never by ad hoc string math. The window-overlap math (Architecture §2) works entirely in **minutes-since-midnight**, never converted to an instant, because overlap is a same-day, same-timezone comparison that an instant conversion would only complicate.
- **Zod on every input, shared from `/shared`.** No form shows raw Zod JSON.
- **Every admin procedure is an `adminProcedure(area)`.** This plan now adds **exactly one new `ROLE_MATRIX` area, `transferQuoting: ['owner', 'finance']`** (owner answer 4) — every other new screen reuses an existing area (`toursPricing`, `vansDrivers`, `usersSettings`, `packagesInquiries`), unchanged from the first draft. The one new area means `BUILD_SPEC.md`'s §9 table and `role-isolation.test.ts`'s pinned counts **must** be edited together, in the same commit (Task T19) — do not add the area without also updating the table, the mapping and the counts, per that test's own enforced convention.
- **No new npm libraries.** Ports 5180/3100 only. Never touch Kong PMS, production, the VPS, or `C:\dev\travelsugbo-explainer`.
- **Every task:** `✅ DONE` immediately on finishing · its own commit · all five checks with exit codes · every new test proven able to fail · leak detector silent · browser check at 1440px and 360px where client-facing.
- **A schema-changing task reminds the owner to apply the migration to the server database** and to run it against `rg_travel_test` locally first.
- **Unrelated bugs found along the way:** finish the task, list it, don't fix it unless it blocks the task — except the money-visibility bug in "Must-fix while here," below, which is in scope.

### Must-fix while here (found during research, not optional)

1. **`server/src/services/reports/money.ts:317`** — `outstandingBookings()` does `INNER JOIN tours`. Once `bookings.tour_id` is nullable, this silently **drops every transfer booking from "still to collect."** Must become a `LEFT JOIN` with a title fallback (route name, or "Custom transfer" for a staff-quoted booking with no route). Task T18's first acceptance criterion.
2. Any other `innerJoin(tours, ...)` or `eq(tours.id, bookings.tourId)` across `server/src/` must be audited once `tour_id` (and now, separately, `route_id`) are nullable: grep both, classify each as "tour-only, correctly excludes transfers" or "must handle NULL" (fix). Task T6's acceptance criterion, run immediately after the `bookings` schema migration (T5) lands.

---

## What already exists — reuse map (read before T2)

Measured at `0035a72`. Build on this; do not rebuild it.

| Capability                                                           | Where                                                                                      | Reused as-is for transfers?                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking statuses, hold expiry, capacity-holding set                  | `shared/src/booking.ts` `CAPACITY_HOLDING_STATUSES`; `bookings.status`                     | Yes, unchanged                                                                                                                                                                                                                                                                                                                                                             |
| Deposit math, ₱100 gateway floor, ₱0 refusal                         | `shared/src/money.ts`, `shared/src/checkout.ts`                                            | Yes                                                                                                                                                                                                                                                                                                                                                                        |
| Online payment (PayMongo) + manual QR + driver cash                  | `checkout.ts` `startPayment`, `routers/webhooks`, `driver.recordCash`, `record-payment.ts` | Yes, unchanged — including for a staff-created booking, which is paid exactly like any other                                                                                                                                                                                                                                                                               |
| Coupons                                                              | `services/coupons.ts`                                                                      | Yes (owner answer 3) — `quoteTransfer`/`createTransferBooking` call the same `validateCoupon`/`recordRedemption`/`releaseRedemption`                                                                                                                                                                                                                                       |
| Fleet-wide date lock                                                 | `fleet_date_slots(date)`                                                                   | **Now the single lock for every capacity decision on a date, tour or transfer** (revised — see Architecture §2; no new lock table)                                                                                                                                                                                                                                         |
| "Which van/driver are free on this date" (dispatch assignment)       | `server/src/services/dispatch/availability.ts` (`vansFreeOn`, `driversFreeOn`)             | **Extended, not unchanged** — `vansFreeOn` needs a window-aware exclusion for transfer-vs-transfer on the same specific vehicle; `driversFreeOn` needs the same window-aware exclusion **plus** a per-driver max-jobs-per-day refusal (owner addendum, second round) (Task T8)                                                                                             |
| `assessCapacity` (tours' own group-per-day math)                     | `server/src/services/capacity.ts`                                                          | **Extended, not untouched** (revised from the first draft) — gains one additive subtraction term for each vehicle type's transfer peak-overlap, **and** a driver-side leftover-pool check mirroring it (Task T7). The empty-fleet test's own assertion is unaffected: zero sellable vehicles/drivers and zero transfer bookings still yields zero available, same as today |
| Driver "free that day" gate for tours (§5 step 4)                    | Folded into `assessCapacity`/`createHold`'s existing driver check                          | **Extended** — now a job-count pool shared with transfer driver jobs, not a plain binary (Architecture §2a, Task T7)                                                                                                                                                                                                                                                       |
| Driver login, lockout, sessions, PIN                                 | Driver portal                                                                              | Yes, unchanged                                                                                                                                                                                                                                                                                                                                                             |
| Check-in / trip_checkpoints, start/finish trip, `on_trip` van status | `server/src/services/trips/checkins.ts`                                                    | Reused; T22 confirms (not assumes) zero-stop tolerance                                                                                                                                                                                                                                                                                                                     |
| Payment box, cash collection, refusal                                | `PaymentBox.tsx`, `admin.bookings.rejectCash`                                              | Yes, unchanged                                                                                                                                                                                                                                                                                                                                                             |
| Receipts, refunds, cancellation, coupon release                      | `admin.refunds.cancelBooking`                                                              | Yes, unchanged                                                                                                                                                                                                                                                                                                                                                             |
| Reviews, driver rating                                               | `services/reviews/*`                                                                       | Yes, unchanged                                                                                                                                                                                                                                                                                                                                                             |
| Reports money math                                                   | `services/reports/money.ts`                                                                | Top-level summary confirmed tour-agnostic; `outstandingBookings` is not — Must-fix #1                                                                                                                                                                                                                                                                                      |
| `admin.vans.*` CRUD                                                  | `routers/admin/vans.ts`, `AdminVansPage.tsx`                                               | Extended with `vehicleType`                                                                                                                                                                                                                                                                                                                                                |
| `admin.packages.*` / `admin.inquiries.*`                             | `routers/admin/packages.ts`                                                                | Extended for the new inquiry type **and** the new convert-to-booking action (gated separately — see below)                                                                                                                                                                                                                                                                 |
| Settings read/write, `content_unverified`-style SEO gating           | `content/settings*.ts`, `seo/resolvers.ts`, `sitemap.ts`                                   | `show_tours` reuses the identical mechanism; a new `transfer_operations` settings block (buffer minutes, minimum notice hours, staff-quote hold hours, **max transfer jobs per driver per day**) reuses the identical writer/reader/cache pattern                                                                                                                          |
| Site/brand copy separation                                           | `client/src/lib/site.ts`                                                                   | Unchanged                                                                                                                                                                                                                                                                                                                                                                  |

**`ROLE_MATRIX`: one new area, not zero (corrected from the first draft).** `toursPricing`, `vansDrivers`, `usersSettings` and `packagesInquiries` (view only) still cover every screen they covered before. The one genuinely new permission boundary is **setting a price on / converting a custom request into a booking**, which the owner explicitly withheld from dispatcher — that needs its own area, `transferQuoting: ['owner', 'finance']`, because no existing area expresses "dispatcher may read this, but not act on it." See Task T19.

---

## Architecture decisions

### 1. Schema: one `bookings` row, a discriminator, two small admin-owned tables, one child table

```
vans
  + vehicle_type  enum('van','suv')  NOT NULL DEFAULT 'van'   -- backfills every existing row to 'van'

drivers
  + max_transfer_jobs_per_day  int, NULLABLE   -- override; NULL = use transfer_operations.maxTransferJobsPerDriverPerDay
                                                 -- (owner addendum, second round — Architecture §2a)

transfer_routes                                    -- anchored on the EXISTING destinations table
  id                    PK
  destination_id        FK -> destinations.id, UNIQUE   -- one transfer route per destination; no duplicate place names
  slug                  varchar(80) unique
  is_active             boolean default true
  sort_order            int
  estimated_duration_minutes  int      -- one-way duration; feeds the window end for transfer_one_way
  free_cancel_hours     int            -- mirrors tours.free_cancel_hours; frozen into the price snapshot
  inclusions_text       text
  exclusions_text       text
  created_at / updated_at

transfer_route_vehicle_prices                       -- mirrors tour_price_tiers' role
  route_id              FK -> transfer_routes.id
  vehicle_type          enum('van','suv')
  one_way_price_centavos  int NOT NULL
  day_use_price_centavos  int NOT NULL
  PK (route_id, vehicle_type)

bookings
  tour_id               becomes NULLABLE (was NOT NULL)
  + product_type        enum('tour','transfer_one_way','transfer_day_use') NOT NULL DEFAULT 'tour'
  + route_id             FK -> transfer_routes.id, NULLABLE   -- NULL for a tour, AND for a staff-quoted custom route
  + vehicle_type_requested  enum('van','suv'), NULLABLE        -- the one real discriminator; see CHECK below
  + CHECK (
      (product_type = 'tour' AND tour_id IS NOT NULL AND vehicle_type_requested IS NULL)
      OR
      (product_type <> 'tour' AND tour_id IS NULL AND vehicle_type_requested IS NOT NULL)
    )
  -- NOTE: route_id is deliberately NOT part of this CHECK. A transfer normally has a route_id,
  -- but a staff-converted custom request may not (see booking_transfer_details.custom_route_description
  -- below). "route_id XOR custom_route_description for every non-tour booking" is a cross-table
  -- invariant MySQL's single-table CHECK cannot express — it is enforced in the ONE writer,
  -- createTransferBooking() (Task T10), and pinned by a dedicated test, the same way
  -- schema-conventions.test.ts pins the amount_paid_centavos writer allow-list.

booking_transfer_details                            -- 1:1 child table (pattern: booking_notes, booking_addons)
  booking_id            PK, FK -> bookings.id
  pickup_time           varchar(5)    -- "HH:mm", civil label
  day_use_end_time       varchar(5)    -- "HH:mm", day-use only; NULL for a one-way transfer
  dropoff_address         varchar(400) NOT NULL
  dropoff_map_url          varchar(500)
  luggage_count           int NOT NULL default 0
  flight_number           varchar(20)   -- airport transfers only
  airline                 varchar(80)   -- airport transfers only
  custom_route_description varchar(300) -- set only when bookings.route_id is NULL (a staff-quoted custom trip)
  buffer_minutes_used      int NOT NULL  -- the admin setting's value AT HOLD TIME, frozen (see price-snapshot discipline)
  created_at / updated_at

inquiries
  type enum gains 'transfer_custom'
  + requested_date       date, nullable
  + pax                  int, nullable
  + route_description    varchar(300), nullable
  + converted_booking_id  int, nullable, FK -> bookings.id   -- set once owner/finance convert it (Task T19)
```

**What is deliberately reused, not duplicated:** `bookings.pickup`/`pickup_map_url` (already exist) serve the transfer's pickup address; `bookings.requests` serves "notes"; `destinations` is not duplicated by `transfer_routes`; `price_snapshot` (JSON, already exists) carries `{ productType, vehicleType, routeId | null, customRouteDescription | null, priceSource: 'catalog' | 'staff_quote', priceCentavos, depositPercent, freeCancelHours }` — no new money column, and `priceSource` lives there rather than as a dedicated `bookings` column.

**Migration numbers.** Next is `0015`. Five tasks change the schema, in this order: T2 (`vans.vehicle_type`) → T3 (`transfer_routes` + `transfer_route_vehicle_prices`) → T5 (`bookings` columns/CHECK + `booking_transfer_details`) → T7 (`drivers.max_transfer_jobs_per_day` — added by the driver-capacity addendum) → T17 (`inquiries` columns). That is migrations `0015`–`0019`. (The first draft's `transfer_date_slots` migration is removed — see Architecture §2.) Every one of these five must be applied to both `rg_travel` and `rg_travel_test`, and the owner reminded to apply each to the server database at next deploy.

### 2. Availability: time windows, shared fleet, one lock — the actual design

**The requirement (owner answers 1 and 9):** a transfer blocks its vehicle type for `[pickup_time, estimated_end + buffer)`, not the whole day, so one vehicle can serve several transfers a day. A tour still blocks a vehicle for the whole day. The two must never conflict, and the check must be concurrency-safe under simultaneous holds.

**The tool that makes this tractable without per-vehicle scheduling at hold time:** neither a tour nor a transfer pins a specific `van_id` at hold/booking time — both still defer physical assignment to dispatch, exactly as today. So the hold-time check cannot ask "is van #7 free from 2–4pm"; it can only ask a pool question: "is there _some_ van of the right type free for this window, given everything else already booked that day?" The classical **interval-scheduling minimum-resources result** answers this cleanly: _the minimum number of same-type resources needed to serve a set of time windows with none overlapping on the same resource equals the maximum number of those windows that are simultaneously active at any single instant_ (the "peak"), and that minimum is always achievable — there is no packing case where more resources are needed than the peak. This is exactly the right tool, and it is a standard, provable result, not a heuristic.

**The three feasibility conditions for a date `D`, checked under `fleet_date_slots(D) FOR UPDATE`** (the existing lock, taken first — unchanged from today's tour path):

```
vanSellable   = COUNT(vans WHERE is_active AND status = VAN_STATUS_SELLABLE AND vehicle_type = 'van')
suvSellable   = COUNT(... vehicle_type = 'suv')
vanPeak(D)    = peakOverlap( windows of every 'van'-type transfer booking on D with a capacity-holding status )
suvPeak(D)    = peakOverlap( windows of every 'suv'-type transfer booking on D, same statuses )
toursToday(D) = COUNT(bookings WHERE product_type = 'tour' AND tour_date = D AND status IN CAPACITY_HOLDING_STATUSES)

(1)  vanPeak(D) <= vanSellable          -- van-type transfers must fit within the van fleet alone
(2)  suvPeak(D) <= suvSellable          -- same, for SUVs
(3)  toursToday(D) <= (vanSellable - vanPeak(D)) + (suvSellable - suvPeak(D))
     -- tours (which can use either type) must fit in whatever is left over after
     -- each type's own transfer peak has reserved its share
```

`peakOverlap()` is a pure, five-line sweep-line function over `{start, end}` pairs in **minutes-since-midnight**: sort the start/end boundaries, walk them incrementing/decrementing a counter, return the maximum. No timezone or DB access inside it — fully unit-testable in isolation with plain arrays.

- **Adding a new TRANSFER of type `T`** is allowed iff recomputing condition (1) or (2) for `T` (with the candidate's window included in the peak) still holds, **and** condition (3) still holds with that new peak (toursToday is unchanged by adding a transfer, but the leftover pool it must fit in shrinks if the peak grew).
- **Adding a new TOUR** is allowed iff condition (3) holds with `toursToday(D) + 1` on the left (conditions 1/2 are unaffected by adding a tour).
- **A window** is computed as `[pickupTime, pickupTime + route.estimatedDurationMinutes + bufferMinutes)` for `transfer_one_way`, or `[pickupTime, dayUseEndTime + bufferMinutes)` for `transfer_day_use`, all in minutes-since-midnight of the civil tour date. `bufferMinutes` is read from the new `transfer_operations` settings block (default 60) and **frozen** onto the booking as `booking_transfer_details.buffer_minutes_used`, so a later admin change to the default never silently reinterprets an existing booking's window.
- **Known, accepted limitation:** a window that would cross midnight (a very late pickup plus a long duration/buffer landing after 23:59) is not modeled across two civil dates — the capacity date key is a single `date`. Task T7 adds an explicit guest-safe refusal for this case ("choose an earlier pickup time") rather than silently miscounting it; a cross-midnight itinerary is rare for these three products and not worth a two-date windowing model at launch.

**Dispatch-time assignment (Task T8) is a separate, more precise question** — once a booking is `confirmed` and an admin is picking an actual `van_id`, the real identity of every other booking on that van that day is known, so this is a straightforward per-vehicle check rather than pool math: `vansFreeOn`/`driversFreeOn` exclude a specific van from being offered for a new assignment when (a) it already has an assigned TOUR that date (whole-day exclusion, unchanged), or (b) it already has an assigned TRANSFER that date whose window overlaps the new booking's window (new — a plain two-interval overlap test, using the same minutes-since-midnight representation). Two non-overlapping transfers on the same van the same day are **not** excluded — that is the "several jobs a day" the owner asked for.

**Why no new lock table.** The first draft proposed a `transfer_date_slots(date, vehicle_type)` row mirroring `tour_date_slots`. It is unnecessary and would actually under-serialize: conditions (1)–(3) above read across **both** vehicle types and **both** product types for one date, so locking only one type's row would let a concurrent van-transfer hold and a concurrent suv-transfer hold both proceed while each makes a decision that depends on the other's (soon-to-be-stale) count. `fleet_date_slots(date)` already serializes the whole date for every capacity-affecting transaction today (tours take it first); extending that same lock to transfers, with no second lock, is both simpler and the only choice that is actually correct for this cross-type sharing requirement.

### 2a. Driver capacity (owner addendum, second round): a second, undifferentiated pool, with its own daily cap

**The requirement:** drivers must not be overworked. Each active, not-on-leave driver may do at most `maxTransferJobsPerDay` transfer jobs on a given day (an admin setting, default 2, with an optional per-driver override — `drivers.max_transfer_jobs_per_day`, NULL meaning "use the default"). A driver already doing a tour that day has none of that budget left — a tour, like a vehicle, consumes a driver for the whole day. At dispatch time, a driver's jobs must also not overlap in time, buffer included.

**Drivers are a single pool, unlike vehicles — there is no "van driver" vs "SUV driver" type.** That removes one dimension of the vehicle problem but adds another: drivers can have _different_ per-day caps (the per-driver override), so "how many drivers does a tour effectively use up" is no longer "exactly one unit from a uniform pool" — it is "exactly one driver, whichever one, and that driver's own cap goes with them." The hold-time question is therefore: _given `N` active, not-on-leave drivers with caps `c_1 <= c_2 <= ... <= c_N` (sorted ascending), and needing to seat `toursToday(D)` whole-day tours and `transfersToday(D)` one-job-unit transfers, does a feasible assignment exist?_

**The optimal (not merely safe) rule, by a standard exchange argument:** to leave the most capacity for transfers, assign tours to the drivers with the **smallest** caps first — swapping a tour from a larger-cap driver to a smaller-cap one never reduces what is left over for transfers, so if any feasible assignment exists, the smallest-first one does too. This gives an exact, not just conservative, feasibility rule:

```
drivers sorted ascending by effective cap c_1 <= c_2 <= ... <= c_N   (effective cap = override ?? maxTransferJobsPerDay default)
toursToday(D)     = COUNT(bookings WHERE product_type = 'tour' AND tour_date = D AND status IN CAPACITY_HOLDING_STATUSES)
transfersToday(D)  = COUNT(bookings WHERE product_type <> 'tour' AND tour_date = D AND status IN CAPACITY_HOLDING_STATUSES)

(4)  toursToday(D) <= N
     -- enough distinct drivers exist to give every tour its own driver (the existing §5
     -- "at least one driver free" rule, now expressed as a pool count instead of a binary)
(5)  transfersToday(D) <= ( sum(c_1 .. c_N) - sum(c_1 .. c_{toursToday(D)}) )
     -- after handing a whole day to the toursToday(D) SMALLEST-capacity drivers (the
     -- capacity-maximising choice), the remaining drivers' summed caps must cover every
     -- transfer job already booked
```

- **Adding a new TRANSFER** is allowed iff condition (5) holds with `transfersToday(D) + 1` on the left (condition 4 is unaffected by adding a transfer).
- **Adding a new TOUR** is allowed iff condition (4) holds with `toursToday(D) + 1`, **and** condition (5) still holds after re-sorting with one more driver notionally removed from the bottom of the list (adding a tour can only shrink the leftover pool, since it removes one more driver — the next-smallest-capacity one — from the sum).
- This runs under the **same** `fleet_date_slots(D) FOR UPDATE` lock as the vehicle conditions (1)–(3) — one lock, one transaction, both the vehicle and the driver question answered together, so a hold is refused the instant either resource is short, never just one.
- **At HOLD time this is a job-count check only — no time-of-day math** (matching the owner's own wording, "driver capacity left that day," not "driver capacity free at this hour"). Time-of-day only matters once a _specific_ driver is being assigned, which is Task T8.

**Dispatch-time (Task T8) refusal, per the owner's second condition:** when an admin assigns a specific driver to a specific booking, refuse with a clear message when either is true — (a) the driver already has `effectiveCap` transfer jobs assigned that day (even if none of them overlap in time — the cap is a _count_, not just a schedule), or (b) the new booking's window overlaps, buffer included, with any job already assigned to that driver that day (using the exact same minutes-since-midnight overlap test as vehicles, and the **same** buffer-minutes setting — there is deliberately no second buffer setting for drivers).

### 3. Quote & hold: parallel procedures, shared booking-writer, coupons included

`checkout.quote`/`createHold` (tours) are untouched. New, parallel procedures:

- **`checkout.quoteTransfer`** (Task T9) — computes `subtotal = vehiclePriceForRouteAndType(route, vehicleType, productType)`, applies a coupon exactly as tours do (`validateCoupon` against the subtotal), `total = subtotal - discount`, `deposit = depositCentavos(total, depositPercent)`, and the existing ₱100/₱0 refusals via the same shared helpers tours use.
- **`createTransferBooking()`** (Task T10, `server/src/services/transfers/create-booking.ts`) — the **one** function that takes the `fleet_date_slots` lock, re-checks the vehicle feasibility conditions (1)–(3) **and** the driver feasibility conditions (4)–(5) from Architecture §2/§2a with the new booking's window included, re-checks the minimum-notice rule (owner answer 2: `pickup instant - now >= transfer_operations.minNoticeHours`, computed through the one civil-time-to-instant helper), writes the `bookings` row plus `booking_transfer_details` in the same transaction, generates the ref via the existing `generateBookingRef()`, and applies/records a coupon exactly as a tour hold does. It takes an explicit `priceSource` parameter — `{ kind: 'catalog' }` (looks up `transfer_route_vehicle_prices`) or `{ kind: 'staff', priceCentavos, staffUserId }` (Task T19's conversion path) — so **both** the guest-facing hold and the staff-conversion booking go through identical capacity/notice/transaction logic, and nothing about dispatch, payments, check-ins or reports ever needs to know which path created the booking.
- **`checkout.createHoldTransfer`** (Task T11) — the thin, public, guest-facing wrapper around `createTransferBooking({ priceSource: { kind: 'catalog' } })`, the counterpart to tours' `createHold`.

### 4. The `show_tours` switch: a second, independent gate next to `content_unverified`

Unchanged from the first draft. `show_tours: z.boolean()` (default `false`) added to `SETTING_SCHEMAS`, exposed as `SettingsPayload.showTours`, consulted by `tours.list`/`bySlug`, `checkout.quote`/`createHold` (tours), the SEO resolver and the sitemap — each independently of `content_unverified`. Admin tour editing is never gated by it.

### 5. Admin & roles: one new area, three unchanged

- **Routes & prices:** `admin.transferRoutes.*`, gated `adminProcedure('toursPricing')` — unchanged area, owner-only.
- **Vehicle type on vans:** existing `admin.vans.update`, unchanged area (`vansDrivers`).
- **The tours switch, `transfer_operations` settings:** existing `admin.settings.*`, unchanged area (`usersSettings`).
- **Viewing a custom-trip-request inquiry:** existing `admin.inquiries.*`, unchanged area (`packagesInquiries`, owner+dispatcher) — dispatcher can see the request, the requested route/date/pax/notes.
- **Setting a price on / converting that request into a booking — the one new boundary:** `admin.transferQuotes.convert`, gated `adminProcedure('transferQuoting')`, **new area, `['owner', 'finance']`**. Dispatcher is denied by the area, not by hiding a button — Task T19 proves this with a role-isolation test the same way every other area is proven.

### 6. Custom Trip Request → staff-priced booking (owner answer 4) — the actual flow

1. Guest submits the existing public inquiry form with "Custom trip request" selected; it lands as an `inquiries` row (`type = 'transfer_custom'`, `requestedDate`, `pax`, `routeDescription`, `message`). Owner and dispatcher both see it (`packagesInquiries`).
2. Owner or finance opens it and chooses **"Quote & convert to booking"** (dispatcher does not have this control — denied server-side by `transferQuoting`). They fill in the full set of transfer-booking fields (vehicle type, product type, tour date, pickup time/addresses, luggage, flight/airline if applicable) **plus a quoted price in pesos**, which the client converts to centavos and the server re-validates (positive, passes the same ₱100-gateway-floor logic that would apply if this were a catalog price, since the guest will pay it through the exact same PayMongo/QR path).
3. The server calls `createTransferBooking({ priceSource: { kind: 'staff', priceCentavos, staffUserId } })`, through the same feasibility/notice checks as any other transfer hold. `inquiries.convertedBookingId` is set. `audit_log` gets a row naming the actor, the inquiry id, and the price (`transfer.custom_quote_converted`).
4. The booking is created at `pending_payment`, with a **longer** hold window than the guest self-serve 15 minutes — a new `transfer_operations.staffQuoteHoldHours` setting (default 48h, admin-editable) — because the guest needs time to receive a notification and come back. This reuses the **existing** `hold_expires_at` column and the **existing** `expire-holds` cron sweep; only the expiry duration passed at creation differs. No new status, no new job.
5. The guest is notified (new copy through the existing `notify()` — cannot-throw, after-commit) with a link into My Booking, where they pay the deposit online/QR or wait for cash collection on the day, exactly like any other transfer booking from this point on.

---

## File Structure

**New server files**

| File                                              | Responsibility                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/services/transfers/overlap.ts`        | Pure `peakOverlap(windows)` sweep-line function (Architecture §2) and a plain two-window `overlaps(a, b)` test, reused for both vehicle and driver checks — no DB, fully unit-testable |
| `server/src/services/transfers/capacity.ts`       | `assessTransferCapacity()` — vehicle conditions (1)/(2)/(3) and driver conditions (4)/(5), reading `transfer_operations.bufferMinutes`/`maxTransferJobsPerDriverPerDay`                |
| `server/src/services/transfers/pricing.ts`        | `quoteTransfer()`                                                                                                                                                                      |
| `server/src/services/transfers/create-booking.ts` | `createTransferBooking()` — the one shared, lock-holding, transaction-writing function (guest and staff paths both call this)                                                          |
| `server/src/routers/public/transfers.ts`          | `transferRoutes.list` (public)                                                                                                                                                         |
| `server/src/routers/admin/transfer-routes.ts`     | `admin.transferRoutes.*`                                                                                                                                                               |
| `server/src/routers/admin/transfer-quotes.ts`     | `admin.transferQuotes.convert` (`transferQuoting` area)                                                                                                                                |
| `server/src/services/transfers/upsert-route.ts`   | Transactional write for a route + its two price rows                                                                                                                                   |

**Modified server files**

| File                                                          | Change                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/src/db/schema.ts`                                     | Architecture §1's five schema changes (no `transfer_date_slots`), including `drivers.max_transfer_jobs_per_day`                                                                            |
| `server/src/services/capacity.ts`                             | `assessCapacity` gains the vehicle leftover-pool subtraction (Architecture §2) and the driver smallest-cap-first subtraction (Architecture §2a)                                            |
| `server/src/services/dispatch/availability.ts`                | `vansFreeOn` gains the window-aware exclusion for transfer-vs-transfer on one vehicle; `driversFreeOn` gains the same window-aware exclusion **plus** a max-jobs-per-day refusal (Task T8) |
| `server/src/routers/public/checkout.ts`                       | + `quoteTransfer`, `createHoldTransfer`                                                                                                                                                    |
| `server/src/routers/admin/vans.ts`                            | `vehicleType` field                                                                                                                                                                        |
| `server/src/routers/admin/packages.ts`                        | Inquiries list/detail handle `type = 'transfer_custom'` fields and link to the convert action                                                                                              |
| `server/src/content/settings-schema.ts`                       | `show_tours: z.boolean()`; new `transfer_operations` block (`bufferMinutes`, `minNoticeHours`, `staffQuoteHoldHours`, `maxTransferJobsPerDriverPerDay`)                                    |
| `server/src/routers/admin/drivers.ts`                         | `maxTransferJobsPerDay` override field on `admin.drivers.update`                                                                                                                           |
| `server/src/routers/public/tours.ts`                          | `showTours` refusal branch                                                                                                                                                                 |
| `server/src/seo/resolvers.ts`, `server/src/seo/sitemap.ts`    | `showTours` gate                                                                                                                                                                           |
| `server/src/middleware/require-role.ts`                       | + `transferQuoting: ['owner', 'finance']`                                                                                                                                                  |
| `server/src/services/reports/money.ts`                        | Must-fix #1; new `revenueByRoute()`                                                                                                                                                        |
| `server/src/routers/public/driver.ts`, `shared/src/driver.ts` | `TripDetail` transfer fields                                                                                                                                                               |
| `server/src/services/notify/templates.ts`                     | Route-name/date copy for a transfer booking; new copy for a ready staff quote                                                                                                              |
| `shared/src/time.ts`                                          | New civil-time-to-instant helper for the minimum-notice check only                                                                                                                         |

**New client files**

| File                                                                                                                                | Responsibility                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `client/src/pages/public/TransferBookingPage.tsx`                                                                                   | The transfer picker + vehicle-option + quote flow |
| `client/src/components/transfer/TransferTypePicker.tsx`, `RoutePicker.tsx`, `VehicleOptionCard.tsx`, `TransferGuestDetailsForm.tsx` | Booking-flow components                           |
| `client/src/pages/admin/AdminTransferRoutesPage.tsx`                                                                                | Routes + prices + inclusions/exclusions editor    |
| `client/src/components/admin/ConvertInquiryForm.tsx`                                                                                | Owner/finance-only quote-and-convert form         |

**Modified client files**

| File                                                                         | Change                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/pages/public/HomePage.tsx`, layout nav                           | Transfer-first hero; tour surfaces gated on `settings.showTours`                                                                                                         |
| `client/src/pages/portal/*`                                                  | Transfer fields when `productType !== 'tour'`                                                                                                                            |
| `client/src/pages/admin/AdminBookingsPage.tsx`, `AdminBookingDetailPage.tsx` | Product-type badge, transfer fields                                                                                                                                      |
| `client/src/pages/admin/AdminCalendarPage.tsx`, `AdminDeparturesPage.tsx`    | Transfers alongside tours; vehicle-type badge                                                                                                                            |
| `client/src/pages/admin/AdminVansPage.tsx`                                   | Vehicle-type field                                                                                                                                                       |
| `client/src/pages/admin/AdminDriversPage.tsx`                                | "Max transfer jobs/day" override field (blank = use the admin default)                                                                                                   |
| `client/src/pages/admin/AdminSettingsPage.tsx`                               | "Show tours" toggle + all four `transfer_operations` fields (buffer minutes, minimum notice hours, staff-quote hold hours, default max transfer jobs per driver per day) |
| `client/src/pages/admin/AdminPackagesPage.tsx`                               | Custom-request fields; "Quote & convert to booking" action, owner/finance only                                                                                           |
| `client/src/pages/admin/AdminReportsPage.tsx`                                | Revenue-by-route                                                                                                                                                         |
| `client/src/pages/driver/*`                                                  | Pickup time, luggage, dropoff, flight/airline                                                                                                                            |

**Shared**

| File                      | Responsibility                                                               |
| ------------------------- | ---------------------------------------------------------------------------- |
| `shared/src/transfers.ts` | `VEHICLE_TYPES`, Zod inputs for quote/hold/route-admin/convert, result types |

---

## Tasks

Batches of 4, plus a trailing controller-only close-out task. **Schema tasks (T2, T3, T5, T7, T17) are strictly sequential** with each other. Model: **Sonnet** for UI/admin-CRUD-plumbing, **Opus** for anything touching money, availability/locking, schema, or the new role boundary. Review: **dedicated Opus reviewer** for every money/availability/schema/role task; combined review for pure-UI tasks. **T7 and T8 carry the owner's explicit instruction of dedicated Opus review** (both already were dedicated Opus; the driver-capacity addendum does not change that, it reconfirms it).

### Batch 1 — Spec correction, vehicle types, routes & pricing schema

| Task   | Delivers                                                                                                                                                                               | Model    | Schema? | Review         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------- |
| **T1** | Correct `BUILD_SPEC.md` line 64 and record the 2026-10-28/10-31 owner decisions in the spec's decision log; correct the pre-launch-fixes plan's now-superseded "no van transfers" line | Sonnet   | No      | combined       |
| **T2** | `vans.vehicle_type` column + migration; `admin.vans.*`; `AdminVansPage.tsx`                                                                                                            | Sonnet   | **Yes** | combined       |
| **T3** | `transfer_routes` + `transfer_route_vehicle_prices` tables + migration; `upsert-route.ts`; `admin.transferRoutes.*` (`toursPricing`)                                                   | **Opus** | **Yes** | dedicated Opus |
| **T4** | `AdminTransferRoutesPage.tsx`                                                                                                                                                          | Sonnet   | No      | combined       |

### Batch 2 — `bookings`/`booking_transfer_details` schema, must-fix audit, availability (hold time + dispatch time, vehicles + drivers)

| Task   | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Model    | Schema? | Review                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **T5** | `bookings` nullable `tour_id` + `product_type`/`vehicle_type_requested`/`route_id` + CHECK + migration; `booking_transfer_details` table + migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **Opus** | **Yes** | dedicated Opus                                                                                                                     |
| **T6** | Must-fix audit: every `tours`-joined or `bookings.tourId`/`bookings.routeId`-assuming query in `server/src/`, classified and fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Opus** | No      | dedicated Opus                                                                                                                     |
| **T7** | `drivers.max_transfer_jobs_per_day` column + migration; `overlap.ts` (`peakOverlap` + `overlaps`); `transfer_operations` settings block (`bufferMinutes`, `minNoticeHours`, `staffQuoteHoldHours`, `maxTransferJobsPerDriverPerDay`); `assessCapacity` extended with the vehicle leftover-pool term (1)–(3) **and** the driver smallest-cap-first term (4)–(5); `assessTransferCapacity()` implementing all five conditions; concurrency-proven the same way `capacity.test.ts` proves tours (two simultaneous holds, one slot, one wins — for both a vehicle-short and a driver-short scenario); the cross-midnight-window refusal | **Opus** | **Yes** | **dedicated Opus — the owner's named highest-scrutiny task in this plan, explicitly reconfirmed for the driver-capacity addendum** |
| **T8** | `vansFreeOn` window-aware exclusion for transfer-vs-transfer on one specific vehicle; `driversFreeOn` gains the same window-aware exclusion **plus** a max-jobs-per-day refusal with a clear message (owner addendum); whole-day tour exclusion unchanged for both; `dispatch-availability.test.ts` extended (vehicle AND driver cases), the existing van-status-agreement test re-proven green                                                                                                                                                                                                                                     | **Opus** | No      | **dedicated Opus — explicitly reconfirmed for the driver-capacity addendum**                                                       |

### Batch 3 — Pricing, the shared booking-writer, the guest hold path

| Task    | Delivers                                                                                                                                                                                                                                                                   | Model    | Schema? | Review                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| **T9**  | `services/transfers/pricing.ts` (`quoteTransfer`) — subtotal/coupon/discount/total/deposit, ₱100/₱0 refusals; `checkout.quoteTransfer`                                                                                                                                     | **Opus** | No      | dedicated Opus                                                             |
| **T10** | `services/transfers/create-booking.ts` (`createTransferBooking`) — the lock, the vehicle conditions (1)–(3) **and** the driver conditions (4)–(5) with the candidate window, the minimum-notice check, the transactional write, coupon redemption, `priceSource` parameter | **Opus** | No      | dedicated Opus — the other half of the owner's named highest-scrutiny work |
| **T11** | `checkout.createHoldTransfer` (public, guest-facing wrapper over T10 with `priceSource: catalog`)                                                                                                                                                                          | **Opus** | No      | dedicated Opus                                                             |
| **T12** | `shared/src/transfers.ts` — Zod inputs for quote/hold (route, product type, vehicle type, date, pax, luggage, pickup/day-use-end time, addresses, flight/airline conditional), friendly messages via `field-errors.ts`                                                     | Sonnet   | No      | combined                                                                   |

### Batch 4 — Public booking UI, home page, tours-hidden switch

| Task    | Delivers                                                                                                                                                                                                                                                                                                                                       | Model    | Schema? | Review         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------- |
| **T13** | `TransferTypePicker`, `RoutePicker`, `VehicleOptionCard`, `TransferGuestDetailsForm`                                                                                                                                                                                                                                                           | Sonnet   | No      | combined       |
| **T14** | `TransferBookingPage.tsx`; home page/nav lead with transfers (owner decision 8)                                                                                                                                                                                                                                                                | Sonnet   | No      | combined       |
| **T15** | `show_tours` settings block + `SettingsPayload.showTours`; `tours.list`/`bySlug`, `checkout.quote`/`createHold` (tours) refusals; SEO resolver + sitemap gate                                                                                                                                                                                  | **Opus** | No      | dedicated Opus |
| **T16** | Client: `AdminSettingsPage.tsx` `show_tours` toggle **and** all four `transfer_operations` fields (buffer minutes, minimum notice hours, staff-quote hold hours, default max transfer jobs per driver per day); `AdminDriversPage.tsx` per-driver override field; home/nav/catalog hidden when `show_tours` is off; regression proof both ways | Sonnet   | No      | combined       |

### Batch 5 — Inquiries extension, reports fix, the new role boundary, its admin UI

| Task    | Delivers                                                                                                                                                                                                                                                                                                       | Model    | Schema? | Review                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------- |
| **T17** | `inquiries` schema extension (`transfer_custom` type, `requestedDate`/`pax`/`routeDescription`/`convertedBookingId`) + migration; `admin.inquiries.*`/`AdminPackagesPage.tsx` show the new fields; public inquiry form gains "Custom trip request"                                                             | Sonnet   | **Yes** | combined                                                                                                 |
| **T18** | Must-fix #1 fix (`outstandingBookings` → LEFT JOIN); `revenueByRoute()`; `AdminReportsPage.tsx` revenue-by-route + CSV                                                                                                                                                                                         | **Opus** | No      | dedicated Opus                                                                                           |
| **T19** | **New `ROLE_MATRIX` area `transferQuoting: ['owner','finance']`** + `BUILD_SPEC.md` §9 table + `role-isolation.test.ts` counts, edited together; `admin.transferQuotes.convert` calling T10's `createTransferBooking({priceSource: staff})`; `staffQuoteHoldHours` setting; `audit_log` row with actor + price | **Opus** | No      | **dedicated Opus — money AND a new role boundary, this project's own dual-trigger for maximum scrutiny** |
| **T20** | `ConvertInquiryForm.tsx` + `AdminPackagesPage.tsx` "Quote & convert to booking" control, visible/actionable only for owner/finance; dispatcher still sees the request read-only                                                                                                                                | Sonnet   | No      | combined                                                                                                 |

### Batch 6 — Close the loop: notifications, role-isolation proof, driver/admin/portal surfaces

| Task    | Delivers                                                                                                                                                                                                         | Model    | Schema? | Review         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------- |
| **T21** | Guest notification for a ready staff quote; role-isolation test proving dispatcher is refused `transferQuoting`; full lifecycle test: inquiry → convert → booking → guest pays deposit → cash balance on the day | **Opus** | No      | dedicated Opus |
| **T22** | `TripDetail` carries transfer fields; driver trip screen renders them; zero-itinerary-stop check-in path confirmed structurally in `checkins.ts`/`tripProgress`, not assumed                                     | **Opus** | No      | dedicated Opus |
| **T23** | `AdminBookingsPage.tsx`/`AdminBookingDetailPage.tsx`/`AdminCalendarPage.tsx`/`AdminDeparturesPage.tsx` show product type, vehicle type, route (or custom description), and the transfer-only guest fields        | Sonnet   | No      | combined       |
| **T24** | Portal (My Booking) renders transfer fields; `notify()` template copy checked for tour-only language across every event, not just the new one                                                                    | Sonnet   | No      | combined       |

### Batch 7 — Regression proof, content, design, legal

| Task    | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Model          | Schema? | Review         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------- | -------------- |
| **T25** | End-to-end regression: full suite green, leak detector silent; a transfer booking walked hold → deposit → dispatch assignment (two same-day non-overlapping jobs on one van **and** one driver, proving T7/T8 together for both vehicles and drivers) → check-ins → review-eligible; a driver at their max transfer jobs refused a third same-day job at dispatch time; a tour booking walked the same lifecycle with `show_tours = true`; a staff-converted booking walked inquiry → convert → pay → complete | **Opus**       | No      | dedicated Opus |
| **T26** | Seed data: 2–3 real-named demo routes with both vehicle-type prices, dev-only (`seedDemo`); placeholder vehicle-card imagery                                                                                                                                                                                                                                                                                                                                                                                   | Sonnet         | No      | combined       |
| **T27** | `frontend-design` + `ui-ux-pro-max` pass on the transfer booking flow, 360px and 1440px                                                                                                                                                                                                                                                                                                                                                                                                                        | Sonnet         | No      | combined       |
| **T28** | Legal/content to-do checklist for the owner (shorter now — see below), text not written here                                                                                                                                                                                                                                                                                                                                                                                                                   | Sonnet         | No      | combined       |
| **T29** | Full five-check pass across the whole batch; `docs/BUGS_LOG.md` updated; plan's "Execution status" closed out                                                                                                                                                                                                                                                                                                                                                                                                  | — (controller) | No      | —              |

---

## Legal & content to-dos for the owner (shortened by the 2026-10-31 defaults; not drafted here)

1. **No-show / waiting-time policy** — owner answer 6: ship as **Terms-page placeholder text only** (consistent with the rest of the site's `content_unverified` placeholder discipline); no automated enforcement to build.
2. **Flight-delay handling** — same treatment as #1, placeholder text.
3. **Luggage limits** — owner answer 7: no legal text needed beyond noting the vehicle-type capacity is enforced at booking time; nothing is "forfeited," the option is simply not offered.
4. **Day-use overrun** — still open; not covered by any 2026-10-31 default. Flag for the owner.
5. **Cancellation window for transfers** — owner answer 8: reuse the same Refund Policy placeholder tours already show; no new copy needed at launch. The enforced number (`transfer_routes.free_cancel_hours`) still needs a sensible default — proposed: same default tours use, admin-editable per route.
6. **"Operated by R&G Travel & Tours"** regulatory/accreditation language — still open: check against transfer-specific DOT/LTFRB requirements if they differ from the tour permit shown today.

---

## Self-review (this revision)

- **Every 2026-10-31 owner answer maps to a named task:** availability → T7/T8; notice → T7/T11; coupons → T9/T10; custom-request conversion → T10/T17/T19/T20/T21; fleet-sharing design → T7/T8 together, explicitly required to agree (T25's regression test exercises both in one scenario).
- **The one new role area is edited everywhere it must be, in one task (T19):** the matrix, the spec table, the test counts, together — matching the project's own enforced convention rather than letting them drift.
- **Type/name consistency checked:** `vehicle_type_requested`, `route_id`, `custom_route_description`, `transfer_operations`, `transferQuoting`, `createTransferBooking`, `priceSource` are used identically everywhere they appear.
- **Placeholder scan:** no task says "handle edge cases" without naming one — the cross-midnight window refusal, the leftover-pool formula, the frozen `buffer_minutes_used`, and the exact CHECK constraint text are all spelled out, not gestured at.
- **A residual risk, named rather than hidden:** `assessCapacity`'s new leftover-pool term and `assessTransferCapacity`'s vehicle conditions are proven correct by the cited interval-scheduling theorem given the model's own assumptions (vehicles within a type are fungible for this count; windows don't cross midnight). The driver conditions (4)–(5), added in the second-round addendum, are proven correct by a separate but equally standard exchange argument (assign tours to the smallest-cap drivers first) — both proofs are stated explicitly above, not left implicit, and both should be the dedicated reviewer's first thing to re-derive independently on T7, not just read.
- **Driver-capacity addendum is folded in everywhere it needs to be:** Architecture §2a, the schema block, migration numbering, File Structure, T7, T8, T16, T25, and this self-review. No other task changes — the addendum is additive to T7/T8's scope, not a reshuffle of the rest of the plan.

---

## Task summary table

| Task | Delivers                                                                                                                                                               | Model  | Schema? | Review                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- | ------------------------------------------------- |
| T1   | Spec/plan correction                                                                                                                                                   | Sonnet | No      | combined                                          |
| T2   | Van vehicle type                                                                                                                                                       | Sonnet | Yes     | combined                                          |
| T3   | Routes + prices schema/service/router                                                                                                                                  | Opus   | Yes     | dedicated Opus                                    |
| T4   | Admin routes/prices UI                                                                                                                                                 | Sonnet | No      | combined                                          |
| T5   | `bookings` + `booking_transfer_details` schema                                                                                                                         | Opus   | Yes     | dedicated Opus                                    |
| T6   | Nullable-join audit                                                                                                                                                    | Opus   | No      | dedicated Opus                                    |
| T7   | Hold-time window-aware vehicle AND driver capacity (overlap math, settings, `drivers.max_transfer_jobs_per_day`, `assessCapacity` extension, `assessTransferCapacity`) | Opus   | Yes     | dedicated Opus (highest scrutiny; owner-mandated) |
| T8   | Dispatch-time window-aware vehicle AND driver assignment (max-jobs-per-day refusal)                                                                                    | Opus   | No      | dedicated Opus (owner-mandated)                   |
| T9   | Transfer pricing/quote incl. coupons                                                                                                                                   | Opus   | No      | dedicated Opus                                    |
| T10  | Shared `createTransferBooking` service                                                                                                                                 | Opus   | No      | dedicated Opus (highest scrutiny)                 |
| T11  | Guest-facing `createHoldTransfer`                                                                                                                                      | Opus   | No      | dedicated Opus                                    |
| T12  | Shared transfer Zod inputs                                                                                                                                             | Sonnet | No      | combined                                          |
| T13  | Booking-flow components                                                                                                                                                | Sonnet | No      | combined                                          |
| T14  | Home page + transfer page                                                                                                                                              | Sonnet | No      | combined                                          |
| T15  | `show_tours` gate (server)                                                                                                                                             | Opus   | No      | dedicated Opus                                    |
| T16  | `show_tours` gate (client) + `transfer_operations`/driver-override settings UI + regression                                                                            | Sonnet | No      | combined                                          |
| T17  | Inquiries extension                                                                                                                                                    | Sonnet | Yes     | combined                                          |
| T18  | Reports money fix + revenue-by-route                                                                                                                                   | Opus   | No      | dedicated Opus                                    |
| T19  | New `transferQuoting` role area + staff-quote conversion                                                                                                               | Opus   | No      | dedicated Opus (money + new role boundary)        |
| T20  | Convert-to-booking admin UI                                                                                                                                            | Sonnet | No      | combined                                          |
| T21  | Staff-quote notification + role-isolation + lifecycle proof                                                                                                            | Opus   | No      | dedicated Opus                                    |
| T22  | Driver portal transfer fields                                                                                                                                          | Opus   | No      | dedicated Opus                                    |
| T23  | Admin bookings/calendar UI                                                                                                                                             | Sonnet | No      | combined                                          |
| T24  | Portal + notifications copy                                                                                                                                            | Sonnet | No      | combined                                          |
| T25  | End-to-end regression proof                                                                                                                                            | Opus   | No      | dedicated Opus                                    |
| T26  | Seed/placeholder content                                                                                                                                               | Sonnet | No      | combined                                          |
| T27  | Design/UX pass                                                                                                                                                         | Sonnet | No      | combined                                          |
| T28  | Legal to-do list                                                                                                                                                       | Sonnet | No      | combined                                          |
| T29  | Final verification sweep                                                                                                                                               | —      | No      | —                                                 |

---

## Assumptions carried into this revision (flag if any are wrong)

- `staffQuoteHoldHours` default of 48 hours is a reasonable guess for "enough time for a guest to see an email and come back," not an owner-given number — admin-editable, easy to change later.
- A staff-converted booking with no matching catalog route still needs _some_ guest-facing display name on receipts/emails/My Booking; this plan uses `custom_route_description` verbatim where a route name would otherwise appear. If the owner wants different wording for a staff-quoted trip specifically, that is a copy change inside T20/T21, not a new architecture decision.
- "Dispatcher can view requests" (owner answer 4) is read as: dispatcher sees the inquiry's captured fields (route description, date, pax, notes) exactly as today, but never the quoted price, the convert action, or the resulting booking's price details beyond what `bookingsView` already exposes on any booking. If the owner wants dispatcher to see the price once set (just not set it themselves), that's a one-line change to T19/T20, flagged now rather than assumed silently.
- The driver-capacity hold-time check (Architecture §2a) treats a driver on leave for only part of a day as unavailable for the **whole** day, mirroring how `driver_leaves` already works for tours today — not a new assumption, just carried forward.
- A driver with an override of `0` is read as "do not give this driver any transfer jobs today" (not an error) — useful for a driver the owner wants reserved for tours only. Worth confirming with the owner during T7 rather than guessing silently if it comes up, but not blocking.

**Approved by the owner, 2026-10-31.** This addendum (driver capacity) is logged and folded into T7/T8 as instructed, as its own commit, before any task execution begins. Execution proceeds via `superpowers:subagent-driven-development`, starting at T1.
