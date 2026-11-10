# HANDOVER-12 — T23 complete, proceeding to T24

## T23: admin screens show a transfer booking's product

Commits:

- `93c7a9a` — T23: todayDepartures shows a transfer's route and pickup time; board stops reading "1 of 1" as finished
- `929a9a4` — T23: bookings list/detail and the dispatch calendar show a transfer's product
- `1fb0016` / `6c70805` — follow-up: tighten two `vehicleTypeLabel` assertions (`.not.toBeNull()` → compare against the real vehicle type name) and drop a dead fixture array, found during this task's own mutation-proof pass.

Two independent commits, matching the two surfaces touched:

**Commit A (`93c7a9a`)** — `admin.departures.today` / `todayDepartures()` and `DeparturesBoard.tsx`:

- `routeDisplayName()`/`transferTitle()` extracted from `services/reports/money.ts` into a new module, `services/transfers/display.ts`. `money.ts`'s own doc comment named this as the point to decide once a third caller's shape was known; T23 brought the count to five callers (`money.ts` itself, `routers/public/driver.ts` from T22, and three new admin-side callers), which settled it. `driver.ts` and `driver-transfer-trip.test.ts`'s imports were repointed to the new module; `money.ts` now imports from it instead of owning the functions.
- `TodayDeparture` gains `transferRouteLabel`, `pickupTime`, `vehicleTypeLabel` — all `null` for a tour, the same `tourId === null` guard every other surface in this feature uses. `todayDepartures()` adds the same four LEFT JOINs (`bookingTransferDetails`, `transferRoutes`, two `transferPlaces` aliases, `vehicleTypes`) that `routers/public/driver.ts`'s `loadDriverTrip` already carries, with the identical 1:1-or-absent cardinality argument.
- **Closes the divergence T22's review named for T23**: `DeparturesBoard.tsx` used to render `{done} of {total} stops` and a percent bar unconditionally, so a transfer (`total` always `1`, since it has no itinerary stops) read "1 of 1 stops" at 100% full the instant it started — the board said the trip was finished while the van was still at the pickup. It now special-cases `total === 1` with status-aware text ("Not started yet" / "Trip started" / "Trip completed"), mirroring `StopList.tsx`'s own branch from T22, and drops the bar entirely for that case rather than drawing one that is always 0% or 100%.

**Commit B (`929a9a4`)** — `admin.bookings.list`/`.detail` and `admin.calendar.month`:

- Same join quartet added to both `bookings.ts` queries and `calendar.ts`'s `month` query, same `transferTitle()` guard pattern.
- `AdminBookingsPage.tsx`: the list's "Tour" column is renamed "Trip" (a transfer's route now renders there too, and a column header naming "Tour" over a transfer row would be a false label). Both the mobile card and the table row show `transferRouteLabel` + `pickupTime` + `vehicleTypeLabel`.
- `AdminBookingDetailPage.tsx`: new "Transfer" section (absent for a tour booking) carrying the full guest-field set — vehicle, pickup time, day-use end time, drop-off address with a Maps link, luggage count, flight/airline.
- `AdminCalendarPage.tsx`: the day's trip list and the assign-panel's own label line both show the route label in place of the generic fallback; the trip list also shows pickup time and vehicle type.

### A deliberate deviation from the plan's literal text, stated here as the plan's own precedent asks

The plan's T23 row reads "product type, vehicle type, route (or custom description), and the transfer-only guest fields" for all four pages. What actually shipped:

- **Detail page** (`AdminBookingDetailPage.tsx`): the full set — vehicle type, route, and every guest field (pickup time, day-use end, drop-off + maps, luggage, flight/airline).
- **The three list surfaces** (`AdminBookingsPage.tsx`, `AdminCalendarPage.tsx`'s trip list, `DeparturesBoard.tsx`): route label + pickup time + vehicle type. The long-tail guest fields (day-use end time, drop-off address/maps, luggage, flight/airline) are detail-page only.

This mirrors T22's own list-vs-detail precedent (`DriverTripRow` carries less than `TripDetail`) rather than literally duplicating every field onto every screen. `productType` itself was never added as a separate raw field anywhere — exactly as T22 didn't add one to the driver screens — because which of `tourTitle`/`transferRouteLabel` is non-null already distinguishes the product, the same signal every other surface in this feature uses.

### Mutation-proved this task (self-review via `advisor()`, no dedicated agent — T23 is Sonnet/combined per the plan)

- `DeparturesBoard.tsx`'s `progress.total === 1` branch: forced to `false`, confirmed the three zero-stop tests in `departures-board.test.tsx` went red, restored.
- The `tourId === null` guard on `transferTitle()`, at all four of its new call sites (`bookings.ts` list, `bookings.ts` detail, `calendar.ts` month, `departures.ts`): each forced to call `transferTitle()` unconditionally, confirmed the corresponding "reads null for a tour booking" assertion caught it answering `'Custom transfer'` instead of `null`, restored.
- Two `vehicleTypeLabel` assertions written as `.not.toBeNull()` were found, during this pass, not to discriminate a wrong join from a right one — tightened to compare against the real vehicle type name (see the two follow-up commits above) rather than carrying a mutation-proof obligation they couldn't pass.

### Test counts (full five-check pass, all three packages, against the final committed state)

- server: 134 files / 2689 tests
- client: 84 files / 1060 tests
- shared: 9 files / 109 tests
- Two new server test files: `admin-transfer-departures.test.ts` (2 tests, Commit A) and `admin-transfer-bookings-calendar.test.ts` (4 tests, Commit B) — split along the same commit boundary as the production code, each with its own fixture day (`2095-09-13` and `2095-09-12` respectively, each confirmed by `grep -rn` to be otherwise unused in `server/src`).
- Client build needed `ALLOW_PLACEHOLDER_BUILD=1` to get past `check-placeholders.mjs` — this is **pre-existing dev-database seed state** (seeded sample reviews still published, `settings.content_unverified` still set), unrelated to T23. Noted here so the next task doesn't rediscover it as a regression.

### Noted, not actioned

- The `transfer-booking-surfaces.test.ts` (Task T6) module doc and its departures-board test's inline comment were both updated to record that T18/T22/T23 have now done the display work those comments used to call unfinished — T24 (portal and notification copy) is the one surface still open.

## Carried forward, still open (unchanged by T23)

- **Owner decision (T20, HANDOVER-9/10):** the three-item finance-reach gap.
- **T17 finding, still open:** `shared/src/schemas/public.ts`'s `inquiryInput` missing `.strict()`.
- **Owner decision (T21, HANDOVER-10):** the quote-ready email is missing pickup time and deposit-vs-total info.
- **Not fixed, named (T21, HANDOVER-10):** `sendAssignmentNotice()`'s missing-booking-id log gap in `dispatch.ts`.
- **Noted, not actioned (T22, HANDOVER-11):** `DriverTripsPage.tsx`'s unlabelled list-row pickup-time text node; the four non-route detail fields' unenforced cross-table invariant; `money.ts`'s no-write-invariant test naming (now stale in a new way — the guard moved to `services/transfers/display.ts`'s own file, which carries no such invariant comment yet; worth a one-line note if T24 or a later task touches that module again); `driver-transfer-trip.test.ts`'s `cleanup()` array-reset asymmetry; dead `TRANSFER_BOOKING_LABEL` code on the two driver screens (now _also_ true on the three admin list surfaces T23 touched, for the same reason — every transfer booking resolves a real `transferRouteLabel`).

## Migrations owed

Unchanged: 0015–0025 need to be applied to both `rg_travel` and `rg_travel_test` on the server (back up before applying, per 0024's own column-removal note). T21, T22 and T23 are all schema-free; nothing new added this batch.

## Next

Proceeding to T24 — Portal (My Booking) renders transfer fields; `notify()` template copy checked for tour-only language across every event — under the standing "yes proceed" authorization into Batch 6. Sonnet model, combined review. T24 completes Batch 6 (T21–T24).
