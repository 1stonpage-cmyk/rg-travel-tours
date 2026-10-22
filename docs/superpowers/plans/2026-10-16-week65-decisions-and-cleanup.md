# Week 6.5 — Owner decisions and cleanup: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle the seven open owner decisions Week 6 left documented-but-undecided, and close the seven carry-forwards it recorded — so that nothing in the driver portal is "deliberate by default" any more.

**Architecture:** Fourteen independent tasks, each one commit or two, each with its own tests. Nothing here is a rewrite: every change extends a module that already works, through the door that module already owns (`releaseVanFromTrip`, `releaseRedemption`, `recordPendingCash`, `resolvePage`, `assertMayVerifyPayments`). One task needs a migration; the rest are additive code plus tests.

**Tech Stack:** React 19 + Vite 7 + Tailwind v4 + shadcn/ui · Express 5 + tRPC v11 · Drizzle 0.44.7 + MySQL 8 · Zod v4 (shared) · node-cron · Vitest.

**Spec:** `docs/BUILD_SPEC.md` (§6, §8, §9, §10, §13) and `CLAUDE.md`. Week 6's own record of these items is `docs/superpowers/plans/2026-10-16-week6-walkthrough.md` (the findings) and `docs/superpowers/plans/2026-10-15-week6-drivers-and-verification.md` (the tasks that found them).

---

## Global Constraints

Copied verbatim from `CLAUDE.md` and the owner's instruction of 2026-10-16. **Every task's requirements implicitly include this section.**

- **Money:** integers in **centavos** everywhere. **`bookings.amount_paid_centavos` is written in `server/src/services/payments/record-payment.ts` and nowhere else.** No second refund path, no new `payments` insert path.
- **Time:** store **UTC**; compute business dates in **Asia/Manila**. Time-dependent code takes an explicit `now` parameter; never a clock read inside a query.
- **Soft deletes only.** Never hard-delete bookings or payments.
- **Audit** every payment, refund, status change and assignment. Audit actions are **dotted** (`payment.cash_rejected`), not snake_case.
- **Zod on every input**, schemas shared from `/shared`.
- **NO RED ANYWHERE.** Warnings amber/orange; errors `#334155` (`text-brand-error`). Meaning is never carried by colour alone.
- **Mobile-first 360px**, 44px minimum tap targets, AA contrast (4.5:1). `brand-gold-600` fails AA for normal-size text — use `brand-gold-700` or darker.
- **Ports: 5180 client / 3100 server.** Never 5173 or 3000. Database `rg_travel`; tests `rg_travel_test`.
- **Use ui-ux-pro-max for every UI change.**
- **Every new test must be proven able to fail**: break the code it covers, confirm red, restore byte-identically.
- **Clean up every row a mutation leaves behind.** The leak detector in `server/src/__tests__/global-setup.ts` must stay silent.
- **The five checks, in this order, before every push:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.
- **DO NOT:** touch Kong PMS; migrate anything but `rg_travel` / `rg_travel_test`; add libraries; use `git commit --amend`; deploy.
- Commits reported as `hash - short human label`. **DONE** after each task, pushed immediately.

## Owner decisions — the authority for this week

Stated directly by the owner in-thread and logged here, **all owner-decided 2026-10-16**. Each row is the instruction as given; the task that implements it may not re-decide it.

| #   | Decision (owner-decided 2026-10-16)                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Completed trips SHOW the driver payment box (cancelled/expired still hidden). Replace the false "nothing to collect" copy. Test: completed trip with balance owed shows "Collect PHP X".                                                                                                          |
| D2  | Finance/owner "reject cash claim — not received": pending cash row to rejected, reason required, audit, `amount_paid` untouched, unblocks the driver. New status value approved if needed (migration). Tests: reject moves no money; driver can re-record after; dispatcher/driver cannot reject. |
| D3  | `driver_inactive` returns the identical error and comparable timing to a wrong PIN; real reason in `audit_log` only. Test the response bodies are byte-identical.                                                                                                                                 |
| D4  | Deactivating a driver deletes all their sessions in the same transaction; their future trips show as needs-assignment. Test: next request after deactivation is `UNAUTHORIZED`.                                                                                                                   |
| D5  | Daily node-cron check: vans `on_trip` with no `in_progress` trip, to a dashboard alert. **Never auto-change status.**                                                                                                                                                                             |
| D6  | `booking_notes` gets a `visible_to_driver` boolean, default FALSE (migration). Driver portal shows only flagged notes; staff UI gets a "Show to driver" checkbox. Test: unflagged note never reaches the driver API.                                                                              |
| D7  | Admin cancellation releases the coupon redemption (audited), same as hold expiry.                                                                                                                                                                                                                 |
| C1  | Write `cancel_reason` / `cancelled_at` / `completed_at` on the paths that own them.                                                                                                                                                                                                               |
| C2  | SPA routes `/driver`, `/admin`, `/portal` return HTTP 200.                                                                                                                                                                                                                                        |
| C3  | Daily cleanup of expired sessions (prod + test DB).                                                                                                                                                                                                                                               |
| C4  | Seed `tour_itinerary_stops` for seeded tours (dev seed only).                                                                                                                                                                                                                                     |
| C5  | Add `fleet_date_slots` to `LEAK_TABLES`; remove hand-written cleanups it makes redundant.                                                                                                                                                                                                         |
| C6  | One `isDuplicateKeyError` (shared), delete the copies.                                                                                                                                                                                                                                            |
| C7  | Limiter vs escalation: keep both; document escalation as the multi-IP defence and add a test where failures from several IPs reach the admin-unlock state.                                                                                                                                        |

### Pre-flight rulings (2026-10-16)

Made before dispatch, each against the plan text that prompted it. An implementer may not re-decide these.

1. **D2 needs NO migration and NO new enum value.** `PAYMENT_STATUSES` already carries `rejected`, and `payments.reject_reason` already exists with exactly these semantics — "an admin looked at this and refused it, and here is why" (`schema.ts`, the manual-receipt flow, owner decision 2026-10-14 Q6). The owner pre-approved a migration _if needed_; it is not needed, and a `cash_rejected` value beside `rejected` would give the system two words for one event. **Cost if wrong:** a report that wants to separate a refused receipt from refused cash joins on `method = 'cash'` — which it must do to find cash rows at all.
2. **D2 does NOT reuse `verifyPendingManualPayment`.** That function is shared by the cash and receipt approval paths and moves the booking (`statusAfterManualVerified`). A cash rejection must move **nothing** on the booking — unlike a receipt rejection, which sends the guest back to `pending_payment` with a re-upload deadline, because that trip has not run yet. Cash is the balance on a trip that already ran. So: a separate `rejectCashPayment()` beside it, sharing only `assertMayVerifyPayments`. **Cost if wrong:** one more function in a file that already holds five.
3. **D3 REMOVES `driver_inactive` from `DriverLoginRefusal`** (`shared/src/driver.ts`) rather than leaving it in the union unreachable. The client builds a compiler-exhaustive `Record<DriverLoginRefusal, string>`; a member the server can never send is a sentence no driver can ever read, and its presence would tell the next reader the state is reachable. Removing it makes the compiler prove the wire cannot carry it. The real reason lives in `audit_log` under its own action. **Cost if wrong:** restoring the member is a two-line revert.
4. **D5 does NOT redden `trip-van-status.test.ts`'s last test.** `CLAUDE.md` warns that building the orphaned-`on_trip` sweep breaks that test and that whoever builds it must replace it with the sweep's own proof. D5 is explicitly **not** a sweep — "Never auto-change status" — so the pinned fact (nothing frees a van left `on_trip`) stays true, and that test stays green and stays in place. What changes is `CLAUDE.md`'s claim that the gap arrives "with nothing in the logs": after D5 there is a daily log line and a dashboard alert. **Cost if wrong:** the test goes red and reveals that the alert changed a status, which is the failure it exists to catch.
5. **D6 must also build the note WRITER.** Nothing in the system writes `booking_notes` today — the table is read by `admin.bookings.detail` and `driver.trip`, and written by no mutation, no admin form and no seed (verified 2026-10-16). A "Show to driver" checkbox needs a form to live in, and a visibility flag with no writer is undemonstrable on a fresh clone — the same C4-shaped gap this week exists to close. So D6 includes `admin.bookings.addNote` and the admin form. **Cost if wrong:** more surface than the decision's wording implies; stated here so the owner can cut it.
6. **D4 must also build the DEACTIVATION, because nothing can deactivate a driver today.** `drivers.is_active` is declared, read by `attemptDriverLogin` and by dispatch availability — and written by **no mutation at all** (verified 2026-10-16). `driverInputSchema` deliberately excludes it, `toUpdateValues` does not map it, and there is no `admin.drivers.setActive` to match vans' `admin.vans.setStatus`; `shared/src/dispatch.ts` says so in as many words ("`status` has no admin-facing setter in this task"). Week 6's measurement of the twelve-hour window was taken with a hand-written `UPDATE drivers`, which is consistent. So "deactivating a driver deletes their sessions" cannot be implemented without the act of deactivating existing first: D4 adds `admin.drivers.setActive`, modelled on `admin.vans.setStatus`, and hangs the revocation off it. **Cost if wrong:** a mutation the owner did not ask for, in a week about closing gaps — stated here so the call stays theirs. The alternative, a re-read of `is_active` on every driver request, was rejected: it costs a second query on the portal's hottest path and still leaves the twelve-hour window if the join is ever dropped.
7. **D4's "future trips show as needs-assignment" goes through `unassignedSoon`, and needs its status filter widened too.** That alert is `status = 'confirmed'` only (owner-decided 2026-10-14, Q7), and assignment moves a booking `confirmed` to `assigned` (`dispatch/assign.ts:213`) — so a booking whose assigned driver is deactivated is `assigned` and the alert would never see it. Adding only the `is_active` term would ship **dead code that reads as a fix**. So the status set becomes `['confirmed', 'assigned']` and the predicate gains the inactive-driver term. The property that makes this safe is testable and must be tested: an `assigned` booking has both ids by construction, so the only way it can match is the inactive-driver term — **adding `assigned` changes no count on a healthy fleet**. **Cost if wrong:** the alert's §9 semantics widen by one status; the residue is that the alert's window is 48 hours, so a deactivated driver's trip further out surfaces as its date approaches rather than immediately. State that in `CLAUDE.md`.
8. **C5's hand-written cleanups are LOAD-BEARING, not redundant.** `LEAK_TABLES` **detects** leaks; it does not clean. Twelve suites hand-delete `fleet_date_slots` rows in `afterAll`, and those deletes are what will keep the detector silent once the table is listed. Removing them would make the detector fire on every run — the opposite of the standing instruction that it stay silent. **So C5 adds the table and removes nothing**, then reports what the detector found. Any file the detector _does_ catch is a suite missing a cleanup, and gets one. **Cost if wrong:** the owner wanted twelve lines deleted and gets a reason instead; the twelve call sites are named in the report so the call stays theirs.

9. **Money guard made function-scoped — owner-decided 2026-10-16 (handover §7a recommendation, ordered 2026-10-22), built as Task M1.** `schema-conventions.test.ts` A5b used to treat `record-payment.ts` as one authorised unit, so a new function in that file could write `bookings.amount_paid_centavos` with the guard green (measured twice in Task 2). It now parses the file with the TypeScript compiler and requires the enclosing top-level function of every write to be on an explicit allow-list: `recordPayment` and `verifyPendingManualPayment`, nothing else. A write at module top level or in an unnamed declaration fails closed; each allow-listed name must still exist and still write. A third crediting function is added by extending the allow-list in the same commit. **Cost if wrong:** one more diff to read when a crediting function is legitimately added, which is the point.

### Interface conflicts found by the pre-flight scan

One row per pair of tasks that share a file or an interface, plus one per task on whether its own text agrees with itself.

| Tasks                 | Shared surface                         | Finding                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D2, D7, C1            | `server/src/services/payments/`        | D2 adds a function to `record-payment.ts`; D7 and C1 both edit `cancelBooking` in `cancel-refund.ts`. **C1 runs after D7**, so C1 edits a `.set()` D7 has already touched — sequence is load-bearing, and C1's brief must say the coupon release is already there. |
| D7, C1                | `cancelBooking`'s audit payload        | Both add a key (`couponReleased`, then the two timestamps are columns not payload). No collision; C1 adds no audit key.                                                                                                                                            |
| D3, D4                | driver auth                            | D3 edits `attemptDriverLogin`'s inactive branch; D4 edits `admin.drivers.update`. Disjoint files. Both assert on `is_active`, and **D4's test must not assume D3's refusal string** — after D3 an inactive driver's login answers `wrong_credentials`.             |
| D4, C3                | `server/src/services/sessions.ts`      | D4 adds `revokeSessionsForSubject`, C3 adds `deleteExpiredSessions`. Two exports, no shared state. C3 runs later and must not refactor D4's.                                                                                                                       |
| D5, C3                | `server/src/jobs/index.ts`             | Both add a `schedule()` call. **C3 runs after D5**, so C3's brief must expect two jobs already registered, not one.                                                                                                                                                |
| D6, C4                | `server/src/db/schema.ts` + migrations | D6 generates a migration (`0012`). C4 touches seed data only, no schema. No ordering constraint beyond "D6's migration is applied before C4's tests run", which the test harness does automatically.                                                               |
| D1, D6                | the driver trip screen                 | D1 edits `PaymentBox.tsx`, D6 edits the notes read. Both are rendered by `DriverTripPage.tsx` and neither touches it.                                                                                                                                              |
| C2, D5                | nothing                                | Disjoint.                                                                                                                                                                                                                                                          |
| C6                    | `server/src/db/duplicate-key.ts`       | Used by five files already; C6 adds two importers and deletes two local copies. No signature change.                                                                                                                                                               |
| C3, C5                | `server/src/__tests__/global-setup.ts` | C3 edits the teardown (prune `sessions`); C5 edits `LEAK_TABLES`. **C3 runs first**, so C5 must not revert C3's prune, and C5 must not add `sessions` to `LEAK_TABLES` — C3's brief explains why.                                                                  |
| D4, C1                | `bookings.driver_id`                   | D4 deliberately does NOT clear `driver_id` on deactivation (the id is the record of who was assigned). C1 adds no driver column. No collision.                                                                                                                     |
| C7                    | `driver-lockout.test.ts`               | Test-only, plus a `CLAUDE.md` edit and a `LAUNCH_CHECKLIST.md` cross-reference. Touches no production code.                                                                                                                                                        |
| Each task, internally | —                                      | Checked: every task's tests name files that the same task creates or that exist today; no task specifies a test over code another task writes.                                                                                                                     |

---

## Task 1 (D1): a completed trip shows the payment box

**Decision:** D1, owner-decided 2026-10-16.

**Why this is first.** It is the only item on the list where the screen currently states something false. After the last stop the trip is `completed`, the box disappears, and the driver reads _"This trip is finished. There is nothing to collect here."_ while PHP 4,500 is owed — measured in the browser on 2026-10-16 (`2026-10-16-week6-walkthrough.md`, step 9). The server already answers `collect_cash` for a completed trip and `driver.recordCash` already accepts the claim; only this component refuses. So this task removes a client-side suppression, and adds nothing to the server.

**Files:**

- Modify: `client/src/components/driver/PaymentBox.tsx` (the `LIVE_STATUSES` allow-list, `NOT_LIVE_COPY`, and the module doc's rule 1)
- Modify: `client/src/__tests__/driver-payment-box.test.tsx` (exact filename to be confirmed by the implementer with `ls client/src/__tests__/ | grep -i payment`; the suite that already covers this component)
- Modify: `CLAUDE.md` (the Driver portal bullet beginning "The payment box is computed on the server")

**Interfaces:**

- Consumes: `PaymentBoxState` and `BookingStatus` from `@rg/shared`, unchanged. `PaymentBoxProps` unchanged.
- Produces: nothing new. The rename below is internal to the file.

- [ ] **Step 1: Write the failing test**

In the component's existing suite, beside the tests that assert the current terminal-state copy:

```tsx
it('shows the collect box on a COMPLETED trip that still owes money', () => {
  renderBox({
    status: 'completed',
    payment: { kind: 'collect_cash', amountCentavos: 450000 },
    isToday: true,
  });

  // The figure AND the words — rule 3 is not suspended because the trip ended.
  expect(screen.getByRole('heading', { name: /Collect ₱4,500 cash/ })).toBeInTheDocument();
  expect(screen.getByText(/Four thousand five hundred pesos/)).toBeInTheDocument();
  // The button is offered, because the server accepts the claim.
  expect(screen.getByRole('button', { name: /Record cash collected/ })).toBeInTheDocument();
  // And the false sentence is gone.
  expect(screen.queryByText(/nothing to collect/i)).not.toBeInTheDocument();
});

it('still hides the amount on a CANCELLED and on an EXPIRED booking', () => {
  for (const status of ['cancelled', 'expired'] as const) {
    const { unmount } = renderBox({
      status,
      payment: { kind: 'collect_cash', amountCentavos: 450000 },
      isToday: true,
    });
    expect(screen.queryByText(/4,500/)).not.toBeInTheDocument();
    expect(screen.getByText(/Do not collect/i)).toBeInTheDocument();
    unmount();
  }
});

it('a completed trip that is fully paid says so, and offers no button', () => {
  renderBox({ status: 'completed', payment: { kind: 'fully_paid' }, isToday: true });
  expect(screen.getByRole('heading', { name: /Paid in full/ })).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
```

`renderBox` is the suite's existing helper; if it does not exist, write one that renders `PaymentBox` inside the suite's tRPC mock provider with `bookingId: 1` and a no-op `onCollected`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- driver-payment-box`
Expected: the first test FAILS — the heading is "Trip completed" and there is no button. The second and third pass already (they pin behaviour this task must not change).

- [ ] **Step 3: Widen the allow-list**

In `PaymentBox.tsx`, rename the constant and add the one status. The rename is the point: `LIVE_STATUSES` would become a lie the moment `completed` joined it, and a constant whose name misdescribes its contents is how the next reader reintroduces the bug.

```tsx
/**
 * The statuses on which this box may show a collection instruction at all.
 *
 * An ALLOW-LIST, in the spirit of `VAN_STATUS_SELLABLE`: a status added
 * later shows no instruction until somebody decides it should.
 *
 * **`completed` is here, and that is a correction** (owner-decided
 * 2026-10-16, D1). It was excluded while the list was called
 * `LIVE_STATUSES`, on the reasoning that a finished trip is not a trip a
 * driver is standing in front of a guest for. That reasoning was wrong in
 * the one case that matters: cash is the BALANCE, handed over at the END of
 * a trip, and a driver who taps Complete before the guest has paid — or
 * whose last check-in completed the trip automatically — then read "There
 * is nothing to collect here" over PHP 4,500 that was owed. The sentence
 * was not merely unhelpful; it was false, and it told a driver not to ask
 * for money the company is owed.
 *
 * The server never suppressed any of this: `driver.trip` answers
 * `collect_cash` on a completed trip and `driver.recordCash` accepts the
 * claim (both measured over HTTP, 2026-10-16). This file was the only
 * refusal, which is exactly the asymmetry the decision closes.
 *
 * `cancelled` and `expired` stay out, and for a different reason than
 * "the trip is over": those two mean the booking should not have been
 * driven at all, so money against them is an office matter.
 */
const COLLECTABLE_STATUSES = [
  'confirmed',
  'pending_verification',
  'assigned',
  'in_progress',
  'completed',
] as const;
type CollectableStatus = (typeof COLLECTABLE_STATUSES)[number];

function showsBox(status: BookingStatus): status is CollectableStatus {
  return (COLLECTABLE_STATUSES as readonly BookingStatus[]).includes(status);
}
```

- [ ] **Step 4: Let the compiler delete the false copy**

`NOT_LIVE_COPY` is declared `Record<Exclude<BookingStatus, LiveStatus>, …>`. Retype it against the new union and **delete the `completed` entry** — the compiler requires it, which is the mechanism that stops the false sentence surviving in a branch nothing reaches:

```tsx
const NOT_COLLECTABLE_COPY: Record<
  Exclude<BookingStatus, CollectableStatus>,
  { tone: 'warn' | 'neutral'; heading: string; body: string }
> = {
  pending_payment: {/* unchanged */},
  cancelled: {/* unchanged */},
  expired: {/* unchanged */},
};
```

Rename the two call sites (`isLive(status)` to `showsBox(status)`, `NOT_LIVE_COPY[status]` to `NOT_COLLECTABLE_COPY[status]`). With `completed` removed from the record, `tone: 'neutral'` is now unreachable — **leave the `'warn' | 'neutral'` union and the neutral rendering branch in place**: all three remaining entries are `warn`, and narrowing the type to `'warn'` would delete the styling a future non-warning state needs. Note it in a comment rather than deleting it.

- [ ] **Step 5: Update the module doc**

Rule 1 in the file header currently says "A trip that is not live shows NO collection instruction" and names "the four live ones". Rewrite it to state the new rule and why `completed` moved, citing D1 and 2026-10-16. The header is what a reader trusts over the code; leaving it describing four statuses is the defect this step exists to prevent.

- [ ] **Step 6: Run the suite and the whole client suite**

Run: `pnpm --filter @rg/client test`
Expected: PASS, including any test that asserted the old completed-trip copy. **A test that asserted "nothing to collect" for a completed trip is now asserting a decision that has been reversed** — update it to assert the collect box, and say so in the report. Do not delete it.

- [ ] **Step 7: Prove the new test can fail**

Remove `'completed'` from `COLLECTABLE_STATUSES` and restore the `completed` entry in the copy record. Run the suite: the new test must go red on the missing heading. Restore both edits byte-identically and re-run to green.

- [ ] **Step 8: Correct CLAUDE.md**

The Driver portal bullet currently reads "**It is NOT suppressed for a `completed` trip** … the box is hidden for `completed` by the client alone (measured 2026-10-16). That asymmetry is an open owner decision, not a settled design; do not 'fix' either side without the answer." Replace it with the settled rule: server and client now agree, `completed` shows the box, `cancelled` and `expired` do not, owner-decided 2026-10-16, and the allow-list is `COLLECTABLE_STATUSES` in `PaymentBox.tsx`.

- [ ] **Step 9: Five checks, commit, push**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check && ALLOW_PLACEHOLDER_BUILD=1 pnpm build
git add -A && git commit -m "fix(driver): a completed trip shows what is still owed"
git push
```

---

## Task 2 (D2): finance can refuse a cash claim

**Decision:** D2, owner-decided 2026-10-16. **Pre-flight rulings 1 and 2 apply: no migration, no new enum value, no reuse of the approval function.**

**The problem being solved.** A driver taps "Record cash collected" and one `pending` `payments` row exists from then on. If the money never reaches the office there is no way to close that row: `verifyCashPayment` only ever approves, and the pending row puts the driver's payment box into `unverified_do_not_collect`, so `driver.recordCash` answers `CONFLICT` on every later attempt. One mistaken tap blocks that booking's cash collection permanently and leaves a false claim sitting in the verification queue.

**Files:**

- Modify: `server/src/services/payments/errors.ts` (add `CashRejectionNeedsReasonError`)
- Modify: `server/src/services/payments/record-payment.ts` (add `rejectCashPayment()`)
- Modify: `server/src/routers/admin/bookings.ts` (add `rejectCash`, and widen the detail read if `rejectReason` is not already selected for cash rows)
- Modify: `client/src/pages/admin/AdminBookingDetailPage.tsx` (the reject control inside the per-claim panel)
- Test: `server/src/__tests__/cash-reject.test.ts` (new)
- Test: `server/src/__tests__/admin-bookings-roles.test.ts` (the existing role matrix test — add `rejectCash`; confirm the filename with `ls server/src/__tests__ | grep -i role`)
- Test: `client/src/__tests__/admin-bookings.test.tsx` (the existing admin detail suite)
- Modify: `CLAUDE.md` (the Driver portal bullet that ends "There is no reject path for a cash claim yet.")

**Interfaces:**

- Consumes: `assertMayVerifyPayments(verifier) -> number` (already exported from `record-payment.ts` for exactly this kind of reuse), `writeAudit`, `CashPaymentNotFoundError`, `CashPaymentNotPendingError` (both already exist), `asTrpcError` (already used by `approveCash`).
- Produces:

  ```ts
  export interface RejectCashPaymentResult {
    paymentId: number;
    bookingId: number;
    /** The booking's ref, for the admin's confirmation line. */
    ref: string;
  }
  export async function rejectCashPayment(input: {
    paymentId: number;
    reason: string;
    verifier: { type: string; id: number | null; role: unknown };
  }): Promise<RejectCashPaymentResult>;
  ```

  tRPC: `admin.bookings.rejectCash({ paymentId: number, reason: string })` under `adminProcedure('verifyPayments')`.

- [ ] **Step 1: Write the failing tests**

`server/src/__tests__/cash-reject.test.ts`. Follow the fixture discipline in `server/src/__tests__/driver-trips.test.ts`: create the tour, van, driver and booking in `beforeAll`, delete every row in `afterAll` in FK order, and delete `fleet_date_slots` rows for any date touched.

```ts
it('moves no money and leaves the booking exactly as it was', async () => {
  const before = await bookingRow(bookingId);
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 450000,
    collectedByDriverId: driverId,
  });

  await rejectCashPayment({
    paymentId,
    reason: 'The driver never handed this in.',
    verifier: { type: 'user', id: financeUserId, role: 'finance' },
  });

  const payment = await paymentRow(paymentId);
  expect(payment.status).toBe('rejected');
  expect(payment.rejectReason).toBe('The driver never handed this in.');
  // The row is kept, never deleted — CLAUDE.md: never hard-delete a payment.
  expect(payment.amountCentavos).toBe(450000);
  // Verified-by stays NULL: nobody verified anything, they refused it.
  expect(payment.verifiedBy).toBeNull();

  const after = await bookingRow(bookingId);
  expect(after.amountPaidCentavos).toBe(before.amountPaidCentavos);
  expect(after.status).toBe(before.status);
  expect(after.paymentReviewRequired).toBe(before.paymentReviewRequired);
});

it('writes one audit row carrying the reason and the actor', async () => {
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 100,
    collectedByDriverId: driverId,
  });
  await rejectCashPayment({
    paymentId,
    reason: 'Short by 500.',
    verifier: { type: 'user', id: financeUserId, role: 'owner' },
  });

  const rows = await auditRowsFor('payments', paymentId);
  const rejected = rows.filter((r) => r.action === 'payment.cash_rejected');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.actorType).toBe('user');
  expect(rejected[0]!.actorId).toBe(financeUserId);
  expect(rejected[0]!.data).toMatchObject({
    reason: 'Short by 500.',
    priorPaymentStatus: 'pending',
    paymentStatus: 'rejected',
    collectedByDriverId: driverId,
  });
  // No guest name, email or phone in an audit payload (RA 10173).
  expect(JSON.stringify(rejected[0]!.data)).not.toMatch(/@|\+63/);
});

it('unblocks the driver: the box returns to collect_cash and a new claim succeeds', async () => {
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 450000,
    collectedByDriverId: driverId,
  });
  // While it is pending, the driver is refused.
  await expect(recordDriverCash(driverId, bookingId, TOUR_DAY_NOON)).rejects.toMatchObject({
    code: 'CONFLICT',
  });

  await rejectCashPayment({
    paymentId,
    reason: 'Not received.',
    verifier: { type: 'user', id: financeUserId, role: 'finance' },
  });

  const detail = await driverTripDetail(driverId, bookingId);
  expect(detail.payment).toEqual({ kind: 'collect_cash', amountCentavos: 450000 });
  const second = await recordDriverCash(driverId, bookingId, TOUR_DAY_NOON);
  expect(second.paymentId).not.toBe(paymentId);
});

it('refuses a second rejection, and refuses one on an approved row', async () => {
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 100,
    collectedByDriverId: driverId,
  });
  await rejectCashPayment({ paymentId, reason: 'One.', verifier: FINANCE });
  await expect(
    rejectCashPayment({ paymentId, reason: 'Two.', verifier: FINANCE }),
  ).rejects.toBeInstanceOf(CashPaymentNotPendingError);
});

it('requires a reason, and refuses whitespace', async () => {
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 100,
    collectedByDriverId: driverId,
  });
  for (const reason of ['', '   ', '\t\n']) {
    await expect(
      rejectCashPayment({ paymentId, reason, verifier: FINANCE }),
    ).rejects.toBeInstanceOf(CashRejectionNeedsReasonError);
  }
  // And it wrote nothing while refusing.
  expect((await paymentRow(paymentId)).status).toBe('pending');
});

it('refuses a driver, a dispatcher, an unknown role and a non-user actor', async () => {
  const { paymentId } = await recordPendingCash({
    bookingId,
    amountCentavos: 100,
    collectedByDriverId: driverId,
  });
  const refused = [
    { type: 'driver', id: driverId, role: 'driver' },
    { type: 'user', id: dispatcherUserId, role: 'dispatcher' },
    { type: 'user', id: financeUserId, role: '__proto__' },
    { type: 'user', id: financeUserId, role: undefined },
    { type: 'system', id: null, role: 'owner' },
  ];
  for (const verifier of refused) {
    await expect(rejectCashPayment({ paymentId, reason: 'No.', verifier })).rejects.toBeInstanceOf(
      PaymentVerificationNotPermittedError,
    );
  }
  expect((await paymentRow(paymentId)).status).toBe('pending');
});

it('refuses a payment id that is not a driver-cash row', async () => {
  // A receipt row: provider manual, method bank_transfer, no collected_by_driver_id.
  const receiptId = await insertReceiptPayment(bookingId);
  await expect(
    rejectCashPayment({ paymentId: receiptId, reason: 'No.', verifier: FINANCE }),
  ).rejects.toBeInstanceOf(CashPaymentNotFoundError);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- cash-reject`
Expected: every test fails at import — `rejectCashPayment` does not exist.

- [ ] **Step 3: Add the error**

In `server/src/services/payments/errors.ts`, beside `ReceiptRejectionNeedsReasonError`:

```ts
/**
 * A cash claim may only be refused WITH a reason. Its own error rather than
 * reusing the receipt one, because the two carry different consequences: a
 * rejected receipt sends a guest an email asking for another one, and a
 * rejected cash claim is an internal finding about a driver. The messages a
 * caller shows differ, so the types do.
 */
export class CashRejectionNeedsReasonError extends Error {
  constructor() {
    super('A cash claim can only be refused with a reason.');
    this.name = 'CashRejectionNeedsReasonError';
  }
}
```

If `errors.ts` maps error classes to tRPC codes (check `asTrpcError`), add this one as `BAD_REQUEST` and `CashPaymentNotPendingError` must already be mapped — confirm, and add a mapping test if one is missing.

- [ ] **Step 4: Write the service**

In `record-payment.ts`, immediately after `verifyCashPayment`. The lock order is the house order and the reason is in the comment — it is the same order `verifyPendingManualPayment` and `decideManualReceipt` take, so none of the three can deadlock against another.

```ts
const rejectCashPaymentInputSchema = z.object({
  paymentId: z.number().int().positive(),
  reason: z.string().max(400),
  verifier: cashVerifierSchema,
});

/**
 * Finance or the owner refuses a cash claim: the money never arrived
 * (owner decision 2026-10-16, D2).
 *
 * Converts the driver's `pending` row to `rejected` with the reason, **in
 * place**, and touches NOTHING on the booking. Not `amount_paid_centavos`,
 * not `status`, not `payment_review_required` — there is nothing to undo,
 * because a claim never credited anything in the first place. That is the
 * whole asymmetry with a rejected RECEIPT, which sends the guest back to
 * `pending_payment` with a re-upload deadline: a receipt is money the guest
 * says they sent before the trip, and cash is the balance on a trip that
 * has already run.
 *
 * ## What this unblocks, and why that is a consequence rather than a goal
 *
 * `driver.trip`'s payment box reads `status = 'pending'` only, so refusing
 * the row returns that box to `collect_cash` and lets the driver record the
 * cash again — which is the right outcome when the first tap was a mistake
 * or the guest paid later. It is NOT an invitation to re-record: every
 * claim is its own row for its whole life, and the rejected one stays
 * exactly where it is as the record of what was claimed and refused.
 *
 * ## `verified_by` stays NULL
 *
 * Deliberately, unlike the receipt rejection path which also leaves it
 * null: `verified_by` means "this person confirmed money arrived", and
 * writing a refuser's id there would make a refusal indistinguishable from
 * an approval in every query that reads that column. The refuser is in the
 * audit row, which is where "who decided what, and why" belongs.
 *
 * Rejects, writing nothing, when the verifier is not an owner or finance
 * user, when the reason is empty or whitespace, when the id is not a
 * driver-cash row, or when that row is no longer `pending`.
 */
export async function rejectCashPayment(
  input: RejectCashPaymentInput,
): Promise<RejectCashPaymentResult> {
  const parsed = rejectCashPaymentInputSchema.parse(input);
  // Before the transaction opens — it needs nothing from the database.
  const verifiedBy = assertMayVerifyPayments(parsed.verifier);
  const reason = parsed.reason.trim();
  if (reason.length === 0) throw new CashRejectionNeedsReasonError();

  return getDb().transaction(async (tx: Transaction) => {
    // Unlocked, and used ONLY to find which booking to lock. Its status is
    // deliberately not trusted — the locking re-read below is.
    const [unlocked] = await tx
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(cashRow(parsed.paymentId))
      .limit(1);
    if (!unlocked) throw new CashPaymentNotFoundError(parsed.paymentId);

    // The booking lock FIRST, then the payment row — the same order every
    // path in this file takes. Nothing is written to the booking; the lock
    // is taken so that an approval racing this rejection is serialised
    // rather than both landing.
    const [booking] = await tx
      .select({ ref: bookings.ref, status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, unlocked.bookingId))
      .for('update')
      .limit(1);
    if (!booking) throw new BookingNotFoundError(unlocked.bookingId);

    const [payment] = await tx
      .select({
        status: payments.status,
        amountCentavos: payments.amountCentavos,
        collectedByDriverId: payments.collectedByDriverId,
      })
      .from(payments)
      .where(cashRow(parsed.paymentId))
      .for('update')
      .limit(1);
    if (!payment) throw new CashPaymentNotFoundError(parsed.paymentId);
    if (payment.status !== 'pending') {
      throw new CashPaymentNotPendingError(parsed.paymentId, payment.status);
    }

    await tx
      .update(payments)
      .set({ status: 'rejected', rejectReason: reason })
      .where(eq(payments.id, parsed.paymentId));

    await writeAudit(tx, {
      actorType: 'user',
      actorId: verifiedBy,
      action: 'payment.cash_rejected',
      entity: 'payments',
      entityId: parsed.paymentId,
      data: {
        bookingRef: booking.ref,
        amountCentavos: payment.amountCentavos,
        collectedByDriverId: payment.collectedByDriverId,
        reason,
        priorPaymentStatus: 'pending',
        paymentStatus: 'rejected',
        // Spelled out so nobody has to infer that the booking is untouched.
        bookingStatus: booking.status,
        amountPaidChanged: false,
      },
    });

    return { paymentId: parsed.paymentId, bookingId: unlocked.bookingId, ref: booking.ref };
  });
}
```

`cashRow(id)` is the predicate that makes a row a driver-cash row. If `record-payment.ts` has no such helper yet (the approval path passes `kind: 'cash'` into the shared function), write one and use it in both places so "what counts as a cash row" has one definition:

```ts
/** A driver-cash row, and nothing else: provider manual, method cash, a driver named. */
const cashRow = (id: number) =>
  and(
    eq(payments.id, id),
    eq(payments.type, 'payment'),
    eq(payments.provider, 'manual'),
    eq(payments.method, 'cash'),
    isNotNull(payments.collectedByDriverId),
  );
```

If the approval path already builds this predicate inline, **extract it rather than copying it** — two answers to "is this a cash row" is how a rejection lands on a receipt.

- [ ] **Step 5: Mount the procedure**

In `server/src/routers/admin/bookings.ts`, beside `approveCash`, with `rejectInput`'s shape (reuse the existing `reason` validation if `rejectInput` is already `{ paymentId, reason }`; if it is receipt-specific, declare `rejectCashInput` separately):

```ts
/**
 * Finance or the owner records that cash a driver claimed never arrived
 * (owner decision 2026-10-16, D2).
 *
 * `adminProcedure('verifyPayments')` — the same gate as `approveCash` and
 * the receipt pair, because refusing a claim is that permission being
 * exercised just as much as approving one. Never a dispatcher, and a driver
 * session is not an admin identity at all.
 *
 * **No email.** Nothing is owed to the guest here: the money either never
 * existed or is a conversation with the driver. §11's email set is the
 * owner's to extend, not this task's.
 */
rejectCash: adminProcedure('verifyPayments')
  .input(rejectCashInput)
  .mutation(async ({ input, ctx }) => {
    try {
      const result = await rejectCashPayment({
        paymentId: input.paymentId,
        reason: input.reason,
        verifier: { type: 'user', id: ctx.session.subjectId, role: ctx.session.role },
      });
      return { ref: result.ref };
    } catch (error) {
      throw asTrpcError(error);
    }
  }),
```

Then add `rejectCash` to whichever test enumerates the admin role matrix, so a dispatcher is proven refused at the procedure boundary and not only in the service.

- [ ] **Step 6: Run the server tests**

Run: `pnpm --filter @rg/server test -- cash-reject` then the full `pnpm --filter @rg/server test`
Expected: all green. If `procedure-role-metadata.test.ts` goes red, it is asking for a declaration for the new procedure — give it one; do not weaken the guard.

- [ ] **Step 7: The admin control**

**Use ui-ux-pro-max before writing this markup** (`--domain ux`, "destructive action confirmation" and "error clarity inline validation"), and record the queries in the report.

In `AdminBookingDetailPage.tsx`, inside the existing per-claim `pendingCash.map(...)` panel. The panel's own comment currently explains why there is no reject button — **replace that comment**, do not leave it contradicting the button beside it.

Requirements, each one a test:

- One reason textarea and one reject button **per claim**, keyed by `claim.id`, exactly as the approve button already is. Two claims must be refusable independently.
- The button is disabled while the reason is empty or whitespace, and while the mutation is pending.
- The reason is a required field with a **visible label**, not a placeholder-only one.
- The confirmation names the amount and the driver: "Record that Juan's PHP 4,500 never arrived" — a refusal is a finding about a person, and a vague button is how the wrong claim gets refused.
- Errors render `role="alert"` in amber/`text-brand-error`, never red, and scoped to the claim whose mutation failed (`rejectCash.variables?.paymentId === claim.id`, the pattern `approveCash` already uses).
- Success invalidates the booking detail query so the claim leaves the panel.
- Tap targets 44px (`tap-target`), and the control stacks under the approve button at 360px rather than sitting beside it.

Add to `client/src/__tests__/admin-bookings.test.tsx`: the button is absent for a dispatcher; disabled with an empty reason; sends the trimmed reason; renders the error for the right claim only; two claims reject independently.

- [ ] **Step 8: Prove the tests can fail**

Four mutations, each restored byte-identically:

1. Delete the `if (reason.length === 0) throw` line — the reason test must go red.
2. Change `assertMayVerifyPayments` to return `verifier.id ?? 0` without checking the role — the role test must go red.
3. Add `amountPaidCentavos` to a `bookings` update in the new function — **expect this to fail `pnpm typecheck` or the `schema-conventions` guard** rather than the test; record which, because that guard is what makes the money rule structural.
4. Change the payment update to `.set({ status: 'rejected' })` without `rejectReason` — the audit/reason test must go red.

- [ ] **Step 9: Correct CLAUDE.md**

The Driver portal bullet ends "There is no reject path for a cash claim yet." Replace that sentence with what exists now: who may refuse a claim (owner and finance, `verifyPayments`), that a refusal moves no money and touches no booking column, that the row is kept as `rejected` with its reason, and that a refusal returns the driver's box to `collect_cash` — including the consequence that the driver can then claim again.

- [ ] **Step 10: Five checks, commit, push**

Two commits if the client work is separable: `feat(payments): finance can refuse a cash claim` and `feat(admin): refusing a cash claim on the booking screen`.

---

## Task 3 (D3): an inactive driver's login is indistinguishable from a wrong PIN

**Decision:** D3, owner-decided 2026-10-16. **Pre-flight ruling 3 applies: `driver_inactive` leaves the shared union.**

**The oracle being closed.** Today `attemptDriverLogin` refuses an inactive driver before hashing anything: a `403` with the message `driver_inactive`, answered in about 5ms where a wrong PIN takes about 250ms. Both halves leak. Anyone with a list of driver codes learns which ones are real and which have left the company, by reading the message or by timing the response — and a code that answers _differently_ is a code worth attacking. Measured on the wire, 2026-10-16.

**Files:**

- Modify: `server/src/services/driver-auth.ts` (move the `is_active` branch below the hash; audit the real reason)
- Modify: `shared/src/driver.ts` (`DriverLoginRefusal` loses `driver_inactive`)
- Modify: `client/src/pages/driver/DriverLoginPage.tsx` (the copy map loses its entry — compiler-forced)
- Test: `server/src/__tests__/driver-auth.test.ts` (the existing suite)
- Modify: `CLAUDE.md` (the Driver portal bullet listing the four refusal reasons)

**Interfaces:**

- Consumes: `verifyPassword`, `evaluatePinAttempt`, `writeAudit`, all unchanged.
- Produces: `DriverLoginRefusal = 'wrong_credentials' | 'locked' | 'needs_admin_unlock'`. **This is a narrowing of a shared type** — the client's `Record<DriverLoginRefusal, string>` must lose exactly one key and nothing else.

- [ ] **Step 1: Write the failing tests**

```ts
it('answers an inactive driver EXACTLY as it answers a wrong PIN', async () => {
  const wrong = await attemptDriverLogin({ code: ACTIVE_CODE, pin: '000000', now: NOW });
  const inactive = await attemptDriverLogin({
    code: INACTIVE_CODE,
    pin: INACTIVE_REAL_PIN,
    now: NOW,
  });

  // Deep equality on the whole object, not just the reason — a field
  // present in one and absent in the other is the same oracle in a
  // different shape.
  expect(inactive).toEqual(wrong);
});

it('answers an inactive driver with the CORRECT pin the same way too', async () => {
  // The case that matters: an attacker who knows the PIN must not be able
  // to tell "deactivated" from "wrong PIN".
  const wrongPinOnInactive = await attemptDriverLogin({
    code: INACTIVE_CODE,
    pin: '000000',
    now: NOW,
  });
  const rightPinOnInactive = await attemptDriverLogin({
    code: INACTIVE_CODE,
    pin: INACTIVE_REAL_PIN,
    now: NOW,
  });
  expect(rightPinOnInactive).toEqual(wrongPinOnInactive);
});

it('is byte-identical on the wire, not merely deep-equal in process', async () => {
  const app = createApp();
  const wrong = await request(app)
    .post('/trpc/driver.login')
    .send({ code: ACTIVE_CODE, pin: '000000' });
  const inactive = await request(app)
    .post('/trpc/driver.login')
    .send({ code: INACTIVE_CODE, pin: INACTIVE_REAL_PIN });

  expect(inactive.status).toBe(wrong.status);
  expect(inactive.status).toBe(401);
  // The serialised body, character for character.
  expect(JSON.stringify(inactive.body)).toBe(JSON.stringify(wrong.body));
  // And no Set-Cookie on either.
  expect(inactive.headers['set-cookie']).toBeUndefined();
});

it('pays the hash on the inactive path, so the timing does not answer either', async () => {
  const time = async (code: string, pin: string) => {
    const started = performance.now();
    await attemptDriverLogin({ code, pin, now: NOW });
    return performance.now() - started;
  };
  const wrong = await time(ACTIVE_CODE, '000000');
  const inactive = await time(INACTIVE_CODE, INACTIVE_REAL_PIN);

  // Both must actually hash: scrypt at this repo's OWASP parameters is
  // ~200ms+, and a 5ms answer is the early return this test exists to
  // forbid. The floor is deliberately well under the measured cost so a
  // slower CI box cannot fail it for being slow.
  expect(wrong).toBeGreaterThan(80);
  expect(inactive).toBeGreaterThan(80);
  // And they must be comparable. A generous band: scrypt dominates both,
  // so the difference is the UPDATE the active path also runs.
  expect(Math.abs(inactive - wrong)).toBeLessThan(wrong);
});

it('records the REAL reason in audit_log, where only staff can read it', async () => {
  await attemptDriverLogin({ code: INACTIVE_CODE, pin: INACTIVE_REAL_PIN, now: NOW });

  const rows = await auditRowsFor('driver', inactiveDriverId);
  const row = rows.find((r) => r.action === 'driver.login_inactive');
  expect(row).toBeDefined();
  expect(row!.actorType).toBe('driver');
  expect(row!.actorId).toBe(inactiveDriverId);
  // Never the PIN, nor anything PIN-shaped.
  expect(JSON.stringify(row!.data)).not.toMatch(/\d{6}/);
});

it('does not touch the inactive driver lockout counters', async () => {
  const before = await driverRow(inactiveDriverId);
  for (let i = 0; i < 6; i += 1) {
    await attemptDriverLogin({ code: INACTIVE_CODE, pin: '000000', now: NOW });
  }
  const after = await driverRow(inactiveDriverId);
  // A driver who left the company must not be able to lock out the code a
  // new hire might later be given — the rule the old early return kept, and
  // which this change must preserve.
  expect(after.failedAttempts).toBe(before.failedAttempts);
  expect(after.lockedUntil).toEqual(before.lockedUntil);
  expect(after.lockoutCount).toBe(before.lockoutCount);
  expect(after.requiresAdminUnlock).toBe(before.requiresAdminUnlock);
});

it('leaves no way to send driver_inactive over the wire', () => {
  // The type-level half of this is `pnpm typecheck`; this is the runtime
  // half, over the whole module's source.
  const source = readFileSync(resolve(__dirname, '../services/driver-auth.ts'), 'utf8');
  expect(source).not.toMatch(/reason:\s*'driver_inactive'/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- driver-auth`
Expected: the equality, wire, timing and audit tests fail. The counters test passes already and must still pass at the end.

- [ ] **Step 3: Move the branch below the hash**

In `attemptDriverLogin`, replace the early return at step 2 with a flag, and act on it after the verify:

```ts
// 2. A soft-deleted driver is NOT refused here any more (owner decision
//    2026-10-16, D3). Refusing before the hash answered in ~5ms where a
//    wrong PIN takes ~250ms, and with its own message — so both the
//    body and the clock told anyone holding a list of driver codes
//    which ones had left the company. The flag is carried past the
//    hash instead, and the refusal below is the wrong-credentials one,
//    byte for byte.
const inactive = !row.isActive;

// 3. ALWAYS, even when locked, and now also when inactive. See the
//    module note — this is the cost that makes every refusal cost the
//    same.
const pinOk = await verifyPassword(input.pin, row.pinHash);

if (inactive) {
  /*
   * The real reason goes to `audit_log` and nowhere else: an admin
   * reading the trail must be able to see that a departed driver is
   * still trying to sign in — that is a real operational signal — while
   * the person at the keypad learns only "that did not work".
   *
   * The lockout counters are deliberately untouched, which is the one
   * thing the old early return got right: a driver who left must not be
   * able to lock out the code a new hire might later be given. So this
   * returns BEFORE `evaluatePinAttempt` is consulted, and writes no
   * `drivers` update at all.
   *
   * `pinOk` is recorded because "a departed driver still knows their
   * PIN" and "someone is guessing at a departed driver's code" are
   * different events, and an admin investigating wants to tell them
   * apart. It is a boolean; the PIN itself never reaches this row.
   */
  await writeAudit(tx, {
    actorType: 'driver',
    actorId: row.id,
    action: 'driver.login_inactive',
    entity: 'driver',
    entityId: row.id,
    data: { code: row.code, pinCorrect: pinOk },
  });
  return { kind: 'refused', reason: 'wrong_credentials' };
}
```

Delete the `'driver_inactive'` case from the `Verdict` type if it names reasons explicitly, and update the module header's numbered list (step 2 currently reads "refuse `driver_inactive` if `is_active = 0`").

- [ ] **Step 4: Narrow the shared union**

In `shared/src/driver.ts`, remove `| 'driver_inactive'` and document why — a reader must not re-add it thinking it was an oversight:

```ts
/**
 * Why a driver login was refused, as the `message` the client reads.
 *
 * **There is deliberately no `driver_inactive`** (owner decision
 * 2026-10-16, D3). A deactivated driver is answered as `wrong_credentials`,
 * in the same 401 with the same body and a comparable hash cost, because a
 * distinguishable refusal told anyone holding a list of driver codes which
 * ones had left the company. The real reason is written to `audit_log` as
 * `driver.login_inactive`, where only staff can read it.
 *
 * Do not add it back to make a screen more helpful: the screen has nothing
 * helpful to say that would not also be said to an attacker.
 */
export type DriverLoginRefusal = 'wrong_credentials' | 'locked' | 'needs_admin_unlock';
```

- [ ] **Step 5: Let the compiler clean the client**

Run `pnpm typecheck`. `DriverLoginPage.tsx`'s `Record<DriverLoginRefusal, string>` now has a surplus key and fails to compile — delete the `driver_inactive` entry. That failure is the mechanism: the copy map is how a driver learns what happened, and a key the server can never send is a sentence nobody can ever read.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @rg/server test` and `pnpm --filter @rg/client test`
Expected: green. Any test asserting the old `driver_inactive` refusal now asserts a reversed decision — rewrite it to assert indistinguishability, and say so in the report.

- [ ] **Step 7: Prove the tests can fail**

Three mutations:

1. Restore the early return above `verifyPassword` (keeping `wrong_credentials`) — the **timing** test must go red while the equality tests stay green. That is the proof the timing test is the one carrying this property, and the reason it exists.
2. Return `reason: 'driver_inactive'` — the wire test and the source-scan test must go red.
3. Delete the `writeAudit` call — the audit test must go red.

Restore each byte-identically. Record the measured milliseconds for mutation 1 in the report (the oracle's actual size).

- [ ] **Step 8: Correct CLAUDE.md**

The bullet beginning "**Every login refusal's `message` IS the reason string**" lists four reasons including `driver_inactive` and says the other three are 403. Rewrite it: three reasons, `wrong_credentials` is 401 and now covers a deactivated driver as well as a wrong code or PIN, the real reason is `driver.login_inactive` in `audit_log`, and the hash is paid on every path so the timing says nothing either.

- [ ] **Step 9: Five checks, commit, push**

`fix(driver-auth): a departed driver's code tells an attacker nothing`

---

## Task 4 (D4): deactivating a driver ends their sessions

**Decision:** D4, owner-decided 2026-10-16.

**The gap.** `requireDriver` reads the session and never re-reads `drivers.is_active`, and `readSession`'s live-role join is on `users` only — so a driver deactivated mid-shift keeps up to twelve hours of access. Measured on the wire 2026-10-16: `is_active = 0`, same cookie, `driver.trips` still answered 200. Staff deactivation is immediate by contrast, which makes this an inconsistency as well as a gap.

**The chosen fix is revocation at the write, not a re-read on every request.** A live `is_active` join on every driver request would cost a second query on the hottest path in the portal, and would still be a window if the join were ever dropped. Deleting the rows closes it at the one moment the state changes.

**And the act of deactivating has to be built first** — pre-flight ruling 6. `drivers.is_active` is written by no mutation today: `driverInputSchema` excludes it, `toUpdateValues` does not map it, and there is no `admin.drivers.setActive` to match vans' `admin.vans.setStatus`. So this task adds that mutation and hangs the revocation off it.

**Files:**

- Modify: `shared/src/dispatch.ts` (the `setActive` input schema, beside `vanStatusInput`'s equivalent)
- Modify: `server/src/services/sessions.ts` (add `revokeSessionsForSubject`)
- Create in: `server/src/routers/admin/drivers.ts` (`setActive`, modelled on `admin.vans.setStatus` at `routers/admin/vans.ts:126`+, revoking in the same transaction)
- Modify: `client/src/pages/admin/AdminDriversPage.tsx` (a control for it, with the consequence stated in words)
- Modify: `server/src/services/dispatch/alerts.ts` (the unassigned-trips alert also counts a trip whose assigned driver is now inactive)
- Test: `server/src/__tests__/driver-deactivation.test.ts` (new)
- Test: `server/src/__tests__/dispatch-alerts.test.ts` (the existing alerts suite)
- Modify: `CLAUDE.md` (the bullet beginning "**`requireDriver` reads the session**")

**Interfaces:**

- Consumes: `Transaction` from `../db/client`, `sessions` from `../db/schema`.
- Produces:

  ```ts
  /**
   * Deletes every session row for one subject, inside the caller's
   * transaction. Returns how many were deleted.
   */
  export async function revokeSessionsForSubject(
    tx: Transaction,
    subjectType: SessionSubject,
    subjectId: number,
  ): Promise<number>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('the next request after deactivation is UNAUTHORIZED', async () => {
  const app = createApp();
  const login = await request(app).post('/trpc/driver.login').send({ code: CODE, pin: PIN });
  const cookie = login.headers['set-cookie'];
  // Proof the cookie worked BEFORE, or the test proves nothing.
  await request(app).get('/trpc/driver.trips').set('Cookie', cookie).expect(200);

  await callAdmin('admin.drivers.update', { id: driverId, patch: { isActive: false } }, OWNER);

  const after = await request(app).get('/trpc/driver.trips').set('Cookie', cookie);
  expect(after.status).toBe(401);
  expect(after.body.error?.data?.code).toBe('UNAUTHORIZED');
});

it('deletes every session that driver had, and only theirs', async () => {
  const mine = [
    await createSession('driver', driverId, NOW),
    await createSession('driver', driverId, NOW),
  ];
  const otherDriver = await createSession('driver', otherDriverId, NOW);
  const staff = await createSession('user', ownerUserId, NOW);

  await callAdmin('admin.drivers.update', { id: driverId, patch: { isActive: false } }, OWNER);

  expect(await sessionCount('driver', driverId)).toBe(0);
  expect(await readSession(otherDriver.token, NOW)).not.toBeNull();
  expect(await readSession(staff.token, NOW)).not.toBeNull();
  // A `user` row whose id happens to equal the driver's id is untouched —
  // `subject_id` is polymorphic, so the type is half of the key.
  expect(await sessionCount('user', driverId)).toBe(await sessionCountBefore('user', driverId));
});

it('revokes in the SAME transaction as the write: a failed update revokes nothing', async () => {
  const session = await createSession('driver', driverId, NOW);
  // A patch that violates the unique index on `code` — the transaction
  // rolls back after the session delete would have run.
  await expect(
    callAdmin(
      'admin.drivers.update',
      { id: driverId, patch: { isActive: false, code: TAKEN_CODE } },
      OWNER,
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' });

  expect(await readSession(session.token, NOW)).not.toBeNull();
  expect((await driverRow(driverId)).isActive).toBe(true);
});

it('revokes nothing when the patch does not deactivate', async () => {
  const session = await createSession('driver', driverId, NOW);
  await callAdmin(
    'admin.drivers.update',
    { id: driverId, patch: { name: 'Juan Dela Cruz' } },
    OWNER,
  );
  expect(await readSession(session.token, NOW)).not.toBeNull();

  // And REACTIVATING does not revoke either — there is nothing to revoke,
  // and a reactivation must not log out a driver who is already back.
  await callAdmin('admin.drivers.update', { id: driverId, patch: { isActive: true } }, OWNER);
  expect(await readSession(session.token, NOW)).not.toBeNull();
});

it('audits how many sessions it ended', async () => {
  await createSession('driver', driverId, NOW);
  await createSession('driver', driverId, NOW);
  await callAdmin('admin.drivers.update', { id: driverId, patch: { isActive: false } }, OWNER);

  const row = (await auditRowsFor('driver', driverId)).find((r) => r.action === 'driver_updated');
  expect(row!.data).toMatchObject({ isActive: false, sessionsRevoked: 2 });
});
```

In `dispatch-alerts.test.ts`:

```ts
it('counts a future trip whose assigned driver has been deactivated', async () => {
  // Assigned, both van and driver set — so the old query saw nothing wrong.
  const bookingId = await assignedBookingOn(FUTURE_DATE, { vanId, driverId });
  expect(await unassignedTrips(getDb(), NOW)).toEqual([]);

  await deactivate(driverId);

  const alerts = await unassignedTrips(getDb(), NOW);
  expect(alerts.map((a) => a.bookingId)).toContain(bookingId);
});

it('does NOT count a PAST trip whose driver was deactivated', async () => {
  // A finished trip needs no new driver. The alert is about work still to do.
  const bookingId = await assignedBookingOn(PAST_DATE, { vanId, driverId });
  await deactivate(driverId);
  expect((await unassignedTrips(getDb(), NOW)).map((a) => a.bookingId)).not.toContain(bookingId);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- driver-deactivation dispatch-alerts`
Expected: the revocation tests fail (the cookie still works), and the two alert tests fail.

- [ ] **Step 3: Add the session revoker**

In `server/src/services/sessions.ts`:

```ts
/**
 * Ends every session one subject holds — "log this driver out everywhere"
 * (owner decision 2026-10-16, D4).
 *
 * Takes the CALLER'S transaction rather than opening its own, which is the
 * whole point: the revocation and the state change that justifies it commit
 * together or not at all. A revocation in its own transaction would log a
 * driver out of a deactivation that then rolled back on a duplicate code —
 * and a driver locked out of a job they still hold, at a pier, is a worse
 * failure than the one this closes.
 *
 * `subject_id` is polymorphic (`schema.ts`), so the TYPE is half of the key:
 * `drivers.id = 7` and `users.id = 7` are different subjects, and
 * `sessions_subject_idx` is on the pair for exactly this query.
 *
 * Returns the count so the caller can audit it. Zero is an ordinary answer
 * — a driver who was not signed in anywhere.
 */
export async function revokeSessionsForSubject(
  tx: Transaction,
  subjectType: SessionSubject,
  subjectId: number,
): Promise<number> {
  const [result] = await tx
    .delete(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)));
  return result.affectedRows;
}
```

`affectedRows` is safe to read as a true count here, unlike on an UPDATE: `CLIENT_FOUND_ROWS` changes what an UPDATE reports (matched, not changed) and has no bearing on a DELETE. Say so in a comment — this repo has been bitten by that distinction.

- [ ] **Step 4: Call it from the one place that deactivates**

In `admin/drivers.ts`'s `update` mutation, inside the existing transaction, after the `drivers` update and before the audit write:

```ts
/*
 * Deactivation ends every session that driver holds, in THIS
 * transaction (owner decision 2026-10-16, D4). Until this existed,
 * `requireDriver` read the session and never re-read `is_active`,
 * so a driver deactivated mid-shift kept up to twelve hours of
 * access — measured on the wire, 2026-10-16.
 *
 * `=== false` and not `!input.patch.isActive`: the patch is
 * partial, so `undefined` means "not changing this" and must not
 * be read as "deactivate".
 */
const sessionsRevoked =
  input.patch.isActive === false ? await revokeSessionsForSubject(tx, 'driver', input.id) : 0;
```

and add `sessionsRevoked` to the audit `data` beside `input.patch`.

- [ ] **Step 5: Make their future trips read as needs-assignment**

`unassignedSoon` (`alerts.ts:119`) needs **two** changes, not one — pre-flight ruling 7. Its status filter is `eq(bookings.status, 'confirmed')`, and assignment moves a booking to `assigned`, so a booking whose driver was just deactivated is `assigned` and the inactive-driver term alone would never fire. Widen the status set as well, and `LEFT JOIN drivers`:

```ts
        inArray(bookings.status, ['confirmed', 'assigned']),
        sql`${bookings.tourDate} >= ${today}`,
        onOrBefore(bookings.tourDate, windowEnd),
        /*
         * A trip whose driver has been DEACTIVATED needs assigning, even
         * though `driver_id` is set (owner decision 2026-10-16, D4).
         * Deactivation does not clear `bookings.driver_id` — deliberately,
         * because that id is the record of who was assigned and an audit
         * trail that forgets is not one — so the alert asks about the
         * driver's state rather than the column's nullity.
         *
         * `assigned` joins `confirmed` in the status filter for the same
         * decision, and it changes no count on a healthy fleet: an
         * `assigned` booking has BOTH ids by construction, so the only term
         * it can match is this one. The test below pins exactly that.
         */
        or(isNull(bookings.vanId), isNull(bookings.driverId), eq(drivers.isActive, false)),
```

The `LEFT JOIN drivers` matters: an `innerJoin` would drop every booking with a null `driver_id`, which is the alert's original and most important case.

Add the safety test: **on a healthy fleet, adding `assigned` to the status set changes no count.** Create an `assigned` booking with a live van and a live driver and assert the alert does not list it.

```ts
      /*
       * A trip whose driver has been DEACTIVATED is a trip that needs
       * assigning, even though `driver_id` is set (owner decision
       * 2026-10-16, D4). Deactivation does not clear `bookings.driver_id`
       * — deliberately, because that id is the record of who was assigned
       * and an audit trail that forgets is not one — so the alert asks
       * about the driver's state rather than the column's nullity.
       */
      or(isNull(bookings.vanId), isNull(bookings.driverId), eq(drivers.isActive, false)),
```

Confirm what the existing alert's shape is before editing and keep its `DashboardAlert` kind; this widens a predicate and adds no new alert type.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @rg/server test`
Expected: green. Watch for suites that deactivate a driver as fixture teardown and then reuse a session — they will now be logged out and must create a new one.

- [ ] **Step 7: Prove the tests can fail**

1. Move `revokeSessionsForSubject` outside the transaction (into the router body after `getDb().transaction(...)` resolves) — the rollback test must go red.
2. Change `input.patch.isActive === false` to `!input.patch.isActive` — the "revokes nothing when the patch does not deactivate" test must go red on the name-only patch.
3. Drop the `subjectType` term from the delete's `where` — the "only theirs" test must go red on the staff session.
4. Revert the alerts predicate — both new alert tests must go red.

- [ ] **Step 8: Correct CLAUDE.md**

Rewrite the bullet that currently records the twelve-hour window as "deliberate-by-default and an open owner decision". The new text: deactivation deletes every session for that driver in the same transaction as the write (D4, 2026-10-16); `requireDriver` still does not re-read `is_active`, **and that is now sufficient rather than a gap** — but state the residue plainly: a driver deactivated by a direct `UPDATE drivers` in SQL, bypassing the mutation, keeps their session, so the invariant is "the mutation revokes", not "an inactive driver cannot be authenticated".

- [ ] **Step 9: Five checks, commit, push**

`feat(admin): deactivating a driver signs them out everywhere`

---

## Task 5 (D5): a daily check for vans left on_trip

**Decision:** D5, owner-decided 2026-10-16. **Pre-flight ruling 4 applies: this is an alert, never a status change.**

**The gap it makes visible.** A driver whose phone dies at the last stop, or who simply forgets to complete, leaves `vans.status = 'on_trip'`. That column is not date-scoped, so the van is refused on **every future date at once** — and the symptom arrives weeks later as "we're fully booked" on a day with idle vans, with nothing in the logs to explain it. `CLAUDE.md` has carried this as a KNOWN GAP since Week 6.

**What this task does and does not do.** It makes the state visible in two places — a dashboard alert and a daily log line — and changes no van's status, ever. The owner's instruction is explicit, and the reason is sound: a sweep that frees a van automatically would, on the one day a trip genuinely overran, put a van with guests in it back on sale.

**Files:**

- Modify: `shared/src/` (the `DashboardAlert` union gains a kind — find it with `grep -rn "DashboardAlert" shared/src`)
- Modify: `server/src/services/dispatch/alerts.ts` (add `orphanedOnTripVans`)
- Modify: the admin dashboard router that assembles the five alerts (find it with `grep -rn "vansInRepair" server/src/routers`)
- Create: `server/src/jobs/orphaned-vans.ts`
- Modify: `server/src/jobs/index.ts` (schedule it daily)
- Modify: `client/src/pages/admin/AdminDashboardPage.tsx`
- Test: `server/src/__tests__/orphaned-vans.test.ts` (new)
- Test: `client/src/__tests__/admin-dashboard.test.tsx` (the existing suite)
- Modify: `CLAUDE.md` (the KNOWN GAP paragraph in Dispatch)

**Interfaces:**

- Produces:

  ```ts
  /**
   * Vans sitting in `on_trip` with no `in_progress` booking to explain it.
   * Takes no `now`: "is there a running trip for this van" is a question
   * about state, not about the clock — the same narrowing `vansInRepair`
   * and `paymentsToVerify` already make.
   */
  export async function orphanedOnTripVans(db: Database | Transaction): Promise<OrphanedVanAlert[]>;

  /** The job. Logs and returns what it found; changes nothing. */
  export async function checkOrphanedVans(now: Date): Promise<{ found: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('finds a van left on_trip by a trip nobody completed', async () => {
  const bookingId = await startedTripOn(YESTERDAY, { vanId, driverId });
  // The trip is in_progress, so the van is legitimately on_trip.
  expect(await orphanedOnTripVans(getDb())).toEqual([]);

  // The booking moves on without the van being released — exactly what a
  // dead phone at the last stop leaves behind. Written directly, because no
  // code path produces it: that is the gap.
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['completed', bookingId]);

  const found = await orphanedOnTripVans(getDb());
  expect(found.map((v) => v.vanId)).toEqual([vanId]);
  expect(found[0]).toMatchObject({ plate: PLATE, lastBookingRef: REF });
});

it('leaves a van on a RUNNING trip alone', async () => {
  await startedTripOn(TODAY, { vanId, driverId });
  expect(await orphanedOnTripVans(getDb())).toEqual([]);
});

it('ignores vans in every other status', async () => {
  for (const status of ['available', 'for_repair', 'inactive'] as const) {
    await setVanStatus(vanId, status);
    expect(await orphanedOnTripVans(getDb())).toEqual([]);
  }
});

it('CHANGES NOTHING — the van is still on_trip after the check', async () => {
  const bookingId = await startedTripOn(YESTERDAY, { vanId, driverId });
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['completed', bookingId]);
  const before = await vanRow(vanId);

  await checkOrphanedVans(NOW);

  const after = await vanRow(vanId);
  expect(after.status).toBe('on_trip');
  // `updated_at` only advances when a write MATCHES, so an unchanged
  // timestamp is positive proof no UPDATE landed on this row.
  expect(after.updatedAt).toEqual(before.updatedAt);
});

it('writes no audit row: an observation is not an event', async () => {
  const before = await auditCount();
  await checkOrphanedVans(NOW);
  expect(await auditCount()).toBe(before);
});

it('reports zero on a healthy fleet, and says nothing', async () => {
  const logged = vi.spyOn(console, 'warn');
  expect(await checkOrphanedVans(NOW)).toEqual({ found: 0 });
  expect(logged).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- orphaned-vans`
Expected: fails at import.

- [ ] **Step 3: Write the query**

In `alerts.ts`, following the file's existing shape — one exported function per alert, a legible query rather than a clever union:

```ts
/**
 * BUILD_SPEC §9's sixth dashboard alert, added by owner decision
 * 2026-10-16 (D5): **a van sitting in `on_trip` with no running trip to
 * explain it.**
 *
 * `vans.status` is not date-scoped, so a van left here is refused on every
 * future date at once (`VAN_STATUS_SELLABLE`, CLAUDE.md's Dispatch
 * section). Nothing in the system puts it back: `startTrip` sets `on_trip`
 * and only a completion, or an admin cancellation of a running trip, clears
 * it. A driver whose phone dies at the last stop therefore removes a van
 * from sale indefinitely, and the symptom arrives weeks later as "we are
 * fully booked" on a day with idle vans.
 *
 * **This function is an OBSERVATION and the alert is the whole fix.**
 * Nothing here or in `jobs/orphaned-vans.ts` writes a van status, and that
 * is the owner's instruction, not an omission: on the one day a trip
 * genuinely overruns past midnight, an automatic sweep would put a van with
 * guests in it back on sale. A dispatcher looking at the alert knows which
 * of the two it is; a cron job never can.
 *
 * No `now`. "Is there an `in_progress` booking for this van" is a question
 * about state, not about the clock — the same narrowing `vansInRepair` and
 * `paymentsToVerify` already make, and giving this a `now` it never read
 * would tell the next reader the clock matters here.
 *
 * The last booking is reported for the dispatcher's benefit — "which trip
 * was this?" is the first question they will ask — and it is the most
 * recent booking naming this van, by tour date, whatever its status. Not a
 * guess at which one stranded it: that booking may since have been
 * cancelled, completed or edited, so the row is a lead rather than a claim.
 */
export async function orphanedOnTripVans(db: Database | Transaction): Promise<OrphanedVanAlert[]> {
  // ... SELECT vans WHERE status = 'on_trip' AND NOT EXISTS (
  //       SELECT 1 FROM bookings b WHERE b.van_id = vans.id AND b.status = 'in_progress'
  //     ), left-joined to the most recent booking for the ref, ordered by
  //     vans.updated_at ASC so the longest-stranded van is first.
}
```

Write the real query with Drizzle's `notExists` / a correlated subquery; keep it one statement plus at most one for the ref lookup. **Do not loop a query per van** — `alerts.ts` has an N+1 guard discipline, and `server/src/__tests__` already counts statements for some of these.

`'on_trip'` must come from the shared van-status constants, never a bare string, and the "not sellable" relationship to `VAN_STATUS_SELLABLE` should be noted rather than re-derived.

- [ ] **Step 4: Write the job**

`server/src/jobs/orphaned-vans.ts`, mirroring `expire-holds.ts`'s discipline: the clock is a parameter, the module exports a plain async function, scheduling lives in `index.ts`, and importing it starts nothing.

```ts
/**
 * The daily orphaned-van check (owner decision 2026-10-16, D5).
 *
 * **It changes nothing.** It asks `orphanedOnTripVans()` and logs what it
 * finds, so that a van removed from sale by a trip nobody completed shows up
 * within a day instead of surfacing weeks later as a mysteriously full
 * calendar. The dashboard alert is the surface a dispatcher sees; this is
 * the one an operator greps at 2am.
 *
 * Why a log line AND an alert: the alert needs somebody to open the
 * dashboard, and the failure this catches is precisely the kind nobody is
 * looking for. A dated log line is also what makes "how long has that van
 * been stuck?" answerable after the fact.
 *
 * `now` is a parameter and is used only in the log line, so the job can be
 * called directly in a test without waiting on a timer — the same contract
 * `expireHolds(now)` keeps.
 */
export async function checkOrphanedVans(now: Date): Promise<{ found: number }> {
  const stranded = await orphanedOnTripVans(getDb());
  if (stranded.length > 0) {
    // `console.warn`, not `error`: nothing is broken, a human needs to look.
    // Plates and refs only — never a guest name (RA 10173).
    console.warn(
      `[jobs] orphaned-vans: ${stranded.length} van(s) sitting in on_trip with no running trip ` +
        `as of ${now.toISOString()} — ${stranded.map((v) => v.plate).join(', ')}. ` +
        'Nothing has been changed; a dispatcher must complete or correct each trip.',
    );
  }
  return { found: stranded.length };
}
```

In `jobs/index.ts`, add the schedule beside `expire-holds`. Pick **07:00 Asia/Manila** — before the first departures, so a dispatcher starting their day sees it — and pass node-cron's `timezone` option explicitly rather than assuming the server's zone. Wrap the callback in the same try/catch the existing job uses: a job that throws into the scheduler takes the API process down with it.

- [ ] **Step 5: The dashboard alert**

**Use ui-ux-pro-max first** (`--domain ux`, "alert severity hierarchy" / "status communication"), and record the queries.

The alert's copy must carry its meaning in words, never in colour: a heading naming the van, how long it has been stranded in plain language ("since Tuesday"), and the one sentence that makes it actionable — that this van is refused on **every** future date until someone completes or corrects the trip. Amber, never red. The existing five alerts set the pattern; follow it rather than inventing a sixth look.

The client test asserts: the alert renders with its plate and the every-future-date sentence; it is absent when the list is empty; and the words are present independent of any colour class.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @rg/server test` and `pnpm --filter @rg/client test`
Expected: green — **including `trip-van-status.test.ts`'s last test**, which pins "nothing sweeps a van left `on_trip`". Pre-flight ruling 4: that test must still pass, because this task adds no sweep. If it goes red, something here changed a status and must be reverted.

- [ ] **Step 7: Prove the tests can fail**

1. Drop the `NOT EXISTS` term — the "leaves a running trip alone" test must go red.
2. Widen the status filter to every status — the "ignores vans in every other status" test must go red.
3. Add `await setVanStatus(van.id, 'available')` inside the job — the "CHANGES NOTHING" test must go red **and so must `trip-van-status.test.ts`**. Record both: that is the proof the two tests together are what hold the owner's "never auto-change status" instruction.

- [ ] **Step 8: Correct CLAUDE.md**

The KNOWN GAP paragraph says the symptom arrives "with nothing in the logs" and lists two candidate fixes needing an owner decision. Rewrite it: the decision was made (D5, 2026-10-16) — a daily check at 07:00 Manila plus a dashboard alert, and **no automatic status change**, with the reasoning. State what is still manual: a human completes or corrects the trip. Keep the sentence telling future readers that `trip-van-status.test.ts`'s last test pins the no-sweep rule, and correct the part that says building the sweep reddens it — the alert does not.

- [ ] **Step 9: Five checks, commit, push**

`feat(dispatch): a daily look for vans no trip ever released`

---

## Task 6 (D6): office notes a driver may not read

**Decision:** D6, owner-decided 2026-10-16. **Pre-flight ruling 5 applies: this task also builds the note writer, because nothing writes this table today.**

**The problem.** `driver.trip` returns every row of `booking_notes` for the trip, text only, oldest first. There is no visibility column, so there is no such thing as an office-eyes-only note — and the office has no way to record "the guest disputed the price, do not discuss it" without the driver reading it.

**Files:**

- Modify: `server/src/db/schema.ts` (`bookingNotes.visibleToDriver`)
- Create: `server/src/db/migrations/0012_*.sql` (generated, never hand-written)
- Modify: `server/src/routers/public/driver.ts` (filter the notes read)
- Modify: `server/src/routers/admin/bookings.ts` (select the flag; add `addNote`)
- Modify: `shared/src/` (the note input schema — place it beside the other booking schemas)
- Modify: `client/src/pages/admin/AdminBookingDetailPage.tsx`
- Test: `server/src/__tests__/booking-notes.test.ts` (new)
- Test: `client/src/__tests__/admin-bookings.test.tsx`
- Modify: `CLAUDE.md` (the bullet beginning "**`booking_notes` text is fully visible to drivers**")

**Interfaces:**

- Produces:
  - `bookingNotes.visibleToDriver: boolean` — `NOT NULL DEFAULT false`.
  - `admin.bookings.addNote({ bookingId: number, note: string, visibleToDriver: boolean })` under the same role gate the booking detail uses.
  - `admin.bookings.detail`'s notes gain `visibleToDriver: boolean`.
  - `driver.trip`'s `officeNotes` shape is **unchanged** — still `string[]`. The client learns nothing about the flag, because a driver has no use for "there are notes you cannot see", and telling them is worse than not.

- [ ] **Step 1: Write the failing tests**

```ts
it('an unflagged note NEVER reaches the driver API', async () => {
  await addNote(
    { bookingId, note: 'Guest disputed the price — do not discuss.', visibleToDriver: false },
    OWNER,
  );
  await addNote({ bookingId, note: 'Waiting at the second gate.', visibleToDriver: true }, OWNER);

  const detail = await driverTripDetail(driverId, bookingId);
  expect(detail.officeNotes).toEqual(['Waiting at the second gate.']);
  // Not merely absent from the array — absent from the whole payload, in
  // case a later field carries notes too.
  expect(JSON.stringify(detail)).not.toMatch(/disputed the price/);
});

it('defaults to invisible, so a note written by anything that forgets the flag is private', async () => {
  // A raw insert — a migration, a seed, a hand-written UPDATE at 2am.
  await getPool().query('INSERT INTO booking_notes (booking_id, user_id, note) VALUES (?, ?, ?)', [
    bookingId,
    ownerUserId,
    'Written with no flag at all.',
  ]);
  const detail = await driverTripDetail(driverId, bookingId);
  expect(detail.officeNotes).toEqual([]);
});

it('the column is NOT NULL DEFAULT 0 in the database, not only in Drizzle', async () => {
  const [[column]] = await getPool().query(
    `SELECT IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_notes' AND COLUMN_NAME = 'visible_to_driver'`,
  );
  expect(column).toMatchObject({ IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' });
});

it('the admin detail shows every note WITH its visibility', async () => {
  await addNote({ bookingId, note: 'Private.', visibleToDriver: false }, OWNER);
  await addNote({ bookingId, note: 'Shared.', visibleToDriver: true }, OWNER);
  const detail = await adminBookingDetail(bookingId, OWNER);
  expect(detail.notes).toEqual([
    expect.objectContaining({ note: 'Shared.', visibleToDriver: true }),
    expect.objectContaining({ note: 'Private.', visibleToDriver: false }),
  ]);
});

it('records who wrote the note, and audits it', async () => {
  const { id } = await addNote({ bookingId, note: 'A note.', visibleToDriver: true }, FINANCE);
  const row = await noteRow(id);
  expect(row.userId).toBe(financeUserId);

  const audit = (await auditRowsFor('bookings', bookingId)).find(
    (r) => r.action === 'booking.note_added',
  );
  expect(audit!.data).toMatchObject({ noteId: id, visibleToDriver: true });
  // The note TEXT is not duplicated into the audit payload: it is already
  // stored, and audit rows are exported in reports.
  expect(JSON.stringify(audit!.data)).not.toMatch(/A note\./);
});

it('refuses an empty note, a whitespace note, and a driver', async () => {
  for (const note of ['', '   ']) {
    await expect(addNote({ bookingId, note, visibleToDriver: true }, OWNER)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  }
  await expect(
    addNote({ bookingId, note: 'No.', visibleToDriver: true }, DRIVER_CALLER),
  ).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

it('refuses a note on a booking that does not exist, writing nothing', async () => {
  const before = await noteCount();
  await expect(
    addNote({ bookingId: 9_999_999, note: 'x', visibleToDriver: true }, OWNER),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(await noteCount()).toBe(before);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- booking-notes`
Expected: fails — no column, no mutation.

- [ ] **Step 3: Add the column and generate the migration**

In `schema.ts`, in `bookingNotes`:

```ts
    /**
     * Whether the driver on this trip may read this note (owner decision
     * 2026-10-16, D6).
     *
     * **Default FALSE, and that direction is the whole point.** Until this
     * column existed, `driver.trip` returned every note on the booking —
     * so the office had nowhere to record "the guest disputed the price"
     * that the driver would not read at the pickup. A default of `true`
     * would have made every note written by anything that does not know
     * about this column (a migration, a seed, a hand-written INSERT)
     * visible in a van, which is the failure this exists to prevent.
     *
     * `NOT NULL` so there is no third state. A nullable flag would make
     * "nobody decided" indistinguishable from "decided no" in every query,
     * and the two would drift.
     */
    visibleToDriver: boolean('visible_to_driver').notNull().default(false),
```

Then:

```bash
pnpm --filter @rg/server db:generate
pnpm --filter @rg/server db:migrate
```

**Read the generated SQL before committing it.** It must be exactly one `ALTER TABLE booking_notes ADD ...` and nothing else; if Drizzle has decided to rewrite an unrelated table, stop and report rather than applying it. Commit the migration file as generated — never hand-edit it.

- [ ] **Step 4: Filter the driver's read**

In `public/driver.ts`'s notes query, add the term and the reason:

```ts
    .where(
      and(
        eq(bookingNotes.bookingId, bookingId),
        /*
         * §8's "Office notes", and ONLY the ones the office marked for the
         * driver (owner decision 2026-10-16, D6). The filter is in the
         * WHERE, not a `.filter()` on the result: a note the driver may not
         * read must not travel to the browser at all, where it would sit in
         * a network response and a React cache regardless of what renders.
         */
        eq(bookingNotes.visibleToDriver, true),
      ),
    )
```

- [ ] **Step 5: Add the writer**

`admin.bookings.addNote`, with the same role gate `admin.bookings.detail` uses (check which `adminProcedure(...)` key that is — a note is part of the booking record, so it is that permission and not `verifyPayments`). One transaction: verify the booking exists, insert the note with `userId` from the session, write a `booking.note_added` audit row. Zod: `note` trimmed, `min(1).max(...)` matching the column, `visibleToDriver` a **required** boolean — not defaulted, because the caller must state the decision rather than inherit one.

Add the input schema to `/shared` beside the other booking schemas, per CLAUDE.md.

- [ ] **Step 6: The admin UI**

**Use ui-ux-pro-max first** (`--domain ux`, "visible labels helper text" and "progressive disclosure"), and record the queries.

- A note form on the booking detail: a labelled textarea, a **checkbox labelled "Show this note to the driver"**, and a helper line stating the default in words — notes are office-only unless this is ticked.
- Every existing note renders its visibility **in words**, not by a colour or an icon alone: "Driver can see this" / "Office only". This is the WCAG 1.4.1 rule and also the practical one — an admin must be able to tell at a glance which notes the driver is reading.
- 44px tap targets, including the checkbox's clickable label. AA contrast. No red.
- The submit button is disabled on an empty note and while pending; success clears the textarea and resets the checkbox to **unticked** (the safe default, re-asserted after every write).

Client tests: the checkbox defaults unticked; submitting sends `visibleToDriver: false` when untouched and `true` when ticked; each note's visibility is readable as text; the form is absent for a role that may not write notes.

- [ ] **Step 7: Run everything, prove the tests can fail**

Run: `pnpm --filter @rg/server test` and `pnpm --filter @rg/client test`

Mutations:

1. Remove the `visibleToDriver` term from the driver's WHERE — the first test must go red.
2. Change the column default to `.default(true)`, regenerate **into a scratch file only** (do not apply), and instead simulate by raw-inserting with `visible_to_driver = 1` — confirm the default test is actually reading the database and not Drizzle's opinion.
3. Make `visibleToDriver` optional in the input schema with a `true` default — the client test asserting an untouched checkbox sends `false` must go red.

- [ ] **Step 8: Correct CLAUDE.md**

Replace the bullet claiming full visibility and an open decision with the settled rule: there is a `visible_to_driver` flag, default FALSE, the driver's read filters on it in SQL, the admin states the decision per note, and the driver is deliberately **not** told that invisible notes exist. Note that `admin.bookings.addNote` is now the only writer of this table — it had none before.

- [ ] **Step 9: Remind the owner about the migration**

CLAUDE.md: "After any schema change, remind the user to apply the migration on the server database." This task's report and the week's closing message must both say that `0012` is owed on the server database.

- [ ] **Step 10: Five checks, commit, push**

Two commits: the migration and server change, then the admin UI.

---

## Task 7 (D7): cancelling a booking gives the coupon back

**Decision:** D7, owner-decided 2026-10-16.

**The asymmetry being closed.** A hold that lapses releases its coupon slot — `expireHolds` calls `releaseRedemption()`, owner decision Q7/Q8. An admin cancellation does not, so a guest whose booking the office cancels has burned one use of a limited coupon for a trip that never ran. Nothing said what should happen because a cancel is a different event from an expiry; now something does.

**Files:**

- Modify: `server/src/services/payments/cancel-refund.ts` (`cancelBooking` releases the redemption)
- Test: `server/src/__tests__/admin-refunds.test.ts` (the existing suite, which already owns the cancel tests)
- Modify: `CLAUDE.md` (the Dispatch bullet on what a cancellation does)

**Interfaces:**

- Consumes: `releaseRedemption(tx, couponId, bookingId) -> Promise<void>` from `../coupons`, unchanged and already idempotent on its own DELETE's affected-row count.
- Produces: `CancelBookingResult` gains `couponReleased: boolean`, and the audit payload gains the same key.

- [ ] **Step 1: Write the failing tests**

```ts
it('releases the coupon slot and decrements used_count exactly once', async () => {
  const { couponId, bookingId } = await heldBookingWithCoupon({ usageLimit: 1 });
  expect(await couponUsedCount(couponId)).toBe(1);
  expect(await redemptionCount(couponId, bookingId)).toBe(1);

  const result = await cancelBooking({
    bookingId,
    reason: 'Guest cancelled.',
    actorUserId: ownerUserId,
  });

  expect(result.couponReleased).toBe(true);
  expect(await couponUsedCount(couponId)).toBe(0);
  expect(await redemptionCount(couponId, bookingId)).toBe(0);
  // And the slot is genuinely usable again, which is the point — not just
  // a counter that reads zero.
  await expect(validateCoupon(COUPON_CODE, { pax: 2 })).resolves.toMatchObject({ ok: true });
});

it('a second cancel cannot decrement a second time', async () => {
  const { couponId, bookingId } = await heldBookingWithCoupon({ usageLimit: 1 });
  await cancelBooking({ bookingId, reason: 'One.', actorUserId: ownerUserId });
  await expect(
    cancelBooking({ bookingId, reason: 'Two.', actorUserId: ownerUserId }),
  ).rejects.toBeInstanceOf(BookingNotCancellableError);
  expect(await couponUsedCount(couponId)).toBe(0);
});

it('reports false, and touches no coupon, for a booking that used none', async () => {
  const bookingId = await heldBooking({ couponId: null });
  const result = await cancelBooking({
    bookingId,
    reason: 'No coupon here.',
    actorUserId: ownerUserId,
  });
  expect(result.couponReleased).toBe(false);
});

it('audits the release beside the cancellation, in the same row', async () => {
  const { bookingId } = await heldBookingWithCoupon({ usageLimit: 5 });
  await cancelBooking({ bookingId, reason: 'Guest cancelled.', actorUserId: ownerUserId });
  const row = (await auditRowsFor('bookings', bookingId)).find(
    (r) => r.action === 'booking.cancelled',
  );
  expect(row!.data).toMatchObject({ couponReleased: true, reason: 'Guest cancelled.' });
});

it('rolls the release back with the cancel', async () => {
  const { couponId, bookingId } = await heldBookingWithCoupon({ usageLimit: 1 });
  // A booking whose status is not cancellable: the conditional UPDATE
  // matches nothing and the whole transaction throws.
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['completed', bookingId]);
  await expect(
    cancelBooking({ bookingId, reason: 'x', actorUserId: ownerUserId }),
  ).rejects.toBeInstanceOf(BookingNotCancellableError);
  expect(await couponUsedCount(couponId)).toBe(1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- admin-refunds`
Expected: the release tests fail; `couponReleased` does not exist.

- [ ] **Step 3: Release the redemption**

In `cancelBooking`, add `couponId` to the locking read's selection, and after the van release:

```ts
/*
 * The coupon slot, given back (owner decision 2026-10-16, D7).
 *
 * A lapsed hold already did this (`expireHolds` -> `releaseRedemption`,
 * owner decision Q7/Q8). A cancel is a different event and nothing said
 * what it should do, so until now it did nothing — and a guest whose
 * booking the office cancelled had burned one use of a limited coupon on
 * a trip that never ran. The two events now agree: capacity comes back,
 * and so does the coupon.
 *
 * `releaseRedemption` is idempotent on its own DELETE's affected-row
 * count, so it cannot double-decrement — and it could not be reached
 * twice anyway: the conditional UPDATE above refuses a second cancel.
 * Both guards, deliberately, because the one that fails silently is the
 * one that matters.
 *
 * LOCK ORDER: the booking row is already held, and this takes
 * `coupon_redemptions` then `coupons`. `expireHolds` reaches the same
 * two tables in the same order from behind the same booking lock
 * (slots, booking, coupon), so the two paths cannot deadlock against
 * each other.
 */
const couponReleased = booking.couponId !== null;
if (booking.couponId !== null) {
  await releaseRedemption(tx, booking.couponId, parsed.bookingId);
}
```

Add `couponReleased` to the audit `data` and to the returned result, and extend the function's doc comment — it currently lists what the cancel does and does not do, and that list is now one item longer.

- [ ] **Step 4: Run everything, prove the tests can fail**

Run: `pnpm --filter @rg/server test`

Mutations:

1. Delete the `releaseRedemption` call — the first test must go red.
2. Move the call outside the transaction (await it after `getDb().transaction(...)` resolves) — the rollback test must go red.
3. Call it unconditionally with `booking.couponId!` — the no-coupon test must go red (or throw), proving the null guard is tested.

- [ ] **Step 5: Correct CLAUDE.md**

The Dispatch bullet "**Cancelling a trip does not retract the check-ins already recorded**" lists what a cancel does and does not do. Add the coupon: a cancellation releases the booking's coupon redemption and decrements `used_count`, audited in the `booking.cancelled` row as `couponReleased`, owner-decided 2026-10-16 — the same treatment a lapsed hold gets.

- [ ] **Step 6: Five checks, commit, push**

`feat(admin): a cancellation gives the coupon back`

---

## Task 8 (C1): the lifecycle columns get written

**Carry-forward:** C1, owner-decided 2026-10-16. **Runs after Task 7**, which has already edited `cancelBooking`'s `.set()` and audit payload.

**The finding.** `bookings.started_at`, `completed_at`, `cancelled_at` and `cancel_reason` are declared in `schema.ts` and written by nothing. `startTrip`, `finishTrip` and `cancelBooking` each set `status` and nothing else. Most sharply: `cancel_reason` is **required** by `cancelInput`, validated at the boundary, and then reaches only the audit payload — a column that exists, is asked for, and is never stored.

**The data is not lost today** (the start time is the `stop_key = 0` checkpoint, the completion is the `trip.completed` audit row, the cancel is the cancel audit row), so this task is about making the obvious read correct rather than recovering anything. That matters for one specific reason: the next person to write a report over `completed_at` will get zeros, and will not find out from the schema.

**Files:**

- Modify: `server/src/services/trips/checkins.ts` (`startTrip`, `finishTrip`, and the completion undo)
- Modify: `server/src/services/payments/cancel-refund.ts` (`cancelBooking`)
- Modify: `server/src/routers/admin/refunds.ts` (pass `now`)
- Test: `server/src/__tests__/trip-checkins.test.ts` and `admin-refunds.test.ts` (existing suites)
- Modify: `CLAUDE.md` (the Conventions bullet claiming the four columns are written by nothing)

**Interfaces:**

- `cancelBooking`'s input gains `now: Date` (`z.date()`), supplied by the router as `new Date()` — the house pattern `decideManualReceipt` already follows. `startTrip` and `finishTrip` already take a `now`.

- [ ] **Step 1: Write the failing tests**

```ts
it('startTrip stamps started_at with the server clock', async () => {
  await startTrip(driverId, bookingId, AT_NOON);
  expect((await bookingRow(bookingId)).startedAt).toEqual(AT_NOON);
});

it('finishTrip stamps completed_at, and the same instant as its audit row', async () => {
  await startTrip(driverId, bookingId, AT_NOON);
  await completeTrip(driverId, bookingId, AT_TWO);

  const row = await bookingRow(bookingId);
  expect(row.completedAt).toEqual(AT_TWO);
  // One event, one instant: a report over the column and a report over the
  // trail must not disagree about when this trip ended.
  const audit = (await auditRowsFor('bookings', bookingId)).find(
    (r) => r.action === 'trip.completed',
  );
  expect(audit!.createdAt.getTime()).toBeCloseTo(AT_TWO.getTime(), -3);
});

it('undoing a completion clears completed_at, exactly as it restores the status', async () => {
  await startTrip(driverId, bookingId, AT_NOON);
  await completeTrip(driverId, bookingId, AT_TWO);
  expect((await bookingRow(bookingId)).completedAt).not.toBeNull();

  await undoLastCheckIn(driverId, bookingId, AT_THREE, { reason: 'Completed by mistake.' });

  const row = await bookingRow(bookingId);
  expect(row.status).toBe('in_progress');
  // Owner decision Q4: undo restores the previous state EXACTLY. A trip
  // reading in_progress with a completion timestamp on it is not that.
  expect(row.completedAt).toBeNull();
  // And started_at is untouched: the trip did start, and still has.
  expect(row.startedAt).toEqual(AT_NOON);
});

it('cancelBooking stores the reason it already required, and the instant', async () => {
  const result = await cancelBooking({
    bookingId,
    reason: 'Guest cancelled — typhoon.',
    actorUserId: ownerUserId,
    now: AT_NOON,
  });
  const row = await bookingRow(bookingId);
  expect(row.cancelledAt).toEqual(AT_NOON);
  expect(row.cancelReason).toBe('Guest cancelled — typhoon.');
  // Unchanged: the audit row still carries it too. The column is the fast
  // read; the trail is the record.
  expect(result.ref).toBeDefined();
});

it('a refused cancel stores neither', async () => {
  await getPool().query('UPDATE bookings SET status = ? WHERE id = ?', ['completed', bookingId]);
  await expect(
    cancelBooking({ bookingId, reason: 'x', actorUserId: ownerUserId, now: AT_NOON }),
  ).rejects.toBeInstanceOf(BookingNotCancellableError);
  const row = await bookingRow(bookingId);
  expect(row.cancelledAt).toBeNull();
  expect(row.cancelReason).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- trip-checkins admin-refunds`
Expected: every new assertion fails with `null`.

- [ ] **Step 3: Write the columns on the three paths**

Each write goes in the **same conditional UPDATE as the status**, never a second statement: a status that moved without its timestamp, or the reverse, is exactly the drift these columns exist to avoid. So `startTrip`'s `.set({ status: 'in_progress' })` becomes `.set({ status: 'in_progress', startedAt: now })`, with the allow-list `WHERE` untouched; `finishTrip` likewise; the completion undo adds `completedAt: null` to the `.set()` that restores `in_progress`; and `cancelBooking` adds `cancelledAt: parsed.now, cancelReason: parsed.reason`.

Each one gets a short comment saying it is the column's only writer. Do not add a `started_at` clear to the check-in undo path: undoing a check-in does not un-start a trip, and the trip-start checkpoint is a separate event.

- [ ] **Step 4: Thread `now` into cancelBooking**

Add `now: z.date()` to `cancelBookingInputSchema` and pass `new Date()` from the router, reading the clock **once at the request boundary** like every other path in this codebase. A `new Date()` inside the service would be untestable at a boundary without faking timers globally.

- [ ] **Step 5: Run everything, prove the tests can fail**

Mutations:

1. Remove `startedAt: now` — the first test goes red.
2. Remove `completedAt: null` from the undo — the undo test goes red. **This is the important one**: it is the only test proving owner decision Q4's "restores the previous state exactly" extends to the new column.
3. Remove `cancelReason` — the cancel test goes red.
4. Write `cancelledAt` in a second UPDATE after the conditional one, and make the conditional one match nothing (point it at a non-cancellable status) — the "refused cancel stores neither" test must go red, proving the single-statement rule is tested rather than merely intended.

- [ ] **Step 6: Correct CLAUDE.md**

Replace the Conventions bullet that says these four columns are "declared in `schema.ts` and **written by nothing**" with what is true now: each is written by the one path that owns the event, in the same conditional UPDATE as the status, and the undo clears `completed_at`. **Keep the sentence about where the authoritative record lives** — the checkpoints and the audit trail are still the record, and the columns are a fast read over it. Add the one caveat a reader needs: rows that predate this change have nulls, so a report over `completed_at` must tolerate them.

- [ ] **Step 7: Five checks, commit, push**

`fix(bookings): the lifecycle columns stop being decoration`

---

## Task 9 (C2): the app surfaces answer 200

**Carry-forward:** C2, owner-decided 2026-10-16.

**The finding.** `resolvePage` has no case for `/driver`, `/admin` or `/portal`, so every app-surface route falls through to the not-found shell: HTTP **404** with `<title>Page not found | TravelSugbo</title>`. The SPA boots and renders correctly anyway — a browser renders a 404 body — so this is operational rather than broken. But a driver's tab reads "Page not found" for their whole shift, and an uptime monitor pointed at `/driver` reports the portal down.

**Files:**

- Modify: `server/src/seo/resolvers.ts` (an app-surface branch before `matchRoute`)
- Test: `server/src/__tests__/seo-resolvers.test.ts` and whichever test drives the HTML surfaces (find both with `grep -rln "notFoundMeta\|resolvePage" server/src/__tests__`)
- Modify: `CLAUDE.md` (the bullet beginning "**Every app-surface route is served HTTP 404**")

**Interfaces:**

- Produces: `appSurfaceMeta(pathname): PageMeta | null` — `null` when the path is not an app surface, so the caller falls through to the existing route table unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
describe('app surfaces', () => {
  const cases = [
    ['/driver', 'Driver portal'],
    ['/driver/login', 'Driver portal'],
    ['/driver/trip/7', 'Driver portal'],
    ['/admin', 'Staff'],
    ['/admin/bookings/3', 'Staff'],
    ['/portal', 'My booking'],
    ['/portal/RG-7KQ4M9', 'My booking'],
  ] as const;

  it.each(cases)('%s resolves 200 and noindex', async (path, titleStart) => {
    const meta = await resolvePage(path);
    expect(meta.status).toBe(200);
    expect(meta.robots).toBe('noindex,nofollow');
    expect(meta.title.startsWith(titleStart)).toBe(true);
    // Not the not-found title, which is the whole bug.
    expect(meta.title).not.toMatch(/Page not found/);
    // No JSON-LD, no OG image: these pages are not content.
    expect(meta.jsonLd).toEqual([]);
    expect(meta.preload).toBeNull();
  });

  it('noindex here does not depend on the content flag', async () => {
    // These routes are noindex forever, not only while the site is
    // unverified — so the assertion must hold with the flag CLEARED.
    await setContentUnverified(false);
    expect((await resolvePage('/driver')).robots).toBe('noindex,nofollow');
  });

  it('a path that merely STARTS with a surface name still 404s', async () => {
    for (const path of ['/drivers', '/driverfoo', '/administrator', '/portalx']) {
      const meta = await resolvePage(path);
      expect(meta.status).toBe(404);
    }
  });

  it('answers without reading the database', async () => {
    // A driver's phone on a bad connection must not depend on a settings
    // read, and an uptime monitor must get an answer when MySQL is down.
    const statements = await countStatements(() => resolvePage('/driver/login'));
    expect(statements).toBe(0);
  });
});
```

Plus one test at the HTTP surface — the one that already drives `html.ts` or the dev middleware — asserting `GET /driver/login` with `Accept: text/html` answers **200** and a title that is not "Page not found".

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- seo`
Expected: the surface cases fail with 404 and the not-found title. The "merely starts with" case passes already and must still pass.

- [ ] **Step 3: Write the branch**

```ts
/**
 * The three app surfaces: the driver portal, the admin console and the
 * customer portal. **200, and permanently `noindex`** (owner decision
 * 2026-10-16, C2).
 *
 * They had no case in the route table, so every one of them fell through to
 * `notFoundMeta` and was served HTTP 404 with the title "Page not found" —
 * measured 2026-10-16. The SPA booted and rendered correctly regardless (a
 * browser renders a 404 body), so nothing was broken; what it cost was
 * real anyway. A driver's tab read "Page not found" for an entire shift,
 * and an uptime monitor pointed at `/driver` reported the portal down.
 *
 * **`noindex` and `404` are not the same statement.** "Do not list this"
 * and "there is nothing here" are different claims, and only the first is
 * true of these routes. They already carry an `X-Robots-Tag`
 * (`middleware/robots-header.ts`); this makes the meta tag agree.
 *
 * Matched by PREFIX, not by the route table: the table matches on an exact
 * segment count, and these surfaces have open-ended paths
 * (`/admin/bookings/3`, `/portal/RG-7KQ4M9`, `/driver/trip/7`). The guard
 * is that the prefix must be the whole first segment — `/drivers` and
 * `/driverfoo` are not the driver portal and must keep 404ing.
 *
 * Pure, and deliberately: no settings read, no database. A crawler
 * hammering `/admin/...` must not cost a query each time, and these pages
 * must still answer when MySQL is unreachable — which is exactly when
 * somebody is looking at an uptime monitor. That also means the site-wide
 * noindex gate in `resolvePage` never applies to these: they are already
 * `noindex` unconditionally, which is strictly stronger.
 */
const APP_SURFACES: ReadonlyArray<{ segment: string; title: string; description: string }> = [
  {
    segment: 'driver',
    title: `Driver portal | ${BRAND}`,
    description: 'Sign-in for TravelSugbo drivers. Not a public page.',
  },
  {
    segment: 'admin',
    title: `Staff console | ${BRAND}`,
    description: 'Sign-in for TravelSugbo staff. Not a public page.',
  },
  {
    segment: 'portal',
    title: `My booking | ${BRAND}`,
    description: 'Manage your TravelSugbo booking. Not a public page.',
  },
];

export function appSurfaceMeta(pathname: string): PageMeta | null {
  const [, first = ''] = normalisePath(pathname).split('/');
  const surface = APP_SURFACES.find((s) => s.segment === first);
  if (!surface) return null;
  return {
    title: surface.title,
    description: surface.description,
    canonical: absoluteUrl(normalisePath(pathname)),
    ogImage: null,
    ogType: 'website',
    jsonLd: [],
    preload: null,
    status: 200,
    robots: 'noindex,nofollow',
  };
}
```

In `resolvePage`, before `matchRoute`:

```ts
// Before the route table and before any settings read — see
// `appSurfaceMeta`. Returning here also bypasses the site-wide noindex
// gate below, which these routes do not need: they are noindex always.
const appSurface = appSurfaceMeta(pathname);
if (appSurface) return appSurface;
```

The titles are the user-visible half of this fix, so settle them with **ui-ux-pro-max** (`--domain ux`, page titles / wayfinding) rather than inventing them, and record the query. They must read as a place, not a status.

- [ ] **Step 4: Run everything, prove the tests can fail**

Mutations:

1. Change the match from whole-segment to `startsWith` — the `/drivers` test must go red.
2. Set `status: 404` — the surface cases go red.
3. Add a `readContentUnverified()` call inside `appSurfaceMeta` — the statement-count test must go red.

- [ ] **Step 5: Correct CLAUDE.md**

Replace the bullet recording the 404 with what is true now: the three surfaces resolve to 200 with their own titles and `noindex,nofollow`, matched by first segment in `appSurfaceMeta`, with no database read. **Keep the client-side residue**: nothing sets `document.title` client-side, so the title a driver sees is the injected one for whatever path they first loaded, and it does not change as they navigate within the SPA. That is a separate, smaller gap and this task does not close it.

- [ ] **Step 6: Five checks, commit, push**

`fix(seo): the driver portal stops reporting itself missing`

---

## Task 10 (C3): expired sessions get swept

**Carry-forward:** C3, owner-decided 2026-10-16. **Runs after Task 5**, so `jobs/index.ts` already registers two jobs.

**The finding.** Nothing deletes a `sessions` row. `revokeSession` removes one on sign-out, and an expired row simply stays: `readSession` checks `expires_at` and refuses it, so the row is harmless and permanent. `rg_travel_test` was holding 678 of them at the last count, and production will accumulate one per sign-in forever.

**Files:**

- Modify: `server/src/services/sessions.ts` (add `deleteExpiredSessions`)
- Create: `server/src/jobs/prune-sessions.ts`
- Modify: `server/src/jobs/index.ts`
- Modify: `server/src/__tests__/global-setup.ts` (the teardown prunes the test database)
- Test: `server/src/__tests__/sessions.test.ts` (the existing suite)
- Modify: `docs/LAUNCH_CHECKLIST.md` (the scheduled-jobs list)

**Interfaces:**

- Produces:

  ```ts
  /**
   * Deletes every session whose `expires_at` has passed. Returns the count.
   * Its own transaction — nothing else needs to commit with it.
   */
  export async function deleteExpiredSessions(now: Date): Promise<number>;
  export async function pruneSessions(now: Date): Promise<{ deleted: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('deletes expired sessions and keeps live ones', async () => {
  const live = await createSession('driver', driverId, NOW);
  const expired = await createSession('driver', driverId, LONG_AGO);

  expect(await deleteExpiredSessions(NOW)).toBe(1);
  expect(await readSession(live.token, NOW)).not.toBeNull();
  expect(await sessionRowByToken(expired.token)).toBeUndefined();
});

it('is exact at the boundary: a session expiring at `now` is gone, one expiring a ms later stays', async () => {
  // `readSession` refuses a session AT its expiry, so the sweep must agree
  // — a row the reader calls dead and the sweep calls live is a row that
  // lives forever.
  const atNow = await sessionExpiringAt(NOW);
  const aMsLater = await sessionExpiringAt(new Date(NOW.getTime() + 1));

  await deleteExpiredSessions(NOW);
  expect(await sessionRowById(atNow)).toBeUndefined();
  expect(await sessionRowById(aMsLater)).toBeDefined();
});

it('sweeps every subject type, not only drivers', async () => {
  for (const subject of ['user', 'customer', 'driver'] as const) {
    await sessionExpiringAt(LONG_AGO, subject);
  }
  expect(await deleteExpiredSessions(NOW)).toBe(3);
});

it('is a no-op on a clean table and says nothing', async () => {
  const logged = vi.spyOn(console, 'log');
  expect(await pruneSessions(NOW)).toEqual({ deleted: 0 });
  expect(logged).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- sessions`

- [ ] **Step 3: Write the sweep and the job**

The service function is three lines plus a comment explaining why the boundary is `<=` and not `<`: `readSession` refuses a session **at** its expiry, so the sweep must delete at the same instant or a row exists that the reader calls dead and the sweep calls live.

The job mirrors `expire-holds.ts`: clock as a parameter, no scheduling in the module, a log line only when it deleted something. Schedule it **daily at 03:30 Asia/Manila** — off-peak, with the timezone passed explicitly — in `jobs/index.ts`, with the same try/catch so a failure cannot reject into the scheduler.

A note the comment must carry: deleting an expired session is **not** a soft-delete violation. CLAUDE.md's rule names bookings and payments; a session is a credential whose whole purpose has ended, and keeping it is a liability rather than a record. The audit trail of who signed in when lives in `audit_log`, untouched by this.

- [ ] **Step 4: Prune the test database**

In `global-setup.ts`'s teardown, delete every `sessions` row before the leak check reports. The baseline after seeding is zero (the seed creates an owner user, not a session), so this returns the table to its baseline rather than to an arbitrary state.

**Do not add `sessions` to `LEAK_TABLES`.** Sessions are created legitimately by dozens of tests, within a run, and a detector that fires on them would fire on every run — which is the opposite of the standing instruction. The teardown delete is the fix; the detector is for rows that change another file's answer, and nothing counts sessions to make a decision. Say that in the comment, beside the `audit_log` exclusion that is there for the same reason.

- [ ] **Step 5: Run everything, prove the tests can fail**

Mutations:

1. Change `lte` to `lt` in the sweep's `where` — the boundary test must go red.
2. Narrow the sweep to `subjectType = 'driver'` — the all-subjects test must go red.
3. Remove the teardown delete, run the full suite twice, and record the `sessions` row count after each — the count must grow, which is the measurement that justifies this task at all.

- [ ] **Step 6: Document the job**

`docs/LAUNCH_CHECKLIST.md` lists the scheduled jobs and the fork-mode requirement. Add this job and Task 5's to that list, with their times and the note that both are idempotent (so a double-run under cluster mode would be wasteful rather than wrong — the same reasoning the hold sweep already carries).

- [ ] **Step 7: Five checks, commit, push**

`feat(jobs): expired sessions stop accumulating forever`

---

## Task 11 (C4): the seed ships itinerary stops

**Carry-forward:** C4, owner-decided 2026-10-16, **dev seed only**.

**The finding.** `db:seed` ships zero `tour_itinerary_stops` across all six tours. So on a fresh clone the driver's itinerary screen shows "Start trip" and nothing else, the departures board reads `0/1` for every trip, and 6C — built and tested — is undemonstrable against seed content.

**Files:**

- Modify: `server/src/db/seed-data.ts` (stops for all six tours)
- Modify: `server/src/db/seed.ts` (an app-only writer)
- Test: `server/src/__tests__/seed-parity.test.ts` (the pure assertions)
- Test: `server/src/__tests__/seed-itinerary.test.ts` (new — the writer, against the test database, cleaning up after itself)
- Modify: `CLAUDE.md` (the Content bullet saying the seed ships no stops)

**Interfaces:**

- `SeedTour` gains `stops: SeedItineraryStop[]` where `SeedItineraryStop = { sortOrder: number; name: string; description: string | null }`.
- `upsertItineraryStops(db, tourIdBySlug): Promise<void>` — called from `seed()` **only when `context === 'app'`**, beside `upsertFleet`, and for the same kind of reason: the test database deliberately keeps a narrower baseline, and a suite that counts rows must not have its answer changed by seed content.

- [ ] **Step 1: Write the failing tests**

In `seed-parity.test.ts` (pure, no database):

```ts
describe('seeded itinerary stops (C4)', () => {
  it('gives every tour at least three stops', () => {
    for (const tour of SEED_TOURS) {
      expect(tour.stops.length, tour.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it("numbers each tour's stops 1..n, contiguous and unique", () => {
    for (const tour of SEED_TOURS) {
      const orders = tour.stops.map((s) => s.sortOrder).sort((a, b) => a - b);
      expect(orders, tour.slug).toEqual(Array.from({ length: orders.length }, (_, i) => i + 1));
    }
  });

  it('names real places, not placeholders', () => {
    for (const tour of SEED_TOURS) {
      for (const stop of tour.stops) {
        expect(stop.name.length).toBeGreaterThan(3);
        expect(stop.name).not.toMatch(/placeholder|lorem|TBD|stop \d/i);
      }
    }
  });
});
```

In `seed-itinerary.test.ts` (the writer, against `rg_travel_test`, with its own cleanup):

```ts
it('writes the stops, in order, and is idempotent across re-runs', async () => {
  const tourId = await tourIdForSlug('kawasan-falls-canyoneering');
  try {
    await upsertItineraryStops(getDb(), new Map([['kawasan-falls-canyoneering', tourId]]));
    const first = await stopsFor(tourId);
    expect(first.map((s) => s.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(first[0]!.name).toBe(
      SEED_TOURS.find((t) => t.slug === 'kawasan-falls-canyoneering')!.stops[0]!.name,
    );

    // A second run replaces rather than duplicating — the discipline
    // `upsertTour` already keeps for price tiers and images.
    await upsertItineraryStops(getDb(), new Map([['kawasan-falls-canyoneering', tourId]]));
    expect(await stopsFor(tourId)).toHaveLength(first.length);
  } finally {
    // The test database keeps no stops: this suite borrows the table and
    // gives it back, or `seed-dispatch.test.ts` starts counting rows it
    // did not create.
    await getPool().query('DELETE FROM tour_itinerary_stops WHERE tour_id = ?', [tourId]);
  }
});

it('the test-context seed writes NO stops', async () => {
  await seed('test');
  const [[row]] = await getPool().query('SELECT COUNT(*) AS n FROM tour_itinerary_stops');
  expect(Number(row.n)).toBe(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- seed-parity seed-itinerary`
Expected: `tour.stops` is undefined; `upsertItineraryStops` does not exist. The second test in the new file passes already and must still pass at the end — it is what holds the app-only rule.

- [ ] **Step 3: Write the stop data**

Three to five stops per tour, named after real places on that itinerary, in the order a van actually reaches them. These are read by drivers and shown to guests, so they must be plausible rather than filler — "Badian jump-off — gear and briefing", not "Stop 1". Write a `description` where it tells a driver something ("the second gate, not the main entrance") and `null` where it does not; a description that restates the name is noise on a screen read through a windscreen.

The six tours are `oslob-whale-shark-tumalog-falls`, `kawasan-falls-canyoneering`, `moalboal-sardine-run-turtles`, `mactan-island-hopping`, `cebu-city-heritage-tour` and `bohol-countryside-chocolate-hills`.

**These are placeholder-adjacent content.** `settings.content_unverified` is still set and the production build is still gated, so this does not publish anything — but say so in the seed-data comment: an owner replacing seed content replaces these too, and a stop name is not an accreditation number.

- [ ] **Step 4: Write the writer**

In `seed.ts`, modelled on the price-tier and image blocks inside `upsertTour`: delete this tour's stops, insert the declared set. Then call it from `seed()` inside the existing `if (context === 'app')` block, with a comment giving the reason:

```ts
/*
 * Itinerary stops are APP-ONLY, like the fleet (owner decision
 * 2026-10-16, C4). `rg_travel_test` keeps a narrower baseline on
 * purpose: suites count checkpoints and stops to decide how far a trip
 * has progressed (`tripProgress`, `checkins.ts`), and seed content
 * those suites did not create would change their answers.
 *
 * What this fixes is the fresh clone: `db:seed` shipped zero stops, so
 * the driver's itinerary screen showed "Start trip" and nothing else
 * and the departures board read 0/1 for every trip. 6C was built and
 * tested all along; it was simply undemonstrable.
 */
```

- [ ] **Step 5: Run everything, prove the tests can fail**

Mutations:

1. Remove one stop from one tour's data so its `sortOrder`s read `[1, 2, 4]` — the contiguity test must go red, naming the tour.
2. Move the `upsertItineraryStops` call outside the `context === 'app'` guard — the "test-context seed writes NO stops" test must go red.
3. Delete the `delete` before the insert — the idempotence test must go red on the second run.

- [ ] **Step 6: Verify the fresh-clone promise by hand**

```bash
pnpm --filter @rg/server db:seed
```

Then open the driver portal on a seeded booking and confirm the itinerary renders its stops and the departures board no longer reads `0/1`. **Record the observed numbers in the report** — this task's whole justification is a thing a person sees, and the suite cannot see it.

- [ ] **Step 7: Correct CLAUDE.md**

Replace the Content bullet beginning "**The seed ships no `tour_itinerary_stops`**" with what is true now: the dev seed ships three to five stops per tour, the test database still ships none and why, and 6C is demonstrable on a fresh clone. Keep the note that 7F's editing screens still do not cover stops — that is unchanged and still true.

- [ ] **Step 8: Five checks, commit, push**

`feat(seed): six tours get the stops a driver taps`

---

## Task 12 (C5): the leak detector watches the slot tables

**Carry-forward:** C5, owner-decided 2026-10-16. **Pre-flight ruling 6 applies: the hand-written cleanups stay, and the report explains why.**

**Files:**

- Modify: `server/src/__tests__/global-setup.ts` (`LEAK_TABLES`)
- Possibly modify: any suite the detector then catches (each gets a cleanup, not a loosened assertion)

- [ ] **Step 1: Add the table**

```ts
  /*
   * Added by owner decision 2026-10-16 (C5). `fleet_date_slots` rows are
   * lock anchors — `takeSlotLocks()` creates one per date so that two
   * bookings racing for the last van serialise against a real row — so a
   * leaked one changes no count and breaks no test today. It is listed
   * anyway, because the twelve suites that hand-delete these rows in
   * `afterAll` are currently the only thing keeping the table tidy, and a
   * thirteenth suite that forgets would leave rows nobody notices for
   * weeks. The detector is how "somebody forgot" becomes a named failure
   * in the run that caused it.
   */
  ['fleet_date_slots', fleetDateSlots],
```

- [ ] **Step 2: Run the whole suite and read the detector**

Run: `pnpm --filter @rg/server test`

Three possible outcomes, and each has a different correct response:

- **Silent.** The twelve existing cleanups cover every suite that takes a slot lock. Record that, and move on.
- **One or more suites named.** Each is a real missing cleanup. Add a `DELETE FROM fleet_date_slots WHERE date = ?` to that suite's `afterAll`, matching the pattern the other twelve use. **Do not loosen the detector to fit the suite.**
- **A suite is named that creates slots for a date it does not know.** Then the cleanup belongs in a helper rather than in the file. Say so in the report; do not invent one under time pressure.

- [ ] **Step 3: Answer the owner's second half honestly**

The instruction asked to "remove hand-written cleanups it makes redundant". They are not redundant — the detector detects and does not clean. The report must:

- name all twelve call sites (`grep -rn "DELETE FROM fleet_date_slots" server/src/__tests__`),
- state that removing any of them makes the detector fire,
- and name the one thing that _would_ make them redundant, so the owner can decide separately: a shared `afterAll` helper (`releaseSlotsFor(dates)`) that each suite calls once, replacing twelve bespoke queries with twelve one-line calls. That is a test-infrastructure refactor touching twelve files and is not in this task's scope.

- [ ] **Step 4: Prove the detector can fail**

Add a temporary test that inserts a `fleet_date_slots` row and does not clean it up. The run must fail, naming `fleet_date_slots`, the baseline, the actual count and the surplus. Delete the temporary test and re-run to green. **Record the failure message verbatim** — this task's only deliverable is a detector, and a detector nobody has watched fail is not known to work.

- [ ] **Step 5: Consider `tour_date_slots`, and do not add it**

The carry-forward also noted `tour_date_slots` has no `ON DELETE` toward `tours`. The owner named only `fleet_date_slots`, so this task adds only that. Check whether `tour_date_slots` rows survive their tours in the test database and **report the finding** with the evidence; adding a second table to the detector, or a foreign key to the schema, is a decision and a migration respectively.

- [ ] **Step 6: Five checks, commit, push**

`test(leak): the fleet slot table joins the leak detector`

---

## Task 13 (C6): one duplicate-key helper

**Carry-forward:** C6, owner-decided 2026-10-16.

**The finding.** `isDuplicateKeyError` exists three times: the shared helper in `server/src/db/duplicate-key.ts`, plus private copies in `server/src/services/booking-ref.ts` and `server/src/routers/public/newsletter.ts`. All three walk the `.cause` chain looking for `ER_DUP_ENTRY`, because Drizzle wraps the mysql2 error. Three copies of a predicate that arbitrates a unique index is three chances for one of them to stop recognising a duplicate — and a duplicate-key catch that stops matching does not throw: it falls through to the generic error path and turns a safe retry into a 500.

**Files:**

- Modify: `server/src/services/booking-ref.ts` (import, delete the local copy)
- Modify: `server/src/routers/public/newsletter.ts` (same)
- Test: `server/src/__tests__/duplicate-key.test.ts` (the shared helper's own suite — confirm it exists and covers both shapes)
- Test: a new guard test asserting there is exactly one implementation

- [ ] **Step 1: Read all three and prove they agree before deleting any**

Write a test that exercises the shared helper against **every** error shape the three copies between them handle: a bare mysql2 error with `code: 'ER_DUP_ENTRY'`, one nested one level deep on `.cause`, one nested two levels, a `null` cause, a cause cycle, a non-object, `undefined`, and an error with a `code` that is not `ER_DUP_ENTRY`. If a private copy handles a shape the shared one does not, **the shared one gains that handling before anything is deleted** — a consolidation that quietly narrows a security-adjacent predicate is worse than three copies.

Record the comparison in the report: for each of the eight shapes, what each of the three implementations answered.

- [ ] **Step 2: Replace the copies**

Delete both private functions, import the shared one. The call sites are unchanged.

- [ ] **Step 3: Add the guard**

A test in the spirit of `no-red.test.ts` and `contrast.test.ts` — reading the real source so a fourth copy added later is caught without anyone updating a list:

```ts
it('has exactly one implementation of the duplicate-key predicate', async () => {
  const hits = await filesMatching(/ER_DUP_ENTRY/, 'server/src', { excludeTests: true });
  // The shared helper, and nothing else. A fourth copy is how one of them
  // stops recognising a duplicate without anybody noticing — and a
  // duplicate-key catch that stops matching does not throw, it falls
  // through to a 500 on a path whose whole design is "insert and catch".
  expect(hits).toEqual(['server/src/db/duplicate-key.ts']);
});
```

Comments in `checkins.ts` mention `isDuplicateKeyError` by name but not `ER_DUP_ENTRY`, so the regex above is the right one. Verify that before committing: if a comment does contain the string, match on the implementation shape rather than loosening the test.

- [ ] **Step 4: Run everything, prove the tests can fail**

Mutations:

1. Re-add a private copy to `newsletter.ts` — the guard test must go red.
2. Narrow the shared helper to check only the top-level error — whichever nesting test covers the deepest shape must go red. Record which call site that would have broken.

- [ ] **Step 5: Five checks, commit, push**

`refactor(db): one answer to "was that a duplicate key"`

---

## Task 14 (C7): the escalation is the multi-IP defence, and now there is a test

**Carry-forward:** C7, owner-decided 2026-10-16. **Keep both limits.**

**The measured fact this task documents.** §8's third limit is 10 `driver.login` attempts per IP per 15 minutes, and the three-lockout escalation needs fifteen failures — so **a single IP cannot drive one driver to `requires_admin_unlock` without the limiter firing first** (HTTP 429 on the 11th attempt, with the driver still at `lockout_count = 1`, measured 2026-10-16). That is correct behaviour and a reading hazard: the obvious conclusion is that the escalation is dead code. It is not. It is reachable across IPs — one driver's code tried from several phones or networks, which is the case the three-lockout rule exists for — and across windows.

**Files:**

- Test: `server/src/__tests__/driver-lockout.test.ts` (a new describe block)
- Modify: `CLAUDE.md` (the bullet beginning "**§8's third limit is 10 `driver.login` attempts per IP**")
- Modify: `docs/LAUNCH_CHECKLIST.md` (cross-reference the `trust proxy` item from the test)

- [ ] **Step 1: Write the failing test**

The limiter keys on `req.ip`. In the deployed configuration `trust proxy` must be set — `LAUNCH_CHECKLIST.md` already carries that as a checklist item, with the reason that without it Express reads nginx's address for every request and the per-IP limit becomes one global limit. The test sets `trust proxy` on its own app and rotates `X-Forwarded-For`, which is exactly the configuration the checklist mandates.

```ts
describe('the escalation is reachable across IPs, and only across IPs (C7)', () => {
  function appWithLimiterBehindProxy() {
    const app = express();
    /*
     * The deployed configuration, not a test convenience:
     * `docs/LAUNCH_CHECKLIST.md` requires `trust proxy` because the app sits
     * behind nginx, and without it `req.ip` is nginx's own address for every
     * request — which would make this per-IP limiter a single global one.
     * Setting it here is what lets the test present distinct client IPs to
     * one limiter instance, as several real phones would.
     */
    app.set('trust proxy', true);
    app.use(createDriverLoginLimiter());
    app.use(express.json());
    app.post('/trpc/driver.login', async (req, res) => {
      const result = await attemptDriverLogin({
        code: req.body.code,
        pin: req.body.pin,
        now: new Date(),
      });
      res.status('ok' in result ? 200 : 401).json(result);
    });
    return app;
  }

  it('ONE IP cannot reach admin-unlock: the limiter fires first', async () => {
    const app = appWithLimiterBehindProxy();
    const ip = '203.0.113.10';
    let limited = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .post('/trpc/driver.login')
        .set('X-Forwarded-For', ip)
        .send({ code: CODE, pin: '000000' });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // The driver is locked ONCE and never escalated — ten attempts reaches
    // the five-failure lockout but not the fifteen the third one needs.
    const driver = await driverRow(driverId);
    expect(driver.lockoutCount).toBe(1);
    expect(driver.requiresAdminUnlock).toBe(false);
  });

  it('THREE IPs reach admin-unlock, which is the case the rule exists for', async () => {
    const app = appWithLimiterBehindProxy();
    const ips = ['203.0.113.10', '203.0.113.11', '203.0.113.12'];
    let clock = START;

    for (const ip of ips) {
      // Five failures from this IP: under the ten-per-window budget, so no
      // 429 — and exactly one lockout for the driver.
      for (let i = 0; i < 5; i += 1) {
        const res = await request(app)
          .post('/trpc/driver.login')
          .set('X-Forwarded-For', ip)
          .send({ code: CODE, pin: '000000' });
        expect(res.status).toBe(401);
      }
      // The 15-minute per-driver lockout has to lapse before the next five
      // can count, so the clock advances between IPs. Still well inside the
      // 24-hour escalation window.
      clock = new Date(clock.getTime() + 16 * 60_000);
      await expireDriverLockout(driverId, clock);
    }

    const driver = await driverRow(driverId);
    expect(driver.lockoutCount).toBe(3);
    expect(driver.requiresAdminUnlock).toBe(true);
    // And the refusal says so, in the reason string the screen matches on.
    const refused = await attemptDriverLogin({ code: CODE, pin: REAL_PIN, now: clock });
    expect(refused).toMatchObject({ ok: false, reason: 'needs_admin_unlock' });
  });

  it('a correct PIN from a fourth IP does not clear the admin-unlock requirement', async () => {
    // Already asserted at the policy level; re-asserted here because this
    // is the end-to-end path a real attacker-plus-real-driver would take.
  });
});
```

The per-driver lockout clock has to be advanced between IPs, because five failures lock the driver for fifteen minutes and a locked driver's further attempts do not count toward a second lockout. Use whichever mechanism `driver-lockout.test.ts` already uses to move that clock (`evaluatePinAttempt` takes `now`; `attemptDriverLogin` takes `now` too) rather than inventing a helper — **and if the only honest way is to pass a later `now`, do that and drop the supertest layer for those five attempts**, noting in the test which layer each assertion is proving. A test that fakes its way to a state and then claims the HTTP path reached it is the failure mode this week keeps finding.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- driver-lockout`
Expected: the three-IP test fails before the fix — or, if it passes immediately, **that is the finding**: the escalation was already reachable and the test is now the proof. Say which, and do not describe a test as newly-passing if it never failed.

- [ ] **Step 3: There is no production change in this task**

C7 says keep both limits. The test and the documentation are the deliverable. If implementing the test reveals that the escalation is in fact unreachable across IPs too, **stop and report** — that is a security finding, not something to fix inside a cleanup task.

- [ ] **Step 4: Prove the test can fail**

1. Raise `DRIVER_LOCKOUT_ESCALATION_COUNT` (or whatever the three-lockout constant is called) to 4 — the three-IP test must go red.
2. Remove `app.set('trust proxy', true)` — the three-IP test must go red with 429s, because every request now shares nginx's key. **Record that**: it is the measurement that makes the `LAUNCH_CHECKLIST.md` item concrete, and it is the clearest possible demonstration of what happens if that item is skipped at deploy time.

- [ ] **Step 5: Correct CLAUDE.md**

Extend the bullet with what is now tested rather than reasoned: the single-IP ceiling is measured, the three-IP escalation is measured, the escalation is **not** dead code and the test is named. Keep the existing warning not to delete it. Add the deployment dependency in one sentence: the per-IP limit is only per-IP when `trust proxy` is set, and `docs/LAUNCH_CHECKLIST.md` carries that as a launch item — without it, all three limits collapse onto one key and one attacker can lock every driver's login out of one window.

- [ ] **Step 6: Five checks, commit, push**

`test(driver-auth): the escalation proven reachable, across IPs only`

---

## Closing the week

After Task 14:

1. Run the five checks one final time on the committed tree and report each number.
2. Confirm `git status` is clean and `git log origin/main..HEAD` is empty.
3. **Remind the owner that migration `0012` (D6) is owed on the server database.**
4. Write **WEEK 6.5 COMPLETE** with: what each of the fourteen decisions now does, what is still mocked or unproven, and any bug found and deliberately not fixed.
5. Then, and only then, write the Week 7 plan per BUILD_SPEC §13 — **plan only, stop for approval.**

## Questions for the owner (not blocking)

Listed rather than guessed, with the direction each was taken in meanwhile.

1. **D2: should a rejected cash claim notify the driver?** Today nothing tells them; the refusal is a conversation the office has in person. Taken: no notification. §11's email set is the owner's to extend, and a driver portal has no notification surface at all yet.
2. **D5: should the orphaned-van alert escalate if the same van is stranded for days?** Taken: no — one alert, daily, no severity ladder. The alert orders the longest-stranded van first, which carries the same information without a second mechanism.
3. **D6: should a driver be told that invisible notes exist?** Taken: no. "There are 2 notes you cannot see" is worse than silence for someone standing at a pickup, and it invites a phone call the flag was set to avoid.
4. **C4: are the seeded stop names acceptable as placeholder content?** They are real Cebu place names on real itineraries, and `content_unverified` still gates the production build — but they are the first seeded content that reads as operational fact rather than obvious filler. Taken: ship them, flagged in the seed-data comment.
5. **C2: should anything set `document.title` client-side?** The injected title is now correct for the entry path, but it does not change as a driver navigates within the SPA. Taken: out of scope, recorded in `CLAUDE.md`. It is a small, self-contained Week 7 candidate.
