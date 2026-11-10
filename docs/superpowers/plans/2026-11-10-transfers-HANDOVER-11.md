# HANDOVER-11 — T22 complete, proceeding to T23

## T22: driver portal carries transfer fields (`TripDetail` / `DriverTripRow`)

Commits:

- `e7f3fc9` — T22: TripDetail and DriverTripRow carry transfer fields; zero-stop check-in confirmed
- `591caa4` — T22 follow-up: address dedicated Opus review findings

Dedicated Opus review ran against `e7f3fc9` and returned 7 should-fix items, all addressed in `591caa4`:

1. `TripDetail` was missing `luggageCount`/`flightNumber`/`airline` — the plan's own file table names them explicitly for this screen. Added.
2. Real client bug: `DriverTripPage.tsx` dropped the pickup-time line whenever `pickup` address was null. Fixed — the "Pickup" heading (with its `· HH:mm`) now renders whenever either `pickup` or `pickupTime` is non-null; the address line is a nested conditional beneath it.
3. Four stale "T22 decides this" code comments (two in `checkins.ts`, one in `departures.ts`, one in `transfer-booking-surfaces.test.ts`) rewritten to record the actual answer.
4. `StopList.tsx`'s zero-stop copy was status-blind ("Trip started" even once completed, and still told a completed trip to "Tap Complete trip"). Made status-aware.
5. No reverse-direction test coverage for `transferRouteLabel`. Added (`driver-transfer-trip.test.ts`, 4th `it()` block).
6. No assertion that the 8 new `TripDetail` fields are null for a tour. Added to `driver-trip-detail.test.ts` and `driver-trips.test.ts`.
7. Test-fixture type-safety gap (untyped mock payloads can silently drift from the widened interface) — added explicit `: TripDetail` / `: DriverTripRow[]` annotations, which surfaced and fixed a real `??`-discards-`null` bug in the `trip()` test helper.

Every fix mutation-proved. Full five-check pass (typecheck/lint/format/test/build) green on all three packages before each commit:

- server: 132 files / 2683 tests
- client: 84 files / 1051 tests
- shared: 9 files / 109 tests

No migration owed — T22 is schema-free.

### Noted, not actioned (lower-priority nitpicks from the T22 review)

- **#4** `DriverTripsPage.tsx`'s pickup-time fragment in the list row is a bare text node between separators, not in its own labelled span. Cosmetic; not fixed.
- **#5** The four non-`transferRouteLabel` detail fields (`dayUseEndTime`, `dropoffAddress`, `dropoffMapsUrl`, plus the luggage/flight/airline trio) rely on an unenforced cross-table invariant (that `bookingTransferDetails` rows line up 1:1 with their booking) rather than a DB-level guarantee beyond the PK relationship already reviewed as safe.
- **#8** `money.ts`'s doc comment, which states the module has no money-writing responsibility, is now guarded by a test file named after a different surface (`driver-transfer-trip.test.ts`) rather than one named after `money.ts` itself.
- **#10** `driver-transfer-trip.test.ts`'s `cleanup()` resets its tracked-ID arrays asymmetrically — some arrays are cleared, others aren't re-initialized the same way between test runs. Harmless given the file's own per-test ID generation, but asymmetric.
- **#11** `TRANSFER_BOOKING_LABEL` (the old fallback string) is now provably dead code in both `DriverTripPage.tsx` and `DriverTripsPage.tsx` — every transfer booking now resolves `transferRouteLabel` to a real value, so the `?? TRANSFER_BOOKING_LABEL` branch never fires. Left in place as a defensive fallback, not removed.

None of these are correctness bugs; each is a real observation a future reviewer may re-derive independently.

## T23 now carries an explicit extra responsibility

T23's row in the plan already owns `AdminBookingsPage.tsx` / `AdminBookingDetailPage.tsx` / `AdminCalendarPage.tsx` / `AdminDeparturesPage.tsx`. The dedicated T22 review surfaced a real divergence that lands squarely inside that scope and **must be closed by T23, not just noted again**:

> `DeparturesBoard.tsx` renders `{done} of {total} stops` and a percent bar from those same two fields. For a transfer, `total` is always `1`, so the board reads "1 of 1 stops" at 100% full the instant the trip starts — the board says the trip is finished while the van is still at the pickup. `StopList.tsx` (the driver's own screen) already special-cases `total === 1` to distinguish "Trip started" from "Trip completed"; the admin board does not. The comment above `todayDepartures()` in `server/src/routers/admin/departures.ts` names this gap already — T23 is where the fix (or a deliberate written decision not to fix it) actually lands, mirroring `StopList.tsx`'s branch as the shape to follow.

T23 is also the natural point to decide whether `routeDisplayName`/`transferTitle` (now exported from `server/src/services/reports/money.ts`) should be extracted into their own module — `money.ts`'s own doc comments defer that decision explicitly to T23, once T23's caller shape is known.

## Carried forward, still open (unchanged by T22)

- **Owner decision (T20, HANDOVER-9/10):** the three-item finance-reach gap. Not touched by T21 or T22.
- **T17 finding, still open:** `shared/src/schemas/public.ts`'s `inquiryInput` missing `.strict()`.
- **Owner decision (T21, HANDOVER-10):** the quote-ready email is missing pickup time and deposit-vs-total info.
- **Not fixed, named (T21, HANDOVER-10):** `sendAssignmentNotice()`'s missing-booking-id log gap in `dispatch.ts`.

## Migrations owed

Unchanged: 0015–0025 need to be applied to both `rg_travel` and `rg_travel_test` on the server (back up before applying, per 0024's own column-removal note). T21 and T22 are both schema-free; nothing new added this batch.

## Next

Proceeding to T23 (`AdminBookingsPage.tsx`/`AdminBookingDetailPage.tsx`/`AdminCalendarPage.tsx`/`AdminDeparturesPage.tsx`) under the standing "yes proceed" authorization into Batch 6. Sonnet model, combined review (not dedicated) — except the `DeparturesBoard.tsx` item above is now a named deliverable of that task, not an optional nitpick.
