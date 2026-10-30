# Week 7 — handover, paused after batch 3 (Task 9)

**Paused by the owner on 2026-10-24**, mid-week, with everything committed
and the working tree clean. Nothing is half-finished: the pause landed
between tasks, not inside one.

This file lives in `docs/` on purpose. The task workspace
(`.superpowers/sdd/2026-10-23-week7/`) is **git-ignored**, so a
`git clean -fdx` destroys it; everything you need to resume without it is
written down here. (The ledger itself — `progress.md`, 210 lines — is still
there as of this writing and is the fuller record; read it first if it
exists before trusting this file's summary of it.)

---

## 1. Where things stand

**Local `main` is at `e02c41f`.** Clean tree, nothing uncommitted.

**`origin/main` is far behind — at `5bb904e`, before this entire plan was
even written.** Nothing from Week 7 has been pushed, by instruction, every
batch so far. Do not assume `origin` reflects local reality, and do not push
without being asked.

The plan is `docs/superpowers/plans/2026-10-23-week7.md` — complete,
owner-approved, 21 tasks (plus the follow-up Task 5b). **Do not rewrite it**;
append to its "Execution status" section and to each task's own section the
way the first nine were closed out, if you want the plan to stay the single
source of truth.

### Done — batches 1, 2, 3 (Tasks 1–9, plus 5b)

| Task                        | Commit(s)             | Review                                                                  |
| --------------------------- | --------------------- | ----------------------------------------------------------------------- |
| 1 — tour catalog            | `e1cf5b0`             | combined, clean                                                         |
| 2 — tour detail + SEO       | `1039b40`             | combined, clean                                                         |
| 3 — package detail + SEO    | `548365c`             | combined, clean                                                         |
| 4 — receipt access role fix | `f3629a8` + `a852bc7` | dedicated Opus, 1 Important fixed                                       |
| 5 — driver lockout backoff  | `9ac4209` + `626c5ba` | dedicated Opus, 1 Important fixed                                       |
| 5b — the Unlock UI          | `2df5502` + `ffc08f8` | dedicated Opus, 1 Important fixed                                       |
| 6 — admin tours (server)    | `81baa45` + `c1514a1` | dedicated Opus, **1 Critical** + 1 Important fixed, re-reproduced clean |
| 7 — admin tours (client)    | `5eb2ff4`             | combined, clean                                                         |
| 8 — coupons admin           | `7d78ad8`             | dedicated Opus, approved **with no fix round**                          |
| 9 — settings admin          | `159d4b2`             | dedicated Opus, clean                                                   |

Each task's commit(s) are between the plan-doc commits that log them
(`4199e5e`, `41aa57c`, `e02c41f`, etc.) — `git log --oneline 5bb904e..HEAD`
shows the whole chain if you want it without the ledger.

**Five checks, re-run independently by the controller at multiple points in
this batch, not just reported by a subagent** — most recently on `159d4b2`:
`lint` 0 · `typecheck` 0 · `test` 0 (2656 tests, 159 files) · `format:check`
0 · `ALLOW_PLACEHOLDER_BUILD=1 build` 0. Leak detector silent throughout.

**No migration is owed from Weeks 7 batches 1–3.** `0013` remains the only
one owed on the server database (pre-Week-7). The next migration in the
plan is Task 17's (`0014`, the FK on three `tour_*` child tables) — when it
is generated, remind the owner to apply it to the server database.

### Not started

**Tasks 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21.** (Task 18, motion
polish, is deferred to Week 8 by owner decision — do not build it, do not
renumber it, leave it in the plan as a marker for the next week's plan.)

---

## 2. How to resume — the exact instruction

Use `superpowers:subagent-driven-development`. **Resume at Task 10.** It has
no blocking owner question — Q4 and Q5 (the driver-rating source and the
review-request timing) are already answered in the plan's Global
Constraints section, dated 2026-10-23.

Per task, in order:

1. `bash <skill>/scripts/task-brief docs/superpowers/plans/2026-10-23-week7.md N`
   — writes `task-N-brief.md` into `.superpowers/sdd/2026-10-23-week7/`
   (the script also handles `5b`-style suffixed task numbers, confirmed
   working this batch).
2. **Research the brief's claims against the real code before dispatching.**
   Every task in this batch needed at least one correction — exact field
   names that had drifted, a component the brief assumed had a feature it
   doesn't (`EntityForm`'s nonexistent accordion), a foreign key the brief's
   author didn't know about. Read the actual files the task touches, not
   just the brief's prose, and fold corrections into the dispatch so the
   implementer isn't the one discovering them mid-task.
3. Record BASE: `git rev-parse HEAD`.
4. Dispatch **one** implementer (never two in parallel — the skill's rule,
   and this batch obeyed it strictly even when two tasks touched the same
   shared file like `_app.ts`/`admin-nav.ts`, which caused zero conflicts
   because dispatch was sequential). Give it the brief path, the
   corrections, interfaces from earlier tasks it needs to know, and a
   report-file path (`task-N-report.md`, same directory). Tell it: no
   subagents of its own, never `git commit --amend`, five checks each run
   separately with exit codes, every new test proven able to fail by
   mutation, the leak detector must stay silent.
5. **Review level, per the owner's standing instruction this whole week:**
   any task touching money, auth, roles or receipts gets its **own**
   dedicated reviewer subagent on the **opus** model. Everything else gets
   one lightweight combined review. By that rule: **Task 10 (reviews,
   `reviewsModeration` role gate) and Task 12 (reports, reads real money)
   get dedicated Opus reviews.** Task 11 (client reviews UI) and Task 16
   (staff name) are good combined-review candidates. Task 13 and 14 add a
   new `ROLE_MATRIX` row / send real email — judge case by case, but lean
   dedicated for anything that moves a role boundary or an external side
   effect.
6. `bash <skill>/scripts/review-package <plan> <BASE> <HEAD>` and dispatch
   the reviewer with that diff path, the brief, and a global-constraints
   block copied from the plan (money rules, role rules, no-red, mobile-first,
   leak detector) — not just "use your judgment."
7. **Fix loop:** Critical or Important findings trigger a fix round,
   resuming the same implementer, scoped tightly to the finding (see
   section 4 — do not let a fix round grow into new scope without a
   separate ruling). Minor findings go straight to the ledger as deferred,
   never into the loop. A reviewer that writes "Approved" and explicitly
   says no fix round is needed, even while labeling one item "Important,"
   should be taken at that word (Task 8, this batch) rather than
   mechanically forcing a round because of the label alone — read its full
   reasoning, not just the section heading.
8. Append to the ledger (`.superpowers/sdd/2026-10-23-week7/progress.md`)
   and to the plan file's "Execution status" section and the task's own
   "Shipped as ..." note. Write **✅ DONE (Task N)**.

Do not end the turn between tasks unless genuinely stuck or the batch's own
instruction says to stop at a specific task. Stop only for a STOP-AND-ASK
condition (money/payment logic the plan doesn't describe, roles the plan
hasn't decided, production/VPS/Kong PMS) or at the batch boundary the owner
actually gave.

---

## 3. The ledger is the recovery map, not this file

`.superpowers/sdd/2026-10-23-week7/progress.md` has a full entry per task:
what was dispatched, every finding, every ruling, every deferred item, with
reasoning. This file is a compressed pointer to it. If the ledger exists,
read it before trusting this summary of it — it has detail this file
deliberately drops (exact test names, exact line numbers, the full text of
every reviewer's reasoning).

If the ledger is gone (e.g. `git clean -fdx` ran), rebuild its header from
this file (`# SDD ledger — plan: docs/superpowers/plans/2026-10-23-week7.md`)
and resume with `git log --oneline 5bb904e..HEAD` plus the plan file's own
"Shipped as ..." notes under each completed task — those notes were written
specifically so the plan file alone could reconstruct what happened if the
ledger were lost.

---

## 4. Rulings this batch made that bind the rest of the week

These are not reopenable by a future implementer without a new ruling or an
owner decision:

1. **Task 6: `tour_price_tiers`/`tour_images` stay wholesale-replaced
   (delete-then-reinsert); `tour_itinerary_stops`/`tour_addons` are
   upserted by id, never wholesale-deleted.** The first two have no
   referencing foreign key; the other two are referenced by
   `trip_checkpoints.stop_id` and `booking_addons.addon_id` (RESTRICT), so
   a wholesale delete 500s the moment real history exists. A dropped
   add-on deactivates (`isActive: false`); a dropped stop with check-in
   history refuses the whole save with a named `CONFLICT` error. **Do not
   revert either table to wholesale delete-then-reinsert.**
2. **Task 5/5b: the lockout policy backs off (15→30→60 min) and is never
   terminal.** `LockoutOutcome`/`LockoutState` structurally cannot express
   the old terminal state anymore — reintroducing one needs a type change,
   which will fail `tsc` loudly rather than compile quietly. `locked`
   (403) and `wrong_credentials` (401) stay deliberately distinguishable;
   that was explicitly re-confirmed, not reopened, this batch.
3. **Task 8: coupons add no validation logic beyond what
   `couponDiscountSchema`'s existing CHECK-mirroring union already does.**
   Do not add an `endsAt > startsAt` refinement without an owner decision —
   `validateCoupon` already refuses an inverted window cleanly at
   checkout, so this is a UX question (see section 5), not a correctness
   gap to silently close.
4. **Task 9: `writeSettingBlock` is the only writer of a `settings` row
   outside the seed, and it must call `resetContentUnverifiedCache()`
   after every write to `content_unverified`, after the transaction
   commits.** Do not add a second settings writer without routing it
   through the same function — the cache-invalidation requirement is easy
   to forget in a second code path.
5. **Every client-touching task this batch hit the same missing-owner-session
   browser-check gap**, and every one of them correctly declined to create
   or guess staff credentials to work around it. `.env` has no
   `OWNER_EMAIL`/`OWNER_PASSWORD`; the seed prints "owner: SKIPPED". **Do
   not create one yourself either** — if a live visual check at 360px
   genuinely matters for a future task, ask the owner to sign in, the way
   Task 5's mid-batch check did (and was told to proceed without, since
   this was an unattended run — judge that call fresh each time rather than
   copying it reflexively).
6. **`EntityForm.tsx` has no accordion and only handles flat scalar
   fields.** If a future task's brief assumes it has either (check Task 13
   and 16's briefs — they weren't audited for this), verify against the
   real component before dispatching, the way Task 7's dispatch did.

---

## 5. Open for the owner — batched from the last three reports

Carried forward, unanswered as of this handover:

**From batch 3 (Tasks 5b–9):**

1. **Task 8 — should an inverted coupon window get a warning?** It already
   refuses cleanly at checkout. Open question is only whether the admin
   list should say so in words next to the existing usage-drift sentence.
2. **Should `coupons`/`coupon_redemptions` join `LEAK_TABLES`?** Same
   precedent as Task 6's own `fleet_date_slots` addition.
3. **Priority on five Minor/follow-up items** (Task 8: an audit-rollback
   test using an already-established pattern, a 40-char coupon code
   overflowing at 360px, a discount-type-switch unit foot-gun in the edit
   form; Task 9: the `content_unverified` editor's fail-open vs. its
   reader's fail-closed, a missing `trust`-block round-trip test) — batch
   into Task 17's cleanup, or handle now as small separate commits?

**Carried from earlier batches, still open:**

4. `AdminDriversPage.tsx`'s Unlock button has no `aria-label` for
   multi-locked-driver disambiguation, and focus doesn't move to its
   confirm step — both inherited unchanged from the pre-existing Reset PIN
   pattern, not new. Worth fixing both controls together, or neither?
5. `drivers.resetPin` has no `isActive` filter, unlike the newer
   `drivers.unlock` — a pre-existing asymmetry. Match them?
6. Two orphan `audit_log` rows in `rg_travel_test` from Task 8's own
   mutation-testing pass (entity id `2000000000`, a test sentinel) —
   harmless, structurally unreachable by the suite's own teardown. Worth a
   one-off cleanup query, or let it ride until the next full test-DB reset?

---

## 6. Unrelated bugs found this batch, not fixed

- `server/src/db/seed.ts`'s `upsertItineraryStops` has the **identical**
  unguarded wholesale-delete shape Task 6 just fixed in the admin router —
  against the **dev** `rg_travel` database, which does ship 24 real
  itinerary stops. The first real driver check-in there will break
  `pnpm --filter @rg/server db:seed` the same way Task 6's bug would have
  broken `admin.tours.update`. Not fixed — outside every task's file list
  so far.
- A price-tier row (Task 7, `AdminToursPage.tsx`) and a 40-character coupon
  code (Task 8, `AdminCouponsPage.tsx`) can each wrap awkwardly at exactly
  360px. Cosmetic only — no overflow, no accessibility defect — caught by
  code-level review since the live 360px check was unavailable all batch.

---

## 7. Standing constraints, unchanged

From `CLAUDE.md` and every batch prompt's own DO-NOT list this week:

- **DO NOT** push, deploy, or touch production/the VPS.
- **DO NOT** touch Kong PMS (files, DB, ports 5173/3000/3111, the
  `kongpms` service) or `C:\dev\travelsugbo-explainer`. Only `rg_travel`
  and `rg_travel_test`, kept schema-identical.
- **DO NOT** trust browser money. The server computes all prices, totals,
  deposits and discounts. Centavos only, everywhere.
- **DO NOT** write `bookings.amount_paid_centavos` outside the allow-listed
  functions in `server/src/services/payments/record-payment.ts`.
- **DO NOT** hard-delete tours, bookings, coupons, drivers or payments.
  Every money/status/assignment/unlock change writes `audit_log`.
- **DO NOT** widen any role beyond what the plan's dated owner decisions
  say. **DO NOT** weaken PIN-guessing protection.
- **DO NOT** add npm libraries. **NO RED anywhere**, including test titles.
  No fake numbers or social proof.
- Every new test **proven able to fail** — break it, confirm red, restore.
- Five checks before calling anything done: `lint` · `typecheck` · `test` ·
  `format:check` · `ALLOW_PLACEHOLDER_BUILD=1 build`, each run separately
  with its own reported exit code.
- Clean up every row a test leaves. **The leak detector must stay silent.**
- A schema change needs a Drizzle migration applied to **both** `rg_travel`
  and `rg_travel_test`, confirmed to match, and the server reminded it owes
  one.
- Ports 5180 client / 3100 server, never 5173 or 3000.
- `ui-ux-pro-max` for every UI task; public pages mobile-first at 360px;
  admin follows the existing dark-sidebar look.
- Unrelated bugs: list them (name + one line), don't fix them unless they
  block the current task.
- Report commits as `hash - short human label`. Formatting-only changes
  get their own commit. Never `git commit --amend`.

---

## Found 2026-10-28, mid-session (QR fix investigation, batch 5 paused)

- **`/api/payment-qr` 404s on a correctly-configured QR.** `server/src/routers/payment-qr.ts`'s `QR_NAME` regex expects a bare filename (no `/`), but the live `rg_travel` settings row had `imagePath: "payment-qr/qr.png"` — the subdirectory prefix typed in by hand, when the route already joins `paymentQrStorageDir()` (which resolves to `.../uploads/payment-qr/`) onto `imagePath`. The regex fails before the file is ever looked up, so the route 404s regardless of session state. Stored value should be the bare filename only (e.g. `"qr.png"`).
- **`db:seed` overwrites admin-edited settings — launch blocker.** Running `pnpm --filter @rg/server db:seed` against `rg_travel` reset the `payment_qr` settings block back to its seed defaults (`isConfigured: false`, every field `null`), wiping out a real, manually-entered configuration. Confirmed live: the row changed from configured to seed-default mid-session while Task 17 was testing a `seed.ts` fix. The seed must never unconditionally overwrite a settings row that already has real (non-default) content — this is a launch blocker: a re-seed on the production box would erase anything the owner has configured through Settings.
