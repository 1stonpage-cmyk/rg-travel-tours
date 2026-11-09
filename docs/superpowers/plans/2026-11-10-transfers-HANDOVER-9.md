# Transfers launch — HANDOVER-9 (Batch 5: T17–T20)

Continues `2026-11-09-transfers-HANDOVER-7.md` and `2026-11-09-admin-buttons-HANDOVER-8.md`
(the two tracks converge here — Batch 4c is done, this is Batch 5 of
`2026-10-31-transfers-launch.md`'s T17–T29). Written incrementally, one task at a time, rather
than only at batch close — this project has crashed mid-batch before.

## T17 — `inquiries` schema extension for Custom Trip Request — DONE

Commit `d0c5b40` — "T17: inquiries schema extension for Custom Trip Request".

What it does: `inquiries.type` gains `'transfer_custom'`; four new columns
(`requestedDate`/`pax`/`routeDescription`/`convertedBookingId`, migration `0025`); the public
"existing inquiry form" (`ContactSection.tsx` — re-briefed and confirmed against §6's own
wording, not `PackageInquiryForm.tsx`, which is package-only) gains a "Custom trip
request"/"General message" toggle; `admin.inquiries.list` LEFT JOINs `bookings` for
`convertedBookingRef`; `AdminPackagesPage.tsx`'s `InquiryRow` shows the new fields read-only.

**Deliberate decisions, not oversights:**

- No new CHECK constraint and no Zod discriminated union on the four new columns. They stay
  nullable-and-unenforced, matching `packageId`'s existing precedent on this same table —
  unlike `bookings_product_type_shape`, a stray non-null value here has no join or money
  consequence to guard against.
- `inquiryInput.type` now reads `INQUIRY_TYPES` from `packages-admin.ts` instead of repeating
  the literal — closes a drift trap an Opus-advisor review caught before it shipped.
- The guest-side 360px pass on the new fieldset is deferred to T27 (guest transfer flow, named
  in the merged run's own task list). The **admin** `<dl>` is not in T27's scope, so it got its
  own check now: measured via a same-origin static harness (the Chrome screenshot tool is still
  broken in this environment — `scrollWidth` vs `clientWidth` on the actual compiled Tailwind
  CSS, same technique Batch 4c used) with a deliberately space-free 150-character
  `routeDescription`. Pre-fix: `scrollWidth 1037` vs `clientWidth 358` on a 360px card — real
  overflow. Post-fix (`min-w-0` + `break-words` on the `<dd>`, `min-w-0`/`shrink-0` on its
  siblings): `358`/`358`, flush. Mirrors the email field's existing `break-all` rule three lines
  above in the same file.

**Tests, each proven able to fail (break → red → restore)**, 5 new:

- `server/src/__tests__/public-mutations.test.ts` — stores a `transfer_custom` inquiry with its
  three extra fields.
- `server/src/__tests__/admin-packages.test.ts` — `admin.inquiries.list` carries the fields and
  the `convertedBookingRef` join (null pre-conversion), and leaves them null on an ordinary row.
- `client/src/__tests__/admin-packages-page.test.tsx` — the screen renders them.
- `client/src/__tests__/forms.test.tsx` — ×2: the toggle actually gates which `inquiryInput`
  keys go out, both directions (switching to custom sends the three fields; switching back
  drops them, not just hides their boxes).

Full suite after T17: shared 8/99, client 84/1034, server 129/2638, both standalone guards —
all green. `pnpm lint` / `typecheck` / `format:check` / `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`
all clean.

## Migrations owed on the server

**0015 through 0025, in order — 0015–0024 unchanged from Handover 7/8. `0025` is new this
batch** (T17: `inquiries.type` enum widened + 4 nullable columns + 1 FK — additive only, no
column removed, no backup needed for 0025 itself). **0024 still removes columns — back up the
server database before applying 0015–0025 as a batch**, same as every prior handover has said.
Applied locally to `rg_travel`; `rg_travel_test` picks up every migration automatically via
`global-setup.ts`'s own `migrate()` call (confirmed this batch, not merely assumed) — no
separate hand-run needed for the test database, on the server either.

## Unrelated bugs found (not fixed, per CLAUDE.md)

1. `shared/src/schemas/public.ts`'s `inquiryInput` (line ~30) has no `.strict()`, despite
   `ContactSection.tsx:37`'s doc comment and `packages-admin.ts`'s file header both describing
   it as one. Pre-existing, not worsened by T17 (the new keys are optional top-level fields
   either way under either a strict or non-strict object). Found via an Opus-advisor review
   pass, not fixed — out of scope.

## T18 — outstandingBookings LEFT JOIN + revenueByRoute + CSV — DONE

Commits `fb364ea` (implementation) and `f4a7f5f` (dedicated-review follow-up).

Fixes the Must-fix #1 named in the plan: `outstandingBookings()`'s `INNER JOIN tours` was
silently dropping every transfer booking from the outstanding-balances report regardless of
whether it had a route. Now a `LEFT JOIN`, with the title falling back to the transfer's route
("Mactan Airport → Oslob", swapped for `direction: 'reverse'`) or to a staff-typed
`customRouteDescription` (or the literal "Custom transfer") for a routeless staff-quoted trip.

Adds `revenueByRoute()` — `revenueByTour`'s transfer-side counterpart, grouped by
(route, direction, vehicle type), not by product type (a route's row deliberately mixes
one-way and day-use revenue — the plan's own granularity). Wired through `admin.reports.byRoute`
(now a 5th procedure in that router), its CSV export, and a new "Revenue by route" table on
`AdminReportsPage.tsx`. Renamed the outstanding report's **displayed** "Tour" column to "Trip"
(CSV header and `<th>` only — the `tourTitle` field name stays, to avoid an unrelated rename
cascade across its only two consumers).

**Dedicated Opus review (required for T18 per the merged-run rules) ran and approved, no
blockers** — but surfaced two should-fix items worth recording since they are LATENT until
T19/T20 starts creating non-tour bookings through `admin.transferQuotes.convert`:

1. `revenueByRoute()` had used `INNER JOIN booking_transfer_details`, trusting a cross-table
   invariant ("every non-tour booking has exactly one details row") that no DB CHECK can
   express — the same reasoning `services/transfers/capacity.ts` and
   `services/dispatch/availability.ts` already reject for this exact join. Fixed: `LEFT JOIN`
   plus a throwing `requireDirection()`, so a future writer bug that skips the details row
   drops that booking's money LOUDLY (an error) rather than silently.
2. A routeless custom transfer's `direction` column is never validated by
   `createTransferBooking()` (its `reverseEnabled` check only runs when a route exists), so two
   custom bookings could in principle land in different grouped buckets with byte-identical
   "Custom transfer (Van)" labels — indistinguishable on screen from a duplicate. Fixed: direction
   is normalised to `'forward'` whenever `routeId` is null.

Both are already fixed in `f4a7f5f`, with fixtures/tests added for the behaviors they protect
(see that commit). **No action owed to T19/T20 beyond business as usual** — just noting why
`revenueByRoute()`'s joins look the way they do, so nobody "simplifies" them back to INNER JOIN.

Full suite after T18: shared 8/99, client 84/1035, server 129/2644, both standalone guards — all
green. `pnpm lint` / `typecheck` / `format:check` / `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` all clean.
No schema change this task (T18 is schema-free per the plan).

## T19 — new `transferQuoting` role area + `admin.transferQuotes.convert` — DONE

Commits `0147f9b` (implementation) and `804513b` (dedicated-review follow-up).

Owner/finance can now convert a `transfer_custom` inquiry into a real, held transfer booking
with a staff-entered price. New `ROLE_MATRIX` area `transferQuoting: ['owner', 'finance']`,
transcribed into `BUILD_SPEC.md` §9's table and `role-isolation.test.ts`'s `AREA_LABELS`/
`adminHarness`/counts (12→13 areas, 23→25 allowed, 13→14 denied) in the same commit, per that
test's own enforced convention. `admin.transferQuotes.convert` is gated `adminProcedure`
`('transferQuoting')` and is the only entry point into the new service.

**Closed a real, pre-existing gap named by an earlier task, not invented by this one.**
`services/transfers/overlap.ts`'s `computeTransferWindow()` doc comment (written during T7,
before T19 existed) explicitly said a one-way custom (routeless) transfer has no stored
duration anywhere in the schema and THROWS rather than default one, naming T19 as the task that
must close it. `CreateTransferBookingInput` gains `customRouteDurationMinutes: number | null`
(required exactly for a routeless one-way trip); `assertBookableShape` gains a new, pre-
transaction typed refusal (`custom_one_way_needs_duration`) instead of leaving that throw
reachable. One variable (`routeDurationMinutesUsed`) feeds both the capacity-window computation
and the frozen `booking_transfer_details` column, so the two cannot disagree. No new migration —
`booking_transfer_details.route_duration_minutes_used` already existed from an earlier task.

**`convertTransferQuote()` (`services/transfers/convert-quote.ts`) is three steps, deliberately
not one transaction** — `createTransferBooking()` manages its own self-contained transaction and
its own doc comment warns against a second pooled connection being held open across it:

1. A plain, lockless pre-check of the inquiry (exists, `type='transfer_custom'`,
   `convertedBookingId IS NULL`, `routeDescription` present — a malformed-row guard, since T17
   added no CHECK).
2. `createTransferBooking({..., priceSource:{kind:'staff', priceCentavos, staffUserId}})` —
   commits independently.
3. A small transaction, wrapped in the same `withDeadlockRetry()` the shared writer uses, that
   links `inquiries.convertedBookingId` via a compare-and-swap `UPDATE ... WHERE
   converted_booking_id IS NULL` (the same pattern `admin.auth.resetPassword` already uses on
   `password_reset_tokens.used_at`) and writes the dedicated `transfer.custom_quote_converted`
   audit row the plan names (actor, inquiry id, price — no PII).

**The accepted, documented consequence:** two staff converting the same inquiry concurrently can
both pass step 1 and both create a real booking in step 2; step 3's compare-and-swap lets exactly
one link. The loser's booking is a live, unlinked `pending_payment` hold — not silently
discarded: `TransferQuoteConvertRaceError` names both booking refs, and the admin screen surfaces
a `CONFLICT` pointing staff at `admin.refunds.cancelBooking` to clean up the duplicate. The orphan
is bounded either way: `expire-holds.ts`'s sweep has no tour-only filter and reclaims it after
`staffQuoteHoldHours`.

**Deliberate decisions, not oversights (each documented in `transferQuoteConvertInput`'s own
header in `shared/src/transfers-admin.ts`):**

- `leadPhone` and `pax` are required, staff-typed fields, even though the plan's own §6 step 2
  prose lists neither — read as illustrative ("the full set of transfer-booking fields"), not
  exhaustive. `inquiries.phone`/`inquiries.pax` are both nullable while `bookings.leadPhone` and
  `assertBookableShape`'s pax check are not; riding either through unedited would make any
  inquiry where the guest skipped one permanently unconvertible. `routeDescription` and the
  guest's own `message` DO ride through unedited (they are the request, not a value with a
  nullability mismatch).
- No `couponCode`, `payMode` or `direction` field: no discount layered on the one legitimate
  staff-entered price; `payMode` is always `'deposit'` (nobody is at checkout when staff
  convert a request); `direction` is always `'forward'` (no catalog route on this path — the
  same normalisation `revenueByRoute()`, Task T18, already applies to a routeless transfer).

**Dedicated Opus review (required for T19 per the merged-run rules — money AND a new role
boundary, the plan's own dual-trigger) ran and approved, no blockers**, with 5 should-fix and 4
nitpicks, all fixed in `804513b`, each with its own new test proven able to fail where
applicable:

1. `priceCentavos` gained a `MAX_CENTAVOS` cap — bare `.positive()` let an `INT`-overflowing
   staff typo roll back as a raw MySQL error-1264 instead of a named refusal.
2. `transfer-clock-pattern-parity.test.ts` extended to this task's own (fourth) independent
   `HH:mm` regex copy.
3. New `shared/src/__tests__/transfers-admin.test.ts`: direct, DB-free coverage of
   `transferQuoteConvertInput`'s `superRefine` — all four cross-field branches, previously
   untested anywhere.
4. The day-use "freezes none" test now actually reads
   `booking_transfer_details.route_duration_minutes_used` and asserts `null`.
5. Step 3 wrapped in `withDeadlockRetry()` — a transient failure there used to roll back the
   link while leaving the already-created booking live, the same orphan the documented race
   produces, reached a different way.
6–9 (nitpicks): a stale comment claiming `inquiries.message` is nullable, a doc comment
   overclaiming a stray duration is refused rather than ignored, a bare `Error` in the
   double-race fallback now a `TransferQuoteLinkUnconfirmedError` naming the orphaned booking,
   and an operational note for T20's form (don't offer a placeholder phone for "no number
   given" — it would trip the per-phone hold cap on the THIRD such conversion).

Full suite after T19: shared 9/109, client 84/1035, server 130/2675, both standalone guards —
all green. `pnpm lint` / `typecheck` / `format:check` / `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`
all clean. No migration this task — `transferQuoting` is a role-matrix-only change; nothing new
owed on the server beyond the migrations already recorded above.

## T20 — `ConvertInquiryForm.tsx` + `AdminPackagesPage.tsx` "Quote & convert to booking" control — DONE

Commit `a64e609`. Combined Sonnet review (not one of the five dedicated-Opus-review tasks) —
no new blockers, 3 should-fix findings surfaced by `advisor()` and fixed before this commit (see
below).

Each unconverted `transfer_custom` inquiry row on `AdminPackagesPage.tsx` now draws a "Quote &
convert to booking" control that opens `ConvertInquiryForm` inline (no modal exists anywhere in
`client/src/pages/admin/`, confirmed by grep) — `EntityForm` for the fields, `FormActions` for
Cancel/primary, a two-step confirm (`primary-pill`, not `amber-pill`: this creates a real,
cancellable hold, not a destructive action) that states the quoted price in figures and words
before calling `admin.transferQuotes.convert`.

**New `TRANSFER_QUOTING_ROLES` constant in `lib/roles.ts`**, not folded into `MONEY_ROLES` even
though both are `['owner', 'finance']` today — that file's own header is explicit that one
constant stands for one §9 ANSWER, not a coincidence of roles, and `transferQuoting` is its own
`ROLE_MATRIX` area with its own reasoning.

**One schema, two shapes, handled by rebuilding the field list from `productType` on every
render — not by hiding boxes.** `transferQuoteConvertInput`'s `superRefine` requires
`customRouteDurationMinutes` on one-way and refuses it (with flight details) on day-use;
`onProductTypeChange` CLEARS the other shape's values on switch, and the submit payload is built
branching on `productType`, never on what survived in `values` — the exact bug `advisor()`
flagged in review (`EntityForm`'s `values` persists a field's value after it leaves `fields`).
Proven with a mutation test: reverting both the clearing and the branch-based payload build made
`switching to day-use drops the one-way-only fields...` fail with the expected shape (a day-use
payload failing its own schema's refusal of a stray `customRouteDurationMinutes`), confirmed, then
restored.

**Owner decision needed, not yet made — the control is correct-by-construction for the day it
changes, but is owner-only in practice today, for reasons outside T19/T20's authorization to
fix:**

1. `admin.inquiries.list` (draws this whole screen) is `adminProcedure('packagesInquiries')` —
   owner and dispatcher, **not finance**. §9's own stated reasoning: "an enquiry carries no
   money." Finance cannot reach the row the convert control lives on at all, regardless of
   `transferQuoting`'s role list.
2. `admin.vehicleTypes.list` (populates the control's vehicle-type picker) is
   `adminProcedure('toursPricing')` — **owner only**, narrower even than `transferQuoting`.
   Gated on `isOwner`, not on `transferQuoting`, specifically so a finance session (today,
   nobody — see 1) doesn't fire a query the server 403s and silently land on a dead-end empty
   select; a genuinely-empty active-vehicle-type list (owner session, none configured yet) gets
   the same explicit "No vehicle type is available to quote this trip yet." notice instead of a
   bare Zod message on a select with no options.
3. `AdminPackagesPage`'s own `DeniedState` text ("Only the owner and dispatcher can manage
   packages and enquiries") is the sentence a finance user sees instead of ever reaching the
   convert control — unchanged, cosmetic, correct today.

**Did NOT widen `packagesInquiries` or `toursPricing`** to admit finance — that is a role change
outside what T19 authorized ("Role changes ONLY per T19") and would contradict §9's own stated
reasoning for excluding finance from enquiries. Whoever decides should look at all three items
above together, since they change as one unit.

**Tests, each proven able to fail**, 7 new in `client/src/__tests__/admin-packages-page.test.tsx`:
role-gating (drawn for owner on an unconverted custom-trip request; absent for a non-matching row,
an already-converted one, and for a dispatcher); the empty-vehicle-types notice; the happy path
(pre-fills `pax`/`leadPhone` from the inquiry, states the price in words, converts, shows the
booking ref); an inline client-side price-format refusal; a server-side `priceCentavos` refusal
(T19's own `MAX_CENTAVOS` message) landing on the price box via a `priceCentavos` → `priceInput`
name remap, not only the banner; and the day-use field-clearing mutation-proof above.

Full suite after T20: client 84/1042 (+7; shared/server untouched this task — no schema, no
server file changed). `pnpm lint` / `typecheck` / `format:check` /
`ALLOW_PLACEHOLDER_BUILD=1 pnpm build` all clean. No migration this task.

## Batch 5 (T17–T20) — summary

Commits, in order: `d0c5b40`/`ff4b510` (T17), `fb364ea`/`f4a7f5f`/`cd76a5c` (T18),
`0147f9b`/`804513b`/`7662fad` (T19), `a64e609` (T20, this handover still owed its own
HANDOVER-9 commit).

Migrations owed on the server: **0015 through 0025, in order — back up before applying, per
0024's own column-removal note** (unchanged since T17; T18/T19/T20 added no migration).

Owner decisions needed (all deferred, not blocking): the three-item finance-reach gap named
under T20 above (§9 vs. `packagesInquiries`/`toursPricing`); the duplicate-booking cleanup the
T19 race can leave behind is bounded by `expire-holds.ts` but still needs `admin.refunds
.cancelBooking` run by hand if staff hit it.

Unrelated bugs found (not fixed): `shared/src/schemas/public.ts`'s `inquiryInput` still has no
`.strict()` despite being documented as one (T17 finding, still open).

Local URLs to check: client `http://localhost:5180/admin/packages` (owner session) — the new
convert control on a `transfer_custom` row.

✅ BATCH 5 COMPLETE
