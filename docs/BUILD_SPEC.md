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

| Layer      | Choice                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- |
| Frontend   | React + TypeScript + Vite + Tailwind + shadcn/ui                                       |
| Routing    | React Router                                                                           |
| API        | Express + tRPC                                                                         |
| ORM / DB   | Drizzle + MySQL 8                                                                      |
| Validation | Zod (shared between client and server)                                                 |
| Auth       | Session cookies (httpOnly, secure, sameSite=lax), bcrypt/argon2 for passwords and PINs |
| Payments   | `PaymentProvider` interface; PayMongo API + webhooks first, Xendit stubbed             |
| Email      | SMTP via a transactional provider (configurable in `.env`)                             |
| SMS        | Optional, behind a provider interface (off by default)                                 |
| Jobs       | `node-cron` in the server process (hold expiry, reminders, alerts)                     |
| Process    | PM2                                                                                    |
| Web server | nginx reverse proxy + Let's Encrypt SSL                                                |

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
base            = tier.price_per_person * pax
addons          = sum(per_person ? price * pax : price)  for selected add-ons
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

- Store a **price snapshot** on the booking (tier price, add-on prices, coupon, totals). Later price edits don't change existing bookings.

### Capacity check (at checkout)

A booking is allowed when **all** are true for the tour + date:

1. Date is not past, not blocked for the tour, and the tour is active.
2. Bookings for that tour/date (statuses that hold capacity) < `groups_per_day`.
3. At least one **van** is free that day: active, not `for_repair`, `capacity >= pax`, not already assigned to a trip that date.
4. At least one **driver** is free that day: active, not on leave, not already assigned that date.

Steps 3–4 count already-confirmed-but-unassigned bookings as consuming one van and one driver each, so we never sell more trips than the fleet can run.

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

> **Open — the lock above is not sufficient for the rule above.** "Vans free that day **across all
> tours**" is a date-global limit, but `tour_date_slots` is keyed by `(tour_id, date)`. Two bookings
> for _different_ tours on the same date lock _different_ rows, so neither waits for the other and
> both can take the last van. A date-level lock is needed as well. Tracked as Q14 in
> `docs/superpowers/plans/2026-10-10-core-schema.md`; unresolved, and it blocks the capacity service.

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
guest paid_ (card, gcash, maya, grabpay, qrph, bank_transfer, manual_qr, cash), because the same
instrument exists on several gateways and §9's revenue report needs both axes.

### Manual QR payment

1. Show the R&G QR image (uploaded by admin in Settings), **exact amount**, booking ref, and instructions to put the ref in the transfer note.
2. 15-minute hold timer + "Download QR" button.
3. Guest enters the transaction reference number and uploads a receipt screenshot (jpg/png/webp/pdf, max 5 MB).
4. Booking → `pending_verification`; payment row → `pending`.
5. Admin approves → payment `paid`, booking `confirmed`. Admin rejects (with reason) → customer portal shows the reason and a re-upload prompt.

A manual QR payment is recorded with `provider = 'manual'` and `method = 'manual_qr'`. It has no
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

- PIN hashed. Lock the driver account for 15 minutes after 5 failed attempts.
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
5. Driver can mark "cash collected" with the amount → creates a `payments` row (`cash`, collected_by driver) for admin to reconcile.

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
| `sessions`               | id, subject_type (admin/customer/driver), subject_id, expires_at                                                                                                                                                                                                                                                                                                                                   |
| `settings`               | key, value (JSON)                                                                                                                                                                                                                                                                                                                                                                                  |
| `destinations`           | id, name, slug, sort_order                                                                                                                                                                                                                                                                                                                                                                         |
| `tours`                  | id, slug, title, destination_id, about, inclusions, exclusions, groups_per_day, max_guests, free_cancel_hours, is_active                                                                                                                                                                                                                                                                           |
| `tour_images`            | id, tour_id, path, alt, sort_order                                                                                                                                                                                                                                                                                                                                                                 |
| `tour_price_tiers`       | id, tour_id, min_pax, max_pax, price_per_person                                                                                                                                                                                                                                                                                                                                                    |
| `tour_itinerary_stops`   | id, tour_id, sort_order, name, description                                                                                                                                                                                                                                                                                                                                                         |
| `tour_addons`            | id, tour_id, name, price, per_person (bool), is_active                                                                                                                                                                                                                                                                                                                                             |
| `tour_blocked_dates`     | id, tour_id, date, reason                                                                                                                                                                                                                                                                                                                                                                          |
| `tour_date_slots`        | tour_id, date (PK pair); lock row for capacity checks                                                                                                                                                                                                                                                                                                                                              |
| `packages`               | id, slug, title, days, old_price, new_price, description, is_active                                                                                                                                                                                                                                                                                                                                |
| `inquiries`              | id, type (contact/package), package_id, name, email, phone, message, status                                                                                                                                                                                                                                                                                                                        |
| `bookings`               | id, ref (unique), tour_id, tour_date, pax, lead name/email/phone, pickup, requests, status, pay_mode (full/deposit), price snapshot (JSON), subtotal, discount, total, amount_paid, coupon_id, van_id, driver_id, hold_expires_at, started_at, completed_at                                                                                                                                        |
| `booking_addons`         | id, booking_id, addon_id, name, price, per_person, qty                                                                                                                                                                                                                                                                                                                                             |
| `booking_notes`          | id, booking_id, user_id, note, created_at                                                                                                                                                                                                                                                                                                                                                          |
| `payments`               | id, booking_id, type (payment/refund), **provider (paymongo/xendit/manual)**, **method (card/gcash/maya/grabpay/qrph/bank_transfer/manual_qr/cash)**, amount_centavos, status (pending/paid/rejected/failed/refunded), **provider_ref**, **provider_status**, txn_ref, receipt_path, reject_reason, verified_by, verified_at, collected_by_driver_id                                               |
| `payment_events`         | id, provider, provider_event_id, type, payload, received_at, processed_at — **UNIQUE (provider, provider_event_id)**. Renamed from `paymongo_events` by the 2026-10-10 multi-gateway change: two gateways can mint the same event id, so uniqueness is per provider                                                                                                                                |
| `vans`                   | id, plate, model, capacity, status, odometer, last_service, next_service, orcr_expiry, franchise_no, franchise_expiry, repair_notes, is_active                                                                                                                                                                                                                                                     |
| `drivers`                | id, name, code, phone, pin_hash, failed_attempts, locked_until, license_no, license_expiry, languages, emergency_contact, status, is_active                                                                                                                                                                                                                                                        |
| `driver_leaves`          | id, driver_id, start_date, end_date, reason                                                                                                                                                                                                                                                                                                                                                        |
| `trip_checkpoints`       | id, booking_id, stop_id (null for "start"), checked_at, undone (bool)                                                                                                                                                                                                                                                                                                                              |
| `reviews`                | id, tour_id, booking_id (null if unverified), name, rating, guide, value, punctuality, safety, body, status (pending/published/hidden), reply, replied_at                                                                                                                                                                                                                                          |
| `review_helpful_votes`   | review_id, voter_hash (unique pair)                                                                                                                                                                                                                                                                                                                                                                |
| `coupons`                | id, code (unique), **discount_type (percent/fixed)**, **percent_bp** (basis points, 1000 = 10%, NULL unless percent), **amount_centavos** (NULL unless fixed), min_spend_centavos, starts_at, ends_at, usage_limit, used_count, is_active — **CHECK: exactly one of percent_bp / amount_centavos is set, matching discount_type** (owner decision 2026-10-11, replacing the single `value` column) |
| `coupon_redemptions`     | id, coupon_id, booking_id                                                                                                                                                                                                                                                                                                                                                                          |
| `newsletter_subscribers` | id, email (unique), created_at                                                                                                                                                                                                                                                                                                                                                                     |
| `audit_log`              | id, actor_type, actor_id, action, entity, entity_id, data (JSON), created_at                                                                                                                                                                                                                                                                                                                       |

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

Nothing in this week is built. There is no `server/src/jobs`, no `server/src/webhooks`, no
gateway client and no `node-cron` dependency.

**Blocked on the core schema.** Every task below needs tables that do not exist yet — `bookings`,
`payments`, `payment_events`, `coupons`, `tour_date_slots`. Those are planned in
`docs/superpowers/plans/2026-10-10-core-schema.md`, which must be approved and executed first.
That plan also carries thirteen open questions; **Q7 (does the van/driver capacity check mean
per-day or per-trip?) blocks 3B**, and Q4 (deposit rounding) blocks 3A.

- **3A** Pricing service + tests (tiers, add-ons, coupons, deposit rounding).
- **3B** Capacity service + transaction lock + concurrency test.
- **3C** Hold creation + expiry cron.
- **3D** Checkout page + coupon validation.
- **3E** Checkout session + webhook through the `PaymentProvider` seam (signature, idempotency
  on `(provider, provider_event_id)`, amount check). PayMongo implemented; Xendit stays a stub
  that cannot mark anything paid — see the 2026-10-10 multi-gateway change in section 6.
- **3F** Confirmation page (read-only polling) + confirmation emails.

Roadmap items to pick up in or after this week:

- **Week 3** — "X slots left today" and "Next available date" on the catalog and detail pages,
  from capacity (`tour_date_slots`).
- **Week 3+** — real "booked this week" and guests-served counts from completed bookings. Wire
  `tours.historical_trips_count` in as the baseline so the displayed total is history + live
  bookings (plan decision D8) rather than a number that drops to near-zero at launch.
- **Pricing engine** — peak and holiday pricing, once the tier engine (3A) exists.

### Week 4 — Manual QR & customer portal (Phase 1 review)

Nothing in this week is built. There is no `client/src/pages/portal` or `.../admin`.

- **4A** Manual QR flow: QR display, timer, download, txn ref, receipt upload.
- **4B** Customer portal login + rate limiting.
- **4C** 5-step tracker, receipt re-upload, auto-refresh.
- **4D** Basic admin bookings list + detail.
- **4E** End-to-end test of every Phase 1 flow; fix and retest.

→ **Client demo / Phase 1 approval.**

### Week 5 — Dispatch

Nothing in this week is built.

- **5A** Vans CRUD + status + expiry fields.
- **5B** Drivers CRUD + leaves + PIN reset.
- **5C** Calendar month view with gold dots.
- **5D** Assignment with exclusion rules + auto-suggest.
- **5E** Dashboard alerts (verification, unassigned, repair, service, expiries).

### Week 6 — Drivers & verification

Nothing in this week is built. There is no `client/src/pages/driver`.

- **6A** Driver portal login + lockout.
- **6B** Today/Upcoming/History + trip detail + payment box.
- **6C** Check-ins (start, stops, complete, undo, cash collected).
- **6D** Live departures on the dashboard.
- **6E** Payment verification queue (approve/reject → portal updates).
- **6F** Cancel/refund flow (PayMongo refund API + manual record).

### Week 7 — Growth features

Nothing in this week is built. Public _display_ of reviews, packages and the newsletter form
exists (it is part of 2B), but no submission, moderation, admin or export side of any of it.

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
2. **QR payments:** static R&G QR with manual verification, PayMongo QR Ph (auto-confirm), or both? (Before Week 3.)
3. **PayPal:** is it enabled on R&G's PayMongo account? If not, remove it from the checkout UI. (Before Week 3.)
4. **SMS:** will the client pay for SMS credits? If not, email only. (Before Week 7.)
5. **Cancellation policy:** free-cancellation window and refund rules per tour. (Before Week 6.)
6. **Backups:** confirm weekly DB dump copied off-server (no paid backups). (Before Week 8.)

---

✅ **When every week is complete and verified, write: ✅ BUILD COMPLETE — ready for deployment prompt.**
