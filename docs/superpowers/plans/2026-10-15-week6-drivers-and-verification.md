# Week 6 — Drivers & Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A driver signs in on their phone with a code and a six-digit PIN, sees only their own trips, taps through the itinerary as the van moves, claims cash when a guest pays at the door — and an admin, never the driver, turns that claim into money received, with cancellations and refunds that can never pay out more than came in.

**Architecture:** Three layers, each usable before the next. (1) A **driver session**: the `sessions` row already exists and `evaluatePinAttempt()` already decides the lockout policy as a pure function — this week gives it a database, a `driverProcedure`, and the per-IP limiter whose guard test has been waiting since Week 4. (2) A **check-in service** that is the only writer of `trip_checkpoints`, and the only thing that sets _and clears_ `vans.status = 'on_trip'`. (3) The surfaces on top: four driver screens, live departures on the admin dashboard, and the cancel/refund flow, which reuses `recordPayment()`'s existing refund path rather than inventing a second one.

**Tech Stack:** Existing only — React 19 + TS + Vite 7 + Tailwind v4 + the vendored shadcn primitives (`accordion`, `badge`, `button`, `card`, `input`, `label`, `select`), Express 5 + tRPC v11, Drizzle 0.44.7 + MySQL 8.0.46, Zod v4, `express-rate-limit`, `node-cron`, Vitest. **No new dependencies.** `nodemailer` and `cookie-parser` are already installed; nothing here needs more.

**Spec:** `docs/BUILD_SPEC.md` — §8 (driver portal, login, views, check-ins, cash), §6 "Refunds & cancellations", §9 (dashboard live departures, payment verification queue), §12 (security), §13 Week 6 (6A–6F).

## Global Constraints

Copied verbatim from `CLAUDE.md` and `docs/BUILD_SPEC.md`. Every task's requirements implicitly include this section.

- **Money:** integers in **centavos** everywhere. **`bookings.amount_paid_centavos` is written by `services/payments/record-payment.ts` and nothing else** — `schema-conventions.test.ts` scans the whole server tree for violations and caught the Week 5 seed doing it.
- **Only a verified webhook or an admin approval marks a booking paid.** A driver's tap is a **claim**, not a reconciliation.
- **Never hard-delete a booking or a payment.** An undone check-in is `undone = true`, never a `DELETE`.
- **Never print, log or commit a PIN, password, key or cookie value.**
- **Time:** store **UTC**; compute business dates in **Asia/Manila**. A tour date is a civil date (`YYYY-MM-DD`), never an instant. **Check-in timestamps are server time, never the driver's device clock.**
- **Audit:** every payment, refund, status change and assignment writes to `audit_log` via `writeAudit(tx, …)`. A driver's action is `actor_type = 'driver'`; an admin's is `'user'`.
- **Validation:** Zod on every input, schemas shared from `/shared`.
- **NO RED ANYWHERE** — including errors, badges and destructive buttons. Warnings amber/orange; errors dark blue/grey (`#334155`). `client/src/__tests__/no-red.test.ts` fails the build if red reappears, and it scans test **names** too.
- **Never convey meaning by colour alone** (WCAG 1.4.1).
- **Mobile-first, must work at 360px** — and for the driver screens that is the only size that matters. 44px minimum tap targets via the `tap-target` utility, visible focus, AA contrast. `brand-gold-600` fails AA for normal-size text.
- **Tailwind CSS transitions only.** `emilkowalski-motion` is **not installed**. Subtle, and respect `prefers-reduced-motion`.
- **Role middleware on every admin procedure**, and `procedure-role-metadata.test.ts` requires everything under `admin.*` to be an `adminProcedure`. Assert refusals on the error **`code`**, never the message.
- **Ports:** client **5180**, server **3100**. Never 5173 or 3000. Test database is `rg_travel_test`; never point a test at `rg_travel`.
- **The test database keeps an EMPTY fleet** — `capacity.test.ts` counts the whole fleet, and `db:seed` gates vans/drivers on `context === 'app'`. Do not loosen that.
- **Every new test must be proven able to fail** (mutate → red → restore), on **full-suite** runs. **After mutation-proving a refusal test, check `rg_travel_test` for rows the now-succeeding call left behind** — `globalSetup`'s teardown fails the run and names the table.
- **Exact-boundary tests, not brackets**, where the number is knowable. An exact count over shared mutable state is a flaky test wearing a precise number — scope it to what the test owns.
- **Verify before pushing — all five, separately, exit codes shown:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.
- **Never `git commit --amend`.** **Never run a background process and wait for it** — two agents lost a task that way in Week 5. Foreground only.
- **After any schema change, remind the owner to apply the migration on the server database.** There is still **no server database**; migrations `0010` and `0011` are already owed there.
- **Check the next migration number yourself.** `0011` is the highest applied.
- **Sunlight is the driver portal's real viewing condition.** A driver reads this screen through a windscreen at midday. Favour the high-contrast end of the brand palette for every driver surface — dark brand ink on near-white, never mid-grey on light-grey, and never gold text at normal size (`brand-gold-600` measures 3.25:1 and fails AA).

---

## What already exists — read this before Task 1

Verified against the tree at `131e198` and against `information_schema` (30 tables, 12 migrations, 2026-10-15). **No task here rebuilds anything in this table.**

| Thing                                                                                 | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `evaluatePinAttempt(state, now, pinOk)`                                               | **Exists and is complete** — `server/src/services/driver-lockout.ts:103`. A **pure function** with no database. It already implements all three of §8's stacked limits' per-driver halves: 5 failures → 15 minutes, 3 lockouts in 24h → `requires_admin_unlock`, and a correct PIN **never** clears that flag. Constants `MAX_FAILED_ATTEMPTS`, `LOCKOUT_MINUTES`, `MAX_LOCKOUTS_PER_WINDOW`, `LOCKOUT_WINDOW_HOURS` are exported. **Import them; never retype the numbers.**                          |
| `drivers` lockout columns                                                             | **All five exist**: `failed_attempts`, `locked_until`, `lockout_count`, `lockout_window_started_at`, `requires_admin_unlock`.                                                                                                                                                                                                                                                                                                                                                                          |
| `admin.drivers.resetPin`                                                              | **Exists** (Week 5) and is the admin unlock — clears all five columns in one transaction with the new hash. **This week owes the end-to-end test** that a reset driver can then actually sign in.                                                                                                                                                                                                                                                                                                      |
| `createSession(subjectType, subjectId)` / `readSession(token, now)` / `revokeSession` | **Exist** — `server/src/services/sessions.ts`. `sessions.subject_type` already admits `'driver'`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`SESSION_TTL_MS`**                                                                  | **Exists and is 24 hours, shared by every subject type.** §8 says a **driver** session lasts **12 hours**. See **Q1** — this is the one thing in Week 6 that needs a decision before Task 1.                                                                                                                                                                                                                                                                                                           |
| `customerProcedure`                                                                   | **Exists** — `server/src/trpc.ts:206`. The shape `driverProcedure` copies. There is **no `driverProcedure`**; Task 1 adds it.                                                                                                                                                                                                                                                                                                                                                                          |
| `createDriverLoginLimiter()`                                                          | **Exists, unmounted on purpose** — `rate-limit.ts:225`, with §8's 10-per-15-minutes already in `DRIVER_LOGIN_IP_MAX`. It is scoped to the procedure name **`driver.login`** (`DRIVER_LOGIN_PROCEDURES`, Week 4's proposal), and Week 4 declined to mount it against a name that did not exist yet because a procedure-scoped limiter aimed at the wrong name **fails open while looking mounted**.                                                                                                     |
| the guard that it gets mounted                                                        | **Exists** in `driver-lockout.test.ts:355`: it fails the build the moment a **public** procedure matching `/driver/i` + `/log_?in\|sign_?in\|authenticate\|pin/i` appears without `createDriverLoginLimiter` in `app.ts`, **and** asserts that procedure's name is in `DRIVER_LOGIN_PROCEDURES`. It skips `admin.*` (owner-decided 2026-10-14, Q5b), which is what keeps `admin.drivers.resetPin` from tripping it. **Task 1 will trip it. That is the point — so name the procedure `driver.login`.** |
| `trip_checkpoints`                                                                    | **Exists and has NO writer anywhere.** `stop_id` is nullable and null means **trip start**. `stop_key` is `GENERATED ALWAYS AS (coalesce(stop_id, 0)) STORED` — **an INSERT that names it is rejected by MySQL; write `stop_id` and let it follow.** `uniqueIndex (booking_id, stop_key)` makes a double-tap impossible _including_ a double "Start trip". `undone`, `undone_at`, `undone_by` exist; `undone_by` is a **driver**, not an admin.                                                        |
| `recordPendingCash(input)`                                                            | **Exists, tested, and is exactly §8 item 5's driver half** — `record-payment.ts:521`. One `payments` row (`provider='manual'`, `method='cash'`, `status='pending'`, `collected_by_driver_id` set) plus its audit row, and **touches nothing on `bookings`**. Deliberately takes no booking lock. **Do not write a second cash path.**                                                                                                                                                                  |
| `verifyCashPayment(input)`                                                            | **Exists, tested** — `record-payment.ts:933`. Converts that **same row** `pending` → `paid`, stamps `verified_by`/`verified_at`, credits `amount_paid_centavos` exactly once, under the booking row lock, and **refuses a driver as the verifier**.                                                                                                                                                                                                                                                    |
| `approveManualReceipt` / the receipt queue                                            | **Exists** (Week 4 Task 7), including reject-with-reason and the portal reflecting it. **§13's 6E is therefore largely already built** — see Task 11, which is smaller than its spec line suggests.                                                                                                                                                                                                                                                                                                    |
| `recordPayment({ type: 'refund', … })`                                                | **Exists, tested** — refunds are a `payments` row with an **always-positive** amount, the sum checked against `amount_paid_centavos` **under the booking row lock**, admin-only, audited. **6F records refunds through this; it does not invent a second path.**                                                                                                                                                                                                                                       |
| `provider.refund(input)`                                                              | **Exists** on the PayMongo provider — `paymongo.ts:533`, posting to `/refunds`. The Xendit stub cannot mark anything paid. **Untested against the real gateway**, like everything else PayMongo (`LAUNCH_CHECKLIST.md`, "the gateway wire check").                                                                                                                                                                                                                                                     |
| `vans.status`                                                                         | `['available', 'on_trip', 'parked', 'for_repair']`, and **`VAN_STATUS_SELLABLE = 'available'` is the allow-list** (owner-decided 2026-10-14). **Nothing writes `on_trip` yet.**                                                                                                                                                                                                                                                                                                                        |
| `isDriverVisible(status, tourDate, now)`                                              | **Exists** — `shared/src/portal.ts:94`. Decides when a guest may see driver contact details. Not the same question as which trips a driver sees.                                                                                                                                                                                                                                                                                                                                                       |
| Admin dashboard                                                                       | **Exists** (Week 5 Task 14) with five alert cards and a line saying live departures arrive this week.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Client test patterns                                                                  | `TrpcProviders` wrapper (`admin-bookings.test.tsx:124-134`); `mockTrpcError(procedure, code, message)` **now honours its code** (fixed 2026-10-15); Radix `Select` needs the three jsdom pointer shims in `assign-panel.test.tsx:35-41`.                                                                                                                                                                                                                                                               |

## What the spec asks for that does not exist yet

- **No driver portal at all.** No `client/src/pages/driver`, no `driverProcedure`, no driver login procedure, no driver session minting.
- **No `trip_checkpoints` writer.** Start, stop, complete and undo are all new.
- **Nothing sets or clears `vans.status = 'on_trip'`.**
- **No live departures** on the admin dashboard.
- **No cancel/refund UI**, though both halves of the server work exist.
- **No per-IP driver-login limiter mounted**, though its guard test is already written and will fail the build until it is.

---

## The three things this week must not get wrong

**1. A driver's tap is a claim, not money.** §8 is unusually explicit, and the reason is a fraud path: a driver who could verify their own collection could pocket the cash and leave the booking reading "paid in full". So `recordPendingCash()` writes one `pending` row and touches **nothing** on the booking, and `verifyCashPayment()` — finance or owner only — converts **that same row** rather than inserting a second one. Both already exist and are tested. This week's job is to wire them to a button and a queue **without adding a path between them.**

**2. `on_trip` must be cleared, or a van that drove once stops being bookable forever.** Week 5 made `available` the only sellable status. 6C is the first code to write `on_trip`. If completing a trip does not put the van back, `assessCapacity()` will refuse that van on **every future date** — and the symptom appears weeks later as "we're fully booked" on a day with four idle vans. Task 7 owns both halves and tests the clearing, not just the setting.

**3. A driver sees only their own trips.** §8 says it in four words and it is the whole privacy model of the portal. Every driver query filters on the session's driver id, and the session's id is the **only** source of that filter — never an input, never a URL. Task 4's tests include a driver asking for someone else's trip by id.

---

## File Structure

**The driver session**

- `server/src/services/driver-auth.ts` — `attemptDriverLogin()`: the database half of §8's lockout. Reads the driver `FOR UPDATE`, asks `evaluatePinAttempt()` what to do, persists the decision, writes the audit row, mints a session on success. One responsibility: turning a code + PIN into a session or a refusal.
- `server/src/routers/public/driver-auth.ts` — the auth half of the `driver` router: **`driver.login`**, `driver.logout`, `driver.me`. Public by necessity (a driver has no session yet), which is exactly why the per-IP limiter mounts here. **The procedure MUST be named `driver.login`** — `DRIVER_LOGIN_PROCEDURES` already reserves that exact string (`rate-limit.ts:223`), and the Week 4 guard asserts every driver-login procedure it finds is listed there. A `driverAuth.login` would trip it with "the limiter is scoped to driver.login and would not count driverAuth.login". Two files, one router: `_app.ts` merges these procedures with Task 2's into a single `driver` namespace.
- `server/src/trpc.ts` — gains `driverProcedure`, the mirror of `customerProcedure`: refuses anything whose session is not a `driver`, and exposes the driver id the queries filter on.

**Check-ins**

- `server/src/services/trips/checkins.ts` — `startTrip()`, `checkInStop()`, `completeTrip()`, `undoLastCheckIn()`. **The only writer of `trip_checkpoints`, and the only thing that sets or clears `vans.status`.** One file because the four operations share one invariant (the itinerary's order) and one lock discipline.
- `server/src/services/trips/progress.ts` — `tripProgress(tx, bookingId)`: the itinerary with each stop's check-in state, read by the driver's trip detail **and** the admin's live departures. One answer, two surfaces, so a dispatcher and a driver never see different progress.

**Routers**

- `server/src/routers/public/driver.ts` — `driver.trips | trip | startTrip | checkInStop | completeTrip | undoCheckIn | collectCash`.
- `server/src/routers/admin/departures.ts` — `admin.departures.today`.
- `server/src/routers/admin/refunds.ts` — `admin.refunds.cancelBooking`.

**Shared**

- `shared/src/driver.ts` — the Zod schemas and view types: `driverLoginSchema`, `DriverTripRow`, `TripDetail`, `TripProgressStop`, `CashCollectionInput`, `DRIVER_SESSION_HOURS`, and `driverTripBucket()` — the pure function that decides Today / Upcoming / History, so the tabs and the server agree.

**Client**

- `client/src/components/layout/DriverLayout.tsx` — the portal shell: one-handed, bottom tabs, no admin nav.
- `client/src/pages/driver/DriverLoginPage.tsx` — code + PIN, with the lockout messages.
- `client/src/pages/driver/DriverTripsPage.tsx` — the three tabs.
- `client/src/pages/driver/DriverTripPage.tsx` — trip detail, payment box, the itinerary, the cash button.
- `client/src/components/driver/PinPad.tsx` — a six-digit entry a thumb can hit in a moving van.
- `client/src/components/driver/PaymentBox.tsx` — §8's three states, text-first.
- `client/src/components/driver/StopList.tsx` — the itinerary with check-in buttons and undo.
- `client/src/components/admin/DeparturesBoard.tsx` — 6D, on the existing dashboard.
- `client/src/components/admin/CancelRefundPanel.tsx` — 6F, on the booking detail page.

---

## Tasks

### Task 1: The driver session — `driverProcedure` and the login service (6A, server)

**Files:**

- Create: `server/src/services/driver-auth.ts`
- Create: `server/src/routers/public/driver-auth.ts`
- Modify: `server/src/trpc.ts` (add `driverProcedure`), `server/src/routers/_app.ts`, `server/src/app.ts` (mount the limiter), `shared/src/driver.ts` (create), `server/src/services/sessions.ts` (per-subject TTL — **see Q1**)
- Test: `server/src/__tests__/driver-auth.test.ts`

**Interfaces:**

- Consumes: `evaluatePinAttempt`, `MAX_FAILED_ATTEMPTS`, `LOCKOUT_MINUTES`, `MAX_LOCKOUTS_PER_WINDOW`, `LOCKOUT_WINDOW_HOURS` (`services/driver-lockout.ts`); `verifyPassword` (`services/password.ts`); `createSession` / `revokeSession` (`services/sessions.ts`); `writeAudit`.
- Produces:

```ts
// shared/src/driver.ts
export const driverLoginSchema = z
  .object({
    code: z.string().trim().min(1).max(20).toUpperCase(),
    pin: z.string().regex(/^[0-9]{6}$/, 'A PIN is six digits'),
  })
  .strict();

/** §8: "Session lasts 12 hours." See Q1 — this is NOT `SESSION_TTL_MS`. */
export const DRIVER_SESSION_HOURS = 12;

// shared/src/driver.ts — NOT the server. Task 9's login screen builds a
// compiler-exhaustive `Record<DriverLoginRefusal, string>` copy map, exactly
// as Week 5's `AssignRefusal` / `REFUSAL_COPY` pair does, and the client
// cannot import from `server/`. Pre-flight ruling, 2026-10-15.
export type DriverLoginRefusal =
  | 'wrong_credentials'
  | 'locked'
  | 'needs_admin_unlock'
  | 'driver_inactive';

// server/src/services/driver-auth.ts
export interface DriverLoginSuccess {
  ok: true;
  token: string;
  driver: { id: number; name: string; code: string };
}
export async function attemptDriverLogin(input: {
  code: string;
  pin: string;
  now: Date;
}): Promise<DriverLoginSuccess | { ok: false; reason: DriverLoginRefusal }>;

// server/src/trpc.ts
export const driverProcedure: ...; // ctx.driver = { driverId: number }
```

**The lockout, and what is already decided.** `evaluatePinAttempt()` is complete and pure; this task gives it a database and must not re-decide anything it decides. The shape is fixed:

```
1. read the driver row FOR UPDATE by `code`            -- the lock is the whole point
2. refuse `driver_inactive` if `is_active = 0`
3. pinOk = await verifyPassword(pin, row.pin_hash)     -- ALWAYS, even when locked
4. decision = evaluatePinAttempt(stateFrom(row), now, pinOk)
5. persist decision.next onto the row (same transaction)
6. writeAudit for a lockout or an escalation
7. on 'ok', mint a session; otherwise map the outcome to a refusal
```

**`FOR UPDATE` is not optional.** Two requests with the same wrong PIN read `failed_attempts = 4`, both compute 5, and both write 5 — so the fifth and sixth failures count as one and the lockout never fires. The test for this is two concurrent wrong PINs leaving `failed_attempts = 2`, not 1.

**Step 3 runs even when the driver is locked**, which looks wasteful and is deliberate: skipping the hash when `locked_until` is in the future makes a locked account answer measurably faster than an unlocked one, which is a free account-state oracle for anyone probing codes. `evaluatePinAttempt` already refuses a correct PIN during a lockout.

**The refusal messages must not distinguish a wrong code from a wrong PIN.** `wrong_credentials` covers both, exactly as §7's booking lookup does — the test asserts the two responses are **deeply equal**.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/driver-auth.test.ts
describeWithDb('drivers', () => {
  it('signs in with the right code and PIN, and mints a driver session', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    const result = await attemptDriverLogin({ code, pin, now: NOW });
    expect(result).toMatchObject({ ok: true, driver: { id: driverId, code } });

    const [session] = await getDb()
      .select({ subjectType: sessions.subjectType, subjectId: sessions.subjectId })
      .from(sessions)
      .where(eq(sessions.subjectId, driverId));
    expect(session).toEqual({ subjectType: 'driver', subjectId: driverId });
  });

  it('answers IDENTICALLY for a wrong code and a wrong PIN', async () => {
    const { code } = await makeDriverWithPin();
    const wrongPin = await attemptDriverLogin({ code, pin: '000000', now: NOW });
    const wrongCode = await attemptDriverLogin({ code: 'NOSUCH', pin: '123456', now: NOW });
    // Deeply equal, like §7's booking lookup: a difference here tells an
    // attacker which half they got right.
    expect(wrongPin).toEqual(wrongCode);
  });

  it('locks the driver out after exactly five consecutive failures, not four', async () => {
    const { code, driverId } = await makeDriverWithPin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
      expect(await attemptDriverLogin({ code, pin: '000000', now: NOW })).toMatchObject({
        reason: 'wrong_credentials',
      });
    }
    // The FOURTH failure must not lock: the boundary is the point.
    expect((await driverRow(driverId)).lockedUntil).toBeNull();

    expect(await attemptDriverLogin({ code, pin: '000000', now: NOW })).toMatchObject({
      reason: 'locked',
    });
    expect((await driverRow(driverId)).lockedUntil).not.toBeNull();
  });

  it('refuses a CORRECT PIN while the lockout is live', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await lockOut(driverId, NOW);
    expect(await attemptDriverLogin({ code, pin, now: NOW })).toMatchObject({ reason: 'locked' });
  });

  it('lets a correct PIN in once the fifteen minutes have passed', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await lockOut(driverId, NOW);
    const after = new Date(NOW.getTime() + LOCKOUT_MINUTES * 60_000 + 1_000);
    expect(await attemptDriverLogin({ code, pin, now: after })).toMatchObject({ ok: true });
  });

  it('needs an admin after three lockouts in twenty-four hours, and a correct PIN does NOT clear it', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await getDb()
      .update(drivers)
      .set({ requiresAdminUnlock: true, lockoutCount: MAX_LOCKOUTS_PER_WINDOW })
      .where(eq(drivers.id, driverId));
    expect(await attemptDriverLogin({ code, pin, now: NOW })).toMatchObject({
      reason: 'needs_admin_unlock',
    });
    // Still set — only an admin clears it.
    expect((await driverRow(driverId)).requiresAdminUnlock).toBe(true);
  });

  /**
   * THE CARRY-FORWARD from Week 5, which could not be written then because
   * there was no login endpoint: a driver locked out of the portal can sign
   * in IMMEDIATELY after an admin resets their PIN. Week 5 proved the policy
   * function and the credential; this proves the thing a dispatcher actually
   * needs at 5am.
   */
  it('signs in immediately after an admin PIN reset, with no waiting', async () => {
    const { code, driverId } = await makeDriverWithPin();
    await getDb()
      .update(drivers)
      .set({
        failedAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(NOW.getTime() + 9e5),
        lockoutCount: MAX_LOCKOUTS_PER_WINDOW,
        requiresAdminUnlock: true,
      })
      .where(eq(drivers.id, driverId));

    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { pin: newPin } = await api.admin.drivers.resetPin({ id: driverId });

    // Same instant — no timer, no window, no second attempt.
    expect(await attemptDriverLogin({ code, pin: newPin, now: NOW })).toMatchObject({ ok: true });
  });

  it('counts two simultaneous wrong PINs as TWO failures', async () => {
    // Without FOR UPDATE both read 0, both write 1, and the fifth and sixth
    // failures count as one — so the lockout never fires.
    const { code, driverId } = await makeDriverWithPin();
    await Promise.allSettled([
      attemptDriverLogin({ code, pin: '000000', now: NOW }),
      attemptDriverLogin({ code, pin: '111111', now: NOW }),
    ]);
    expect((await driverRow(driverId)).failedAttempts).toBe(2);
  });

  it('refuses a soft-deleted driver', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await getDb().update(drivers).set({ isActive: false }).where(eq(drivers.id, driverId));
    expect(await attemptDriverLogin({ code, pin, now: NOW })).toMatchObject({
      reason: 'driver_inactive',
    });
  });

  it('writes an audit row for a lockout, naming the driver as the actor', async () => {
    const { code, driverId } = await makeDriverWithPin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await attemptDriverLogin({ code, pin: '000000', now: NOW });
    }
    const rows = await auditRowsFor('driver', driverId);
    const lockout = rows.find((r) => r.action === 'driver_locked_out');
    expect(lockout).toBeDefined();
    expect(lockout!.actorType).toBe('driver');
  });

  it('never puts a PIN in an audit row', async () => {
    const { code, pin, driverId } = await makeDriverWithPin();
    await attemptDriverLogin({ code, pin, now: NOW });
    const rows = await auditRowsFor('driver', driverId);
    expect(JSON.stringify(rows)).not.toContain(pin);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- driver-auth`
Expected: FAIL — the module does not exist. (If it reports **skipped**, `describeWithDb` could not see `drivers`: check `rg_travel_test` is migrated, and never repoint a test at `rg_travel`.)

- [ ] **Step 3: Write the per-subject session TTL (owner-decided 2026-10-15, Q1)**

§8 says a driver session is **12 hours**; `SESSION_TTL_MS` (`services/sessions.ts:49`) is 24 and shared by staff, guests and drivers alike. **Do not change the shared constant** — that would silently halve every staff session, which §9 does not ask for.

**A per-subject map, and no optional argument.** The owner's reason: a per-call `ttlMs` is the version someone forgets to pass, and the omission reads as a working session rather than a bug.

```ts
/**
 * How long a session lives, by subject type (owner-decided 2026-10-15, Q1).
 *
 * §8: a DRIVER session lasts 12 hours — a driver's phone spends its day in
 * a van that other people get into, so the window is the working day and
 * not the calendar one. Staff and guests keep the 24 hours they have had
 * since Week 4.
 *
 * The map is the single source of truth. `createSession` reads it by
 * subject; there is deliberately NO per-call override, because an override
 * that is forgotten produces a session that looks fine and lives too long.
 */
export const SESSION_TTL_MS_BY_SUBJECT: Record<SessionSubject, number> = {
  user: 24 * 60 * 60 * 1000,
  customer: 24 * 60 * 60 * 1000,
  driver: 12 * 60 * 60 * 1000,
};
```

Keep `SESSION_TTL_MS` exported if anything still imports it (check first) — but `createSession` must read the map, so the map is what decides.

**Both tests the owner named are required:**

```ts
it('expires a DRIVER session at exactly twelve hours', async () => {
  const token = await createSession('driver', driverId, NOW);
  const justInside = new Date(NOW.getTime() + 12 * 3_600_000 - 1_000);
  const justOutside = new Date(NOW.getTime() + 12 * 3_600_000 + 1_000);
  expect(await readSession(token, justInside)).not.toBeNull();
  expect(await readSession(token, justOutside)).toBeNull();
});

it('expires a STAFF session at exactly twenty-four hours, unchanged', async () => {
  const token = await createSession('user', userId, NOW);
  const justInside = new Date(NOW.getTime() + 24 * 3_600_000 - 1_000);
  const justOutside = new Date(NOW.getTime() + 24 * 3_600_000 + 1_000);
  expect(await readSession(token, justInside)).not.toBeNull();
  expect(await readSession(token, justOutside)).toBeNull();
});

it('keeps the three TTLs independent', () => {
  // A single shared constant reintroduced later fails here, which is the
  // only thing standing between "drivers get 12 hours" and "everyone does".
  expect(SESSION_TTL_MS_BY_SUBJECT.driver).toBe(12 * 3_600_000);
  expect(SESSION_TTL_MS_BY_SUBJECT.user).toBe(24 * 3_600_000);
  expect(SESSION_TTL_MS_BY_SUBJECT.user).not.toBe(SESSION_TTL_MS_BY_SUBJECT.driver);
});
```

`readSession` already takes an explicit `now`, so neither boundary needs a faked clock. **Mutation proof:** point the driver entry at the staff value — the driver boundary test goes red and the staff one stays green.

- [ ] **Step 4: Write `driver-auth.ts`, `driverProcedure` and the router**

Follow the seven-step order above exactly. `driverProcedure` mirrors `customerProcedure` (`trpc.ts:206`) and must **refuse a staff or customer session**, not merely require any session — the test for that is a `staffContext` caller being refused a driver query.

- [ ] **Step 5: Mount the per-IP limiter and expect the guard to go GREEN**

`createDriverLoginLimiter()`'s guard test has been waiting since Week 4: the moment `driver.login` exists it demands the limiter be mounted in `app.ts` **and** that the procedure's exact name appears in `DRIVER_LOGIN_PROCEDURES` — which already reads `['driver.login']`, a name Week 4 proposed and this task confirms. Name the procedure anything else and the guard fails by design, because a procedure-scoped limiter mounted against the wrong name **fails open while looking mounted**. §8: **10 attempts per 15 minutes per IP.** Expect the guard to fail first, then pass once mounted — and say in the report that you saw it fail, because a guard that was already green proves nothing.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test`
Expected: PASS, including `driver-lockout.test.ts` and `procedure-role-metadata.test.ts` **unedited**.

- [ ] **Step 7: Prove the tests can fail — five exact-match mutations**

1. Drop `.for('update')` on the driver read → the two-simultaneous-failures test goes red. **If it stays green the lock is unproven** — log it in `docs/BUGS_LOG.md` and fix the test first.
2. Let a correct PIN clear `requires_admin_unlock` → that test goes red.
3. Return a distinguishable refusal for a bad code → the deeply-equal test goes red.
4. Lock at `MAX_FAILED_ATTEMPTS - 1` → the boundary test goes red.
5. Skip `verifyPassword` when locked → **no test catches this today**; add one that asserts a locked wrong-PIN attempt and a locked right-PIN attempt take comparably long, or state in the report that timing is not testable here and the property rests on the code comment. **Say which.**

- [ ] **Step 8: Commit**

```bash
git add server/src/services/driver-auth.ts server/src/routers/public/driver-auth.ts server/src/trpc.ts server/src/routers/_app.ts server/src/app.ts shared/src/driver.ts server/src/services/sessions.ts server/src/__tests__/driver-auth.test.ts
git commit -m "feat(driver): a PIN, five tries, and a lockout only an admin can lift"
```

**✅ DONE 1**

---

### Task 2: The driver's trip list (6B, server)

**Files:**

- Create: `server/src/routers/public/driver.ts`
- Modify: `shared/src/driver.ts`, `server/src/routers/_app.ts`
- Test: `server/src/__tests__/driver-trips.test.ts`

**Interfaces:**

- Consumes: `driverProcedure` (Task 1), `manilaCivilDate`, `civilDateFromDate`.
- Produces:

```ts
// shared/src/driver.ts
export type DriverTripBucket = 'today' | 'upcoming' | 'history';

/**
 * Which tab a trip belongs in. PURE, and shared, so the tabs and the server
 * cannot disagree about what "today" means — it is the Manila civil date,
 * never the device's.
 */
export function driverTripBucket(tourDate: string, todayManila: string): DriverTripBucket;

export interface DriverTripRow {
  bookingId: number;
  ref: string;
  tourTitle: string;
  tourDate: string;
  pax: number;
  status: BookingStatus;
  vanPlate: string | null;
  bucket: DriverTripBucket;
}
// driver.trips() -> DriverTripRow[]   (ALL of this driver's trips, bucketed)
```

**A driver sees only their own trips, and the filter comes only from the session.** `ctx.driver.driverId`, never an input. Three tests: a driver sees their own, does not see another's, and a staff session is refused the procedure entirely.

**This task owes `procedure-role-metadata.test.ts` a `driver` branch** (carried from Task 1, 2026-10-15). That guard requires every mounted procedure to declare a recognised access type; its `accessOf()` returns `undefined` for `driver`, so Task 1 could only mount the two **public** procedures (`driver.login`, `driver.logout`) and had to prove `driverProcedure`'s gate against a test-local router. **`driver.trips` is the first mounted `driverProcedure`, so it turns that guard red — and the guard is right to go red: it is asking for a declaration nobody has written yet.** Extend it, do not weaken it:

- teach `accessOf()` the `driver` access type;
- require every `driver.*` procedure that is not in the public login pair to be a `driverProcedure`;
- and require each one to refuse **all three** of an anonymous caller, a staff session and a customer session — the guard's existing shape for admin procedures, applied to the third subject type.

A branch that merely stops failing (an early `return`, a widened `undefined` case, an allow-list of names) is the defect this note exists to prevent: it would make every future driver procedure invisible to the only test that checks they are gated at all.

**"Today" is the Manila civil date.** A driver in a van at 00:30 is on today's trips, not tomorrow's — `manilaCivilDate(new Date())` server-side, and `driverTripBucket` is pure so the client can re-bucket without a round trip.

- [ ] **Step 1: Write the failing test**

```ts
it('shows this driver their own trips, bucketed', async () => {
  const api = driverCaller(driverA);
  const trips = await api.driver.trips();
  expect(trips.map((t) => t.ref).sort()).toEqual([todayRef, upcomingRef, pastRef].sort());
  expect(trips.find((t) => t.ref === todayRef)!.bucket).toBe('today');
  expect(trips.find((t) => t.ref === upcomingRef)!.bucket).toBe('upcoming');
  expect(trips.find((t) => t.ref === pastRef)!.bucket).toBe('history');
});

it('NEVER shows one driver another driver trips', async () => {
  const mine = await driverCaller(driverA).driver.trips();
  expect(mine.map((t) => t.bookingId)).not.toContain(theirBookingId);
});

it('refuses a STAFF session the driver procedures', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await expect(api.driver.trips()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

it('refuses a CUSTOMER session the driver procedures', async () => {
  const api = appRouter.createCaller(customerContext(someBookingId) as never);
  await expect(api.driver.trips()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

it('buckets by the MANILA civil date, not the UTC one', () => {
  // 2026-11-10 23:30 Manila is 15:30 UTC the same day; 00:30 Manila on the
  // 11th is 16:30 UTC on the 10th, and a UTC-based bucket would put that
  // driver on yesterday's trips while they are standing next to the van.
  expect(driverTripBucket('2026-11-11', '2026-11-11')).toBe('today');
  expect(driverTripBucket('2026-11-12', '2026-11-11')).toBe('upcoming');
  expect(driverTripBucket('2026-11-10', '2026-11-11')).toBe('history');
});

it('shows a trip reassigned TO this driver mid-trip, and hides one taken away', async () => {
  // Owner Q3 carry-forward from Week 5: the swap exists; this is the half
  // that makes it visible. Both directions, because only testing the
  // gaining driver would pass with a query that never filters at all.
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await api.admin.dispatch.assign({
    bookingId: todayBookingId,
    vanId,
    driverId: driverB,
    reason: 'Reassignment test: swapped mid-trip.',
  });
  expect((await driverCaller(driverB).driver.trips()).map((t) => t.bookingId)).toContain(
    todayBookingId,
  );
  expect((await driverCaller(driverA).driver.trips()).map((t) => t.bookingId)).not.toContain(
    todayBookingId,
  );
});
```

- [ ] **Step 2: Run it and watch it fail** · Run: `pnpm --filter @rg/server test -- driver-trips` · Expected: FAIL, `driver.trips` does not exist.
- [ ] **Step 3: Write `driverTripBucket` in `/shared`, then the router.** The query joins `tours` for the title and `vans` for the plate, filters `bookings.driver_id = ctx.driver.driverId`, and orders `tour_date` ascending.
- [ ] **Step 4: Run the tests and watch them pass.**
- [ ] **Step 5: Prove they can fail.** Replace the session's driver id with an input-supplied one → the other-driver test goes red. Bucket on `toISOString().slice(0,10)` → the Manila test goes red. Drop the `driver_id` filter → both isolation tests go red.
- [ ] **Step 6: Commit** · `feat(driver): a driver sees their own trips, and only their own`

**✅ DONE 2**

---

### Task 3: Trip progress — one answer, two surfaces (6B/6D, server)

**Files:**

- Create: `server/src/services/trips/progress.ts`
- Modify: `shared/src/driver.ts`
- Test: `server/src/__tests__/trip-progress.test.ts`

**Interfaces:**

```ts
export interface TripProgressStop {
  /** `null` for the trip-start pseudo-stop. */
  stopId: number | null;
  name: string;
  sortOrder: number;
  checkedAt: string | null; // ISO instant, server time
  undone: boolean;
}
export interface TripProgress {
  bookingId: number;
  status: BookingStatus;
  /** Trip start first, then `tour_itinerary_stops` by `sort_order`. */
  stops: TripProgressStop[];
  /** Stops checked in and not undone, over total. For the admin's bar. */
  done: number;
  total: number;
}
export async function tripProgress(tx: Transaction, bookingId: number): Promise<TripProgress>;
```

**Why this is its own module.** The driver's itinerary and the admin's "stop-by-stop progress bar" are the same question. Two implementations would drift, and the drift would show as a dispatcher ringing a driver who has already checked in. **An undone check-in counts as not done** — that is the whole purpose of `undone`.

- [ ] **Step 1: Write the failing test** — stops in `sort_order` with trip start first; an undone check-in counts as not done; `done`/`total` exact; a trip with no check-ins is `0 / n`; `checked_at` is the **server** time (assert it is within seconds of `now`, not equal to a value the caller passed).
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement it** — two queries (stops, then checkpoints), joined in memory; never one query per stop.
- [ ] **Step 4: Run and pass.**
- [ ] **Step 5: Prove it can fail.** Count undone rows as done → that test goes red. Order by `stop_id` instead of `sort_order` → the ordering test goes red.
- [ ] **Step 6: Commit** · `feat(trips): one progress answer for the driver and the dispatcher`

**✅ DONE 3**

---

### Task 4: Trip detail and the payment box (6B, server)

**Files:** Modify `server/src/routers/public/driver.ts`, `shared/src/driver.ts` · Test: `server/src/__tests__/driver-trip-detail.test.ts`

**Interfaces:**

```ts
export type PaymentBoxState =
  | { kind: 'collect_cash'; amountCentavos: number }
  | { kind: 'fully_paid' }
  | { kind: 'unverified_do_not_collect' };

export interface TripDetail {
  bookingId: number;
  ref: string;
  tourTitle: string;
  tourDate: string;
  pax: number;
  status: BookingStatus;
  leadName: string;
  leadPhone: string;
  pickup: string | null;
  pickupMapsUrl: string | null;
  vanPlate: string | null;
  officeNotes: string[];
  payment: PaymentBoxState;
  progress: TripProgress;
}
// driver.trip({ bookingId }) -> TripDetail
```

**§8's payment box is three states and the middle one is the dangerous one.** `unverified_do_not_collect` means a payment exists but nobody has verified it — the driver must **not** collect, and the copy says to call the office. Deriving that wrongly either takes money twice or lets a guest ride free. **The state is computed server-side** and the client only renders it, so there is one place to get it right:

- `fully_paid` — `amount_paid_centavos >= total_centavos`.
- `unverified_do_not_collect` — a `pending` manual payment exists, **or** `payment_review_required` is set.
- `collect_cash` — otherwise, for `total - amount_paid`.

**A driver sees the guest's phone, and that is deliberate** (§8: call/text/WhatsApp) — but only for **their own** trip, which is why this procedure is `driverProcedure` and filters on the session's driver id. A driver asking for another driver's `bookingId` gets `NOT_FOUND`, **not** `FORBIDDEN`: a 403 confirms the booking exists.

- [ ] **Step 1: Write the failing test** — all three payment states with exact amounts; `NOT_FOUND` for another driver's booking (and assert the message does not name the booking); the `pending`-cash case resolving to `unverified_do_not_collect`; `payment_review_required` doing the same; office notes present.
- [ ] **Step 2–4: fail, implement, pass.**
- [ ] **Step 5: Prove it can fail.** Compute the balance client-side → not applicable, so instead: make `unverified` fall through to `collect_cash` → that test goes red; return `FORBIDDEN` instead of `NOT_FOUND` → the enumeration test goes red.
- [ ] **Step 6: Commit** · `feat(driver): a payment box that says do not collect when it means it`

**✅ DONE 4**

---

### Task 5: Start, check in, complete (6C, server)

**Files:** Create `server/src/services/trips/checkins.ts` · Modify `server/src/routers/public/driver.ts` · Test: `server/src/__tests__/trip-checkins.test.ts`

**Interfaces:**

```ts
// shared/src/driver.ts, for the same reason as `DriverLoginRefusal`: Task 10
// maps every member to copy a driver reads in a van, and an exhaustive
// `Record<CheckInRefusal, string>` is what makes the compiler catch a member
// added later with no sentence behind it. Pre-flight ruling, 2026-10-15.
export type CheckInRefusal =
  | 'not_your_trip'
  | 'trip_not_startable'
  | 'already_checked_in'
  | 'unknown_stop'
  | 'trip_not_started'
  | 'nothing_to_undo';
export async function startTrip(tx, { bookingId, driverId, now }): Promise<...>;
export async function checkInStop(tx, { bookingId, driverId, stopId, now }): Promise<...>;
export async function completeTrip(tx, { bookingId, driverId, now }): Promise<...>;
```

**Four rules, each tested:**

1. **`stop_id` only — never `stop_key`.** It is `GENERATED ALWAYS`, and an INSERT naming it is rejected by MySQL. Write `stop_id`; `stop_key` follows as `COALESCE(stop_id, 0)`.
2. **The unique index is the double-tap guard, not a check-then-insert.** A driver on a bumpy road double-taps "Arrived"; two requests race; a `SELECT` then `INSERT` lets both through. Insert and catch the duplicate with `isDuplicateKeyError()` (`server/src/db/duplicate-key.ts` — Drizzle wraps mysql2 and moves the driver's code onto `.cause`, so never hand-roll the check against `error.code`) → `already_checked_in`. **Do not** pre-check. Task 6 adds one branch inside that catch — an `undone` row is reactivated rather than refused (owner-decided 2026-10-15, Q5) — and it is deliberately a recovery _after_ the collision, so the index stays the thing that arbitrates the race.
3. **A `pending_verification` booking CAN be started** (owner-accepted 2026-10-15, Q2). The guests are standing there; the payment box already says not to collect. A `confirmed` booking has no van and no driver and so cannot be started by anyone — that is `trip_not_startable`.
4. **Start sets the booking `in_progress` AND the van `on_trip`.** Complete sets `completed` **and puts the van back to `available`** — see Task 7, which owns the clearing and its test.
5. **Timestamps are server time.** `checked_at` comes from the server, never from an input. There is no device-clock field to trust.
6. **The audit action strings are fixed here, because Task 6 and Task 12 assert them: `trip.started`, `trip.checked_in`, `trip.completed`**, with Task 6 adding `trip.checkin_undone` and `trip.completion_undone`. **Dotted, not snake_case** — ruling 2026-10-15, after Task 1 found that `evaluatePinAttempt()` already returns `driver.locked_out` and that the dotted form is what the core code uses (`auth.login`, `auth.login_failed`, `booking.held`, `booking.expired`, `payment.cash_collected`, `payment.verified`, `review.submitted`). Week 5's `driver_created` / `van_updated` are the outliers; do not copy them, and do not rename them either — that is a separate commit nobody has asked for. `actor_type` is `'driver'`, and **`entity` is the plural `'bookings'`**: Week 5 shipped a singular `'booking'` that made an audit row invisible in the detail trail, caught by reading the query rather than the write.

- [ ] **Step 1: Write the failing test** — start from `assigned` succeeds; **start from `pending_verification` also succeeds** (Q2, and assert the payment box still says `unverified_do_not_collect`); start twice is `already_checked_in` (via the unique index, proven by two **concurrent** calls); start from `confirmed` (no van) is `trip_not_startable`; another driver's booking is `not_your_trip`; a stop from a different tour is `unknown_stop`; checking in before starting is `trip_not_started`; the last stop completes the trip; `checked_at` is server time (within seconds of `now`, never a value the caller passed).
- [ ] **Step 2–4: fail, implement, pass.**
- [ ] **Step 5: Prove it can fail.** Replace the duplicate-key catch with a `SELECT`-then-`INSERT` → the concurrent double-tap test goes red. Write `stop_key` explicitly → MySQL rejects every insert and every test goes red (confirm that, then restore). Accept a caller-supplied timestamp → the server-time test goes red.
- [ ] **Step 6: Commit** · `feat(driver): taps that cannot double-count, on server time`

**✅ DONE 5**

---

### Task 6: Undo the last check-in (6C, server)

**Files:** Modify `server/src/services/trips/checkins.ts`, `server/src/routers/public/driver.ts` · Test: `server/src/__tests__/trip-checkins.test.ts`

```ts
export async function undoLastCheckIn(
  tx,
  { bookingId, driverId, reason, now },
): Promise<{ ok: true; stopId: number | null } | { ok: false; reason: CheckInRefusal }>;
```

**§8: "Undo last check-in (only the most recent; marked `undone`, not deleted)."** With the owner's two decisions of 2026-10-15, this task has five rules and none of them is open:

- **Only the most recent**, by `checked_at` among rows where `undone = false`. Undoing an arbitrary stop would let a driver rewrite the trip's history after the fact.
- **Marked, never deleted.** `undone = true`, `undone_at = now`, `undone_by = driverId`. `CLAUDE.md` forbids hard deletes, and "arrived 10:15, retracted 10:16" versus "retracted three days later, after the complaint" are very different facts in a refund argument.
- **Undoing a completion restores the previous state exactly** (owner-decided 2026-10-15, Q4): the booking goes back to **`in_progress`** and the van back to **`on_trip`**, audited with the actor and a **required reason**. A mistaken completion must not free a van that is still on the road — Task 7 makes `on_trip` unsellable, so leaving the van `available` would offer dispatch a van with guests in it.
- **A re-check-in REACTIVATES the row** (owner-decided 2026-10-15, Q5). This is Task 5's `checkInStop`, specified here because it is the same invariant: an existing `undone` row is **updated** — fresh `checked_at`, `undone` false, `undone_at` and `undone_by` **cleared** — never duplicated. **The unique index stays**; it is what makes a double-tap safe.
- **Every check-in, undo and re-check-in writes `audit_log`** with `actor_type = 'driver'`. One row per stop means the row itself cannot show that a stop was claimed, retracted and re-claimed — the audit trail is where that history lives, and it is the reason one row per stop is acceptable at all.

- [ ] **Step 1: Write the failing test**

```ts
it('marks the newest check-in undone and leaves the earlier ones alone', async () => {
  await startTrip(...);
  await checkInStop(..., { stopId: first });
  await checkInStop(..., { stopId: second });
  await undoLastCheckIn(..., { reason: 'Tapped the wrong stop.' });

  const rows = await checkpointRows(bookingId);
  expect(rows.find((r) => r.stopId === second)!.undone).toBe(true);
  expect(rows.find((r) => r.stopId === first)!.undone).toBe(false);
});

it('keeps the row — an undo is never a delete', async () => {
  await startTrip(...);
  await checkInStop(..., { stopId: first });
  await undoLastCheckIn(..., { reason: 'Mis-tap.' });

  const [row] = (await checkpointRows(bookingId)).filter((x) => x.stopId === first);
  expect(row).toBeDefined();
  expect(row.undone).toBe(true);
  expect(row.undoneAt).not.toBeNull();
  expect(row.undoneBy).toBe(driverId); // a DRIVER, not an admin
});

it('undoes the next-newest on a second undo, not the same row twice', async () => {
  /* two check-ins, two undos, both rows undone and the earlier one undone second */
});

it('refuses `nothing_to_undo` when every row is already undone', async () => {
  /* ... */
});

it('refuses another driver undoing your check-in', async () => {
  /* ... */
});

it('requires a reason', async () => {
  await expect(api.driver.undoCheckIn({ bookingId, reason: '' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

/* --- Q5: tap → undo → tap again, one row throughout --- */

it('lets the same stop be checked in again after an undo, reusing the one row', async () => {
  await startTrip(...);
  await checkInStop(..., { stopId: first, now: T1 });
  await undoLastCheckIn(..., { reason: 'Tapped before we actually arrived.' });
  const again = await checkInStop(..., { stopId: first, now: T2 });

  expect(again).toMatchObject({ ok: true });
  const rows = (await checkpointRows(bookingId)).filter((r) => r.stopId === first);
  expect(rows).toHaveLength(1); // reactivated, not duplicated
  expect(rows[0].undone).toBe(false);
  expect(rows[0].undoneAt).toBeNull();
  expect(rows[0].undoneBy).toBeNull();
  expect(rows[0].checkedAt.getTime()).toBe(T2.getTime()); // the NEW time
});

it('still cannot create two rows for one stop without an undo', async () => {
  // The test that keeps the one above from being implemented by weakening
  // the unique index. Concurrent, because a bumpy-road double-tap IS a race
  // and a sequential pair would pass against a check-then-insert.
  await startTrip(...);
  const settled = await Promise.allSettled([
    checkInStop(..., { stopId: first }),
    checkInStop(..., { stopId: first }),
  ]);
  const rows = (await checkpointRows(bookingId)).filter((r) => r.stopId === first);
  expect(rows).toHaveLength(1);
  const outcomes = settled.map(settledOutcome);
  expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
  expect(outcomes.filter((o) => o === 'already_checked_in')).toHaveLength(1);
});

it('writes an audit row for the check-in, the undo AND the re-check-in', async () => {
  await startTrip(...);
  await checkInStop(..., { stopId: first });
  await undoLastCheckIn(..., { reason: 'Mis-tap.' });
  await checkInStop(..., { stopId: first });

  const actions = (await auditRowsFor('driver', driverId)).map((r) => r.action);
  expect(actions.filter((a) => a === 'trip.checked_in')).toHaveLength(2);
  expect(actions).toContain('trip.checkin_undone');
});

/* --- Q4: undoing a completion puts the van back out --- */

it('restores in_progress and on_trip when a completion is undone', async () => {
  await startTrip(...);
  await completeTrip(...);
  await undoLastCheckIn(..., { reason: 'Completed by mistake — still at the last stop.' });

  expect((await bookingRow(bookingId)).status).toBe('in_progress');
  expect((await vanRow(vanId)).status).toBe('on_trip');
});

it('does NOT offer that van for any date while it is back on_trip', async () => {
  // The owner's named test, and it reads AVAILABILITY rather than the
  // column: the column proves the write happened, not that dispatch
  // honours it. A van with guests in it must not be sellable.
  await startTrip(...);
  await completeTrip(...);
  expect(await assess(tourId, FUTURE_DATE, 2)).toEqual({ ok: true });

  await undoLastCheckIn(..., { reason: 'Completed by mistake.' });
  expect(await assess(tourId, FUTURE_DATE, 2)).toEqual({ ok: false, reason: 'no_van_available' });

  // Scoped to the van THIS test created, not `toEqual([])`. The test
  // database keeps an empty fleet, but a sibling test file creating its own
  // van would turn an exact-emptiness assertion into a flaky test wearing a
  // precise number — Week 5's lesson, applied.
  const free = await vansFreeOn(getDb(), FUTURE_DATE, 2);
  expect(free.map((v) => v.id)).not.toContain(vanId);
});

it('audits the undone completion with the actor and the reason', async () => {
  await startTrip(...);
  await completeTrip(...);
  await undoLastCheckIn(..., { reason: 'Completed by mistake.' });
  const row = (await auditRowsFor('driver', driverId)).find(
    (r) => r.action === 'trip.completion_undone',
  );
  expect(row).toBeDefined();
  expect(row!.actorType).toBe('driver');
  expect(JSON.stringify(row!.detail)).toContain('Completed by mistake.');
});
```

- [ ] **Step 2: Run it and watch it fail** · Run: `pnpm --filter @rg/server test -- trip-checkins` · Expected: FAIL — `undoLastCheckIn` does not exist.

- [ ] **Step 3: Implement the undo and the reactivation.** The reactivation lives in `checkInStop` (Task 5's function): on a duplicate-key collision, read the existing row — if `undone` is true, UPDATE it back to live; if it is false, refuse `already_checked_in`. That ordering matters. The insert stays the first move, so the unique index is still what arbitrates a race, and the undone-row branch is a recovery rather than a pre-check.

- [ ] **Step 4: Run the tests and watch them pass.**

- [ ] **Step 5: Prove they can fail — five exact mutations**

1. `DELETE` instead of marking → the row-still-exists test goes red.
2. Pick the oldest un-undone row → the newest-only test goes red.
3. On the duplicate-key collision, refuse unconditionally instead of reactivating → the tap→undo→tap test goes red.
4. Reactivate without checking `undone` (so any duplicate tap re-stamps the time) → the double-tap test goes red.
5. Leave the van `available` when a completion is undone → the availability test goes red. **If it stays green the test is reading the column, not dispatch** — fix the test first.

**Clean up after every mutation proof.** These run inside the booking the test owns, but a mutation that lets a refused call succeed can leave an extra `trip_checkpoints` row — the leak detector names `bookings`, `drivers`, `vans`, `payments` and `users`, **not** checkpoints, so check that table by hand before moving on.

- [ ] **Step 6: Commit** · `feat(driver): an undo that marks rather than erases, and a stop you can re-record`

**✅ DONE 6**

---

### Task 7: `on_trip`, set and cleared — the Week 5 carry-forward

**Files:** Modify `server/src/services/trips/checkins.ts` · Test: `server/src/__tests__/trip-van-status.test.ts`

**Task 5 writes the status changes; this task PROVES them.** `on_trip` is set and cleared inside `startTrip` and `completeTrip`, in their own transactions — splitting the write out would ship a window in which a started trip has an `available` van, which is the bug. So if Task 5 did it correctly, **this task's diff is tests plus the `CLAUDE.md` edit and nothing else**, and the report must say so rather than re-implement what already works (`CLAUDE.md`: build additively). Pre-flight ruling, 2026-10-15.

**It exists at all because of a trap Week 5 recorded and could not close.** `VAN_STATUS_SELLABLE` makes `available` the **only** sellable status, so a van left `on_trip` is refused by `assessCapacity()` on **every future date**. The symptom is "we're fully booked" on a day with four idle vans, weeks later, with nothing in the logs. 6C is the first code to write `on_trip`; this task owns both halves.

- [ ] **Step 1: Write the failing test**

```ts
it('puts the van on_trip when the trip starts', async () => { /* ... */ });

it('puts the van BACK to available when the trip completes', async () => {
  await startTrip(...);
  await completeTrip(...);
  expect((await vanRow(vanId)).status).toBe('available');
});

it('makes the van sellable again for a FUTURE date after completion', async () => {
  // The test that matters. A van stuck `on_trip` is refused by
  // assessCapacity on every future date, and nothing else notices.
  await startTrip(...);
  const duringTrip = await assess(tourId, FUTURE_DATE, 2);
  await completeTrip(...);
  const afterTrip = await assess(tourId, FUTURE_DATE, 2);
  expect(duringTrip).toEqual({ ok: false, reason: 'no_van_available' });
  expect(afterTrip).toEqual({ ok: true });
});

it('does not touch a van that is for_repair', async () => {
  // Completing a trip must not make a broken van sellable.
  await getDb().update(vans).set({ status: 'for_repair' }).where(eq(vans.id, vanId));
  await completeTrip(...);
  expect((await vanRow(vanId)).status).toBe('for_repair');
});
```

- [ ] **Step 2–4: fail, implement, pass.**
- [ ] **Step 5: Prove it can fail.** Remove the clearing on complete → the future-date test goes red. That mutation is the whole point of this task; if it stays green, the test is not reading capacity.
- [ ] **Step 6: Update `CLAUDE.md`** — its Dispatch section says "whatever sets it must also clear it". Change that to say what now does, and name this task's test as the thing keeping it true.
- [ ] **Step 7: Commit** · `fix(fleet): a van that finishes a trip is bookable again`

**✅ DONE 7**

---

### Task 8: Cash collected (6C, server) — wiring, not inventing

**Files:** Modify `server/src/routers/public/driver.ts` · Test: `server/src/__tests__/driver-cash.test.ts`

**`recordPendingCash()` already exists, is tested, and is exactly §8 item 5.** This task gives it a procedure and **adds no path of its own**. A reviewer should reject any new `payments` insert in this task.

**Cash is a today-only action** (owner-accepted 2026-10-15, Q9): the procedure refuses a trip whose tour date is not today in Manila, **and** Task 10 hides the button. Hiding alone is not a control — a driver tapping "collect cash" on next week's trip is almost certainly a mis-tap, and the refusal is what makes it harmless.

- [ ] **Step 1: Write the failing test** — the driver's claim writes **one** `pending` row with `collected_by_driver_id` set; **the booking does not move** (`amount_paid_centavos`, `status` and `payment_review_required` all unchanged — snapshot before and after); the audit row is `actor_type = 'driver'`; another driver's booking is refused; **a trip dated tomorrow is refused server-side** and one dated today is accepted, with the Manila civil date deciding (Q9); **a driver cannot verify their own collection** (`verifyCashPayment` with a driver actor is refused — this already holds, and the test states it here, where someone might otherwise add a shortcut).
- [ ] **Step 2–4: fail, implement, pass.**
- [ ] **Step 5: Prove it can fail.** Credit `amount_paid_centavos` in the procedure → the booking-does-not-move test goes red, **and** `schema-conventions.test.ts` fails because only `record-payment.ts` may write that column. Both should fire; say so in the report. Drop the today check → the tomorrow test goes red. Build "today" from UTC instead of Manila → add the 00:30-Manila case that catches it, or say in the report that the window is not exercised at that edge.
- [ ] **Step 6: Commit** · `feat(driver): cash collected is a claim, not a reconciliation`

**✅ DONE 8**

---

### Task 9: The driver portal shell and sign-in (6A, client)

**Files:** Create `client/src/components/layout/DriverLayout.tsx`, `client/src/pages/driver/DriverLoginPage.tsx`, `client/src/components/driver/PinPad.tsx` · Modify `client/src/App.tsx` · Test: `client/src/__tests__/driver-login.test.tsx`

**Design — run `ui-ux-pro-max` first, and this screen is used standing up in a van:**

```
python scripts/search.py "touch target size spacing" --domain ux -n 3
python scripts/search.py "numeric keypad input mobile" --domain ux -n 3
python scripts/search.py "error clarity inline validation" --domain ux -n 3
```

Binding decisions:

- **One-handed, 360px, thumb-reachable.** The PIN pad sits in the **lower two-thirds** of the screen. A driver is holding a phone in one hand beside a van, not sitting at a desk.
- **Digits, not a text field.** `inputMode="numeric"`, `autoComplete="one-time-code"`, and **no** `type="password"` masking by default (owner-accepted 2026-10-15, Q6) — a driver mistyping a PIN they cannot see, five times, is a lockout and a phone call to the office. A show/hide toggle, defaulting to **visible**, because the realistic threat beside a van is a mistype rather than a shoulder-surfer.
- **The lockout copy must say what to do.** "Locked for 15 minutes" and "Ask the office to reset your PIN" are different sentences and the second one is the only useful thing to say when `needs_admin_unlock` comes back. Never show the attempt count — it tells a shoulder-surfer how many tries are left.
- **No red.** A lockout is **amber**; a wrong PIN is dark blue/grey.
- Tap targets ≥ 44px via `tap-target`, which on this screen should be comfortably larger.

- [ ] **Step 1: Write the failing test** — the pad enters six digits and submits; `wrong_credentials` shows one generic message naming neither field; `locked` shows the fifteen-minute sentence; `needs_admin_unlock` shows the ask-the-office sentence and **not** the timer one; no attempt count appears anywhere; every control carries `tap-target`; the PIN is not rendered into the DOM as a masked value the test can read back (assert on the input's `value` only via the control, never via a snapshot).
- [ ] **Step 2–4: fail, implement, pass**, then `pnpm --filter @rg/client test -- no-red contrast`.
- [ ] **Step 5: Prove it can fail.** Render the attempt count → that test goes red. Collapse the two lockout messages into one → the `needs_admin_unlock` test goes red.
- [ ] **Step 6: Commit** · `feat(driver): a sign-in a thumb can manage beside a van`

**✅ DONE 9**

---

### Task 10: The three tabs, the trip, and the itinerary (6B/6C, client)

**Files:** Create `client/src/pages/driver/DriverTripsPage.tsx`, `client/src/pages/driver/DriverTripPage.tsx`, `client/src/components/driver/PaymentBox.tsx`, `client/src/components/driver/StopList.tsx` · Modify `client/src/App.tsx` · Test: `client/src/__tests__/driver-trips-page.test.tsx`, `client/src/__tests__/driver-trip-page.test.tsx`

**Design — run `ui-ux-pro-max` first:**

```
python scripts/search.py "bottom nav limit tabs" --domain ux -n 3
python scripts/search.py "destructive action confirmation" --domain ux -n 3
python scripts/search.py "submit feedback loading state" --domain ux -n 3
```

Binding decisions:

- **Three tabs, bottom-anchored** — Today / Upcoming / History. Within the five-item bottom-nav ceiling, and reachable by thumb.
- **The payment box is the loudest thing on the trip screen**, and `unverified_do_not_collect` is **amber with words**: "Do not collect — call the office." Never a colour alone, never red. A driver glancing at a phone must not read "don't collect" as "collect".
- **"Collect ₱X cash" states the amount in words and figures**, and the cash button **confirms inline** before submitting — a mis-tap claims money was taken. Confirmation is two-step in place, not a modal (no `dialog` is vendored).
- **The stop list is a checklist, not a form.** One large button per stop, in itinerary order, each showing its check-in time once tapped. The **undo** control appears only against the most recent un-undone check-in, because that is the only one the server will accept.
- **Optimistic UI is forbidden here.** A tap must show pending and then the server's answer. A stop that appears checked-in and later is not is worse than a half-second wait, because the driver has already driven away.
- Tailwind transitions only; respect `prefers-reduced-motion`.

- [ ] **Step 1: Write the failing test** — the tabs bucket correctly from one `driver.trips` payload; all three payment states render with their exact copy; the unverified state shows words and not only amber; the cash button needs confirmation and calls nothing when cancelled; stops render in order; undo appears **only** on the newest un-undone stop; a pending tap disables the button and shows feedback; nothing is optimistic (a failed check-in leaves the stop unchecked).
- [ ] **Step 2–4: fail, implement, pass**, then the guard suites.
- [ ] **Step 5: Prove it can fail.** Render undo on every stop → that test goes red. Make the check-in optimistic → the failed-check-in test goes red. Drop the words from the unverified box → the colour-alone test goes red.
- [ ] **Step 6: Commit** · `feat(driver): three tabs, one checklist, and a payment box that is unmistakable`

**✅ DONE 10**

---

### Task 11: The verification queue — what 6E still needs (6E)

**Files:** Modify `server/src/routers/admin/bookings.ts` (if a cash branch is missing), `client/src/pages/admin/AdminBookingDetailPage.tsx` · Test: `server/src/__tests__/admin-cash-verify.test.ts`

**6E is smaller than its spec line suggests, and the report must say so rather than claim new work.** Week 4 Task 7 already built the receipt queue: list, preview, approve, reject-with-reason, and the portal reflecting it. `verifyCashPayment()` already exists and is tested. What is genuinely missing is the **cash** half of the queue surface: a driver-collected `pending` row needs to appear for finance and be approvable through `verifyCashPayment` — with the driver named, because "who says they took this money" is the question finance is answering.

- [ ] **Step 1: Read `admin.bookings.list`/`detail` and the Week 4 queue, and write down in the report exactly what exists** before writing code. If the cash rows already appear, this task is a test-only task and should say so.
- [ ] **Step 2: Write the failing test** — a driver-collected `pending` row appears in the queue with the driver's name; finance approves it and `amount_paid_centavos` is credited **exactly once** (two concurrent approvals credit once, the second refused — under the booking lock); **a driver cannot approve**; approving does **not** insert a second `payments` row (count before and after).
- [ ] **Step 3–5: fail, implement, pass, prove.** Drop the booking lock in the verify path → the concurrent test goes red. **If it stays green it is two sequential calls**, not a race — fix the test first.
- [ ] **Step 6: Commit** · `feat(admin): the cash a driver says they took, verified exactly once`

**✅ DONE 11**

---

### Task 12: Live departures on the dashboard (6D)

**Files:** Create `server/src/routers/admin/departures.ts`, `client/src/components/admin/DeparturesBoard.tsx` · Modify `server/src/routers/_app.ts`, `client/src/pages/admin/AdminDashboardPage.tsx` · Test: `server/src/__tests__/admin-departures.test.ts`, `client/src/__tests__/departures-board.test.tsx`

**Interfaces:** `admin.departures.today()` → `Array<{ bookingId; ref; tourTitle; driverName; vanPlate; status; progress: TripProgress }>`, built on **Task 3's `tripProgress`** — not a second progress query.

**§9: "Check-ins update the admin dashboard within ~15 seconds (polling is fine; no websockets needed)."** So: a 15-second `refetchInterval`, and the existing dashboard page replaces its "arrives in Week 6" line with this board. The progress bar must **state its numbers in text** (`3 of 7 stops`) — a bar alone is colour and length, which is exactly what `CLAUDE.md` forbids as the only signal.

- [ ] **Step 1: Write the failing test** — today's departures only (Manila civil date); an `in_progress` trip shows its progress; a completed one shows full; **an undone check-in reduces the count**; all three roles may read it (§9 gives the Dashboard to everyone); the progress text appears as words.
- [ ] **Step 2–5: fail, implement, pass, prove.** Count undone rows as done → that test goes red. Build "today" from UTC → the Manila test goes red.
- [ ] **Step 6: Commit** · `feat(admin): today's departures, with the numbers written out`

**✅ DONE 12**

---

### Task 13: Cancel and refund (6F)

**Files:** Create `server/src/routers/admin/refunds.ts`, `client/src/components/admin/CancelRefundPanel.tsx` · Modify `server/src/routers/_app.ts`, `client/src/pages/admin/AdminBookingDetailPage.tsx` · Test: `server/src/__tests__/admin-refunds.test.ts`

**Everything dangerous here already exists and is tested.** `recordPayment({ type: 'refund', … })` enforces the always-positive amount, the sum never exceeding `amount_paid_centavos`, the booking row lock, admin-only, and the audit row. `provider.refund()` exists on the PayMongo provider. **This task composes them; it does not reimplement any of it.**

Four rules from §6:

1. **Refund through the provider that TOOK the payment**, read from the payment row — never the currently-active provider. A gateway switch would otherwise send refunds to the wrong company.
2. **A refund is never a booking status.** Cancelling sets `cancelled`; the refund is a `payments` row.
3. **Partial refunds are allowed**, so the sum check matters and must happen **under the lock**.
4. **A webhook may confirm a refund an admin initiated; it may never initiate one.**

- [ ] **Step 1: Write the failing test** — a full refund records one positive `refund` row and leaves the booking `cancelled`; two partial refunds summing to the paid amount are allowed and a third is refused; **two concurrent refunds do not exceed `amount_paid`** (overlapping transactions, exactly one wins); a manual payment refunds as an offline record with a method and reference and **calls no gateway**; the provider used is the one on the payment row, proven with a payment row whose provider differs from the active one; finance may refund and **dispatcher may not**; the audit row names the admin.
- [ ] **Step 2–5: fail, implement, pass, prove.** Read the active provider instead of the row's → that test goes red. Drop the lock → the concurrent test goes red; **if it stays green the test is not concurrent.**
- [ ] **Step 6: Commit** · `feat(admin): refunds that cannot pay out more than came in`

**✅ DONE 13**

---

### Task 14: The driver walkthrough, and closing the week

**Files:** Create `docs/superpowers/plans/2026-10-XX-week6-walkthrough.md` · Modify `docs/BUILD_SPEC.md` (§13 Week 6 + Week 7 carry-forwards), `CLAUDE.md`

Not a code task. Drive every 6A–6F flow against the running app **over HTTP with a real session cookie**, the way Week 5's pass did — `createCaller` bypasses the context factory, the cookie, the origin check and the role middleware, so a pass there proves none of them.

- [ ] **Step 1:** Sign a driver in with a code and PIN; confirm the session is 12 hours (or whatever Q1 settled).
- [ ] **Step 2:** Five wrong PINs → locked. Three lockouts → needs an admin. Admin resets → **signs in immediately**.
- [ ] **Step 3:** Today/Upcoming/History, and a driver asking for another driver's trip id getting `NOT_FOUND`.
- [ ] **Step 4:** Start → stops → complete, with a deliberate double-tap, and an undo. Confirm the van goes `on_trip` and comes back `available`, and that a future date becomes bookable again.
- [ ] **Step 5:** All three payment-box states against real bookings.
- [ ] **Step 6:** Collect cash → confirm the booking did not move → finance verifies → `amount_paid_centavos` credited once, one row for its whole life.
- [ ] **Step 7:** The dashboard showing the trip's progress within ~15 seconds.
- [ ] **Step 8:** Cancel with a partial refund, then a second that would exceed the paid amount being refused.
- [ ] **Step 9:** **Open the portal in a 360px browser window and use it one-handed.** Week 5's walkthrough named the browser as its largest gap; for a driver portal it is not an acceptable gap. Record what you actually saw.
- [ ] **Step 10:** Clean up every row and account the pass created, and confirm `rg_travel_test` still has an empty fleet.
- [ ] **Step 11:** Update §13's Week 6 preamble (it currently says "Nothing in this week is built", which has gone stale three weeks running), carry anything unfinished into Week 7's preamble, and add to `CLAUDE.md` the standing facts this week establishes.
- [ ] **Step 12:** Five checks, each separately with its exit code, then **✅ WEEK 6 COMPLETE** — with anything mocked or unproven named in the marker itself.

**✅ DONE 14**

---

## Which test proves which constraint

| Constraint                                             | Proven by                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Five failures lock, four do not                        | Task 1's boundary test                                               |
| A correct PIN never clears `requires_admin_unlock`     | Task 1                                                               |
| Two simultaneous wrong PINs count twice                | Task 1's concurrency test, with `FOR UPDATE` deleted as the mutation |
| A wrong code and a wrong PIN are indistinguishable     | Task 1's deeply-equal test                                           |
| An admin reset lets a driver in immediately            | Task 1 (the Week 5 carry-forward)                                    |
| A driver sees only their own trips                     | Task 2's isolation tests, plus Task 4's `NOT_FOUND`                  |
| A mid-trip reassignment moves the trip between drivers | Task 2 (owner Q3 carry-forward), both directions                     |
| "Today" is Manila, not UTC                             | Task 2 and Task 12                                                   |
| A double-tap cannot double-count a stop                | Task 5's concurrent test, via the unique index                       |
| Check-in times are server time                         | Task 5                                                               |
| An undo marks and never deletes                        | Task 6                                                               |
| Only the most recent check-in can be undone            | Task 6                                                               |
| **A van that finishes a trip is bookable again**       | **Task 7's future-date capacity test**                               |
| A driver's cash claim moves no money                   | Task 8, plus `schema-conventions.test.ts`                            |
| A driver cannot verify their own collection            | Task 8 and Task 11                                                   |
| One handful of cash is one `payments` row for its life | Task 11's row-count test                                             |
| Cash is credited exactly once under contention         | Task 11's concurrent approval test                                   |
| Refunds never exceed what was paid                     | Task 13's concurrent refund test                                     |
| A refund goes to the provider that took the money      | Task 13                                                              |
| Progress is one answer for driver and dispatcher       | Task 3, consumed by Tasks 4 and 12                                   |
| No red anywhere                                        | the existing `no-red` guard, run in Tasks 9, 10, 12, 13              |
| Meaning never by colour alone                          | Task 10's payment-box test, Task 12's progress-text test             |

---

## Questions — ALL ANSWERED (owner-decided / owner-accepted 2026-10-15)

**The plan was approved with answers to every question below.** Q1, Q4 and Q5 were decided explicitly; Q2, Q3 and Q6–Q10 were **owner-accepted** as the plan's stated defaults. Nothing here is open, and no task waits on an answer — each question keeps its reasoning so the decision can be re-read later with the argument that produced it.

### Q1 — The driver session is 12 hours; `SESSION_TTL_MS` is 24 (BLOCKS Task 1)

§8 says "Session lasts 12 hours". `services/sessions.ts` has a single `SESSION_TTL_MS = 24 * 60 * 60 * 1000`, shared by staff, customer and driver sessions, with a comment explaining the 24 hours in terms of a **guest's** booking-ref login.

**Changing the shared constant would silently halve every staff session**, which §9 does not ask for.

**Options:** (a) a per-subject TTL map — `{ user: 24h, customer: 24h, driver: 12h }` — and `createSession` picks by subject; (b) an optional `ttlMs` argument on `createSession`, defaulting to the current constant, with the driver path passing 12 hours; (c) 24 hours for drivers too, and amend §8.

**Default if unanswered:** (a). It puts every session's lifetime in one visible place, and a per-call argument is the version someone forgets to pass.

**ANSWER (owner-decided 2026-10-15): option (a) — a per-subject TTL map.** Driver sessions last **12 hours**; staff (`user`) and guest (`customer`) sessions keep the 24 hours they have today. **No optional `ttlMs` argument** — the map is the single source of truth, because a per-call argument is the version someone forgets to pass and the omission reads as a working session.

Required tests: **each subject's expiry at the exact boundary** (a driver session valid at 12h minus a second and expired at 12h plus a second; the same for staff at 24h), and **changing the driver's TTL cannot alter the staff one** — assert both values independently so a single shared constant reintroduced later fails the suite.

### Q2 — Which trips may a driver start? (Task 5)

The plan allows `assigned` → `in_progress`. A `confirmed` booking has no van and no driver, so it cannot be started by anyone. But **`pending_verification` can now be pre-assigned** (owner Q2, Week 5) — so a driver can be holding a trip whose money is unverified.

**Should a driver be able to START such a trip?** The payment box already tells them not to collect. Starting it is arguably right — the guests are standing there — and arguably wrong, since nobody has confirmed they paid.

**Default if unanswered:** allow it. Refusing leaves a driver with guests, a van, and a screen that will not let them begin; the payment box already carries the warning, and §8's box exists precisely for this case.

**ANSWER (owner-accepted 2026-10-15): the plan's default — allow it.** A driver may start a trip on a `pending_verification` booking. Refusing would leave a driver with guests, a van and a screen that will not let them begin; §8's payment box already carries the warning, and `unverified_do_not_collect` exists precisely for this case.

### Q3 — Does a driver see a trip before its tour date? (Task 2)

"Upcoming" implies yes, but how far? All future assigned trips, or a window?

**Default if unanswered:** all of them, ordered soonest first. A driver planning their week is the point of the tab, and the list is bounded by how much work one driver has.

**ANSWER (owner-accepted 2026-10-15): the plan's default — all future assigned trips, soonest first.** No window. A driver planning their week is the point of the tab, and the list is bounded by one driver's workload.

### Q4 — Undoing a completion: does the van go back out? (BLOCKS Task 6)

If the last stop completed the trip and the driver undoes it, the booking leaves `completed`. **Does the van return to `on_trip`?**

It must do _something_: leaving it `available` means a van that is still out is offered to dispatch, and §5's capacity could sell it. But `on_trip` is also what Task 7 clears on completion, so the two interact.

**Options:** (a) undo restores the previous state exactly — booking back to `in_progress`, van back to `on_trip`; (b) undo of a completion is refused entirely, and only an admin can reopen a completed trip; (c) undo works and the van stays `available`, accepting the window.

**Default if unanswered:** (a). It is what "undo" means, and (c) can oversell a van that is physically on the road.

**ANSWER (owner-decided 2026-10-15): option (a) — undo restores the previous state exactly.** Undoing a completion puts the booking back to **`in_progress`** and the van back to **`on_trip`**. Audited with the **actor and a reason**.

Required test: **after the undo, that van is NOT offered for any date it is `on_trip` for** — assert against the real availability module and `assessCapacity()`, not against the column. A van physically still on the road must not be sellable, and reading the column only proves the write happened, not that dispatch honours it.

### Q5 — Can a stop be checked in again after an undo? (Task 6)

The unique index is on `(booking_id, stop_key)` and an undone row **still exists**, so a second check-in of the same stop will hit the index and be refused. That makes undo a one-way door: a driver who taps the wrong stop, undoes it, and then arrives there for real cannot record it.

**Options:** (a) the check-in path treats an existing **undone** row as re-usable — update it back to `undone = false` with a fresh `checked_at` rather than inserting; (b) accept the one-way door and tell the driver to call the office; (c) change the index.

**Default if unanswered:** (a), as an UPDATE of the undone row. It keeps the index intact, keeps one row per stop, and the audit trail still shows the retraction. **(c) is not on the table** — the index is what makes a double-tap safe.

**ANSWER (owner-decided 2026-10-15): option (a) — re-recording REACTIVATES the existing row.** A second check-in at a stop whose row is `undone` **updates that row**: a fresh `checked_at`, `undone` back to false, and `undone_at` / `undone_by` **cleared**. No second row is inserted and **the unique index stays** — it is what makes a double-tap safe.

**Every check-in, undo and re-check-in writes `audit_log`** (`actor_type = 'driver'`), so one row per stop still leaves a complete history of what was claimed, retracted and re-claimed.

Required tests: **tap → undo → tap again at the same stop succeeds**, and **a double-tap with no undo in between still cannot create two rows**. The second test is what keeps the first from being implemented by weakening the index.

### Q6 — Is the PIN masked as it is typed? (Task 9)

A masked PIN is the convention; an unmasked one is kinder in a van, and five mistyped attempts is a lockout plus a phone call to the office.

**Default if unanswered:** visible by default with a show/hide toggle, since the realistic threat in a van is a mistype rather than a shoulder-surfer. Say the word and it flips.

**ANSWER (owner-accepted 2026-10-15): the plan's default — visible by default, with a show/hide toggle.** The realistic threat beside a van is a mistype, and five mistypes is a lockout plus a phone call to the office.

### Q7 — WhatsApp from the driver's phone (Task 4/10)

§8 wants call/text/WhatsApp buttons. `CLAUDE.md` permits the WhatsApp brand colours as a documented exception, **icon-only with an `aria-label`** and no white text, with any wording outside the pill.

**Confirm:** the same treatment as the public site, which is the plan's assumption.

**ANSWER (owner-accepted 2026-10-15): the plan's default — the same treatment as the public site.** `CLAUDE.md`'s documented brand-colour exception: icon-only pills with an `aria-label`, no white text on any of the three colours, any wording outside the pill in brand ink.

### Q8 — Does a driver's completion notify anyone? (Task 5/12)

§11 lists notification events; "trip completed" reaching the office by email is not in §13's 6A–6F list, and the dashboard polls anyway.

**Default if unanswered:** no notification. The dashboard updates within fifteen seconds and §13 does not ask for one.

**ANSWER (owner-accepted 2026-10-15): the plan's default — no notification on completion.** The dashboard polls within ~15 seconds and §13 does not ask for one.

### Q9 — May a driver collect cash on a trip that is not today? (Task 8)

Nothing stops it technically. A driver tapping "collect cash" on next week's trip is almost certainly a mis-tap.

**Default if unanswered:** restrict the cash button to a trip whose tour date is **today** in Manila, and refuse server-side as well as hiding it client-side. Hiding alone is not a control.

**ANSWER (owner-accepted 2026-10-15): the plan's default — today only, enforced server-side.** The cash button is hidden unless the tour date is today in Manila, **and** the procedure refuses a non-today trip. Hiding alone is not a control.

### Q10 — Who may cancel a booking? (Task 13)

§9's matrix gives "Cancel / refund" to **owner and finance**, not dispatcher. §6 says "Admin cancels a booking".

**Default if unanswered:** `ROLE_MATRIX.cancelRefund` as it stands — owner and finance — with the dispatcher refused and a test for it.

---

**ANSWER (owner-accepted 2026-10-15): the plan's default — `ROLE_MATRIX.cancelRefund` as it stands: owner and finance.** Verified in source: `require-role.ts:48` reads `cancelRefund: ['owner', 'finance']`. The dispatcher is refused, with a test.

## Self-review

**1. Spec coverage.** §13's Week 6 lines map as: **6A** → Tasks 1 + 9; **6B** → Tasks 2 + 3 + 4 + 10; **6C** → Tasks 5 + 6 + 7 + 8 + 10; **6D** → Task 12; **6E** → Task 11; **6F** → Task 13. §8's login and three stacked limits → Task 1 (the per-driver halves already exist as a pure function; this week adds the database and the per-IP limiter). §8's views → Tasks 2, 4, 10. §8's payment box, all three states → Task 4 + Task 10. §8's check-ins 1–5 → Tasks 5, 6, 8. §8's "driver may not verify their own collection" → Tasks 8 and 11. §6's refunds → Task 13. §9's live departures → Task 12. The three Week 5 carry-forwards → Task 1 (PIN-reset sign-in), Task 2 (mid-trip reassignment visible), Task 7 (`on_trip` cleared).

**Gaps I am declaring rather than hiding:**

- **A driver's "upcoming trips" on the ADMIN drivers screen** (§9) is still unbuilt. Week 5 declared it; this week does not add it either, because it is an admin-surface read and 6A–6F is the driver's side. It is a small task whenever the owner wants it.
- **The day-before reminder email** (§11) and **SMS** (§11, optional) remain unscheduled, as they have since Week 4.
- **The live gateway check** remains blocked on the PayMongo account. Task 13 exercises `provider.refund()` against the mock only; a real refund has never been issued. That is the same blocking pre-launch item `LAUNCH_CHECKLIST.md` already carries.
- **No notification fires on assignment or completion.** Not in §13's list for this week.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Tasks 1, 7 and the interface blocks carry full test code; Tasks 3–6 and 8–13 carry full test **case lists** plus the exact mutation that must turn each one red, with code deferred where a listed question gates the shape (Q1 for Task 1's TTL, Q4/Q5 for Task 6, Q2 for Task 5). Those are named limits, not placeholders — and the three questions that gate code are marked as blocking.

**3. Type consistency.** Checked across tasks: `TripProgress` / `TripProgressStop` are defined in Task 3 and consumed unchanged by Task 4 (`TripDetail.progress`) and Task 12 (the departures board). `DriverTripBucket` and `driverTripBucket(tourDate, todayManila)` are defined in Task 2 and reused by Task 10's tabs. `PaymentBoxState`'s three variants are the only states Task 10 renders. `CheckInRefusal`'s six members are the only refusals Tasks 5, 6 and 10 map to copy — and, like Week 5's `AssignRefusal`, the union lives in a place the client can import so the copy map is exhaustive by the compiler. `DriverLoginRefusal`'s four members are the only ones Task 9's login screen handles. `driverProcedure` is produced by Task 1 and consumed by Tasks 2, 4, 5, 6 and 8.

**4. One thing I want to flag rather than bury.** Three of this week's six spec lines are **mostly already built** — 6E's receipt queue shipped in Week 4, and both halves of 6F's dangerous money logic shipped with the core schema. The risk in those tasks is not writing them; it is **writing them again**. Task 11 opens by requiring the implementer to read what exists and report it before touching code, and Task 13 says in its first line that it composes rather than implements. If either task's diff contains a new `payments` insert or a second refund path, that is a defect however well-tested it is.
