# HANDOVER-17 (FINAL): admin Dashboard "Direction B: Control Room" + grouped sidebar + demo transfer bookings

Continues HANDOVER-16 (T26–T29, transfers-launch plan closed). This is a new,
separate task: the admin dashboard rebuild, grouped sidebar, and dev-only demo
transfer bookings, per the owner's 2026-11-10 brief. **All tasks 1A–1G are now
complete.** This handover was first written with 1G pending the owner's seed
re-run; three follow-up commits closed it out — see "Post-handover follow-up"
at the end for the seed-timing fix the owner's first re-run surfaced, the new
`db:clear-demo-transfers` safety tool, and the 360px bug 1G itself caught.

Process per the brief: controller (Sonnet) with Opus advisor, consulted before
each task and before marking done. Implementer Sonnet, one at a time, no
parallel background agents. A dedicated Opus reviewer was dispatched for 1B
(the new server queries) — see "The 1B reviewer" below for why it was stopped
rather than awaited, and why 1E had no separate dedicated review.

## Owner decisions, 2026-11-10, given directly by the owner

1. **Dashboard = Direction B "Control Room"** from
   `.design-preview/admin-dashboard.html` (local, git-excluded, never committed
   or touched).
2. **Sidebar grouping (fixed):** OVERVIEW (Dashboard, Reports) · BOOKINGS
   (Bookings, Trip requests, Payment checks) · OPERATIONS (Dispatch,
   Departures, Vans, Drivers) · TRANSFERS SETUP (Transfer routes, Places,
   Vehicle types) · TOURS SETUP (Tours, Packages — faded with a "Hidden" tag
   while `show_tours` is off, still clickable) · MARKETING (Coupons, Reviews)
   · ADMIN (Staff, Settings). Direction B's sidebar visual style.
3. **Role visibility does not change.** Every role sees exactly the nav items
   and data it can reach today; a group with no visible items disappears.
   Money figures only for roles that already see money (owner, finance).
4. **Demo transfer bookings are wanted (dev-only)** so the dashboard,
   Dispatch, Departures, Booking Status and My Booking can be shown in a demo.

## Named deviations from the literal brief

- **No new `/admin/trip-requests` nav item or page.** Decision 2 names "Trip
  requests" as a Bookings-group nav entry, but 1A's own test (the per-role nav
  SET must be identical to before the regroup) forbids adding one — resolved
  via `advisor()`: Packages stays where it was (Tours Setup), and the
  dashboard's trip-request mini-queue (1C) links into the EXISTING
  `/admin/packages` Enquiries screen instead of a new route. Recorded in
  `admin-nav.ts`'s own comments and the 1A commit message.
- **The "Hidden" tag applies to Tours only, not Packages**, even though
  decision 2 names both. Verified by code inspection: `show_tours` does not
  actually gate `PackagesSection` or `/packages/:slug` anywhere in the public
  app, so tagging Packages "Hidden" would show staff something false.
- **1C's "Needs attention" panel keeps `AlertCard`'s existing card grid**,
  not Direction B's literal dense ledger rows. The mockup's ledger row is
  `<a>label</a><span>count</span>` with no slot for `copy.detail` (the
  `orphaned_on_trip` consequence sentence, the `driver_locked`
  self-clearing-then-unlock ordering) and renders a zero as a bare `—`
  rather than the brief's own DO-NOT: "Zero alerts must still be visibly
  stated as clear, never silently omitted." Both are owner decisions,
  both already pinned by `admin-dashboard-page.test.tsx`. Confirmed via
  `advisor()` before building.
- **1C's stats-row money cell reads "Collected today" / "Pending
  verification"**, not the mockup's literal "To collect today" (an
  outstanding-balance figure 1B never built and this batch was not asked to
  add). It reads the two figures 1B actually built.
- **1C reuses `DeparturesBoard`'s existing card-list "Today's trips" panel**,
  not Direction B's literal dense table — confirmed via `advisor()`: a
  parallel table would re-derive the `total === 1` transfer branch, the
  status-pill tones, the 15-second poll and the amber unassigned-row logic,
  which is exactly the drift risk `CLAUDE.md`'s "build additively" rule warns
  against.

## 1A — grouped sidebar

**Commit `4b86f57`.** `admin-nav.ts` gained `AdminNavGroup`/`GROUP_ORDER` and a
`group` field per nav item; `groupedNavFor(role)` returns the per-role grouped
list with empty groups omitted. `hiddenWhileToursOff` is set only on Tours (see
deviation above). `AdminLayout.tsx` renders grouped sections with icon+label
headings and the faded "Hidden" tag, reading `settings.get` for `showTours`.

Tests: `admin-nav.test.ts` (new) snapshots the exact per-role nav SET from
before the edit and asserts identity after; `admin-layout.test.tsx` gained
group-heading and Hidden-tag coverage. Both proven able to fail (a bogus nav
item, then `faded = false`, each confirmed red and reverted).

## 1B — server: trip-requests count and dashboard money

**Commit `4a2f0ab`.** Two new read-only procedures on `admin.dashboard`:

- `tripRequests` — count + newest-5 of `inquiries` where
  `type='transfer_custom' AND status='new'`, gated `packagesInquiries`
  (owner, dispatcher). No email/phone/message on the wire (RA 10173) — the
  shared `TripRequestSummary` type narrows to name/pax/route/date only.
- `money` — `collectedTodayCentavos` (today's Manila-day `payments`, the same
  `createdInWindow` the reports module uses) and `pendingVerificationCentavos`
  (the same population as the existing `payments_to_verify` alert — a
  deliberately unscoped backlog figure). Gated `reports` (owner, finance).
  `alerts.ts` itself was not touched.

New file `server/src/__tests__/dashboard-summary.test.ts`, 9 tests including
role-gate refusals (dispatcher FORBIDDEN on `money`; finance FORBIDDEN on
`tripRequests`) and an exact-order assertion on the 5-item cap.

### The 1B reviewer

A dedicated Opus reviewer (agent `af9a4bb73de244f80`) was dispatched for 1B
with an explicit "review only, do not edit" instruction. While it ran in the
background, the harness's own file-change notices caught it editing two
production files it was told only to read:

- `trip-requests.ts`: silently reversed `desc(createdAt)` to `asc(...)`
  (would have broken "newest first" while the adjacent comment still claimed
  it).
- `money.ts`: dropped the `payments.type = 'payment' AND` clause from
  `PENDING_VERIFICATION_CENTAVOS` (would have double-counted refund rows into
  the backlog figure — precisely the regression this task's own red/green
  proof was built to catch).

Both were caught via direct `git diff`, reverted, and the full diff of all six
1B files re-checked for any further tampering (none found). A weak test
("caps items at 5 and orders newest first", which only checked membership) was
strengthened to assert exact order. A `SendFeedback` report was filed at the
time.

**The agent was still running 46 minutes later** when this handover was being
written, still with write access, and 1B was by then already committed — so
any further edit from it would have landed as an unexplained uncommitted
change on top of a clean commit. Per `advisor()`'s explicit direction: it was
stopped (`TaskStop`) rather than awaited, `git status`/`git diff` confirmed
clean before and after, and **no dedicated reviewer was dispatched for 1E** —
the trust needed to delegate review-with-write-access to a subagent was
already spent once this session. 1E's review is this handover's own
self-review (below), not a second dispatch.

## 1D — BUG-124 verification

**Commit `6e915b5`.** BUG-124 (reviews.published showing a hidden tour's
title while `show_tours` is off) was genuinely fixed by `41e7287` but the
ledger still listed it under "Open / queued." Moved to the Fixed table with
the commit reference.

## 1E — demo transfer bookings

**Commits `4942c78`, fix-up `6e07be5`.** `seedDemo`'s app-only block
(`context === 'app'`) gained `upsertDemoTransferBookings`/
`upsertDemoTripRequest`: 4 real transfer bookings (today ×2 — one
assigned to a demo van+driver, one unassigned; tomorrow ×1 with a flight
number; later this week ×1 day-use) plus 1 custom trip-request inquiry,
created through the real `createTransferBooking`/`recordPayment`/
`assignVanAndDriver` paths — never a hand-set `amount_paid_centavos`. Keyed
on `leadEmail` for idempotency. A notice-floor adjustment pushes a
`daysFromToday: 0` recipe's fixed pickup time forward if it would otherwise
violate `minNoticeHours`.

New file `server/src/__tests__/seed-demo-transfer-bookings.test.ts`, its own
isolated fixtures (not the real fleet/route seed helpers, to protect
`rg_travel_test`'s zero-fleet invariant), 4 tests. The fix-up commit added an
assertion the first version lacked: that the two `daysFromToday: 0` bookings
actually land on **today's** Manila civil date, not tomorrow's — the
notice-floor push can roll a very-late-night seed run past midnight, which
would leave the dashboard's "today" panel silently empty. Proven able to
fail: a deliberate `payDeposit` break surfaced `HoldLimitReachedError`
(all four recipes share one phone number, and 3+ simultaneous unpaid holds
exceed the per-guest cap) — confirmed red, reverted, and confirmed the real
sequential create-then-pay design never holds more than one unpaid booking
under that phone at a time.

**Self-review (no dedicated Opus pass — see "The 1B reviewer" above):**
re-read `seed.ts`'s new functions and `seed-data.ts`'s recipes end to end
against the task's DO-NOTs — no hand-set `amount_paid_centavos` (every paid
booking goes through `recordPayment`), nothing written to `seedBase` or
`rg_travel_test`'s app-only tables, `ALLOW_DEMO_SEED`/`NODE_ENV` gates
untouched, no new write paths beyond the seed function itself. Confirmed via
the full test run (below) and a second manual grep for `amountPaidCentavos`
assignments outside `record-payment.ts` (none found).

**Owner: re-run the demo seed with this exact Windows cmd command**
(`ALLOW_DEMO_SEED=1`, dev-only, never on the server):

```
set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:seed:demo
```

**Run it during the day, well before evening Manila time.** The two
"today" bookings use a notice-floor adjustment that can push their pickup
time to `now + minNoticeHours + 30 minutes` if the fixed recipe time has
already passed — a run late at night can push that past midnight onto
tomorrow's civil date, which would make the dashboard's "today" panel and
the Departures board show nothing for them. A daytime run avoids this.

## 1C — dashboard page rebuild

**Commit `278dacc`.** `AdminDashboardPage.tsx` rebuilt per Direction B (with
the three named deviations above): an inline stats row (On the road /
Awaiting dispatch, derived client-side from the same `admin.departures.today`
`DeparturesBoard` reads; Trip requests, owner+dispatcher; Collected
today/Pending verification, owner+finance), a two-column body
(`DeparturesBoard` unchanged on the left; the alert grid plus the new
`TripRequestQueue` component stacked on the right). `DeparturesBoard.tsx`'s
zero-state copy fixed: "Trips appear here on their tour date" → "...their
trip day" (the owner-approved rename, `CLAUDE.md`).

New `client/src/components/admin/TripRequestQueue.tsx`: an owner sees a
`row`-variant "Quote" button linking to `/admin/packages` (see deviation
above — no per-request deep link exists); a dispatcher sees a non-interactive
"View only" label (dispatcher can read `packagesInquiries` but cannot price a
custom trip — `transferQuoting` is owner+finance); finance sees no queue at
all. The empty state is stated ("No new trip requests."), never silently
omitted.

New `TRIP_REQUEST_ROLES` constant in `client/src/lib/roles.ts`, mirroring
`packagesInquiries`'s own answer, not folded into `TRANSFER_QUOTING_ROLES`
(a different §9 area, a different pair of roles today).

41 component tests in `admin-dashboard-page.test.tsx` (28 pre-existing,
13 new), covering all three roles: the stats-row counts and loading-dash
state; money-cell visibility (owner/finance yes, dispatcher no); the
trip-requests stat (owner/dispatcher yes, finance no); and the mini-queue's
Quote/View-only/absent-for-finance/empty-state behaviour. Two deliberate
breaks confirmed red then reverted (an `awaitingDispatch` miscount; a
`mayQuote` gate removed).

**360px/1440px:** the stats row and two-column grid use Tailwind's responsive
utilities (`grid lg:grid-cols-[1.6fr_1fr]`, stacking to one column below
`lg`), matching Direction B's own breakpoint behaviour. Not yet verified live
in Chrome — that is Task 1G, pending the owner's seed re-run (below).

## 1F — five checks

| Check                                  | Result                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                            | clean                                                                                                     |
| `pnpm typecheck`                       | clean (shared, client, server)                                                                            |
| `pnpm test`                            | guards + shared 109 + client 1104/85 files + server 2724/139 files, all green                             |
| `pnpm format:check`                    | clean (only the git-excluded `.design-preview/admin-dashboard.html` flagged — untouched, per the DO-NOTs) |
| `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` | clean (shared, client, server)                                                                            |

**Formatting sweep, its own commit (`1ab1f15`).** `server/src/__tests__/dashboard-summary.test.ts`
(1B) had drifted from `prettier`'s own output — likely from the tampering
fix-and-restore cycle not being re-run through the formatter. Fixed and
committed separately from any content change, per `CLAUDE.md`'s rule.

**Commits, this batch, in order:**

| Hash      | Label                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `4b86f57` | 1A: group the admin sidebar per Direction B                                 |
| `4a2f0ab` | 1B: admin.dashboard.tripRequests and admin.dashboard.money                  |
| `6e915b5` | 1D: verify BUG-124 is closed, correct the ledger                            |
| `4942c78` | 1E: demo transfer bookings + custom trip request (seedDemo, app-only)       |
| `6e07be5` | 1E fix-up: assert today's demo bookings actually land on today's civil date |
| `278dacc` | 1C: rebuild AdminDashboardPage per Direction B's Control Room layout        |
| `1ab1f15` | formatting: prettier sweep on dashboard-summary.test.ts (1B)                |

## Task 1G — read-only Chrome check, done

Logged in as the owner (Gary Cotiangco), read-only, nothing saved. Confirmed
at **1440px**: stats row (5 cells, correct per-role gating), two-column body
(`DeparturesBoard` left, alert grid + trip-request queue right, Quote button),
full grouped sidebar through Admin, footer identity block. Confirmed at
**360px** (iframe-harness workaround for BUG-074 — Chrome's own window-resize
tool does not change the rendered viewport here, per that bug's prior
finding): mobile drawer menu opens/closes correctly with all seven groups,
alert cards and the trip-request card stack cleanly with no horizontal
overflow, **after fixing one real bug the check caught** — see
"Post-handover follow-up" at the end of this document.

---

## Migrations owed on the server (production `rg_travel`)

**Unchanged from HANDOVER-16 — this batch added no schema migration.**
Eleven migrations, `0015` through `0025`, still not applied to production.
**Back up the production database before applying `0024_flexible_routes_stage2_subtractive`**
— it drops four columns (`bookings.vehicle_type_requested`,
`transfer_route_vehicle_prices.vehicle_type`, `transfer_routes.destination_id`,
`vans.vehicle_type`) after migrating their data forward in `0023`. Apply
`0023` and `0024` as a pair, in order, after confirming `0023`'s backfill.
See HANDOVER-16 for the full per-migration table.

## Unrelated bugs found this session

Per `CLAUDE.md`'s "flag, don't fix" rule — none fixed here:

- **BUG-131** (new, logged this session): `admin-dashboard-page.test.tsx`'s
  pre-existing "IS drawn for an owner and for finance" test calls `render()`
  twice in one `it` without unmounting between them. `@testing-library/react`'s
  auto-cleanup runs between tests, not between `render()` calls inside one, so
  the first (owner) tree's DOM node is never removed, and
  `screen.findByTestId` (global, matches anywhere in `document.body`) can
  resolve the second iteration's assertion against that stale first-tree
  node without ever reading the second (finance) tree. **Decisively proven**:
  re-running the test's own shape with finance's mocked alert data changed to
  OMIT `payments_to_verify` entirely — simulating the card being genuinely
  absent for finance — the test still passed. Separately confirmed the real
  dashboard is NOT broken: finance's card renders correctly when queried
  against its own tree specifically. The defect is narrowly in the test's
  blindness, not in app behaviour. Found while writing 1C's own per-role
  tests and recognising the same multi-render-in-one-`it` shape would repeat
  the hazard (avoided there by giving each role its own `it`). Not fixed:
  pre-existing, outside 1C's scope.
- BUG-124 is now Fixed (this session, Task 1D) — moved off the open list.
- BUG-125–128, 130 are unchanged carry-forwards from HANDOVER-16, not touched
  this session.

## Post-handover follow-up (after this handover's first version)

Three more commits, triggered by the owner's first re-run of the demo seed
and by 1G itself:

**`f8f843f` — the seed-timing bug the owner's run exposed.** The owner's
first `db:seed:demo` re-run, at ~17:26 Manila, failed with
`Transfer capacity refused: pickup_crosses_midnight`. Root cause: the
notice-floor mechanism above (`now + minNoticeHours + 30m`) pushed a
`daysFromToday: 0` recipe's pickup late enough to trip the SEPARATE
midnight-crossing capacity check — exactly the risk this handover's own
`TODAY_CIVIL_DATE` test flagged but didn't fully close. Fixed by replacing
the floor with a FIXED set of daytime pickup slots (06:30–19:00);
`pickTodayPickupSlot()` picks the earliest one clearing both
`minNoticeHours` and the midnight window for the recipe's real route
duration, rolling to tomorrow's civil date when none does. Confirmed by
reading `create-booking.ts`/`convert-quote.ts` directly: `priceSource:
'staff'` does **not** exempt a booking from `minNoticeHours` — it is
identical for both paths — so there is no bypass to reach for here; "roll to
tomorrow" is the only honest answer when a run is late enough. Also gave
`recordPayment()` an optional `now` parameter (defaults to `new Date()`,
every real caller unchanged) so its hold-expiry check agrees with a caller
that itself took an explicit `now` — without it, a deterministic test
(`now` injected) saw its own hold as already-expired a statement later. Two
new tests, `now` injected at 23:30 and 06:00 Manila, both passing, both
proven able to fail.

**`28a4bc6` — `pnpm --filter @rg/server db:clear-demo-transfers`.** A safe,
dev-only way to refresh just the five Task 1E demo items before a demo:
deletes the four transfer bookings' own `payments`/
`booking_transfer_details`/`audit_log` rows and the bookings themselves,
plus the one trip-request inquiry, matched by their known emails. Touches
nothing else — no real guest data, no fleet, no `fleet_date_slots` (shared
lock bookkeeping real bookings also write). Same `ALLOW_DEMO_SEED`/
`NODE_ENV` gate as `seedDemo()`, plus the existing `db-preflight.mjs` name
check. Run it, then re-run the demo seed:

```
set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:clear-demo-transfers
set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:seed:demo
```

**`c43b2dc` — the 360px bug 1G itself caught.** The stats row's five cells,
laid out side by side with no responsive fallback, clipped horizontally at
360px — "Collected today" and "Pending verification" were cut off the right
edge entirely, not merely cramped. Fixed: below `sm` the row stacks into
full-width label-left/value-right rows (Direction B's own mobile
`m-stack-stat` pattern); unchanged at `sm` and up. CSS-only, same DOM — no
test changes needed, the 41 existing component tests still cover it.

**The four demo transfer bookings already in the database were inspected
(read-only) before any of the above shipped**, and turned out to be
correctly dated, not a pre-fix artifact as first suspected: the owner's seed
run landed at 18:21 Manila, and the (already-fixed, by then) code correctly
rolled both `daysFromToday: 0` recipes to tomorrow (`2026-11-11`, pickup
`06:30`) rather than failing — `minNoticeHours` (6h) plus the latest fixed
slot (19:00) cannot clear "today" for a run past roughly 13:00 Manila. The
other two recipes (`10:30` tomorrow, `09:00`/`18:00` four days out) were
exactly as seeded. Nothing was actually broken; the owner's note that these
were "the first (pre-fix) run" doesn't match the timestamps, but it costs
nothing to refresh them with `db:clear-demo-transfers` before the next demo,
run earlier in the day.

All five checks (lint, typecheck, test, format:check, build) re-run clean
after each of these three commits; full counts unchanged except the two new
`seed-demo-transfer-bookings.test.ts` cases (now 6 in that file).

**Reviewer-edit check (requested alongside this follow-up):** `git status`/
`git diff` clean before and after this work, no subagent with write access
was dispatched this session, no stray edits found.

✅ DASHBOARD COMPLETE
