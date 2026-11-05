# Transfers Launch — Handover, 2026-11-03

**Status: T1–T8 done locally, NOT pushed. Next task: T9.**

Plan: `docs/superpowers/plans/2026-10-31-transfers-launch.md`. `main` was `origin/main` at `a105df9` (T1–T6 already pushed) when this session started. This session finished T7 (which was half-built, uncommitted, in the working tree) and built T8 from scratch.

## Commits, T1–T8

| Task   | Commit                | Label                                                                                                                    |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| T1–T4  | (pushed, pre-session) | Spec correction, vehicle types, transfer routes/pricing schema                                                           |
| T5     | `27574e6`             | product_type discriminator, nullable tour_id, booking_transfer_details (T5)                                              |
| —      | `3540d92`             | a tour may not carry a route_id; unfail-open the schema test gate (T5 review I1-I3)                                      |
| T6     | `2b16a34`             | fix(bookings): audit every tours-joined query for a null tour_id (T6)                                                    |
| —      | `a105df9`             | test(bookings): move the T6 surface fixtures off admin-reports' EMPTY_MONTH (I1) — **origin/main HEAD at session start** |
| **T7** | **`85f8682`**         | **feat(transfers): window-aware vehicle+driver capacity for transfers (T7)**                                             |
| **T8** | **`056f05b`**         | **feat(transfers): window-aware dispatch assignment for transfers (T8)**                                                 |

Nothing has been pushed. `git log --oneline -2` on `main` currently shows `056f05b` then `85f8682`.

## What T7 built

- `drivers.max_transfer_jobs_per_day` (nullable override) and `booking_transfer_details.route_duration_minutes_used` (frozen duration — see below) — migrations **0019** and **0020**.
- `transfer_operations` settings block (`bufferMinutes`, `minNoticeHours`, `staffQuoteHoldHours`, `maxTransferJobsPerDriverPerDay`), seeded via `seedBase` (insert-only).
- `services/transfers/overlap.ts` — pure `peakOverlap`/`overlaps`/`computeTransferWindow`/`clockTimeToMinutes`.
- `services/transfers/capacity.ts` — `assessTransferCapacity()` (all five Architecture §2/§2a conditions) and the shared pool primitives.
- `services/capacity.ts` (tour gate) extended with the shared-pool subtraction so a tour and a transfer can never both oversell the fleet.
- Concurrency-proven for both a vehicle-short and a driver-short race, mirroring `capacity.test.ts`'s own tour races.
- **Dedicated Opus review (owner-mandated highest scrutiny) found one Critical issue, fixed in the same commit**: `transferWindowsByType` was reading `transfer_routes.estimated_duration_minutes` LIVE for an already-booked transfer, so an admin shortening a route's duration after a booking was taken would silently shrink that booking's reserved window — an oversell. Fixed by freezing the duration onto `booking_transfer_details.route_duration_minutes_used` at hold time (migration 0020), mirroring how the buffer was already frozen. Also closed three test-coverage gaps (fail-closed branches, the `driver_leaves` START boundary) and softened an admin settings hint that overclaimed a per-driver UI control T16 hasn't built yet. Re-reviewed clean.

## What T8 built

- `vansFreeOn`/`driversFreeOn` (`services/dispatch/availability.ts`) gained an opt-in `transferWindow` (and `vehicleType` for vans) that switches from the original whole-day exclusion (every pre-T8 caller) to a window-aware one for a transfer assignment. `driversFreeOn` additionally excludes on the daily job-COUNT cap, independent of overlap.
- `assignVanAndDriver`'s (`services/dispatch/assign.ts`) former stopgap throw on `tour_id === null` is replaced with the real transfer-assignment path: `takeFleetDateLock` instead of `takeSlotLocks`, the booking's own FROZEN window recomputed (never the live catalog route), and a new `driver_at_daily_cap` refusal reason (`shared/src/dispatch.ts`, wired through the router and `AssignPanel.tsx`'s copy map).
- **Dedicated Opus review (owner-mandated) found no Critical issues.** Fixed three Important ones, all in the same commit:
  1. `vehicleType` could silently narrow a TOUR'S van pool if ever passed without `transferWindow` — now ignored outside the transfer branch.
  2. The `van_too_small` diagnostic could misreport a wrong-type or already-busy van as merely "too small" on the transfer branch, where seats never gate selection — now always `van_unavailable` there.
  3. A driver on leave who also happened to be at their daily cap was reported `driver_at_daily_cap` instead of the true reason — the diagnostic now defers to `driver_unavailable` for an inactive or on-leave driver.
- Each fix has its own regression test, each proven able to fail (broken, confirmed red, restored) before being committed.

## Migrations owed on the server

**0015 through 0020**, in order — none of these have been applied anywhere but local `rg_travel`/`rg_travel_test`:

| #    | What                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 0015 | `vans.vehicle_type`                                                                                                    |
| 0016 | `transfer_routes`, `transfer_route_vehicle_prices`                                                                     |
| 0017 | `bookings` nullable `tour_id` + `product_type`/`route_id`/`vehicle_type_requested` + CHECK; `booking_transfer_details` |
| 0018 | `bookings_product_type_shape` CHECK correction (adds the `route_id IS NULL` tour clause)                               |
| 0019 | `drivers.max_transfer_jobs_per_day`                                                                                    |
| 0020 | `booking_transfer_details.route_duration_minutes_used`                                                                 |

**After applying these to the production/staging server, also re-run `pnpm --filter @rg/server db:seed`** (the insert-only base seed) — the new `transfer_operations` settings row does not exist until that runs, and `readDefaultDriverTransferCap`/`readTransferOperationsSettings` throw "Missing setting" without it, which 500s every tour quote and hold, not just transfer ones.

## ASSUMPTIONS

1. **T7's duration-freeze fix (migration 0020) is a NEW column beyond what the plan specified** — the plan's Architecture §2/Global Constraints only named the buffer as something to freeze onto the booking, not the route duration. The dedicated review found that omission was a real oversell path and the fix extends the plan's own "price-at-booking" discipline rather than contradicting it. No owner decision is on record for this specific column; see QUESTIONS below.
2. **`driver_at_daily_cap` (T8) is a new `AssignRefusal` value**, not called for explicitly in the plan's T8 row, added because the codebase's own documented precedent (`driver_unavailable`'s doc comment) argues for a distinct reason wherever the generic one would send a dispatcher hunting for the wrong fix.
3. **T8 deliberately does not touch `services/dispatch/suggest.ts` or `routers/admin/calendar.ts`** — per the plan's own task table, making the calendar dropdowns and auto-suggest window-aware is later admin-UI work, not T7/T8. The enforcement is correct; a dispatcher cannot yet see or pick transfer-safe options through today's UI because no transfer-dispatch UI exists yet at all.
4. **A custom, staff-quoted one-way transfer (no catalog route) still has no stored duration** — `computeTransferWindow` throws rather than guessing one. Unreachable until T19 builds the staff-conversion flow, which must supply a real duration some other way (a new column, most likely) rather than defaulting one.

## UNRELATED BUGS

None found during T7 or T8's work.

## QUESTIONS (batched, for the owner)

1. **Should a transfer's van assignment enforce `van.capacity >= pax`?** Right now, at both hold time (T7) and dispatch time (T8), a transfer's vehicle selection is by TYPE only (van vs SUV), never by seats — mirroring the hold-time pool math's own precedent that "the type is the fit." This means a small van of the matching type can be sold and assigned to a party that doesn't actually fit, with no refusal and no warning anywhere. Found by T8's dedicated review (Important finding #3). Is this the intended behavior, or should a seat check be added at one or both of these points?
2. **Is freezing `route_duration_minutes_used` (migration 0020, T7) the right fix**, or was a different approach intended for the live-duration-read oversell bug? No owner decision exists on record for this column specifically — it was added reactively during T7's dedicated review, not planned in advance.

---

Next task: **T9** (`services/transfers/pricing.ts` — `quoteTransfer()`: subtotal/coupon/discount/total/deposit, ₱100/₱0 refusals; `checkout.quoteTransfer`). Opus, dedicated Opus review, per the plan.
