# Week 6.5 — handover, paused after Task 2

**Paused by the owner on 2026-10-16**, mid-week, with everything committed and
pushed and the working tree clean. Nothing is half-finished: the pause landed
between tasks, not inside one.

This file lives in `docs/` on purpose. The task workspace
(`.superpowers/sdd/2026-10-16-week65-decisions-and-cleanup/`) is **git-ignored**,
so a `git clean -fdx` destroys it; everything you need to resume without it is
written down here.

---

## 1. Where things stand

**`origin/main` is at `1aa34be`.** Clean tree, nothing unpushed.

Week 6 finished at `9a3fa74`. Everything after that is Week 6.5:

| Commit    | What                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `c9c9871` | docs(week6.5): the plan for seven decisions and seven carry-forwards     |
| `5920bf8` | docs(week6.5): two plan defects found before dispatch, not after         |
| `d91ca14` | **Task 1 (D1)** fix(driver): a completed trip shows what is still owed   |
| `ee3f34e` | style(week6.5): prettier on the plan file                                |
| `d8bec15` | docs(driver): the test file's own header stops overstating rule 1        |
| `fed6501` | **Task 2 (D2)** feat(payments): finance can refuse a cash claim          |
| `996e89f` | **Task 2 (D2)** feat(admin): refusing a cash claim on the booking screen |
| `1aa34be` | test(admin): the refusal-alert test's title stops promising amber        |

**Five checks, re-run on `1aa34be` by the coordinator (not just reported by a
subagent):** `lint` 0 · `typecheck` 0 · `test` 0 · `format:check` 0 ·
`ALLOW_PLACEHOLDER_BUILD=1 build` 0.

**2,144 tests passing, 0 failed, 0 skipped** — server 1,522 (87 files),
client 543, shared 79. Leak detector silent.

**No migration is owed.** Task 2 needed none (see ruling 1 below). The next
migration in the week is Task 6's (`0012`, `booking_notes.visible_to_driver`),
and when it is generated the owner must be reminded to apply it to the server
database.

### Done

- **Task 1 — D1.** A `completed` trip now shows the driver payment box.
  `COLLECTABLE_STATUSES` in `client/src/components/driver/PaymentBox.tsx` is
  the allow-list (five members); `cancelled` and `expired` still show no
  amount. The false sentence — _"This trip is finished. There is nothing to
  collect here"_, printed over ₱4,500 that was owed — is gone.
  Review: SPEC PASS / QUALITY APPROVED, no blocking findings.
- **Task 2 — D2.** Finance or the owner can refuse a cash claim.
  `rejectCashPayment()` in `server/src/services/payments/record-payment.ts`,
  `admin.bookings.rejectCash`, and a per-claim reject control on the admin
  booking screen. The row becomes `rejected` with its reason **in place**; no
  money moves and no booking column is touched; the driver's box returns to
  `collect_cash` so a mistaken tap no longer blocks that booking forever.
  Review: SPEC PASS / QUALITY APPROVED, six non-blocking findings, one fixed.

### Not started

Tasks 3–14: **D3, D4, D5, D6, D7, C1, C2, C3, C4, C5, C6, C7.**

---

## 2. How to resume — the exact instruction

The plan is `docs/superpowers/plans/2026-10-16-week65-decisions-and-cleanup.md`.
It is complete and approved; **do not rewrite it.** Resume at **Task 3 (D3)**.

Use `superpowers:subagent-driven-development`. Per task, in order:

1. `bash <skill>/scripts/task-brief docs/superpowers/plans/2026-10-16-week65-decisions-and-cleanup.md N`
   — writes `task-N-brief.md` into the workspace.
2. Record BASE: `git rev-parse HEAD`.
3. Dispatch ONE implementer (never two in parallel). Hand it three paths and
   nothing else: `CLAUDE.md`, the brief, and **the notes file** (section 3).
   Tell it the notes win over the brief where they disagree, that it must not
   dispatch subagents of its own, that it must not push, and that it must not
   use `git commit --amend`.
4. `bash <skill>/scripts/review-package <plan> <BASE> <HEAD>` and dispatch the
   reviewer with that diff path, the brief, the notes and the report.
   **Use the narrow review contract** (section 5) — not the full five checks.
5. Fix any blocking finding; fix cheap non-blocking ones yourself; log the rest.
6. Coordinator runs the full five checks, commits anything it fixed, pushes.
7. Append to the ledger. Write **✅ DONE — Task N** with commits as
   `hash - short human label`.

Do not end the turn between tasks. Stop only for a STOP-AND-ASK condition
(money, refunds, auth, roles or schema beyond what the plan describes; a new
dependency) or at **✅ WEEK 6.5 COMPLETE**.

### After Task 14

1. Five checks on the committed tree; report each number.
2. Confirm `git status` clean and `git log origin/main..HEAD` empty.
3. **Remind the owner that migration `0012` (Task 6 / D6) is owed on the
   server database.**
4. **Update `docs/BUILD_SPEC.md` lines ~1065 and ~1087–1186** — see section 6.
5. Write **✅ WEEK 6.5 COMPLETE**: what each of the fourteen decisions now
   does, what is still mocked or unproven, and the bugs found and not fixed.
6. **Then** write the Week 7 plan per BUILD_SPEC §13 (`writing-plans`;
   `ui-ux-pro-max` for all UI; questions listed). **PLAN ONLY — stop for the
   owner's approval.**

---

## 3. The dispatch notes — the most valuable thing here

`.superpowers/sdd/2026-10-16-week65-decisions-and-cleanup/task-N-notes.md`
exists for **every task 2–14**. Each one records facts the plan's brief could
not know, verified against the real code on 2026-10-16. They have already
caught the plan being wrong four times in two tasks.

**If that directory is gone, regenerating the notes is the first job of the
resumed session, and it is not optional** — the briefs alone are known to be
wrong about:

- **Task 1:** the test filename (the plan guessed
  `driver-payment-box.test.tsx`; the real file is
  `client/src/__tests__/driver-trip-page.test.tsx`) and a `renderBox` helper
  that does not exist.
- **Task 2:** a `cashRow` predicate that added
  `isNotNull(collectedByDriverId)`, which would have silently narrowed the
  working **approval** path too.
- **Task 4:** see ruling 6 — the brief's tests call a mutation that cannot
  deactivate a driver.
- **Task 10/12:** both edit `server/src/__tests__/global-setup.ts`; 10 runs
  first and 12 must not revert it.

The notes are reconstructable from this file's rulings plus a careful read of
the touched files. Budget for it.

---

## 4. The rulings that bind the rest of the week

All eight are written in full in the plan file's **"Pre-flight rulings
(2026-10-16)"** section. Summarised, because they are not reopenable by an
implementer:

1. **D2 needed no migration and no new enum value.** `PAYMENT_STATUSES`
   already had `rejected`, and `payments.reject_reason` already meant exactly
   this. _Done, and it held._
2. **D2 did not reuse `verifyPendingManualPayment`** — that one moves the
   booking (a receipt rejection sends the guest back to `pending_payment`);
   a cash rejection must move nothing, because the trip already ran.
   _Done, and it held._
3. **D3 REMOVES `driver_inactive` from the shared `DriverLoginRefusal`
   union**, so the compiler proves the wire cannot carry it. The real reason
   goes to `audit_log` as `driver.login_inactive`.
4. **D5 must NOT redden `server/src/__tests__/trip-van-status.test.ts`'s last
   test.** D5 is an alert, not a sweep — "never auto-change status" — so the
   pinned fact (nothing frees a van left `on_trip`) stays true. `CLAUDE.md`
   currently warns that building the sweep reddens that test; correct that
   sentence, because an alert does not.
5. **D6 must also build the note WRITER.** Nothing writes `booking_notes`
   today — no mutation, no admin form, no seed. A "Show to driver" checkbox
   needs a form to live in.
6. **D4 must also build the DEACTIVATION.** Nothing can deactivate a driver:
   `drivers.is_active` is read by the login path and by dispatch availability
   and written by no mutation — `driverInputSchema` excludes it,
   `toUpdateValues` does not map it, there is no `admin.drivers.setActive`.
   Week 6 measured the twelve-hour session window with a hand-written
   `UPDATE`. So D4 adds `setActive`, modelled on `admin.vans.setStatus`.
7. **D4's "future trips show as needs-assignment" needs the alert's STATUS
   FILTER widened too.** `unassignedSoon` is `status = 'confirmed'` only, and
   assignment moves a booking to `assigned` — so the inactive-driver term
   alone would be dead code that reads as a fix. Status set becomes
   `['confirmed', 'assigned']`, with a test pinning what makes that safe: an
   `assigned` booking has both ids by construction, so the only term it can
   match is the new one.
8. **C5's twelve hand-written `fleet_date_slots` cleanups are LOAD-BEARING,
   not redundant.** `LEAK_TABLES` detects; it does not clean. Add the table,
   remove nothing, and report the twelve call sites so the owner can decide
   separately about a shared `releaseSlotsFor(dates)` helper.

Two ordering constraints: **Task 7 before Task 8** (both edit `cancelBooking`'s
`.set()`), and **Task 5 before Task 10** (both add a `schedule()` call to
`server/src/jobs/index.ts`). Task 10 before Task 12 (both edit
`global-setup.ts`).

---

## 5. The review contract to use (calibrated after Task 1)

Task 1's review took **80 minutes** because it re-ran all five checks _and_
reproduced every mutation — work the implementer already did and the
coordinator repeats before pushing. Task 2's review, scoped as below, took
**8 minutes** and caught more.

Give the reviewer: `CLAUDE.md`, the brief, the notes, the report, the diff
file. Ask it to:

- read the diff and judge it against the brief, the notes and `CLAUDE.md`;
- run `pnpm typecheck` and **the task's own test files only**;
- reproduce **ONE** mutation — the most load-bearing — and nothing more;
- restore what it touched and confirm `git status` is clean before finishing;
- **not** run `lint`, `format:check` or the build;
- return `SPEC: PASS/FAIL`, `QUALITY: APPROVED/CHANGES REQUESTED`, numbered
  findings each marked BLOCKING or NON-BLOCKING, and whether the tree is clean;
- **not fix anything** — report it.

The coordinator runs the full five checks before every push. Same gate, one
step later, paid for once instead of three times.

---

## 6. `BUILD_SPEC.md` must be updated before the Week 7 plan

`docs/BUILD_SPEC.md`'s **Week 7 section (lines ~1087–1186)** opens by handing
Week 7 the same ten carry-forwards and seven open decisions that Week 6.5 is
closing. Left alone, it will hand Week 7 a list of problems that no longer
exist.

- Lines ~1093–1112 (and the one-liner at ~1065) say the orphaned-`on_trip`
  van needs an owner decision and names two candidate fixes. **D5 decided it:**
  a daily check plus a dashboard alert, and **never** an automatic status
  change. Rewrite, keeping the pointer to `trip-van-services.test.ts`'s pinning
  test (the real filename is `trip-van-status.test.ts`).
- Of the ten numbered items, Week 6.5 closes **2 (C5), 3 (C3), 4 (C6),
  6 (C4), 7 (C7), 8 (C2), 9 (C1)** and all seven decisions in item 10.
- **Item 5 stays open**: the PayMongo gateway wire check. `provider.refund()`
  has only ever run against the mock, and no real payment or refund has ever
  been issued. Still a blocking pre-launch item in `LAUNCH_CHECKLIST.md`.
- **Item 1 is NOT in the owner's C-list** — `TripProgressStop` carries no
  checkpoint id, so the client's undo _label_ breaks a same-second tie by
  array index where the server uses id. Label only; the refetch corrects it.
  Leave it as a Week 7 carry; do not quietly fold it in.

---

## 7. Open for the owner — decide before or during the resumed week

**(a) The money guard is weaker than the plan assumed.** The guard enforcing
"only `record-payment.ts` writes `bookings.amount_paid_centavos`" is
**file-scoped**, so that file is an authorised owner and a _new function added
to it_ can write the column with the guard green. Measured twice — by the
implementer and independently by the reviewer: an `amountPaidCentavos` write
planted inside `rejectCashPayment` passed `pnpm typecheck` **and**
`schema-conventions.test.ts` 6/6, and was caught only by three assertions in
`admin-cash-verify.test.ts`. The guard's own docblock warns of exactly this
("Add a third writer to that file and this guard will not stop you").

The rule held, but it is held by tests and review rather than structurally.
**Recommended, not done** (outside D2's scope, and it touches a money guard):
make the guard function-scoped inside `record-payment.ts`, with an allow-list
of the two functions permitted to credit a booking.

**(b) Scope the owner may want to cut**, both recorded as rulings 5 and 6: D4
adds `admin.drivers.setActive` and D6 adds `admin.bookings.addNote` plus its
form. Neither was asked for in the decision's wording, and neither decision
can be implemented without it.

**(c) Smaller items found and deliberately not fixed in Task 2:** there is no
cross-booking view of refused claims; nothing notifies a driver their claim was
refused (their box simply returns to `collect_cash`); and
`asTrpcError`'s `CashRejectionNeedsReasonError` branch is unreachable through
tRPC because the input schema refuses a blank reason first — the same property
the existing receipt branch has, kept as defence in depth for a service that is
callable from a script.

---

## 8. Standing constraints, unchanged

From the owner's instruction of 2026-10-16 and `CLAUDE.md`:

- **DO NOT** touch Kong PMS; migrate anything but `rg_travel` / `rg_travel_test`;
  add libraries; write `amount_paid_centavos` outside `record-payment.ts`; add a
  second refund path; use red; use `git commit --amend`; deploy.
- **Owner decisions come only from the owner in that thread**, logged with
  dates in the plan file.
- `ui-ux-pro-max` for every UI change, with the queries recorded in the report.
- Every new test **proven able to fail** — break it, confirm red, restore
  byte-identically.
- Clean up every row a mutation leaves. **The leak detector must stay silent.**
- Five checks before every push: `lint` · `typecheck` · `test` ·
  `format:check` · `ALLOW_PLACEHOLDER_BUILD=1 build`.
- **Run Prettier on any markdown written by hand** — `format:check` covers
  `docs/`, and this bit once already (`ee3f34e`).
- Ports 5180 client / 3100 server. MySQL service name is `kongpms`; a
  connection error is not an assertion failure and reports must say which.
- Unrelated bugs: list at the end, do not fix.
