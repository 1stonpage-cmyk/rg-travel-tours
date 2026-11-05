# Task 0D report — Surface "destination inactive hides a transfer route"

Owner decision 2026-11-06 #1. Pre-task in Batch 4a, not a plan task.

## What was already built (confirmed, not re-touched)

- `server/src/routers/public/transfers.ts`'s `transferRoutesRouter.list` already filtered on
  both `transferRoutes.isActive` and `destinations.isActive`.
- `server/src/services/transfers/pricing.ts`'s `vehiclePriceForRouteAndType()` already joined
  to `destinations` and filtered on both flags, returning `null` (→ `NOT_FOUND`) when either
  is false.
- `checkout.quoteTransfer` and `checkout.createHoldTransfer` → `createTransferBooking()` both
  already call `vehiclePriceForRouteAndType` and translate a `null` into the existing
  non-distinguishing refusal sentences. No change was made to either message (ruling honoured).
- `transfer_routes.destination_id` is `NOT NULL` / RESTRICT — no migration needed or added.

## What was missing and what I built

### 1. Hold-path regression test (point 1 of the brief)

File: `server/src/__tests__/checkout-create-hold-transfer.test.ts`

- Extended the file's own `makeRoute()` fixture helper with a `destinationActive?: boolean`
  option (mirroring `transfer-pricing.test.ts`'s `destinationActive` fixture option), threaded
  into the `destinations` insert's `isActive` column.
- Added a new test, `'refuses a route whose destination is retired, even though the route
  itself is active'`, placed directly after the existing `'refuses an unquotable route with one
  NOT_FOUND sentence for every cause'` test (which only covers the route's own flag). It builds
  a route with `destinationActive: false` (route itself still active), calls
  `checkout.createHoldTransfer` through the real caller, and asserts:
  - `code: 'NOT_FOUND'`, `message: 'That route is no longer available for that vehicle.'` —
    the exact same sentence the route-retired case gets (confirmed from
    `TransferRouteNotQuotableError`'s translation in `create-booking.ts`), never a
    destination-specific sentence.
  - `writtenRowCounts()` is unchanged (no booking, no transfer-details row, no audit row).

**Proof it can fail:** temporarily removed `eq(destinations.isActive, true)` from
`vehiclePriceForRouteAndType`'s `.where()` in `server/src/services/transfers/pricing.ts`.
Re-ran the new test alone — it went red: the mutated code let the hold succeed (price was
returned for the inactive-destination route), so the expected refusal never arrived, and the
hold's writes (booking, `booking_transfer_details`, a van, a driver, a `fleet_date_slots` row)
landed for real. This left the shared test database (`rg_travel_test`) holding stray rows,
which the suite's own `global-setup.ts` teardown detected and refused to let the run end
cleanly (`"rg_travel_test has rows no test cleaned up"`). I identified every stray row by id
(1 booking + its `booking_transfer_details` row, 2 vans, 2 drivers, 1 `fleet_date_slots` row,
the route and destination fixtures themselves) and deleted them directly against
`rg_travel_test` before restoring the predicate. After restoring the predicate, re-ran the test
(green) and confirmed via direct queries that `bookings`, `drivers`, `vans` and
`fleet_date_slots` were all back to 0 in the test database before running anything else.
`git diff` on `pricing.ts` after the restore shows no diff — the predicate is exactly as found.

### 2. `destinationIsActive` on the admin row (point 2)

- `shared/src/transfers-admin.ts`: added `destinationIsActive: boolean;` to
  `TransferRouteAdminRow`, placed directly after `destinationName` with a doc comment explaining
  it is denormalised from `destinations.is_active` the same way `destinationName` is, and is
  independent of the row's own `isActive`.
- `server/src/routers/admin/transfer-routes.ts`: added `destinationIsActive:
  destinations.isActive` to the `.select({...})` in `list`'s query. The row-shaping code
  (`rows.map((row) => ({ ...row, prices: ... }))`) already spreads every selected column through
  via `...row`, so no further change was needed there — the brief anticipated this ("search for
  where rows is mapped") and the spread already covers it.
- Verified no other file constructs a `TransferRouteAdminRow` object literal that would need a
  new required field filled in (`grep -rn "TransferRouteAdminRow"` → only the router, the shared
  type file, a doc-comment mention in `shared/src/transfers.ts`, and the admin page component).

**Test added:** `server/src/__tests__/admin-transfer-routes.test.ts`, new test
`'surfaces destinationIsActive on each row, false only once the destination is retired'`,
placed directly after the existing `"round-trips both vehicle types' prices through create and
list"` test. Creates one route on a still-active destination and one route on a destination
retired *after* the route was created (via a direct `UPDATE destinations SET is_active = false`,
using the already-imported `destinations`/`eq`/`getDb`), then asserts
`admin.transferRoutes.list()` returns `destinationIsActive: true` for the first and `false` for
the second, while `isActive` stays `true` on both (proving the two flags are read
independently).

**Proof it can fail:** temporarily removed the `destinationIsActive: destinations.isActive`
line from the `.select({...})` in `transfer-routes.ts`. Re-ran the new test alone — it went red
(`AssertionError: expected { id: 4366, …(10) } to match object { isActive: true, …(1) }` —
`destinationIsActive` was simply absent from the row). This test uses the file's own
`created`-array + `afterAll` teardown (plus the `strays` sweep keyed on `destIds`), so the failed
assertion left nothing uncleaned — confirmed by the immediate next run (after restoring the
select field) passing with no teardown complaint. Restored the field; re-ran — green.

### 3. Admin UI label (point 3)

File: `client/src/pages/admin/AdminTransferRoutesPage.tsx`

- Added `DESTINATION_INACTIVE_CLASS` and `DESTINATION_INACTIVE_LABEL` constants near
  `STATUS_BADGE_CLASS`. Used a plain `<p>` rather than the `<Badge>` component: `Badge`'s base
  class is `whitespace-nowrap` + `w-fit` (`inline-flex shrink-0`), which is right for a one-word
  status pill but would force the full sentence `"Destination inactive — hidden from guests"`
  onto one unbroken line and risk horizontal overflow on a 360px phone card. Went with the
  "box" variant the brief offered as an alternative (`border border-amber-300 bg-amber-100 ...
  text-amber-900`) rather than the bare badge classes, specifically so the text can wrap.
- Phone card (`<ul>`, around original line 691–715): added the label as an additional element
  directly beneath the existing Active/Inactive `<Badge>`, shown only when
  `route.destinationIsActive === false`.
- Table (around original line 717–770): added the label inside the same Status `<td>`, stacked
  beneath the existing Status badge — no new column was added, as instructed.
- Both renders are gated on `route.destinationIsActive === false` (not `!route.destinationIsActive`),
  so a fixture or payload that omits the field entirely renders no label rather than a false
  positive — matches how `statusLabel`/boolean checks are written elsewhere in this file.

**Client test:** this codebase already has a render test enumerating text for this page —
`client/src/__tests__/admin-transfer-routes-page.test.tsx` (found via the full `pnpm test` run;
my initial `Glob` patterns for a test file missed it because the real filename is
`admin-transfer-routes-page.test.tsx`, not `AdminTransferRoutesPage.test.*` — confirmed by
`grep -rn "admin.transferRoutes.list" client/src` returning exactly the page and this one test
file, so there is no second render-test file to also update). Per the brief's instruction to
extend an existing render test rather than skip, I:
- Added `destinationIsActive: true` to the two existing fixtures (`AIRPORT_ROUTE`, `OSLOB_ROUTE`)
  so they reflect the real shape.
- Added a third fixture, `CEBU_CITY_ROUTE` — `isActive: true` (route itself still shows Active)
  but `destinationIsActive: false` — the exact scenario this label exists for.
- Added a new test, `'shows an amber "Destination inactive" label only for a route whose
  destination is retired'`: renders the three routes together, asserts the label text appears
  exactly twice (once per render surface — phone card and table — pinning that both surfaces
  show it, not just one), and that it does not appear for the other two routes (whose
  destinations are both still active, including Oslob, whose own *route* is inactive for an
  unrelated reason — proving the label tracks the destination flag, not the route flag).

**Proof it can fail:** temporarily flipped the phone-card condition from
`route.destinationIsActive === false` to `=== true` (one line, `AdminTransferRoutesPage.tsx`
line ~720 at the time). Re-ran the new test alone — it went red
(`AssertionError: expected 3 to be 2`): with the condition inverted, the phone card showed the
label for the two routes whose destination IS active and omitted it for Cebu City, so the total
count of matching label nodes became 3 (wrong set) instead of 2, catching the regression
immediately. I deliberately mutated only the phone-card branch (not the table branch at
~line 784) as the single minimal edit to prove the test is sensitive to the condition — the
`toBe(2)` assertion would equally go red if either branch's condition were broken (removing
either branch drops the count to 1), but I only empirically exercised the phone-card branch; I
did not separately mutate and re-test the table branch. Restored the condition; re-ran — green,
all 5 tests in the file passing.

## Files touched

- `shared/src/transfers-admin.ts` — added `destinationIsActive: boolean` to
  `TransferRouteAdminRow`.
- `server/src/routers/admin/transfer-routes.ts` — added `destinationIsActive:
  destinations.isActive` to `list`'s `.select({...})`.
- `server/src/__tests__/admin-transfer-routes.test.ts` — new test for `destinationIsActive`
  round-tripping.
- `server/src/__tests__/checkout-create-hold-transfer.test.ts` — `makeRoute()` gained
  `destinationActive` option; new test for the hold-path refusal.
- `client/src/pages/admin/AdminTransferRoutesPage.tsx` — new amber label, phone card and table.
- `client/src/__tests__/admin-transfer-routes-page.test.tsx` — fixtures updated with
  `destinationIsActive`; new render test for the label.

## Out of scope — confirmed untouched

- Quote/hold refusal message text — unchanged (verified via `git diff` showing no change to any
  message string; the only edit to `pricing.ts` was the temporary mutation-proof, fully
  reverted).
- No `ROLE_MATRIX` area added; `role-isolation.test.ts` untouched and still passes (95 tests,
  part of the full server suite run).
- `admin.transferRoutes.setActive`, pricing math, capacity math — untouched.
- No migration added or needed.
- Public `transferRoutes.list` router — untouched.

## Unrelated bugs found

None observed while doing this task.

## Verification — all five commands, run against the final tree

1. `pnpm lint` — exit 0 (`eslint .`, no output beyond the command echo).
2. `pnpm typecheck` — exit 0 (`shared typecheck: Done`, `server typecheck: Done`,
   `client typecheck: Done`).
3. `pnpm test` — exit 0. Includes `check:coming-soon` and `check:contact-parity` (both clean,
   confirmed in the log: "check-coming-soon: 2 file(s) clean", "check-contact-parity: site.ts
   and coming-soon/index.html agree"), then:
   - `shared test`: 7 files / 93 tests passed.
   - `client test`: 68 files / 889 tests passed (includes the 5 tests in
     `admin-transfer-routes-page.test.tsx`, up from 4 before this task).
   - `server test`: 119 files / 2431 tests passed (includes the 28 tests in
     `admin-transfer-routes.test.ts`, up from 27, and the 23 tests in
     `checkout-create-hold-transfer.test.ts`, up from 22).
4. `pnpm format:check` — exit 0 after running `prettier --write` once on
   `AdminTransferRoutesPage.tsx` (the manually-typed JSX for the new `<p>` label needed
   reformatting — multi-line attributes). Re-ran `pnpm format:check` clean afterward, and
   re-ran the affected test file to confirm the reformat changed no behaviour.
5. `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` — exit 0. `shared build: Done`, `server build: Done`
   (tsc --noEmit), `client build` — placeholder guard deliberately skipped
   (`ALLOW_PLACEHOLDER_BUILD=1`), `tsc --noEmit` clean, `vite build` succeeded (2078 modules,
   dist written; only pre-existing Rollup comment-annotation warnings from the `zod` package and
   the pre-existing >500kB chunk-size warning, neither new nor related to this change).

All five ran in this order, each one re-run after the format fix where relevant, and this
report is written before committing.

---

## Follow-up: Opus review fixes (commit 2987906 review)

Review on commit `2987906` came back clean on spec compliance with 1 Important + 2 Minor on
test quality. All three addressed below.

### 1. Important — the "label is additive, not a replacement" assertion could not fail

`client/src/__tests__/admin-transfer-routes-page.test.tsx`'s new test asserted
`screen.getAllByText(/^(Active|Inactive)$/).map(...).toContain('Active')` — unscoped, so it
collected every status badge across all three fixture routes and both render surfaces. Since
Mactan Airport's badge is also "Active", the assertion passed regardless of what happened to
Cebu City's own badge specifically — it would have stayed green even if that badge were deleted
and replaced by the amber label, which is exactly the regression the test claimed to prove.

**Fix:** replaced the unscoped check with `within()`, scoped to Cebu City's own rendered
container on each surface. The test now:
- Finds Cebu City's two containers (`.closest('li')` for the phone card, `.closest('tr')` for
  the table) by walking up from the two "Cebu City" text nodes.
- For each container, asserts (via `within(container)`) that the existing `'Active'` badge text
  is present AND the amber label (`getByTestId('destination-inactive-label')`) is present in the
  SAME container — proving the two coexist rather than one replacing the other.

**Proof it can fail (re-done for the fixed assertion):** temporarily made the phone-card branch
hide the Active badge whenever `destinationIsActive === false` (simulating the exact regression
the reviewer described — the badge disappearing when the amber label appears). Re-ran the test
alone: it went red with `TestingLibraryElementError: Unable to find an element with the text:
Active`, inside the `within(container)` scope for Cebu City's own `<li>` — i.e. the fixed
assertion caught the regression the old one missed. Restored the component
(`git diff --stat` on `AdminTransferRoutesPage.tsx` showed no diff after restoring, confirming
an exact revert); re-ran — green, all 5 tests passing.

### 2. Minor — dead `data-testid`

`data-testid="destination-inactive-label"` was already on both render surfaces but unused by
the test (which matched on the literal sentence only). Kept the attribute (more robust than
matching the literal twice) and put it to use: the label-count assertion now reads
`screen.getAllByTestId('destination-inactive-label')` (asserting `toHaveLength(2)` and that each
has the expected text via `toHaveTextContent`), and the per-surface scoped checks above also
query by this test id rather than the literal text a second time.

### 3. Minor — duplicated refusal-sentence literal

`checkout-create-hold-transfer.test.ts` re-typed `'That route is no longer available for that
vehicle.'` in the new destination-inactive test instead of reusing the `expected` const the
route-retired test (directly above it) already defined for the same sentence. Hoisted that
object to a module-level constant, `UNQUOTABLE_ROUTE_REFUSAL`, placed beside the file's other
shared catalog constants near the top, with a doc comment explaining why all four unquotable
cases (unknown id, retired route, no price row for the vehicle type, and now retired
destination) share one sentence on purpose. Both tests now reference
`UNQUOTABLE_ROUTE_REFUSAL` instead of a locally-typed object literal — a future wording change
updates one constant and both tests move together; it is no longer possible to edit one and miss
the other.

### Files touched (this follow-up)

- `client/src/__tests__/admin-transfer-routes-page.test.tsx` — scoped the Cebu-City assertion
  with `within()`, switched the label lookups to `getAllByTestId`/`getByTestId`, added `within`
  to the `@testing-library/react` import.
- `server/src/__tests__/checkout-create-hold-transfer.test.ts` — hoisted
  `UNQUOTABLE_ROUTE_REFUSAL` to module scope; both affected tests now reference it.

No change to `shared/src/transfers-admin.ts`, `server/src/routers/admin/transfer-routes.ts`, or
`server/src/services/transfers/pricing.ts` was needed for this follow-up — all three review
findings were test-quality issues, not implementation gaps.

### Verification (follow-up) — all five commands, final tree

1. `pnpm lint` — exit 0.
2. `pnpm typecheck` — exit 0 (shared/server/client all `Done`).
3. `pnpm test` — exit 0. `check-coming-soon` and `check-contact-parity` both clean. Shared 7
   files / 93 tests, client 68 files / 889 tests (unchanged counts — this follow-up only
   strengthened existing tests, added none), server 119 files / 2431 tests (unchanged counts,
   same reason).
4. `pnpm format:check` — failed once on `checkout-create-hold-transfer.test.ts` (prettier
   wanted to re-wrap the three `toMatchObject(UNQUOTABLE_ROUTE_REFUSAL)` call sites across
   multiple lines); ran `prettier --write` on that one file, re-ran `pnpm format:check` — exit 0,
   clean across the whole repo. Re-ran the affected test file afterward to confirm the reformat
   changed no behaviour (still 23/23 passing).
5. `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` — exit 0, same shape as the first report (2078
   modules, dist written, only the pre-existing `zod` comment-annotation and >500kB chunk-size
   warnings, neither new).

All five re-run in order against the final tree before committing this follow-up.
