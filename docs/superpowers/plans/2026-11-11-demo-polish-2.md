# Demo Polish Round 2 (owner decisions 2026-11-11)

Owner-given directly, executed subagent-driven, one implementer at a time. Dedicated Opus
reviewer for Task 1 (1A — admin role-gating surface) and Task 4 (1D — demo-data deletion
script). Default reviewer for Tasks 2-3.

**Process note:** this plan's own research was redone directly by the controller after an
earlier incident this session where a "fork" research subagent inherited full conversation
context and ended up dispatching its own unreviewed implementer for 1A (caught via `git
status`, fully recovered — nothing was committed, the uncommitted work was stashed and
discarded, not built on). 1B and 1D's research came from two OTHER forks that completed
cleanly before the incident; their findings are trusted and used below. 1A and 1C's research
was redone directly by the controller via Read/Grep, not trusted to any fork.

## Global Constraints

- DO NOT push. DO NOT use /loop. DO NOT touch the VPS.
- DO NOT weaken auth/Turnstile/rate limits.
- DO NOT change money, holds, roles, or the schema.
- DO NOT add dependencies. DO NOT use red.
- Related tests per task. Full five checks (lint, typecheck, test, format:check,
  `ALLOW_PLACEHOLDER_BUILD=1 build`) run ONCE at the very end by the controller.
- Commit each task separately: `hash - short label`.

---

## Task 1 (1A): "Trip requests" sidebar item + standalone page

**Current state, researched directly (file:line verified):**

- `client/src/components/layout/admin-nav.ts` already has a `'Bookings'` group with exactly
  two items today: `{ to: '/admin/bookings', label: 'Bookings', roles: ALL, group: 'Bookings' }`
  (line 86-93) and `{ to: '/admin/payments', label: 'Payment checks', roles: ['owner','finance'],
group: 'Bookings', badge: 'payments_to_verify' }` (line 94-102). Insert a new item for
  `'Trip requests'` BETWEEN them (owner's stated order: "Bookings, Trip requests, Payment
  checks").
- **Role gating — verified against the real server-side `ROLE_MATRIX`
  (`server/src/middleware/require-role.ts:72,98`) and the client's own mirror
  (`client/src/lib/roles.ts:65,75`), not assumed:**
  - `packagesInquiries: ['owner', 'dispatcher']` — gates `admin.inquiries.list`/`.setStatus`
    (the page's own data). Finance is explicitly, deliberately excluded ("Finance is excluded
    in both directions: an enquiry carries no money" — `require-role.ts:70`).
  - `transferQuoting: ['owner', 'finance']` — gates `admin.transferQuotes.convert` (the
    "Quote & convert" action specifically). A dispatcher is denied this ONE action, not the
    page.
  - **The new nav item's `roles` must be `['owner', 'dispatcher']`** — exactly matching
    `TRIP_REQUEST_ROLES` (`client/src/lib/roles.ts:75`) and the existing `/admin/packages`
    item's own role list — so finance never even sees the nav link (finance cannot view
    `admin.inquiries.list` at all; this is pre-existing, deliberate, and out of this task's
    scope to change). This achieves "owner/finance can quote+convert, dispatcher read-only":
    the CONVERT button inside each row stays gated on `roleMay(role, TRANSFER_QUOTING_ROLES)`
    (owner+finance) exactly as it is today — unchanged — while dispatcher sees every row
    read-only (no convert button, per the EXISTING `showConvertSection` check in `InquiryRow`).
    **Do not add finance to the new page's own role list** — that would be a role-gating
    CHANGE, not "same gating as today," and finance's practical inability to reach the
    convert action through this UI is a pre-existing, separately-tracked gap (see
    `TripRequestQueue.tsx`'s own doc comment, lines 11-18) that this task does not touch.
- **The inquiries inbox today** lives entirely inside
  `client/src/pages/admin/AdminPackagesPage.tsx`'s `PackagesAdmin({ role })` function
  (line 807-1020). The "Enquiries" section specifically is lines 953-1010: an
  `inquiryOffset` state (810), the `inquiryList` query (811-814), a `vehicleTypesQuery`
  (827-830, needed by the convert form, `enabled: isOwner`), a `waiting` count (852), and
  the JSX from the "Enquiries" `<h2>` through the Previous/Next pager. `InquiryRow`
  (function, lines 513-692) is the per-row component, already self-contained — takes only
  `row`/`role`/`vehicleTypes` props, uses `trpc.admin.inquiries.setStatus`,
  `ConvertInquiryForm` (`@/components/admin/ConvertInquiryForm`, unchanged import), and the
  file's local `INQUIRY_BADGE_CLASS`/`CARD`/`ALERT`/`NOTICE` style constants (lines 76-96).
- **Extraction plan:** create `client/src/components/admin/InquiriesInbox.tsx`, a new shared
  component taking `{ role: AdminRole | undefined }`, containing: the `inquiryOffset` state,
  the `inquiryList` query, the `vehicleTypesQuery`/`vehicleTypes`, the `waiting` count, the
  `InquiryRow` function (moved here from `AdminPackagesPage.tsx`, along with
  `INQUIRY_BADGE_CLASS`, `describeError`, `utcIsoToManilaLabel` import, `roleMay`/
  `TRANSFER_QUOTING_ROLES` import — check `AdminPackagesPage.tsx`'s exact import list,
  lines 47-74, for everything `InquiryRow` needs), and the full "Enquiries" JSX block
  (minus the "Enquiries" `<h2>` itself, which each PAGE should render with its own
  `AdminPageHeader` instead, matching each page's own framing — see below). Export it as the
  default export. `CARD`/`ALERT`/`NOTICE` are currently file-local consts in
  `AdminPackagesPage.tsx` with identical string values used elsewhere in the admin codebase
  (e.g. `ConvertInquiryForm.tsx` has its own `ALERT` with the same string) — redeclare them
  locally in the new file rather than trying to import from `AdminPackagesPage.tsx` (that
  direction of import would be backwards once `AdminPackagesPage.tsx` itself consumes this
  new component).
- **`AdminPackagesPage.tsx` keeps rendering the inquiries inbox** — replace its inline
  "Enquiries" section (the whole block described above) with `<InquiriesInbox role={role} />`,
  so behavior and the existing `admin-packages.test.tsx` coverage for inquiries-on-the-
  Packages-page is unchanged (packages and their enquiries still show on one screen there,
  per that page's own `AdminPageHeader` description: "Multi-day packages, the enquiries
  guests send about them, and the newsletter list" — do not change that description or
  remove enquiries from that page, the owner only asked to ADD a second entry point, not
  remove the first one).
- **New page:** `client/src/pages/admin/AdminTripRequestsPage.tsx` — follow the two-layer
  role-denial shape every other admin page in this codebase uses (`DeniedState`-on-
  known-role, plus a second check on a refused query — see `AdminPackagesPage.tsx`'s own
  `export default function AdminPackagesPage()`, lines 1031+, and its `isRoleRefusal`
  helper, line 120, for the exact pattern to copy). Its own `AdminPageHeader` should
  describe this page as the trip-requests inbox specifically (custom trip requests,
  general messages, and package enquiries — all three `inquiries.type` values render here,
  exactly as they do on the Packages page today; `InquiriesInbox` doesn't filter by type).
  Role check: `['owner', 'dispatcher']`.
- **New route:** `client/src/App.tsx`, inside the existing `<Route path="admin" ...>` block
  (around line 174-194) — add `<Route path="trip-requests" element={<AdminTripRequestsPage />} />`,
  following the exact sibling pattern of `packages`/`bookings`/etc.
- **New nav item:** `admin-nav.ts`, inserted between the `/admin/bookings` and
  `/admin/payments` entries: `{ to: '/admin/trip-requests', label: 'Trip requests', end:
false, roles: ['owner', 'dispatcher'], group: 'Bookings' }`.
- **Dashboard link:** `client/src/components/admin/TripRequestQueue.tsx:65` —
  `<Link to="/admin/packages">Quote</Link>` becomes `<Link to="/admin/trip-requests">Quote</Link>`.
  Update that component's own doc comment (lines 20-24, the "named deviation... recorded in
  HANDOVER-17" note) to say the dedicated page now exists — the "no per-request deep link"
  caveat may still apply (confirm whether `/admin/trip-requests` supports a hash/id param;
  if not, say so plainly rather than silently dropping the caveat) but the destination
  itself is no longer a workaround.

**Tests — write first, watch fail, then implement:**

1. `client/src/__tests__/admin-nav.test.ts` has a test literally named `'no "Trip requests"
or any other destination not already reachable was added'` (line 79-86) — this is a
   deliberate guard from the PRIOR sidebar-restructuring task proving Trip Requests was
   NOT added yet. It must now be REMOVED or rewritten to assert the opposite (Trip requests
   WAS added, for owner and dispatcher, not finance) — do not leave a test asserting the
   old, now-false premise. `BEFORE_OWNER`/`BEFORE_DISPATCHER` arrays (lines 15-33, 35-44)
   need `/admin/trip-requests` added in the right position (between bookings and payments);
   `BEFORE_FINANCE` (46-53) must NOT gain it. The "dispatcher sees exactly the same 8
   destinations" test (line 65) becomes 9; "owner sees exactly the same 17" becomes 18.
   The `'dispatcher gets single-item Overview and Bookings groups'` test (line 103) will
   need updating too — dispatcher's Bookings group now has two items (`/admin/bookings` and
   `/admin/trip-requests`), not one.
2. Server-side: NO new test needed — no `ROLE_MATRIX` area is added (this task reuses
   `admin.inquiries.list`/`.setStatus`/`admin.transferQuotes.convert` exactly as they exist
   today, unchanged), so `role-isolation.test.ts`'s generated matrix and
   `docs/BUILD_SPEC.md`'s own §9 table (parsed by that same test) are untouched. Confirm
   this explicitly in your report — do not touch `require-role.ts` or `docs/BUILD_SPEC.md`.
3. Extend or add a test for `AdminTripRequestsPage.tsx` covering: owner/dispatcher see the
   inbox; a role known to be denied (finance) sees `DeniedState`; the page renders
   inquiries of all three types (not filtered). Check `admin-packages-page.test.tsx` (if
   that's the real filename — confirm) for the existing inquiries-on-Packages-page test
   pattern to mirror.
4. Confirm `AdminPackagesPage.tsx`'s own existing tests still pass unchanged after the
   extraction (the inquiries section's behavior must be byte-identical from that page's
   perspective — same queries, same role checks, same rendered output).
5. Update `TripRequestQueue.tsx`'s own test (if one exists — check
   `admin-dashboard-page.test.tsx` or similar) for the new `Link to` target.
6. Mutation-testing proof: temporarily revert the nav item's `roles` to `['owner',
'dispatcher', 'finance']` — a test must catch finance now seeing it. Restore.

**Dedicated Opus review** (admin role-gating surface).

Commit message: `feat(admin): "Trip requests" sidebar item + standalone page, reusing the existing inquiries inbox (owner decision 2026-11-11, 1A)`

---

## Task 2 (1B): Admin wording sweep — "tour" → "trip"/neutral where generic

**Researched exact locations (file:line, current text, verified):**

1. `client/src/pages/admin/AdminBookingsPage.tsx:74` —
   `description="Soonest tour first. Open a booking to act on it."` →
   `"Soonest trip first. Open a booking to act on it."`
2. `client/src/pages/admin/AdminBookingsPage.tsx:100` — `<Label htmlFor="filter-from">Tour
date from</Label>` → `"Trip date from"`.
3. `client/src/pages/admin/AdminBookingsPage.tsx:111` — `<Label htmlFor="filter-to">Tour date
to</Label>` → `"Trip date to"`.
   (Confirmed generic: this filter sets `from`/`to` against `booking.tourDate`, a column
   populated for every booking type; the table's own column header already says "Trip" at
   line 196.)
4. `client/src/pages/admin/AdminReportsPage.tsx:369` — `Every booking on these tour dates is
paid in full.` → "trip dates" (generic — `OutstandingTable`, which already has its own
   "Trip" column with a comment explaining a transfer booking has a route there, not a tour).
5. `client/src/pages/admin/AdminReportsPage.tsx:378` — `agree, earliest tour date first.` →
   "earliest trip date first" (same table's caption).
6. `client/src/pages/admin/AdminReportsPage.tsx:386` — `<th>Tour date</th>` → "Trip date"
   (same table's column header).
7. `client/src/pages/admin/AdminReportsPage.tsx:490` — `"...Bookings and the balance still
to collect count by the tour date..."` → "trip date" (generic page-level description,
   covers ALL booking types' money reporting per CLAUDE.md's own reports rule).
8. `client/src/pages/admin/AdminReportsPage.tsx:218` — `const BY_TOUR_DATE = 'By tour date';`
   → `'By trip date'` (used at lines 244/246 as a generic stat-card label covering all
   booking types — rename the constant too for consistency, not just the string, since
   nothing outside this file references the identifier name itself — verify that before
   renaming).
9. `client/src/pages/admin/AdminCouponsPage.tsx:563` — `<th>Tour date</th>` in the coupon
   redemption log → "Trip date" (generic — coupons redeem against any booking type, caption
   above says "N bookings, most recent first" with no tour-specific framing).

**Leave alone — genuinely tour-specific, confirmed by research, do NOT touch:**
`AdminToursPage.tsx` entirely (the tour-CRUD screen); `AdminReportsPage.tsx`'s "Revenue by
tour" heading, `ByTourTable`, the `byTour` query, and its CSV label (lines 150, 253, 262,
267, 290, 556-567, 613) — deliberately separate from a transfer-specific counterpart per
that file's own Task T18 comment at line 307, a real product-line split, not loose wording;
every `toursPricing`/`AdminToursPage.tsx` mention that's a code comment or the real
server-side role-area name, not UI copy.

**Flag, do not silently fix:** `client/src/pages/admin/AdminReviewsPage.tsx:229` —
`{row.tourTitle ?? 'General feedback (no tour)'}`. This is narrower than a wording swap:
`row.tourTitle` is also null for a review tied to a TRANSFER booking (not just one with no
booking at all), and this line has no transfer-route fallback the way
`AdminBookingsPage.tsx`/`AdminPaymentsPage.tsx` do (`?? booking.transferRouteLabel ?? ...`).
A bare word swap to "(no trip)" would paper over a possible mislabeling. **Do not fix this
one in this task** — just change the word if you do touch it for consistency, but note in
your report that the underlying fallback-completeness question (can a review actually
attach to a transfer booking? if so, does it need a three-way fallback like the other
pages?) is unresolved and out of this task's scope.

**Tests to update (confirmed, exact):**

- `client/src/__tests__/admin-bookings.test.tsx:269` —
  `screen.getByLabelText(/tour date from/i)` → `/trip date from/i`.
- `client/src/__tests__/admin-reports-page.test.tsx:309` —
  `expect(screen.getAllByText('By tour date')).toHaveLength(2)` → `'By trip date'`.

No other test asserts any of the other strings above (confirmed by grep, case-insensitive,
across `client/src/__tests__`).

**Mutation-testing proof:** for at least the two named strings in item 1-3 above (the
task's own explicit ask), temporarily revert one change and confirm the corresponding test
reddens, restore.

Commit message: `fix(admin): product-neutral wording — "tour" → "trip" where it means any booking (owner decision 2026-11-11, 1B)`

---

## Task 3 (1C): Public footer tagline — conditional on show_tours

**Researched, to be confirmed by the implementer before editing (controller's own pass did
NOT re-verify every consumer — the implementer must do the verification steps below before
writing code, since the rogue-fork incident means this task's own research was not
independently completed):**

- `client/src/lib/site.ts`'s `SITE.tagline` is currently a fixed string: `'Cebu day tours and
multi-day packages, booked direct.'` (confirm the exact current value and its exact
  location before editing — read the file).
- The owner's decision: while `show_tours` is OFF, the tagline must read **"Private airport
  and island transfers across Cebu, booked direct."** While `show_tours` is ON, keep the
  EXISTING tour-wording tagline unchanged.
- **Implementer's first step: grep `client/src` for every reader of `SITE.tagline`** (the
  controller did not do this directly — do it yourself before writing any code). Confirm:
  - `client/src/components/layout/SiteFooter.tsx` reads it (near-certain, from context
    established in a prior session's work on this same file).
  - Whether `HomePage.tsx`, any SEO/meta code, or anything else also reads `SITE.tagline`.
  - For each reader: does it already call `trpc.settings.get.useQuery()` and have
    `settings?.showTours` available (cheap, no new query), or would adding this conditional
    require a NEW query in that component (more invasive — flag if so, don't silently add
    a new network request to a component that didn't have one)?
- **Check `scripts/check-contact-parity.mjs` BEFORE touching `site.ts`** — this build-guard
  script (wired into root `pnpm test`) compares several `SITE.contact.*` fields against
  `coming-soon/index.html`, and a PRIOR session's own research flagged that `SITE.tagline`
  may ALSO be one of the fields it compares (read the script fully, find every field name
  it extracts and compares — `expected.motto`, `expected.services`, etc. — and confirm
  whether `tagline` is among them). If it IS checked, making `tagline` conditional
  (two possible strings instead of one fixed one) will need the script's own logic updated
  to know which of the two strings is the "real" one to compare against
  `coming-soon/index.html` — **and you must decide what `coming-soon/index.html` (a
  standalone static page with no JS, no access to `show_tours`) should say.** Given
  `coming-soon/index.html` is the page served at the apex domain BEFORE launch (i.e.,
  while the site itself is not live), and the transfers-first launch state is `show_tours
OFF`, the TRANSFERS tagline is almost certainly the correct one for that static page —
  but confirm this reasoning holds (re-read `coming-soon/index.html`'s own existing copy for
  consistency — does it already talk about transfers, or tours?) and say so explicitly in
  your report rather than silently picking one.
- **Pattern to follow:** `client/src/lib/site.ts` already has `visibleNav(showTours: boolean)`
  as an exported function taking a boolean and returning a conditional result — follow that
  exact shape for a new exported function (e.g. `siteTagline(showTours: boolean): string`)
  rather than making `SITE.tagline` itself a function (which would be a breaking change to
  every existing reader's call-shape) or restructuring the `SITE` object.
- Check `client/src/__tests__/layout.test.tsx` (and any other test file) for an existing
  assertion on the current tagline string, and update it to cover BOTH states (showTours
  true → old string, false → new string) rather than just flipping to the new string
  everywhere.

**Tests — write first, watch fail, then implement:**

1. A unit test for the new `siteTagline(showTours)` function (or whatever you name it,
   following the `visibleNav` pattern) — both branches.
2. Whichever component test(s) render the footer (or any other confirmed consumer) with
   `showTours: true` and `showTours: false` mocked, asserting the right tagline text in each
   case.
3. If `check-contact-parity.mjs` does check this field, confirm (re-run the script) it still
   passes after your change, and add/update whatever assertion is needed there — do not
   leave a silently-broken build guard.
4. Mutation-testing proof: temporarily swap which string each branch returns — the relevant
   test(s) must redden. Restore.

Commit message: `fix(content): public footer tagline is product-neutral while show_tours is off (owner decision 2026-11-11, 1C)`

---

## Task 4 (1D): A script to remove demo TOUR bookings (sibling to clear-demo-transfer-bookings)

**Researched exact shape (file:line verified by a completed fork before the incident —
re-confirm the exact current file contents yourself before writing new code, since some
time has passed):**

- **Scope ruling, made here, not deferred to the implementer:** the owner's wording states
  the PROBLEM as "seedDemo must NOT create demo TOUR bookings while show_tours is off" but
  the concrete, actionable ASK is "extend the clear script... or add a sibling script."
  Today there is no `show_tours` conditional anywhere near the demo tour bookings' creation
  (`upsertFleet()` in `seed.ts`, gated only on `context === 'app'` vs `'test'`, never on
  `show_tours`) — and the EXISTING `clear-demo-transfer-bookings.ts` script is, itself, not
  paired with any seed-time gate either (it doesn't stop a future reseed from recreating
  transfer demo bookings; it's a manual, opt-in cleanup tool, run after the fact). **This
  task follows that exact same precedent: build the clearing script ONLY. Do NOT touch
  `seed.ts`'s `upsertFleet()`/`SEED_UNASSIGNED_TRIPS` creation logic** — that would be
  scope creep beyond the literal ask, inconsistent with the one existing precedent this
  task is explicitly modeled on, and a second, different kind of change (seed-time
  prevention) the owner did not concretely request. If the owner wants that too, it's a
  follow-up task. State this ruling plainly in your own report.
- **The demo tour bookings — the complete list, confirmed:** exactly two, from
  `SEED_UNASSIGNED_TRIPS` in `server/src/db/seed-data.ts` (around line 1363-1378): ref
  `RG-SEED23` (`kawasan-falls-canyoneering`) and ref `RG-SEED24`
  (`oslob-whale-shark-tumalog-falls`). `DEMO_REF_PREFIX = 'RG-SEED'` is defined once in
  `seed.ts` (around line 116) and used in exactly one place (`upsertFleet`, around line 1068) — confirm these are still the only two before writing the script; grep
  `seed-data.ts`/`seed.ts` for `RG-SEED` yourself to be sure nothing else was added since.
  **No other demo tour bookings exist.**
- **Match key: `bookings.ref`** (NOT email, unlike the transfer script) — these two rows'
  own surrounding comment in `seed.ts` explicitly documents a past bug where
  email/name-based matching double-created or suppressed rows, so ref is the deliberate,
  already-chosen match key for tour demo bookings specifically. Use `bookings.ref IN
('RG-SEED23', 'RG-SEED24')` as the match (or an allowlist array constant, same idiom the
  transfer script uses for its own allowlist).
- **Guard shape — mirror `clear-demo-transfer-bookings.ts` exactly, same order:**
  (a) `env.ALLOW_DEMO_SEED !== '1'` → throw, before any query; (b) `env.NODE_ENV ===
'production'` → throw, before any query; (c) a payment-taint check — read each matched
  booking's `payments` rows, then the `audit_log` rows for `entity='payments'` with those
  payment ids, build a map of `paymentId → actorType`, and refuse the WHOLE run if any
  actorType is not `'system'` (the one actor type the seed's own payment-writing path ever
  produces). **Simpler than the transfer script in one real way, confirmed by research:**
  these two tour bookings have no `bookingTransferDetails` row (tours don't have that
  table) and no `fleet_date_slots`/`tour_date_slots` row to worry about (raw
  `db.insert(schema.bookings)`, bypassing the real hold/capacity path entirely) — so the
  delete order is simply `payments` (if any — check, don't assume none exist) → `audit_log`
  where `entity='bookings'` and `entity_id` matches → `bookings`. No slot-table cleanup
  needed. Read the real `clear-demo-transfer-bookings.ts` file in full before writing the
  new one — copy its transaction structure, its exact guard-check wording/order, and its
  report-line shape (`console.log` with a `[clear-demo]`-prefixed line naming what was
  deleted vs. already absent), adapted to the simpler tour-booking case.
- **File name and command:** `server/src/db/clear-demo-tour-bookings.ts` (a sibling file,
  not an extension of the transfer one — confirm this matches the owner's own "or add a
  sibling script" phrasing; a single combined script handling both booking types is also
  defensible, but the owner's wording offers "extend... OR add a sibling" as two options,
  and a clean sibling file with its own focused guard-and-delete logic is simpler to review
  and test independently — your call, but default to the sibling-file reading unless you
  find a strong reason the existing file's own structure makes extending it trivially safe).
  Add `"db:clear-demo-tours": "node scripts/db-preflight.mjs && tsx src/db/clear-demo-tour-bookings.ts"`
  to the server workspace's `package.json`, mirroring the exact existing
  `"db:clear-demo-transfers"` entry's shape.
- **Docs:** the existing transfer script is DELIBERATELY undocumented (not in
  `LAUNCH_CHECKLIST.md`, not in `CLAUDE.md`) by its own file's stated design — "never a step
  anyone should run against a server" in the sense of a routine/automatic step. Follow the
  same convention: no doc update needed for the new command either. The exact command to
  tell the owner (for the final report, not a doc file) is:
  `pnpm --filter @rg/server db:clear-demo-tours`, run with `ALLOW_DEMO_SEED=1` set in the
  environment (same precondition the existing transfer command needs — confirm the exact
  invocation shape, e.g. whether `ALLOW_DEMO_SEED=1` needs to be inline on the command or is
  expected to already be in `.env`, by checking how the transfer command's own
  precondition is actually satisfied in practice/documented anywhere, including this
  plan's own prior sessions' reports if you can find them).

**Tests — write first, watch fail, then implement, mirroring `clear-demo-transfer-
bookings.test.ts`'s own pattern exactly (`describeWithDb` blocks):**

1. `ALLOW_DEMO_SEED` unset/wrong → throws, booking(s) still exist afterward (guard fired
   before any query).
2. `NODE_ENV === 'production'` → throws, same proof.
3. A booking with a DIFFERENT ref (not RG-SEED23/24) must survive untouched (match-scope
   test).
4. A payment-taint test: attach a non-`'system'`-actor payment to one of the two matched
   bookings → the WHOLE run refuses, and even the OTHER (untainted) matched booking is left
   alone (the same "refuses the whole run, not just the tainted row" property the transfer
   script's own test proves).
5. The happy path: both RG-SEED23/24 exist, guards pass, no taint → both get deleted, the
   function reports what it did.
6. Mutation-testing proof: temporarily weaken the payment-taint check (e.g. make it check
   for `actorType !== 'nonexistent-value'` instead of `!== 'system'`) — the taint test must
   redden. Restore.

**Dedicated Opus review** (demo-data deletion script — destructive-operation-adjacent, same
tier of care as the existing transfer script got).

Commit message: `feat(db): a script to remove the seed's demo TOUR bookings (sibling to clear-demo-transfer-bookings, owner decision 2026-11-11, 1D)`

---

## Closing report (2026-11-12)

All 4 tasks complete. Final whole-branch review (dedicated Opus, covering `036fb3e..7d1306f`):
no Critical or Important defect in the diff itself — the one real Important finding (the five
checks had not yet been run on the composite tree) is closed below. One Minor, comment-only
correction (overclaiming test comment) folded in as `deb7c61`.

### Commits

| Commit    | Label                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `f772d49` | feat(admin): "Trip requests" sidebar item + standalone page, reusing the existing inquiries inbox (1A)    |
| `72653d0` | fix(admin): update admin-layout.test.tsx's stale nav-link expectations for Trip requests (1A fix round 1) |
| `99c1436` | fix(admin): product-neutral wording — "tour" → "trip" where it means any booking (1B)                     |
| `a560e50` | fix(reports): CSV export header matches the on-screen "Trip date" rename (1B fix round 1)                 |
| `243fe52` | fix(content): public footer tagline is product-neutral while show_tours is off (1C)                       |
| `b69d833` | feat(db): a script to remove the seed's demo TOUR bookings (sibling to clear-demo-transfer-bookings) (1D) |
| `7d1306f` | docs(db): correct clear-demo-tour-bookings' actor-type comment to not overclaim (1D self-correction)      |
| `deb7c61` | Demo Polish 2 (1D): correct overclaiming test comment (final-review finding)                              |

### Five checks on the composite tree (`deb7c61`)

`pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` ✅ (shared 109/109, client 1145/1145, server
2781/2783 + 2 skipped) · `pnpm format:check` ✅ · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` ✅
(pre-existing chunk-size and third-party-comment warnings only, nothing new).

### For the owner: running the new demo-tour-cleanup script

```
# cmd
set "ALLOW_DEMO_SEED=1" && pnpm --filter @rg/server db:clear-demo-tours

# PowerShell
$env:ALLOW_DEMO_SEED="1"; pnpm --filter @rg/server db:clear-demo-tours
```

Same precondition as the existing `db:clear-demo-transfers`: refuses unless `ALLOW_DEMO_SEED=1`
is set AND `NODE_ENV` is not `production`. It deletes the two demo tour bookings (`RG-SEED23`,
`RG-SEED24`) and nothing else, and refuses the _entire_ run if either has a non-seed payment on
it. **Consequence to know before running it:** those two bookings are what the dashboard's
"unassigned trips" alert and the dispatch calendar's demo gold dot currently show as true — running
this script empties both of those demo surfaces until `pnpm --filter @rg/server db:seed:demo`
is run again.

### No new `.env` lines, no new admin settings

This batch added no new environment variable and no new admin-settings field. `ALLOW_DEMO_SEED`
already existed (added by the precedent transfer-cleanup work).

### Flagged for the owner — follow-up candidates, not this batch's debt

1. **`coming-soon/index.html` still reads tour-first** — title "Cebu Tours", meta/OG/Twitter
   descriptions "Cebu day tours, booked direct", h1 "Cebu day tours, booked direct — coming
   soon". Pre-existing, genuinely untouched by this batch (confirmed: `check-contact-parity.mjs`
   never checks `tagline`), but it's the page served at the apex domain in exactly the window
   the transfers-first positioning (1C) is for — the largest remaining instance of the thing 1C
   was asked to fix. Needs owner-approved copy before anyone touches it.
2. **`AdminReviewsPage.tsx`'s `tourTitle` fallback** — `row.tourTitle ?? 'General feedback (no
trip)'` (word swapped per 1B's own scoping) still has no transfer-route fallback the way the
   bookings/payments pages do. Whether a review can attach to a transfer booking, and if so
   whether it needs the same three-way fallback, is a behavior question, not a wording one —
   left open per the task's own explicit instruction.
3. **`settings.contact.tagline`** (admin → Settings → "Tagline") is a dead field — nothing in
   client or server source reads it (grepped repo-wide). The footer tagline is code-side in both
   the tours-on and tours-off branches (`client/src/lib/site.ts`'s `siteTagline()`), so editing
   that admin field currently does nothing. Not introduced by this batch, but worth knowing.

### Minor, deferred (recorded in the ledger, safe as-is)

Inline `['owner','dispatcher']` role literals instead of the `TRIP_REQUEST_ROLES` constant in
one spot (`AdminTripRequestsPage.tsx`); the `DeniedState`/`NOTICE` denial-screen shape copy-pasted
a fourth time (verified byte-identical across all four copies, worth consolidating next touch);
three stale code comments still saying "tour" where the rule is now "trip"; the new tour-cleanup
script's `DEMO_TOUR_BOOKING_REFS` is hardcoded rather than derived from `seed-data.ts` (safe
drift direction — under-cleans, never over-deletes); the payment-taint check's `new Map()` keeps
only the last audit row per payment id with no `ORDER BY` (inherited verbatim from the precedent
script, less exposed here since `seedDemo` writes no payment at all for these two refs).

**✅ DEMO POLISH 2 COMPLETE**
