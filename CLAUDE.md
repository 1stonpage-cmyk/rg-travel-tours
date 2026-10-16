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
- **The seed ships no `tour_itinerary_stops` — all six tours have zero.** So on a fresh clone the
  driver's itinerary screen shows "Start trip" and nothing else, and the departures board reads
  `0/1` for every trip. 6C is built and tested; it is simply undemonstrable against seed content
  until stops exist, and 7F's editing screens do not cover them either.
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
- **KNOWN GAP: nothing sweeps a van left `on_trip` by a trip nobody ever completed.** A driver
  whose phone dies at the last stop, or who simply forgets, leaves that van unsellable
  indefinitely — and the symptom arrives weeks later as "we're fully booked" on a day with idle
  vans, with nothing in the logs. The only cures today are the driver completing the trip and a
  hand-written `UPDATE vans`. Two candidate fixes are on the table, and both need an owner
  decision because both are new surface area: a `node-cron` job that frees a van whose booking is
  still `in_progress` past its tour date (a new scheduled job is a new failure mode), or a
  dispatcher-facing "force complete" on the §9 booking detail, audited like any other status
  change (no scheduler, but somebody has to notice first). Until one is built the gap is pinned by
  the last test in `trip-van-status.test.ts` — building the sweep reddens that test, and whoever
  does should replace it with the sweep's own proof rather than loosen it.
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
  going to happen now.

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
  `needs_admin_unlock`, `driver_inactive`), so the login screen matches the reason rather than
  parsing prose. `wrong_credentials` is `401`; the other three are `403`. A per-driver lockout is
  never `429` — that status belongs to the per-IP limiter and the client reads it as "slow down".
- **§8's third limit is 10 `driver.login` attempts per IP per 15 minutes, and the three-lockout
  escalation needs fifteen failures — so a single IP cannot reach `requires_admin_unlock` without
  the limiter firing first** (measured 2026-10-16: HTTP 429 on the 11th attempt, with the driver
  still at `lockout_count = 1`). Correct for an attacker, and the reason any walkthrough of the
  escalation has to stage the counters and say so. It also means several drivers behind one office
  NAT share that budget. **Do NOT conclude the escalation code is unreachable and delete it** — it
  is reachable across IPs (one driver's code tried from several phones or networks, which is the
  case the three-lockout rule exists for) and across windows. Both halves are tested independently,
  and neither test proves the other.
- **Every app-surface route is served HTTP 404 with the "Page not found" title.** `resolvePage`
  (`server/src/seo/resolvers.ts`) has no case for `/driver`, `/admin` or `/portal`, so they get the
  not-found shell: `/driver/login` and `/driver/trip/:id` answer `404` with
  `<title>Page not found | TravelSugbo</title>`, indistinguishable from a junk URL (measured
  2026-10-16 in dev; `html.ts` shares the resolver, so production matches). **The SPA boots and
  renders correctly anyway** — a browser renders a 404 body — so this is cosmetic and operational
  rather than broken: nothing client-side sets `document.title`, so a driver's tab reads "Page not
  found" for their whole shift, and an uptime monitor pointed at `/driver` reports the portal down.
  These routes should be `noindex` (they already carry an `X-Robots-Tag`); `noindex` and `404` are
  not the same statement.
- **The payment box is computed on the server and the client only renders it.** Three states, and
  the payload carries no totals to re-derive them from. **It is NOT suppressed for a `completed`
  trip:** `driver.trip` still answers `collect_cash` there and `driver.recordCash` still accepts
  it — the box is hidden for `completed` by the client alone (measured 2026-10-16). That asymmetry
  is an open owner decision, not a settled design; do not "fix" either side without the answer.
- **A driver's cash tap is a CLAIM and moves nothing.** One `pending` `payments` row with
  `collected_by_driver_id`; `bookings.amount_paid_centavos` does not change until owner or finance
  approves that same row, which credits it once under the booking lock. **One handful of cash is
  one `payments` row for its whole life** — a test asserts the absence of a second `payments`
  insert. A driver can never verify their own collection, and a dispatcher cannot verify payments
  at all. Cash is **today-only in Manila, refused by the procedure** and not merely by hiding a
  button. There is no reject path for a cash claim yet.
- **One `trip_checkpoints` row per stop, arbitrated by the unique index on
  `(booking_id, stop_key)`.** A double tap is `already_checked_in` — a shrug, not an error and not
  a second row. An undo **marks** (`undone`, `undone_at`, `undone_by = the driver`) and never
  deletes, takes a required reason into the audit row, and reverses exactly one event — a
  completion if the trip is `completed`, otherwise the most recent standing check-in. Re-recording
  a stop **reactivates its existing row** rather than inserting a second (owner decision Q5): the
  index is what makes the double tap safe and must not be weakened to allow a re-tap.
- **`booking_notes` text is fully visible to drivers.** `driver.trip` returns every note on the
  trip, text only, oldest first. There is no visibility column, so there is no such thing as an
  office-eyes-only note today. Open owner decision.
- **`requireDriver` reads the session and never re-reads `drivers.is_active`**, and `readSession`'s
  live-role join is on `users` only — so **a driver deactivated mid-shift keeps up to 12 hours of
  access** (measured 2026-10-16: `is_active = 0`, same cookie, `driver.trips` still 200). Staff
  deactivation IS immediate, by contrast. The asymmetry is deliberate-by-default and an open owner
  decision, not an invariant to build on.

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
