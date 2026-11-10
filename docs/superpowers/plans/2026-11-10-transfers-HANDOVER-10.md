# Transfers launch — HANDOVER-10 (Batch 6, T21)

Continues `2026-11-10-transfers-HANDOVER-9.md` (Batch 5, T17–T20, complete). This handover
closes **T21 only** — T22/T23/T24 remain open in Batch 6 of `2026-10-31-transfers-launch.md`.

## T21 — guest quote-ready notice + full staff-quote-to-cash lifecycle test — DONE

Commits `cee2985` (implementation) and `c25fd08` (dedicated-review follow-up).

Three parts, per the plan's own T21 line ("Guest notification for a ready staff quote;
role-isolation test proving dispatcher is refused `transferQuoting`; full lifecycle test:
inquiry → convert → booking → guest pays deposit → cash balance on the day"):

**A. A new `NotifyEvent`, `custom_quote_ready`** (`services/notify/templates.ts`) — the eighth
event. `NotifyPayload` gains `tripLabel?`/`holdExpiresAt?`, both required-by-convention for this
event only, following the same optional-on-the-flat-interface pattern `reason` and
`driverName`/`vanPlate` already set. `tripLabel` exists because `tourTitle` is contractually
`null` for every transfer — reusing it here would break every other template's "no Tour row"
omission for a null tour. A new `manilaDateTimeLabel()` helper renders the hold deadline as an
Asia/Manila date-and-time (not a civil date like `tourDate` — the HOUR matters here, because
`staffQuoteHoldHours` is a deadline a guest must act before).

**B. The router wires it** (`routers/admin/transfer-quotes.ts`) — `sendQuoteReadyNotice()`,
shaped exactly like `sendAssignmentNotice()` (`admin/dispatch.ts`): re-queries the just-committed
booking FRESH by id (LEFT JOIN onto `booking_transfer_details`, never INNER — T18's own lesson),
wrapped in its own try/catch even though `notify()` itself cannot throw, called strictly AFTER
`convertTransferQuote()`'s try/catch has resolved so a mid-flight race or deadlock-exhaustion
throws before any email goes out.

**C. `transfer-quote-lifecycle.test.ts`** (new file) — proves a staff-quoted, ROUTELESS transfer
survives the whole path unmodified: convert → guest deposit online → dispatch → driver cash claim
→ finance verification. Every step after conversion reuses machinery with its own dedicated test
file; this file's only job is the end-to-end fit.

**The role boundary is deliberately not re-proven in the new file.** `admin-transfer-quotes
.test.ts:331` (T19) already denies a dispatcher against the real mounted procedure, and
`role-isolation.test.ts`'s generated matrix covers it a second way in the abstract.

**`convertTransferQuote()` is called service-direct, not through the router, for the conversion
step only** — the router hardcodes `new Date()`; the test needs an explicit, injectable `now` so
two time-sensitive checks (the 6-hour minimum-notice check, and `driver.recordCash`'s same-day
check, which reads a REAL `new Date()` the test cannot inject into) are both deterministic
regardless of the wall-clock hour the suite runs at. Worked out algebraically in the file's own
header: pickup pinned to `10:00`, `now = real-now − 24h`, so the gap stays in `(10, 34]` hours at
any hour of any day.

**The guest's online deposit is simulated by calling `recordPayment()` directly**, matching the
exact shape the real webhook handler's `applyEvent()` uses — the webhook ROUTE itself has its own
dedicated file (`webhook-signed-end-to-end.test.ts`); re-deriving a second real HMAC signature
here would test that seam twice while testing this lifecycle not at all.

### Dedicated Opus review (required for T21 per the merged-run rules) — ran, no blockers,

6 should-fix + 7 nitpicks, all should-fix and the actionable nitpicks fixed in `c25fd08`, each
with a new or extended assertion proven able to fail:

1. **The injected `now` also sets `holdExpiresAt`, which the file header's time analysis had
   missed.** `createTransferBooking()` computes `holdExpiresAt = now + staffQuoteHoldHours`; with
   the seeded 48h setting the fixture's hold lands safely at `real-now + 24h`, but at a seeded
   value of 24h or less the fixture would be born with an ALREADY-EXPIRED hold, silently proving a
   state production can never reach. Fixed: the test now pins the seeded `staffQuoteHoldHours`
   value by name (same discipline as `transfer-create-booking.test.ts:524`) and asserts the
   resulting `holdExpiresAt` both exactly and as still-live relative to the real clock. Mutation-
   proven by shrinking the hold arithmetic — the exact-value assertion caught it.
2. **Nothing asserted the notice's payload, only that it fired** — a broken LEFT JOIN or column
   swap in `sendQuoteReadyNotice` would have silently fallen back to the router's own stand-in
   wording and stayed green. Fixed: `admin-transfer-quotes.test.ts`'s mail capture now also
   asserts the body contains the real route description. Mutation-proven by forcing `tripLabel`
   to `undefined` — the assertion caught the fallback wording appearing instead.
3. `TODAY`/`NOW_MINUS_24H` moved from module load into `beforeEach` — the sequential full suite
   (`fileParallelism: false`) can take minutes between load and this test running, long enough to
   cross a real Manila midnight and turn `TODAY` stale. Matches `driver-cash.test.ts` and siblings.
4. **`tripLabel` is guest-typed** (travels from `inquiries.routeDescription`, unrestricted beyond
   length) and had no escaping test, unlike `driverName`/`vanPlate` and `reason`. Added one to
   `notify.test.ts`. Mutation-proven by skipping the `escapeHtml()` call — caught the raw
   `<script>` tag.
5. The failure log in `sendQuoteReadyNotice` named no booking at all — per `notify()`'s own rule
   ("the event and the booking ref"), it now includes the booking id, so a production failure is
   chaseable to a specific guest.
6. **Owner decision, not fixed — see below.**

Nitpicks fixed: a stale `manilaDateTimeLabel` doc-comment example (date-first, not time-first); a
wrong "eighth `NotifyEvent`" count in `services/notify/index.ts`'s password-reset header (ninth,
now "another"); two different fallback strings for a missing route description (router's own
`'your custom trip'` removed in favour of the template's single `'your trip'` fallback — the
router's was provably unreachable); the lifecycle test's step-2 comment claimed to read the
frozen deposit snapshot but actually re-read the live `trust` setting — now reads
`price_snapshot.depositPercent` off the booking row, matching what the comment always claimed;
the file-level mail-capture array is now cleared in a file-level `beforeEach` rather than only
inside `describeWithDb`'s own, so "mail is empty when a test starts" holds unconditionally for
every test in that file, including the pure guard outside the database-backed suite.

### Owner decision needed, not yet made

**The quote-ready email names a Total but no pickup time, no drop-off, and no deposit amount.**
`date`/`pickupTime` are staff-CHOSEN on the convert form — the inquiry only carries the guest's
`requestedDate` — so this email is the guest's only chance to catch a wrong day or a wrong hour
before they pay a deposit on it. It shows `Reference` / `Date` / `Total` only; the pickup time and
the deposit-vs-total split are both one column away (`booking_transfer_details.pickupTime`, which
`sendQuoteReadyNotice` already LEFT JOINs, and `paidCentavos`, which the payload already carries
but `custom_quote_ready`'s template never reads). Fixing it needs a new `NotifyPayload` field
(pickup time) and/or reading the deposit against the total in the template — both touch the flat-
payload contract this task's own doc comments argue for keeping narrow. **Not fixed**, because
§6 step 5 of the plan promises only "a link into My Booking," which the email does provide, and
widening the payload is a product-copy decision, not a bug. Owner (or T24, which owns the
tour-only-language sweep, though this is a content-completeness question rather than a wording
one) should decide whether this warrants a new field now or waits.

### Noted, not fixed (named rather than actioned, per the standing "list rather than fix" rule)

- The lifecycle fixture's `created_at`/`updated_at` land ~24h in the past (same injected `now`
  that sets `holdExpiresAt`). Harmless — nothing in the lifecycle reads either column — but worth
  naming so nobody mistakes it for a real anomaly if they go looking.
- `sendAssignmentNotice()` (`routers/admin/dispatch.ts:140-145`) has the identical missing-
  booking-id gap `sendQuoteReadyNotice` had before should-fix #5 — same `[dispatch] could not
send the assignment notice (${kind})` shape, no identifier. Outside this diff; listed in
  Unrelated bugs below.

## Migrations owed on the server

**Unchanged — 0015 through 0025, in order, same as HANDOVER-9.** T21 is schema-free; no new
migration this task. Back up before applying 0015–0025 as a batch, per 0024's own column-removal
note.

## Unrelated bugs found (not fixed, per CLAUDE.md)

1. `sendAssignmentNotice()`'s failure log (`routers/admin/dispatch.ts:140-145`) names no booking,
   the same gap `sendQuoteReadyNotice` had before this task's should-fix #5 fixed it here. Found
   by the dedicated reviewer as an out-of-diff observation, not fixed — a production assignment-
   notice failure is currently unchaseable to a specific booking, same as T21's was.
2. Carried forward, still open: `shared/src/schemas/public.ts`'s `inquiryInput` has no `.strict()`
   despite being documented as one (T17 finding).

## Owner decisions carried forward, still open

The three-item finance-reach gap named under T20 in HANDOVER-9 (`packagesInquiries`/
`toursPricing` narrower than `transferQuoting`) — not touched by T21, still unresolved.

## Full suite, five checks

Server 131 files / 2679 tests, all green, after both T21 commits. `pnpm run typecheck` / `eslint`
/ `prettier --check` / `pnpm run build` all clean on every touched file, each confirmed
individually and in the full run.

## Local URLs to check

None new this task — T21 shipped no UI; `admin.transferQuotes.convert`'s guest email can be
observed via the console warning (`[notify] custom_quote_ready for RG-XXX not sent — SMTP is not
configured`) with no SMTP configured locally.

Proceeding to T22 (`TripDetail` transfer fields, driver trip screen, zero-itinerary-stop
check-in) — Opus model, dedicated Opus review required.
