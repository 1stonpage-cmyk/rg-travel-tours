# Week 6, Task 14 — the driver walkthrough, and what it could not prove

Driven on **2026-10-16** against the running server on `localhost:3100`, over real HTTP with real
session cookies.

**Ten of the eleven steps in this agent's scope passed. One step — step 9, the browser at 360px — was
driven separately by the coordinator and is left for them to fill in below.**

## What "against the running app" means here, exactly

Over **HTTP**, not through `appRouter.createCaller`. The suite already covers every resolver;
`createCaller` bypasses the tRPC context factory, the session cookie, the origin check and the role
middleware's real wiring, so a pass there says nothing about any of them. This walkthrough signs in,
takes the `Set-Cookie`, and sends that cookie on every subsequent request. Every mutation carried an
`Origin: http://localhost:5180` header, because the origin check refuses a state-changing request
without one — the first thing the pass confirmed, by accident, is that a bare `POST` is 403'd.

Three temporary staff accounts (`owner`, `finance`, `dispatcher`) and two temporary drivers (`WT1`,
`WT2`) were created with **random passwords and PINs that were never printed**, used, and then
deleted along with their sessions. Seven temporary bookings (`RG-WT0001` … `RG-WT0007`) and two
temporary itinerary stops were created and deleted. The harness lives in the session scratchpad
rather than the repo: it writes to `rg_travel`, and a script that mints staff accounts is not
something to leave lying in a checkout.

**No PIN, password, token or cookie value appears anywhere in this document or in the harness
output.** The admin PIN reset was exercised and its new PIN used to sign in; the value was never
logged.

### One thing the harness had to work around, and it is a finding in its own right

§8's third login limit is **10 `driver.login` attempts per IP per 15 minutes**
(`DRIVER_LOGIN_IP_MAX`, `app.ts`). The three-lockout escalation needs **fifteen** real failures. So
**the per-IP limiter fires before a single IP can ever reach `requires_admin_unlock`** — observed, not
reasoned: the 11th attempt in the window answered `HTTP 429 Too many requests, please try again
later.` while `WT2` still sat at `lockout_count = 1`.

That is correct behaviour for an attacker and awkward for a walkthrough, so step 2 is split: the
**five-failure walk was driven in full over HTTP** (attempts 1→4 refused without locking, the fifth
locking), and the **escalation to a third lockout** was reached by staging `WT2`'s counter columns in
the database to the boundary and driving every transition across it over HTTP. That staging is named
here rather than hidden; nothing else in this pass was staged.

---

## Step 1 — a driver signs in, and the session is 12 hours: **PROVEN**

`driver.login` with `WT1` + its PIN answered `HTTP 200` and `{"driver":{"id":7,"name":"Walkthrough
Driver One","code":"WT1"}}` — the driver, and **no token in the payload**: the session is in the
httpOnly cookie and nowhere a script could read it.

Owner decision Q1 confirmed two ways, from the wire and from the row:

| Measured                                  | Value         |
| ----------------------------------------- | ------------- |
| `Set-Cookie`'s own `Expires`, minus now   | **11.9998 h** |
| `sessions` row, `expires_at − created_at` | **12.0000 h** |
| the same, for the `owner` staff session   | **24.0000 h** |

The staff 24 hours is the half that mattered to check: Q1's whole point was a per-subject map rather
than one shared constant, and a live staff session reading 24 while a live driver session reads 12 is
the only honest proof that halving one did not halve the other.

## Step 2 — the lockout, end to end: **PROVEN**

### The five-failure walk, driven over HTTP

| Attempt                         | HTTP | reason              | `failed_attempts` | `locked_until` | `lockout_count` |
| ------------------------------- | ---- | ------------------- | ----------------- | -------------- | --------------- |
| unknown code `WTZZ`             | 401  | `wrong_credentials` | —                 | —              | —               |
| wrong PIN #1                    | 401  | `wrong_credentials` | 1                 | null           | 0               |
| wrong PIN #2                    | 401  | `wrong_credentials` | 2                 | null           | 0               |
| wrong PIN #3                    | 401  | `wrong_credentials` | 3                 | null           | 0               |
| wrong PIN #4                    | 401  | `wrong_credentials` | **4**             | **null**       | 0               |
| wrong PIN #5                    | 403  | `locked`            | 5                 | **set**        | **1**           |
| the **correct** PIN, now locked | 403  | `locked`            | 5                 | set            | 1               |

- **Four failures do not lock and the fifth does** — the boundary, on the wire.
- **An unknown code and a wrong PIN are byte-identical answers** (asserted as a deep equality of the
  two response bodies, not as a similarity).
- **A correct PIN during a lockout is still refused and clears nothing.** `lockout_count` stayed 1.
- Further attempts during the lockout moved **no counter at all** — `failed_attempts` and
  `lockout_count` were read before and after and were unchanged.
- One audit row, `driver.locked_out`, carrying
  `{"lockedUntil":…,"lockoutCount":1,"failedAttempts":5,"lockoutWindowStartedAt":…}` — and **no PIN
  and no hash** anywhere in it. `lockedUntil` was exactly fifteen minutes after
  `lockoutWindowStartedAt`.

Two notes on how precisely to read that table. The **statuses and the five counter columns** are from
the unbroken 1→5 walk; the **`reason` strings for the two `403` rows** were captured in the later run
described below, where the counter was staged to 4 and the fifth failure driven over HTTP — because
the first run's harness logged the status and the row but not the error body. Nothing in the table is
inferred from source; the two halves were measured a few minutes apart.

### The third lockout, and the admin unlock

With `lockout_count` staged to 2 and the window opened an hour ago (inside the 24-hour escalation
window), the next fifth failure answered **`HTTP 403 needs_admin_unlock`** and the row read
`failed_attempts 5, lockout_count 3, requires_admin_unlock 1`. A correct PIN then answered
`needs_admin_unlock` too, and the flag survived it.

Then, the Week 5 carry-forward:

1. `admin.drivers.resetPin` as **finance** → `403 FORBIDDEN "Not permitted for this account."` —
   §9 gates it on `vansDrivers`, which is owner and dispatcher.
2. `admin.drivers.resetPin` as **dispatcher** → `200`, a six-digit PIN handed back **once**.
3. The driver row afterwards: `requires_admin_unlock = 0`, `lockout_count = 0`,
   `failed_attempts = 0`, `locked_until = null` — **all five columns cleared in the reset's own
   transaction**.
4. `driver_pin_reset` audit row, `{"clearedLockout":true}` and **no PIN**.
5. **`driver.login` with the new PIN → `HTTP 200`, immediately.** Week 5's carry-forward is closed on
   the wire rather than against the policy function.

And then, re-staged to `failed_attempts 4, lockout_count 0`, the same fifth failure answered
**`HTTP 403 "locked"`** with `lockout_count 1` and no admin flag — the ordinary fifteen-minute
lockout, with the row confirming `locked_until` fifteen minutes out. A correct PIN during it answered
`"locked"`, and a further wrong PIN left `failed_attempts` at 5 and `lockout_count` at 1. That is the
run the two `403` reason strings in the table above came from.

### And the two refusals that are not the same refusal

`locked` and `needs_admin_unlock` are both `403` but carry different messages, because the driver's
next action differs — wait, or ring the office. `wrong_credentials` is `401`. A per-driver lockout is
deliberately **not** `429`: that status belongs to the per-IP limiter, and the client reads it as "the
network told you to slow down".

## Step 3 — Today / Upcoming / History, and the other driver's trip: **PROVEN**

`driver.trips` with `WT1`'s cookie, six rows, bucketed by the server:

| bucket     | ref         | date       | status                 | pax | van      |
| ---------- | ----------- | ---------- | ---------------------- | --- | -------- |
| `history`  | `RG-WT0006` | 2026-10-10 | completed              | 3   | SEED-001 |
| `today`    | `RG-WT0001` | 2026-10-16 | assigned               | 4   | SEED-003 |
| `today`    | `RG-WT0002` | 2026-10-16 | assigned               | 2   | SEED-001 |
| `today`    | `RG-WT0003` | 2026-10-16 | assigned               | 2   | SEED-002 |
| `today`    | `RG-WT0004` | 2026-10-16 | `pending_verification` | 2   | —        |
| `upcoming` | `RG-WT0005` | 2026-10-17 | assigned               | 2   | —        |

- `WT2`'s trip (`RG-WT0007`, today) is **absent** from `WT1`'s list.
- The list payload contains **no `@` and no `+639`** — scanned as raw JSON, not read off the
  projection. RA 10173: the list is a list, and contact details belong to the one-trip manifest.
- A trip with no van renders rather than hiding (`RG-WT0004`, `RG-WT0005`).

And the refusals, which are the point of the step:

| Request as `WT1`                                   | Answer                                      |
| -------------------------------------------------- | ------------------------------------------- |
| `driver.trip` for `WT2`'s booking id               | **404 `NOT_FOUND` "No trip with that id."** |
| `driver.trip` for a booking id that does not exist | 404 `NOT_FOUND`, **the same message**       |
| `driver.trips` with no cookie                      | 401 `UNAUTHORIZED`                          |
| `driver.trips` with an **owner** cookie            | 401 `UNAUTHORIZED`                          |

A `403` on the first row would have confirmed the booking exists, and over a numeric id that is a
tool for walking every booking on the system towards a guest's phone number. The two answers are
indistinguishable, including the message string. The staff-cookie row is `UNAUTHORIZED` and not
`FORBIDDEN` on purpose: a staff session has no driver to be.

The trip detail for `RG-WT0001` carried `leadName`, `leadPhone`, `pickup`, `pickupMapsUrl`,
`vanPlate`, `officeNotes`, the payment box and the progress — and **no `leadEmail`** and no totals.

**`officeNotes` showed the office's note verbatim to the driver** ("guest waiting at the second
gate"). That is open owner decision 6, confirmed on the wire: there is no visibility column, so every
`booking_notes` row a trip carries is driver-readable.

## Step 4 — start → stops → complete, with a double-tap and an undo: **PROVEN**

`RG-WT0001`, four pax, van **SEED-003**, tour 7 with two itinerary stops — so `total` is **3**,
because the trip-start pseudo-stop counts.

| #   | Action                                         | Result                                                        |
| --- | ---------------------------------------------- | ------------------------------------------------------------- |
| 0   | `dayOptions` for **tomorrow's** trip           | `SEED-001, SEED-002, SEED-003` — baseline                     |
| 1   | `driver.startTrip`                             | `1/3 in_progress`; van **`on_trip`**                          |
| 2   | `driver.startTrip` again (**double-tap**)      | `{"ok":false,"reason":"already_checked_in"}`                  |
| 3   | `driver.checkIn` stop 1                        | `2/3`                                                         |
| 4   | `driver.checkIn` stop 1 again (**double-tap**) | `already_checked_in`                                          |
| 5   | `driver.undoCheckIn` with a reason             | `{"ok":true,"stopId":3}`; progress back to `1/3`              |
| 6   | `driver.checkIn` stop 1 a third time           | `2/3`, and **still two checkpoint rows, not three**           |
| 7   | `dayOptions` for **tomorrow**                  | `SEED-001, SEED-002` — **SEED-003 gone**                      |
| 8   | `driver.checkIn` stop 2                        | `3/3 completed`; van **`available`**                          |
| 9   | `driver.completeTrip`                          | `already_checked_in` — a shrug, not an error                  |
| 10  | `dayOptions` for **tomorrow**                  | `SEED-003` **back**                                           |
| 11  | `driver.undoCheckIn` (undoing the completion)  | `{"ok":true,"stopId":null}`; `in_progress`; van **`on_trip`** |
| 12  | `dayOptions` for **tomorrow**                  | SEED-003 **gone again**                                       |
| 13  | `driver.completeTrip`                          | `3/3 completed`; van `available`                              |
| 14  | `dayOptions` for **tomorrow**                  | `SEED-003` back                                               |

The things worth naming separately:

- **The van's round trip was read through the availability module, not the column.** Rows 7, 10, 12
  and 14 are `admin.calendar.dayOptions` — the §9 dropdown that reads
  `services/dispatch/availability.ts` — asked about a **future** date. A van on today's trip
  disappeared from tomorrow's options and came back when the trip finished. The column was also read,
  but the column only proves the write landed.
- **Undo marks, never deletes.** After row 5 the checkpoint row was still there with
  `undone = 1, undone_by = 7` (the driver, not an admin).
- **Re-recording reactivated the row** (owner Q5): two rows before the undo, two rows after the
  re-tap. The unique index on `(booking_id, stop_key)` — the thing that makes the double-tap safe —
  was not weakened to allow it.
- **Undoing the completion put the van back out** (owner Q4), and dispatch honoured it on a date
  thirty-odd hours away within the same request.

## Step 5 — all three payment-box states, against real bookings: **PROVEN**

| Booking     | booking status           | box on the wire                                   |
| ----------- | ------------------------ | ------------------------------------------------- |
| `RG-WT0002` | `assigned`               | `{"kind":"collect_cash","amountCentavos":300000}` |
| `RG-WT0003` | `assigned`, paid in full | `{"kind":"fully_paid"}`                           |
| `RG-WT0004` | `pending_verification`   | `{"kind":"unverified_do_not_collect"}`            |

The amount is the server's arithmetic, already done; the payload carries no total and no
`amount_paid` for a client to re-derive it from. `RG-WT0004` is the dangerous middle state and it is
reachable two ways — a `pending` payment row, or `payment_review_required` — and this one came
through the flag.

**And one thing that is not a pass.** `RG-WT0001`, **after it was completed**, still answered
`{"kind":"collect_cash","amountCentavos":600000}`. The box is suppressed for `completed` on the
client only. Open owner decision 1 says exactly that the server would accept such a claim; it now
has a measurement behind it — see the findings section.

## Step 6 — the cash claim moves no money until finance says so: **PROVEN**

| Step                                                      | Answer                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `driver.recordCash` on **tomorrow's** trip                | `403 FORBIDDEN "Cash can only be recorded on the day of the trip."`  |
| `driver.recordCash` on `RG-WT0002`                        | `{"paymentId":1,"amountCentavos":300000}`                            |
| the booking, immediately after                            | **`assigned`, `amount_paid_centavos` 0** — it did not move           |
| the `payments` row                                        | `pending`, `manual`/`cash`, 300000, `collected_by_driver_id = 7`     |
| `admin.bookings.approveCash` with the **driver's** cookie | `401 UNAUTHORIZED "Admin sign-in required."`                         |
| `driver.recordCash` a second time                         | `409 CONFLICT "There is nothing to collect on this trip right now…"` |
| `driver.trip` again                                       | the box is now `unverified_do_not_collect`                           |
| `admin.bookings.approveCash` as **dispatcher**            | `403 FORBIDDEN "Not permitted for this account."`                    |
| `admin.bookings.approveCash` as **finance**               | `{"bookingStatus":"assigned","paymentReviewRequired":false}`         |
| the booking, after                                        | `amount_paid_centavos` **300000**                                    |
| the `payments` rows, after                                | **one row, id 1**, now `paid`, `verified_by = 10` (the finance user) |
| `approveCash` a **second** time                           | `409 CONFLICT "This cash has already been handled (it is "paid")…"`  |
| the booking, after that                                   | still 300000 — **credited exactly once**                             |

**One handful of cash, one `payments` row for its whole life.** The driver's tap created it, finance
converted it, and no second row was ever inserted. The today-only rule is enforced by the procedure
and not only by hiding a button. The driver could not verify their own collection and neither could
a dispatcher.

## Step 7 — the dispatcher's board sees it: **PROVEN (the endpoint; the 15 seconds is the client's)**

Mid-trip, with `RG-WT0001` one stop in, `admin.departures.today` answered
`{"done":1,"total":3,"status":"in_progress","driver":"Walkthrough Driver One","van":"SEED-003"}` —
**immediately**, in the very next request. After completion the same row read `3/3 completed`.

All six of today's departures were listed, including the seed's own unassigned `RG-VVBQ5T` with
`driver —  van —`, which is the single most important row on the board. All three roles could read it
(`dashboard` is owner + dispatcher + finance); each answered `200` with six departures.

**What is proven and what is not:** the endpoint reflects a driver's tap on the next read. The
"within ~15 seconds" is `DEPARTURES_POLL_MS = 15_000` in
`client/src/components/admin/DeparturesBoard.tsx`, a `refetchInterval` — **read from the source, not
watched in a browser.** No browser rendered the board in this pass.

## Step 8 — cancel, a partial refund, and a refund that was refused: **PROVEN**

| Step                                                   | Answer                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `admin.refunds.cancelBooking` as **dispatcher**        | `403 FORBIDDEN` — owner Q10, on the wire                                                                                             |
| `admin.refunds.cancelBooking` as **owner**             | `{"ref":"RG-WT0002","previousStatus":"assigned","vanReleased":false}`                                                                |
| the booking                                            | `cancelled`, `amount_paid_centavos` still 300000                                                                                     |
| `refundPayment` **100000**, offline `cash`, as finance | `{"paymentId":2,"bookingId":13,"provider":"manual","calledGateway":false}`                                                           |
| the `payments` rows                                    | `[ {1, payment, paid, 300000}, {2, refund, refunded, 100000} ]`                                                                      |
| `refundPayment` **250000** (would total 350000)        | **`400 BAD_REQUEST "That is more than this booking can give back: 3000.00 pesos were paid and 1000.00 has already been refunded."`** |
| the booking and the rows, after the refusal            | **byte-identical to before it** — no row, no change                                                                                  |
| `refundPayment` **200000**, the exact remainder        | accepted — the cap is the remainder, not a smaller number                                                                            |

`vanReleased: false` is correct: `RG-WT0002` had a van assigned but its trip had never started, so
there was no `on_trip` to clear. `calledGateway: false` is also correct and is the week's standing
limitation — the row is `provider = 'manual'`, so the money went back by hand and the system recorded
it. **No refund has ever been issued through a real gateway** (see below).

One convention worth writing down because the pass measured it: **a refund does not decrement
`amount_paid_centavos`.** The booking still reads 300000 paid after 300000 was refunded; the cap is
computed as paid minus already-refunded under the booking row lock. §6's "a refund is never a booking
status" extends to "a refund is never a subtraction from what was paid".

## Step 9 — the browser, at 360px

> **PLACEHOLDER — driven separately by the coordinator.** Opening the driver portal in a 360px window
> and using it one-handed was explicitly outside this agent's scope: no dev server was started for it,
> no screen was rendered, and **no layout finding of any kind is claimed here.** The coordinator will
> fill this section in.

## Step 10 — housekeeping done after the pass

- The three walkthrough staff accounts, the two walkthrough drivers, and **every session row
  belonging to them**: deleted.
- The seven `RG-WT…` bookings and everything hanging off them — payments, refunds, checkpoints,
  office notes, audit rows: deleted.
- The two temporary `tour_itinerary_stops` on tour 7: deleted.
- The seed's own demo trips `RG-VVBQ5T` and `RG-FNFQ7G`: **reset to `confirmed` with no van and no
  driver**, so the dashboard alerts and the calendar read exactly as a fresh clone finds them. The
  four seed vans are all back to their seeded statuses (`available` ×3, `for_repair` ×1) and the four
  seed drivers' lockout columns are untouched zeroes.
- `rg_travel`'s own tables, counted after: `users` 0, `payments` 0, `trip_checkpoints` 0,
  `booking_notes` 0, `tour_itinerary_stops` 0, `sessions` 0. Two bookings, four vans, four drivers —
  the seed, exactly.
- `rg_travel_test`: **zero vans, zero drivers** — the empty-fleet premise `capacity.test.ts` depends
  on is intact.
- Two lock-placeholder rows remain and were deliberately left: one `fleet_date_slots(2026-10-16)` —
  which was already there before this pass began — and one `tour_date_slots(7, 2026-10-16)`, the pair
  for the seed's own `RG-VVBQ5T`. Both tables hold nothing but the key; any capacity path recreates
  the row it needs. Nothing cleans them, which is carry-forward 3 below.

## Step 12 — the five checks, each run separately

| Check                                  | Exit |
| -------------------------------------- | ---- |
| `pnpm lint`                            | 0    |
| `pnpm typecheck`                       | 0    |
| `pnpm test`                            | 0    |
| `pnpm format:check`                    | 0    |
| `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` | 0    |

**2,127 tests — 79 shared, 534 client, 1,514 server — across 136 test files, 0 skipped**, plus the
`check:coming-soon` and `check:contact` guards that `pnpm test` runs first. **No migration was added
this week**: the latest is Week 5's `0011_colossal_tomorrow_man`, so 6A–6F were built entirely on the
existing schema and there is nothing new to apply to a server database.

---

## What this pass did NOT prove

Named rather than glossed over.

- **The browser — still, and now it matters more.** Step 9 was the coordinator's and is unfilled
  above at the time of writing. Everything in steps 1–8 went through HTTP and the database. jsdom does
  no layout, so **360px, one-handed reach, the 44px tap targets, the payment box's actual visibility
  in sunlight and the undo button's position are verified by class string, not by looking at a
  screen.** For a dashboard that was an acceptable gap for a week; for a screen a driver uses standing
  beside a van it is not.
- **The gateway.** `provider.refund()` has only ever run against the mock. `calledGateway: false` on
  both refunds in step 8 is the honest reading: the money moved by hand and the system recorded it.
  **No real payment and no real refund has ever been issued** — blocked on the PayMongo account, the
  same item `LAUNCH_CHECKLIST.md` already carries.
- **Concurrency through the UI.** The double-tap in step 4 was two sequential requests, which is a
  double-tap in the human sense but not a race. The actual races — two taps arbitrated by the unique
  index, two approvals of one cash row, two refunds against one payment — are proven by the suite's
  concurrent tests, with the index and the locks removed as the mutation. No two browser tabs were
  used.
- **The full three-lockout escalation from one IP, unaided.** It cannot be done: the per-IP limiter
  fires at 10 attempts and the escalation needs 15. The counters were staged to the boundary; every
  transition across it was driven over HTTP. See the note at the top.
- **A mid-trip re-assignment reaching the driver portal.** Owner Q3's end-to-end version — a driver
  whose trip is taken off them stops seeing it, and the receiver starts — is covered by Task 2's
  isolation tests in both directions, and `driver.trips` filtering on the session was confirmed here,
  but **no re-assignment was performed during this pass** and no driver watched a trip vanish.
- **Email and SMS.** Nothing notifies anyone on assignment, completion, a cash claim or a
  verification. §13 does not list it for this week.
- **An expired driver session.** The 12 hours were measured on the cookie and the row; no session was
  held until it lapsed, and no request was made with an expired one. The boundary itself is covered by
  Task 1's TTL tests.
- **`rg_travel_test`'s `sessions` table.** It was counted (**672** rows when this pass began, **675**
  after two full suite runs) and left alone; nothing in this pass tested session cleanup, because
  there is none.

## Findings this pass produced that the tests did not

Each of these was observed on the wire. None of them was fixed — this task may touch documentation
and nothing else.

1. **`driver.trip` returns `collect_cash` on a `completed` trip, and `driver.recordCash` accepts
   it.** Measured: `RG-WT0001` was completed, its box on the wire read
   `{"kind":"collect_cash","amountCentavos":600000}`, and a `recordCash` against it answered
   `{"paymentId":4,"amountCentavos":600000}` — a real `pending` row, which this pass then deleted.
   The box is hidden for `completed` by the client alone. This is **open owner decision 1** and it now
   has a number behind it: the recommendation on record is to show the box for `completed` and keep
   `cancelled`/`expired` excluded, which would make the client agree with the server rather than
   cover for it.
2. **A driver's second cash claim is blocked by their own first one.** `409 CONFLICT "There is
nothing to collect on this trip right now. Please call the office."` — correct, and also the whole
   of **open owner decision 2**: there is no way to refuse a claim, so a claim for money that never
   arrives sits `pending` forever and that driver cannot re-record. Observed, not inferred.
3. **A driver deactivated mid-shift keeps their session.** `WT2` signed in, `is_active` was set to 0
   in the database, and `driver.trips` with the same cookie still answered **`HTTP 200` with their
   trips**. `requireDriver` narrows the session and never re-reads `drivers`, and `readSession`'s
   live-role join is on `users` only. Up to **12 hours** of access after deactivation — **open owner
   decision 4**, confirmed on the wire rather than read off the source.
4. **`driver_inactive` is distinguishable from `wrong_credentials` all the way to the screen.**
   `403` + the message `driver_inactive`, against `401` + `wrong_credentials`. A deactivated code's
   failure counters are also not touched at all, which is deliberate (a leaver must not be able to
   lock out a code a new hire is later given) and is itself a second, quieter signal. **Open owner
   decision 3.**
5. **The seed ships no `tour_itinerary_stops` at all.** Every one of the six seeded tours has zero.
   On seeded content the driver's itinerary screen is "Start trip" and nothing else, and the
   departures board reads `0/1` for every trip — visible in step 7's listing. This pass had to create
   two stops to have anything to check in to. Not a code defect; a content gap that makes 6C
   undemonstrable on a fresh clone, and one that 7F's admin editing screens do not cover either.
6. **`fleet_date_slots` and `tour_date_slots` are not in the test harness's `LEAK_TABLES`, and
   neither is `sessions`.** `server/src/__tests__/global-setup.ts` lists `bookings`, `drivers`,
   `vans`, `payments`, `users`, `trip_checkpoints` and nothing else. `rg_travel_test` held **672
   `sessions` rows** when this pass began and **675** when it finished.
7. **The duplicate-key walk has three implementations.** The shared
   `server/src/db/duplicate-key.ts` plus private copies in `server/src/routers/public/newsletter.ts`
   and `server/src/services/booking-ref.ts`. Carried forward.

## The seven owner decisions still open, each with its safe current behaviour

Collected in one place because they are scattered across six files' comments. **None of them is
unsafe today**; each is a question about whether the safe behaviour is the one the owner wants.

1. **`completed` trips show no payment box, so cash cannot be recorded after Complete is tapped** —
   on the client. The server would accept it, and this pass measured that it does (finding 1).
   _Safe today:_ a driver who taps Complete before taking the money has to ring the office.
   _Recommendation on record:_ show the box for `completed`, keep `cancelled` and `expired` excluded.
2. **A cash claim cannot be refused.** A `pending` cash row can be approved but there is no reject
   path for it, so a claim for money that never arrives sits `pending` forever and blocks that driver
   from re-recording (finding 2). _Safe today:_ no money moves, and the booking stays unpaid, which is
   the truth.
3. **`driver_inactive` is distinguishable from `wrong_credentials`** by status, by message and by the
   timing of the refusal, all the way to the screen (finding 4). _Safe today:_ it tells a leaver's
   code apart from a wrong PIN, which is kinder to the driver and marginally useful to an attacker
   enumerating codes.
4. **A driver deactivated mid-shift keeps up to 12 hours of access** (finding 3).
   _Safe today:_ deactivating a driver stops them signing in again and removes their future
   assignments, but does not end a live session. Staff deactivation **is** immediate, by contrast —
   `readSession` re-reads `users.is_active` on every request. The asymmetry is the decision.
5. **The orphaned-`on_trip` sweep — which of the two candidates.** A `node-cron` job that frees a van
   whose booking is still `in_progress` past its tour date, or a dispatcher-facing force-complete.
   _Safe today:_ nothing sweeps it, and the gap is pinned by the last test in
   `trip-van-status.test.ts`.
6. **`booking_notes` text is now visible to drivers** (step 3). There is no visibility column, so
   every note on a trip is driver-readable. _Safe today:_ the office writes notes knowing drivers read
   them — but nobody told the office that.
7. **Does an admin cancellation return the booking's coupon use?** Hold expiry does; a cancel is a
   different event and nothing in §6 says. _Safe today:_ untouched — the redemption stands, so a
   guest who cancels does not get the coupon back.

## Carried into Week 7

1. The **orphaned-`on_trip` sweep** (decision 5 above).
2. **`TripProgressStop` carries no checkpoint id** — confirmed in `shared/src/driver.ts`: the shape is
   `{ stopId, name, sortOrder, checkedAt, undone }`. So the client's undo **label** breaks a
   same-second `checked_at` tie by array index where the server breaks it by `id`. Label only; the
   refetch after the mutation corrects the record.
3. **`fleet_date_slots` is not in `LEAK_TABLES`**, `tour_date_slots` has no `ON DELETE` toward
   `tours`, and several suites therefore carry a hand-written cleanup line (finding 6).
4. **`sessions` rows accumulate unbounded in `rg_travel_test`** — 675 as of this pass, and the number
   only goes up. Nothing truncates them between runs and nothing expires them.
5. **`isDuplicateKeyError` has two private copies** besides the shared helper (finding 7).
6. **The gateway wire check** remains blocked on the PayMongo account. No real payment and no real
   refund has ever been issued.
