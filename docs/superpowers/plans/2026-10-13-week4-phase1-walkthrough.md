# Week 4, Task 12 — the Phase 1 end-to-end pass

**Date:** 2026-10-14
**Scope:** every Phase 1 flow, driven through the real Express app.
**Evidence:** `server/src/__tests__/phase1-walkthrough.test.ts` — this record says what was
proven; that file is what makes it re-runnable instead of a memory.

---

## What "driven against the running app" means here, exactly

The walkthrough drives **`createApp()`** — the same function `server/src/index.ts` starts — over
HTTP with `supertest`. That means every step passes through the real middleware stack in the real
order: the malformed-URL guard, the CSRF origin check, the rate limiters, the cookie parsers, the
tRPC adapter, and then the real services against the real MySQL database (`rg_travel_test`).

Two honest limits, both deliberate:

1. **No browser was driven.** Each step proves the SERVER half of a flow. The client half — the
   QR screen, the portal booking page, the review form, the admin list and detail — is proved by
   the component tests beside them (`client/src/__tests__/`), which render the real components
   against the real tRPC client with only the socket faked. Nobody clicked through Chrome.
2. **No payment gateway was touched.** There is no PayMongo account yet (owner decision
   2026-10-13), so the online payment path is **not proven end to end** — see step 1.

The only thing stubbed anywhere in the pass is the **mail transport**, which is injectable in
production by design (§11's `notify()` takes a transport), so stubbing it is using the seam rather
than bypassing it.

---

## Step 1 — the online payment path: **MOCKED — live wire check pending**

**Status: mocked; the live wire check is pending the PayMongo account** (a blocking item in
`docs/LAUNCH_CHECKLIST.md`, "The gateway wire check"). Week 3 built and tested our side of the
`PaymentProvider` seam against a mock provider; what is pending is PayMongo's side. Recorded as
unproven-against-the-real-gateway rather than papered over — "mocked" is the label, not a claim
that the gateway works.

What cannot be proven without an account: that `startPayment` produces a usable checkout session,
that the redirect lands back correctly, that a real webhook's signature verifies, that the event
names and field names match what `services/payments/paymongo.ts` expects, and that a real
test-mode payment confirms a booking.

What the pass DOES prove, which is the only thing that can be proven while the account is
missing: **asking to pay does not mark anything paid.** `checkout.startPayment` is reachable, it
answers (a refusal, with no provider configured), and the booking is still `pending_payment` with
`amount_paid_centavos = 0` afterwards.

The real wire check is a **blocking pre-launch item** in `docs/LAUNCH_CHECKLIST.md` ("The gateway
wire check"): create the account, put TEST keys in `.env`, tunnel a webhook, run one test-mode
booking end to end, confirm the field names, delete the dev webhook. Nothing in the test suite can
substitute for it, and this pass does not claim to.

---

## Step 2 — the manual QR path, end to end: **PROVEN**

One story, in order, all through HTTP:

| #   | Step                                              | Proven                                                                                  |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `checkout.quote`                                  | a quote with a server-signed `quoteId`                                                  |
| 2   | `checkout.createHold`                             | a booking reference, a hold expiry                                                      |
| 3   | `portal.login` (ref + email)                      | a guest session cookie                                                                  |
| 4   | `portal.manualPayment`                            | the amount due **computed by the server**, the account details, five uploads remaining  |
| 5   | the same call with no session                     | **401** — the account number is not public                                              |
| 6   | `POST /api/receipts/upload`                       | 200, the file stored, the row written                                                   |
| 7   | `portal.booking`                                  | `pending_verification`, **nothing paid**, `hold_expires_at` **nulled**, tracker `##...` |
| 8   | §11 emails                                        | "we received your receipt" to the guest, "receipt to verify" to the business inbox      |
| 9   | `staffAuth.login`                                 | a staff session cookie                                                                  |
| 10  | `admin.bookings.list` with `awaitingVerification` | the booking is in the queue                                                             |
| 11  | `GET /api/receipts/<name>` with the staff cookie  | **200** — the verifier can open the receipt                                             |
| 12  | `admin.bookings.approveReceipt`                   | approved                                                                                |
| 13  | `portal.booking` again                            | `confirmed`, the deposit credited, a balance remaining, tracker `###..`                 |
| 14  | §11 email                                         | "your booking is confirmed" to the guest                                                |
| 15  | `audit_log`                                       | `payment.receipt_submitted` then `payment.verified`                                     |

The money assertion in row 7 is the one that matters: a guest's receipt creates a claim, not a
payment.

---

## Step 3 — the reject path: **PROVEN**

- An admin rejects with a reason. The payment becomes `rejected`, the booking returns to
  **`pending_payment`** (owner decision Q7 — not cancelled), and `hold_expires_at` is set to the
  Q8 deadline.
- The portal shows **the admin's own words** as the rejection reason, and says four uploads are
  left.
- §11's amber email carries that reason to the guest.
- The guest re-uploads. The newest receipt is `pending`; the rejected one is still there with its
  reason — nothing was deleted.
- The admin approves the second receipt: `confirmed`, money credited.
- **The rejected receipt cannot then be approved.** Asserted explicitly, because "only the newest
  pending row is decidable" is the rule the whole supersede/reject design rests on.

---

## Step 4 — the portal: **PROVEN**

- **Wrong-credential parity.** A wrong email and a wrong reference produce the same status, the
  same message, and **no session cookie** either way (§7: "don't reveal which").
- **The tracker at each status the booking really reaches**: `#....` held → `###..` confirmed and
  paid → `####.` assigned → `#####` completed, driven through the app and cross-checked against
  the shared rule the server and client both use.
- **Auto-refresh** is the shared `portalPollMs()` rule, proved over all eight statuses in
  `shared/src/portal.test.ts` (20s while `pending_verification`, never otherwise) and wired into
  the page by a structural test. The 20-second interval itself was not waited out in a browser.
- **The review after completion**: accepted only once `completed`, written `pending` with
  `is_sample = false` and the booking id set, and **absent from the public `reviews.published`
  list** until an admin moves it. That last assertion is the guard against a guest publishing
  straight to the site.

---

## Step 5 — hold expiry: **PROVEN**

- A hold with a coupon is created; the redemption row exists.
- `expireHolds()` runs one second after the hold lapses. The booking becomes `expired`.
- **The coupon use comes back** — the redemption row is gone, so the next guest can use a
  single-use code.
- **The capacity comes back**, asserted by successfully HOLDING the same date again rather than
  merely re-quoting it. A quote consumes nothing, so a passing quote would have proved nothing;
  the tour allows two groups a day and the lapsed booking had taken one.

---

## Step 6 — what the pass found

**No application bugs.** Three things refused the walkthrough on its first runs, and every one of
them was a guard working exactly as designed. They are recorded because "the guard fired" is
itself evidence:

1. **Capacity.** Six bookings on one date were refused with "this tour is fully booked for that
   date" — `groups_per_day` and the fleet-then-tour lock order doing their job. The walkthrough
   now gives each booking its own tour date, because these steps test the FLOW and a pass that
   exhausts the fleet is testing the fleet.
2. **The per-guest hold cap.** Re-using one mobile number across guests was refused with "you
   already have the maximum number of pending bookings for this contact" — the cap keys on the
   contact, not the email. Each walkthrough guest is now a different person.
3. **The per-IP hold limiter.** The sixth hold from one address answered 429 — five per IP per
   fifteen minutes (Ruling 5). Each test now gets its own app instance, which is one visitor's
   worth of budget.

No fix was needed for any of the three, so there is no "test per fix" to add: the tests that
cover them already existed and already pass.

---

## Status

| Flow                                                    | Verdict                              |
| ------------------------------------------------------- | ------------------------------------ |
| Manual QR, hold → receipt → approve → confirmed → email | **PROVEN**                           |
| Reject → reason shown → re-upload → approve             | **PROVEN**                           |
| Portal login parity, tracker, review-after-completion   | **PROVEN**                           |
| Hold expiry, capacity return, coupon release            | **PROVEN**                           |
| Online gateway payment, webhook, confirmation           | **MOCKED — live wire check pending** |

Everything in Phase 1 that can be proven without a payment gateway account is proven and
re-runnable. The gateway path remains the one blocking pre-launch item, and it is written down as
such in `docs/LAUNCH_CHECKLIST.md`.
