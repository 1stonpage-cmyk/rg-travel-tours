# Transfers Launch — Handover 2, 2026-11-03 (Batch 3)

**Status: Pre-tasks 0A/0B/0C done, T9/T10 done, T11 implemented but its fix round was interrupted mid-way (user paused to save credit) — NOT yet reviewed clean. Not pushed. Next step: finish T11's fix round, then T12.**

Plan: `docs/superpowers/plans/2026-10-31-transfers-launch.md`. `main` was `origin/main` at `cb527b3` (T1–T8 + prior handover) when this batch started. This session ran pre-tasks 0A/0B/0C, then T9, T10, T11 in order via `superpowers:subagent-driven-development`.

## Commits, this batch

| Task | Commit | Label |
| ---- | ------ | ----- |
| 0B | `4d7befc` | docs(transfers): record 2026-11-03 owner decisions in the plan (0B) |
| 0A | `4b9ce07` | fix(settings): fall back to owner defaults for a missing/malformed transfer_operations row (pre-task 0A) |
| 0C | `a0ce37d` | feat(transfers): soft, overridable vehicle seat+luggage check at transfer dispatch (0C) |
| 0C fix 1 | `960caf3` | fix(transfers): prove and align step 6b's service-layer override re-check (0C review F1) |
| T9 | `b500915` | feat(transfers): transfer pricing, checkout.quoteTransfer and the public route list (T9) |
| T9 fix 1 | `603ed9e` | fix(transfers): quote a retired destination's route no more, and really pin the list order (T9 review) |
| T10 | `f190fa9` | feat(transfers): createTransferBooking — the one shared booking-writer (T10) |
| T10 fix 1 | `5e50697` | test(bookings): pin the price-snapshot union's disjointness (T10 review fix) |
| **T11** | **`98fbe1c`** | **feat(transfers): checkout.createHoldTransfer — the guest-facing hold (T11)** |

**T11's fix round is UNCOMMITTED, in the working tree, interrupted mid-way:**

```
 M server/src/__tests__/checkout-create-hold-transfer.test.ts
 M shared/src/transfers-checkout.ts
 M shared/src/transfers.ts
```

This is the regex-guard fix for a reviewed Important finding (see "T11, what's left" below) — do NOT discard it (`git checkout .` / `git clean` / `git stash` would destroy real work). Finish it, verify, commit, then re-review per the loop below.

Nothing in this batch has been pushed. `git log --oneline -3` on `main` currently shows `98fbe1c` then `5e50697` then `f190fa9`.

## What each task built

**Pre-task 0A** — `transfer_operations` settings fallback. A missing/malformed settings row used to 500 every tour quote AND hold (not just transfer ones), because `assessCapacity`'s driver-pool term reads it unconditionally. Fixed with a narrow, deliberate exception to this project's "settings fail loudly" rule, scoped to this one block only: `TRANSFER_OPERATIONS_DEFAULTS` (byte-identical to the seed), a `resolveTransferOperations()` resolver handling missing/partial/fully-invalid rows, and two new readers (`readTransferOperationsSettings`/`readTransferOperationsSettingsTx`) that never throw. Review: 0 Critical, 0 Important, 1 Minor (parked — a row with one wrong-TYPED field falls back to full defaults rather than keeping its other valid fields; confirmed intentional per the brief's own design).

**Pre-task 0B** — recorded two 2026-11-03 owner decisions directly in the plan file: the T7 frozen-route-duration fix is confirmed as the right call (not just a reactive patch), and the vehicle seat/luggage check at dispatch is a soft check with override (answering the prior handover's open QUESTIONS #1).

**Pre-task 0C** — soft, overridable vehicle seat+luggage check at transfer dispatch assignment. New `vans.luggage_capacity` column (migration **0021**, nullable — NULL means "not yet recorded," skips the luggage half of the check). `assignVanAndDriver`'s step 6b: a transfer assignment that's short on seats or luggage is refused (`vehicle_too_small`) unless `override: true` + a 5+ character reason is sent — enforced server-side (Zod `.refine()` AND a service-layer re-check, both now proven, after one fix round), one audit row carrying the actual numbers. Client: `AssignPanel.tsx` shows an amber warning with the live numbers. No new `ROLE_MATRIX` area. Review: 0 Critical, 2 Important (1 fixed — the service-layer re-check was untested and had a looser threshold than Zod, now backed by a shared `OVERRIDE_REASON_MIN_LENGTH` constant; 1 ruled out-of-scope — `admin.calendar.dayOptions` is still tour-shaped for transfers, pre-existing since T8, carried forward as a flagged follow-up, not a defect in this diff), 3 Minor parked.

**T9** — `services/transfers/pricing.ts` (`quoteTransfer()` — a FLAT per-vehicle rate, no `pax` parameter at all, pinned by a `@ts-expect-error`; `vehiclePriceForRouteAndType()`), `checkout.quoteTransfer`, and a new public `transferRoutes.list` endpoint (closing a plan File-Structure gap nobody's task explicitly claimed — see "Rulings" below). Reuses `trust.depositPercent` (no second deposit setting), the same ₱100/₱0 gateway floor, no `quoteId`/digest (price is always re-derived from the catalog, never trusted from a client). Review: 0 Critical, 2 Important (1 fixed — the public list and the pricing lookup disagreed about a retired DESTINATION, now both check it; 1 ruled — `vehiclePriceForRouteAndType`'s `tx` handle is the last, defaulted parameter rather than first-and-required, left as shipped with the requirement to pass it explicitly written into T10's own brief instead of reopening T9), 3 Minor parked.

**T10** — `server/src/services/transfers/create-booking.ts`, `createTransferBooking()` — the ONE function both the guest path (T11) and the future staff path (T19) call. The plan's own "other half" of its highest-scrutiny pairing with T7. `takeFleetDateLock` first, no plain read before it (proven by a mutation that reddened both concurrency races). `routeId` XOR `customRouteDescription` enforced as the one writer. A plain (non-discriminated) `z.union` price-snapshot design — a deliberate, reviewed deviation from the brief, verified sound. Review: 0 Critical, 1 Important (fixed — pinned the union's disjointness with a regression test, since that property was true but unasserted), 6 Minor parked (carried forward notes for T11/T19: an empty `customRouteDescription` slips past the XOR; a past-pickup gets no distinguishable error from a too-short-notice one; no direct test of the staff-price floor; a test-teardown leak risk; audit CSV-escaping awareness; minor wording/double-read nits).

**T11** — `checkout.createHoldTransfer`, the thin guest-facing wrapper over T10, plus the FULL guest-facing hold input (absorbing T12's "hold" half — see "Rulings" below) in a new file `shared/src/transfers-checkout.ts` (not `transfers.ts`, to avoid a real import cycle `transfers.ts → booking.ts → checkout.ts → booking.ts`, verified by the reviewer). Beyond the brief: `checkout.createHoldTransfer` now shares ONE combined per-IP rate-limit budget (5 holds/15 min) with tours' `createHold` — verified as a real shared mechanism and judged correct (Ruling 5 caps hold *creations*, product-blind). **Review: 0 Critical, 1 Important, 2 Minor — the fix round for the Important finding was interrupted by the pause and is sitting uncommitted (see above).**

### T11, what's left (the in-progress fix)

A malformed `pickupTime` on a day-use request (e.g. `'8:00'` instead of `'08:00'`) falsely marks a VALID `dayUseEndTime` as invalid too — the day-use `superRefine` branch compares the two clock strings lexicographically on the stated assumption both are already zero-padded, which Zod 4 does not guarantee holds at that point (object-level refinements still run after a field-level check has already failed). Reproduced: `pickupTime: '8:00'` / `dayUseEndTime: '17:00'` (a valid 9-hour window) produces two errors, one correct, one false. No money/security impact. Fix dispatched: gate the comparison on `pickupTime` actually passing the clock regex first, plus a regression test. **This is the uncommitted work in the tree right now** — finish it, run the five checks, commit, then dispatch one scoped re-review before marking T11 complete.

## Migrations owed on the server

**0015 through 0021**, in order — none applied anywhere but local `rg_travel`/`rg_travel_test` (0015–0020 were already owed per the prior handover; **0021 is new this batch**):

| # | What |
| - | ---- |
| 0015–0020 | (unchanged from the prior handover — vans.vehicle_type; transfer_routes/prices; bookings product_type/route_id/vehicle_type_requested + CHECK + booking_transfer_details; CHECK correction; drivers.max_transfer_jobs_per_day; booking_transfer_details.route_duration_minutes_used) |
| **0021** | **`vans.luggage_capacity`** (nullable int, no default) — pre-task 0C |

**After applying these, re-run `pnpm --filter @rg/server db:seed`** (the insert-only base seed) — unchanged advice from the prior handover, still true.

## Rulings I made (controller decisions on your behalf — read these)

1. **T9 absorbed a plan gap: the public `transferRoutes.list` endpoint.** The plan's own File Structure table names `server/src/routers/public/transfers.ts` with `transferRoutes.list (public)` as a deliverable, but no task row explicitly claims building it. Ruled: T9 builds it, since `checkout.quoteTransfer` needs a real way for a guest to have obtained a valid `routeId` in the first place, and no other task in this batch's range was positioned to do it. Cost if wrong: purely a documentation/sequencing question — the endpoint itself is correct and tested either way.
2. **T9/T11 absorbed T12's "quote" and "hold" Zod inputs respectively**, because T12 ("shared Zod inputs for quote/hold") is a LATER task in the plan's own order but T9 and T11 cannot be built without real input schemas, and T10's own doc comment explicitly names T11 as the thing that builds the hold input. Cost if wrong: none functionally — T12, when it runs, now has a much smaller remaining scope (whatever friendly-message polish or UI-only concerns are left) and must be re-briefed against what's already built rather than its original plan-text description, or it will duplicate work.
3. **0C's "dayOptions is still tour-shaped for transfers" finding — ruled out of scope for 0C, carried forward as a flagged follow-up**, not fixed in this batch. It predates 0C (confirmed since T8) and is a real, separate gap: the admin assignment dropdown doesn't yet show transfer-window-aware or type-filtered options. Should be closed before — or as part of — whichever later task makes a transfer dispatchable through the real UI. Cost if wrong (i.e., if this should have blocked 0C): none — the server-side enforcement 0C built is correct regardless of what the dropdown shows today.
4. **T9's `vehiclePriceForRouteAndType` keeps its `tx`-last, defaulted parameter signature** rather than being reopened to flip it to handle-first-and-required (the house convention almost everywhere else in this codebase). Ruled: document the requirement explicitly in T10's own brief instead (which was done, and T10's implementer followed it correctly, verified by the reviewer) rather than reopen a clean, reviewed task for a style preference. Cost if wrong: if some future caller forgets to pass the handle explicitly inside its own transaction, it silently checks out an extra pool connection under concurrency — a real but narrow risk, and one each new caller's own concurrency tests should catch before merge, the same way T10's did.
5. **Hold caps are shared between tours and transfers** (`assertUnderHoldCaps`, reused unchanged in T10) — one pool of `MAX_ACTIVE_HOLDS_PER_GUEST` (2) per guest regardless of product type. Not an explicit plan decision; the natural, zero-new-code reading, and T10's own test suite PROVES the sharing (one tour hold + one transfer hold, a third of either type refused) rather than just assuming it. Cost if wrong: if the owner wants separate pools, this is a small, isolated change (a `productType` filter added to one query) with its own test to flip.
6. **`checkout.createHoldTransfer` shares ONE rate-limit budget with `checkout.createHold`** (5 combined hold-creations per IP per 15 minutes), not its own independent budget. T11's own implementer made this call beyond the brief; the reviewer verified it's a real shared mechanism and endorsed it, citing this codebase's own existing comment that "Ruling 5 is about holds, not about tours." Residual, stated plainly: a client who burns 5 tour holds cannot make a transfer hold for 15 minutes, and an office/hotel NAT shares the budget (the same residual already documented elsewhere in this codebase for the driver-login limiter). Cost if wrong: a legitimate guest occasionally rate-limited sooner than they'd expect — recoverable by waiting, and a one-line change (give transfers their own entry in a second limiter) if the owner wants it split.

## Assumptions (not owner decisions, flag if any are wrong)

1. **0A's fallback defaults are the seed's own values**, not invented — but the choice to build a resilient-reading exception AT ALL (rather than, say, making `db:seed` a harder prerequisite documented more loudly) was the batch prompt's own explicit ask, not something this session chose independently.
2. **T9's "no `quoteId`" design** (a transfer hold always re-derives its price from the catalog rather than trusting a client-echoed digest) was reasoned by the T9 implementer and independently verified sound by two separate dedicated reviewers (T9's own, and T10's, which re-confirmed nothing downstream ever trusts a client-sent total). No owner decision is on record approving this specific departure from the tour pattern, though it is arguably SAFER than the tour's own digest mechanism.
3. **T10's price-snapshot union is a plain (non-discriminated) union**, not the discriminated one the brief asked for — independently verified safe (the two schemas share no required-field overlap that could cross-match) and now pinned by a regression test. No owner decision exists on this specific schema-design question; it is a sound engineering call, not a product decision.

## Unrelated bugs found

**None new this batch.** The one pre-existing, unrelated item carried forward from the start of this batch — `pnpm format:check` fails on `docs/superpowers/plans/2026-11-03-transfers-HANDOVER.md` (the PRIOR handover doc, confirmed pre-existing since its own commit `cb527b3`, before this batch began) — is still unfixed, still logged, still not blocking anything. It would take one `prettier --write` in its own formatting-only commit.

## Open owner questions (carried forward or new this batch)

1. **(Carried, unanswered) T6's cross-batch sequencing note:** notification-copy sweep (T24) should land before a real transfer booking becomes guest-reachable, so a transfer guest doesn't get tour-flavored email copy ("Your tour is tomorrow"). T9/T10/T11 have now made real transfer bookings reachable (once T11's fix lands) — **this note is now live, not theoretical.** Worth prioritizing T24 relatively soon after this batch, or accepting tour-flavored copy for a window.
2. **(Carried, unanswered) T7's duration-freeze column:** confirmed correct by the owner in pre-task 0B (ruling #1 above settles this one — no longer open).
3. **(New) Should a transfer route be sellable when its DESTINATION is inactive but the route itself is active?** T9's fix made the two surfaces (public list, price lookup) AGREE with each other, but both now hide a route the moment its destination goes inactive — which may be wrong for a destination the business runs no TOUR to anymore but still wants to sell airport transfers for. Flagged by T9's reviewer as a real product question, not settled here.
4. **(New) Rate-limit sharing (ruling #6 above):** confirm the owner is fine with transfers and tours sharing one hold-creation budget rather than getting independent ones.

## Test counts

Full suite as of the last fully-committed state (`98fbe1c`, before the uncommitted, in-progress T11 fix): shared 93, client 888, server 2428 — all green. (The in-progress fix adds tests on top of this; exact final count pending its completion.)

---

**Next task: finish T11's fix round** (regex guard in `shared/src/transfers-checkout.ts`'s day-use `superRefine`, already dispatched and partially done in the uncommitted working tree), re-run the five checks, commit, dispatch one scoped re-review, mark T11 complete in the SDD ledger, then proceed to **T12** (`shared/src/transfers.ts` — whatever's left of "Zod inputs for quote/hold" after T9/T11 already built the real ones; re-brief against what exists before dispatching, don't re-read the original plan text as if nothing has changed).
