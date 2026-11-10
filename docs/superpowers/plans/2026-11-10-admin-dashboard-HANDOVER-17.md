# HANDOVER-17: admin Dashboard "Direction B: Control Room" + grouped sidebar + demo transfer bookings

Continues HANDOVER-16 (T26–T29, transfers-launch plan closed). This is a new,
separate task: the admin dashboard rebuild, grouped sidebar, and dev-only demo
transfer bookings, per the owner's 2026-11-10 brief. Tasks 1A–1F are complete
and committed; **Task 1G (the read-only Chrome check) is pending the owner
re-running the demo seed** — see "What's left" below.

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

## What's left — Task 1G

A read-only Chrome check of the dashboard and sidebar at 360px and 1440px,
using the owner's existing admin session, saving nothing. **Blocked on the
owner re-running the demo seed** (command above) — without it the dashboard
has nothing demo-shaped to show, and a stale earlier run's "today" bookings
would read as yesterday's. Per the brief's own instruction: ask and wait,
rather than proceed. **Please run the seed command above (during the day,
Manila time) and say so when it's done — 1G runs immediately after.**

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
  the first (owner) tree's DOM node is never removed — the second
  `screen.findByTestId` call resolves against that STALE first-tree node
  rather than ever reading the finance-role render. Measured directly
  (instrumented both renders with distinguishing content; the first tree's
  content was still present after the second `render()` call). The test
  therefore does not actually prove the card renders for finance — it would
  pass identically if that were broken. Found while writing 1C's own
  per-role tests and recognising the same shape would repeat the hazard
  (avoided there by giving each role its own `it`). Not fixed: pre-existing,
  outside 1C's scope, and `role-isolation.test.ts` independently covers the
  server-side gate this client test only appears to.
- BUG-124 is now Fixed (this session, Task 1D) — moved off the open list.
- BUG-125–128, 130 are unchanged carry-forwards from HANDOVER-16, not touched
  this session.

✅ TASKS 1A–1F COMPLETE. 1G pending the owner's seed re-run.
