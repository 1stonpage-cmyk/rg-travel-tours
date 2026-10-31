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

| Command                                 | Does                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @rg/server db:generate`  | Write a migration from `src/db/schema.ts`                                                                                       |
| `pnpm --filter @rg/server db:migrate`   | Apply migrations to `rg_travel` (name preflight)                                                                                |
| `pnpm --filter @rg/server db:seed`      | BASE: owner, destinations, settings — insert-only, safe on prod                                                                 |
| `pnpm --filter @rg/server db:seed:demo` | DEMO: tours, packages, reviews, (app db) fleet — dev-only, upserts; needs `ALLOW_DEMO_SEED=1` and refuses `NODE_ENV=production` |

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
  src/jobs                                                   (5 registered: expire-holds, prune-sessions,
                                                              orphaned-vans, review-requests, trip-reminders)
  src/routers/webhooks                                       (built)
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
`pnpm --filter @rg/server db:seed` (owner, destinations, settings) followed by
`pnpm --filter @rg/server db:seed:demo` (tours, packages, reviews, fleet) — both from
`server/src/db/seed-data.ts`.

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
- **`db:seed` is BASE, insert-only forever; `db:seed:demo` is DEMO, dev-only, and still
  overwrites.** (Owner-reported incident 2026-10-28; A2 fix `212d200`; split into base/demo,
  BUG-118, Task B2.) The original incident: a re-seed against `rg_travel` wiped a hand-entered
  `payment_qr` block back to its seed defaults — real configuration, gone, from a command the
  launch checklist used to call safe. A2 made `settings` insert-only (`insertSettingIfMissing`);
  the identical overwrite shape was still live in five more tables (`tours`/`tour_price_tiers`
  — money, and failing **open** — `tour_images`, `packages`, `reviews`, the fleet) until Task B2
  split `seed(context)` into two halves with opposite re-run contracts:
  - **`seedBase(context)`** — the first owner, destinations (`insertDestinationIfMissing`,
    mirroring `insertSettingIfMissing`), settings. **Insert-only on every table it touches, and
    safe to re-run against production at any time.** This is what `pnpm --filter @rg/server
db:seed` now runs.
  - **`seedDemo(context)`** — tours (incl. `tour_price_tiers` and images), packages, reviews,
    and (app-database only) the fleet and itinerary stops. **Unchanged upsert behaviour** — this
    is dev/demo content, and staying overwritable on a dev box is the point. Guards its own
    database name independently of `seedBase`'s own guard call (refuses anything but
    `rg_travel`/`rg_travel_test`) — **but that guard is not what keeps it off production**:
    production's own database is named `rg_travel` too (`APP_DATABASE_NAME`), so the guard waves a
    production run straight through. It only catches a genuinely FOREIGN database (Kong PMS's,
    say, or a `DATABASE_URL` typo). This is the new, separate `pnpm --filter @rg/server
db:seed:demo`.
    **Task C2 added the real guard**, ahead of the database-name check and before any write:
    `seedDemo` now also refuses unless `env.ALLOW_DEMO_SEED === '1'` (a deliberate opt-in; unset,
    empty or any other value refuses) AND `env.NODE_ENV !== 'production'` — two independent
    checks, each with its own message naming which one failed, both enforced regardless of
    `context`. `ALLOW_DEMO_SEED` is in `.env.example` (commented "dev only — never set on the
    server") and in `server/src/env.ts`'s schema (optional, no default, mirroring
    `OWNER_EMAIL`/`OWNER_PASSWORD`). The test suite's `seed('test')` callers (17+ files, via
    `global-setup.ts`) need `ALLOW_DEMO_SEED=1` too — `env.ts` parses `process.env` once at
    import time, so setting it any later (inside `global-setup.ts`'s own function body, for
    instance) would be too late. **Vitest's `test.env` option alone does NOT reach
    `global-setup.ts`**: `test.env` is only applied inside each test file's own worker (Vitest's
    `setupCommonEnv()`), and `globalSetup` runs earlier, in Vitest's main process, before any
    worker exists — proven by setting only `test.env` and watching the suite fail with this
    exact refusal, thrown from inside `global-setup.ts`. What actually protects it is a
    top-level `process.env.ALLOW_DEMO_SEED ??= '1';` statement in `server/vitest.config.ts`
    itself, outside `defineConfig`, which runs at config-load time in that same main process —
    before `global-setup.ts`'s static `import { env } from '../env'` ever executes — and whose
    value every later-spawned worker also inherits. `test.env` is kept alongside it as the
    documented, worker-scoped channel: it is what a test file that calls `seed('test')` or
    `seedDemo('test')` directly, inside its own worker, is actually relying on; it is not what
    protects `globalSetup`. Their `NODE_ENV` is already `'test'`, so the production check needed
    no loosening for them.

  `seed(context)` itself is `await seedBase(context); await seedDemo(context);` — unchanged
  externally, so every existing caller (test files, `global-setup.ts`, `helpers/test-db.ts`)
  keeps working without modification. All six tables that used to share one overwrite shape now
  key on the same **admin-editable natural keys** (slug, plate, code) they always did, but only
  `seedDemo`'s five are still upserted by them — know which command you are running before you
  run it against anything but a dev box.

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
- `/sitemap.xml` and `/robots.txt` are generated from the database per request, and `lastmod` is
  read from `updated_at`, never invented.
- **A sitemap must never list a URL whose OWN RESOLVER says `noindex`** — the per-route decision,
  not the site-wide gate. The distinction is load-bearing and this sentence used to be written as
  a flat absolute, which is **literally false today** (measured 2026-10-30: 15 URLs listed while
  every one of them is served `noindex`). While `settings.content_unverified` is true the
  site-wide gate noindexes every route and `robots.txt` answers `Disallow: /`, which is what keeps
  the sitemap unreachable rather than contradictory. The guard test
  (`sitemap-robots.test.ts`, "lists no URL that says noindex") **clears the flag first on
  purpose**, because the site-wide gate would otherwise make it pass no matter what each resolver
  asked for. So: when you release a detail route from `noindex`, add it to the sitemap in the same
  task — and do not "fix" the sitemap by filtering on `content_unverified`, which would empty it
  and prove nothing.
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
  `db:seed:demo` puts vans, drivers and demo bookings in `rg_travel` only (`seedDemo(context)`
  gates on `'app'`). Do not loosen that assertion to fit a seed.
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
- **Every login refusal's `message` IS the reason string** (`wrong_credentials`, `locked`), so the
  login screen matches the reason rather than parsing prose.
  `wrong_credentials` is `401`; `locked` is `403`. A per-driver lockout is never `429` — that
  status belongs to the per-IP limiter and the client reads it as "slow down". There were three
  refusals until 2026-10-23; `needs_admin_unlock` went with the terminal lockout (see below), and
  it is gone from `DriverLoginRefusal` rather than left as a member no path returns.
  **A refused login's body is the bare reason string and nothing else**, and the backoff did not
  change that: the tier, the banked lockout count and the exact `locked_until` instant are all
  known to the server and **none of them is in the response**. Each would tell someone probing a
  code how much pressure they have already applied, and a driver can act on none of them beyond
  "try again later".
  **A deactivated driver is `wrong_credentials` too** (owner decision 2026-10-16, D3): same 401, same
  body byte for byte, and the PIN hash is paid on that path as on every other, so the timing says
  nothing either. There is deliberately no `driver_inactive` reason; the real one is the
  `driver.login_inactive` row in `audit_log`, and an inactive code's attempts touch no lockout
  counter. **Known residual:** active codes lock after repeated wrong PINs and an inactive one never
  does, so a patient attacker can still tell them apart by hammering until `locked` appears
  (bounded by the per-IP limiter, 10 attempts per 15 minutes).
- **The PIN lockout BACKS OFF and is never terminal** (owner decision 2026-10-23, Q1, option C+E),
  **superseding the terminal escalation that stood here from 2026-10-11 Q9 and was defended as
  deliberate on 2026-10-16.** Five consecutive wrong PINs still lock a driver; what changed is what
  the 24-hour window's `lockout_count` is FOR. It now picks the LENGTH from
  `LOCKOUT_SCHEDULE_MINUTES` (`server/src/services/driver-lockout.ts`) — 15 minutes, then 30, then
  **60 for the third and every one after, capped there** — instead of ending the policy at three.
  `MAX_LOCKOUTS_PER_WINDOW`, the `LockoutState.requiresAdminUnlock` field, the
  `LockoutOutcome` member `'needs_admin_unlock'` and the audit action `driver.unlock_required` are
  all **removed from the types**, not set to false: a type that cannot express the terminal state is
  the proof it is gone, and `attemptDriverLogin`'s exhaustive `switch` plus `asTrpcError`'s mean a
  reintroduction cannot compile quietly. `requires_admin_unlock` survives as a **column nothing
  reads** (no migration was taken); the login path writes `false` to it on every attempt as a
  cleanup, and `resetPin` still zeroes it.
  **Why it was superseded, which matters more than that it was.** The old rule's argument was that a
  policy an attacker can reset by eventually guessing right is not a policy — true, and it made the
  control a better weapon than a defence. A driver code is short, printed inside the van and shared
  with guests on a manifest, so **anyone at all could spend fifteen wrong PINs and park a driver out
  of the portal** until a dispatcher was awake to reset their PIN; a 5am pickup is exactly when none
  is. The backoff keeps the guessing cost (130 attempts per 24 hours against one code, computed from
  the policy by a test, before the per-IP limit is even consulted) while leaving the driver a way
  back in that needs no human. **Do not reintroduce a terminal state, an uncapped backoff, or a
  lockout longer than the last tier without a new owner decision** — an unbounded backoff is the
  terminal state again wearing a clock.
- **`admin.drivers.unlock` is the office's shortcut, and it never touches the PIN**
  (same decision). `adminProcedure('vansDrivers')` — owner and dispatcher, the same area `resetPin`
  uses. It clears `failed_attempts` and `locked_until` **only**: `lockout_count` and
  `lockout_window_started_at` are left standing, so the driver's next lockout today keeps its place
  in the schedule — an admin intervening is not the same event as a correct PIN, and clearing the
  count would hand an attacker a free reset for every helpful dispatcher. It **refuses with
  `BAD_REQUEST` when the driver is not currently locked** (null or past `locked_until`) rather than
  succeeding quietly, takes the row lock, and audits `driver.unlocked` with the lockout it lifted,
  the count it left and `pinReset: false` — never a PIN or a hash. `resetPin` still does both halves,
  for the case it was written for: a PIN nobody can remember.
  A seventh dashboard alert, **`driver_locked`** (`driverLocked` in
  `server/src/services/dispatch/alerts.ts`: an active driver whose `locked_until` is in the future,
  relative to the dashboard's `now`), puts a locked driver in front of the office instead of waiting
  for them to ring — and links to `/admin/drivers`. **Still manual, and deliberately:** nothing
  unlocks a driver automatically, because the clock already does that.
  **The UI caller landed in Task 5b** (owner decision 2026-10-24), closing the gap this entry used
  to record: `/admin/drivers` now carries an **Unlock** button beside Reset PIN, with the same inline
  two-step confirm, shown only while that row is locked. What the row carries is
  `DriverRow.isLockedOut` — a **boolean the server derives** in `admin.drivers.list` against the one
  `now` the request reads, mirroring the alert's own question — and **never `locked_until` itself**:
  the browser compares no clocks, and no unlock time, tier or attempt count is on the wire for any
  surface. `unlock`'s row lock also filters on `is_active` now, so an inactive driver's id is refused
  with the **same `NOT_FOUND` message an unissued id gets** (a distinguishable refusal would make a
  numeric id an oracle for which drivers exist). And the driver sign-in screen's `locked` sentence
  stopped naming a duration in the same change: "15 minutes, longer if it keeps happening today" was
  the first tier quoted at a driver who might be on their third, so the copy now says waiting works
  and points at the office, which finally has a button behind it.
- **§8's third limit is 10 `driver.login` attempts per IP per 15 minutes, which is fewer than the
  fifteen counted failures three lockouts cost — so a single IP cannot reach the third backoff tier
  inside one limiter window without the limiter firing first** (measured 2026-10-16 and pinned:
  HTTP 429 on the 11th attempt, with the driver still at `lockout_count = 1`). Correct for an
  attacker, and the reason any walkthrough of the backoff has to stage the counters or move the clock
  and say so. It also means several drivers behind one office NAT share that budget. **Do NOT
  conclude the later tiers are unreachable and flatten the schedule** — they are reachable across IPs
  (one driver's code tried from several phones or networks) and across windows (a patient single IP
  that waits out each lockout never trips the limiter at all). That is tested, not reasoned, in the
  C7 block of `server/src/__tests__/driver-lockout.test.ts`, three tests that each own one layer:
  **one IP** through the real limiter gets ten attempts and a 429 on the eleventh, the driver locked
  exactly once; **three IPs** through the same limiter send fifteen attempts with no 429, because
  each address has its own budget; and `attemptDriverLogin` driven directly with an advancing `now`
  lengthens `locked_until` 15 → 30 → 60 minutes in the column and then **lets the driver in with
  their own PIN**. No single test claims both halves, because a request cannot inject `now` and a
  locked driver's attempts count toward nothing; the clock is why the backoff test has no IP.
  **Deployment dependency:** the per-IP limit is only per-IP when
  `trust proxy` is set (`docs/LAUNCH_CHECKLIST.md` carries it as a launch item; `app.ts` does not set
  it), and without it all three limits collapse onto one key — measured by removing it from the test
  app: the three-IP test fails with 429s, so one attacker could lock every driver's login out of
  one window.
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

## Checkout & payments (current state)

- **A booking ref is CASE-INSENSITIVE on lookup and normalised to uppercase on the server; refs
  are still GENERATED uppercase** (owner decision 2026-10-23, Q10; BUG-108). The normalisation
  (trim, then uppercase) is folded into `bookingRefSchema` itself via `.transform().pipe()`, so it
  runs **before** the shape check rather than after, and all three procedures that take a ref
  (`bookingLookupInput`, `startPaymentInput`, `bookingStatusInput`) share that **one** schema.
  Nothing about `generateBookingRef()` changed. The point is that this used to work on one
  procedure only, and only because `bookings.ref`'s `_ci_` collation matched case-insensitively on
  its own — a guarantee nothing asserted. **Do not add a second ref schema, and do not lean on the
  collation again** (BUG-107 is the same shape on `coupons.code`).
- **An online charge below the gateway's ₱100 minimum is refused at HOLD time, before any write**
  (`PAYMONGO_MIN_CENTAVOS` in `shared/src/money.ts`; BUG-110). It is taken in `createHold()`'s
  money step, not at the gateway call, because **a hold that can never be paid has already taken a
  slot** — and a refusal therefore leaves no booking, no slot and nothing for the expiry sweep
  (measured 2026-10-30, including the absence of the `tour_date_slots` row). `startPayment`
  repeats it defensively for a booking the hold check never saw.
- **The guest sentence for that refusal branches three ways on the booking's TOTAL, and the total
  is the only number that can decide it** — `gatewayMinimumMessage()` in `shared/src/checkout.ts`
  is the one chooser, called by both refusing surfaces, so neither can offer an alternative that
  does not exist. Total at or above the floor → name pay-in-full, which genuinely works. Total
  below the floor but above zero → **do not** name pay-in-full; that is the same refusal again.
  Total of nothing (a 100%-off coupon) → name no payment method at all, because there is no
  amount. All three measured guest-side. **Owner decision 2026-10-30: a ₱0 booking is always
  refused, never confirmed with no payment step.** It is enforced in two places now — at hold time
  (`createHold()`, as above) and in the public `checkout.quote` preview the checkout UI calls
  before the guest ever submits: `quote` throws the same `BAD_REQUEST` /
  `gatewayMinimumMessage()` refusal the instant its own computed `totalCentavos` is `<= 0`, rather
  than handing the browser a successful ₱0 quote it would only be refused on at hold time.
- **Whether "Pay now" may be offered is the SERVER's decision, published as one boolean.**
  `onlinePaymentEnabled` on the settings payload is `paymongoConfigured && at least one enabled
payment method`; the payload deliberately carries **neither ingredient**, so the browser cannot
  re-derive or disagree. Checkout and the booking-status retry page both render one shared
  `<PaymentOptions>` with three states — online available / manual only / neither — and copy
  outside that component must stay **state-neutral**: the hold sentence says "arrange that", never
  "pay now", because it is rendered in all three states.
  **BUG-117, fixed: `checkout.startPayment` now enforces both halves.** It used to enforce only
  the PayMongo-configured half — it never read `settings.payment_methods`, so with PayMongo
  configured and every method switched off, a stale tab, a back-button return or a direct tRPC
  call still created a real checkout session. It now reads the same `payment_methods` block via
  `readSettingBlock('payment_methods')` and refuses with the existing `gatewayUnavailable()`
  guest-safe `SERVICE_UNAVAILABLE` sentence when `resolvePaymentMethods(block).length === 0` —
  the same function `onlinePaymentEnabled` itself calls, so the two can never disagree about
  "enabled". It deliberately does not cross-reference individual method keys against
  `CHECKOUT_PAYMENT_METHODS` (their vocabularies don't match 1:1); it matches `onlinePaymentEnabled`'s
  own formula exactly — zero enabled methods, full stop.
- **A gateway outage keeps the server's own guest-safe sentence.** A `SERVICE_UNAVAILABLE` from
  the payment path is passed through, not swallowed by the generic "something went wrong" — the
  guest is told online payment is unavailable and offered another way. Any new raiser of
  `SERVICE_UNAVAILABLE` on a guest path inherits that and must therefore carry a guest-safe
  message.
- **No form, public or admin, may show raw Zod JSON.** The server's `errorFormatter` already
  publishes structured `error.data.zodError`; the client reads it through the one shared helper
  `client/src/lib/field-errors.ts` and places each message beside its own field via
  `aria-describedby`. **Any new form with a multi-field Zod input uses that helper rather than
  rendering `error.message`** — and note that the trap this rule exists for was a **query**, not a
  mutation (the coupon field), so sweep both. `createHoldInput.lead` is nested, and the input shape
  itself stays that way — a prior review ruled it correct, so do not flatten it. **BUG-120 (fixed,
  Task B6, pre-launch fixes batch):** a bad phone no longer marks name/email invalid too. The
  `errorFormatter` now also publishes a dot-path `nestedFieldErrors` map (`'lead.phone'`) alongside
  the unchanged top-level `fieldErrors`; `field-errors.ts`'s `getNestedFieldError(error, path)`
  reads the leaf message when the map is present and falls back to the parent's grouped message
  only when the whole map is absent — never when one path is merely missing from a present map,
  which would silently reintroduce the same cross-field bug one layer down.

## Notifications (current state)

- **Email only. No SMS** (owner decision 2026-10-23, Q6, answering the spec's own overdue §15
  question). The SMS provider interface exists behind `SMS_ENABLED` and is off by default, so
  turning it on is configuration rather than a build.
- **`notify()` can never throw**, template rendering included — a notification failure must not
  roll back the thing it was reporting. Sends happen **after** the commit.
- **Five jobs are registered**, each with its own `schedule()` call and its zone passed
  explicitly, pinned by `jobs-registration.test.ts`: `expire-holds` every minute,
  `prune-sessions` 03:30, `orphaned-vans` 07:00, `review-requests` 07:00, `trip-reminders` 16:00,
  the last four Asia/Manila. The two staff-facing sweeps sit at 07:00 and the one guest-facing
  reminder at 16:00, deliberately. A sixth job needs its own file and its own registration, not
  logic folded into a neighbour (owner Q5).
- **A reminder is sent once and a review request at most once EVER**, both claimed by an
  `audit_log` row written **before** the send (`hasAuditRow`). `review-requests` uses a **7-day
  lookback rather than "yesterday only"**, deliberately: a one-day window would make
  "at most once ever" pass vacuously, since yesterday's booking falls out of range today whether
  the audit row fired or not. It is self-healing against a missed run, and its one cost is a
  first-run burst on whatever system first deploys it — a launch-day backfill note, not a cap.

## Admin & content editing (current state)

- **A settings write validates BEFORE it opens a transaction, so a refusal provably writes
  nothing and audits nothing**, and `resetContentUnverifiedCache()` fires **after** commit so the
  noindex gate is never stale against the flag that was just saved. `admin.settings.all` reads the
  raw rows rather than the throwing `readSettings()` — the one screen that can repair a broken
  block has to stay loadable. Owner-only (`usersSettings`). The audit row carries `{key}` only.
- **The reports' money predicates are the week's most quotable rule, and they are split by
  figure** (owner decision 2026-10-23, Q7). Money received and refunds bucket by the
  payment/refund row's own `created_at` in **Manila**; bookings and still-to-collect bucket by
  **`tour_date`**. **A refund does not reduce "still to collect"** — it reduces net received —
  and the still-to-collect statement never references the `payments` table at all. One shared
  `REPORT_NON_COLLECTABLE_STATUSES` feeds both spellings of the cancelled/expired list.
- **Every CSV cell that can contain guest-entered or content-entered text goes through
  `csvText()`** (`server/src/services/reports/csv.ts`), which neutralises a leading `=+-@`, TAB
  and CR so a spreadsheet cannot parse a guest's name as a formula. Applied to the text cells
  only, never near a money cell — a negative figure must stay a number. It composes with
  `csvField`'s RFC-4180 quoting; both escapes apply.
- **Only owner and finance may read a receipt** (owner decision 2026-10-23, Q2). A dispatcher gets
  the **same `404` a stranger gets** — asserted byte-identical in status, body and raw text —
  because a `403` would confirm the receipt exists. Gated on `ROLE_MATRIX.verifyPayments`, and
  both client links read the page's existing `mayVerify` rather than a hand-listed role array.
- **A submitted review is never published.** Submission is the **existing** `portal.submitReview`
  (there is deliberately no second public submit path); a submission is `pending` and invisible to
  `reviews.published`. **One browser, one helpful vote** — the composite primary key on
  `review_helpful_votes` _is_ the rule, arbitrated by an anonymous voter cookie distinct from the
  session cookie, and the raw IP and cookie id are never stored, only a hash. The verified badge
  is derived from `bookingId !== null` and **the booking id reaches neither the public nor the
  moderation wire** (RA 10173). A driver's rating comes through
  `reviews.booking_id → bookings.driver_id` against the existing `settings.trust.minReviewsForRating`
  — not a second constant (owner Q4) — and is admin-only, never shown to a guest.
- **`coupons.used_count` is not writable through any admin input**, and `coupon_redemptions` is
  append-only: `recordRedemption` / `releaseRedemption` are its only writers. A full-replacement
  `admin.coupons.update` is safe against rewriting money a guest was already charged **because the
  booking carries its own `price_snapshot`** — that is what makes it safe, so do not remove the
  snapshot to "simplify".
- **A tour, package, van, driver or coupon is deactivated, never deleted — and neither are a
  tour's children.** A dropped add-on is set `isActive: false` (`booking_addons` references it),
  and an itinerary stop with real `trip_checkpoints` history **refuses removal** with a `CONFLICT`
  naming the stop, so the whole mutation writes nothing rather than dying on a foreign key.
  **Two price tiers can never both match a party size:** overlapping tiers are refused and nothing
  is written.
- **§9's role table in `docs/BUILD_SPEC.md` is PARSED BY A TEST.** `role-isolation.test.ts` reads
  that markdown table and pins the exact area / allowed / denied counts (12 areas, 23 allowed, 13
  denied as of `packagesInquiries`). So adding a `ROLE_MATRIX` area means editing the spec's table,
  the area-label mapping **and** the counts in one commit — the matrix and the spec cannot drift
  apart quietly, by design.
- **The staff name is display only.** It rides on the session's own live join, and **never drives
  an access decision** — `navFor()` still takes the role string, pinned by a test that reddens if
  the name is passed instead.

## Security

- HTTPS only; HSTS; secure, httpOnly, sameSite=lax cookies.
- Malformed request URLs (e.g. `/trpc/%zz`) return a plain 400, never a 500 with a stack
  trace (`server/src/middleware/malformed-url.ts`).
- CSRF protection on state-changing requests (sameSite + origin check). The origin check sits
  **outside** the session gate: a mutation with no `Origin`, or a foreign one, is `403`'d before
  anything looks for a cookie, so a cross-origin attempt never reaches the role layer (measured
  2026-10-30).
- **Session isolation between the three surfaces now exists** (BUG-119, fixed Pre-launch Task B5).
  `server/src/middleware/session-cookie.ts` issues one cookie PER SURFACE —
  `SESSION_COOKIE_BY_SUBJECT`: `rg_admin_session`, `rg_driver_session`, `rg_customer_session`, same
  flags on all three — so a guest signing into My Booking no longer overwrites a live staff
  session, and a browser can legitimately hold all three at once. `context.ts` resolves three
  independent fields accordingly — `ctx.adminSession`, `ctx.driverSession`, `ctx.customerSession`
  — each from its own cookie and kept only if it resolves to that surface's own subject type;
  `requireRole` / `requireDriver` / `requireCustomer` each read only their own field. The two
  standalone Express routes that read a session cookie directly (`/api/receipts/:name`,
  `/api/payment-qr`) read the same map by name — both read BOTH the customer and the staff cookie,
  because both are genuinely dual-surface (a guest reads their own file; owner/finance read either
  for verification), not single-surface as first assumed. **This was never a privilege
  escalation** even before the fix — each session row always carried its own subject type and the
  gates always read that, so the evicted user was signed out, not impersonated — but it is the
  reason a browser check of one surface used to destroy the session held on another, which no
  longer happens.
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
