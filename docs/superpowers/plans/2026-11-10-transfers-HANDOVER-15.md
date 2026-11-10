# HANDOVER-15: T25b, T20b, T21b complete

Continues HANDOVER-14 (T25). All three tasks below are Sonnet/combined review per the owner's own classification — implemented directly, one combined self-review each, checked in at the batch boundary (plus one `advisor()` pass after T21b's commit, which caught two small polish items, both fixed in this same handover's commit — see "Post-commit polish" below).

## T25b — guest-facing pages show transfer details

**Commit `4bfd8db`.** Owner ask: BookingStatusPage, ManualQrPage, `checkout.bookingStatus`, and `checkout.bookingLookup` must show transfer fields the same way My Booking (T24) does.

**Scope decision — deliberately narrower than T24's field set.** The owner's own list named five things: route + direction, vehicle type, pickup time, pickup/drop-off, flight if set. That's what shipped — `transferRouteLabel`, `vehicleTypeLabel`, `pickupTime`, `dropoffAddress`, `flightNumber`/`airline`. T24's My Booking page additionally shows `dayUseEndTime`, `luggageCount`, and `dropoffMapsUrl`; none of those were in the owner's list for this task, so none were added here. If the owner wants parity with My Booking's full set on these guest-facing pages too, that's a one-line follow-up (the same four-join query already selects enough; it would just mean widening the return type and the two page components).

**Where it landed:**

- `server/src/routers/public/checkout.ts` — both `bookingStatus` and `bookingLookup` widened with the same four-join pattern already used elsewhere (`bookingTransferDetails` + `transferRoutes` + two `transferPlaces` aliases + `vehicleTypes`), guarded by the `tourId === null` check.
- `server/src/routers/public/portal.ts` — `manualPayment` widened identically.
- `client/src/pages/public/BookingStatusPage.tsx`, `client/src/pages/portal/ManualQrPage.tsx` — new conditional "Your transfer" section; heading falls back to the route label before `TRANSFER_BOOKING_LABEL`.
- Tests: `server/src/__tests__/checkout-status-transfer-fields.test.ts` (new), `client/src/__tests__/booking-status.test.tsx`, `client/src/__tests__/manual-qr-page.test.tsx`.

## T20b — audit every price edit with old → new values

**Commit `e7ab102`.** Owner ask: no dual-control approval needed, but every price edit (tour tier, package, route/vehicle-type price) must write an `audit_log` row naming who, when, and old → new. Add a test for each gap.

**The three write paths, confirmed by grep across the server tree, none missed:**

1. `services/tours/upsert.ts` (reached by `admin.tours.update`) — added a pre-write read of the existing tier rows (`previousPriceTiers`), returned alongside the new ones; `routers/admin/tours.ts`'s `auditDataFor()` now includes both.
2. `routers/admin/packages.ts` `update` — added a pre-write `SELECT oldPriceCentavos, newPriceCentavos` read; audit row now carries `previousOldPriceCentavos`/`previousNewPriceCentavos` alongside the package's own (differently-named) marketing columns — the naming collision is called out inline in the code so a future reader doesn't confuse "previous price" with the package's own `oldPriceCentavos` field.
3. `routers/admin/transfer-routes.ts` `update` — zero new reads needed; the existing merge logic already reads `storedPrices` before writing, so the audit `data` was simply widened to nest `{ patch, previousPrices: storedPrices }`.

A fourth site exists — `services/transfers/upsert-route.ts`'s route **create** path (also reached by `admin.transferRoutes.create`) — which has no "previous" by construction (nothing existed before). `admin-transfer-routes.test.ts` already proved the create audit records its prices before this task; `admin.packages.create` is the same. So coverage is complete across all four write sites, with three needing — and now carrying — a "previous" value and one correctly having none.

Tests: `admin-tours.test.ts`, `admin-packages.test.ts`, `admin-transfer-routes.test.ts` — one new test each, asserting both old and new values land in the same audit row.

## T21b — quote-ready email names pickup time, vehicle, and the money breakdown

**Commit `1618ea5`**, plus a small post-commit polish pass (not yet its own commit — see below). Owner ask: the `custom_quote_ready` email should include pickup date/time, route + direction, vehicle type, deposit due now vs. full total vs. balance on the day, and the quote/hold expiry in Asia/Manila time.

**"Route + direction" was already covered before this task started.** Read `services/transfers/convert-quote.ts:218-226` directly: `convertTransferQuote()` always produces `routeId: null, direction: 'forward'` — a staff-quoted booking never has a catalog route or a meaningful direction. The pre-existing `tripLabel` field (free-text `customRouteDescription`) is what actually carries "where this trip goes" for this email, and it already rendered before this task. No fake direction field was invented to satisfy the letter of the ask.
**Pickup date was already shown** via the existing `tourDate` field; **hold expiry in Manila time** was already shown via `manilaDateTimeLabel()` (pre-existing, also used by `holdExpiresAt`). What was actually missing, and is what this task added: pickup **time**, vehicle type, and the due-now/balance breakdown.

**Where it landed:**

- `server/src/services/notify/templates.ts` — `NotifyPayload` gained `pickupTime?`, `vehicleTypeLabel?`, `dueNowCentavos?` (all `custom_quote_ready`-only). New conditional trip-detail rows and a money line.
- `server/src/routers/admin/transfer-quotes.ts` — `sendQuoteReadyNotice` widened its query (two new joins: `bookingTransferDetails`, `vehicleTypes`) and computes `dueNowCentavos` the same way `portal.manualPayment`'s `amountDueCentavos` already does from the same price snapshot.
- Tests: `server/src/__tests__/notify.test.ts` (4 new template tests), `server/src/__tests__/admin-transfer-quotes.test.ts` (extended the existing conversion test with 5 assertions against the real mail, not template fallback).

### Post-commit polish (advisor review after `1618ea5`)

Ran `advisor()` at the Batch 7 boundary per the governing rule. Two small fixes applied, both re-verified green, not yet separately committed (bundled into this handover's commit):

1. **Removed a duplicated "Total" line.** The email's `details` table already states the total; the new money line also said "Total: ₱X" right below it. Dropped the redundant "Total:" clause from `moneyHtml`/`moneyPlain`, keeping "Due now" and "Balance on the day." Re-ran `notify.test.ts` and `admin-transfer-quotes.test.ts` — both still green, since their assertions on the total figure are satisfied by the `details` row that was always there.
2. **Documented `payMode === 'full'` as an intentional fail-safe, not live code.** `convertTransferQuote()` always writes `'deposit'`, so that branch is unreachable today. Added a comment naming this explicitly, the same way `driver.startTrip` documents its own already-`in_progress` guard for a status its own path can't currently produce. No behavior change.

## Test counts (final, this segment)

Server: 137 files / 2709 tests, exit 0 (full suite, before the post-commit polish — that pass touched only template copy and a comment, re-verified via the two affected test files plus typecheck/lint/format/build, not a full re-run).

## Owner questions — answered and implemented

- **T20 (finance-reach gap):** owner answered no dual-control approval; audit-log every price edit instead. Implemented in T20b above — all three edit paths now write old→new.
- **T21 (quote-ready email gap):** owner answered yes, enrich the email. Implemented in T21b above.

Both are closed, not pending.

## Carried forward, still un-owned

- **`dispatch-assign.test.ts`'s missing `audit_log` teardown** (from HANDOVER-14) — still nobody's.
- **Admin cash panel's "recorded ₱3,150 on tour day" wording** — should likely say "trip day" now that the rename is owner-approved (BUILD_SPEC §7, this batch). Cosmetic, not fixed here — out of this batch's scope, flagging for whoever next touches that panel.
- **T17's missing `.strict()`** on an input schema (flagged in an earlier handover, still open).
- **`dispatch.ts`'s missing-booking-id log gap** (flagged in an earlier handover, still open).

## Batch 7 process note

T25b, T20b, T21b all implemented directly per advisor's guidance for this batch, with one combined self-review each rather than a dedicated review pass, and one `advisor()` call at the batch boundary (after all four commits) rather than per-task.
