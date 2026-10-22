# TravelSugbo — Full Build Spec

> Public brand: **TravelSugbo** (TravelSugbo.com).
> Legal operator: **R&G Travel & Tours** — holds the DOT/DTI/BIR registrations,
> the PayMongo merchant account and the payment QR. Customer-facing copy uses
> the brand; anything regulatory, legal or financial names the operator.

> Master build document for Claude Code. Read this file fully before starting any task.
> The approved HTML demo is the visual and feature reference. Where this spec and the demo disagree, **this spec wins** — ask if unclear.

---

## 0. Before you start (read every session)

- **Check `CLAUDE.md` first** to confirm current standing conventions before implementing anything.
- Use **Superpowers** (`writing-plans` + `subagent-driven-development`) for each week's work. Write the plan, get approval, then execute.
- Use **ui-ux-pro-max** for all UI, layout, and design work.
- Use **emilkowalski-motion** for motion/animation only, and only after the layout exists.
- Write **✅ DONE** right after each numbered task (1A, 1B…) actually finishes, not just at the end of a week.
- Write **✅ WEEK X COMPLETE** when every task in that week is done and verified.
- Report commits as `hash - short human label` (e.g. `55f1bba - Checkout deposit math`).
- After any schema change, remind the user that the server database needs the migration applied.

### DO NOT (hard boundaries)

- **DO NOT** trust prices, totals, deposits, or discounts sent from the browser. The server computes all money.
- **DO NOT** mark a booking paid from the client side or from a redirect URL. Only a verified gateway webhook or an admin approval does that — for **every** provider, including any added later.
- **DO NOT** store card numbers, CVV, or e-wallet credentials anywhere. The payment gateway handles them.
- **DO NOT** expose receipt uploads, driver data, or customer details through public URLs.
- **DO NOT** let one role reach another role's endpoints. Hiding a button is not access control.
- **DO NOT** change auth, payment, or database schema logic outside the task you were given.
- **DO NOT** deploy to production from this spec. Deployment is a separate, dedicated prompt.
- **DO NOT** add libraries, services, or features not listed here without asking.
- **DO NOT** use red anywhere in the UI (brand rule).
- **DO NOT** fake social proof. Ratings, "booked X times," and guest counts must come from real data or admin-entered settings.

### When in doubt — stop and ask

Stop and ask the user before changing anything if:

- A task touches payments, refunds, auth, roles, or the schema in a way not described here.
- The spec is ambiguous or conflicts with the demo.
- A fix would require changing a feature that already works.
- You'd need a new dependency or external service.

### Unrelated bugs

If you find a bug unrelated to the current task, **don't stop or fix it**. Finish the task, then list it at the end (name + one-line description) and wait for instructions. Exception: flag immediately only if it blocks the current task.

### Working principles

- Prefer simple solutions. No over-engineering, no duplicate data.
- High confidence over speed. Test every flow more than once before calling it done.
- Build additively. Once a feature works, extend it with new routes, components, or tables. Don't rewrite it.

---

## 1. Project overview

| Item           | Value                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand          | TravelSugbo (public-facing)                                                                                                                                   |
| Legal operator | R&G Travel & Tours, Cebu, Philippines                                                                                                                         |
| Business       | Day tours + multi-day packages (not van rentals)                                                                                                              |
| Domain         | TravelSugbo.com                                                                                                                                               |
| Hosting        | IONOS VPS M+ (2 vCPU, 4 GB RAM), Ubuntu, nginx, PM2                                                                                                           |
| Payments       | Multi-gateway behind one interface — PayMongo first (GCash, Maya, GrabPay, card, PayPal if enabled on account, QR Ph), Xendit addable without a schema change |
| Timeline       | 8 weeks                                                                                                                                                       |
| Users          | Guests, customers (booked guests), drivers, admin staff                                                                                                       |

### Five surfaces

1. **Public website**: catalog, tour pages, reviews, packages, contact.
2. **Checkout**: pay full or 30% deposit; online through the active gateway, or manual QR transfer.
3. **Customer portal**: track booking, upload receipt, see driver, review.
4. **Driver portal**: trips, guest contact, payment to collect, stop check-ins.
5. **Admin & dispatch**: bookings, verification, calendar, fleet, drivers, pricing, reports.

---

## 2. Tech stack

| Layer      | Choice                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend   | React + TypeScript + Vite + Tailwind + shadcn/ui                                                                                                           |
| Routing    | React Router                                                                                                                                               |
| API        | Express + tRPC                                                                                                                                             |
| ORM / DB   | Drizzle + MySQL 8                                                                                                                                          |
| Validation | Zod (shared between client and server)                                                                                                                     |
| Auth       | Session cookies (httpOnly, secure, sameSite=lax), **scrypt via `node:crypto`** for passwords and PINs — owner decision 2026-10-14, replacing argon2/bcrypt |
| Payments   | `PaymentProvider` interface; PayMongo API + webhooks first, Xendit stubbed                                                                                 |
| Email      | SMTP via a transactional provider (configurable in `.env`)                                                                                                 |
| SMS        | Optional, behind a provider interface (off by default)                                                                                                     |
| Jobs       | `node-cron` in the server process (hold expiry, reminders, alerts)                                                                                         |
| Process    | PM2                                                                                                                                                        |
| Web server | nginx reverse proxy + Let's Encrypt SSL                                                                                                                    |

### SEO note (Vite SPA)

The public site needs search visibility. Handle it without SSR. **Built — task 2E.** What
shipped, as opposed to what was planned:

- Express serves `index.html` and **injects per-route `<title>`, meta description, canonical,
  Open Graph and Twitter tags** for `/`, `/tours`, `/privacy`, `/terms`, `/tours/:slug` and
  `/packages/:slug` from the database (`server/src/seo/resolvers.ts` → `seo/render.ts`, served
  by `server/src/html.ts`). `/privacy` and `/terms` were added to the planned list; a path that
  matches nothing resolves to 404 meta and is served with a real 404 status.
- **Dev injects the same meta through the same two modules**, via the `rg-seo-dev` middleware
  in `client/vite.config.ts`, so a wrong title shows up locally instead of only after a deploy
  (plan decision D6). That middleware only acts on requests that send `Accept: text/html` —
  a bare `curl` sends `*/*` and falls through to the static shell, which has no meta injected.
- The hero LCP `<link rel="preload">` travels with that per-route meta too, so only `/` carries
  it (task 4.4b). `client/index.html` is the shared shell and must not grow a preload again.
- `/sitemap.xml` and `/robots.txt` are generated from the database on every request
  (`server/src/seo/sitemap.ts`). `lastmod` is read from `updated_at`, never invented, and the
  sitemap never lists a URL that says `noindex`.
- JSON-LD ships on **every** public route, not only tour pages: a `TravelAgency` node
  everywhere, `FAQPage` on `/`, and `TouristTrip` on the two detail routes
  (`server/src/seo/jsonld.ts`).
- `AggregateRating` is built **only** from real reviews (`status = 'published' AND
is_sample = 0`, via `services/ratings.ts` → `realAggregate()`) and the key is omitted
  entirely when there are none — never a zero. With the current seed data no rating is
  emitted anywhere, because every seeded review is a sample.
- **While `settings.content_unverified` is true the whole site is noindex.** `robots.txt`
  answers `Disallow: /` and every route carries `noindex,nofollow`, whatever its own resolver
  asked for. Clearing that flag is now the act that publishes the site to search engines.
- `SITE_ENV` must be `production` in the deployed `.env` or `robots.txt` fails closed to
  `Disallow: /`. It defaults to `development`.

### Folder structure

```
/client          React app (public site + all portals)
  /src/pages/public
  /src/pages/portal       customer portal
  /src/pages/driver
  /src/pages/admin
  /src/components
  /src/lib
/server
  /src/routers            tRPC routers by domain
  /src/services           pricing, capacity, payments, notifications
  /src/jobs               cron jobs
  /src/webhooks           PayMongo webhook handler (plain Express route)
  /src/db                 Drizzle schema + migrations
/shared                   Zod schemas, types, constants
/uploads                  OUTSIDE the web root; receipts, served via auth route
```

### Conventions

- **Money:** integers in **centavos** everywhere (DB, API, logic). Format only at display.
- **Time:** store UTC; display and compute business dates in **Asia/Manila**.
- **IDs:** auto-increment internally; public booking ref is random, non-sequential (e.g. `RG-7KQ4M9`).
- **Soft deletes:** use `is_active` / status fields for tours, vans, drivers, users. Never hard-delete bookings or payments.
- **Audit:** every payment, refund, status change, and assignment writes to `audit_log`.

---

## 3. Brand & design

- **Colors:** blue (primary) and gold (accent). **No red**, including errors and badges. Use amber/orange for warnings and a dark blue/grey for errors.
- **Mobile-first.** Most guests book from a phone.
- **Match the approved demo** for layout, sections, and tone. Use **ui-ux-pro-max** to refine without changing structure.
- **Motion:** subtle only (card hovers, tracker progress, check-in confirmation) via **emilkowalski-motion**.
- **Accessibility:** 44px tap targets, visible focus states, alt text on all tour images, AA contrast.

---

## 4. Public website

### Routes

| Route                     | Page                                              |
| ------------------------- | ------------------------------------------------- |
| `/`                       | Home                                              |
| `/tours`                  | Tour catalog                                      |
| `/tours/:slug`            | Tour detail                                       |
| `/packages/:slug`         | Multi-day package detail + inquiry                |
| `/checkout/:holdId`       | Checkout                                          |
| `/booking/:ref/confirmed` | Confirmation                                      |
| `/contact`, `/faq`        | Optional standalone pages (sections also on home) |

### Home sections (in order)

1. **Hero:** search (destination + date + guests), trust line (rating, DOT accredited, guest count from settings).
2. **Trust bar** under the hero.
3. **Tour catalog preview** with destination filter.
4. **How booking works.**
5. **Why book direct** (6 reasons, editable in settings).
6. **Most visited places** (6).
7. **Multi-day packages** (3), with old vs new price → inquiry form.
8. **Guest reviews** (published, real).
9. **Promo band** + newsletter signup (code `RGTOURS10` shown after signup).
10. **FAQ** (7, editable).
11. **Contact us:** phone/Viber, WhatsApp, email, Facebook, office address, hours, inquiry form.
12. **Footer:** DOT / DTI / BIR permit numbers, payment logos.
13. **Floating WhatsApp button** on all public pages.

### Tour catalog

- Destination filter: Oslob, Mactan, Badian/Kawasan, Moalboal, Bohol, Cebu City (from DB, not hardcoded).
- Each card shows: photo, title, destination, average rating + count, total booked count, "booked X times this week" (real count from confirmed bookings in the last 7 days; hide if 0), "from ₱X" (lowest tier), free cancellation badge if enabled on the tour.

### Tour detail page

- Photo gallery (lightbox on mobile).
- About, itinerary (ordered stops), inclusions, exclusions.
- **Tiered group pricing table** (price per person drops with group size).
- Add-ons (per person or per group).
- Date picker: disables blocked dates, past dates, and dates at capacity.
- Guest picker: 1–12 (max from tour setting).
- Live price summary computed by calling the server pricing endpoint (no client-side math as the source of truth).
- **Reviews block:**
  - Average score, 5–1★ breakdown.
  - Sub-scores: guide, value, punctuality, safety.
  - Filter by stars, sort by newest / highest / most helpful.
  - "Verified booking" badge for reviews tied to a completed booking.
  - Business replies.
  - "Helpful" votes (one per browser via cookie + IP rate limit).
  - Write-a-review form → status `pending` → admin approval.

---

## 5. Pricing, capacity & holds (core logic)

All of this lives in `/server/src/services` and is unit-tested.

### Pricing

```
tier            = tier where min_pax <= pax <= max_pax
base            = tier.price_per_person_centavos * pax
addons          = sum(per_person ? price_centavos * pax : price_centavos)  for selected add-ons
subtotal        = base + addons
discount        = coupon applied to subtotal (percent or fixed, capped at subtotal)
total           = subtotal - discount
deposit         = ceil(total * deposit_percent / 100) rounded UP to a whole peso, clamped to total
                  (deposit_percent = 30 in settings; see the note below)
amount_due_now  = pay_in_full ? total : deposit
balance         = total - amount_paid   (collected on tour day)
```

> **Owner decision, 2026-10-11 (deposit rounding).** "ceil" and "to the nearest whole peso"
> disagree on any deposit with centavos — on ₱568.20, ceil gives ₱569 and nearest gives ₱568.
> **Ceil wins: always round UP to the next whole peso.** Clamped to the total, so a 100% deposit on
> a non-whole-peso total cannot exceed the price. Computed **server-side only**
> (`depositCentavos()` in `shared/src/money.ts`); the browser never sends a deposit.

- Store a **price snapshot** on the booking. It freezes the **tier price used**, **every add-on**
  with its price and per-person flag, the **coupon applied**, the **deposit percent** in force, and
  the tour's **`free_cancel_hours`** cancellation window, alongside the computed totals.
  **Refund and cancellation logic reads the snapshot, never the live tour** (owner decision
  2026-10-11). Later price edits don't change existing bookings — and neither does shortening a
  tour's cancellation window change the refund rights of someone who already booked.

### Capacity check (at checkout)

A booking is allowed when **all** are true for the tour + date:

1. Date is not past, not blocked for the tour, and the tour is active, and it falls inside the
   **bookable date window** (see below).
2. Bookings for that tour/date (statuses that hold capacity) < `groups_per_day`.
3. At least one **van** is free that day: active, not `for_repair`, `capacity >= pax`, not already assigned to a trip that date.
4. At least one **driver** is free that day: active, not on leave, not already assigned that date.

Steps 3–4 count already-confirmed-but-unassigned bookings as consuming one van and one driver each, so we never sell more trips than the fleet can run.

#### The bookable date window

The spec above says only "not past", which left today, the night before, and how far ahead a
guest may book undecided. These three are **settings**, not constants and not schema
(`settings.booking`, validated in `settings-schema.ts`, seeded in `SEED_SETTINGS`):

| Setting                     | Default   | Meaning                                                             |
| --------------------------- | --------- | ------------------------------------------------------------------- |
| `booking.minLeadDays`       | `1`       | Today is **not** bookable; tomorrow is the earliest date.           |
| `booking.nextDayCutoffTime` | `"18:00"` | Asia/Manila. At or after it, tomorrow stops being bookable too.     |
| `booking.maxAdvanceDays`    | `180`     | The furthest ahead a guest may book, counted from the Manila today. |

> **Proposed by developer 2026-10-13 — not yet confirmed with R&G.** All three defaults, and the
> decision to stop same-day bookings at all, are the developer's proposal standing in for a rule
> the spec never stated. Confirm each with R&G before launch; `nextDayCutoffTime` is the one that
> most needs a real answer, because it is the line between "we can still crew a van for tomorrow"
> and "we cannot", and `tours` has no departure-time column to anchor a per-tour cutoff to.

`bookableDateRange()` in `shared/src/time.ts` is the **only** definition of the window. What
answers from it **today**: `createHold()` (the authority — inside the locked transaction) and
`checkout.availability` (the early, friendly answer a picker can call per date). The window is
also published to the browser, resolved **server-side**, as `SettingsPayload.bookingWindow` (two
civil dates) — the raw settings never reach the client, for the same reason announcement
schedules do not: a browser clock in the wrong time zone must never evaluate a Manila rule.

**Not yet wired, and deliberately listed so nobody assumes otherwise:** the date picker does not
consume `bookingWindow` yet, and `checkout.quote` does **not** enforce the window — a quote for a
closed date still returns a price and a `quoteId`, and the hold then refuses it. So the quote is
not a gate, and `createHold()`'s check is not redundant with anything. Wiring the picker is a
separate task.
`createHold()` re-checks it inside the locked transaction, after `takeSlotLocks()`, and refuses
with its own reason (`date_not_bookable`) rather than a capacity one.

> **Owner decision, 2026-10-11 — _pending R&G confirmation_.** The rule above left open whether
> `groups_per_day` or the fleet is the binding limit. It is **both, whichever is smaller**:
>
> **Each booked group requires one van.** Per tour per day, accept bookings up to
> `MIN(tour.groups_per_day, vans free that day across all tours)`.
>
> - **Never overbook automatically.** The check refuses the booking; it does not warn and proceed.
> - An **admin may manually override** with a reason. The override writes to `audit_log`
>   (`booking.capacity_override`, with the reason in `data`). There is no override on the public
>   booking flow — only an authenticated admin can do it.
>
> Build to this rule now; confirm it with R&G before launch.

**Concurrency:** run the check and the booking insert in **one DB transaction** with a row lock on a `tour_date_slots` row (`SELECT … FOR UPDATE`). Two guests racing for the last slot: one wins, one gets "just sold out."

> **Resolved 2026-10-11 — two lock rows, in a fixed order.** The lock above is per tour, but "vans
> free that day **across all tours**" is date-global: two bookings for _different_ tours on the same
> date lock _different_ `tour_date_slots` rows, never wait for each other, and can both take the
> last van. So a second lock row exists, `fleet_date_slots (date)`, and every booking transaction
> takes **both, always in this order**:
>
> ```
> 1. fleet_date_slots(date)           SELECT ... FOR UPDATE   <- the shared fleet
> 2. tour_date_slots(tour_id, date)   SELECT ... FOR UPDATE   <- this tour's groups_per_day
> ```
>
> **Fleet first, tour second, no exceptions.** Two transactions taking the pair in opposite orders
> deadlock — A holds fleet and waits for tour while B holds tour and waits for fleet. A fixed global
> order makes that impossible rather than rare, and rare is the worst kind of concurrency bug.
> Both rows are created on demand with `INSERT ... ON DUPLICATE KEY UPDATE`.

### Holds

- Clicking "Book now" creates a booking with status `pending_payment` and `hold_expires_at = now + 15 min`.
- Holds consume capacity.
- Cron (every minute) moves expired, unpaid holds to `expired` and frees capacity.
- A receipt upload before expiry moves the booking to `pending_verification` and **stops the expiry**.

### Booking statuses

| Status                 | Meaning                                    | Holds capacity |
| ---------------------- | ------------------------------------------ | -------------- |
| `pending_payment`      | Hold active, waiting for payment           | Yes            |
| `pending_verification` | Manual receipt uploaded, waiting for admin | Yes            |
| `confirmed`            | Paid (deposit or full), no van/driver yet  | Yes            |
| `assigned`             | Van + driver assigned                      | Yes            |
| `in_progress`          | Driver started the trip                    | Yes            |
| `completed`            | Last stop checked in                       | No             |
| `cancelled`            | Cancelled by admin                         | No             |
| `expired`              | Hold timed out                             | No             |

Refunds are tracked on `payments`, not as a booking status.

### Assignment rule

- Bookings confirm automatically; van + driver are assigned later by dispatch.
- Admin calendar **auto-suggests** a van (smallest that fits) and an available driver.
- **Deadline:** unassigned bookings raise a dashboard alert 48 hours before the tour date. (Confirm with client; see Open questions.)

---

## 6. Checkout & payments

> **Owner-approved spec change — 2026-10-10: multi-gateway payments.**
> This section was PayMongo-only. The system must now support multiple payment gateways
> behind one `PaymentProvider` interface: **PayMongo is implemented first, and Xendit must
> be addable later without a schema change or a rewrite.** The `payments` table is
> provider-neutral, webhook idempotency is keyed on `(provider, provider_event_id)`, and
> the rule that only a verified webhook or an admin approval marks a booking paid now
> applies to every provider. The implementation plan is
> `docs/superpowers/plans/2026-10-10-core-schema.md`; §10's `paymongo_events` becomes
> `payment_events` as part of it.

### Checkout page

- Lead guest details: full name, mobile (PH format), email, pickup location (text + optional Google Maps pin), special requests.
- Pay in full / 30% deposit toggle.
- Coupon code field (server-validated: active, within dates, under usage limit, minimum spend).
- Countdown showing the 15-minute hold.
- Terms + privacy consent checkbox (Data Privacy Act notice).

### Online payment — multi-gateway

> **Owner-approved spec change, 2026-10-10.** This section replaced a PayMongo-only design. The
> system must support **multiple payment gateways**: PayMongo is implemented first, and **Xendit
> must be addable later without a schema change or a rewrite**. Everything below is written so that
> adding a gateway means writing one file and flipping one setting.

**The provider seam.** All gateway-specific code lives behind a `PaymentProvider` interface in
`/server/src/services/payments/`:

```ts
interface PaymentProvider {
  readonly name: 'paymongo' | 'xendit' | 'manual';
  createCheckout(input): Promise<{ redirectUrl; providerRef }>;
  verifyWebhook(rawBody, headers): boolean; // never true on doubt
  parseEvent(rawBody): ParsedPaymentEvent; // gateway vocabulary -> ours
  refund(input): Promise<{ providerRef; providerStatus }>;
}
```

PayMongo implements it. **Xendit ships as a stub whose every method throws "not enabled"** — so the
seam is exercised from day one rather than discovered to be wrong when a second gateway arrives.
No gateway SDK is used; both are plain `fetch` against documented REST endpoints.

**Nothing outside that directory may name a gateway.** No PayMongo-specific column, no
`if (provider === …)` in a router.

1. Server asks the **active provider** (chosen by an admin in Settings, never by the request) to
   create a checkout for the exact `amount_due_now`, with the booking ref in metadata and the
   allowed methods.
2. Guest pays on the gateway's page.
3. **Webhook** (`POST /api/webhooks/:provider` — one route, one handler per provider) is the only
   thing that marks the payment paid:
   - **Unknown provider → reject**, before the body is read. Fail closed.
   - Verify that provider's own signature with that provider's secret. **Invalid → reject**, store
     nothing.
   - **Idempotency:** store each event in `payment_events` with `UNIQUE (provider, provider_event_id)`.
     A duplicate delivery hits that index, is acknowledged, and changes nothing. The unique index is
     the gate — not an application-level check-then-insert, which races.
   - Check the amount matches the booking's expected amount.
   - In one transaction: insert `payments` row (`paid`), update booking to `confirmed`, write audit log.
4. The success redirect page only **reads** status (polls until the webhook lands). It never confirms anything itself.

**Only a verified webhook or an admin approval marks a booking paid — for every provider, without
exception.** The disabled Xendit stub must be incapable of it, and there is a test for that.

**Secrets** are per provider and live only in `.env` (`PAYMONGO_SECRET_KEY`,
`PAYMONGO_WEBHOOK_SECRET`, and later the Xendit pair). Never in the database, never in client code.

**The `payments` table is provider-neutral:** `provider` (enum), `provider_ref`, `provider_status`,
and `amount_centavos`. `provider` records _who processed it_; a separate `method` records _how the
guest paid_ (card, gcash, maya, grab_pay, qrph, bank_transfer, cash), because the same
instrument exists on several gateways and §9's revenue report needs both axes.

### Manual QR payment

1. Show the R&G QR image (uploaded by admin in Settings), **exact amount**, booking ref, and instructions to put the ref in the transfer note.
2. 15-minute hold timer + "Download QR" button.
3. Guest enters the transaction reference number and uploads a receipt screenshot (jpg/png/webp/pdf, max 5 MB).
4. Booking → `pending_verification`; payment row → `pending`.
5. Admin approves → payment `paid`, booking `confirmed`. Admin rejects (with reason) → customer portal shows the reason and a re-upload prompt.

   **What a rejection does, in full** (owner decisions 2026-10-13 Q7 and Q8;
   built in Week 4 Task 7). _The twelve hours and the no-extension rule are
   proposed by the developer and are **not yet confirmed with R&G**._

   - The payment row becomes `rejected` with `reject_reason`; the reason is
     shown to the guest and emailed to them.
   - The booking returns to **`pending_payment`** — not cancelled — and the
     guest may upload again.
   - `hold_expires_at = min(rejectedAt + 12h, bookingCutoffInstant(tourDate))`,
     so the re-upload window never outlives the booking window for that tour
     date. When it lapses the existing expiry sweep releases the seats; it
     still skips anything flagged `payment_review_required`.
   - A second receipt while one is pending marks the older row **`superseded`**
     (owner decision 2026-10-14, Q6), and only the newest `pending` row can be
     approved or rejected. Five receipts per booking, then the guest is asked
     to message R&G.
   - Manual transfers are **`gcash`, `maya` and `bank_transfer` only** (owner
     decision 2026-10-14, Q4). `card`, `grab_pay` and `qrph` are the gateway's;
     `cash` is §8's office/driver flow.

A manual QR payment is recorded with `provider = 'manual'` and whichever instrument the guest
actually used (`gcash`, `maya`, `bank_transfer`, …) — there is no `manual_qr` method, because
`provider` already carries the fact that a human verified it. It has no
gateway to call, so it never goes through a `PaymentProvider` — admin approval is the other of the
two paths allowed to mark a booking paid.

> **Note:** a static QR cannot embed the amount. The amount is shown as text next to the QR. If the client wants auto-confirmed QR payments, use the active gateway's QR Ph method in the online flow instead. See Open questions.

### Refunds & cancellations

- Admin cancels a booking, choosing a refund amount (full, partial, none).
- Gateway payments: call `provider.refund()` on **the provider that took the payment** — read from
  the payment row, never the currently-active provider, or a gateway switch would send refunds to
  the wrong place. Then record a `refund` row.
- Manual payments: admin records the refund as done offline (method + reference).
- A refund is a `payments` row with `type = 'refund'` and an **always-positive** amount; direction
  comes from `type`, never from a sign. Refunds are never a booking status.
- **Partial refunds are allowed**, so one booking can carry several refund rows. Their **sum must
  never exceed `amount_paid`**, checked inside the same transaction under a row lock on the
  booking — without the lock, two admins refunding at once each see "nothing refunded yet" and the
  money leaves twice.
- **Refunds are admin-only** and write to `audit_log` naming the admin. A gateway webhook may
  _confirm_ a refund the admin initiated; it may never initiate one.
- Free-cancellation policy window is a tour setting (e.g. 24 hours before). Shown to guests; enforced by admin, not automatically.

---

## 7. Customer portal

**Login:** booking ref + email (case-insensitive). Creates a session scoped to **that booking only**.

- Rate limit: 5 failed attempts per IP per 15 minutes.
- Same generic error for wrong ref or wrong email (don't reveal which).

### 5-step tracker

| Step              | Done when                                    |
| ----------------- | -------------------------------------------- |
| Booked            | Booking exists                               |
| Payment sent      | Online payment received, or receipt uploaded |
| Verified by admin | Payment `paid` (auto for PayMongo)           |
| Driver assigned   | Booking `assigned`                           |
| Tour day          | Booking `in_progress` or `completed`         |

### Features

- Upload / re-upload receipt (when rejected), with the rejection reason shown.
- Auto-refresh status every 20 seconds while `pending_verification`.
- Assigned driver name, van model, plate, call/WhatsApp buttons (visible from assignment until tour day ends).
- Balance due on tour day.
- After `completed`: rate & review form (verified badge, sub-scores) → `pending` → admin approval.

---

## 8. Driver portal

**Login:** driver selects name (or enters driver code) + 6-digit PIN.

- PIN hashed, never stored or logged raw. **Three limits stack** (owner decision 2026-10-11):
  - **Per driver:** 5 consecutive failed attempts → 15-minute lockout.
  - **Per driver, escalating:** 3 lockouts inside 24 hours → locked until an **admin** resets it.
    A correct PIN does **not** clear this; only an admin action does.
  - **Per IP:** 10 attempts per 15 minutes.
  - Every lockout and every admin reset writes to `audit_log`.
- Session lasts 12 hours. Drivers see **only their own trips**.

### Views

- Today / Upcoming / History tabs.
- **Trip detail:**
  - Guest name, pax, call/text/WhatsApp buttons.
  - Pickup with a Google Maps link.
  - Van assigned.
  - **Payment box:**
    - "Collect ₱X cash" if there's a balance.
    - "Fully paid" if nothing is owed.
    - "Not paid — don't collect, call office" if payment is unverified.
  - Office notes.

### Itinerary check-ins

1. **Start trip** → booking `in_progress`, timestamp saved.
2. Tap each stop on arrival → `trip_checkpoints` row with server timestamp.
3. Last stop → booking `completed`, van freed.
4. **Undo last check-in** (only the most recent; marked `undone`, not deleted).
5. Driver can mark "cash collected" with the amount → creates **one** `payments` row
   (`provider=manual`, `method=cash`, **`status=pending`**, `collected_by_driver_id` set) for
   admin to reconcile. The audit row is `actor_type=driver`.
   - **The booking does not move.** Not `amount_paid_centavos`, not `status`, not
     `payment_review_required`. A driver's tap is a claim that cash was taken, not a
     reconciliation — same precedent as §6's manual QR transfer, where the payment row is
     `pending` until an admin approves it.
   - **Finance (or owner — `ROLE_MATRIX.verifyPayments`) converts THAT SAME ROW**
     `pending` → `paid`: `verified_by` / `verified_at` are stamped on it,
     `amount_paid_centavos` is credited **exactly once**, and the audit row is
     `actor_type=user`. One handful of cash is one `payments` row for its whole life —
     verification **never inserts a second row**, which would orphan the pending one and
     leave the trail showing two payments for one collection.
   - A **driver may not verify their own collection.** The whole point of the split: a
     driver who could would be able to pocket the cash and still leave the booking reading
     "paid in full".
   - Both calls are one transaction each, and verification runs under the booking row lock,
     so two finance users clicking at once credit the cash once and the second is refused.
   - Cash is the BALANCE, so verification does **not** check the amount against the
     booking's expected deposit or total; the overpay cap against `total_centavos` is what
     bounds it. The status moves to `confirmed` only from `pending_payment` /
     `pending_verification` — a tour-day collection must not walk an `in_progress` or
     `completed` trip backwards — and a cancelled or expired booking gets §6's
     review-flag treatment instead: credited, flagged, status untouched.

Check-ins update the admin dashboard within ~15 seconds (polling is fine; no websockets needed).

---

## 9. Admin & dispatch

**Login:** email + password. Roles control access to every tRPC procedure (server-side middleware).

### Roles & permissions

| Area                             | Owner | Dispatcher | Finance |
| -------------------------------- | ----- | ---------- | ------- |
| Dashboard                        | ✅    | ✅         | ✅      |
| Bookings: view, notes            | ✅    | ✅         | ✅      |
| Assign van/driver                | ✅    | ✅         | ❌      |
| Verify payments, record payments | ✅    | ❌         | ✅      |
| Cancel / refund                  | ✅    | ❌         | ✅      |
| Vans, drivers                    | ✅    | ✅         | ❌      |
| Tours, pricing, coupons          | ✅    | ❌         | ❌      |
| Reviews moderation               | ✅    | ✅         | ❌      |
| Reports, CSV export              | ✅    | ❌         | ✅      |
| Users, settings                  | ✅    | ❌         | ❌      |

### Dashboard

- Today's departures with stop-by-stop progress bars.
- Alerts:
  - Payments to verify.
  - Unassigned trips within 48 hours.
  - Vans in repair.
  - Van service due within 14 days.
  - Driver license, OR/CR, and LTFRB franchise expiring within 30 days.

### Bookings

- Search by ref, name, phone, or email. Filter by date, tour, status, and payment state.
- Detail view:
  - Assign van + driver.
  - Record a manual payment.
  - Cancel/refund.
  - Mark completed.
  - Send reminder (email/SMS).
  - Internal notes.
  - Check-in history.
  - Audit trail.

### Payment verification queue

- List of `pending` manual payments: receipt preview, txn ref, expected vs entered amount.
- Approve / reject (reason required). Updates the customer portal immediately.

### Calendar

- Monthly view; each day shows trips. **Gold dot** = needs assignment.
- Assign van/driver per trip. Dropdowns **exclude**:
  - Vans already booked that day, in repair, or too small.
  - Drivers on leave or already assigned that day.
- Auto-suggest button.

### Vans

- Status:
  - Available / On tour / Parked / For repair.
  - "On tour" is derived from in-progress trips; the others are set manually.
- Fields: plate, model, capacity, odometer, last/next service date, OR/CR expiry, LTFRB franchise number + expiry, repair notes.

### Drivers

- Status: active / on leave (with date ranges) / inactive.
- Fields: license number + expiry, languages, emergency contact, phone, PIN reset, average rating, upcoming trips.

### Tours & pricing

- On/off, title, slug, destination, gallery, about, itinerary stops, inclusions/exclusions.
- Price tiers, add-ons, groups per day, max guests, blocked dates, free-cancellation window.

### Other admin pages

- **Packages:** multi-day packages and their inquiries.
- **Coupons:**
  - Code, percent or fixed, start/end dates, usage limit, minimum spend, active toggle.
  - Redemption log.
- **Reviews:** publish/hide, reply, see verified status.
- **Reports:**
  - Revenue by tour and by payment method (date range).
  - Trips per van and per driver.
  - Outstanding balances.
  - CSV export for each.
- **Settings:**
  - Business info, contact numbers, permit numbers.
  - QR image, deposit %, hold minutes.
  - Trust-line values, FAQ, "why book direct" text.
  - Newsletter list export.

---

## 10. Database tables

All money columns are `INT` centavos. All timestamps are UTC `DATETIME`.

| Table                    | Key columns                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | id, name, email (unique), password_hash, role (owner/dispatcher/finance), is_active, last_login_at                                                                                                                                                                                                                                                                                                 |
| `sessions`               | id, subject_type (**user**/customer/driver), subject_id, token_hash (unique), expires_at — `user` -> users.id, `driver` -> drivers.id, **`customer` -> bookings.id** (a customer session is scoped to one booking; there are no customer accounts). Stores a SHA-256 of the token, never the token                                                                                                 |
| `settings`               | key, value (JSON)                                                                                                                                                                                                                                                                                                                                                                                  |
| `destinations`           | id, name, slug, sort_order                                                                                                                                                                                                                                                                                                                                                                         |
| `tours`                  | id, slug, title, destination_id, about, inclusions, exclusions, groups_per_day, max_guests, free_cancel_hours, is_active                                                                                                                                                                                                                                                                           |
| `tour_images`            | id, tour_id, path, alt, sort_order                                                                                                                                                                                                                                                                                                                                                                 |
| `tour_price_tiers`       | id, tour_id, min_pax, max_pax, price_per_person_centavos                                                                                                                                                                                                                                                                                                                                           |
| `tour_itinerary_stops`   | id, tour_id, sort_order, name, description                                                                                                                                                                                                                                                                                                                                                         |
| `tour_addons`            | id, tour_id, name, price_centavos, per_person (bool), is_active                                                                                                                                                                                                                                                                                                                                    |
| `tour_blocked_dates`     | id, tour_id, date, reason                                                                                                                                                                                                                                                                                                                                                                          |
| `tour_date_slots`        | tour_id, date (PK pair); lock row for capacity checks                                                                                                                                                                                                                                                                                                                                              |
| `fleet_date_slots`       | date (PK). **Date-level lock row, added 2026-10-11.** The fleet is shared across tours, so a per-tour lock cannot serialise it. Always locked BEFORE `tour_date_slots`                                                                                                                                                                                                                             |
| `packages`               | id, slug, title, days, old_price_centavos, new_price_centavos, description, is_active                                                                                                                                                                                                                                                                                                              |
| `inquiries`              | id, type (contact/package), package_id, name, email, phone, message, status                                                                                                                                                                                                                                                                                                                        |
| `bookings`               | id, ref (unique), tour_id, tour_date, pax, lead name/email/phone, pickup, requests, status, pay_mode (full/deposit), price snapshot (JSON), subtotal, discount, total, amount_paid, coupon_id, van_id, driver_id, hold_expires_at, started_at, completed_at                                                                                                                                        |
| `booking_addons`         | id, booking_id, addon_id, name, price, per_person, qty                                                                                                                                                                                                                                                                                                                                             |
| `booking_notes`          | id, booking_id, user_id, note, created_at                                                                                                                                                                                                                                                                                                                                                          |
| `payments`               | id, booking_id, type (payment/refund), **provider (paymongo/xendit/manual)**, **method (card/gcash/maya/grab_pay/qrph/bank_transfer/cash)**, amount_centavos, status (pending/paid/rejected/failed/refunded), **provider_ref**, **provider_status**, txn_ref, receipt_path, reject_reason, verified_by, verified_at, collected_by_driver_id                                                        |
| `payment_events`         | id, provider, provider_event_id, type, payload, received_at, processed_at — **UNIQUE (provider, provider_event_id)**. Renamed from `paymongo_events` by the 2026-10-10 multi-gateway change: two gateways can mint the same event id, so uniqueness is per provider                                                                                                                                |
| `vans`                   | id, plate, model, capacity, status, odometer, last_service, next_service, orcr_expiry, franchise_no, franchise_expiry, repair_notes, is_active                                                                                                                                                                                                                                                     |
| `drivers`                | id, name, code, phone, **pin_hash** (6-digit PIN, hashed), failed_attempts, locked_until, **lockout_count**, **lockout_window_started_at**, **requires_admin_unlock**, license_no, license_expiry, languages, emergency_contact, status, is_active                                                                                                                                                 |
| `driver_leaves`          | id, driver_id, start_date, end_date, reason                                                                                                                                                                                                                                                                                                                                                        |
| `trip_checkpoints`       | id, booking_id, stop_id (null for "start"), checked_at, undone (bool)                                                                                                                                                                                                                                                                                                                              |
| `reviews`                | id, tour_id, booking_id (null if unverified), name, rating, guide, value, punctuality, safety, body, status (pending/published/hidden), reply, replied_at                                                                                                                                                                                                                                          |
| `review_helpful_votes`   | review_id, voter_hash (unique pair)                                                                                                                                                                                                                                                                                                                                                                |
| `coupons`                | id, code (unique), **discount_type (percent/fixed)**, **percent_bp** (basis points, 1000 = 10%, NULL unless percent), **amount_centavos** (NULL unless fixed), min_spend_centavos, starts_at, ends_at, usage_limit, used_count, is_active — **CHECK: exactly one of percent_bp / amount_centavos is set, matching discount_type** (owner decision 2026-10-11, replacing the single `value` column) |
| `coupon_redemptions`     | id, coupon_id, booking_id                                                                                                                                                                                                                                                                                                                                                                          |
| `newsletter_subscribers` | id, email (unique), created_at                                                                                                                                                                                                                                                                                                                                                                     |
| `audit_log`              | id, **actor_type (user/customer/driver/system/provider)**, actor_id, action, entity, entity_id, data (JSON), created_at — a webhook-driven change is `provider` with the gateway named in `data`; a cron job is `system`. Both have a null actor_id                                                                                                                                                |

**Indexes:**

- `bookings (tour_id, tour_date, status)`
- `bookings (ref)`
- `bookings (driver_id, tour_date)`
- `payments (booking_id)`
- `payments (status)`

---

## 11. Notifications

| Event                             | Email                         | SMS (optional) |
| --------------------------------- | ----------------------------- | -------------- |
| Booking confirmed                 | ✅ guest                      | ✅ guest       |
| Receipt received                  | ✅ guest                      | —              |
| Payment rejected                  | ✅ guest                      | ✅ guest       |
| Driver assigned                   | ✅ guest (driver, van, plate) | ✅ guest       |
| Reminder (day before)             | ✅ guest                      | ✅ guest       |
| New booking / receipt to verify   | ✅ admin                      | —              |
| Review request (after completion) | ✅ guest                      | —              |

- Emails are plain, branded HTML templates.
- Failures are logged and never block the booking flow.

---

## 12. Security checklist

- HTTPS only; HSTS; secure, httpOnly, sameSite cookies.
- CSRF protection on state-changing requests (sameSite + origin check).
- Rate limits on:
  - All logins.
  - Coupon checks.
  - Review submissions.
  - Inquiry forms.
  - Helpful votes.
- Zod validation on every input.
- File uploads: check MIME + extension + size, rename to random IDs, store in `/uploads` outside the web root, serve via an authenticated route (admin, or the owning customer session).
- **Every** gateway's secret key and webhook secret only in `.env`, never in client code and never
  in the database — one pair per provider (`PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, …).
  The admin chooses which provider is _active_ in Settings; the admin never sees or sets a secret.
- Each webhook route verifies **its own provider's** signature, and fails closed on an unknown
  provider or a bad signature — storing nothing and marking nothing paid.
- Webhook idempotency is enforced by a database unique index on `(provider, provider_event_id)`,
  not by an application-level check-then-insert.
- Role middleware on every admin procedure, plus a test per role per area.
- Privacy (Data Privacy Act RA 10173):
  - Consent checkbox at checkout.
  - Privacy notice page.
  - Admin-only access to personal data.

---

## 13. Build plan — 8 weeks

Each task ends with **✅ DONE**. Each week ends with **✅ WEEK X COMPLETE** after verification.

> **Markers audited and corrected 2026-10-10** — the previous ✅ DONE marks were template
> defaults, not completion records. Every task below was re-checked against the actual tree
> (`git ls-files`, the test suite, the running app); a task carries ✅ DONE only if the code
> exists and its tests pass. No week has earned **✅ WEEK X COMPLETE** yet.

Weeks 1–2 were not built in week order. The **dynamic site + SEO plan**
(`docs/superpowers/plans/2026-10-09-dynamic-site-and-seo.md`, phases 1–4) built the database
content layer, the live-data public site and the whole of 2E, which is why 2E is done while
2C and 2D are not.

### Week 1 — Foundation

- **1A** Repo setup: client/server/shared, TypeScript, Tailwind, shadcn, tRPC, Drizzle, ESLint/Prettier, `.env.example`. ✅ DONE
- **1B** Full Drizzle schema (section 10) + first migration + seed (destinations, 6 tours with tiers/stops/add-ons, 4 vans, 4 drivers, owner user, settings).
  **Partial — not done.** The 12 public-content tables are built and migrated (`0000_*`,
  `0001_*`): `settings`, `destinations`, `tours`, `tour_images`, `tour_price_tiers`,
  `tour_itinerary_stops`, `tour_addons`, `tour_blocked_dates`, `packages`, `reviews`,
  `inquiries`, `newsletter_subscribers`. The other 16 in section 10 are not: `users`,
  `sessions`, `tour_date_slots`, `bookings`, `booking_addons`, `booking_notes`, `payments`,
  `payment_events`, `vans`, `drivers`, `driver_leaves`, `trip_checkpoints`,
  `review_helpful_votes`, `coupons`, `coupon_redemptions`, `audit_log`. The seed covers
  destinations, tours, tiers, images, packages, reviews and settings — **no** vans, drivers,
  owner user, itinerary stops or add-ons. Finish this with the week that first needs the
  missing tables (1C needs `users` + `sessions`; Week 3 needs the rest).
- **1C** Auth: admin sessions + role middleware; customer and driver session types.
  **Not done** — no session table, no password hashing, no role middleware, and no
  `protectedProcedure`. Every tRPC procedure today is public and read-mostly.
- **1D** Shared money/time utilities (centavos, Asia/Manila) with unit tests. ✅ DONE
- **1E** `CLAUDE.md` with these conventions. ✅ DONE

### Week 2 — Public site

Use **ui-ux-pro-max** throughout; match the approved demo.

- **2A** Layout, header, footer, floating WhatsApp, brand tokens (blue/gold, no red). ✅ DONE
- **2B** Home page sections 1–13. ✅ DONE — all thirteen render from live `settings`/tRPC data.
- **2C** Catalog with destination filter and real stats.
  **Not done** — `/tours` is `client/src/pages/public/ToursStubPage.tsx`, which echoes the
  hero's search params and says so. The home page's _catalog preview_ (section 3 of 2B) does
  have the live destination filter; the standalone catalog page does not exist.
- **2D** Tour detail page (gallery, itinerary, tiers, add-ons, date/guest picker).
  **Not done** — no `/tours/:slug` route in `client/src/App.tsx`. The server side is already
  built and tested ahead of it: `server/src/seo/resolvers.ts` resolves the meta and JSON-LD
  for `/tours/:slug` and `/packages/:slug` but serves both `noindex,nofollow`, because the
  shell would otherwise reach a crawler with correct meta over an empty body (plan decision
  D5).
  **When this page is built, in the same task:** delete those two `robots` lines, and add the
  detail URLs to `/sitemap.xml` — `server/src/seo/sitemap.ts` already collects, filters by
  `is_active` and sorts them in `detailUrls()`, with the emit commented out and marked
  `WEEK 2D`.
- **2E** Meta tag injection, sitemap, robots. ✅ DONE — see the SEO note in section 2. Built by
  phase 4 of the dynamic-site plan: per-route `<title>`/description/canonical/OG/Twitter and
  JSON-LD on `/`, `/tours`, `/privacy`, `/terms`, `/tours/:slug` and `/packages/:slug`,
  injected by one module (`seo/render.ts`) on both surfaces — Express in production, a Vite
  middleware in dev — plus dynamic `/sitemap.xml` and `/robots.txt` and an `X-Robots-Tag`
  header for non-production hosts.

### Week 3 — Booking & online payments

> **Preamble rewritten 2026-10-13.** It previously said "nothing in this week is built", that
> there was no gateway client, and that the week was blocked on an unexecuted core-schema plan
> with Q7 and Q4 open. All of that described a world that no longer exists. What follows is
> checked against the tree, not against the plan's expectations.

**No longer blocked on the core schema.** That plan is executed and its migrations are applied:
`bookings`, `booking_addons`, `payments`, `payment_events`, `coupons`, `coupon_redemptions`,
`tour_date_slots`, `fleet_date_slots`, `vans`, `drivers`, `driver_leaves`, `users`, `sessions`
and `audit_log` all exist (nine migrations in `server/src/db/migrations`). **Q4 (deposit
rounding — ceil to the next whole peso) and Q7 (capacity is
`MIN(groups_per_day, vans free that day)`) were both answered 2026-10-11** and are implemented;
Q7 is still marked _pending R&G confirmation_ in section 5, which is a business confirmation, not
a build blocker.

**The gateway seam exists**, built by the core-schema plan ahead of this week:
`server/src/services/payments/` holds the `PaymentProvider` registry, the PayMongo client and
the Xendit stub that cannot mark anything paid, and the webhook route is mounted at
`/api/webhooks` from `server/src/routers/webhooks` — **not** the `server/src/webhooks` path this
spec originally planned. `recordPayment()` is the only thing that can mark a booking paid.

**The scheduler exists** (corrected 2026-10-13, final review F2: this paragraph still said
there was no `server/src/jobs` and that `node-cron` was "not yet a dependency", ten lines above
3C's own ✅ DONE line crediting the sweep to `node-cron` — the section contradicted itself, and
in this repo the spec wins disagreements, so a reader hitting the preamble first concluded the
sweep was unbuilt). `server/src/jobs/{expire-holds,index}.ts` are in the tree and
`node-cron@^4.6.0` is in `server/package.json`.

**Still absent, and it is a specific task's job: there is no email transport** (3F) — no
provider, no SMTP client, no template. Of this plan's own open questions, **Q1 (scheduler) is
answered — `node-cron` in the server process — and Q2 (email provider) is still open**, which
is the only thing blocking the confirmation email in 3F.

- **3A** Pricing service + tests (tiers, add-ons, coupons, deposit rounding). ✅ DONE —
  `services/pricing.ts`: pure `priceQuote()`, `loadQuoteInputs()` and the `quoteDigest()` that
  lets a hold detect a price edited between quote and booking.
- **3B** Capacity service + transaction lock + concurrency test. ✅ DONE —
  `services/capacity.ts`: `takeSlotLocks()` takes `fleet_date_slots` then `tour_date_slots`, in
  that fixed order, and `assessCapacity()` returns a verdict rather than throwing. The
  cross-tour race is pinned by a genuinely concurrent test, and the fleet lock's removal is
  proven to break it.
- **3C** Hold creation + expiry cron. ✅ DONE — `services/create-hold.ts` is one transaction
  from quote to `pending_payment` with a 15-minute hold, the price snapshot, the add-on lines
  and an audit row, under both slot locks with a retry on deadlock; and `jobs/expire-holds.ts`
  now sweeps lapsed holds to `expired` every minute via `node-cron`, freeing both the capacity
  and the coupon reservation. **It never expires a booking with money against it** — a guest who
  paid after their hold lapsed is left for the review queue, enforced by two conditions in the
  UPDATE's own WHERE and pinned by a two-connection test that fails if the race did not actually
  overlap. One poisoned row is logged, counted and skipped rather than aborting the sweep.
  **Deploy note:** the schedule must run in a single process — PM2 fork mode, one instance — or
  every worker runs it and each sweep fires N times (see `LAUNCH_CHECKLIST.md`).
- **3D** Checkout page + coupon validation. ✅ DONE — `services/coupons.ts` gives one typed
  error per §6 rule, re-checked under the coupon row's lock inside the hold; the checkout page
  renders a server-computed quote with **no arithmetic on any centavo value in `client/`**, which
  a repo-wide guard asserts; the date input takes its bounds from `SettingsPayload.bookingWindow`
  — two civil dates resolved server-side, never a browser clock — so it no longer offers a date
  the server would refuse; and `date_not_bookable` has its own amber sentence, distinct from the
  capacity copy, keyed off the single shared constant rather than a retyped literal.
- **3E** Checkout session + webhook through the `PaymentProvider` seam (signature, idempotency
  on `(provider, provider_event_id)`, amount check). **Built and tested against a MOCK provider
  — the live wire check is pending an account.** `checkout.startPayment` starts a checkout from a
  held booking, sending the amount read off the booking row; the webhook half, with the signature
  check and the `(provider, provider_event_id)` unique index, predates this week. Xendit remains
  a stub that cannot mark anything paid — see the 2026-10-10 multi-gateway change in section 6.

  **Not ✅ DONE, and the distinction is the point** (owner decision 2026-10-13: no PayMongo or
  Xendit account exists yet, so the live test-mode check is deferred). Everything on OUR side of
  the seam is proven — the refusals, the amount read off the row, the one-time hold extension,
  the four fixed methods, `recordPayment`, the signature verifier and webhook idempotency. What
  is **unproven** is PayMongo's side of it: that its real checkout response parses, that its real
  signature header verifies against our verifier, and that its real event names match what the
  webhook router switches on. All three were assumed from documentation and no real response has
  ever been seen. A mismatch in any one means a guest pays and the booking never confirms, which
  is why `docs/LAUNCH_CHECKLIST.md` carries it as a **blocking** pre-launch item rather than a
  nice-to-have.

- **3F** Confirmation page (read-only polling) + confirmation emails. **Partial.** The booking
  status page is **done** — `BookingStatusPage` polls `checkout.bookingStatus` (a query) and
  confirms nothing itself, mounted at the exact route `startPayment` sends PayMongo, asserted
  from the shared constant rather than a retyped path. The read-only guarantee is guarded three
  ways: `checkout` exposes exactly two mutations (`createHold`, `startPayment`), polling is
  asserted to fire none of them, and the one retry action is pinned to `startPayment` alone.
  **Confirmation emails are NOT part of Week 3** — settled, not open. The owner confirmed on
  2026-10-13 that the 2026-10-12 deferral stands: confirmation emails move to **Week 4**, Task 12
  is struck from Week 3, and **Week 3 completes without email**. The transport is decided
  (`nodemailer` over SMTP, no other email library, every value in `.env`) and its account and DNS
  work is tracked in `docs/LAUNCH_CHECKLIST.md`. Nothing in Week 3 depends on it: a guest sees
  the booking on screen and can find it again by ref + email.

Roadmap items to pick up in or after this week:

- **Week 3** — "X slots left today" and "Next available date" on the catalog and detail pages,
  from capacity (`tour_date_slots`).
- **Week 3+** — real "booked this week" and guests-served counts from completed bookings. Wire
  `tours.historical_trips_count` in as the baseline so the displayed total is history + live
  bookings (plan decision D8) rather than a number that drops to near-zero at launch.
- **Pricing engine** — peak and holiday pricing, once the tier engine (3A) exists.

### Week 4 — Manual QR & customer portal (Phase 1 review) — ✅ WEEK 4 COMPLETE (2026-10-14)

> **Preamble rewritten 2026-10-14.** It said "Nothing in this week is built. There is no
> `client/src/pages/portal` or `.../admin`." Both statements are now false. §13's markers were
> audited once before for exactly this reason, so this is corrected at the moment the week closes
> rather than left to be discovered.

**All of 4A–4E is built, tested and committed.** Plan:
`docs/superpowers/plans/2026-10-13-week4-manual-qr-and-portal.md` (12 tasks); evidence:
`docs/superpowers/plans/2026-10-13-week4-phase1-walkthrough.md`.

**Three things this week added that the spec did not describe as Week 4 work**, each because
nothing downstream worked without it: the **tRPC context factory** (`server/src/context.ts`) —
until Task 1, `ctx` was `{}` and so **every `adminProcedure` refused everything**; **staff login**
(Week 1's 1C, pulled in on the owner's answer to this plan's Q1); and the **reject half** of
receipt verification, which §6 implies but no code did — `payments.reject_reason` was written
nowhere and `'rejected'` was never set.

- **4A** ✅ Manual QR flow: QR display, timer, download, txn ref, receipt upload.
  A new receipt marks the previous row `superseded` — never deleted, never approvable — and
  only the newest `pending` row can be decided; capped at five uploads per booking.
  Needed migration `0009_payments_superseded_status.sql`.
- **4B** ✅ Customer portal login (booking ref + email) + rate limiting, with wrong-credential
  responses that are deeply equal so neither half of the pair is revealed.
- **4C** ✅ 5-step tracker, receipt re-upload, auto-refresh, rejection reason shown in amber.
- **4D** ✅ Basic admin bookings list + detail, including the verification queue and the
  approve/reject decision.
- **4E** ✅ End-to-end test of every Phase 1 flow. **Except the online gateway path, which is
  `mocked` — the live wire check is pending the PayMongo account and remains a BLOCKING
  pre-launch item** (`docs/LAUNCH_CHECKLIST.md`, "The gateway wire check"), under the same
  rule Week 3 closed on. The walkthrough found no application bugs; three guards refused it
  and were right to (capacity, the per-contact hold cap, the per-IP hold limiter).

**Still unbuilt and deliberately carried forward, not dropped:** the day-before reminder email
(§11 — `node-cron` and `server/src/jobs/` exist, but 4A–4E never gave it a task), SMS (§11,
optional and off by default), and the **12-hour re-upload window after a rejection**, which is
still _proposed by developer — pending R&G confirmation_.

→ **Client demo / Phase 1 approval.**

### Week 5 — Dispatch — ✅ WEEK 5 COMPLETE (2026-10-15)

> **Preamble rewritten 2026-10-15.** It said "Nothing in this week is built." All of 5A–5E now is.
> §13's markers were audited once before for exactly this staleness, so it is corrected as the week
> closes rather than left to be discovered.

Plan: `docs/superpowers/plans/2026-10-14-week5-dispatch.md` (16 tasks). Evidence:
`docs/superpowers/plans/2026-10-15-week5-walkthrough.md` (24/24 steps over real HTTP).

- **5A** ✅ Vans CRUD + status + expiry fields. §9's fourth status `parked` added, and
  `assessCapacity()`'s Gate 2 became an **allow-list** — only `available` is sellable fleet
  (owner-decided 2026-10-14, Q1), so a status nobody has thought of yet is excluded by default.
- **5B** ✅ Drivers CRUD + leaves + PIN reset. A reset **is** the admin unlock: it clears all five
  lockout columns in the same transaction as the new hash (owner instruction 2026-10-14). The PIN is
  server-generated, shown once, and appears in no log and no audit row. Leaves cannot overlap each
  other or a day the driver is already assigned.
- **5C** ✅ Calendar month view. §9's **gold dot** stays and stops being the only signal: the day
  cell carries the count as a numeral and its accessible name is built from text
  (`10 November, 3 trips, 2 need assignment`), because colour alone is a WCAG 1.4.1 failure. One tab
  stop for the whole grid.
- **5D** ✅ Assignment with exclusion rules + auto-suggest. One availability module is the single
  source of truth for "which van and driver are free", read by the dropdowns, the suggest and the
  mutation's re-check. **Double-assignment is prevented by the `fleet_date_slots` lock taken BEFORE
  availability is read** — proven by four concurrency tests that fail when the lock is removed and
  when it merely moves after the read.
- **5E** ✅ Dashboard alerts. All five, every load, **zeroes included** — a hidden empty card is
  indistinguishable from a broken query. The 48-hour window counts back from the tour date in
  Asia/Manila (owner-decided 2026-10-14, Q7).

**Deliberately not built, declared rather than discovered:** a driver's average rating and upcoming
trips (§9 "Drivers" — the rating needs an owner decision, since no rating column exists and
inventing one is fabricated social proof); §9's "today's departures with stop-by-stop progress",
which needs the `trip_checkpoints` writes that arrive in 6C/6D and which the dashboard says so about
on screen; and assignment notifications (§11), which §13 does not list for this week.

**The browser is the gap.** Every walkthrough step went through HTTP and the database. 436 client
tests cover the screens, including the accessibility ones, but jsdom does no layout — so 360px,
tablet, the 44px tap targets and the gold dot's real visibility are checked by class string, not by
looking at a screen.

### Week 6 — Drivers & verification — ✅ WEEK 6 COMPLETE (2026-10-16)

> **Preamble rewritten 2026-10-16.** It said "Nothing in this week is built. There is no
> `client/src/pages/driver`." All of 6A–6F now is, and that directory exists. §13's markers have been
> audited for exactly this staleness twice before, so it is corrected as the week closes rather than
> left to be discovered a third time.

Plan: `docs/superpowers/plans/2026-10-15-week6-drivers-and-verification.md` (14 tasks). Evidence:
`docs/superpowers/plans/2026-10-16-week6-walkthrough.md` — ten of eleven in-scope steps driven over
real HTTP with real session cookies, the eleventh (the 360px browser) driven separately.

- **6A** ✅ Driver portal login + lockout. Code + six-digit PIN, **a 12-hour session**
  (owner-decided Q1): `SESSION_TTL_MS_BY_SUBJECT` replaced the single shared 24-hour constant, so
  `driver` is 12 and `user`/`customer` stay 24, with no per-call override to forget. §8's three
  stacked limits are all live — five failures lock for fifteen minutes, three lockouts in 24 hours
  need an admin, and ten `driver.login` attempts per IP per fifteen minutes. **An admin PIN reset is
  the unlock**, and a driver signs in immediately afterwards — Week 5's carry-forward, now proven on
  the wire. A wrong code and a wrong PIN are one indistinguishable refusal; the scrypt verify is paid
  even for an unknown code and even during a lockout, so the timing answers nothing the message
  refuses to.
- **6B** ✅ Today/Upcoming/History + trip detail + payment box. Buckets are resolved **server-side
  from the Manila civil date**, never the handset clock. A driver sees only their own trips, and
  another driver's booking id answers **`NOT_FOUND`, never `FORBIDDEN`** — a 403 would confirm the
  booking exists, and over a numeric id that walks the whole table towards a guest's phone number.
  The trip list carries no guest contact details at all; the one-trip manifest carries the lead's
  phone and nothing else. **The payment box's three states are computed on the server** and the
  client receives no totals to re-derive them from.
- **6C** ✅ Check-ins: start, stops, complete, undo, cash collected. One row per stop, arbitrated by
  a unique index on `(booking_id, stop_key)` — a double tap is a shrug, not a second row. An undo
  **marks, never deletes** (`undone`, `undone_at`, `undone_by`, with a required reason in the audit
  row), only the most recent standing check-in can be undone, and re-recording a stop **reactivates
  that row** rather than inserting a second (owner-decided Q5). Undoing a completion restores the
  previous state exactly — booking back to `in_progress`, van back to `on_trip` (owner-decided Q4).
  **A driver's cash tap moves no money**: one `pending` `payments` row with
  `collected_by_driver_id`, today-only and refused server-side on any other date, and a driver can
  never verify their own collection.
- **6D** ✅ Live departures on the dashboard. §9's board, every trip departing today in Manila with
  stop-by-stop progress, polled at fifteen seconds. **It reads `tripProgress()` — the same function
  the driver's own itinerary screen reads**, so the dispatcher's bar and the driver's checklist
  cannot disagree. One statement for the day plus two per departure, with a test that measures the
  count.
- **6E** ✅ Payment verification queue. Mostly already built in Week 4; this week added the **cash**
  half and nothing else — `verifyCashPayment` converts the driver's own `pending` row in place and
  credits the booking exactly once under its row lock. **One handful of cash is one `payments` row
  for its whole life.** A test asserts the ABSENCE of a second `payments` insert, so "no second path"
  is enforced by the suite rather than by anyone's say-so.
- **6F** ✅ Cancel/refund. §9 gates it on `cancelRefund` — owner and finance, never a dispatcher.
  A cancellation moves no money by construction and puts an `on_trip` van back on sale, because the
  completion that would have done it is never going to happen. Refunds go back through **the provider
  that took the money**, partials are allowed, and their sum can never exceed what was paid — capped
  inside the transaction under the booking row lock, never at the input boundary.

**Deliberately not built, declared rather than discovered:**

- **A driver's average rating and their upcoming trips on the ADMIN drivers screen** (§9). Week 5
  declared both; this week adds neither. The rating still needs an owner decision — there is no
  rating column, `reviews` scores a _tour_, and inventing a number is the fabricated social proof
  `CLAUDE.md` forbids. The upcoming-trips list is an admin-surface read and 6A–6F is the driver's
  side.
- **No notification fires on assignment, completion, a cash claim or a verification.** §11 lists the
  events; §13 does not list any of them for this week, and the dashboard polls anyway.
- **The live gateway check.** `provider.refund()` has only ever run against the mock. **No real
  payment and no real refund has ever been issued** — blocked on the PayMongo account, the same item
  `LAUNCH_CHECKLIST.md` carries.
- **No sweep for a van left `on_trip` by a trip nobody completed.** Declared in full in Week 7's
  preamble below, and pinned by the last test in `trip-van-status.test.ts`.
- **No reject path for a driver's cash claim.** A `pending` cash row can be approved; it cannot be
  refused. A claim for money that never arrives sits `pending` and blocks that driver from
  re-recording. Owner decision 2 in the walkthrough.
- **The seed ships no `tour_itinerary_stops`.** All six seeded tours have zero, so on a fresh clone
  the driver's itinerary screen is "Start trip" and nothing else and the departures board reads
  `0/1`. 6C is complete; it is simply undemonstrable against seed content, and 7F's editing screens
  do not cover itinerary stops either.

**The browser is the gap, as it was in Week 5, and for a driver portal that matters more.** Every
walkthrough step but one went through HTTP and the database. jsdom does no layout, so 360px,
one-handed reach and the 44px tap targets are checked by class string. Step 9 of the walkthrough was
driven separately for exactly that reason.

- **6A** Driver portal login + lockout.
- **6B** Today/Upcoming/History + trip detail + payment box.
- **6C** Check-ins (start, stops, complete, undo, cash collected).
- **6D** Live departures on the dashboard.
- **6E** Payment verification queue (approve/reject → portal updates).
- **6F** Cancel/refund flow (PayMongo refund API + manual record).

### Week 7 — Growth features

Nothing in this week is built. Public _display_ of reviews, packages and the newsletter form
exists (it is part of 2B), but no submission, moderation, admin or export side of any of it.

> **What Week 6 hands this week: an orphaned `on_trip` van has no sweep, and that is a declared
> gap rather than an oversight** (Task 7, 2026-10-15).
>
> 6C sets `vans.status = 'on_trip'` on Start and clears it on completion, one transaction each,
> and `server/src/__tests__/trip-van-status.test.ts` proves dispatch honours both halves by asking
> `assessCapacity` / `vansFreeOn` about a date thirty days out. What nothing does is clear
> `on_trip` for a trip **nobody ever completes**. A driver whose phone dies at the last stop, or
> who simply forgets, leaves that van unsellable on every future date at once — `available` is the
> only sellable status (Week 5's allow-list) and `vans.status` is not date-scoped. The symptom
> arrives weeks later as "we're fully booked" on a day with idle vans, with nothing in the logs,
> and the only cures today are the driver finishing the trip and a hand-written `UPDATE vans`.
>
> **Two candidate fixes, both needing an owner decision because both are new surface area:** a
> `node-cron` job that frees a van whose booking is still `in_progress` past its tour date
> (`node-cron` is already an approved dependency, but a new scheduled job is a new failure mode of
> its own), or a dispatcher-facing **force complete** on the booking detail, audited like any other
> status change (no scheduler, but somebody has to notice first). If 7E's day-before reminder cron
> gets built, the sweep is the cheaper of the two to add beside it.
>
> The current behaviour is pinned by the last test in `trip-van-status.test.ts`, so the gap is a
> known quantity with a name. Building either fix turns that test red — that is the intended
> signal. Replace it with the new behaviour's own proof rather than loosening it.

> **The rest of what Week 6 hands this week** (walkthrough, 2026-10-16). Ten items, none of them
> blocking, all of them cheap to lose track of.
>
> 1. **`TripProgressStop` carries no checkpoint id.** `shared/src/driver.ts` defines it as
>    `{ stopId, name, sortOrder, checkedAt, undone }`. The server's undo breaks a same-second
>    `checked_at` tie by `trip_checkpoints.id`; the client's **undo label** has no id to break it
>    with and falls back to array index. Label only — the refetch after the mutation corrects the
>    record — but the two orders can disagree for one render, and adding the id to the shape is the
>    whole fix.
> 2. **`fleet_date_slots` is not in the test harness's `LEAK_TABLES`, and neither is
>    `tour_date_slots` or `sessions`.** `server/src/__tests__/global-setup.ts` lists `bookings`,
>    `drivers`, `vans`, `payments`, `users` and `trip_checkpoints`. `tour_date_slots.tour_id`
>    references `tours.id` with no `ON DELETE`, so several suites carry a hand-written cleanup line
>    to work around it. Either the list grows or the FK gets a cascade; doing neither is how the
>    next suite inherits the same line.
> 3. **`sessions` rows accumulate unbounded in `rg_travel_test`** — 675 as of 2026-10-16. Nothing
>    truncates them between runs and nothing expires them. Harmless until it is not.
> 4. **The duplicate-key walk has three implementations**: the shared
>    `server/src/db/duplicate-key.ts`, plus private copies in
>    `server/src/routers/public/newsletter.ts` and `server/src/services/booking-ref.ts`. The shared
>    one is the complete one (it walks `.cause`, which is what Drizzle's wrapping requires); the
>    other two should become imports.
> 5. **The gateway wire check** remains blocked on the PayMongo account. `provider.refund()` has
>    only ever run against the mock, and **no real payment and no real refund has ever been
>    issued.** The same blocking pre-launch item `LAUNCH_CHECKLIST.md` carries.
> 6. **`db:seed` ships ZERO `tour_itinerary_stops` — across all six tours.** So on a fresh clone 6C's
>    check-ins cannot be demonstrated at all: the driver's itinerary screen is "Start trip" and
>    nothing else, and the departures board reads `0/1` for every trip. The next person hits this in
>    their first ten minutes and has no way to tell a missing feature from missing content.
>    Deliberately **not** fixed as Week 6 closed: changing shared seed content touches
>    `seed-parity.test.ts` and anything that assumes an empty `tour_itinerary_stops`, and it is
>    outside 6A–6F. Whoever does it should add stops to at least one tour and check what the fleet
>    and capacity suites assume first.
> 7. **A single IP can never drive one driver to `requires_admin_unlock`** — and the escalation code
>    is still live, so do not read it as dead and delete it. The per-IP limiter is 10 `driver.login`
>    attempts per 15 minutes and the third lockout needs fifteen failures, so the 429 always arrives
>    first (measured at the 11th attempt, 2026-10-16, with the driver still at `lockout_count = 1`).
>    The policy is reachable **across** IPs — a driver's code tried from several phones or networks,
>    which is exactly the case the three-lockout rule exists for — and across windows. Both halves
>    are tested independently; neither test proves the other.
> 8. **Every app-surface route is served HTTP 404 with the "Page not found" title.** `resolvePage`
>    has no case for `/driver`, `/admin` or `/portal`, so the shell they get is the not-found one:
>    `/driver/login`, `/driver/trip/:id`, `/admin` and `/portal` all answer `404` with
>    `<title>Page not found | TravelSugbo</title>`, indistinguishable from `/nonsense-xyz`
>    (measured 2026-10-16 on the dev middleware; `server/src/html.ts` shares the resolver, so
>    production answers the same). The SPA still boots and renders correctly, and nothing client-side
>    sets `document.title`, so a driver's browser tab reads "Page not found" for their whole shift.
>    It also means an uptime monitor pointed at `/driver` reports the portal down. These routes
>    SHOULD be `noindex` — they already get an `X-Robots-Tag` — but `noindex` and `404` are not the
>    same statement.
>    **Resolved 2026-10-23 (Week 6.5, Task 9 / C2):** the three surfaces now answer `200` with their
>    own titles and `noindex,nofollow` (`appSurfaceMeta`). Not resolved: nothing sets `document.title`
>    client-side, so the injected title does not follow in-app navigation.
> 9. **Four declared `bookings` columns are never written by anything.** `started_at`,
>    `completed_at`, `cancelled_at` and `cancel_reason` exist in `schema.ts` and in no write in
>    `server/src`: `startTrip`, `finishTrip` and `cancelBooking` each set `status` and nothing else
>    (measured 2026-10-16 — a booking driven start → three stops → complete through the browser came
>    out `completed` with `started_at` and `completed_at` both null). **Nothing is lost** — the start
>    time is the `stop_key = 0` checkpoint, the completion time is the `trip.completed` audit row, and
>    the cancel time and reason are the cancel audit row — so this is dead weight rather than a bug.
>    The surprising one is `cancel_reason`: `cancelInput` requires it and rejects an empty string, and
>    it then reaches only the audit payload. Either write the four or drop them; leaving them is how
>    the first report over `completed_at` comes back empty.
>    **Resolved 2026-10-23 (Week 6.5, Task 8, owner-decided C1): the four are now written**, each in
>    the same conditional `UPDATE` as the status change. Bookings that predate the fix still have
>    nulls; the checkpoints and the audit trail remain the authoritative record.
> 10. **Seven owner decisions are open**, listed in one place with each one's safe current behaviour
>     in `docs/superpowers/plans/2026-10-16-week6-walkthrough.md`. Three of them are driver-portal
>     behaviour an owner can answer in a sentence (the payment box on a `completed` trip; whether a
>     cash claim can be refused; whether `booking_notes` needs a visibility column); two are security
>     postures (`driver_inactive` being distinguishable; a driver deactivated mid-shift keeping up to
>     12 hours of access, where staff deactivation is immediate); one is the `on_trip` sweep above;
>     and one is whether an admin cancellation returns the booking's coupon use — hold expiry does, a
>     cancel is a different event, and nothing says.

- **7A** Reviews: submit (portal + public), moderation, replies, helpful votes, verified badge.
- **7B** Coupons admin + redemption log.
- **7C** Packages + inquiries admin; newsletter signup + export. (The public signup and both
  inquiry forms are live via `newsletter.subscribe` and `inquiries.create`; the admin list and
  the CSV export are not.)
- **7D** Reports + CSV exports.
- **7E** Notifications: all emails; SMS provider interface (off by default); day-before
  reminder cron.
- **7F** Settings page — **admin editing screens for every content block the dynamic-site plan
  made database-driven**: announcement, hero, promo, business hours, payment methods, permits,
  how-it-works, why-book-direct, FAQ, contact, the legal markdown, and the per-tour
  featured / sort-order / badge / alert-note fields. All of these are live on the public site
  and editable only by SQL today.
- **7G** Motion polish with **emilkowalski-motion** (subtle only). The home page's motion layer
  (scroll reveal, card stagger, count-up, header shrink, hero parallax, carousel) was built
  early with the dynamic-site plan; what is left here is the portal, driver and admin surfaces.
- **Phase 2 upsell** — travel guides / blog for SEO. Not in this build.

### Week 8 — QA & launch prep

Nothing in this week is built.

- **8A** Full test pass (section 14), at least two complete rounds.
- **8B** Role permission tests for every admin area.
- **8C** Mobile pass on real phones (iOS Safari, Android Chrome). (A 360px mobile pass and a
  motion pass were done for the public site only.)
- **8D** Load real content from client (photos, prices, permits). The build guard
  (`client/scripts/check-placeholders.mjs`) now **blocks** a production build until this is
  done — see `docs/LAUNCH_CHECKLIST.md`.
- **8E** Production readiness checklist (env vars, PayMongo live keys, webhook URL, SSL, PM2
  config, weekly DB dump script).

**Post-launch cleanup:** once the coming-soon holding page is retired, remove the contact
constants from `client/src/lib/site.ts` and delete `scripts/check-contact-parity.mjs`, so
`settings.contact` becomes the single, admin-editable source of truth for phone, email and
hours.

→ **Deployment: separate prompt.**

---

## 14. Test checklist

### Payments

- [ ] PayMongo payment confirms the booking only via webhook.
- [ ] Invalid webhook signature is rejected.
- [ ] Duplicate webhook doesn't double-record.
- [ ] Amount mismatch is flagged, not confirmed.
- [ ] Deposit math is correct with and without a coupon; balance is correct after a partial payment.
- [ ] Hold expires at 15 min and frees capacity.
- [ ] Receipt upload stops expiry.
- [ ] Reject → re-upload → approve works end to end.
- [ ] Refund via PayMongo and manual refund both record correctly.

### Capacity

- [ ] Two simultaneous checkouts for the last slot: exactly one succeeds.
- [ ] Van in repair, too-small van, and driver on leave are all excluded.
- [ ] Blocked dates can't be booked.

### Logins & access

- [ ] Customer login is rate-limited and shows a generic error; customer sees only their own booking.
- [ ] Driver lockout after 5 failed PINs; driver sees only their own trips.
- [ ] Each admin role is blocked from the endpoints it shouldn't reach (tested at the API, not just the UI).
- [ ] Receipt files are unreachable without the correct session.

### Operations

- [ ] Check-ins appear on the dashboard; undo works; last stop completes the trip and frees the van.
- [ ] Cash collected shows in reports.
- [ ] Expiry alerts fire at the right thresholds.

### Public

- [ ] Real stats only.
- [ ] Reviews need approval.
- [ ] Meta tags render per tour.
- [ ] No red anywhere.
- [ ] Mobile layout works at 360px.

---

## 15. Open questions (ask before the related week)

1. **Assignment deadline:** is it "assign at least 48 hours before the tour" or "within 48 hours of booking"? (Before Week 5.)
2. **QR payments:** static R&G QR with manual verification, gateway QR Ph (auto-confirm), or both? (Before Week 3.) — _Schema side settled 2026-10-11: both are representable. A hand-verified transfer is `provider='manual'` plus the instrument the guest used; an auto-confirmed one is `provider='paymongo', method='qrph'`. The remaining question is which to OFFER, not how to store it._
3. **PayPal:** is it enabled on R&G's PayMongo account? If not, remove it from the checkout UI. (Before Week 3.)
4. **SMS:** will the client pay for SMS credits? If not, email only. (Before Week 7.)
5. **Cancellation policy:** free-cancellation window and refund rules per tour. (Before Week 6.) — _Schema side settled 2026-10-11: `free_cancel_hours` is frozen into the booking's price snapshot, so changing a tour's window never alters an existing booking's rights. The policy values themselves are still open._
6. **Backups:** confirm weekly DB dump copied off-server (no paid backups). (Before Week 8.)

---

✅ **When every week is complete and verified, write: ✅ BUILD COMPLETE — ready for deployment prompt.**
