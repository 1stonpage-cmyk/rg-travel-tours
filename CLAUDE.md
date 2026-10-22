# CLAUDE.md — R&G Travel & Tours

Standing conventions for every session on this repo. **Read this before implementing anything.**
Full requirements live in `docs/BUILD_SPEC.md` — that spec wins any disagreement with this file.

## Project

Online booking + operations system for **TravelSugbo**, Cebu, Philippines.
Day tours and multi-day packages. Domain: TravelSugbo.com. 8-week build.

**Brand vs legal entity — keep these separate.** The public trading brand is
**TravelSugbo**; the licensed operator is **R&G Travel & Tours**, which holds the
DOT/DTI/BIR registrations, the PayMongo merchant account and the payment QR.
In code these are `SITE.name` and `SITE.legalOperator` (`client/src/lib/site.ts`).
Customer-facing copy uses the brand. Anything regulatory, legal or financial —
the copyright notice, the accreditation block, the "Operated by" credit, payment
receipts — names the operator. Do not collapse them into one value.

Five surfaces: public website, checkout, customer portal, driver portal, admin/dispatch.

## Ports — hard constraint

**Kong PMS also runs on this machine. NEVER use port 5173 or port 3000.**

| Process                  | Port                          |
| ------------------------ | ----------------------------- |
| Client (Vite dev server) | **5180** (`strictPort: true`) |
| Server (Express + tRPC)  | **3100**                      |

- Vite proxies `/trpc` and `/api` to `http://localhost:3100`.
- Ports come from `.env` (`CLIENT_PORT=5180`, `PORT=3100`) and are mirrored in `.env.example`.
- Local MySQL database name is **`rg_travel`** — separate from Kong's database.

## Commands

| Command                             | Does                                            |
| ----------------------------------- | ----------------------------------------------- |
| `pnpm install`                      | Install all workspace packages                  |
| `pnpm dev`                          | Run client (5180) and server (3100) in parallel |
| `pnpm build`                        | Build every package                             |
| `pnpm test`                         | Run all tests                                   |
| `pnpm typecheck`                    | `tsc --noEmit` across packages                  |
| `pnpm lint` / `pnpm lint:fix`       | ESLint                                          |
| `pnpm format` / `pnpm format:check` | Prettier                                        |

Database commands live in the **server** workspace, so they need the filter — a bare
`pnpm db:seed` from the repo root fails with `Command "db:seed" not found` (BUG-101):

| Command                                | Does                                             |
| -------------------------------------- | ------------------------------------------------ |
| `pnpm --filter @rg/server db:generate` | Write a migration from `src/db/schema.ts`        |
| `pnpm --filter @rg/server db:migrate`  | Apply migrations to `rg_travel` (name preflight) |
| `pnpm --filter @rg/server db:seed`     | Load development content from `src/db/seed-data` |

Package manager is **pnpm**. Do not introduce npm or yarn lockfiles.
`.gitattributes` pins the whole tree to LF (`* text=auto eol=lf`) — without it a fresh clone
on Windows fails `pnpm format:check` on every text file (BUG-099). Do not relax it.

## Layout

```
/client   React + TS + Vite + Tailwind v4 + shadcn/ui
  src/pages/public | portal | driver | admin
  src/components | src/lib
/server   Express + tRPC
  src/routers | services | db | seo | content | middleware   (built)
  src/jobs | webhooks                                        (Week 3+, not yet created)
/shared   Zod schemas, types, constants
/uploads  OUTSIDE the web root; receipts served via an authenticated route
/docs     BUILD_SPEC.md and superpowers plans
```

## Stack

React + TypeScript + Vite + Tailwind v4 + shadcn/ui + React Router · Express + tRPC ·
Drizzle + MySQL 8 · Zod (shared) · session cookies with **scrypt via `node:crypto`**
(owner decision 2026-10-14, replacing argon2/bcrypt: no native dependency to build on the VPS;
OWASP parameters, self-describing hashes so a later migration is additive) · PayMongo ·
SMTP email · optional SMS behind a provider interface · `node-cron` · PM2 · nginx + Let's Encrypt.

Tailwind is **v4**: brand tokens live in an `@theme` block in `client/src/index.css`.
There is no `tailwind.config.js`.

## Conventions

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display.
  A **refund never decrements `bookings.amount_paid_centavos`**: it is a separate positive
  `payments` row of `type = 'refund'`, and the cap is computed as paid minus already-refunded
  inside the transaction, under the booking row lock. §6's "a refund is never a booking status"
  extends to "a refund is never a subtraction from what was paid".
- **Time:** store **UTC**; display and compute business dates in **Asia/Manila**.
- **IDs:** auto-increment internally. Public booking refs are random and non-sequential (`RG-7KQ4M9`).
- **A booking's lifecycle instants are on the booking, but the record is `trip_checkpoints` and
  `audit_log`.** `bookings.started_at`, `completed_at`, `cancelled_at` and `cancel_reason` are each
  written by the ONE path that owns the event, in the same conditional `UPDATE` as the status
  change (owner decision 2026-10-16, C1): `startTrip` sets `started_at`; `finishTrip` (the
  Complete tap and the last-stop check-in alike) sets `completed_at`; the completion undo clears
  `completed_at` back to null in the `UPDATE` that restores `in_progress`, while `started_at` stays
  (undoing a check-in never touches it); `cancelBooking` sets `cancelled_at` and `cancel_reason`. A
  refused transition matches nothing and stores nothing. Every instant is a `now` read once at the
  request boundary, never inside the service (`cancelBooking`'s `now` is required). The columns are
  a fast read over the record, not a replacement for it: the start time is still the `stop_key = 0`
  checkpoint, the completion is the `trip.completed` audit row, and the cancel is the cancel audit
  row. **Rows that predate this change have nulls**, so a report over `completed_at` or
  `cancelled_at` must tolerate them (fall back to the checkpoint or audit row). `writeAudit` stamps
  its own `created_at` from the real clock, so an audit row's time and the column's can differ
  wherever a caller injects a `now`.
- **Soft deletes:** use `is_active` / status fields for tours, vans, drivers, users.
  **Never hard-delete bookings or payments.**
- **Audit:** every payment, refund, status change, and assignment writes to `audit_log`.
- **Validation:** Zod on every input, schemas shared from `/shared`.

## Brand & design

- **Blue primary, gold accent. NO RED ANYWHERE** — including errors, badges, and
  destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`).
  shadcn's `--destructive` token is remapped away from red.
  A guard test (`client/src/__tests__/no-red.test.ts`) fails the build if red reappears.
- **Contrast guard:** `client/src/__tests__/contrast.test.ts` reads every class string that
  sets both a `bg-brand-*` and a `text-brand-*` utility, resolves both against the `@theme`
  block in `index.css`, and requires AA (4.5:1). It reads the real source, not a fixture list,
  so a pairing added later is checked without anyone updating anything (BUG-080).
- **Mobile-first.** Must work at 360px; most guests book on a phone.
- **Accessibility:** 44px minimum tap targets, visible focus states, alt text on every
  image, AA contrast.
- **Gold contrast:** `brand-gold-600` (`#b8860b`) fails AA (4.5:1) for normal-size text on
  white and on `brand-blue-50` — measured 3.25:1 and 3.00:1. Small gold text (eyebrows,
  labels, captions) must use `brand-gold-700` or darker. `brand-gold-600` remains fine for
  non-text uses (icons, badges, large decorative elements).
- **Brand-colour exception (WhatsApp / Viber):** `#25D366` (WhatsApp), `#128C7E` (WhatsApp
  hover/pressed) and `#7360F2` (Viber) are a documented exception to the blue/gold palette —
  official third-party chat-app colours, used only for WhatsApp/Viber deep-link controls.
  Red remains forbidden everywhere else. **No white text on any of the three** — each carries
  only the official white glyph (exempt under WCAG 1.4.11 as a logotype); every pill built
  from one of these colours is icon-only with an `aria-label`, and any visible wording
  ("Chat on WhatsApp", "Viber") sits **outside** the pill, on the page background, in brand
  ink. `#128C7E` is the WhatsApp pill's hover/pressed state only and never gets white text
  either. White-on-`#25D366` measures 1.98:1 (fails AA at any size); `#128C7E` and `#7360F2`
  measure 4.14:1 and 4.48:1, both just under the 4.5:1 bar — hence one uniform rule instead
  of per-colour sizing exceptions.
- **Motion:** subtle only (card hovers, tracker progress, check-in confirmation), and only
  after the layout exists.

## Workflow

- Use **Superpowers** (`writing-plans` + `subagent-driven-development`) per week of work.
  Write the plan, get approval, then execute.
- Use **ui-ux-pro-max** for all UI, layout, and design work.
- Motion: Use **emilkowalski-motion** for motion/animation only, after layout exists. Subtle only; respect `prefers-reduced-motion`.
- **Verify before pushing — all five, in this order:**
  `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` ·
  `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.
  `pnpm test` also runs the standalone guards (`check:coming-soon`, `check:contact`).
  Never report work as done on an unrun command.
- **Every new test must be proven able to fail.** Break the code it covers, confirm the
  test goes red, then restore. A test that cannot fail is a bug — log it in
  `docs/BUGS_LOG.md`. **Security controls and destructive operations must fail closed,
  with a test for the failure path.**
- Keep formatting changes in their own commit. A `pnpm format` sweep mixed into a
  feature commit buries the real diff.
- Write **✅ DONE** immediately after each numbered task (1A, 1B, …) actually finishes.
- Write **✅ WEEK X COMPLETE** when every task in a week is done and verified.
- Report commits as `hash - short human label` (e.g. `55f1bba - Checkout deposit math`).
- After any schema change, remind the user to apply the migration on the server database.
- Build **additively**. Once a feature works, extend it — do not rewrite it.
- Prefer simple solutions. No over-engineering, no duplicate data.

## DO NOT

- **DO NOT** trust prices, totals, deposits, or discounts sent from the browser.
  The server computes all money.
- **DO NOT** mark a booking paid from the client side or from a redirect URL.
  Only a verified PayMongo webhook or an admin approval does that.
- **DO NOT** store card numbers, CVV, or e-wallet credentials anywhere. PayMongo handles them.
- **DO NOT** expose receipt uploads, driver data, or customer details through public URLs.
- **DO NOT** let one role reach another role's endpoints. Hiding a button is not access control.
- **DO NOT** change auth, payment, or database schema logic outside the task you were given.
- **DO NOT** deploy to production from the spec. Deployment is a separate, dedicated prompt.
- **DO NOT** add libraries, services, or features not listed in the spec without asking.
- **DO NOT** use red anywhere in the UI.
- **DO NOT** fake social proof. Ratings, "booked X times", and guest counts must come from
  real data or admin-entered settings.
- **DO NOT** use ports 5173 or 3000.

## Content (current state)

The public site is fully database-backed (task 3.7 deleted the last hardcoded module).
Every page reads tours, destinations, packages, reviews, FAQs and settings from the
`rg_travel` MySQL database via tRPC, seeded for local development by
`pnpm --filter @rg/server db:seed` from `server/src/db/seed-data.ts`.

- `settings.content_unverified` (exposed to the client as `contentUnverified`) drives the
  on-site amber banner (`PlaceholderBadge.tsx`), gates production builds, **and keeps the
  whole site out of every search index**. An admin clears it once real content replaces the
  seed; clearing it is the act that publishes the site to search engines.
- Permit numbers (DOT/DTI/BIR) remain `null` in the seed and render as an explicit
  "— pending —" state (`lib/site.ts`). **Never invent an accreditation number.**
- Seeded reviews are flagged `is_sample` in the database. Published samples block a
  production build, and never contribute to a rating a crawler can see.
- **The production build guard** is `client/scripts/check-placeholders.mjs`. It asks the
  database (through a small server-side probe, so the client package grows no mysql2) and
  exits non-zero while a published `is_sample` review exists or `content_unverified` is set.
  `ALLOW_PLACEHOLDER_BUILD=1` is the deliberate override for local builds and client demos —
  never for a launch build. It fails closed: an unreachable database blocks the build.
- **Content tokens:** admin-editable content may embed `{{tokenName}}` placeholders, which the
  rendering component substitutes with live data — currently only `{{paymentMethods}}` in the
  payment FAQ answer, replaced with the enabled payment methods. Tokens are allowed **only** in
  settings-stored copy, never in component source, and an answer with no token renders verbatim.
  Adding a **second** token requires extracting a shared substitution helper first, rather than
  repeating the per-component match.
- **The dev seed ships three to five `tour_itinerary_stops` per tour (24 across the six); the test
  database ships none** (owner decision 2026-10-16, C4). `upsertItineraryStops` in `seed.ts` runs only
  when `context === 'app'`, beside `upsertFleet`, and replaces a tour's stops wholesale on each run.
  It is app-only because `tripProgress` and `checkins.ts` count a booking's checkpoints against its
  tour's stops to decide how far a trip has got and whether the van is freed, so stops those suites
  did not create would change their answers. On a fresh clone the driver's itinerary screen now lists
  the stops and the departures board reads `0 of 4 stops`, not `0/1` (the trip-start event counts as
  the first), so 6C is demonstrable. The stops are seed content like the rest — real place names in
  van order, still behind `content_unverified` — and 7F's editing screens still do not cover them.
- Placeholder imagery still lives in `client/public/placeholders/`, generated by
  `client/scripts/generate-placeholders.mjs` — brand-gradient SVGs labelled PLACEHOLDER.

## SEO & indexing (current state)

- **Per-route head content is injected server-side**, from the database, for `/`, `/tours`,
  `/privacy`, `/terms`, `/tours/:slug` and `/packages/:slug`: title, description, canonical,
  Open Graph, Twitter, JSON-LD, and the home page's hero preload.
- **Two surfaces, one implementation.** `server/src/seo/resolvers.ts` (`resolvePage`) decides,
  `server/src/seo/render.ts` (`injectMeta`) renders; production serves it from
  `server/src/html.ts` and dev from the `rg-seo-dev` middleware in `client/vite.config.ts`.
  Never build meta in a surface — if a title is wrong it is wrong in the resolver, for both.
  `injectMeta` is the single escaping boundary; resolvers return plain text, never markup.
- The dev middleware only acts on requests sending `Accept: text/html`. A bare `curl` sends
  `*/*`, falls through to the static shell and shows no injected meta — verify with
  `curl -H "Accept: text/html"` or you will be misled.
- **JSON-LD ships on every public route**: `TravelAgency` everywhere, `FAQPage` on `/`,
  `TouristTrip` on the two detail routes.
- **`aggregateRating` comes only from real reviews** (`status='published' AND is_sample=0`,
  via `realAggregate()`) and the key is **omitted entirely** when there are none — never a
  zero, never `settings.trust.ratingAverage`. With the current seed, no rating is emitted
  anywhere.
- `/sitemap.xml` and `/robots.txt` are generated from the database per request. A sitemap must
  never list a URL that says `noindex`, and `lastmod` is read from `updated_at`, never
  invented.
- **Two independent noindex gates, both fail closed.** While `settings.content_unverified` is
  true, `robots.txt` says `Disallow: /` and every route is served `noindex,nofollow`. And
  `SITE_ENV` must be `production` in the deployed `.env` or `robots.txt` fails closed the same
  way — it defaults to `development`. `/admin`, `/driver` and `/portal` additionally get an
  `X-Robots-Tag`.
- `client/index.html` is the **shared** SPA shell. Anything route-specific belongs in the
  injector, not in it — a hero preload there is served on `/privacy` too (task 4.4b). Its
  `viewport-fit=cover` meta must stay: without it the mobile bottom bar's safe-area padding is
  inert (BUG-079).

## Dispatch (current state)

- **One module answers "which van and which driver are free on this date"** —
  `server/src/services/dispatch/availability.ts`. The §9 exclusion rules live there and nowhere
  else: the calendar dropdowns, the auto-suggest and the assignment mutation's re-check all read it.
  Three copies of that question is how a van gets sent to two trips on one morning.
- **Only `status = 'available'` is sellable or dispatchable fleet** (`VAN_STATUS_SELLABLE`, owner
  decision 2026-10-14). An allow-list, not a deny-list: a status added later is unsellable until
  someone decides otherwise. `on_trip` is included in "not sellable", and because `vans.status` is
  not date-scoped, a van left there is refused on **every future date at once**.
- **`on_trip` is set and cleared by `server/src/services/trips/checkins.ts` and by nothing else.**
  `startTrip` sets it, `finishTrip` clears it (both routes into it — the Complete tap and the
  last-stop check-in), and undoing a completion puts it back; each half runs in the same
  transaction as its checkpoint write, so there is no window in which a running trip has an
  `available` van. `moveVanStatus` is conditional in SQL in both directions — the `from` status is
  in the `WHERE` — which is what stops a completion from putting a van a dispatcher marked
  `for_repair` back on sale. The proof is `server/src/__tests__/trip-van-status.test.ts`, whose
  **load-bearing test reads capacity** — `assessCapacity` / `vansFreeOn`, on a date thirty days
  out — rather than the `vans.status` column. Three of its five tests do assert the column, and
  deliberately: the write has to be pinned before anything is built on it. But the column only
  proves the write landed, and availability proves dispatch honours it, so a van-status test that
  reads the column ALONE is not a test of this rule.
- **A van left `on_trip` by a trip nobody completed is made VISIBLE, never auto-freed** (owner decision
  2026-10-16, D5). A driver whose phone dies at the last stop, or who simply forgets, leaves the van
  `on_trip` — and because `vans.status` is not date-scoped it is refused on every future date at once.
  Two surfaces now report it: a sixth dashboard alert, `orphaned_on_trip` (`orphanedOnTripVans` in
  `server/src/services/dispatch/alerts.ts`: an active van in `on_trip` with no `in_progress` booking;
  not from §9, hence the sixth in `DASHBOARD_ALERT_KINDS`, same `DashboardAlert` shape with
  `date: null` and the plate and last trip in `label`), and a daily `console.warn` from
  `server/src/jobs/orphaned-vans.ts` at **07:00 Asia/Manila** (registered in `jobs/index.ts` with the
  zone passed explicitly; silent when nothing is found). **Neither changes a status, and neither
  writes an audit row.** That is the owner's instruction, not an omission: on the one day a trip
  genuinely overruns past midnight, an automatic sweep would put a van with guests in it back on sale,
  and a dispatcher can tell the two cases apart where a clock cannot. **What is still manual:** a human
  completes or corrects the trip (or sets the van's status on the fleet screen). Do not "finish" this
  by adding a sweep without a new owner decision. The no-sweep rule is pinned from two sides:
  `orphaned-vans.test.ts` ("CHANGES NOTHING" — status, `updated_at` and dispatch availability all
  unchanged after the job) and the last test in `trip-van-status.test.ts`, which pins the absence of
  any completion path for an abandoned trip. **Building the alert did not redden that gap test and
  nothing but a real sweep or a new completion path would**; whoever builds one should replace it with
  the new behaviour's own proof rather than loosen it. Caveat on that second pin: it never calls the
  job, so it does not by itself catch the job being changed to write a status — `orphaned-vans.test.ts`
  is the one that does (measured 2026-10-23).
- **Lock order for anything that touches a day's capacity is absolute:** `fleet_date_slots(date)`
  → `tour_date_slots(tour_id, date)` → the booking row. `createHold()`, the expiry sweep and
  `assignVanAndDriver()` all take it in that order. Two paths taking the same pair in opposite
  orders deadlock, and that failure never appears in a test and always appears on a holiday weekend.
- **Take the lock BEFORE reading availability.** Under REPEATABLE READ a non-locking read taken
  first returns the pre-lock snapshot even after the lock is granted — this project has shipped that
  bug once already. The assignment tests fail if the lock merely moves after the read, which is the
  only way to keep that honest.
- **A civil date is a string; a `date()` column is a `Date`.** Convert with `civilDateFromDate()`
  and compare with the raw-`sql` helpers (`on()`, `onDate()`, `betweenDates()`), never `eq()`
  against a string. `takeSlotLocks()` asserts its date is civil and throws otherwise.
- **Time-dependent queries take an explicit `now`.** A clock read inside a query cannot be tested at
  a boundary without faking timers globally, which is how a timezone bug survives its own suite. The
  procedure takes no time from the client.
- **The test database keeps an EMPTY fleet.** `capacity.test.ts` counts the whole fleet, so
  `db:seed` puts vans, drivers and demo bookings in `rg_travel` only (`seed(context)` gates on
  `'app'`). Do not loosen that assertion to fit a seed.
- **Cancelling a trip does not retract the check-ins already recorded** (owner ruling 2026-10-16,
  Task 13). `admin.refunds.cancelBooking` sets `cancelled` and leaves every checkpoint standing —
  the van really did reach those stops, and erasing that would be the worse record. Because
  `checkInStop`'s `in_progress` gate is a plain read, a check-in already in flight can also land
  moments **after** a cancel, and `undoLastCheckIn` will still retract a tap on a cancelled
  booking; neither moves money nor the van. What the cancel does do is put an `on_trip` van back to
  `available` (`releaseVanFromTrip`), because the completion that would have cleared it is never
  going to happen now. **It also gives the booking's coupon back** (owner decision 2026-10-16, D7):
  `releaseRedemption` deletes the `coupon_redemptions` row and decrements `coupons.used_count`
  inside the cancel's transaction — the same treatment a lapsed hold gets from `expire-holds.ts` —
  and the release is reported as `couponReleased` in the result and in the `booking.cancelled`
  audit row. It is taken last, behind the booking lock, in the same order the expiry sweep uses.
  Still no `payments` row and no change to `amount_paid_centavos`: a cancel moves no money.

## Driver portal (current state)

- **A session's lifetime is decided by its SUBJECT, in one map.**
  `SESSION_TTL_MS_BY_SUBJECT` (`server/src/services/sessions.ts`) — `driver` 12 hours,
  `user` and `customer` 24 (owner decision 2026-10-15, Q1). It replaced a single shared
  constant, and there is deliberately **no per-call `ttlMs` override**: an override that is
  forgotten produces a session that looks fine and lives too long. A fourth subject type
  cannot be added to the union without a TTL being decided for it here.
- **`driverProcedure` refuses a staff session with `UNAUTHORIZED`, never `FORBIDDEN`** — a
  staff session has no driver to be, so there is no role to forbid. And a driver asking for a
  booking that is not theirs gets **`NOT_FOUND` with the same message as a booking id that does
  not exist**. A 403 would confirm the booking exists, and over a numeric id that is a tool for
  walking the whole table towards a guest's phone number (RA 10173). Both halves are one
  `WHERE id = ? AND driver_id = ?`, never a check afterwards.
- **Every login refusal's `message` IS the reason string** (`wrong_credentials`, `locked`,
  `needs_admin_unlock`), so the login screen matches the reason rather than parsing prose.
  `wrong_credentials` is `401`; the other two are `403`. A per-driver lockout is never `429` — that
  status belongs to the per-IP limiter and the client reads it as "slow down".
  **A deactivated driver is `wrong_credentials` too** (owner decision 2026-10-16, D3): same 401, same
  body byte for byte, and the PIN hash is paid on that path as on every other, so the timing says
  nothing either. There is deliberately no `driver_inactive` reason; the real one is the
  `driver.login_inactive` row in `audit_log`, and an inactive code's attempts touch no lockout
  counter. **Known residual:** active codes lock after repeated wrong PINs and an inactive one never
  does, so a patient attacker can still tell them apart by hammering until `locked` appears
  (bounded by the per-IP limiter, 10 attempts per 15 minutes).
- **§8's third limit is 10 `driver.login` attempts per IP per 15 minutes, and the three-lockout
  escalation needs fifteen failures — so a single IP cannot reach `requires_admin_unlock` without
  the limiter firing first** (measured 2026-10-16: HTTP 429 on the 11th attempt, with the driver
  still at `lockout_count = 1`). Correct for an attacker, and the reason any walkthrough of the
  escalation has to stage the counters and say so. It also means several drivers behind one office
  NAT share that budget. **Do NOT conclude the escalation code is unreachable and delete it** — it
  is reachable across IPs (one driver's code tried from several phones or networks, which is the
  case the three-lockout rule exists for) and across windows. Both halves are tested independently,
  and neither test proves the other.
- **The three app surfaces (`/driver`, `/admin`, `/portal`) are served HTTP 200 with a title of their
  own and `noindex,nofollow`** (owner decision 2026-10-16, C2; built Task 9). They used to fall through
  to the not-found shell: `404` and `<title>Page not found | TravelSugbo</title>`, so a driver's tab
  read "Page not found" for a whole shift and an uptime monitor on `/driver` reported the portal down.
  Now `appSurfaceMeta` (`server/src/seo/resolvers.ts`) answers them: "Driver portal", "Staff console"
  and "My booking", each `| TravelSugbo`. It is called first in `resolvePage`, **pure and synchronous
  with no database read**, so these pages answer when MySQL is down and a crawler costs no query. They
  are `noindex` unconditionally, not only while `content_unverified` is set (the site-wide gate never
  runs for them). "Is this an app surface" is `isPrivatePath` from `middleware/robots-header.ts`, the
  same predicate that sets their `X-Robots-Tag`, imported rather than re-listed: it matches the whole
  first segment, so `/drivers` and `/driverfoo` still `404`, and a prefix added to
  `NOINDEX_PATH_PREFIXES` will not compile until it is given a title. **Still true:** nothing sets
  `document.title` client-side, so the title is the one injected for whatever path the SPA was first
  loaded at and it does not change as a driver navigates inside the app (sign-in to itinerary keeps
  "Driver portal"). That smaller gap is open; this change did not close it.
- **The payment box is computed on the server and the client only renders it.** Three states, and
  the payload carries no totals to re-derive them from. **Server and client now agree on
  `completed`** (owner-decided 2026-10-16, D1): `driver.trip` answers `collect_cash` there,
  `driver.recordCash` accepts the claim, and the client shows the box too — cash is the balance,
  handed over at the end of a trip, so a finished trip that still owes money still says so.
  `cancelled` and `expired` do not show it; those mean the booking should not have been driven at
  all, so money against them is an office matter. The allow-list is `COLLECTABLE_STATUSES` in
  `client/src/components/driver/PaymentBox.tsx`.
- **A driver's cash tap is a CLAIM and moves nothing.** One `pending` `payments` row with
  `collected_by_driver_id`; `bookings.amount_paid_centavos` does not change until owner or finance
  approves that same row, which credits it once under the booking lock. **One handful of cash is
  one `payments` row for its whole life** — a test asserts the absence of a second `payments`
  insert. A driver can never verify their own collection, and a dispatcher cannot verify payments
  at all. Cash is **today-only in Manila, refused by the procedure** and not merely by hiding a
  button. **A claim can also be REFUSED — "the money never arrived"** (owner decision 2026-10-16,
  D2): `admin.bookings.rejectCash` under `verifyPayments`, so owner and finance only, never a
  dispatcher and never the driver who made it. A refusal needs a reason, moves no money and touches
  **no column on `bookings`** — there is nothing to take back, because a claim credited nothing —
  and the row is kept, not deleted: `status = 'rejected'` with its `reject_reason`, `verified_by`
  still NULL (a refuser is not a verifier; they are in the audit row instead). It is not the receipt
  rejection's shape: no guest email, no re-upload deadline. The consequence to know is that the
  driver's payment box reads `status = 'pending'` only, so refusing the row returns it to
  `collect_cash` and **the driver can claim again** — which is the point when the first tap was a
  mistake, and the reason one mistaken tap no longer blocks a booking's cash collection for good.
  The refused row stays exactly where it is as the record of what was claimed and refused.
- **One `trip_checkpoints` row per stop, arbitrated by the unique index on
  `(booking_id, stop_key)`.** A double tap is `already_checked_in` — a shrug, not an error and not
  a second row. An undo **marks** (`undone`, `undone_at`, `undone_by = the driver`) and never
  deletes, takes a required reason into the audit row, and reverses exactly one event — a
  completion if the trip is `completed`, otherwise the most recent standing check-in. Re-recording
  a stop **reactivates its existing row** rather than inserting a second (owner decision Q5): the
  index is what makes the double tap safe and must not be weakened to allow a re-tap.
- **A `booking_notes` row is office-only unless the office says otherwise** (owner decision
  2026-10-16, D6). `booking_notes.visible_to_driver` is `NOT NULL DEFAULT 0` in the database, not
  only in Drizzle, so a note written by anything that forgets the flag (a seed, a hand-written
  INSERT) is private. `driver.trip` filters on it **in the SQL `WHERE`**, not in JS, so a note the
  driver may not read never reaches the browser; its `officeNotes` payload is still `string[]`,
  oldest first. The driver is deliberately **not** told that office-only notes exist. The admin
  states the decision per note: `admin.bookings.addNote` (`adminProcedure('bookingsView')`, so
  owner, dispatcher and finance) takes a **required** `visibleToDriver` boolean with no default,
  and is the **only writer of this table**, since nothing wrote it before. It audits
  `booking.note_added` on entity `bookings` with `{noteId, visibleToDriver}` and never the note
  text. `admin.bookings.detail` returns every note with its flag, and the detail screen says
  "Driver can see this" or "Office only" in words beside each. Migration `0012` adds the column.
- **Deactivating a driver ends their sessions** (owner decision 2026-10-16, D4).
  `admin.drivers.setActive` — an `adminProcedure('vansDrivers')`, so owner and dispatcher — writes
  `is_active` and DELETES every `sessions` row for that driver (`revokeSessionsForSubject`) in the
  **same transaction**, then audits `driver.deactivated` / `driver.reactivated` with the count
  revoked. `requireDriver` still reads the session and never re-reads `drivers.is_active`, and that
  is now sufficient rather than a gap: a deactivated driver's very next request is `UNAUTHORIZED`
  (measured over HTTP in `driver-deactivation.test.ts`). Reactivating revokes nothing and does not
  bring old sessions back — the driver signs in again. **The invariant is "the mutation revokes", not
  "an inactive driver cannot be authenticated":** a driver switched off by a direct `UPDATE drivers`
  in SQL, bypassing the mutation, keeps their session until it expires (12 hours). `sessions.subject_id`
  is polymorphic, so the revoke keys on type AND id — `drivers.id = 7` and `users.id = 7` are
  different subjects. `drivers.update` deliberately cannot change `is_active`; only `setActive` can.
- **A deactivated driver's future trips need assigning again.** Deactivation does NOT clear
  `bookings.driver_id` (the id is the record of who was assigned). The §9 `unassignedSoon` alert
  reads the driver instead: its status filter is `confirmed` **and** `assigned` (assignment moves a
  booking to `assigned`, so `confirmed` alone could never see it), it `LEFT JOIN`s `drivers` (an
  inner join would drop every booking with a null `driver_id`, the alert's original case), and it
  counts a trip whose driver is inactive as well as one missing a van or a driver. Widening the
  status adds no count on a healthy fleet — an `assigned` booking has both ids by construction —
  and a test pins that. Residue: the alert's window is 48 hours of tour days, so a deactivated
  driver's trip further out surfaces as its date approaches rather than immediately. That is the
  alert's existing design, not a new gap.

## Security

- HTTPS only; HSTS; secure, httpOnly, sameSite=lax cookies.
- Malformed request URLs (e.g. `/trpc/%zz`) return a plain 400, never a 500 with a stack
  trace (`server/src/middleware/malformed-url.ts`).
- CSRF protection on state-changing requests (sameSite + origin check).
- Rate limits on logins, coupon checks, review submissions, inquiry forms, helpful votes.
- Uploads: validate MIME + extension + size, rename to random IDs, store outside the web
  root, serve via an authenticated route.
- PayMongo secret key and webhook secret only in `.env`, never in client code.
- Role middleware on every admin procedure, plus a test per role per area.
- Data Privacy Act (RA 10173): consent checkbox at checkout, privacy notice page,
  admin-only access to personal data.

## Unrelated bugs

Found a bug outside the current task? Do not stop and do not fix it. Finish the task,
then list it (name + one-line description) and wait for instructions.
Exception: flag immediately if it blocks the current task.

## When in doubt — stop and ask

Stop and ask before changing anything if a task touches payments, refunds, auth, roles, or
the schema in a way the spec does not describe; if the spec is ambiguous; if a fix would
change a feature that already works; or if you would need a new dependency or service.
