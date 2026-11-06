# Transfers Launch — Handover 3, 2026-11-06 (Batch 4a)

**Status: 0A, 0D, T12, T13, T14 done and reviewed clean. Plus one unplanned fix (QA-1), found and closed during the mandated post-batch Chrome walkthrough. Not pushed. Next step: T15.**

Plan: `docs/superpowers/plans/2026-10-31-transfers-launch.md`. `main` was `origin/main` at `0eb936e` (T1–T11 done and pushed, per Batch 3's own handover) when this batch started. See `docs/superpowers/plans/2026-11-03-transfers-HANDOVER-2.md` for everything through T11 — this doc does not repeat it.

## Commits, this batch

| Task      | Commit    | Label                                                                                                            |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| 0A        | `81cdd0a` | docs(transfers): record 2026-11-06 owner decisions in the plan (0A)                                              |
| 0D        | `2987906` | fix(transfers): surface destination-inactive on transfer routes (0D)                                             |
| 0D fix 1  | `ca08b86` | fix(transfers): address review findings on 0D test quality (0D review fix)                                       |
| T12       | `ddc8326` | test(transfers): pin behavioral parity across the three clock-time regexes (T12)                                 |
| T13       | `93269f0` | feat(transfers): add TransferTypePicker/RoutePicker/VehicleOptionCard/TransferGuestDetailsForm (T13)             |
| T14       | `66a9e24` | feat(transfers): TransferBookingPage, home hero/nav/header lead with transfers (T14)                             |
| T14 fix 1 | `7c0a2ba` | fix(transfers): address T14 review findings — coupon recovery, stale price, test/contrast fixes (T14 review fix) |
| **QA-1**  | `9baa844` | fix(seo): add /transfer to the app-surface meta mechanism (QA-1, BUG-116 pattern for /transfer)                  |

`git log --oneline -8` on `main` currently shows `9baa844` down through `81cdd0a`, then `0eb936e` (prior batch's head). Nothing in this batch has been pushed.

## What each task built

**0A** — recorded three 2026-11-06 owner decisions directly in the plan file, closing three of the four open questions the 2026-11-03 handover had carried forward: (1) a transfer route whose destination is inactive is not sellable even if the route itself is active; (2) tours and transfers keep ONE shared rate-limit budget for hold attempts, as already built; (3) T24 (notification-copy sweep) stays in Batch 6, no reorder.

**0D** — implemented decision (1). **Most of the actual enforcement was already built by T9** (`transferRoutes.list` and `vehiclePriceForRouteAndType` both already filtered on `destinations.isActive`) — this task filled three real gaps: a hold-path regression test proving an active route on a retired destination is refused with the same non-distinguishing sentence the route-retired case gets; `destinationIsActive` surfaced on `admin.transferRoutes.list`'s row; an additive amber "Destination inactive — hidden from guests" label on the admin screen (beside, not replacing, the existing Active/Inactive badge). Review found 1 Important (a test that could never go red — fixed, then independently re-verified by mutating the component and confirming the corrected assertion does redden) + 2 Minor (both fixed).

**T12** — confirmed almost all of the plan's T12 row was already built by T9/T11 (real quote input, real hold input, friendly messages, one re-export point). The one real gap: three near-identical-but-not-byte-identical copies of an `HH:mm` clock-time regex, with no test pinning them equal. Added one behavioral parity test driving all three through their real public surfaces. **Ruled not to consolidate** the three into one shared constant — `settings-schema.ts`'s copy also backs an unrelated nullable field, so consolidating would be a settings-validation behavior change for zero gain. Review clean, zero findings.

**T13** — four presentational components (`TransferTypePicker`, `RoutePicker`, `VehicleOptionCard`, `TransferGuestDetailsForm`), no tRPC calls inside any of them — data-fetching deliberately deferred to T14. Prop contracts fixed by the controller before dispatch (three take a resolved `error?: string`; `TransferGuestDetailsForm` alone takes raw `error?: unknown` and calls `field-errors.ts` itself) specifically so three different implementer-chosen contracts wouldn't have to be reconciled by T14. Review clean, 2 Minors parked (stylistic non-null assertions; hardcoded radio `name` attributes — both harmless for the single-instance-per-page usage T14 builds).

**T14** — `TransferBookingPage.tsx` at `/transfer`, consuming all four T13 components; home hero gained a primary transfer mini-flow (plain `Select`/`Input`, not the T13 card pickers — those stayed booking-page-only, a controller correction before dispatch since they don't fit the hero's compact grid); nav gained "Transfers" ahead of "Tours"; header CTA changed to "Book a transfer". Tours were explicitly NOT hidden — `show_tours`/T15 is untouched, the existing tour search is demoted but fully functional.

Review found **2 Critical**: (1) a bad/expired coupon code threw `BAD_REQUEST` on both the van and SUV `quoteTransfer` queries at once, and the page treated that identically to "both vehicles unavailable" — unmounting the entire guest-details form and destroying every field the guest had already typed, with `CouponField` still falsely showing "applied."; (2) `keepPreviousData` kept showing the OLD product type's price on a vehicle card, still selectable, while the new product's quote was loading — a stale price presented as current. Plus 2 Important (a happy-path test that didn't actually pin `<PaymentOptions>` reuse, since the booking ref also appears in an unrelated sibling `<span>`; an unrequested contrast regression on the demoted tour-search card's background/blur). One fix round closed all four, verified by a dedicated Opus re-reviewer (escalated per this batch's review policy, since 2 Criticals were found) with its own independent mutation proofs for every finding, including reproducing the exact false-positive the test finding described before confirming the fix catches it. 2 Minors parked, see below.

**QA-1 (unplanned)** — found live during the mandated post-batch Chrome walkthrough, after T14's fix round reviewed clean: a real browser navigation to `/transfer` served an actual **HTTP 404** with title "Page not found | TravelSugbo" — the exact **BUG-116** shape this codebase already has a documented, tested fix-pattern for (`/checkout` and `/booking` hit this same bug once already). `resolvePage()` checks `appSurfaceMeta()` before the route table; T14 added `/transfer` as a real public route but nobody added an entry to that mechanism, so it fell through to the 404 branch. The SPA still rendered correctly client-side (masking it from every click-through that started from an in-app `Link`), which is exactly why neither T14's own browser check, the combined review, nor the Opus re-review caught it — none of them did a fresh full-page navigation straight to `/transfer`.

Fixed as a three-file mirror of the exact existing `/checkout`/`/booking` pattern (`shared/src/document-titles.ts`, `server/src/middleware/robots-header.ts`, `server/src/seo/resolvers.ts`), plus two test cases mirroring the existing coverage. The implementer hit this session's token/rate limit right after committing and finishing its own report, before it could send its final reply — the controller independently re-verified the whole thing from scratch (full diff re-read against the brief, all five checks re-run clean, live Chrome re-confirmation that the title is now correct) rather than trust an unreturned status.

**This bug class will recur if nothing changes the mechanism.** `NOINDEX_PATH_PREFIXES` / `APP_SURFACE_COPY` / `APP_SURFACE_TITLES` has no compile-time link to `client/src/App.tsx`'s route table — a new top-level public SPA route compiles fine with zero entries and silently 404s on its first real navigation. This has now bitten twice (BUG-116 for `/checkout` + `/booking`; QA-1 for `/transfer`). **Any new top-level public route added to `App.tsx` from here on needs an entry in all three app-surface constants, in the same commit — this is not optional, and nothing currently enforces it.** Batch 5's new admin screens (`AdminTransferRoutesPage`-adjacent, `ConvertInquiryForm`) are safe because they live under the already-prefixed `/admin`; the next time this bites will be another new top-level PUBLIC route.

## Migrations owed on the server

**Unchanged from the prior handover — this batch added no schema change.** Still **0015 through 0021**, in order, none applied anywhere but local `rg_travel`/`rg_travel_test`:

| #         | What                                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0015–0020 | vans.vehicle_type; transfer_routes/prices; bookings product_type/route_id/vehicle_type_requested + CHECK + booking_transfer_details; CHECK correction; drivers.max_transfer_jobs_per_day; booking_transfer_details.route_duration_minutes_used |
| 0021      | vans.luggage_capacity (nullable int, no default) — pre-task 0C                                                                                                                                                                                 |

**After applying these, re-run `pnpm --filter @rg/server db:seed`** (the insert-only base seed) — unchanged advice.

## Rulings made this batch (controller decisions on your behalf — read these)

1. **0D's refusal message text stays unchanged.** Kept `checkout.quoteTransfer`'s existing non-distinguishing refusal ('No price is available for that route and vehicle.') rather than the batch prompt's example "This route isn't available right now." — the current message was deliberately written not to reveal WHY (route doesn't exist vs. retired vs. destination retired), avoiding an id-enumeration oracle (a T9 review finding). Cost if wrong: a one-line string change, no behavior change.
2. **T12: do not consolidate the three clock-time regex copies.** `settings-schema.ts`'s copy also backs an unrelated nullable field (`businessHourEntrySchema`'s `opensAt`/`closesAt`); consolidating would be a settings-validation behavior change for zero gain. A behavioral parity test closes the drift risk instead. Cost if wrong: three copies stay three copies; the test now catches any future drift between them.
3. **T13/T14 prop-contract split, decided before T13 was dispatched**, to avoid three different implementer-chosen error-prop shapes T14 would then have to reconcile: `TransferTypePicker`/`RoutePicker`/`VehicleOptionCard` take a resolved `error?: string`; `TransferGuestDetailsForm` alone takes raw `error?: unknown`. Cost if wrong: a prop-shape change across four files, each already covered by its own component tests.
4. **T14's hero mini-flow uses plain `Select`/`Input`, not the T13 card pickers.** The card/pill pickers are full-width booking-step UI; the hero's existing form is a compact one-row grid. Decided before dispatch rather than letting the implementer either wreck the hero's layout or modify components outside their fixed scope. Cost if wrong: a hero redesign, isolated to `HeroSection.tsx`.
5. **`/transfer` gets permanent noindex, mirroring `/checkout`/`/booking` (QA-1).** This is the conservative, zero-judgment-call fix for the literal 404 bug, but it is **not** a settled SEO decision — see the open question below.

## Parked findings / known gaps (none block anything; read before the next batch touches these areas)

- **(T14, parked Minor)** The page-level consent pre-check message isn't positioned beside the checkbox and doesn't clear reactively on check — a direct consequence of `TransferGuestDetailsForm`'s fixed, no-op `onChange` (a T13 contract boundary). The precheck still correctly blocks the mutation.
- **(T14, parked Minor)** `RoutePicker`'s empty state doesn't distinguish "no routes" from "fetch failed" — matches this codebase's existing pattern elsewhere (the hero's own `destinationsQuery`), not a regression.
- **(T14, new residual surfaced by the Opus re-review, parked)** During a `productType` switch, `TransferGuestDetailsForm`'s pay-mode fieldset briefly shows the OLD product's "due now" figures (a sub-second display race) — `quoteFor()` only checks `isError`, not `isPlaceholderData`, before handing a quote down. **No money risk**: `createHoldTransfer` sends only the selection fields and the server recomputes authoritatively, and the vehicle card itself is already correctly gated. A real but narrow display-only gap; the fix shape is gating `selectedQuote` the same way the card now is, if someone wants to close it.
- **(T14, known heuristic limit, documented by design, not a defect)** Both `quoteTransfer` queries erroring for a NON-coupon reason (e.g. no price row for either vehicle type on a route) while a valid coupon is applied is still attributed to the coupon by the two-query discriminator. This is the discriminator working exactly as specified, not a bug — a route with no price for either vehicle type is an admin data problem, not a guest-facing edge case worth a third discriminator dimension.
- **(Live-verification limitation, both T13 and T14 and the controller's own final walkthrough)** The dev database has **zero `transfer_routes` rows** (no seed covers this admin-entered catalog yet — that's a T26 deliverable). The booking flow past route-selection (vehicle cards, guest details, hold, payment) has **never been exercised in a live browser** — only through component tests and the page-level test with mocked tRPC. If the owner wants this walked live, a demo route needs seeding first (T26, not this batch).
- **(Tooling limitation, not a code issue)** `resize_window` (Claude in Chrome) did not actually change the rendered viewport in this session — confirmed by screenshotting before and after a resize call and seeing identical 1568×698 output both times. Both the T13 and T14 implementer agents independently hit the same limitation. **360px was not visually verified this batch** — verification relied on reading tap-target/breakpoint classes in the source plus the `no-red`/`contrast` guard tests, which don't check breakpoints.

## Open owner questions (new this batch)

1. **(New) Should `/transfer` actually be noindex, permanently?** QA-1's fix mirrors `/checkout`/`/booking`'s treatment (a thin, dynamic, no-stable-content booking flow → permanent noindex) as the safe, zero-judgment-call fix for a literal 404 bug, made without the owner awake to ask. But owner decision 8 (2026-10-28) makes transfers the **lead product** — a permanently-noindexed primary landing page is plausibly not what's wanted once real routes/content exist on it. This was a controller ruling under time pressure (the 404 itself needed fixing regardless of the answer), not a settled product decision — worth a real answer before launch.
2. **(Carried, unanswered)** Day-use overrun legal/content gap (plan's Legal & content to-dos #4) — still open, not addressed by any 2026-11-06 decision.
3. **(Carried, unanswered)** "Operated by R&G Travel & Tours" regulatory language for transfers — still open (plan's Legal & content to-dos #6).

## Unrelated bugs found

None beyond QA-1 itself, which was fixed rather than only logged (see the ruling in the ledger: it's a direct regression from this batch's own T14, the fix is a zero-design-judgment mirror of an existing pattern, and it was found during the user's own explicitly-requested final review).

## Test counts

Full suite as of the final state (`9baa844`), each workspace run directly, independently re-verified by the controller after the QA-1 implementer's session was cut off by a rate limit:

- shared: 7 files, 93 tests
- client: 74 files, 925 tests
- server: 120 files, 2453 tests

All green. All five checks (`lint`, `typecheck`, `test`, `format:check`, `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`) pass on this state. One transient `ERR_IPC_CHANNEL_CLOSED` vitest-worker flake was observed on a single full-monorepo `pnpm test` run and did not reproduce on an isolated `pnpm --filter @rg/server test` re-run (2453/2453 clean) — a worker-teardown flake under load, not a real failure.

## Viewing it locally

Dev server already running on 5180/3100 (per the batch instructions — not restarted). Home page: `http://localhost:5180/` (transfer mini-flow now primary in the hero, demoted tour search still beneath it). Booking page direct: `http://localhost:5180/transfer` — renders correctly, but **the dev database has no transfer routes seeded**, so you'll see "No routes are available right now" past the type-picker step. Seed a demo route (or wait for T26) to walk the rest of the flow live.

---

**Next task: T15** (`show_tours` settings block + gate — server-side: `tours.list`/`bySlug`, `checkout.quote`/`createHold` refusals, SEO resolver + sitemap gate. Dedicated Opus review per the plan's own task table). Re-brief against current code before dispatching, same discipline as every task this batch.
