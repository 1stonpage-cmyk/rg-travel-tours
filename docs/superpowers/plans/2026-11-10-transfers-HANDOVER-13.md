# HANDOVER-13: T24 complete — Batch 6 (T21-T24) closed

## T24 scope

Two deliberately separate halves, both done:

1. **notify() copy sweep** — every email template `renderTemplate()` can produce for a transfer booking (`tourTitle: null`) reads correctly for a transfer, not just a tour.
2. **Portal "My Booking"** — the customer-facing booking page shows a transfer's product (route, pickup time, vehicle, drop-off, luggage, flight) the same way the admin/driver surfaces already do since T22/T23, plus the same tour-only-wording sweep extended to every Portal-reachable component once the full client suite surfaced the rest.

Explicitly **not** done, and not required by the plan text: naming a transfer's _real route_ in the prose sentences that still say generic things like "your trip" (e.g. "Your trip is tomorrow"). That's a larger change requiring the same four-join pattern inside `notify()`'s callers to pass a route label into the payload. No task in Batch 6 owns it.

## Commits

| Task | Commits                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T21  | `cee2985` (guest quote-ready notice + staff-quote-to-cash lifecycle test), `c25fd08` (dedicated Opus review follow-up), `2763fe6` (HANDOVER-10)                                            |
| T22  | `e7f3fc9` (TripDetail/DriverTripRow transfer fields, zero-stop check-in), `591caa4` (dedicated Opus review follow-up), `5bf93fd` (HANDOVER-11)                                             |
| T23  | `93c7a9a` (todayDepartures route/pickup, board "1 of 1" fix), `929a9a4` (bookings list/detail + dispatch calendar), `1fb0016` + `6c70805` (follow-up tightenings), `6ea63a8` (HANDOVER-12) |
| T24  | `e5a82ec` (notify() sweep), `8c60248` (Portal "My Booking" + extended sweep)                                                                                                               |

## The eight-event audit (the deliverable for the notify() half)

Every event `renderTemplate()` can render, checked against a transfer payload (`tourTitle: null`) for literal "tour" language and for subtler tour-only assumptions (guide, itinerary, meeting point, what to bring, hotel lobby):

| Event                     | Verdict                 | Note                                                                                     |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `booking_confirmed`       | **Fixed**               | "Balance on tour day" → "Balance on trip day" (html + text)                              |
| `driver_assigned`         | **Fixed**               | Same balance-line fix (html + text)                                                      |
| `trip_reminder`           | **Fixed**               | Subject "Your tour is tomorrow" → "Your trip is tomorrow"; heading and text body matched |
| `receipt_received`        | Already product-neutral | No tour-only language found                                                              |
| `payment_rejected`        | Already product-neutral | No tour-only language found                                                              |
| `admin_receipt_to_verify` | Already product-neutral | Internal/admin-facing, references ref code and amount only                               |
| `review_request`          | Already product-neutral | No tour-only language found                                                              |
| `custom_quote_ready`      | Already product-neutral | No tour-only language found                                                              |

Note: `NotifyPayload.tourTitle` itself is still conditionally rendered as a "Tour" row when non-null — correct and unchanged, since that row only ever appears on an actual tour booking.

3 new tests added to `server/src/__tests__/notify.test.ts` proving the three fixed events say "trip"/never "tour" under a transfer payload; each mutation-proved (reverted the production string, confirmed red, restored).

## Portal "My Booking" (the second half)

`portal.booking` widened with the same 1:1-or-absent four-join pattern used since T22's `loadDriverTrip` (`bookingTransferDetails`, `transferRoutes`, two `transferPlaces` aliases, `vehicleTypes`), guarded by `row.tourId === null` exactly like the T23 admin call sites. Detail-screen field set (full guest fields, not the list-screen subset) since My Booking is a single-booking detail view. New test file `server/src/__tests__/portal-transfer-booking.test.ts` (fixture day `2095-09-14`, confirmed unique in `server/src` via unfiltered grep — matches only that file's own comment and declaration).

Client: `PortalBookingPage.tsx` gained a conditional "Your transfer" section (vehicle, pickup time, day-use end time, drop-off address + "Open in Maps" link, luggage count, flight/airline), rendered only when `transferRouteLabel !== null`. Header falls back `tourTitle ?? transferRouteLabel ?? TRANSFER_BOOKING_LABEL`.

## Unplanned finding: the full-suite sweep surfaced more than the targeted grep did

Running the full client test suite before committing (not just the directly-edited file, per the governing discipline) surfaced tour-only wording the initial targeted grep of `pages/portal/`/`components/portal/` missed or under-covered:

- `ReviewForm.tsx` — "How was your tour?" → "How was your trip?"
- `DriverCard.tsx` — "...until the end of your tour day." → "...end of your trip day."
- `shared/src/portal.ts`'s `TRACKER_STEPS` — see below; this one wasn't in either portal directory at all.

## Spec update: `TRACKER_STEPS` fifth step renamed — owner-confirmed

**§7 of BUILD_SPEC.md (line 512) names the five My Booking tracker steps.** This step renders on _every_ My Booking page, transfer bookings included, and has done so since the tracker first existed (T6) — meaning every transfer booking had been showing a step literally labeled "Tour day" since before this task.

T24 renamed `shared/src/portal.ts`'s `TRACKER_STEPS` fifth entry from `'Tour day'` to `'Trip day'`, with the corresponding `portalTracker()` step object and `shared/src/portal.test.ts` updated to match.

**Owner confirmed 2026-11-10: "Trip day" is approved for all products.** BUILD_SPEC.md §7's table (line 512) was updated to "Trip day" in the same pass, so the spec and the code now agree — this is no longer a deviation. Confirmed via an unfiltered repo-wide `grep -rn "Tour day" . --exclude-dir=node_modules --exclude-dir=.git`: the only remaining hit is `docs/superpowers/plans/2026-10-13-week4-manual-qr-and-portal.md:860`, a historical plan document from before this rename — left as-is, since historical plans aren't rewritten after the fact. No stray rendered-copy "Tour day" exists anywhere in the app or the current spec.

## Gaps now owned: T25b (added 2026-11-10, owner)

The three gaps below were un-owned when this handover was first written; the owner added **T25b** to Batch 7 (before T27) to close them in the same pattern T24 used for Portal:

1. **`BookingStatusPage.tsx:238`** — same `tourTitle ?? TRANSFER_BOOKING_LABEL` gap `portal.booking`'s heading had before this task; the public booking-status page still has no transfer field display at all.
2. **`ManualQrPage.tsx` / `portal.manualPayment`** — identical gap: no transfer field display.
3. **`checkout.bookingStatus` / `checkout.bookingLookup`** — identical gap.

(The admin cash panel's "recorded ₱3,150 on tour day" wording was deliberately left alone — correctly out of scope for this task, a wording-only nitpick on an admin-internal surface, not a customer-facing gap. Still un-owned.)

## Local dev URLs

This project's local dev servers are **client 5180 / API 3100**. Ports 5173, 3000, and 3111 belong to Kong PMS — a separate, unrelated project this session must never touch or report against. (Correction: the chat summary at the end of the T24/Batch-6 report incorrectly named 5173/3000 as this project's local URLs — that was a mistake, not a code change; this file is the correct record.)

## Test counts (final, both T24 commits included)

- Server: 135 files / 2694 tests
- Client: 84 files / 1066 tests
- Shared: 9 files / 109 tests
- All three builds pass (client via `ALLOW_PLACEHOLDER_BUILD=1`, pre-existing dev-DB seed-state bypass, unrelated to this task)

## Carried-forward open items

- T20: three-item finance-reach owner decision (unresolved — see questions below)
- T17: `shared/src/schemas/public.ts`'s `inquiryInput` missing `.strict()` (finding, not fixed)
- T21: quote-ready email missing pickup-time/deposit-vs-total info (unresolved — see questions below)
- T21/`dispatch.ts`: `sendAssignmentNotice()`'s missing-booking-id log gap (not fixed)
- T22 nitpicks: unlabelled list-row pickup time on `DriverTripsPage.tsx`, others listed in HANDOVER-11/12
- Resolved 2026-11-10: `TRACKER_STEPS`/BUILD_SPEC §7 — owner approved "Trip day" for all products, spec updated to match (see above)
- Resolved 2026-11-10: the 3 Portal/checkout transfer-field gaps are now owned by T25b, added to Batch 7

## Owner questions (plain-English, with recommendation)

**1. T20's finance-reach gap.** When a package/tour price is edited by staff with the `finance` role, does that edit need the same dual-control/approval step money-affecting admin actions elsewhere get, or is editing a listed price (versus moving real money) a different category that doesn't need it?
_Recommendation: treat it as a different category._ Nothing changes hands when a price is edited — only the next booking is priced differently. The dual-control pattern elsewhere in this codebase guards an action that releases or captures funds; this one doesn't. Unless there's a specific incident or audit requirement in mind, this one can stay as a plain edit.

**2. T21's quote-ready email gap.** The guest email telling someone their custom quote is ready doesn't currently say the pickup time or spell out the deposit amount versus the full total — should it?
_Recommendation: add both._ A guest deciding whether to accept a quote needs to know what they're committing to pay now versus later, and pickup time is exactly the kind of detail that avoids a confused follow-up email. This is a small, low-risk addition to an existing template, not a new feature — worth doing whenever a task touches that email next.

## Migrations — clarified 2026-11-10

All 26 migrations (0000–0025) are already applied **locally**, to both `rg_travel` and `rg_travel_test` — confirmed this session by querying each database's `__drizzle_migrations` table directly: 26 rows in each, matching the 26 `.sql` files in `server/src/db/migrations`. Nothing is owed locally.

What's owed is unchanged and was always meant to mean **the actual deployed server**, not these local dev/test databases: 0015 through 0025 still need to be applied there (back up before applying 0024, per its own column-removal note). T21–T24 are all schema-free; nothing new added across this whole batch.
