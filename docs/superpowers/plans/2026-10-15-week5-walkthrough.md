# Week 5, Task 16 — the dispatch walkthrough, and what it could not prove

Driven on **2026-10-15** against the running server on `localhost:3100`, over real HTTP with a real
session cookie. **24 of 24 steps passed.**

## What "against the running app" means here, exactly

Over **HTTP**, not through `appRouter.createCaller`. The test suite already covers every resolver;
`createCaller` bypasses the tRPC context factory, the session cookie, the origin check and the role
middleware's real wiring, so a pass there says nothing about those. This walkthrough signs in, gets
a `Set-Cookie`, and sends that cookie on every subsequent request.

Two temporary staff accounts (one `owner`, one `finance`) were created with **random passwords that
were never printed**, used, and then deleted along with their sessions. The walkthrough script lives
in the session scratchpad rather than the repo: it writes to `rg_travel`, and a script that creates
staff accounts is not something to leave lying in a checkout.

**No PIN, password or cookie value appears in the output.**

## Step 1 — a dispatcher signs in: **PROVEN**

Both accounts authenticated over HTTP and received a session cookie. This is the first Week 5
exercise of `staffAuth.login` → `context.ts` → `adminProcedure` end to end rather than in a unit
test.

## Step 2 — the dashboard, where the day starts: **PROVEN**

All **five** alerts answered, every one with a real row behind it from the seed:

| Alert                            | Count                                                 |
| -------------------------------- | ----------------------------------------------------- |
| Unassigned trips within 48 hours | **2** (e.g. `RG-VVBQ5T · Kawasan Falls Canyoneering`) |
| Vans in repair                   | 1                                                     |
| Service due within 14 days       | 2 (one of them **overdue**)                           |
| Papers expiring within 30 days   | 2 (one van franchise, one driver licence)             |
| Payments to verify               | 0 — correct: the seed creates no manual receipts      |

The zero is as important as the four: it rendered as a card saying so, rather than vanishing.

## Step 3 — the calendar: **PROVEN**

- 31 days returned for the month, every day present including empty ones.
- `2026-10-16` carried the needs-assignment marker with a count of 1.
- That day named the trip: `RG-VVBQ5T · Kawasan Falls Canyoneering · 4 pax`.
- **The month payload contained no guest email and no phone number** (RA 10173) — checked by
  scanning the whole JSON for `@` and `+639`, not by reading the projection.

## Step 4 — the dropdowns: **PROVEN**

`dayOptions` offered **3 vans and 4 drivers** for a 4-pax trip out of a seeded fleet of four vans
and four drivers. The excluded van is the `for_repair` one, and **every van offered was big enough
for the group** — the 6-seater was included, the repair van was not.

## Step 5 — auto-suggest: **PROVEN**

Suggested **SEED-003, the 6-seater** — the smallest van that fits 4 — out of a free list containing
a 6, a 10 and a 15. Not the first row, not the biggest.

## Step 6 — finance is refused: **PROVEN**

The `finance` session's assignment attempt answered **FORBIDDEN**. This is the role boundary
exercised through the real middleware with a real cookie, which no unit test does.

## Step 7 — assigning: **PROVEN**

`SEED-003 + Benjie Sarmiento` assigned, answered `{ ok: true }`. Re-reading the options afterwards
still offered this booking its own van — `excludeBookingId` doing its job, so re-assignment is
possible rather than self-blocking.

## Step 8 — a mid-trip swap: **PROVEN**

With the trip moved to `in_progress`:

1. A swap with **no reason** was refused — `BAD_REQUEST`, carrying `reason_required`.
2. The same swap **with** a reason succeeded: `SEED-001 + Jun Alcantara`.
3. The trip was **still `in_progress`** afterwards — the swap did not un-start a running trip.
4. The audit row was `booking_reassigned_in_progress`, **carried the reason**, and recorded
   `previousVanId = 3` — the van it replaced.

## What this pass did NOT prove

Named rather than glossed over:

- **The browser.** Every step went through HTTP and the database. The React screens
  (`AdminCalendarPage`, `AssignPanel`, `AdminDashboardPage`, the vans and drivers pages) are covered
  by 436 client tests including the accessibility ones, but **no human has clicked them and no
  browser has rendered them.** jsdom is not a browser: it does no layout, so the 360px and tablet
  behaviour, the 44px tap targets and the gold dot's actual visibility are **verified by class
  string and by eye in code, not by looking at a screen.** That is the largest gap in this week and
  it wants ten minutes with `pnpm dev` and a phone-sized window.
- **Two dispatchers at once, through the UI.** The concurrency guarantee is proven by four tests —
  one van and one driver across two tours, plus the same within one tour — and by removing the fleet
  lock and watching them fail. It has not been exercised by two browser tabs.
- **The driver portal reflecting a re-assignment.** Owner Q3 requires it; the portal is Week 6
  (6A/6B) and does not exist. Carried forward, recorded below.
- **`on_trip` as a van status.** Nothing writes it yet (check-ins are 6C), so no van in this pass
  ever held it. The allow-list treats it as unsellable, which is correct and untested against real
  data.
- **Email.** No notification fires on assignment; §11's dispatch notifications are not in §13's
  5A–5E list.

## Carried into Week 6

1. **`on_trip` must be cleared when a trip completes.** 6C's check-ins are the first code to set it,
   and `VAN_STATUS_SELLABLE` allow-lists `available` alone — so a van left `on_trip` stops being
   sellable on **every future date**.
2. **The driver portal must reflect a mid-trip re-assignment** (owner Q3, 2026-10-14). A driver
   whose trip was taken off them must stop seeing it; the one who received it must start.
3. **A driver's average rating and upcoming trips** (§9 "Drivers") are not built. The rating needs an
   owner decision first — there is no rating column, `reviews` scores a tour, and inventing a number
   is the fabricated social proof `CLAUDE.md` forbids.

## Housekeeping done after the pass

- The two walkthrough staff accounts and their sessions: **deleted**.
- The demo trips: **reset** to `confirmed` with no van and no driver, so the seed state and the
  dashboard alerts are exactly as a fresh clone finds them.
- `rg_travel_test`: **zero vans, zero drivers** — the empty-fleet premise `capacity.test.ts` depends
  on is intact.
