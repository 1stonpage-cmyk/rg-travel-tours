# Week 3 — Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest can pick a tour and date, see a server-computed price, hold a slot for 15 minutes, pay through PayMongo in test mode, and land on a confirmation page that only reads status — with the booking confirmed by the webhook that already exists.

**Architecture:** Three pure services (pricing, coupons, capacity) sit under one transactional `createHold()` that takes the fleet and tour locks in the fixed order the core schema established. The checkout UI never computes money; it asks the server for a quote and renders what comes back. Payment goes through the existing `PaymentProvider` seam and `recordPayment()` — Week 3 adds no new way for a booking to become paid.

**Tech Stack:** React 19 + Vite 7 + Tailwind v4 + shadcn/ui · Express 5 + tRPC v11 · Drizzle + MySQL 8 · Zod v4 (shared) · `express-rate-limit` · **`node-cron`** — approved by the owner 2026-10-12 for Task 11, and **the only dependency this week installs**. **No other new dependency without the owner's approval.** No email library: Q2 deferred email to Week 4.

**Spec:** `docs/BUILD_SPEC.md` — §4 (tour detail), §5 (pricing, capacity, holds), §6 (checkout & payments), §7 (customer portal login), §9 (roles), §11 (notifications). The plan argues from the spec; executors read both.

**Status:** APPROVED and EXECUTING — owner approved all ten questions on 2026-10-12 (Q1/Q2/Q4/Q7/Q8 first, then Q3/Q5/Q6/Q9/Q10 exactly as recommended). Q1 unblocks Task 11; Q2 drops Task 12, leaving **12 tasks**. Every answer is recorded under Questions below.

## Global Constraints

Copied from `CLAUDE.md` and `docs/BUILD_SPEC.md`. Every task's requirements implicitly include this section.

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display.
- **Time:** store **UTC**; display and compute business dates in **Asia/Manila**.
- **DO NOT trust prices, totals, deposits or discounts sent from the browser. The server computes all money.** The checkout page renders a server quote; it never adds anything up itself.
- **DO NOT mark a booking paid from the client side or from a redirect URL.** Only a verified gateway webhook or an admin approval does that — and both already exist. Week 3 adds no third path.
- **DO NOT auto-confirm a booking whose hold has expired or that was cancelled.** `recordPayment()` already records the money, leaves the status alone and raises `payment_review_required`; the checkout flow must not undo that.
- **Never hard-delete a booking or a payment.**
- **Audit:** every payment, refund, status change and assignment writes to `audit_log`.
- **Validation:** Zod on every input, schemas shared from `/shared`.
- **No red anywhere in the UI** — including errors, badges and destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`). `no-red.test.ts` enforces it.
- **Mobile-first, must work at 360px.** 44px minimum tap targets, visible focus states, alt text on every image, AA contrast (`contrast.test.ts` enforces 4.5:1 on brand pairings).
- **Use ui-ux-pro-max for every checkout screen** (CLAUDE.md requires it for all UI work).
- **Motion: Tailwind CSS transitions only.** `emilkowalski-motion` is **not installed here** — do not reach for it, and do not add an animation library. Respect `prefers-reduced-motion`; `index.css` already has a blanket reduced-motion block.
- **No new libraries** beyond those in `package.json` or named in the spec, and none at all without asking.
- **Never log or print** `DATABASE_URL`, any password, or any gateway secret.
- **PayMongo test keys only. No live keys, no real charges.**
- Local databases are **`rg_travel`** and **`rg_travel_test`**; the DB-name guard enforces it. Never touch Kong PMS, ports 5173/3000, or `C:\dev\kong-pms`.
- **Every new test must be proven able to fail.** Break the code it covers, confirm red, restore. A test that cannot fail is a bug — log it in `docs/BUGS_LOG.md`. Security controls and destructive operations must fail closed, with a test for the failure path.
- **Verify before pushing — all five, run SEPARATELY so each exit status is visible:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Piping a check through `tail` swallows its exit code and hides which command failed.

---

## What already exists (do not rebuild it)

The core schema plan (`docs/superpowers/plans/2026-10-10-core-schema.md`) shipped all 30 tables and the whole payment spine. Week 3 consumes it.

| Already built                                                                                               | Where                                                         | What Week 3 does with it                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bookings`, `payments`, `coupons`, `coupon_redemptions`, `tour_date_slots`, `fleet_date_slots`, `audit_log` | `server/src/db/schema.ts`                                     | Reads and writes; **adds no table**                                                               |
| `depositCentavos(total, percent)`                                                                           | `shared/src/money.ts`                                         | The pricing service calls it — do **not** reimplement the rounding                                |
| `generateBookingRef()` / `insertBookingWithRef(tx, values)`                                                 | `server/src/services/booking-ref.ts`                          | `createHold()` uses the collision-retrying insert                                                 |
| `recordPayment()`                                                                                           | `server/src/services/payments/record-payment.ts`              | Already the only writer of `amount_paid_centavos`; Week 3 does not call it from checkout          |
| `PaymentProvider` seam, `getProvider`, `paymongoProvider`                                                   | `server/src/services/payments/`                               | `createCheckout()` is implemented and untested against a live call — Task 8 is its first real use |
| `POST /api/webhooks/:provider`, signed and idempotent                                                       | `server/src/routers/webhooks/index.ts`                        | Confirms the booking. Week 3 changes nothing here                                                 |
| `writeAudit(tx, entry)`                                                                                     | `server/src/services/audit.ts`                                | Every status change in this plan writes one                                                       |
| `requireRole()` / `adminProcedure(area)`                                                                    | `server/src/middleware/require-role.ts`, `server/src/trpc.ts` | Nothing in Week 3 is an admin procedure; all of it is public or customer-scoped                   |
| Rate limiter pattern                                                                                        | `server/src/middleware/rate-limit.ts`                         | Task 10 adds the booking-lookup limiter following it                                              |
| App-level error handler                                                                                     | `server/src/middleware/error-handler.ts`                      | 4xx passes through with a fixed string; 5xx is `Internal Server Error`. Do not bypass it          |

**The lock order is already fixed and is not negotiable:** `fleet_date_slots(date)` **before** `tour_date_slots(tour_id, date)`, always. Two transactions taking them in opposite orders deadlock. See the carry-forward note at the end of the core-schema plan.

**One correction this plan makes to the spec:** §13's Week 3 preamble still says "Nothing in this week is built… no `server/src/webhooks`, no gateway client" and declares Week 3 blocked on the core schema with Q7/Q4 open. All of that is now false — the webhook route and PayMongo client exist, the schema is migrated, and Q7/Q4 were answered on 2026-10-11. Task 12 updates it.

---

## Scope check

This plan covers the **guest's path to a paid booking** and stops there. It does **not** build the customer portal's authenticated views (Week 4), manual QR upload (Week 4), dispatch or assignment (Week 5), the driver portal (Week 6), or the admin review queue for `payment_review_required` (Weeks 5–7, and tracked in `LAUNCH_CHECKLIST.md`).

Two tasks were **blocked on a dependency decision** — Task 11 (the expiry sweep) and Task 12 (the confirmation email). **Both are now resolved:** Q1 approved `node-cron`, so Task 11 proceeds; Q2 deferred email to Week 4, so **Task 12 is dropped** and this week is **12 tasks**, shipping on-screen confirmation plus booking lookup instead.

---

## File structure

| File                                            | Responsibility                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/src/checkout.ts`                        | **Create.** Zod schemas and types shared by client and server: `quoteInput`, `QuoteResult`, `createHoldInput`, `bookingLookupInput`. |
| `server/src/services/pricing.ts`                | **Create.** Pure. Tier selection, add-on maths, coupon application, totals, deposit. No database, no clock.                          |
| `server/src/services/coupons.ts`                | **Create.** Coupon validation (active, window, usage cap, minimum spend) and redemption recording.                                   |
| `server/src/services/capacity.ts`               | **Create.** The Q7 rule, and the two-lock transaction helper.                                                                        |
| `server/src/services/create-hold.ts`            | **Create.** The one transaction that checks capacity and inserts a booking with a 15-minute hold.                                    |
| `server/src/jobs/expire-holds.ts`               | **Create.** The expiry sweep. **Blocked on Q1.**                                                                                     |
| `server/src/routers/public/checkout.ts`         | **Create.** `quote`, `availability`, `createHold`, `startPayment`, `bookingStatus`, `bookingLookup`.                                 |
| `client/src/pages/public/CheckoutPage.tsx`      | **Create.** The checkout form.                                                                                                       |
| `client/src/pages/public/BookingStatusPage.tsx` | **Create.** Success/cancel landing; polls, never confirms.                                                                           |
| `client/src/components/checkout/*`              | **Create.** Quote summary, guest details, coupon field, hold countdown, consent.                                                     |
| `server/src/services/email/*`                   | **Create.** Confirmation email. **Blocked on Q2.**                                                                                   |

---

## Questions — ALL TEN ANSWERED by the owner, 2026-10-12

Listed, not guessed, then answered. **Q1, Q2, Q4 and Q7/Q8 were answered first; Q3, Q5, Q6, Q9 and Q10 were approved exactly as recommended in the second round.** Nothing in this plan was implemented before the last of them landed.

Each answer is recorded with the alternatives it beat, rather than the alternatives being deleted — a decision whose rejected options are gone reads later as an arbitrary preference, and gets quietly re-litigated.

### Q1 — ✅ ANSWERED: use `node-cron`. (Blocked Task 11.)

**Owner decision: option B, `node-cron`** — CLAUDE.md's approved stack already names it, so it is not a new dependency decision. This overrides the plan's own recommendation of option A (`setInterval`), which stays recorded below.

Three conditions came with it, all binding on Task 11:

1. **Single process only.** Deployment: PM2 **fork mode, 1 instance** — under cluster mode every worker runs the schedule, so each sweep fires N times. Recorded in `LAUNCH_CHECKLIST.md` beside the existing fork-mode requirement, which until now rested only on the rate limiter.
2. **The sweep stays idempotent** — a second run, a restart mid-tick or two overlapping ticks must not change the outcome.
3. **It must skip `payment_review_required = 1`** — already carry-forward constraint 1 of the core-schema plan, so the two documents now agree. Task 11 owes a test for it.

Alternatives recorded: **A. `setInterval`** (no dependency; one job, one minute; crontab syntax buys nothing) and **C. OS-level cron hitting an authenticated endpoint** (no dependency, but needs deploy wiring that does not exist and an endpoint that must be protected).

### Q2 — ✅ ANSWERED: defer email to Week 4. (Blocked Task 12.)

**Owner decision: defer**, as recommended. **Task 12 is dropped from Week 3** — dropped, not deferred inside it — so this week is **12 tasks** and ships **on-screen confirmation (Task 9) plus booking lookup (Task 10)**. Week 4 builds the layer once, with `nodemailer` over SMTP per §2's stack, covering all seven of §11's notification events together.

**`LAUNCH_CHECKLIST.md` now carries: test SMTP sending from the VPS EARLY**, before Week 4 writes code against it. IONOS has blocked outbound SMTP on another of the owner's projects, so this is a known failure mode, and it is a hosting-level block no application code works around. The fallback, if it is blocked, is a provider's REST API over plain `fetch` — the same pattern as the PayMongo provider, and no new dependency.

### Q3 — ✅ ANSWERED: stay on checkout, clear the date, offer the next three; and yes, a server-side quote id.

**Owner decision: approved as recommended.** When capacity goes between quote and submit, the loser **stays on the checkout page** with the date cleared, an **amber** "just sold out" notice (never red — CLAUDE.md) and **the next 3 available dates offered inline**, so the guest's typing is never thrown away. §5's "one wins, one gets 'just sold out'" is the behaviour; this is the copy and the recovery path.

**And the quote carries a short-lived server-side quote id**, so a price cannot be replayed after an admin edits a tier. The id is the handle; the money stays on the server, which is what keeps this consistent with "the server computes all money" — the browser never holds a signed total it could replay.

### Q4 — ✅ ANSWERED: limit holds, three ways.

**Owner decision.** All three apply together, and **each owes its own test**:

| Limit                                      | Scope                                 |
| ------------------------------------------ | ------------------------------------- |
| Max **2 active unpaid holds per email**    | Counted on `bookings`, under the lock |
| Max **2 active unpaid holds per phone**    | Same, independently — **AND**, not OR |
| **5 hold creations per IP per 15 minutes** | `express-rate-limit` on `createHold`  |

Holds expire on the spec's existing hold window; this adds no new expiry concept.

Two things Task 5 must honour. The email and phone caps are **AND, not OR** — one guest must not take four slots by reusing an email with two phone numbers — and both must be counted **inside the same locked transaction that creates the hold**, or two concurrent submits both read "1 active hold" and both win, leaving a limit that reads as enforced while not being. The per-IP limiter is the weakest of the three alone (office and carrier NAT share addresses), which is why it is a third layer rather than the only one.

### Q5 — ✅ ANSWERED: measured from creation, and extended ONCE at the gateway redirect.

**Owner decision: approved as recommended.** `hold_expires_at = created_at + 15 min` per §5. **At the moment the guest is redirected to the gateway, the hold is extended once to 30 minutes total** — a single, bounded extension, written to `audit_log`, and never repeatable.

The reason: a guest who has reached the payment page has committed, and `recordPayment()`'s `payment_review_required` queue should hold genuine anomalies — a webhook for a cancelled booking, a late manual transfer — not someone who typed their card number slowly. §6's manual-QR flow already "stops the expiry" on receipt upload, so extending on a payment attempt is the established precedent, not a new concept.

**It does not change what happens if the money still lands late:** `recordPayment()` records it, leaves the status alone and raises `payment_review_required`. The extension makes that path rarer; it must not be mistaken for removing it.

### Q6 — ✅ ANSWERED: card, GCash, Maya, GrabPay. Nothing else.

**Owner decision: approved as recommended.** `createCheckout` requests exactly **`card`, `gcash`, `maya`, `grab_pay`**.

- **`bank_transfer` and `cash` are never offered online** — both are manual flows an admin reconciles by hand (§6's QR path, and §8's driver cash, which `recordPendingCash()` already keeps out of `amount_paid_centavos`).
- **`qrph` is held back** until §15's own open Q2 (QR payments) is answered. Offering it now would mean guessing how the QR flow reconciles, which is exactly the kind of guess that becomes a money bug.

### Q7 + Q8 — ✅ ANSWERED: a hold reserves capacity AND coupon usage in one locked transaction; expiry releases both.

**Owner decision.** An active hold reserves **both** capacity (fleet slot + tour slot) **and** coupon usage, all **inside the same locked transaction**. Expiry releases both. A coupon slot therefore behaves exactly like a seat: reserved while held, returned when the hold lapses. That settles Q8 by the same mechanism — a cancellation or refund releases the redemption the way expiry does, because the reservation is tied to the hold's life, not to the payment.

Two tests, named by the owner: **the last slot cannot be held by two guests**, and **a single-use coupon cannot be held twice**.

Three things this binds, which the implementer must not rediscover by guessing:

1. **Lock order gains a third lock.** The core-schema plan fixes `fleet_date_slots(date)` **before** `tour_date_slots(tour_id, date)`. The coupon row is taken **LAST**, after both slot locks — otherwise two guests holding different tours with the same coupon can deadlock.
2. `coupon_redemptions` is unique on `(coupon_id, booking_id)`, which stops one booking double-redeeming but **not** two bookings racing the last slot, so `used_count` must move under the lock rather than be derived afterwards.
3. The expiry sweep (Task 11) now releases **two** things per hold, and Q1's idempotency condition covers both: a second run must not decrement `used_count` twice.

### Q9 — ✅ ANSWERED: guest checkout, no account, exactly §6's fields.

**Owner decision: approved as recommended.** A guest checks out with **no account and no password**, and **no account is created at checkout**. The form collects exactly §6's fields: **full name, PH mobile, email, pickup location text + optional Google Maps pin, special requests**. The **pin is optional at launch**.

Portal access afterwards is §7's **booking ref + email** — which is why the booking ref must stay random and non-sequential (CLAUDE.md), since it is doing the work a password would otherwise do.

The Data Privacy Act consent checkbox (RA 10173) is part of this form, not a later addition.

### Q10 — ✅ ANSWERED: accept both forms, store one.

**Owner decision: approved as recommended.** Accept **both `09XXXXXXXXX` and `+639XXXXXXXXX`**, **strip spaces and dashes before validating** (the seed's own numbers are `0908 469 6246` style, and a guest who types their number the way they read it must not be rejected), **store normalised as `+639XXXXXXXXX`**, and reject everything else.

**One shared Zod schema in `/shared`**, used by both checkout and booking lookup — if the two drift, a guest can create a booking they cannot then look up, which is the worst possible place for a validation mismatch.

---

## Task 1: Shared checkout schemas

**Files:**

- Create: `shared/src/checkout.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/src/__tests__/checkout.test.ts`

**Interfaces:**

- Consumes: `bookingRefSchema`, `PAY_MODES` from `shared/src/booking.ts`.
- Produces: `quoteInput`, `QuoteInput`, `quoteResultSchema`, `QuoteResult`, `createHoldInput`, `CreateHoldInput`, `bookingLookupInput`.

Everything the browser sends is validated here, and **nothing the browser sends is money**. A quote request names a tour, a date, a head count, add-on ids and an optional coupon code. It never carries a price.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { quoteInput, createHoldInput } from '../checkout';

describe('quoteInput', () => {
  it('accepts a minimal quote request', () => {
    expect(
      quoteInput.safeParse({
        tourSlug: 'oslob-whale-shark-tumalog-falls',
        date: '2026-12-25',
        pax: 4,
      }).success,
    ).toBe(true);
  });

  it('REFUSES any money field the browser tries to send', () => {
    const withMoney = {
      tourSlug: 'oslob-whale-shark-tumalog-falls',
      date: '2026-12-25',
      pax: 4,
      totalCentavos: 1,
    };
    // .strict(): an unknown key is a rejection, not a silently dropped field.
    // The server computes all money (CLAUDE.md); a client that sends a price
    // should get an error, not have it quietly ignored.
    expect(quoteInput.safeParse(withMoney).success).toBe(false);
  });

  it('refuses a pax count outside 1..12', () => {
    const base = { tourSlug: 'x', date: '2026-12-25' };
    expect(quoteInput.safeParse({ ...base, pax: 0 }).success).toBe(false);
    expect(quoteInput.safeParse({ ...base, pax: 13 }).success).toBe(false);
  });

  it('refuses a date that is not a civil YYYY-MM-DD', () => {
    const base = { tourSlug: 'x', pax: 2 };
    expect(quoteInput.safeParse({ ...base, date: '25/12/2026' }).success).toBe(false);
    expect(quoteInput.safeParse({ ...base, date: '2026-12-25T00:00:00Z' }).success).toBe(false);
  });
});

describe('createHoldInput', () => {
  it('requires the data-privacy consent to be true', () => {
    const base = {
      tourSlug: 'x',
      date: '2026-12-25',
      pax: 2,
      payMode: 'deposit',
      lead: { name: 'A', email: 'a@b.com', phone: '09171234567' },
    };
    expect(createHoldInput.safeParse({ ...base, consent: false }).success).toBe(false);
    expect(createHoldInput.safeParse({ ...base }).success).toBe(false);
    expect(createHoldInput.safeParse({ ...base, consent: true }).success).toBe(true);
  });
});
```

The second test is the one that matters: prove it fails by dropping `.strict()`, which makes the extra `totalCentavos` silently ignored instead of rejected.

- [ ] **Step 2: Run it and watch it fail** — `pnpm --filter @rg/shared test checkout`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// shared/src/checkout.ts
import { z } from 'zod';
import { PAY_MODES } from './booking';

/** A civil date in Asia/Manila — the tour day, not an instant. */
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

/**
 * What the browser may ask for. `.strict()` is load-bearing: the server
 * computes all money (CLAUDE.md), so a request carrying `totalCentavos` is a
 * bug or an attack, and either way it must be refused rather than ignored.
 */
export const quoteInput = z
  .object({
    tourSlug: z.string().min(1).max(160),
    date: civilDate,
    pax: z.number().int().min(1).max(12),
    addonIds: z.array(z.number().int().positive()).max(20).default([]),
    couponCode: z.string().min(1).max(40).optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof quoteInput>;

export const createHoldInput = quoteInput
  .extend({
    payMode: z.enum(PAY_MODES),
    lead: z
      .object({
        name: z.string().min(1).max(160),
        email: z.email().max(200),
        /** See Q10 — the PH mobile rule is not yet decided. */
        phone: z.string().min(7).max(40),
      })
      .strict(),
    pickup: z.string().max(400).optional(),
    pickupMapUrl: z.string().url().max(500).optional(),
    requests: z.string().max(2000).optional(),
    /** RA 10173. Anything but `true` fails here, before the router runs. */
    consent: z.boolean().refine((v) => v === true, { message: 'Consent is required' }),
  })
  .strict();
export type CreateHoldInput = z.infer<typeof createHoldInput>;

export const bookingLookupInput = z
  .object({ ref: z.string().min(1).max(12), email: z.email().max(200) })
  .strict();
```

`quoteResultSchema` is defined in Task 2 alongside the service that produces it.

- [ ] **Step 4: Run the tests, prove each can fail, run the five checks separately, commit**

```bash
git commit -m "feat(checkout): shared schemas that refuse client-sent money"
```

**✅ DONE 1**

---

## Task 2: The pricing service

**Files:**

- Create: `server/src/services/pricing.ts`
- Modify: `shared/src/checkout.ts` (add `quoteResultSchema` / `QuoteResult`)
- Test: `server/src/__tests__/pricing.test.ts`

**Interfaces:**

- Consumes: `depositCentavos` from `@rg/shared`; `tours`, `tour_price_tiers`, `tour_addons`, `coupons`.
- Produces: `priceQuote(input: PriceQuoteInput): QuoteResult` — **pure**, and `loadQuoteInputs(slug, date, addonIds, couponCode)` which does the reading.

Split deliberately: the arithmetic is pure and exhaustively testable; the database reading is separate and thin. §5's formula, verbatim:

```
tier            = tier where min_pax <= pax <= max_pax
base            = tier.price_per_person_centavos * pax
addons          = sum(per_person ? price_centavos * pax : price_centavos)
subtotal        = base + addons
discount        = coupon applied to subtotal (percent or fixed, capped at subtotal)
total           = subtotal - discount
deposit         = depositCentavos(total, deposit_percent)
amount_due_now  = pay_in_full ? total : deposit
balance         = total - amount_due_now
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { priceQuote } from '../services/pricing';

const TIERS = [
  { id: 1, minPax: 1, maxPax: 3, pricePerPersonCentavos: 250000 },
  { id: 2, minPax: 4, maxPax: 6, pricePerPersonCentavos: 189000 },
];
const base = { tiers: TIERS, addons: [], coupon: null, depositPercent: 30, freeCancelHours: 24 };

describe('priceQuote', () => {
  it('picks the tier the head count falls in, not the cheapest', () => {
    expect(priceQuote({ ...base, pax: 2 }).tier.id).toBe(1);
    expect(priceQuote({ ...base, pax: 4 }).tier.id).toBe(2);
  });

  it('REFUSES a head count no tier covers rather than guessing', () => {
    expect(() => priceQuote({ ...base, pax: 11 })).toThrow(/no price tier/i);
  });

  it('multiplies a per-person add-on by pax and a per-group add-on once', () => {
    const addons = [
      { id: 1, name: 'Lunch', priceCentavos: 35000, perPerson: true },
      { id: 2, name: 'Drone video', priceCentavos: 150000, perPerson: false },
    ];
    const q = priceQuote({ ...base, pax: 4, addons });
    // base 189000*4 = 756000; lunch 35000*4 = 140000; drone 150000
    expect(q.subtotalCentavos).toBe(756000 + 140000 + 150000);
  });

  it('applies a percent coupon in basis points', () => {
    const q = priceQuote({
      ...base,
      pax: 4,
      coupon: {
        id: 7,
        code: 'SAVE10',
        discountType: 'percent',
        percentBp: 1000,
        amountCentavos: null,
      },
    });
    expect(q.subtotalCentavos).toBe(756000);
    expect(q.discountCentavos).toBe(75600); // 10.00%
    expect(q.totalCentavos).toBe(680400);
  });

  it('caps a fixed coupon at the subtotal — a discount never makes a total negative', () => {
    const q = priceQuote({
      ...base,
      pax: 1,
      coupon: {
        id: 8,
        code: 'BIG',
        discountType: 'fixed',
        percentBp: null,
        amountCentavos: 99_999_900,
      },
    });
    expect(q.discountCentavos).toBe(250000);
    expect(q.totalCentavos).toBe(0);
  });

  it('rounds the deposit UP to a whole peso via the shared helper', () => {
    // 189000*4 = 756000; 30% = 226800 -> ceil to 227000
    const q = priceQuote({ ...base, pax: 4 });
    expect(q.depositCentavos).toBe(227000);
  });

  it('amount due now is the total in full mode and the deposit otherwise', () => {
    const q = priceQuote({ ...base, pax: 4 });
    expect(q.amountDueNowCentavos.full).toBe(q.totalCentavos);
    expect(q.amountDueNowCentavos.deposit).toBe(q.depositCentavos);
    expect(q.balanceCentavos.deposit).toBe(q.totalCentavos - q.depositCentavos);
  });

  it('returns only integers — no float ever touches money', () => {
    const q = priceQuote({
      ...base,
      pax: 4,
      coupon: { id: 9, code: 'ODD', discountType: 'percent', percentBp: 333, amountCentavos: null },
    });
    for (const v of [q.subtotalCentavos, q.discountCentavos, q.totalCentavos, q.depositCentavos]) {
      expect(Number.isInteger(v), `${v} is not an integer`).toBe(true);
    }
  });
});
```

The cap test is the one that protects real money: prove it fails by removing the `Math.min`, and the total goes negative.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement** — pure, integer arithmetic throughout, `Math.floor` on the percent branch so a discount never rounds **up** against the business, and `Math.min(discount, subtotal)` as the cap. Call `depositCentavos()` from `@rg/shared`; do not restate the rounding rule.

- [ ] **Step 4: Add `quoteResultSchema` to `shared/src/checkout.ts`** mirroring the return type, so the client's rendering is type-checked against what the server sends.

- [ ] **Step 5: Run the tests, prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): server-side pricing, pure and exhaustively tested"
```

**✅ DONE 2**

---

## Task 3: Coupon validation

**Files:**

- Create: `server/src/services/coupons.ts`
- Test: `server/src/__tests__/coupons.test.ts`

**Interfaces:**

- Consumes: `coupons`, `coupon_redemptions`.
- Produces: `validateCoupon(code, subtotalCentavos, now): Promise<ValidCoupon>` (throws a typed error otherwise), `recordRedemption(tx, couponId, bookingId)`.

§6: "server-validated: active, within dates, under usage limit, minimum spend". Each is a separate refusal with its own error, because the checkout UI must tell a guest _which_ rule they failed — "this code expired" and "spend ₱500 more" are different messages.

- [ ] **Step 1: Write the failing test** covering, each as its own case with its own error type: unknown code; `is_active = false`; before `starts_at`; after `ends_at`; `used_count >= usage_limit`; subtotal below `min_spend_centavos`; and a valid coupon returning its discount shape. Use a fixture inside a rolled-back transaction (`schema-coupons.test.ts` shows the pattern).

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Compare dates in UTC against `now` passed in — **never `new Date()` inside**, so the window tests run in milliseconds. `recordRedemption` relies on the `UNIQUE (coupon_id, booking_id)` index rather than checking first.

- [ ] **Step 4: Prove each refusal can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): coupon validation with one error per rule"
```

**✅ DONE 3**

---

## Task 4: The capacity service

**Files:**

- Create: `server/src/services/capacity.ts`
- Test: `server/src/__tests__/capacity.test.ts`

**Interfaces:**

- Consumes: `bookings`, `tours`, `vans`, `drivers`, `driver_leaves`, `tour_date_slots`, `fleet_date_slots`, `CAPACITY_HOLDING_STATUSES`.
- Produces: `takeSlotLocks(tx, tourId, date)`, `assessCapacity(tx, tourId, date, pax): Promise<CapacityVerdict>`.

**The owner's Q7 rule, verbatim (BUILD_SPEC §5, _pending R&G confirmation_):** each booked group requires one van. Per tour per day, accept bookings up to `MIN(tour.groups_per_day, vans free that day across all tours)`. Never overbook automatically; an admin may override with a reason, and the override writes to `audit_log`.

**The lock order is fixed:** `fleet_date_slots(date)` **first**, then `tour_date_slots(tour_id, date)`. Both created on demand with `INSERT … ON DUPLICATE KEY UPDATE`, then `SELECT … FOR UPDATE`. Taking them in the other order deadlocks under load — and a deadlock passes every sequential test.

- [ ] **Step 1: Write the failing test**

Cases: a tour at `groups_per_day` refuses the next booking; a fleet with every van committed refuses even when the tour has room (this is the cross-tour case the fleet lock exists for); a van too small for `pax` does not count; a `for_repair` van does not count; a driver on leave does not count; only `CAPACITY_HOLDING_STATUSES` consume capacity — a `cancelled` or `expired` booking frees its slot. Plus the concurrency case:

```ts
it('serialises two bookings for DIFFERENT tours on the same date', async () => {
  // The reason fleet_date_slots exists. Both tours have room; the fleet has
  // exactly one van. Without the date-level lock both transactions read
  // "one van free" and both succeed.
  const results = await Promise.allSettled([bookOnTour(tourA, DAY), bookOnTour(tourB, DAY)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
```

**Drive it concurrently, not sequentially.** A sequential pair passes against code with no lock at all. (The same lesson landed in A5b: a non-locking re-read still returned a stale `pending` under REPEATABLE READ, and only a concurrent test exposed it.)

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** `assessCapacity` returns `{ ok: true }` or `{ ok: false, reason }` — it does not throw, because the caller turns the reason into guest-facing copy. Every read happens through `tx`, after the locks.

- [ ] **Step 4: Prove the concurrency test fails without the fleet lock** — drop it and watch both bookings commit. Restore. Five checks separately, commit.

```bash
git commit -m "feat(checkout): capacity under the fleet-then-tour lock order"
```

**✅ DONE 4**

---

## Task 5: `createHold()`

**Files:**

- Create: `server/src/services/create-hold.ts`
- Test: `server/src/__tests__/create-hold.test.ts`

**Interfaces:**

- Consumes: `priceQuote`, `validateCoupon`, `takeSlotLocks`, `assessCapacity`, `insertBookingWithRef`, `writeAudit`.
- Produces: `createHold(input: CreateHoldInput): Promise<{ ref: string; bookingId: number; holdExpiresAt: Date }>`.

One transaction: take both locks in order, assess capacity, recompute the quote **server-side from the database** (never from anything the client sent), insert the booking with `status='pending_payment'` and `hold_expires_at = now + 15 minutes`, write the price snapshot, insert the add-on lines, and write an audit row.

**The price snapshot must freeze what the core-schema plan requires** (owner decision Q5): the tier used, every add-on with its price and per-person flag, the coupon, the deposit percent **and the tour's `free_cancel_hours`** — so a later edit to the tour cannot change what this guest agreed to.

- [ ] **Step 1: Write the failing test** — a successful hold writes exactly one booking with `pending_payment`, a `hold_expires_at` 15 minutes out, a snapshot containing `freeCancelHours` and `depositPercent`, one `booking_addons` row per add-on, and one audit row; a capacity refusal writes **nothing** (assert the row count, not the thrown error); and the quote the booking stores matches a fresh `priceQuote()` over the same inputs — so a client-sent price cannot influence it.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): one transaction from quote to held booking"
```

**✅ DONE 5**

---

## Task 6: The checkout tRPC router

**Files:**

- Create: `server/src/routers/public/checkout.ts`
- Modify: `server/src/routers/_app.ts`
- Test: `server/src/__tests__/checkout-router.test.ts`

**Interfaces:**

- Consumes: `priceQuote`/`loadQuoteInputs`, `validateCoupon`, `assessCapacity`, `createHold`, `publicProcedure`.
- Produces: `checkout.quote`, `checkout.availability`, `checkout.createHold`.

All three are **`publicProcedure`** — a guest has no session. Task A4's enumeration guard requires every procedure to be built through `publicProcedure` or `adminProcedure(area)`, so using anything else fails the suite.

- [ ] **Step 1: Write the failing test** — `quote` returns a server-computed total for a real tour; `quote` with an unknown coupon returns a typed error naming the rule, not a 500; `createHold` refuses `consent: false` (Zod, before the resolver); `createHold` returns a ref matching `bookingRefSchema`; and **a request carrying `totalCentavos` is rejected** — the `.strict()` schema's whole purpose, asserted at the router boundary where it actually matters.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Thin resolvers: validate, call the service, map a typed service error to a `TRPCError` with a guest-safe message. Never let a service error's raw message through — the tRPC `errorFormatter` scrubs paths but the message is still yours to choose.

- [ ] **Step 4: Prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): quote, availability and hold procedures"
```

**✅ DONE 6**

---

## Task 7: Starting a PayMongo payment

**Files:**

- Modify: `server/src/routers/public/checkout.ts`
- Test: `server/src/__tests__/checkout-payment.test.ts`

**Interfaces:**

- Consumes: `getProvider`, `paymongoProvider.createCheckout`, `bookings`.
- Produces: `checkout.startPayment({ ref }) → { redirectUrl }`.

**This is the first real use of `createCheckout()`.** Task 16 built it from PayMongo's documentation and never called it; its own report flagged that the field names are unconfirmed. Treat a surprise here as expected, not as a defect in this task.

The amount comes from the **booking**, never the request: `amount_due_now` is `total_centavos` or the deposit per the booking's `pay_mode`, both already frozen in the snapshot. The booking ref goes in `metadata` so the webhook can find it. PayMongo's amounts are already centavos, so there is no conversion.

**It must refuse to start a payment for a booking that is not `pending_payment`** — an expired or confirmed booking cannot be paid again — and the test must assert no gateway call was attempted, not merely that it threw.

- [ ] **Step 1: Write the failing test** with the transport stubbed; `globalThis.fetch` replaced by a throw, plus an assertion it was never called. Cases: a held booking returns a redirect URL and sends the right amount and metadata; an expired booking is refused with no call; an already-confirmed booking is refused with no call; a missing `PAYMONGO_SECRET_KEY` fails with a clear error rather than a silent skip.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** `getProvider('paymongo')` — **branch on `manual` first** if you ever generalise this, because `manual` is a valid `ProviderName` the registry deliberately never resolves.

- [ ] **Step 4: Prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): start a PayMongo test-mode payment from a held booking"
```

**✅ DONE 7**

---

## Task 8: The checkout page

**Files:**

- Create: `client/src/pages/public/CheckoutPage.tsx`, `client/src/components/checkout/{QuoteSummary,GuestDetails,CouponField,HoldCountdown,ConsentCheckbox}.tsx`
- Modify: `client/src/App.tsx`
- Test: `client/src/__tests__/checkout-page.test.tsx`

**Interfaces:**

- Consumes: `trpc.checkout.quote`, `trpc.checkout.createHold`, `QuoteResult`.

**Use the ui-ux-pro-max skill** (Skill tool) before writing markup — CLAUDE.md requires it for all UI work, and this is the highest-stakes screen in the product.

Non-negotiables, all already enforced by existing guards:

- **The page never computes money.** It renders `QuoteResult` fields. No `*` or `+` on a centavos value anywhere in `client/`. Add a test asserting that.
- **No red.** Validation messages use the existing error ink (`#334155`) and warnings use amber. `no-red.test.ts` fails the build otherwise.
- **360px, 44px targets, AA contrast.** `contrast.test.ts` checks any new `bg-brand-*`/`text-brand-*` pairing.
- **Motion is Tailwind transitions only** — `transition-*`, `duration-*`, `ease-*`. No animation library; `emilkowalski-motion` is not installed here. The blanket `prefers-reduced-motion` block in `index.css` already neutralises them.
- **The consent checkbox follows the existing pattern** in `ContactSection.tsx`: a custom inline message, not HTML `required`, with the label naming `SITE.legalOperator` (R&G Travel & Tours) because consent is a legal matter.
- **The hold countdown is display only.** It must not expire the booking client-side; the server's `hold_expires_at` is the truth and the cron is what acts on it. When it reaches zero, re-query status rather than asserting an outcome.

- [ ] **Step 1: Write the failing test** — renders a quote without recomputing it (mock `checkout.quote`, assert the rendered peso figures come from the mock verbatim); consent unchecked blocks submit with a visible message; a 429 shows the calm rate-limit copy (`describeMutationError` already exists); the countdown renders and does not mutate anything at zero.

- [ ] **Step 2–4: Implement, prove each test can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): the checkout page, rendering a server quote"
```

**✅ DONE 8**

---

## Task 9: The booking status page — read only

**Files:**

- Create: `client/src/pages/public/BookingStatusPage.tsx`
- Modify: `client/src/App.tsx`, `server/src/routers/public/checkout.ts`
- Test: `client/src/__tests__/booking-status.test.tsx`, extend `server/src/__tests__/checkout-router.test.ts`

**Interfaces:**

- Produces: `checkout.bookingStatus({ ref })` → status, amounts and tour summary. **No mutation on this route at all.**

§6: "The success redirect page only **reads** status (polls until the webhook lands). It never confirms anything itself." This is the single most important property in Week 3's UI, and it is also the easiest to break by accident, because the obvious implementation of a success page is to mark the thing successful.

- [ ] **Step 1: Write the failing test**

```ts
it('exposes no mutation that could confirm a booking', () => {
  const procs = Object.entries(appRouter._def.procedures);
  const checkoutMutations = procs
    .filter(([name]) => name.startsWith('checkout.'))
    .filter(([, p]) => (p as { _def: { type: string } })._def.type === 'mutation')
    .map(([name]) => name);
  // createHold and startPayment are the only two. A third mutation here is
  // how a redirect page quietly becomes a way to confirm a booking.
  expect(checkoutMutations.sort()).toEqual(['checkout.createHold', 'checkout.startPayment']);
});
```

Plus: polling renders `pending_payment` then `confirmed` without issuing a mutation (assert the mutation spy was never called); an unknown ref returns a generic not-found, never leaking whether the ref exists.

- [ ] **Step 2–4: Implement, prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): a status page that only reads"
```

**✅ DONE 9**

---

## Task 10: Booking lookup, rate-limited

**Files:**

- Modify: `server/src/routers/public/checkout.ts`, `server/src/middleware/rate-limit.ts`
- Test: extend `server/src/__tests__/checkout-router.test.ts`

**Interfaces:**

- Produces: `checkout.bookingLookup({ ref, email })`, `createBookingLookupLimiter()`.

§7: ref + email, case-insensitive; **5 failed attempts per IP per 15 minutes**; and "the same generic error for wrong ref or wrong email (don't reveal which)".

That last rule is a real security property and the easy thing to get wrong: a lookup that returns "no such booking" for a bad ref and "wrong email" for a bad email turns the endpoint into a ref oracle. **Both failures must be byte-identical**, including timing-insensitive behaviour as far as is reasonable.

Follow the scoped-limiter pattern already in `rate-limit.ts` (Task 21 added `createDriverLoginLimiter()` the same way, with a guard test that fails the build if the procedure exists unmounted — mirror that).

- [ ] **Step 1: Write the failing test** — correct pair returns the booking; wrong email returns the **same** error object as an unknown ref (assert deep equality of the two responses, which is what makes this non-vacuous); email match is case-insensitive; the 6th attempt from one IP inside the window is refused; the limiter is actually mounted and scoped to this procedure.

- [ ] **Step 2–4: Implement, prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(checkout): booking lookup that reveals nothing and is rate-limited"
```

**✅ DONE 10**

---

## Task 11: The hold-expiry sweep — **UNBLOCKED (Q1: `node-cron`)**

**Files:**

- Create: `server/src/jobs/expire-holds.ts`, `server/src/jobs/index.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/__tests__/expire-holds.test.ts`

**Q1 answered: install and use `node-cron`**, which CLAUDE.md's stack already names. Run it **every minute**, in a **single process** (PM2 fork mode, 1 instance — see `LAUNCH_CHECKLIST.md`; under cluster mode every worker runs the schedule and each sweep fires N times).

Keep the shape the blocked version specified, because it is what makes the sweep testable without a scheduler: export `expireHolds(now: Date): Promise<{ expired: number }>`, pure of scheduling, and let `node-cron` call it. **The tests drive `expireHolds()` directly and never wait on a timer.**

**It must be idempotent** (Q1 condition): a second run, a restart mid-tick or two overlapping ticks must not change the outcome — and that now covers releasing the **coupon redemption** as well as capacity (Q7/Q8), so `used_count` must not be decremented twice for one expired hold. Owes a test.

§5: "Cron (every minute) moves expired, unpaid holds to `expired` and frees capacity."

**The rule that is easy to miss, and carries real money:** the sweep **must skip `payment_review_required = 1`**. `recordPayment()` deliberately leaves `hold_expires_at` set on that path, so a booking whose guest paid _after_ their hold lapsed still looks expired to a naive `WHERE status = 'pending_payment' AND hold_expires_at < NOW()`. Expiring it would hide a guest who has paid from the very review queue meant to catch them. This is carry-forward item 1 from the core-schema plan.

- [ ] **Step 1: Write the failing test**

```ts
it('expires a lapsed unpaid hold', async () => {
  /* status -> 'expired', audit row written */
});

it('does NOT expire a lapsed hold that has been PAID and flagged for review', async () => {
  // The carry-forward case. recordPayment() leaves hold_expires_at set, so
  // this booking matches a naive WHERE clause — and expiring it would bury a
  // guest who has already paid.
  const { bookingId } = await seedLapsedHold({ paymentReviewRequired: true });
  await expireHolds(new Date());
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  expect(row.status, 'a paid booking was expired by the cron').not.toBe('expired');
});

it('leaves a hold that has not lapsed yet', async () => {
  /* … */
});
it('writes one audit row per expiry, actor_type system', async () => {
  /* … */
});
it('is idempotent — a second sweep expires nothing', async () => {
  /* … */
});
```

Prove the second test fails by removing the `payment_review_required` condition.

- [ ] **Step 2–4: Implement, prove each can fail, five checks separately, commit**

```bash
git commit -m "feat(jobs): expire lapsed holds, never the ones that were paid"
```

**✅ DONE 11**

---

## Task 12: Confirmation email — **DROPPED from Week 3 (Q2: defer to Week 4)**

**Do not build this task.** The owner deferred email to Week 4, so Week 3 is **12 tasks** and ships on-screen confirmation (Task 9) plus booking lookup (Task 10). The booking is confirmed and visible without an email, and nothing else in this plan depends on it.

**Handover to Week 4** — the constraints that still hold whenever the layer is built, recorded here so they are not rediscovered:

- `nodemailer` over SMTP per §2's stack, built **once** for all seven of §11's events rather than twice.
- Sends go **outside** the webhook's transaction: an SMTP timeout must never roll back a confirmed payment.
- Failures are **logged and never block the booking flow** (§11).
- **First, test SMTP from the VPS** (now in `LAUNCH_CHECKLIST.md`). IONOS has blocked outbound SMTP on another of the owner's projects; the fallback is a provider's REST API over plain `fetch`, the same pattern as the PayMongo provider.

**✅ DONE 12 — dropped, not built.**

---

## Task 13: Correct the spec's Week 3 preamble

**Files:**

- Modify: `docs/BUILD_SPEC.md` §13

§13 currently says Week 3 has nothing built, that there is no `server/src/webhooks` and no gateway client, and that the week is blocked on the core schema with Q7 and Q4 open. **All four statements are now false.** Rewrite the preamble to say what is actually true: the schema is migrated, the webhook route and PayMongo provider exist, Q7/Q4 were answered on 2026-10-11, and the remaining blockers are this plan's Q1 (scheduler) and Q2 (email).

Mark each 3A–3F line with what this plan's tasks deliver, and leave `✅ DONE` off until the work is actually done — §13's markers were audited once already for exactly this reason.

- [ ] **Run `pnpm format:check` and commit**

```bash
git commit -m "docs(spec): week 3's preamble no longer describes a world that existed"
```

**✅ DONE 13**

---

## Which test proves which constraint

| Constraint                                              | Proven by                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The client cannot send money                            | Task 1 `.strict()` tests + Task 6 asserting it at the router boundary                    |
| The client cannot compute money                         | Task 8's scan for arithmetic on centavos in `client/`                                    |
| Pricing matches §5's formula                            | Task 2 — tier selection, add-on modes, coupon cap, deposit rounding, integers only       |
| A discount never makes a total negative                 | Task 2's cap test                                                                        |
| Capacity honours `MIN(groups_per_day, free vans)`       | Task 4                                                                                   |
| Two tours on one date serialise on the fleet            | Task 4's **concurrent** test                                                             |
| A held booking freezes its refund rights                | Task 5 — snapshot carries `freeCancelHours` and `depositPercent`                         |
| A capacity refusal writes nothing                       | Task 5, asserting row counts                                                             |
| Payment can only start from a `pending_payment` booking | Task 7, asserting no gateway call was attempted                                          |
| **The success page cannot confirm anything**            | Task 9's procedure enumeration — only two checkout mutations exist                       |
| Lookup reveals nothing about which half was wrong       | Task 10, asserting the two error responses are deeply equal                              |
| Lookup is rate-limited and the limiter is mounted       | Task 10                                                                                  |
| **The cron never expires a booking that was paid**      | Task 11's `payment_review_required` test                                                 |
| A booking still becomes paid only via webhook or admin  | Unchanged from Phase 3; Task 9 adds the guard that Week 3 did not introduce a third path |

---

## Self-review

**1. Spec coverage.** §5 pricing → Task 2; §5 capacity → Task 4; §5 holds → Tasks 5 and 11; §6 checkout page → Task 8; §6 coupon validation → Task 3; §6 online payment → Task 7 (the webhook half already exists); §6 success redirect reads only → Task 9; §7 lookup + rate limit → Task 10; §11 confirmation email → Task 12 (blocked). Week 3's 3A–3F all map: 3A→2, 3B→4, 3C→5+11, 3D→8+3, 3E→7, 3F→9+12.

**Deliberate gaps, stated:** manual QR upload is §6 but Week 4 (`pending_verification` already exists for it); the customer portal's authenticated views are Week 4; the admin review queue for `payment_review_required` is Weeks 5–7 and already on the launch checklist; "X slots left today" is a §13 roadmap item, not a Week 3 task.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 3, 5, 8, 10 and 11 give full test _cases_ and implementation _shape_ rather than complete bodies, because their bodies depend on answers to Q3, Q5, Q7 and Q10 — named limits, not placeholders. Every test whose behaviour is already decided is written out.

**3. Type consistency.** `QuoteInput`/`QuoteResult`/`CreateHoldInput` are defined in Task 1–2 and used by 5, 6, 8. `priceQuote` is named identically in 2, 5, 6. `assessCapacity`/`takeSlotLocks` in 4 are used by 5. `createHold` returns `{ ref, bookingId, holdExpiresAt }` and 6 and 8 consume exactly that. `expireHolds(now)` in 11 takes the clock, matching the pure-function discipline of `evaluatePinAttempt` and `priceQuote`.

---

## What happens after approval

1. Answer Q1 and Q2 — they block Tasks 11 and 12. Q3–Q10 shape behaviour and are cheaper now than after guests have booked.
2. Execute with `superpowers:subagent-driven-development`, one task per subagent, reviewing between.
3. Expect roughly 90–120 new tests, every one proven able to fail.
4. Nothing here changes how a booking becomes paid. If a task seems to require it, that is the signal to stop and ask.
