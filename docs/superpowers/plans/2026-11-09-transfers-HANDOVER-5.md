# Transfers — Handover 5, 2026-11-09 (Flexible places/routes/vehicle types, owner decision 2026-11-08)

**Status: 0A through 1G all done, reviewed, and committed. Not pushed. Next task: T17 (plus BUG-122 still pending an owner ruling).**

Plan: `docs/superpowers/plans/2026-11-08-flexible-routes.md` (the design note this whole batch built against). `main` was at `f241af9` when this batch started (T1–T16 pushed, per Handover 4). This batch replaces the hard-coded `van`/`suv` vehicle-type enum with an admin-managed `vehicle_types` list, and replaces "one route per destination" with admin-managed "places" joined from/to on routes with a reverse-direction flag — owner decisions dated 2026-11-08. See Handover 4 for everything through Batch 4b; this doc does not repeat it.

## Commits, this batch

| Task  | Commit    | Label                                                                               |
| ----- | --------- | ----------------------------------------------------------------------------------- |
| 0A    | `fad9c76` | docs(transfers): design note for flexible places/routes/vehicle types (0A)          |
| 1A    | `28f481f` | feat(schema,shared): vehicle_types + transfer_places tables, FK swaps (1A)          |
| 1B    | `f1d1279` | feat(transfers): generalize capacity/pricing/dispatch to dynamic vehicle types (1B) |
| fmt   | `58a6627` | style(migrations): prettier formatting on 1A's generated snapshot/journal           |
| fmt   | `47b6c4e` | style(tests): prettier formatting on 1B-era dispatch/alert tests                    |
| 1C    | `864ddc0` | feat(transfers): admin/public routers for places, vehicle types, routes (1C)        |
| fix   | `df0f0e7` | fix(transfers): scope route price-row delete to active types, not routeId alone     |
| 1D+1E | `6a25572` | feat(admin,public): flexible transfer places/routes/vehicle-type UI (1D/1E)         |
| 1F    | `215ca41` | test(transfers): full regression for flexible places/routes/vehicle types (1F)      |
| 1G    | `c3a81bc` | feat(seed): demo transfer catalog — places, routes, prices, fleet (1G)              |

`git log --oneline -1` on `main` currently shows `c3a81bc`, with `f241af9` ten commits back. **Nothing in this batch has been pushed.**

## What each task built

**0A** (Opus-reviewed design note) — the authoritative schema/migration/service/router/test plan for the whole batch, amended twice more during the batch as 1C's and 1D/1E's own reviews found real gaps in it (the gate-timing ruling's self-contradiction; the price-card completeness contract's outer-patch-key vs inner-card-key ambiguity).

**1A** (schema + migrations) — `vehicle_types` and `transfer_places` tables; `transfer_routes` restructured to `fromPlaceId`/`toPlaceId` + `reverseEnabled`, dropping `destinationId`; `transfer_route_vehicle_prices`' PK swapped to `(routeId, vehicleTypeId)`; `vans.vehicleTypeId`/`bookings.vehicleTypeId` replacing the old enum columns, with the `bookings_product_type_shape` CHECK rewritten. Two hand-edited migrations (`0023` additive, `0024` subtractive — a two-stage schema technique devised to work around drizzle-kit's non-interactive rename-prompt limitation), with existing van/suv/route/price/booking data migrated by natural key, nothing lost. Both migrations were replayed statement-by-statement against a scratch copy of local `rg_travel` before being reported done, then applied for real via `pnpm db:migrate` (tracked as ids 23/24/25 in `__drizzle_migrations`).

**1B** (services) — `services/transfers/capacity.ts`, `services/transfers/pricing.ts`, `services/transfers/create-booking.ts`, `services/transfers/upsert-route.ts`, `services/dispatch/availability.ts`, `services/dispatch/assign.ts` all generalized from the fixed `{van, suv}` shape to a dynamic `Map`/`Set` keyed by `vehicle_type_id`. New `sumLeftoverVehicles()` helper shared between the tour and transfer capacity gates so they can never disagree. New post-catalog-read checks for `reverse_not_enabled_for_route` and `flight_details_required_for_airport_route` (the latter closing a blank-string bypass). A grep-guard test pins that no `'van'`/`'suv'` string literals remain in the generalized logic.

**1C** (shared Zod + tRPC) — new admin routers `admin.vehicleTypes.*` and `admin.transferPlaces.*` (both reusing the existing owner-only `toursPricing` area — no new `ROLE_MATRIX` row), `admin.transferRoutes.*` and `admin.vans.*` rebuilt for the new shapes, public `transferRoutes.list` rebuilt to apply the §4 sellability rule (priced AND sellable), new public `vehicleTypes.list`. Found and fixed during 1C's own review: a real regression in `admin/vans.ts` (a missing vehicle-type-id existence check that would have surfaced as an opaque 500 instead of a guest/admin-safe 400).

**Server fix** (`df0f0e7`, found during the 1D/1E review, landed ahead of their commit) — `upsertTransferRoute()`'s price-row delete matched on `routeId` alone, so saving ANY field on a route through 1D's new form would have silently wiped a since-deactivated vehicle type's stray price (the form can only ever post a card naming active types, so it could never restate that row to save it). Fixed by scoping the delete to the union of active vehicle types and whatever the caller actually names as a key — preserving the existing, intentional "omit a key, drop that type's price" rule for every type an admin can actually see.

**1D** (admin UI) — new "Vehicle types" page, new "Places" page with a type-to-search combobox (`TransferPlaceCombobox`, plain HTML — no Radix combobox/popover exists in this project) carrying an inline "+ Add new place", `AdminTransferRoutesPage` rebuilt (From/To place pickers, reverse toggle, hours+minutes duration entry, a price table over every active vehicle type), `AdminVansPage`'s vehicle-type field now a dropdown sourced from the live vehicle-types list.

**1E** (public UI) — `RoutePicker` now selects a `{routeId, direction}` pair (a reversible route renders both legs with swapped labels but the same `routeId` — never a fabricated second route), `VehicleOptionCard` takes `vehicleTypeId`/`vehicleTypeName` instead of a `'van'|'suv'` literal, `TransferGuestDetailsForm` takes `requiresFlightDetails`, `TransferBookingPage` rebuilt around a dynamic `trpc.useQueries` fan-out (one quote per offered vehicle type) with a guest-facing "not available" state when a route offers zero types.

**1D/1E combined review** (before commit) — re-verified both headline mutation-proofs live, sampled and mutation-tested several more tests in each diff, and found and fixed one real bug: `TransferPlaceCombobox`'s inline-create error path rendered a raw Zod issue array on a validation failure instead of routing through the shared `firstValidationMessage()` helper every sibling admin form uses — the exact "raw Zod JSON" trap CLAUDE.md calls out by name, and reachable in practice (the inline input has no `maxLength`, the server caps the name at 120 characters). Fixed and covered by a new regression test.

**1F** (full regression, test-only) — closed the batch's most-deferred gap: the public §4 sellability AND-gate (priced AND sellable) had never actually been exercised, because every existing scenario ran against a permanently-sellable fixture van, so the AND always degenerated to "priced." Added a test with a real, newly-seeded sellable van (cleaned up in `afterAll` — `vans` is a `LEAK_TABLES` table). Also added: an MPV-shaped "priced on one route only" scenario, the symmetric FROM-place-deactivated case for the public list, router-level `reverseEnabled: false` refusal/acceptance, both price-snapshot shapes for `transferSnapshotVehicleTypeLabel` (which had zero callers and zero tests until now), and the zero-offered-vehicle-types render path. No production file changed; no existing assertion weakened.

**1G** (demo seed data) — the owner's exact demo catalog (Van 12/8, SUV 4/4, MPV 6/4; Mactan-Cebu International Airport + Cebu City/Moalboal/Oslob/Hagnaya Port; 4 routes, all from the airport, `reverseEnabled: true`, `freeCancelHours: 24`; MPV priced on Cebu City's route only, deliberately demonstrating that a route need not offer every type), written through `upsertTransferRoute` (the one writer) so its completeness contract does the MPV-sparsity work rather than a second hand-rolled insert. Two new demo vans (`DEMO-SUV-01`, `DEMO-MPV-01`) added rather than relabelling the existing four, so model names stay honest. All of it gated `context === 'app'` — `seedBase` and `rg_travel_test` get none of it. Two small fixes made during review (both the implementer's oversight, not deliberate): the T26 doc note had been inserted mid-table, breaking the markdown table's rendering for three rows after it — moved below the table; the new test's second `describe` block used a bare `describe` instead of the codebase's `describeWithDb()` MySQL-reachability guard — swapped, so it skips cleanly rather than throwing when no database is configured.

## Rulings made this batch (controller decisions on your behalf — read these)

1. **1A/1B's commits are "reviewable units, not independently-verifiable ones"; only 1C's commit is required to typecheck/test/lint cleanly on its own, and the full repo-wide `pnpm typecheck`/build do not have to pass again until 1E's commit.** Drizzle generates TypeScript types directly from `schema.ts`, so a renamed/retyped column breaks every direct consumer across `shared/`, `server/`, and `client/` simultaneously — there is no commit boundary between 1A and 1E at which the whole repo can genuinely compile, short of landing all of 1A–1E as one giant commit, which the task structure (separate reviewers per task) rules out. This was confirmed with the advisor before 1A started, then the exact gate-timing wording was found self-contradictory by 1C's own reviewer (it had accidentally implied 1C's commit never clears its own gate) and corrected in the design note before 1C was reported done. Cost if wrong: re-deriving which commit's gate means what, isolated to the design note's §0.
2. **1D and 1E were dispatched and reviewed in parallel, not sequentially**, on the advisor's explicit confirmation once 1C's shared types were frozen: their file sets are disjoint (`pages/admin/*` vs `pages/public/*` + `components/transfer/*`), and neither needed the other's output. Cost if wrong: none observed — `git status` confirmed zero file overlap between the two agents' diffs when both returned.
3. **The "price-card completeness contract" only ever has to be complete over ACTIVE vehicle types, not every id that ever existed.** This was not stated precisely enough in the original design note, and the gap it left (a route save silently wiping a deactivated type's stray price) was caught by the 1D/1E reviewer's own close reading before it ever reached a committed bug — see the server fix above. The existing, intentional "omit an active type's key, drop its price" rule (owner decision 4, tested since 1C) is unchanged; only the inactive-type case was fixed. Cost if wrong: reverting one `WHERE` clause in `upsert-route.ts`, with the existing test suite immediately failing loudly either way (one test pins each direction).
4. **"One combined Sonnet review for 1D, 1E, 1F and 1G" was read as "use Sonnet reviewers rather than dedicated Opus for this trailing batch," not literally "exactly one review event covering all four tasks at once."** This was the controller's own call, made after 1D+1E had already been reviewed and committed on that reading — confirmed with the advisor only in retrospect, not before proceeding. Each of 1D+1E, 1F, and 1G ended up with its own review-and-commit cycle rather than waiting for all four to land before any review started. Cost if wrong: re-reading the four tasks together retroactively, which would find nothing new, since each was already independently verified.
5. **1F's and 1G's own confirmatory test runs were not trusted at face value — both were independently re-verified against a clean, uncontested run before committing**, because this session hit the shared-test-database concurrency hazard described below twice. Cost if wrong: none — every independent re-run matched the implementing agent's reported counts exactly, in both cases.

## Open owner questions

1. **(Carried from the design note's own §6, unresolved — flagged before 1B started coding, never answered)** With `reverseEnabled` true on route (A→B), nothing in this design stops an admin from ALSO separately creating route (B→A) — the identical journey listed twice, possibly at different prices, since `UNIQUE(from_place_id, to_place_id)` treats them as different rows. Decide: refuse creating the reverse pair outright when a `reverseEnabled` route already covers it, or leave it as an admin-trusted judgment call (routes are owner-only)?
2. **(Carried from the same §6, unresolved)** Is the "flight fields required when either end of the route is an airport place" rule (owner decision 5, built in 1B/1F) actually wanted at launch? It refuses some one-way transfer requests that are bookable TODAY under the pre-batch system (flight fields are currently always optional on a one-way trip) — confirm this is an intended tightening, not an unintended regression introduced while answering decision 5.
3. **(New)** The public `vehicleTypes.list` procedure (added in 1C) is unused by the public booking UI — 1E's implementer made the correct call to skip it, since every vehicle type a guest needs is already resolved onto `transferRoutes.list`'s `vehiclePrices`. It's a dead surface today, left in place rather than removed. Decide: keep it (a plausible future use — a standalone "what vehicles do you have" page?) or remove it.
4. **(Carried, unanswered since Handover 4)** BUG-122 — two public procedures (`checkout.availability`, `reviews.forTour`) resolve a tour slug independently of `show_tours` and leak whether a specific tour exists while it's off. Needs an owner ruling on scope before a fix is built (see `docs/BUGS_LOG.md`).
5. **(Carried, unanswered since Handover 3/4)** Day-use overrun legal/content gap, and "Operated by R&G Travel & Tours" regulatory language for transfers (plan's Legal & content to-dos #4 and #6).

## Assumptions carried into this batch (flag if any are wrong)

- The demo price table, place names, vehicle-type defaults, and fleet composition (1G) are reproduced exactly from the owner's own given figures — not invented, not adapted from a competitor. They are explicitly placeholder/demo values per owner decision 7 and must be replaced in admin before launch.
- `transfer_places.destination_id` was left `null` for every 1G demo place, including "Cebu City" (which coincidentally shares a name with an existing tour destination) — the field is informational-only per owner decision 1, and linking it wasn't asked for. Cheap to set later if wanted.
- 1D's new demo-independent judgment calls (not spec-given, all low-stakes, all stated in-code): a new route defaults `reverseEnabled: true`; an inactive vehicle type is invisible to the route price form entirely (consistent with the design note's explicit instruction); a van already pointed at a since-deactivated type shows it as a labelled "(inactive)" extra dropdown option so editing the van's other fields isn't blocked.

## Known gaps / parked findings (none block anything; read before the next batch touches these areas)

- **(1F, parked, not a defect)** No test exists for the public booking page's "route offers zero vehicle types" render path being reached via a REAL route from the server rather than a mocked response — the client-side render was confirmed safe and is now tested with a mock, but nothing exercises it end-to-end through an actual zero-priced-or-unsellable route. Low priority; the mechanism (`vehicleOptions.length === 0`) is simple and already covered.
- **(Process note, this session, not a product defect)** The shared `rg_travel_test` database tolerates exactly ONE `vitest run` process at a time. Running two concurrently (which happened three times this session — twice by dispatched agents' own confirmatory runs, once by the controller's independent verification racing an agent's still-running test) produces a spurious "N rows leaked" teardown failure that has nothing to do with the code under test and clears the moment only one process is running. This rule isn't written down in CLAUDE.md today and should be, so the next batch doesn't lose time re-diagnosing it as a real regression.
- **(Found during 1G's verification, unrelated to this batch, not fixed per CLAUDE.md's "list it, don't fix it")** `rg_travel_test` currently carries 4 stray `users` rows named "Reset Fixture"/"Reset Inactive Fixture", `created_at` 2026-11-05 — two days before this entire batch started, so not introduced here. Likely residue from an incompletely-cleaned-up password-reset test run in an earlier session. `users` IS one of `global-setup.ts`'s `LEAK_TABLES`, but the leak detector counts its baseline AFTER seeding, at the start of each run — so these 4 rows have been silently absorbed into every run's baseline since 2026-11-05, and the detector is currently blind to them rather than tolerant of them. Worth a deliberate cleanup pass (delete them directly, confirm the count drops to whatever the real baseline should be) next time anyone is in `rg_travel_test` directly — until then, any FUTURE leak of exactly these rows' shape would also go undetected.
- **(Carried from Handover 4, still open)** BUG-123 — a driver whose phone is stored in `09...` form would have it silently rewritten to `+63...` form on any unrelated admin edit. Confirmed latent, not currently live (no reachable write path produces `09...` form today). Still open, still minor.

## Migrations owed on the server

**0015 through 0024, in order.** 0015–0022 carried unchanged from Handover 4. **0023 and 0024 are new this batch** (1A):

| #    | What                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0023 | Additive stage: `vehicle_types`/`transfer_places` tables created; 6 new nullable/defaulted columns added across `transfer_routes`/`transfer_route_vehicle_prices`/`vans`/`bookings`; existing van/suv/route/price/booking data backfilled by natural key (never a literal id).                                                                                                                                               |
| 0024 | Subtractive stage: old `destinationId`/enum columns dropped, the `bookings_product_type_shape` CHECK rewritten, the `transfer_routes_from_to_unique` constraint added. Two real FK-ordering bugs in drizzle-kit's raw generated output were hand-corrected (a `DROP FOREIGN KEY` before its backing `DROP INDEX`/`DROP PRIMARY KEY` in each case) — both were predicted by the 0A design reviewer before they were ever hit. |

Both migrations were verified end-to-end via statement-by-statement replay against a scratch copy of local `rg_travel`, then applied for real via the official `pnpm --filter @rg/server db:migrate` command (exit 0; tracked as ids 23/24/25 in `__drizzle_migrations`).

**After applying these, re-run `pnpm --filter @rg/server db:seed`** (the insert-only base seed) — no new `seedBase` rows were added this batch, so this step is routine rather than load-bearing, unlike Handover 4's `show_tours` row. The demo transfer catalog (1G) is `seedDemo`-only; see the next section for the exact command and its warning.

## Test counts

Full suite at the batch's final state (`c3a81bc`), independently re-run by the controller from a clean, uncontested state (not only trusted from any agent's report — this session hit the shared-database concurrency hazard twice, so every number below was reproduced a second time before being recorded):

- shared: 8 files, 99 tests
- client: 77 files, 980 tests
- server: 128 files, 2610 tests
- **Total: 213 files, 3689 tests, all green.**

All five checks pass at this exact commit: `pnpm lint`, `pnpm typecheck` (all three packages, repo-wide — clean for the first time since 1C, now that 1D/1E have updated every client consumer), `pnpm test`, `pnpm format:check`, `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

## Viewing it locally

Dev server assumed running on 5180/3100 per the batch's own instructions (not started/restarted by this batch). **Demo data is not loaded yet** — these screens will show empty lists/no routes until the owner runs the command below.

- Admin Vehicle types: `http://localhost:5180/admin/vehicle-types`
- Admin Places: `http://localhost:5180/admin/transfer-places`
- Admin Transfer routes: `http://localhost:5180/admin/transfer-routes`
- Public booking flow: `http://localhost:5180/transfer`

## Loading the demo data (owner action — not run by this batch)

Windows `cmd` syntax, from the repo root:

```
set ALLOW_DEMO_SEED=1 && pnpm --filter @rg/server db:seed:demo
```

**Warning: this command also re-upserts the existing demo tours, packages, and reviews** (it is the same `seedDemo` function that has always owned that content — this batch only added the transfer catalog to the same function, under the same `context === 'app'` gate). It is dev-only, upsert-by-natural-key, and refuses outright if `NODE_ENV=production`. It does not touch `seedBase`'s content (owner, destinations, settings) at all.

## Unrelated bugs found

None newly introduced by this batch's own tests. Carried forward and unresolved from before this batch: BUG-122 (needs an owner ruling — see Open Owner Question 4 above) and BUG-123 (latent, minor). One new non-bug finding logged above under "Known gaps": the pre-existing stray `users` rows in `rg_travel_test`, which predate this session.

---

**Next task: T17** (`inquiries` schema extension — per the transfers-launch plan's Batch 5, which also starts the new `transferQuoting` role boundary in T19). **Batch 5 is explicitly NOT started**, per this batch's own controller prompt. Re-brief against current code before dispatching, same discipline as every prior batch — in particular, confirm BUG-122 has an owner answer before T19's new role boundary work begins, since T19 is exactly the kind of task where "who can see what about a tour" matters again. Before any of that, this batch's own two unresolved owner questions above (reverse-pair duplicate routes; whether the flight-fields tightening is wanted) should also get an answer, since they describe real, already-shipped behavior rather than a future task's design choice.
