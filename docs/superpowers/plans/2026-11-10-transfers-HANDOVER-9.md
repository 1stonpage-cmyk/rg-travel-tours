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

## Next

T18 (outstandingBookings LEFT JOIN + revenue by route + CSV).
