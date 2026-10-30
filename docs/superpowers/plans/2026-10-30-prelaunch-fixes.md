# Pre-launch fixes batch (B1–B7) — 2026-10-30

Spec: `docs/BUILD_SPEC.md` (wins any disagreement with this plan). Standing
conventions: `CLAUDE.md`. Bug tracker: `docs/BUGS_LOG.md`.

## Follow-up owner answers, 2026-10-31 (tasks C1–C3)

Answering the three QUESTIONS the B1–B7 batch's final report raised:

1. **The ₱0.01–₱99.99 `quote`/`createHold` asymmetry:** keep it simple and
   consistent with the ₱0 fix (Task B4) rather than building the
   manual-transfer-aware branch first proposed — `checkout.quote` refuses a
   total below the ₱100 gateway minimum exactly the way `createHold` already
   does, with a friendly guest message. `createHold` and `PaymentOptions`
   are **not** touched; this is a `quote`-only extension of B4's existing
   `totalCentavos <= 0` guard to `totalCentavos < PAYMONGO_MIN_CENTAVOS`.
   (An earlier draft of this answer considered letting a below-floor total
   through when manual transfer is configured — the owner rejected that in
   favour of the simpler, already-proven-in-createHold shape.) Own reviewer
   subagent on opus.
2. **`db:seed:demo`'s production safety net:** YES — add a real technical
   guard. `db:seed:demo` must refuse unless `ALLOW_DEMO_SEED=1` is set AND
   `NODE_ENV` is not `"production"` (both checks, abort with a clear
   message naming which one failed). Add `ALLOW_DEMO_SEED` to
   `.env.example`, empty, with the comment "dev only — never set on the
   server". Each refusal path gets its own test, proven able to fail.
3. **README.md / .env.example staleness:** YES — update both to match the
   base/demo seed split (Task B2), including documenting `ALLOW_DEMO_SEED`
   from answer 2 above.

Global Constraints from the original batch (below) still bind all three
tasks. Additional constraint for this follow-up: do not touch
production/the VPS or Kong PMS; no new npm/yarn dependencies; no red.

---

Owner answers the original B1–B7 batch acted on (logged here per the
prompt's instruction):

1. BUG-118: after launch the ADMIN owns all content. Split `db:seed` into
   (a) BASE — settings defaults, destinations, first owner from
   `OWNER_EMAIL`/`OWNER_PASSWORD` — insert-only, never overwrites an existing
   row; (b) DEMO — sample tours, price tiers, images, packages, reviews,
   fleet, drivers — dev only, and it refuses to run unless the connected
   database is `rg_travel` or `rg_travel_test` (abort with a clear message
   otherwise). Launch blocker.
2. BUG-117: YES — `startPayment` must refuse on the server when every online
   payment method is disabled, not just the UI.
3. ₱0 bookings: NO. Refuse (server-side, at hold time and in coupon
   validation/preview) any coupon that brings the amount due to ₱0, with a
   friendly guest message.
4. BUG-119 (A9): YES — split the shared session cookie into one per surface
   (admin, driver, customer). No schema change. Existing sessions may be
   invalidated once.
5. Add `.claude/settings.local.json` to `.prettierignore` (owner-approved,
   local harness file).

## Global Constraints (hand verbatim to every reviewer)

- Money: integers in centavos everywhere; server computes all money; a
  refund is never a subtraction from `amount_paid_centavos`.
- `amount_paid_centavos` may only be written by `server/src/services/payments/record-payment.ts`.
- Never hard-delete bookings or payments; soft-deletes (`is_active`/status)
  everywhere else.
- No red anywhere in the UI (guard tests: `no-red.test.ts`, `contrast.test.ts`).
- Ports: client 5180, server 3100 — never 5173/3000.
- Database: `rg_travel` (app), `rg_travel_test` (test) — never anything
  else; Kong PMS shares the MySQL server and must never be touched.
- Security controls and destructive operations must fail closed, with a
  test for the failure path.
- Every new test must be proven able to fail (break the code, see red,
  restore) — log a test that cannot be made to fail in `docs/BUGS_LOG.md`
  rather than shipping it silently.
- No new npm/yarn lockfiles, no new dependencies without asking.
- Do not widen a role, touch Kong PMS, build van transfers/joiner
  departures, or deploy to production.
- A booking ref is validated and normalised by the one shared
  `bookingRefSchema` — do not add a second ref schema.
- No form may show raw Zod JSON; use `client/src/lib/field-errors.ts`.
- `docs/BUGS_LOG.md` gets a row moved from Open to Fixed (with commit hash)
  for every bug this batch closes; stale CLAUDE.md/BUILD_SPEC.md prose
  describing the now-fixed defect gets corrected in the same commit
  (project convention — see how BUG-041's status correction was handled).

## Pre-flight conflict scan

| Task pair                          | Shared surface                                                                                                                | Conflict?                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B2 (seed split) × B3/B4 (checkout) | None — seed.ts vs checkout.ts/coupons.ts                                                                                      | none                                                                                                                |
| B2 × B5 (cookie split)             | None — different subsystems                                                                                                   | none                                                                                                                |
| B3 × B4                            | Both edit `server/src/routers/public/checkout.ts` (`startPayment` vs `quote`), different procedures in the same file          | sequential edits to the same file; run B3 before B4, same file, non-overlapping line ranges (startPayment vs quote) |
| B5 × B3/B4                         | `createContext`/session plumbing vs checkout router — checkout procedures are `publicProcedure`, no session dependency        | none                                                                                                                |
| B6 × B5                            | B6 touches SEO resolvers + field-errors.ts (client); B5 touches session/context — no overlap                                  | none                                                                                                                |
| B6 × B3/B4                         | B6's field-errors half touches `createHoldInput` consumers (client `GuestDetails.tsx`), not the server procedures B3/B4 touch | none                                                                                                                |
| B7 × anything                      | `sitemap.ts` comment-only edit                                                                                                | none                                                                                                                |

Ordering: B2 → B3 → B4 → B5 → B6 → B7 (B1 already done, commit `46ac1cb`).
Each task is its own commit; `git add` named files only.

---

## Task B2 — BUG-118: split `db:seed` into BASE and DEMO

**Files:** `server/src/db/seed.ts`, new `server/src/db/seed-demo.ts`,
`server/package.json`, `docs/BUGS_LOG.md`, `docs/LAUNCH_CHECKLIST.md`,
`CLAUDE.md` (the "Content (current state)" BUG-118 paragraph),
`docs/BUILD_SPEC.md` (the owner-decision-log line about BUG-118).
New/edited tests in `server/src/__tests__/`.

**Current state** (`server/src/db/seed.ts`): one exported `seed(context)`
that runs, in order: `seedFirstOwner` (already insert-only/create-only) →
`upsertDestination` for each `SEED_DESTINATIONS` (currently an upsert —
updates an existing row every run) → `upsertTour` for each `SEED_TOURS`
(upsert; always replaces that tour's `tour_price_tiers`/`tour_images`
wholesale) → `upsertPackage` (upsert) → `upsertReview` (upsert) →
`insertSettingIfMissing` loop over `SEED_SETTINGS` (already insert-only) →
if `context === 'app'`: `upsertFleet` (vans/drivers, upsert) and
`upsertItineraryStops` (upsert keyed on `sort_order`, never deletes a stop
with checkpoint history). The CLI entry point at the bottom of the file
(`isMainModule` block) calls `seed()` and is wired to
`pnpm --filter @rg/server db:seed`.

**What to build:**

1. Split the single `seed(context)` body into two exported functions,
   keeping `seed(context)` itself as `await seedBase(context); await
seedDemo(context);` so every existing caller that imports `seed` (17+
   test files, `global-setup.ts`, `helpers/test-db.ts`) keeps working
   unchanged — this task must not touch those call sites.

   - `seedBase(context: DatabaseContext = 'app')`: runs
     `assertDatabaseName`/`assertConnectedDatabase` (same as today),
     `seedFirstOwner`, destinations, and settings. **Destinations become
     insert-only**: write a new `insertDestinationIfMissing(db, destination)`
     mirroring `insertSettingIfMissing`'s shape (select by `slug`; if a row
     exists, return its id and touch nothing; otherwise insert) and use it
     in place of today's `upsertDestination`. Settings stay exactly as they
     are (`insertSettingIfMissing`, unchanged).
   - `seedDemo(context: DatabaseContext = 'app')`: runs its OWN
     `assertDatabaseName`/`assertConnectedDatabase` call (so a standalone
     CLI invocation is still guarded even though `seed()` will now call the
     guard twice when it runs both halves — that redundancy is intentional
     and cheap, not a defect to "optimize away"), then tours/price-tiers/
     images, packages, reviews — **unchanged upsert behaviour**, this is
     dev/demo content and keeping it overwritable is the whole point of the
     split. Then, exactly as today, `if (context === 'app')`: `upsertFleet`
     and `upsertItineraryStops`; otherwise log the existing "skipped" lines.

2. CLI wiring: change the bottom `isMainModule` block in `seed.ts` to call
   `seedBase()` only (not `seed()`). Add a new file `server/src/db/seed-demo.ts`
   with its own `isMainModule` block that imports and calls `seedDemo()` and
   `closeDb()`, following the exact same pattern (including the
   success/failure console output) as the existing block. Add a
   `db:seed:demo` script to `server/package.json`:
   `"db:seed:demo": "node scripts/db-preflight.mjs && tsx src/db/seed-demo.ts"`.
   Leave `"db:seed"` pointing at `tsx src/db/seed.ts` (now base-only).

3. Update the module doc-comment at the top of `seed.ts` to describe the
   split (what BASE owns, what DEMO owns, and why — the BUG-118 incident is
   the why).

4. Tests — three new/extended cases, each proven able to fail (implementer:
   actually break the code, watch it go red, then restore; report how):
   - **"an edited tour price survives a base re-seed"**: using the test
     database, get a tour+price-tier into the database (via `seed('test')`
     or `seedDemo('test')`), directly `UPDATE` a `tour_price_tiers` row's
     `price_per_person_centavos` to a different value (simulating an admin
     edit), call `seedBase('test')` alone, and assert the price is
     unchanged. Make it provably able to fail by confirming it goes red if
     `seedBase` is temporarily made to call `upsertTour`.
   - **"a deactivated driver stays deactivated through a base re-seed"**:
     insert a driver row directly (bypassing seeding — follow the pattern
     other driver tests use, e.g. `driver-lockout.test.ts`) with
     `is_active = false`, call `seedBase('test')` alone, assert still
     inactive. (`rg_travel_test` must keep an empty fleet from `seedDemo`
     per the existing `capacity.test.ts` invariant — do not seed a driver
     through `seedDemo`/`upsertFleet` for this test; insert it directly.)
   - **"the demo seed refuses to run against a non-dev database name"**:
     exercise `seedDemo`'s own guard call directly (mirroring how
     `guard.test.ts`/existing `assertDatabaseName` tests are structured) —
     confirm it throws `DB_WRONG_DATABASE` and writes nothing (no
     `upsertTour`/etc. call happens) when pointed at a database name that is
     neither `rg_travel` nor `rg_travel_test`.
     Also re-run every existing test in `owner-seed.test.ts`,
     `seed-settings.test.ts`, `seed-itinerary.test.ts`, and anything else
     calling `seed('test')` — they must all still pass unmodified, since
     `seed()`'s external behaviour has not changed.

5. Docs:
   - `docs/BUGS_LOG.md`: move BUG-118's row from "Open / queued" to "Fixed",
     filling in the commit hash this task produces, following the existing
     Fixed-row format (see how BUG-041/BUG-108 read).
   - `docs/LAUNCH_CHECKLIST.md`: correct the step-2 paragraph (currently
     warning that `tours`/`tour_price_tiers`/`tour_images`/`packages`/
     `reviews`/fleet "are still upserted the OLD way" and that `db:seed`
     must only ever be run for the one settings-key gap) — `pnpm --filter
@rg/server db:seed` is now base-only and genuinely safe to re-run
     against production at any time; `db:seed:demo` must never be run
     against production and the checklist should say so explicitly.
   - `CLAUDE.md`: correct the "Content (current state)" bullet that begins
     "`db:seed` is insert-only for `settings` and OVERWRITES everything
     else" — it is now split into `db:seed` (base, insert-only) and
     `db:seed:demo` (dev-only demo content, unchanged overwrite behaviour,
     refuses on the wrong database name).
   - `docs/BUILD_SPEC.md`: the owner-decision-log entry at the "open
     questions" list referencing BUG-118 gets marked resolved with a one-line
     pointer to this task, matching how other resolved entries in that list
     read.

**Do not**: touch `upsertFleet`'s/`upsertItineraryStops`'s actual logic
beyond moving them into `seedDemo` unchanged; touch `insertSettingIfMissing`;
add a database migration (none is needed — no schema change).

---

## Task B3 — BUG-117: `startPayment` enforces "online methods disabled"

**File:** `server/src/routers/public/checkout.ts`, test file
`server/src/__tests__/checkout-payment.test.ts`, `docs/BUGS_LOG.md`,
`CLAUDE.md` (the BUG-117 paragraph in "Checkout & payments (current state)").

**Current state:** `startPayment` (the mutation starting around line 750)
loads the booking, checks it is `payable`, computes `amountDueNowCentavos`,
refuses below `PAYMONGO_MIN_CENTAVOS` (BUG-110, already fixed), then calls
`getProvider('paymongo').createCheckout({...})` inside a `try/catch` that
turns any thrown error into `gatewayUnavailable(error)` — a
`TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Online payment is
temporarily unavailable...' })` (the `gatewayUnavailable` helper, around
line 472). It never reads `settings.payment_methods`, so once PayMongo is
genuinely configured, disabling every payment method in Settings does not
stop `startPayment` from creating a real checkout session — only the client
UI hides the "Pay now" button (`onlinePaymentEnabled`, computed in
`server/src/content/settings.ts`'s `toSettingsPayload`, formula
`paymongoConfigured && resolvePaymentMethods(payment_methods).length > 0`).

**What to build:** in `startPayment`, before the call to
`getProvider('paymongo').createCheckout`, add a guard that reads the same
`payment_methods` settings block `startPayment` does not currently read
(`readSettingBlock('payment_methods')` — the same helper this file already
imports and calls for the `'booking'` block) and, using the already-imported
`resolvePaymentMethods` from `server/src/content/settings.ts`, throws via the
existing `gatewayUnavailable(error)` helper when
`resolvePaymentMethods(block).length === 0` — reusing its fixed guest-safe
message rather than inventing a new one (CLAUDE.md: any new
`SERVICE_UNAVAILABLE` raiser on a guest path must carry a guest-safe
message; reusing the existing helper satisfies this by construction). Do
not attempt to cross-reference specific enabled method keys against
`CHECKOUT_PAYMENT_METHODS` — their vocabularies don't match 1:1 today
(`gcash`/`maya`/`grabpay`/`qr_ph`/`visa`/`mastercard` in settings vs.
`card`/`gcash`/`maya`/`grab_pay` in the checkout constant) and the bug is
specifically about "zero enabled methods", matching `onlinePaymentEnabled`'s
own formula exactly.

**Tests:** in `checkout-payment.test.ts`, add a case that updates (or seeds a
fixture for) `settings.payment_methods` to every method `enabled: false`
(mirror `settings.test.ts`'s `ALL_METHODS_DISABLED` fixture shape for the
block contents, but write it through whatever this file's existing DB-backed
pattern is, e.g. a direct `UPDATE settings` against the held test booking's
database), then call `caller.checkout.startPayment({ ref })` and assert it
throws `{ code: 'SERVICE_UNAVAILABLE' }` with the existing
`gatewayUnavailable` message text, and that the gateway's `createCheckout`
spy was never called. Restore the settings row (or scope the mutation so it
doesn't leak into later tests in the file, following this file's existing
isolation pattern) so the rest of the suite is unaffected. Confirm this test
can fail (temporarily remove the new guard, see it go red, restore it).

**Docs:** move BUG-117 to Fixed in `docs/BUGS_LOG.md` with the commit hash;
correct the CLAUDE.md "Known gap, open on an owner decision (BUG-117)"
sentence to say it is now enforced in `startPayment` too.

---

## Task B4 — ₱0 bookings: refuse in the quote/coupon-preview path too

**File:** `server/src/routers/public/checkout.ts` (the `quote` procedure,
around lines 577–607), test file `server/src/__tests__/checkout-router.test.ts`,
`docs/BUGS_LOG.md`, `CLAUDE.md` ("Checkout & payments (current state)" ₱0
bullet).

**Current state:** `createHold()` (`server/src/services/create-hold.ts`,
step 4b) and `startPayment`'s defensive re-check already refuse a booking
whose amount-due is below `PAYMONGO_MIN_CENTAVOS`, including the `<= 0` case
(`GatewayMinimumNotMetError` → `gatewayMinimumMessage(totalCentavos)` →
`NOTHING_TO_PAY_ONLINE` from `shared/src/checkout.ts`) — this half is already
built and already tested (`create-hold.test.ts` lines ~753–779,
`checkout-router.test.ts` lines ~479–516 for the hold half). The gap is the
public `checkout.quote` procedure — the preview the checkout UI calls before
the guest ever submits — which computes `priceQuote()` (so it already knows
`quote.totalCentavos`) and calls `validateCoupon()` (which only ever sees
`subtotalCentavos`, never the resulting total), then returns the quote to
the browser successfully even when `totalCentavos === 0`. The existing test
at `checkout-router.test.ts` lines ~479–490 currently asserts this
succeeds — that assertion is now wrong per owner decision #3 and must be
corrected to expect a refusal, in the same place the already-passing
`createHold` refusal is asserted a few lines below it.

**What to build:** in the `quote` procedure, immediately after computing the
quote (and before returning it, ok either before or after the existing
`validateCoupon` call since `validateCoupon` doesn't consult the total),
add: `if (quote.totalCentavos <= 0) throw new TRPCError({ code:
'BAD_REQUEST', message: gatewayMinimumMessage(quote.totalCentavos) })` —
reusing the same imported `gatewayMinimumMessage`/`TRPCError` this file
already uses for the identical check in `startPayment`. Do not change
`validateCoupon()`'s signature (it has two call sites —
`checkout.quote` and `createHold()` — and CLAUDE.md's existing note on this
exact function says the grouping/shape here is deliberate); the refusal
belongs in the procedure that already has the computed total in hand, not
inside the function that was never given it.

**Tests:** in `checkout-router.test.ts`, change the existing "tells a
100%-off guest there is nothing to pay" test's `quote` call (currently
asserted to succeed with `totalCentavos === 0`) to instead assert it throws
`{ code: 'BAD_REQUEST', message: NOTHING_TO_PAY_ONLINE }` — the `createHold`
assertion a few lines below it in the same test is unaffected and stays as
proof the hold-time path still independently refuses. Add one boundary case
confirming a coupon that leaves ₱1 or more due still returns a successful
quote (mirroring `create-hold.test.ts`'s "normal tour still holds on
deposit" boundary pattern), so the new check isn't over-tight. Prove the new
assertion can fail (temporarily remove the guard, see the test go red,
restore).

**Docs:** move the ₱0 open question in `CLAUDE.md`'s "Checkout & payments"
section from "Still open: whether a ₱0 booking should confirm... is an
owner decision" to recording the 2026-10-30 owner decision (refuse, always)
and that it is now enforced at both hold time and in the quote/preview path.
Log nothing new in BUGS_LOG (this was an open design question, not a
tracked bug) — update the spec/CLAUDE.md text only.

---

## Task B5 — BUG-119: split the shared session cookie into one per surface

**Files:** `server/src/middleware/session-cookie.ts`, `server/src/context.ts`,
`server/src/middleware/require-role.ts`, `server/src/middleware/require-driver.ts`,
`server/src/middleware/require-customer.ts`, `server/src/trpc.ts`,
`server/src/routers/admin/auth.ts`, `server/src/routers/public/driver-auth.ts`,
`server/src/routers/public/portal.ts`, `server/src/routers/receipts.ts`,
`server/src/routers/payment-qr.ts`, and every test file that references
`SESSION_COOKIE` or asserts "same cookie" behaviour (grep first — confirmed
list so far: `session-context.test.ts`, `admin-bookings.test.ts`,
`admin-auth.test.ts`, `driver-auth.test.ts`, `portal-login.test.ts`,
`staff-must-change-gate.test.ts`, `phase1-walkthrough.test.ts`,
`receipts-route.test.ts`, `receipt-upload.test.ts`, `payment-qr-upload.test.ts`,
`portal-manual-payment.test.ts` — grep the whole `server/src` tree again
before finishing, this list may be incomplete). `docs/BUGS_LOG.md`,
`CLAUDE.md` (the "no session isolation" security-section paragraph).

**Current state:** one cookie, name `rg_session`, path `/`, issued by
`setSessionCookie(res, token, expiresAt)` / cleared by
`clearSessionCookie(res)` in `middleware/session-cookie.ts`. Every tRPC call
(admin, driver, portal/customer alike) is served from one merged
`appRouter` under the single Express mount `/trpc` — there is no per-surface
Express path prefix to key a per-path cookie off, confirmed by reading
`app.ts`'s full middleware chain. `context.ts`'s `createContext()` reads the
ONE `rg_session` cookie once per request and resolves it via `readSession()`
into a single `ctx.session: { subjectType, subjectId, role?, ... } | null`.
`requireRole()` (admin), `requireDriver()`, and `requireCustomer()` each just
narrow that one `ctx.session` by checking `subjectType`. Because it is
genuinely the same cookie, signing into one surface in a browser overwrites
whatever session (of any subject type) that browser already had — this is
the bug. Two standalone Express routes (`receipts.ts`, `payment-qr.ts`) read
the identical `SESSION_COOKIE` cookie directly, bypassing `createContext`
entirely (each is single-surface already — receipts is customer-only,
payment-qr is staff-only). `sessions.ts`'s `SessionSubject` union is
`'user' | 'customer' | 'driver'`; `SESSION_TTL_MS_BY_SUBJECT` keys off the
same three values — none of this changes. The origin-check/CSRF middleware
(`origin-check.ts`) depends on nothing cookie-related — confirmed no change
needed there.

**Design (the reason a single resolved `ctx.session` cannot work anymore):**
with three distinctly-named cookies, a browser can legitimately hold all
three valid at once (a guest in "My Booking" while staff is also signed in
on another tab) — that simultaneity is the whole point of the fix, so
`createContext` cannot pick "the one session for this request" without
knowing which surface the request is for, and inferring that from the tRPC
procedure path is fragile under request batching. Instead, resolve three
independent, surface-scoped fields on the context, each from its own
cookie, each independently validated:

- `ctx.adminSession` — from the admin cookie, only kept if
  `readSession(...).subjectType === 'user'`.
- `ctx.driverSession` — from the driver cookie, only kept if
  `subjectType === 'driver'`.
- `ctx.customerSession` — from the customer cookie, only kept if
  `subjectType === 'customer'`.

Each lookup only runs `readSession` when its cookie is actually present
(most requests carry at most one or two of the three). `requireRole()` /
`requireDriver()` / `requireCustomer()` each read only their own field —
e.g. `requireRole` checks `!ctx.adminSession` → `UNAUTHORIZED` instead of
`!session || session.subjectType !== 'user'`. This removes the
`subjectType` inequality check from each gate (the field itself now
guarantees the type) while keeping the same `UNAUTHORIZED`/`FORBIDDEN`
behaviour and messages the existing tests already pin
(`driverProcedure` refuses a staff session with `UNAUTHORIZED` per
CLAUDE.md — preserve that: `ctx.driverSession` is simply absent for a staff
cookie, so the existing refusal shape is unaffected).

**What to build, concretely:**

1. `middleware/session-cookie.ts`: replace the single `SESSION_COOKIE`
   constant with
   `export const SESSION_COOKIE_BY_SUBJECT: Record<SessionSubject, string> = { user: 'rg_admin_session', driver: 'rg_driver_session', customer: 'rg_customer_session' }`
   (import `SessionSubject` from `services/sessions.ts`). Change
   `setSessionCookie(res, subjectType, token, expiresAt)` and
   `clearSessionCookie(res, subjectType)` to take a `subjectType` parameter
   and look up the right cookie name; keep every existing cookie option
   (`httpOnly`, `sameSite: 'lax'`, `secure: env.SITE_ENV === 'production'`,
   `path: '/'`) unchanged.
2. `context.ts`: read all three cookies from `req.cookies`, look up
   `readSession` only for the ones present, and assign
   `ctx.adminSession`/`ctx.driverSession`/`ctx.customerSession` as described
   above (null if the cookie is absent, invalid, expired, or resolves to the
   wrong `subjectType`). Remove the old single `ctx.session` field — grep
   every remaining reference to `ctx.session` across `server/src` (routers,
   services, audit logging, anywhere a staff/driver/customer name or role is
   read off context) and point each at the correct one of the three new
   fields; do not leave a dangling reference.
3. `trpc.ts`: update `adminProcedure`/`adminProcedureAllowingPasswordChange`,
   `driverProcedure`, `customerProcedure`'s middleware (and `require-role.ts`
   / `require-driver.ts` / `require-customer.ts`, wherever the actual check
   lives) to read the matching new context field.
4. Login mutations — `admin/auth.ts`'s `login`, `public/driver-auth.ts`'s
   `login`, `public/portal.ts`'s `login` — call
   `setSessionCookie(ctx.res, '<their subjectType>', token, expiresAt)`.
5. Logout mutations — the same three files' `logout` — call
   `clearSessionCookie(ctx.res, '<their subjectType>')`, reading the token
   via the surface's own new cookie-name constant. **Fix the pre-existing
   literal in `portal.ts`'s logout** (`cookies?.rg_session`, a hardcoded
   string that bypassed the shared constant even before this task) to use
   the new customer cookie name instead.
6. `receipts.ts` and `payment-qr.ts`: read their one relevant cookie
   directly by name (`SESSION_COOKIE_BY_SUBJECT.customer` for receipts,
   `SESSION_COOKIE_BY_SUBJECT.user` for payment-qr) instead of the old
   generic `SESSION_COOKIE`.
7. No change to `sessions.ts` (no schema change, as instructed) or to
   `origin-check.ts`.

**Tests:** update every existing reference to the old `SESSION_COOKIE`
constant/name across the test files listed above to use the correct
per-surface constant, and rewrite the "both arrive in the same cookie, only
`subject_type` separates them" comments (now literally false) to describe
the new per-surface-cookie model — the same kind of stale-comment
correction this project has made before (see how BUG-121 was found and how
BUG-041's status line was corrected). Add:

- A test proving a guest "My Booking" login in the same request/cookie-jar
  no longer evicts a live staff session: sign in as staff, capture its
  Set-Cookie; sign in as a portal customer, capture its Set-Cookie; present
  the ORIGINAL staff cookie again on a subsequent admin-only call and
  confirm it still succeeds.
- A test that each surface refuses the others' cookies: present a valid
  driver cookie (under its own cookie name) to an admin procedure and
  confirm `UNAUTHORIZED` (the admin cookie is simply never sent/absent); and
  the reverse for a staff cookie against a driver procedure.
- A test that logout clears only its own cookie: call driver logout and
  assert the response's `Set-Cookie` only clears the driver cookie name, not
  the admin or customer cookie names.
- Re-run the existing CSRF/origin-check test file unmodified and confirm it
  still passes (no code change expected there; this is a regression check,
  not a new test).

Prove each new test can fail (e.g. temporarily revert to the shared cookie
name, confirm the eviction test goes red, restore).

**Docs:** move BUG-119 to Fixed in `docs/BUGS_LOG.md` with the commit hash;
correct the CLAUDE.md Security-section paragraph ("There is NO session
isolation between the three surfaces") to describe the new per-surface
cookie model and that isolation now exists.

**Stop-and-ask trigger check:** this task is explicitly authorized by owner
answer 4 (BUG-119/A9) — proceed without re-asking, but if the grep in step 2
surfaces a `ctx.session` consumer whose correct new field is genuinely
ambiguous (not "staff vs driver vs customer" but something structurally
different), stop and ask rather than guess.

---

## Task B6 — BUG-116 (checkout/booking pages 404) + BUG-120 (lead field misattribution)

**Files (BUG-116):** `server/src/seo/resolvers.ts`,
`server/src/middleware/robots-header.ts`, `shared/src/document-titles.ts`
(wherever `APP_SURFACE_TITLES` lives), `server/src/__tests__/seo-resolvers.test.ts`.
**Files (BUG-120):** the server's tRPC `errorFormatter` (grep `server/src`
for where `error.data.zodError` is populated — not yet located by this
plan's research; locate it first), `client/src/lib/field-errors.ts`,
`client/src/components/checkout/GuestDetails.tsx`, and that component's
existing tests if any.

### BUG-116

**Current state:** `/checkout/:tourSlug` and `/booking/:ref` are real public
SPA routes (`client/src/App.tsx`) but have no entry in `resolvers.ts`'s
`ROUTES` table and are not part of `NOINDEX_PATH_PREFIXES`
(`middleware/robots-header.ts`, currently `['/admin', '/driver', '/portal']`
— which already carries a forward-looking comment: "Add the booking
surfaces here as they land: `/checkout` and the confirmation pages are a
thin-content, personal-data noindex for exactly the same reasons.") — so
both fall through `resolvePage` to `notFoundMeta` (404, "Page not found").
Task 9 solved the identical defect for `/driver`/`/admin`/`/portal` with
`appSurfaceMeta`: add a path to `NOINDEX_PATH_PREFIXES`, add a title to
`APP_SURFACE_TITLES`, wire a description into `APP_SURFACE_COPY` in
`resolvers.ts` — `appSurfaceMeta` then serves it synchronously (no DB read),
200, `noindex,nofollow`, matched by first path segment regardless of what
follows (so `/checkout/anything` and `/booking/anything` both resolve, same
as `/driver/trip/7` does today).

**What to build:** add `/checkout` and `/booking` to `NOINDEX_PATH_PREFIXES`,
`APP_SURFACE_TITLES`, and `APP_SURFACE_COPY` following that exact existing
pattern — titles "Checkout" and "Booking status" (or equivalent brand-style
two-to-four-word titles matching "Driver portal"/"Staff console"/"My
booking"'s tone; "My booking" is already taken by `/portal`, do not reuse
it for `/booking`), each suffixed `| TravelSugbo` like the existing three,
with a one-sentence non-indexable description in the same voice as the
existing three ("Sign-in for ... Not a public page." style, adapted — e.g.
"Complete your TravelSugbo booking." / "Track your TravelSugbo booking.").
This is the one surface where this plan is asking for product copy
judgement; use `ui-ux-pro-max`/`frontend-design`'s voice guidance only if
genuinely useful — this is one sentence of meta description, not a UI
screen, so don't over-invest.

**Tests:** extend `seo-resolvers.test.ts`'s existing `it.each` table (the
one covering `/driver`/`/admin`/`/portal`) with `/checkout` and `/booking`
rows, plus the "merely starts with the prefix is not the surface" check
(e.g. `/checkoutfoo` stays 404) and the `resolvePage` integration assertion
(`status === 200`, `robots === 'noindex,nofollow'`, issues no DB query) —
mirroring the existing rows exactly. Prove able to fail (temporarily remove
the new prefix entries, confirm the new test rows go red against the
current 404 behaviour, restore).

### BUG-120

**Current state:** `createHoldInput.lead` (`shared/src/checkout.ts`) is one
nested Zod object (`{ name, email, phone }`). The server's tRPC error
formatter publishes `error.data.zodError` from the caught `ZodError`'s
top-level `flattenError`/`fieldErrors`, which groups by `issue.path[0]` —
so any issue inside `lead` (whichever of the three sub-fields is actually
wrong) arrives as one `fieldErrors.lead` entry with no sub-key.
`client/src/lib/field-errors.ts`'s `getFieldErrors` only ever reads that
top-level map, and `GuestDetails.tsx` reads `fieldErrors?.lead` once and
renders it beside all three inputs (`name`, `email`, `phone`), marking all
three `aria-invalid` regardless of which one is actually wrong. The A4
reviewer ruled the _nested `lead` input shape_ correct and not to be
reworked for its own sake — this task does not flatten `createHoldInput`;
it teaches the error path to carry nested attribution instead, which is the
other option CLAUDE.md names as the real fix.

**What to build:** locate the server's `errorFormatter` (likely
`server/src/trpc.ts`) and extend what it publishes on `error.data.zodError`
so a form with a nested object input can resolve a message to the exact
leaf field — walk the underlying `ZodError`'s `issues` (each carries a full
`path: (string | number)[]`, e.g. `['lead', 'phone']`) and build a
dot-joined map (`'lead.phone'` → message) alongside (not replacing) the
existing top-level `fieldErrors`, so every other form using the shared
helper today keeps working unchanged. In
`client/src/lib/field-errors.ts`, extend `getFieldErrors` (or add a sibling
helper) so a caller can ask for a nested path (`'lead.phone'`) and get that
leaf's own message when present, falling back to the parent key's message
only if no leaf-level message exists (keeps old callers safe). In
`GuestDetails.tsx`, switch from one shared `fieldErrors?.lead` lookup to
three independent lookups (`'lead.name'`, `'lead.email'`, `'lead.phone'`),
each rendered and `aria-invalid`-marked only on its own input.

**Tests:** a unit test on the new error-formatter behaviour (construct a
`ZodError` against `createHoldInput` with only `lead.phone` invalid, confirm
the published shape carries a `'lead.phone'`-keyed message and that
`'lead.name'`/`'lead.email'` are absent); a `field-errors.ts` unit test for
the new nested lookup plus its fallback behaviour; and (if a test file for
`GuestDetails.tsx` exists — check first) a component test confirming only
the phone input is marked invalid when only the phone is wrong. If no
component test file exists for this component today, a unit test on the
helper/formatter is sufficient — do not create a new test-infrastructure
pattern just for this. Prove able to fail per the usual rule.

**Docs:** move both BUG-116 and BUG-120 to Fixed in `docs/BUGS_LOG.md` with
the commit hash.

---

## Task B7 — BUG-121: fix `sitemap.ts`'s stale comments, then push main

**Files:** `server/src/seo/sitemap.ts` (header comment and the inline
comment near line 185), `docs/BUGS_LOG.md`.

**What to build:** replace the stale "a sitemap must never list a URL that
says `noindex`" phrasing in both comments with the corrected rule already
stated in `CLAUDE.md`'s SEO section: "a sitemap must never list a URL whose
OWN RESOLVER says `noindex`" — the per-route decision, not the site-wide
`content_unverified` gate. Copy CLAUDE.md's phrasing/reasoning rather than
inventing new wording, so the two stay in sync. This is a comment-only
change — no code/behaviour difference, no test needed (there is nothing
executable to prove able to fail).

**Docs:** move BUG-121 to Fixed in `docs/BUGS_LOG.md` with the commit hash.

**Then:** run the five checks one final time on the whole branch, and push
`main` to `origin`. If the push is rejected for permissions, stop and tell
the user to run it themselves — do not retry with elevated credentials or
force.

---

## Task C1 — `checkout.quote` refuses any total below the ₱100 gateway minimum

**File:** `server/src/routers/public/checkout.ts` (the `quote` procedure —
the same guard B4 already added, one line above it), test file
`server/src/__tests__/checkout-router.test.ts`.

**Current state:** since Task B4, `quote` refuses when
`quote.totalCentavos <= 0` (a 100%-off coupon), via `throw new TRPCError({
code: 'BAD_REQUEST', message: gatewayMinimumMessage(quote.totalCentavos)
})`. `createHold()` has always refused more broadly — ANY
`amountDueNowCentavos < PAYMONGO_MIN_CENTAVOS` (₱100), zero or not — so a
coupon leaving e.g. ₱50 due previews successfully today and is only refused
once the guest tries to actually hold the booking.

**What to build:** widen `quote`'s existing check from `quote.totalCentavos
<= 0` to `quote.totalCentavos < PAYMONGO_MIN_CENTAVOS` (import
`PAYMONGO_MIN_CENTAVOS` from `@rg/shared`/`shared/src/money.ts` if not
already imported in this file — check first, `startPayment` in the same
file already uses it). Keep reusing the exact same
`gatewayMinimumMessage(quote.totalCentavos)` call — it already branches
correctly: `<= 0` → `NOTHING_TO_PAY_ONLINE`, `0 < total < ₱100` →
`TOTAL_BELOW_GATEWAY_MINIMUM` — so no new message text is needed anywhere.
Do not touch `createHold()`, `PaymentOptions.tsx`, or
`settings.manualTransferEnabled` — this task is scoped to `quote` only, by
explicit owner decision (an earlier, broader design — letting a
below-floor total through when manual transfer is configured — was
considered and rejected in favour of this simpler, already-proven shape).

**Tests:** extend `checkout-router.test.ts` with a case for a coupon
leaving a non-zero amount below ₱100 due (e.g. 1 pax, a coupon leaving
₱50) — assert `quote` throws `{ code: 'BAD_REQUEST', message:
TOTAL_BELOW_GATEWAY_MINIMUM }` (import the constant from
`shared/src/checkout.ts` rather than hardcoding the string) and that
`createHold` for the same inputs still independently refuses too (the
existing coverage shouldn't regress). Confirm the existing `₱1 or more due
still succeeds` boundary test from B4 is unaffected by the widened
threshold (it should still pass since it uses a total above the floor —
reread it and adjust its fixture if the floor change makes its math land
in the new refusal band). Prove the new test can fail (temporarily revert
the widened check, confirm red, restore).

**Docs:** no `docs/BUGS_LOG.md` row (this is a refinement of B4's existing
fix, not a new tracked bug); no CLAUDE.md change needed (CLAUDE.md's ₱0
paragraph already describes the general pattern and doesn't claim the
non-zero band is unhandled — reread it once you're done and correct it
only if it's now actually wrong).

---

## Task C2 — `db:seed:demo` refuses without `ALLOW_DEMO_SEED=1` and outside dev

**Files:** `server/src/env.ts` (add `ALLOW_DEMO_SEED` to the schema),
`server/src/db/seed.ts` (`seedDemo`'s guard), `.env.example`, new/edited
tests in `server/src/__tests__/`.

**Current state:** `seedDemo(context)` already refuses on a non-dev
database name (`assertDatabaseName`/`assertConnectedDatabase`, Task B2) —
but as the final whole-branch review found, that guard does NOT protect
against a production run, because production's own database is also named
`rg_travel`. There is currently no other technical barrier.

**What to build:**

1. `server/src/env.ts`: add `ALLOW_DEMO_SEED: z.string().optional(),` to
   the schema (mirroring `OWNER_EMAIL`/`OWNER_PASSWORD`'s pattern — no
   default, optional).
2. `seedDemo(context)` in `server/src/db/seed.ts`: before anything else
   (ahead of or alongside its existing database-name guard — your call on
   exact ordering, but both must run before any write), add two checks,
   each throwing a clear, distinct error message naming which check
   failed:
   - `env.ALLOW_DEMO_SEED !== '1'` → refuse (message should say to set
     `ALLOW_DEMO_SEED=1` to run this, and that it's dev-only).
   - `env.NODE_ENV === 'production'` → refuse (message should say this
     command must never run with `NODE_ENV=production`).
     Both checks apply regardless of `context` (`'app'` or `'test'`) — this
     guards the DEMO half specifically, not the base seed, and the test
     suite's own calls to `seed('test')` (which internally calls
     `seedDemo('test')`) will need `ALLOW_DEMO_SEED=1` set in the test
     environment for the existing 17+ test files to keep working. Find
     wherever the test environment's env vars are configured (e.g. a
     `.env.test` file, `vitest.config.ts`'s `env` option, or
     `global-setup.ts`) and set it there — do not weaken the production
     check to accommodate tests; `NODE_ENV` in the test run is already
     `'test'`, not `'production'`, so only `ALLOW_DEMO_SEED` needs adding to
     the test environment.
3. `.env.example`: add `ALLOW_DEMO_SEED=` (empty) with a comment directly
   above or beside it: `# dev only — never set on the server`.

**Tests:** two new cases, each proven able to fail (break the code, confirm
red, restore):

- `seedDemo` refuses when `ALLOW_DEMO_SEED` is unset (or not exactly
  `'1'`), even against the correct test database name, and writes
  nothing.
- `seedDemo` refuses when `NODE_ENV` is `'production'`, even with
  `ALLOW_DEMO_SEED=1` set and the correct test database name, and
  writes nothing.
  You'll need to manipulate `process.env` directly in the test (save and
  restore the original values in a `finally`/`afterEach`, matching
  whatever pattern `owner-seed.test.ts` or similar already uses for
  env-var-dependent tests — check first rather than inventing a new
  pattern). Also re-run (don't need to rewrite) the existing suite to
  confirm `seed('test')`'s 17+ callers still pass once the test
  environment sets `ALLOW_DEMO_SEED=1` globally.

**Docs:** this closes QUESTION 2 from the batch's final report — no new
`docs/BUGS_LOG.md` row needed (it was a question, not a tracked bug), but
correct `docs/LAUNCH_CHECKLIST.md`'s and `CLAUDE.md`'s `db:seed:demo`
description (corrected by the final-review fix wave to stop _overclaiming_
protection) to now accurately describe the REAL guard this task adds.

---

## Task C3 — update README.md and .env.example for the base/demo seed split

**Files:** `README.md`, `.env.example`.

**Current state:** flagged as an unrelated-but-found gap in the B1–B7
batch's final report — README.md and `.env.example` still describe the
pre-B2 single `db:seed` command and don't mention `db:seed:demo` or (once
C2 lands) `ALLOW_DEMO_SEED`.

**What to build:** read both files' current `db:seed`-related sections and
update them to match `CLAUDE.md`'s Commands table (base = insert-only,
safe on prod; demo = dev-only, requires `ALLOW_DEMO_SEED=1` and non-production
`NODE_ENV`, upserts). If C2 is done first, this task documents its real
behaviour; if done in parallel/first, coordinate so the description matches
what C2 actually builds rather than what this plan merely proposes — reread
`server/src/db/seed.ts`'s own module doc-comment before writing, and treat
it as the source of truth over this plan text. Comment-only/doc-only — no
test needed.

---

**Then:** run the five checks one final time, and push `main` to `origin`.
If the push is rejected for permissions, stop and tell the user to run it
themselves.
