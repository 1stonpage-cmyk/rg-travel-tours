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
- **DO NOT** mark a booking paid from the client side or from a redirect URL. Only a verified PayMongo webhook or an admin approval does that.
- **DO NOT** store card numbers, CVV, or e-wallet credentials anywhere. PayMongo handles them.
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

| Item           | Value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| Brand          | TravelSugbo (public-facing)                                                |
| Legal operator | R&G Travel & Tours, Cebu, Philippines                                      |
| Business       | Day tours + multi-day packages (not van rentals)                           |
| Domain         | TravelSugbo.com                                                            |
| Hosting        | IONOS VPS M+ (2 vCPU, 4 GB RAM), Ubuntu, nginx, PM2                        |
| Payments       | PayMongo (GCash, Maya, GrabPay, card, PayPal if enabled on account, QR Ph) |
| Timeline       | 8 weeks                                                                    |
| Users          | Guests, customers (booked guests), drivers, admin staff                    |

### Five surfaces

1. **Public website**: catalog, tour pages, reviews, packages, contact.
2. **Checkout**: pay full or 30% deposit; PayMongo online or manual QR transfer.
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
| Payments   | PayMongo API + webhooks                                                                |
| Email      | SMTP via a transactional provider (configurable in `.env`)                             |
| SMS        | Optional, behind a provider interface (off by default)                                 |
| Jobs       | `node-cron` in the server process (hold expiry, reminders, alerts)                     |
| Process    | PM2                                                                                    |
| Web server | nginx reverse proxy + Let's Encrypt SSL                                                |

### SEO note (Vite SPA)

The public site needs search visibility. Handle it without SSR:

- Express serves `index.html` and **injects per-route `<title>`, meta description, and Open Graph tags** for `/`, `/tours`, `/tours/:slug`, and `/packages/:slug` from the DB.
- Generate `/sitemap.xml` and `/robots.txt` dynamically.
- Add JSON-LD (`TouristTrip` / `Product` with `AggregateRating`) on tour pages, but only with real review data.

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
deposit         = ceil(total * deposit_percent / 100)  to the nearest whole peso (deposit_percent = 30 in settings)
amount_due_now  = pay_in_full ? total : deposit
balance         = total - amount_paid   (collected on tour day)
```

- Store a **price snapshot** on the booking (tier price, add-on prices, coupon, totals). Later price edits don't change existing bookings.

### Capacity check (at checkout)

A booking is allowed when **all** are true for the tour + date:

1. Date is not past, not blocked for the tour, and the tour is active.
2. Bookings for that tour/date (statuses that hold capacity) < `groups_per_day`.
3. At least one **van** is free that day: active, not `for_repair`, `capacity >= pax`, not already assigned to a trip that date.
4. At least one **driver** is free that day: active, not on leave, not already assigned that date.

Steps 3–4 count already-confirmed-but-unassigned bookings as consuming one van and one driver each, so we never sell more trips than the fleet can run.

**Concurrency:** run the check and the booking insert in **one DB transaction** with a row lock on a `tour_date_slots` row (`SELECT … FOR UPDATE`). Two guests racing for the last slot: one wins, one gets "just sold out."

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

### Checkout page

- Lead guest details: full name, mobile (PH format), email, pickup location (text + optional Google Maps pin), special requests.
- Pay in full / 30% deposit toggle.
- Coupon code field (server-validated: active, within dates, under usage limit, minimum spend).
- Countdown showing the 15-minute hold.
- Terms + privacy consent checkbox (Data Privacy Act notice).

### Online payment (PayMongo)

1. Server creates a PayMongo **Checkout Session** with the exact `amount_due_now`, booking ref in metadata, and allowed methods.
2. Guest pays on PayMongo's page.
3. **Webhook** (`/webhooks/paymongo`) is the only thing that marks the payment paid:
   - Verify the signature header with the webhook secret. Reject if invalid.
   - **Idempotency:** store each event ID in `paymongo_events`; skip duplicates.
   - Check the amount matches the booking's expected amount.
   - In one transaction: insert `payments` row (`paid`), update booking to `confirmed`, write audit log.
4. The success redirect page only **reads** status (polls until the webhook lands). It never confirms anything itself.

### Manual QR payment

1. Show the R&G QR image (uploaded by admin in Settings), **exact amount**, booking ref, and instructions to put the ref in the transfer note.
2. 15-minute hold timer + "Download QR" button.
3. Guest enters the transaction reference number and uploads a receipt screenshot (jpg/png/webp/pdf, max 5 MB).
4. Booking → `pending_verification`; payment row → `pending`.
5. Admin approves → payment `paid`, booking `confirmed`. Admin rejects (with reason) → customer portal shows the reason and a re-upload prompt.

> **Note:** a static QR cannot embed the amount. The amount is shown as text next to the QR. If the client wants auto-confirmed QR payments, use PayMongo's QR Ph method in the online flow instead. See Open questions.

### Refunds & cancellations

- Admin cancels a booking, choosing a refund amount (full, partial, none).
- PayMongo payments: call the PayMongo refund API, then record a `refund` row.
- Manual payments: admin records the refund as done offline (method + reference).
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

| Table                    | Key columns                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | id, name, email (unique), password_hash, role (owner/dispatcher/finance), is_active, last_login_at                                                                                                                                                          |
| `sessions`               | id, subject_type (admin/customer/driver), subject_id, expires_at                                                                                                                                                                                            |
| `settings`               | key, value (JSON)                                                                                                                                                                                                                                           |
| `destinations`           | id, name, slug, sort_order                                                                                                                                                                                                                                  |
| `tours`                  | id, slug, title, destination_id, about, inclusions, exclusions, groups_per_day, max_guests, free_cancel_hours, is_active                                                                                                                                    |
| `tour_images`            | id, tour_id, path, alt, sort_order                                                                                                                                                                                                                          |
| `tour_price_tiers`       | id, tour_id, min_pax, max_pax, price_per_person                                                                                                                                                                                                             |
| `tour_itinerary_stops`   | id, tour_id, sort_order, name, description                                                                                                                                                                                                                  |
| `tour_addons`            | id, tour_id, name, price, per_person (bool), is_active                                                                                                                                                                                                      |
| `tour_blocked_dates`     | id, tour_id, date, reason                                                                                                                                                                                                                                   |
| `tour_date_slots`        | tour_id, date (PK pair); lock row for capacity checks                                                                                                                                                                                                       |
| `packages`               | id, slug, title, days, old_price, new_price, description, is_active                                                                                                                                                                                         |
| `inquiries`              | id, type (contact/package), package_id, name, email, phone, message, status                                                                                                                                                                                 |
| `bookings`               | id, ref (unique), tour_id, tour_date, pax, lead name/email/phone, pickup, requests, status, pay_mode (full/deposit), price snapshot (JSON), subtotal, discount, total, amount_paid, coupon_id, van_id, driver_id, hold_expires_at, started_at, completed_at |
| `booking_addons`         | id, booking_id, addon_id, name, price, per_person, qty                                                                                                                                                                                                      |
| `booking_notes`          | id, booking_id, user_id, note, created_at                                                                                                                                                                                                                   |
| `payments`               | id, booking_id, type (payment/refund), method (paymongo/manual_qr/cash), amount, status (pending/paid/rejected/failed), paymongo_id, txn_ref, receipt_path, reject_reason, verified_by, verified_at, collected_by_driver_id                                 |
| `paymongo_events`        | event_id (unique), type, received_at                                                                                                                                                                                                                        |
| `vans`                   | id, plate, model, capacity, status, odometer, last_service, next_service, orcr_expiry, franchise_no, franchise_expiry, repair_notes, is_active                                                                                                              |
| `drivers`                | id, name, code, phone, pin_hash, failed_attempts, locked_until, license_no, license_expiry, languages, emergency_contact, status, is_active                                                                                                                 |
| `driver_leaves`          | id, driver_id, start_date, end_date, reason                                                                                                                                                                                                                 |
| `trip_checkpoints`       | id, booking_id, stop_id (null for "start"), checked_at, undone (bool)                                                                                                                                                                                       |
| `reviews`                | id, tour_id, booking_id (null if unverified), name, rating, guide, value, punctuality, safety, body, status (pending/published/hidden), reply, replied_at                                                                                                   |
| `review_helpful_votes`   | review_id, voter_hash (unique pair)                                                                                                                                                                                                                         |
| `coupons`                | id, code (unique), kind (percent/fixed), value, min_spend, starts_at, ends_at, usage_limit, used_count, is_active                                                                                                                                           |
| `coupon_redemptions`     | id, coupon_id, booking_id                                                                                                                                                                                                                                   |
| `newsletter_subscribers` | id, email (unique), created_at                                                                                                                                                                                                                              |
| `audit_log`              | id, actor_type, actor_id, action, entity, entity_id, data (JSON), created_at                                                                                                                                                                                |

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
- PayMongo secret key and webhook secret only in `.env`, never in client code.
- Role middleware on every admin procedure, plus a test per role per area.
- Privacy (Data Privacy Act RA 10173):
  - Consent checkbox at checkout.
  - Privacy notice page.
  - Admin-only access to personal data.

---

## 13. Build plan — 8 weeks

Each task ends with **✅ DONE**. Each week ends with **✅ WEEK X COMPLETE** after verification.

### Week 1 — Foundation

- **1A** Repo setup: client/server/shared, TypeScript, Tailwind, shadcn, tRPC, Drizzle, ESLint/Prettier, `.env.example`. ✅ DONE
- **1B** Full Drizzle schema (section 10) + first migration + seed (destinations, 6 tours with tiers/stops/add-ons, 4 vans, 4 drivers, owner user, settings). ✅ DONE
- **1C** Auth: admin sessions + role middleware; customer and driver session types. ✅ DONE
- **1D** Shared money/time utilities (centavos, Asia/Manila) with unit tests. ✅ DONE
- **1E** `CLAUDE.md` with these conventions. ✅ DONE

### Week 2 — Public site

Use **ui-ux-pro-max** throughout; match the approved demo.

- **2A** Layout, header, footer, floating WhatsApp, brand tokens (blue/gold, no red). ✅ DONE
- **2B** Home page sections 1–13. ✅ DONE
- **2C** Catalog with destination filter and real stats. ✅ DONE
- **2D** Tour detail page (gallery, itinerary, tiers, add-ons, date/guest picker). ✅ DONE
- **2E** Meta tag injection, sitemap, robots. ✅ DONE

### Week 3 — Booking & online payments

- **3A** Pricing service + tests (tiers, add-ons, coupons, deposit rounding). ✅ DONE
- **3B** Capacity service + transaction lock + concurrency test. ✅ DONE
- **3C** Hold creation + expiry cron. ✅ DONE
- **3D** Checkout page + coupon validation. ✅ DONE
- **3E** PayMongo checkout session + webhook (signature, idempotency, amount check). ✅ DONE
- **3F** Confirmation page (read-only polling) + confirmation emails. ✅ DONE

### Week 4 — Manual QR & customer portal (Phase 1 review)

- **4A** Manual QR flow: QR display, timer, download, txn ref, receipt upload. ✅ DONE
- **4B** Customer portal login + rate limiting. ✅ DONE
- **4C** 5-step tracker, receipt re-upload, auto-refresh. ✅ DONE
- **4D** Basic admin bookings list + detail. ✅ DONE
- **4E** End-to-end test of every Phase 1 flow; fix and retest. ✅ DONE

→ **Client demo / Phase 1 approval.**

### Week 5 — Dispatch

- **5A** Vans CRUD + status + expiry fields. ✅ DONE
- **5B** Drivers CRUD + leaves + PIN reset. ✅ DONE
- **5C** Calendar month view with gold dots. ✅ DONE
- **5D** Assignment with exclusion rules + auto-suggest. ✅ DONE
- **5E** Dashboard alerts (verification, unassigned, repair, service, expiries). ✅ DONE

### Week 6 — Drivers & verification

- **6A** Driver portal login + lockout. ✅ DONE
- **6B** Today/Upcoming/History + trip detail + payment box. ✅ DONE
- **6C** Check-ins (start, stops, complete, undo, cash collected). ✅ DONE
- **6D** Live departures on the dashboard. ✅ DONE
- **6E** Payment verification queue (approve/reject → portal updates). ✅ DONE
- **6F** Cancel/refund flow (PayMongo refund API + manual record). ✅ DONE

### Week 7 — Growth features

- **7A** Reviews: submit (portal + public), moderation, replies, helpful votes, verified badge. ✅ DONE
- **7B** Coupons admin + redemption log. ✅ DONE
- **7C** Packages + inquiries admin; newsletter signup + export. ✅ DONE
- **7D** Reports + CSV exports. ✅ DONE
- **7E** Notifications: all emails; SMS provider interface (off by default); day-before reminder cron. ✅ DONE
- **7F** Settings page. ✅ DONE
- **7G** Motion polish with **emilkowalski-motion** (subtle only). ✅ DONE

### Week 8 — QA & launch prep

- **8A** Full test pass (section 14), at least two complete rounds. ✅ DONE
- **8B** Role permission tests for every admin area. ✅ DONE
- **8C** Mobile pass on real phones (iOS Safari, Android Chrome). ✅ DONE
- **8D** Load real content from client (photos, prices, permits). ✅ DONE
- **8E** Production readiness checklist (env vars, PayMongo live keys, webhook URL, SSL, PM2 config, weekly DB dump script). ✅ DONE

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
