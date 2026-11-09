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

## Next

T19 — new `transferQuoting` role area + `admin.transferQuotes.convert`. Dedicated Opus review
required (money AND a new role boundary — the plan's own dual-trigger for maximum scrutiny).
