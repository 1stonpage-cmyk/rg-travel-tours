# HANDOVER-14: T25 complete

## Commit

`bc566d8` — end-to-end regression proof, through the real app, for both a transfer and a tour. Dedicated Opus review ran (one real finding, four smaller ones), all fixed in the same commit; see the commit message for the full breakdown.

## What T25 proves, concretely

- **Transfer composition** (`server/src/__tests__/transfer-walkthrough.test.ts`): two same-day non-overlapping jobs assigned to one van AND one driver through the real `admin.dispatch.assign` — with both bookings read back afterward and the shared van+driver pinned on each (not just inferred from `{ok:true}`, the gap the dedicated review caught). A third job is refused specifically at the driver's daily cap, isolated from any van confound.
- **Transfer full lifecycle**: hold → manual QR deposit → staff approval → dispatch → driver check-in (start, a refused zero-stop check-in, complete) → review-eligible (read off the My Booking tracker) — all through `supertest` against the real Express app.
- **Tour, the same way** (extension to `phase1-walkthrough.test.ts`, its own dedicated fixtures so the shared walkthrough tour other tests in that file depend on is untouched): real `admin.dispatch.assign` + a real driver check-in through one real itinerary stop. Every post-confirmation status in that file previously came from a direct `UPDATE bookings SET status = ...` — never a real dispatch or check-in call. T25 is the first test in that file to drive either for real.

## Leak detector — verified, not assumed

The dedicated review counted DB residue directly after running these two files (plus `dispatch-assign.test.ts` and `trip-checkins.test.ts` together, 110/110): every leak-tracked table (`bookings`, `drivers`, `vans`, `payments`, `users`, `tripCheckpoints`, `fleetDateSlots`, `coupons`, `couponRedemptions`, `reviewHelpfulVotes`) at zero, `reviews` at 6 (the seed baseline). Also confirmed clean: `tourItineraryStops`, `bookingTransferDetails`, no stray `t25`-named `transferPlaces`/`transferRoutes` rows, no `fleetDateSlots` row for `2099-12-30`, `payment_qr` restored to its unconfigured seed value, and the two receipt files this run created were removed (two OTHER stale receipt files remain in `uploads/receipts`, dated 2026-10-13 and 2026-10-27 — pre-existing debris, not T25's). The full suite run that followed the fixes: 136 files / 2697 tests, exit 0.

## Un-owned finding, surfaced by the dedicated review, not T25's to fix

**`dispatch-assign.test.ts` has no `audit_log` teardown of its own.** `phase1-walkthrough.test.ts`'s `afterAll` runs an unscoped, action-name-filtered `audit_log` delete (`booking.held`, `booking_assigned`, `trip.started`, etc. — widened by T25 to cover four of the five newly-added names; `booking_reassigned_in_progress` is harmless in that list even though neither new T25 test produces it, since no test asserts the delete's scope). That sweep may currently be the **only** thing reclaiming `dispatch-assign.test.ts`'s own `booking_assigned` rows. This is latent, not live: `server/vitest.config.ts:48` sets `fileParallelism: false`, so the two files' tests never interleave. But it means five `toEqual([])` assertions in `dispatch-assign.test.ts`/`trip-checkins.test.ts` would pass **spuriously** (because the row was already gone) rather than fail, if phase1's sweep ever stopped running before them or ran between a write and that assertion. Nobody owns giving `dispatch-assign.test.ts` its own scoped `audit_log` cleanup. Flagging it rather than fixing it here — the fix (scoping phase1's delete by its own booking ids) risks starting to leak `dispatch-assign.test.ts`'s rows instead, which needs its own careful pass, not a T25 side-effect.

## Test counts (final)

Server: 136 files / 2697 tests, leak detector silent, build clean.

## Batch 7 process note

T25 required dedicated Opus review per the plan; T25b, T20b and T21b (next) are all Sonnet/combined per the owner's own classification, following patterns T22–T24 already established. Implementing these directly with one combined self-review each, checking in at the batch boundary rather than per-task.
