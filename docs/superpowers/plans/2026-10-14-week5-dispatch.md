# Week 5 — Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dispatcher can manage the fleet and the drivers, see the month at a glance, assign a van and a driver to every confirmed booking without ever double-booking either, and be warned by the dashboard before a trip, a licence or a franchise becomes a problem.

**Architecture:** One availability module is the single source of truth for "which van and which driver are free on this date", and everything else reads it — the dispatch dropdowns, the auto-suggest, and the agreement test that keeps it honest against `assessCapacity()`. On top of that sit four thin layers: two CRUD surfaces (vans; drivers + leaves + PIN reset), a month calendar that is a pure read, one assignment mutation that writes under the fleet date lock, and a dashboard that is five independent alert queries. Nothing in this week touches money, and the only schema change it proposes is gated on a question.

**Tech Stack:** Existing only — React 19 + TS + Vite 7 + Tailwind v4 + the shadcn/ui primitives already vendored (`accordion`, `badge`, `button`, `card`, `input`, `label`, `select`), Express 5 + tRPC v11, Drizzle 0.44.7 + MySQL 8.0.46, Zod v4, `express-rate-limit`, `node-cron`, Vitest. **No new dependencies.** See **Q8** for why this plan does not add shadcn's `table`, `dialog` or `switch`.

**Spec:** `docs/BUILD_SPEC.md` — §5 (capacity, holds, booking statuses, assignment rule), §9 (roles, dashboard, calendar, vans, drivers), §10 (tables), §12 (security), §13 Week 5 (5A–5E), §15 open question 1.

## Global Constraints

Copied verbatim from `CLAUDE.md` and `docs/BUILD_SPEC.md`. Every task's requirements implicitly include this section.

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display. **This week writes no money at all.** If a task finds itself touching `amount_paid_centavos` or any `payments` row, it is out of scope — stop and ask.
- **Only a verified webhook or an admin approval marks a booking paid.** Assignment is not payment: assigning a van must never change a payment field, a payment status, or `bookings.amount_paid_centavos`.
- **Never hard-delete a booking or a payment.** Vans and drivers are soft-deleted through `is_active` (`CLAUDE.md`, "Soft deletes") — there is deliberately **no delete mutation in this plan** for either.
- **Time:** store **UTC**; compute business dates in **Asia/Manila**. A tour date is a **civil date** (`YYYY-MM-DD`), never an instant. Use `manilaCivilDate()` / `manilaParts()` / `manilaInstant()` from `shared/src/time.ts` — no task does its own date arithmetic.
- **Audit:** every status change and assignment writes to `audit_log` via `writeAudit(tx, …)`.
- **Validation:** Zod on every input, schemas shared from `/shared`.
- **NO RED ANYWHERE** — including errors, badges and destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`). `client/src/__tests__/no-red.test.ts` fails the build if red reappears. An expiry alert is **amber**, however urgent it is.
- **Contrast:** AA (4.5:1). `brand-gold-600` **fails** AA for normal-size text — small gold text uses `brand-gold-700` or darker. `brand-gold-600` stays fine for non-text uses (a dot, an icon). `client/src/__tests__/contrast.test.ts` reads real source, so a new pairing is checked without anyone updating a fixture list.
- **Mobile-first, must work at 360px.** 44px minimum tap targets, visible focus states, alt text on every image.
- **Never convey information by colour alone** (WCAG 1.4.1). This binds §9's "**gold dot** = needs assignment" — see Task 9.
- **Use `ui-ux-pro-max` for every screen in this plan** (owner instruction, standing since 2026-10-13). Motion only after layout exists, via `emilkowalski-motion`, subtle, respecting `prefers-reduced-motion`.
- **Role middleware on every admin procedure, plus a test per role per area.** `procedure-role-metadata.test.ts` requires **everything in an `admin.*` namespace to be an `adminProcedure`** — a new router that forgets it fails that test, which is the point.
- **DO NOT let one role reach another role's endpoints. Hiding a button is not access control.**
- **Ports:** client **5180**, server **3100**. Never 5173 or 3000. Test database is `rg_travel_test`; never point a test at `rg_travel`.
- **Data Privacy Act (RA 10173):** a driver's phone, licence number and emergency contact are personal data. Admin-only, and never rendered on a public or portal surface.
- **Every new test must be proven able to fail.** Break the covered code, confirm red, restore. Security controls and destructive operations must fail closed, with a test for the failure path.
- **Verify before pushing — all five, in this order:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Run them **separately and report each exit code**; piping them through `tail` swallows the status and has already caused one misdiagnosis in this project.
- **After any schema change, remind the owner to apply the migration on the server database.** There is still **no server database** — it does not exist yet, so no task here runs a remote migration.
- **Check the next migration number yourself** before generating one. `0009` is the highest applied; do not assume `0010` is free without looking.

---

## What already exists — read this before Task 1

Verified against the tree at `973d6d1` and against `information_schema` on `rg_travel` (30 tables, 10 migrations, 2026-10-14). **No task in this plan rebuilds anything in this table.**

| Thing                             | State                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vans` table                      | **Exists with every §9 field**: `plate` (unique), `model`, `capacity`, `status`, `odometer`, `last_service`, `next_service`, `orcr_expiry`, `franchise_no`, `franchise_expiry`, `repair_notes`, `is_active`. Index `vans_active_status_idx (is_active, status, capacity)` — **its column order is load-bearing**; the comment in `schema.ts` explains why, and it must not be rearranged. |
| `VAN_STATUSES`                    | `['available', 'on_trip', 'for_repair']` — **three, where §9 names four.** `parked` does not exist. See **Q1**, which gates Task 2.                                                                                                                                                                                                                                                       |
| `drivers` table                   | **Exists with every §9 field** plus the five lockout columns (`failed_attempts`, `locked_until`, `lockout_count`, `lockout_window_started_at`, `requires_admin_unlock`), `pin_hash`, `license_no`, `license_expiry`, `languages` (JSON), `emergency_contact`, `status`, `is_active`.                                                                                                      |
| `DRIVER_STATUSES`                 | `['available', 'on_trip', 'off_duty']`.                                                                                                                                                                                                                                                                                                                                                   |
| `driver_leaves` table             | **Exists.** `start_date`/`end_date` are civil dates, **inclusive at both ends**, with a DB CHECK `end_date >= start_date`. **Two overlapping leaves for one driver are still possible** — a known, logged, service-layer gap.                                                                                                                                                             |
| `bookings.van_id` / `.driver_id`  | **Exist**, nullable, FK to `vans.id` / `drivers.id`. Index `bookings_driver_date_idx (driver_id, tour_date)` exists. **There is no `(van_id, tour_date)` index** — Task 3 adds it.                                                                                                                                                                                                        |
| `assessCapacity()`                | **Exists** (`server/src/services/capacity.ts`) and is the booking-time gate. Gate 2 counts vans as `is_active AND status <> 'for_repair' AND capacity >= pax`; Gate 3 counts drivers as `is_active AND NOT EXISTS (a leave covering that date)`. **Both are counts, never identities** — it never says _which_ van.                                                                       |
| `takeSlotLocks(tx, tourId, date)` | **Exists.** Takes `fleet_date_slots(date)` **then** `tour_date_slots(tour_id, date)`, in that order, creating rows on demand. The order is global and absolute.                                                                                                                                                                                                                           |
| `CAPACITY_HOLDING_STATUSES`       | **Exists** in `/shared` — the five statuses that hold capacity. Never restate the list; import it.                                                                                                                                                                                                                                                                                        |
| Roles                             | `ROLE_MATRIX` in `server/src/middleware/require-role.ts` already has **`assignVanDriver: ['owner','dispatcher']`** and **`vansDrivers: ['owner','dispatcher']`**. Both areas this week needs exist; no role work is required.                                                                                                                                                             |
| `adminProcedure(area)`            | **Exists** and fails closed. It re-validates the role inside the middleware and **replaces** `ctx.session` with the narrowed one.                                                                                                                                                                                                                                                         |
| tRPC context                      | **Exists** (`server/src/context.ts`). `ctx.session` is a `StaffSession` — `{ subjectType, subjectId, role }`, where `subjectId` is `users.id`.                                                                                                                                                                                                                                            |
| Admin surface                     | `AdminLoginPage`, `AdminBookingsPage`, `AdminBookingDetailPage` at `/admin/login`, `/admin/bookings`, `/admin/bookings/:ref`. **There is no admin layout, no admin nav and no dashboard route.** The three pages are standalone.                                                                                                                                                          |
| Admin router                      | `server/src/routers/admin/` holds `auth.ts` and `bookings.ts` only. `admin.bookings.list` / `.detail` are `adminProcedure('bookingsView')`; `.approveReceipt` / `.rejectReceipt` are `adminProcedure('verifyPayments')`.                                                                                                                                                                  |
| Test harness                      | **Exists**: `__tests__/helpers/ctx.ts` (`staffContext(userId, role)`, `customerContext(bookingId)`, `testContext()`), `helpers/db.ts` (`describeWithDb`, which **skips** rather than silently passing when the table it probes is absent), and `appRouter.createCaller(...)`.                                                                                                             |
| Manila time helpers               | **Exist** in `shared/src/time.ts`: `manilaCivilDate(now)`, `manilaParts(date)`, `manilaInstant(civilDate, hhmm)`, `bookableDateRange()`, `isDateBookable()`.                                                                                                                                                                                                                              |
| `writeAudit(tx, entry)`           | **Exists.** `{ actorType, actorId, action, entity, entityId, data? }`; a cron is `system`, a webhook is `provider`, both with a null `actorId`.                                                                                                                                                                                                                                           |
| shadcn primitives                 | Only `accordion`, `badge`, `button`, `card`, `input`, `label`, `select` are vendored. **No `table`, `dialog`, `switch`, `textarea`, `checkbox` or `tabs`.** `AdminBookingsPage` uses a semantic `<table>` with Tailwind plus a card list below `md:` — that is the house pattern. See **Q8**.                                                                                             |
| `trip_checkpoints`                | **Exists**, but nothing writes to it yet. §9's dashboard also wants "today's departures with stop-by-stop progress bars" — that is **Week 6 (6D)**, not 5E. This week's dashboard ships **alerts only**, and says so on screen rather than leaving a blank panel.                                                                                                                         |

## What the spec asks for that does not exist yet

- No vans router, no drivers router, no leaves handling, no PIN reset.
- No calendar query and no calendar screen.
- No assignment mutation. **Nothing in this codebase has ever written `bookings.van_id` or `bookings.driver_id`** — grepping `vanId:` across `server/src/routers` and `server/src/services` returns nothing outside `schema.ts`. **Task 10 is the first writer in the project's history**, which is why it carries the concurrency tests rather than trusting the ones that already exist.
- No dashboard query and no dashboard screen.
- No `parked` van status (**Q1**).
- No per-van index for "what is this van doing on this date" (Task 3).

---

## File Structure

**The availability module — the piece everything else leans on**

- `server/src/services/dispatch/availability.ts` — `vansFreeOn()` and `driversFreeOn()`. **One responsibility: turning a date into the identities of the vans and drivers free on it.** It is the only place that encodes §9's exclusion rules, so the dropdown, the auto-suggest and the assignment re-check cannot drift apart — and a drift here is a van sent to two trips on one morning.
- `server/src/services/dispatch/assign.ts` — `assignVanAndDriver()`: the locked transaction that writes `bookings.van_id`, `bookings.driver_id`, the status move to `assigned`, and the audit row. A separate file from `availability.ts` because one reads and one writes, and the writer is the dangerous half.
- `server/src/services/dispatch/suggest.ts` — `suggestAssignment()`: smallest van that fits, least-loaded free driver. Pure selection over what `availability.ts` returned, with no queries of its own beyond those two calls.
- `server/src/services/dispatch/alerts.ts` — §9's five dashboard alerts, one exported function each, so a reviewer can reject one alert without touching the other four.

**Shared contracts** (client and server must agree, so they live in `/shared`)

- `shared/src/dispatch.ts` — the Zod schemas (`vanInputSchema`, `driverInputSchema`, `driverLeaveInputSchema`, `assignInputSchema`, `calendarMonthSchema`) and the three thresholds: `UNASSIGNED_ALERT_HOURS`, `SERVICE_DUE_DAYS`, `PAPERS_EXPIRING_DAYS`. **Thresholds are constants in `/shared`, never magic numbers in SQL or JSX** — the 48, the 14 and the 30 each appear exactly once in the codebase.

**Routers**

- `server/src/routers/admin/vans.ts` — `admin.vans.list | create | update | setStatus`.
- `server/src/routers/admin/drivers.ts` — `admin.drivers.list | create | update | addLeave | removeLeave | resetPin`.
- `server/src/routers/admin/calendar.ts` — `admin.calendar.month` (the month read) and `admin.calendar.dayOptions` (the exclusion-filtered dropdown contents for one booking).
- `server/src/routers/admin/dispatch.ts` — `admin.dispatch.assign`, `admin.dispatch.suggest`.
- `server/src/routers/admin/dashboard.ts` — `admin.dashboard.alerts`.

**Client**

- `client/src/components/layout/AdminLayout.tsx` — the shell: skip link, nav, sign-out, `<Outlet/>`. Four new screens hang off it and the three Week 4 pages move into it.
- `client/src/pages/admin/AdminDashboardPage.tsx` — 5E.
- `client/src/pages/admin/AdminVansPage.tsx` — 5A.
- `client/src/pages/admin/AdminDriversPage.tsx` — 5B.
- `client/src/pages/admin/AdminCalendarPage.tsx` — 5C, with the 5D assignment UI inside it.
- `client/src/components/admin/AlertCard.tsx` — one alert: amber, its count, its link.
- `client/src/components/admin/MonthGrid.tsx` — the 7-column month grid and the day cell, including the needs-assignment marker.
- `client/src/components/admin/AssignPanel.tsx` — the two dropdowns, the auto-suggest button, the confirmation.
- `client/src/components/admin/EntityForm.tsx` — the shared labelled-field form shell both CRUD screens use, so the vans form and the drivers form cannot disagree about where an error appears.

---

## The one idea this week turns on

**`assessCapacity()` counts; dispatch must identify.** Those are different questions, and the gap between them is where this week's only serious bug lives.

At booking time, §5's rule is `MIN(groups_per_day, vans free that day across all tours)`, and `assessCapacity()` answers it by counting: how many vans fit this group, minus how many bookings already hold capacity that day. It never records _which_ van, because at booking time no van is chosen — §5 is explicit that "bookings confirm automatically; van + driver are assigned later by dispatch."

Dispatch asks the other question: _which_ van, specifically, is free on this date. The exclusion list is per-van (`already booked that day, in repair, or too small`), and the answer is a list of identities, not a number.

**The two must agree in one direction and are allowed to disagree in the other.** If checkout accepted a booking, dispatch must be able to fulfil it — otherwise the business sold a trip it cannot run. The reverse is not required: dispatch may well find vans free that capacity had already counted against the day, because capacity deducts _every_ capacity-holding booking from the fleet whether or not that booking has a van yet. So:

- **Required:** every booking `assessCapacity()` accepted can be assigned a van and a driver.
- **Permitted:** `vansFreeOn()` returns more vans than `assessCapacity()`'s arithmetic implied.
- **Forbidden:** `vansFreeOn()` returns a van that is already assigned to another capacity-holding booking on that date, or that is `for_repair`, inactive, or too small.

Task 3 writes that as a test rather than as a comment, because the asymmetry is exactly the kind of thing a later change "simplifies" into a bug.

---

## Tasks

### Task 1: The admin shell

**Files:**

- Create: `client/src/components/layout/AdminLayout.tsx`
- Modify: `client/src/App.tsx` (admin routes become children of the layout)
- Test: `client/src/__tests__/admin-layout.test.tsx`

**Interfaces:**

- Consumes: `trpc.staffAuth.me` and `trpc.staffAuth.logout` (both exist, Week 4 Task 5).
- Produces: `AdminLayout` (default export, no props — it renders `<Outlet/>`), and the five admin nav destinations every later task links into: `/admin` (dashboard), `/admin/bookings`, `/admin/calendar`, `/admin/vans`, `/admin/drivers`.

Four new screens are coming and the three Week 4 pages are currently standalone routes with no way to get from one to another. The shell is built first so no later task invents its own navigation.

**Design (run `ui-ux-pro-max` before writing JSX):** query `"skip link keyboard navigation"` and `"bottom nav limit"` in `--domain ux`, and `"table dialog select form" --stack shadcn`. The guidance that binds here: a **skip link** is required on a nav-heavy page ("100 tabs to reach content" is the anti-pattern), tab order must match visual order, and a sticky nav must not overlap the first section — if the nav is `h-14`, the main region carries the matching padding.

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/__tests__/admin-layout.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import AdminLayout from '@/components/layout/AdminLayout';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<p>dashboard body</p>} />
          <Route path="vans" element={<p>vans body</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminLayout', () => {
  it('renders a skip link that targets the main region', () => {
    renderAt('/admin');
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip.getAttribute('href')).toBe('#admin-main');
    expect(document.getElementById('admin-main')).not.toBeNull();
  });

  it('renders the child route inside the main region', () => {
    renderAt('/admin/vans');
    const main = document.getElementById('admin-main');
    expect(main?.textContent).toContain('vans body');
  });

  it('marks the current section with aria-current, not with colour alone', () => {
    renderAt('/admin/vans');
    const current = screen.getByRole('link', { name: /vans/i });
    expect(current.getAttribute('aria-current')).toBe('page');
    // Every other nav link must NOT claim to be current.
    const others = screen
      .getAllByRole('link')
      .filter((a) => a !== current && a.getAttribute('aria-current') !== null);
    expect(others).toEqual([]);
  });

  it('gives every nav link a 44px tap target', () => {
    renderAt('/admin');
    for (const link of screen.getAllByRole('link')) {
      if (/skip to main/i.test(link.textContent ?? '')) continue;
      expect(link.className).toMatch(/tap-target/);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- admin-layout`
Expected: FAIL — `Failed to resolve import "@/components/layout/AdminLayout"`.

- [ ] **Step 3: Write `AdminLayout.tsx`**

A `<header>` with the nav, a `<main id="admin-main">` holding `<Outlet/>`, and the skip link as the first focusable thing in the DOM. Follow `PublicLayout.tsx` for the house conventions. Rules this component must satisfy, each of which the tests above pin:

- the skip link is first in the DOM, visually hidden until focused (`sr-only focus:not-sr-only`), and points at `#admin-main`;
- the current section is marked `aria-current="page"` **and** styled — the styling is the redundant half, never the only signal;
- every nav link carries `tap-target`;
- the operator's name and role come from `staffAuth.me`; a sign-out button calls `staffAuth.logout` and then navigates to `/admin/login`;
- nav labels: Dashboard, Bookings, Calendar, Vans, Drivers. **Five**, which is the bottom-nav ceiling the UX guidance names, so the mobile layout can use the same five without a "more" menu.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rg/client test -- admin-layout`
Expected: PASS (4 tests).

- [ ] **Step 5: Prove the tests can fail**

Delete the `href="#admin-main"` attribute, re-run, confirm the first test goes red. Restore. Then change `aria-current="page"` to `aria-current="true"`, confirm the third test goes red, restore. **A test that stays green through both mutations is a bug — log it in `docs/BUGS_LOG.md`.**

- [ ] **Step 6: Nest the existing admin routes under the layout**

In `App.tsx`, the three Week 4 admin routes become children of a `<Route path="admin" element={<AdminLayout />}>`. **`admin/login` stays outside it** — a login page must not render a nav that assumes a session. Keep the existing comments about `X-Robots-Tag` and `noindex` intact.

- [ ] **Step 7: Five checks and commit**

```bash
pnpm lint; pnpm typecheck; pnpm --filter @rg/client test; pnpm format:check
git add client/src/components/layout/AdminLayout.tsx client/src/App.tsx client/src/__tests__/admin-layout.test.tsx
git commit -m "feat(admin): a shell the four dispatch screens can hang off"
```

**✅ DONE 1**

---

### Task 2: The fourth van status, and an allow-list for sellable fleet — ✅ Q1 ANSWERED

**Owner-decided 2026-10-14 (Q1).** Add §9's `parked`, and change `assessCapacity()`'s Gate 2 from
the deny-list `status <> 'for_repair'` to the **allow-list `status = 'available'`**. A new or
unknown status is excluded by default — the gate fails closed.

**Files:**

- Modify: `server/src/db/schema.ts` (`VAN_STATUSES`, plus the new `VAN_STATUS_SELLABLE`)
- Modify: `server/src/services/capacity.ts` (Gate 2 → allow-list)
- Create: `server/src/db/migrations/00NN_vans_parked_status.sql` (**check the next free number yourself**)
- Test: `server/src/__tests__/capacity-van-status.test.ts`

**Interfaces:**

- Produces: `VAN_STATUSES` including `'parked'`, and **`VAN_STATUS_SELLABLE = 'available'`** — the
  single allow-listed status, which **Task 3 imports** so `vansFreeOn()` and `assessCapacity()`
  cannot disagree about what a status means. There is deliberately **no** `VAN_STATUSES_UNAVAILABLE`
  export: a list of what is forbidden is the deny-list this task exists to remove, and leaving one
  in the codebase invites the next person to filter on it.

**Why the allow-list, in one sentence a reviewer can check the code against.** A deny-list makes
every status anyone adds later sellable until somebody notices; an allow-list makes it unsellable
until somebody decides. The first direction oversells a trip, the second refuses a booking, and
only one of those strands a guest at a pier.

**The `on_trip` consequence, which must be written into the schema comment, not just here.**
`on_trip` is now unsellable. §9 intends it as a derived _today_ status ("'On tour' is derived from
in-progress trips"), and nothing in the codebase sets or clears it yet — check-ins are Week 6 (6C)
— so today no van is ever `on_trip` and this costs nothing. **When Week 6 starts writing `on_trip`
it must also clear it**, or a van that drove one trip stops being bookable for every future date.
Put that sentence in the comment beside `VAN_STATUSES`, where whoever builds 6C will read it.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/capacity-van-status.test.ts
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getDb } from '../db/client';
import { VAN_STATUSES, VAN_STATUS_SELLABLE, vans } from '../db/schema';
import { assessCapacity } from '../services/capacity';
import { describeWithDb } from './helpers/db';

it('names all four statuses from BUILD_SPEC §9', () => {
  expect([...VAN_STATUSES].sort()).toEqual(['available', 'for_repair', 'on_trip', 'parked']);
});

it('allow-lists exactly one status as sellable', () => {
  expect(VAN_STATUS_SELLABLE).toBe('available');
});

it('exports no deny-list for anyone to filter on by mistake', async () => {
  const schema = await import('../db/schema');
  expect(Object.keys(schema)).not.toContain('VAN_STATUSES_UNAVAILABLE');
});

describeWithDb('vans', () => {
  /**
   * The owner's first named test: EVERY non-available status is excluded.
   * Written as a loop over VAN_STATUSES rather than three hand-written
   * cases, so a fifth status added later is covered the day it is added
   * instead of the day someone remembers this file.
   */
  it.each(VAN_STATUSES.filter((s) => s !== VAN_STATUS_SELLABLE))(
    'does not count a %s van as sellable fleet',
    async (status) => {
      const db = getDb();
      await db.update(vans).set({ status }).where(eq(vans.id, onlyVanId));
      const verdict = await db.transaction((tx) => assessCapacity(tx, { tourId, date, pax: 2 }));
      expect(verdict).toEqual({ ok: false, reason: 'no_van_available' });
    },
  );

  it('counts an available van as sellable fleet', async () => {
    const db = getDb();
    await db.update(vans).set({ status: 'available' }).where(eq(vans.id, onlyVanId));
    const verdict = await db.transaction((tx) => assessCapacity(tx, { tourId, date, pax: 2 }));
    expect(verdict).toEqual({ ok: true });
  });
});
```

**Ruling (controller, 2026-10-14): the owner's SECOND named Q1 test lives in Task 3, not here.**
The owner named two tests — every non-`available` status excluded (above, in full), and _capacity
and dispatch availability agree_. The second one has to import `vansFreeOn`, which **Task 3
creates**, so written here it would not compile. It is therefore a **requirement on Task 3**, which
owns both modules, and Task 3's brief carries it. Both named tests get written; only the file
differs. Do not attempt the agreement assertion in this task, and do not import anything from
`services/dispatch/` here.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- capacity-van-status`
Expected: FAIL — `VAN_STATUS_SELLABLE` is not exported, and a `parked` van is still counted as
sellable fleet by Gate 2's deny-list.

- [ ] **Step 3: Add the status, export the allow-list, and make Gate 2 an allow-list**

```ts
// server/src/db/schema.ts
/**
 * §9's four van statuses.
 *
 * `on_trip` is DERIVED, not administrative: §9 says "'On tour' is derived
 * from in-progress trips", and the other three are set by hand.
 *
 * **Week 6 (6C) owes this list a clearing step.** Nothing writes `on_trip`
 * today, so nothing has to clear it. The moment check-ins start setting it,
 * they must also unset it when a trip completes — a van left `on_trip`
 * stops being sellable on EVERY future date, because `VAN_STATUS_SELLABLE`
 * below allow-lists `available` alone.
 */
export const VAN_STATUSES = ['available', 'on_trip', 'parked', 'for_repair'] as const;

/**
 * The ONLY status a van may have to be sold or dispatched (owner decision
 * 2026-10-14, Q1).
 *
 * An allow-list, deliberately, replacing the deny-list `status <> 'for_repair'`
 * that `assessCapacity()` used until now. A deny-list makes every status
 * added later sellable until somebody notices; an allow-list makes it
 * unsellable until somebody decides. The first direction oversells a trip,
 * the second refuses a booking, and only one of those strands a guest.
 *
 * Imported by BOTH `assessCapacity()` (which counts free vans) and
 * `vansFreeOn()` (which identifies them), so the two can never disagree
 * about whether a status is usable.
 */
export const VAN_STATUS_SELLABLE = 'available' as const;
```

```ts
// server/src/services/capacity.ts — Gate 2, now an allow-list
.where(
  and(
    eq(vans.isActive, true),
    eq(vans.status, VAN_STATUS_SELLABLE),
    gte(vans.capacity, pax),
  ),
)
```

**Delete Gate 2's old comment** explaining why `status <> 'for_repair'` was preferable to
`status = 'available'` — it now argues for the opposite of what the code does, and a stale comment
that contradicts its own code is worse than none. Replace it with the allow-list reasoning above.

- [ ] **Step 4: Generate and apply the migration**

```bash
ls server/src/db/migrations | tail -3     # confirm the next free number YOURSELF
pnpm --filter @rg/server db:generate
pnpm --filter @rg/server db:migrate      # rg_travel only; the preflight enforces it
```

Then read the generated SQL before trusting it: adding an enum value to a column that has a default is a `MODIFY COLUMN`, and MySQL rewrites the column — confirm the generated statement preserves `NOT NULL DEFAULT 'available'` and the existing rows.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- capacity-van-status capacity`
Expected: PASS, **including every pre-existing capacity test** — if one of those goes red, Gate 2's change was wrong, not the test.

- [ ] **Step 6: Prove it can fail**

Put `'for_repair'` back as the only unavailable status, re-run, confirm the parked-van test goes red. Restore.

- [ ] **Step 7: Commit, and remind the owner about the server DB**

```bash
git add server/src/db/schema.ts server/src/services/capacity.ts server/src/db/migrations server/src/__tests__/capacity-van-status.test.ts
git commit -m "feat(fleet): a parked van is not fleet you can sell"
```

Say in the report: **migration NNNN must be applied to the server database when it exists.**

**✅ DONE 2**

---

### Task 3: The availability module

**Files:**

- Create: `server/src/services/dispatch/availability.ts`
- Modify: `server/src/db/schema.ts` (add `bookings_van_date_idx`)
- Create: `server/src/db/migrations/00NN_bookings_van_date_index.sql`
- Test: `server/src/__tests__/dispatch-availability.test.ts`

**Interfaces:**

- Consumes: `CAPACITY_HOLDING_STATUSES` (`/shared`), **`VAN_STATUS_SELLABLE`** (Task 2 — the allow-list, owner-decided 2026-10-14), `Transaction` (`server/src/db/client`).
- Produces, and every later task uses exactly these signatures:

```ts
export interface FreeVan {
  id: number;
  plate: string;
  model: string;
  capacity: number;
}
export interface FreeDriver {
  id: number;
  name: string;
  code: string;
}
export interface FreeOnOptions {
  /** Ignore this booking's own current assignment, so re-assigning a
   *  booking does not exclude the van it already holds. */
  excludeBookingId?: number;
}
export async function vansFreeOn(
  tx: Transaction,
  date: string,
  minCapacity: number,
  opts?: FreeOnOptions,
): Promise<FreeVan[]>;
export async function driversFreeOn(
  tx: Transaction,
  date: string,
  opts?: FreeOnOptions,
): Promise<FreeDriver[]>;
```

`date` is a civil `YYYY-MM-DD` string in Asia/Manila, always. Both functions return rows **ordered by `capacity` then `id`** for vans and by `name` then `id` for drivers, so the dropdowns are stable and Task 11's "smallest that fits" is just `[0]`.

**The exclusion rules, from §9 "Calendar", written once here and nowhere else:**

| Excluded van                                                         | Why                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `is_active = 0`                                                      | Soft-deleted.                                                                   |
| `status <> VAN_STATUS_SELLABLE`                                      | Anything but `available` — in repair, parked, or on a trip. Allow-list, per Q1. |
| `capacity < minCapacity`                                             | Too small for this group.                                                       |
| Assigned to another booking on this date whose status holds capacity | Already booked that day.                                                        |

| Excluded driver                                                      | Why                               |
| -------------------------------------------------------------------- | --------------------------------- |
| `is_active = 0`                                                      | Soft-deleted.                     |
| A `driver_leaves` row covers the date                                | On leave. Inclusive at both ends. |
| Assigned to another booking on this date whose status holds capacity | Already assigned that day.        |

**Not excluded, deliberately:** `drivers.status = 'off_duty'`. §9 lists driver status as `active / on leave (with date ranges) / inactive`, and leave is a date range, not a flag — a driver who is off duty _today_ is not off duty next Tuesday. Excluding on the flag would hide drivers from every future date the moment someone set it. If the owner wants the flag to block dispatch too, that is **Q4**.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/dispatch-availability.test.ts
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getDb } from '../db/client';
import { bookings, driverLeaves, drivers, vans } from '../db/schema';
import { assessCapacity } from '../services/capacity';
import { driversFreeOn, vansFreeOn } from '../services/dispatch/availability';
import { describeWithDb } from './helpers/db';

describeWithDb('vans', () => {
  it('excludes a van that is too small', async () => {
    const db = getDb();
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 99));
    expect(free).toEqual([]);
  });

  it('excludes a van already assigned to a capacity-holding booking that day', async () => {
    const db = getDb();
    const before = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(before.map((v) => v.id)).toContain(vanId);

    await db.update(bookings).set({ vanId, status: 'assigned' }).where(eq(bookings.id, otherId));

    const after = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(after.map((v) => v.id)).not.toContain(vanId);
  });

  it('does NOT exclude a van assigned to a booking that no longer holds capacity', async () => {
    // `cancelled`, `expired` and `completed` release the day. A cancelled
    // trip must give its van back, or one cancellation wastes a van forever.
    const db = getDb();
    await db.update(bookings).set({ vanId, status: 'cancelled' }).where(eq(bookings.id, otherId));
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 2));
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  it('does not exclude the booking being re-assigned from seeing its own van', async () => {
    const db = getDb();
    await db.update(bookings).set({ vanId, status: 'assigned' }).where(eq(bookings.id, mineId));
    const free = await db.transaction((tx) =>
      vansFreeOn(tx, DATE, 2, { excludeBookingId: mineId }),
    );
    expect(free.map((v) => v.id)).toContain(vanId);
  });

  it('excludes a driver on leave, inclusively at both ends', async () => {
    const db = getDb();
    await db.insert(driverLeaves).values({ driverId, startDate: DATE, endDate: DATE });
    const free = await db.transaction((tx) => driversFreeOn(tx, DATE));
    expect(free.map((d) => d.id)).not.toContain(driverId);
  });

  /**
   * THE STATUS-AGREEMENT TEST — the owner's second named Q1 test, moved here
   * from Task 2 because it needs both modules (controller ruling).
   *
   * Capacity COUNTS and availability IDENTIFIES, so they answer different
   * questions — but they must never disagree about whether a van's status
   * makes it usable at all. One van, one date, no other bookings: the only
   * condition under which the two answers must be identical.
   */
  it.each([...VAN_STATUSES])('capacity and dispatch agree about a %s van', async (status) => {
    const db = getDb();
    await db.update(vans).set({ status }).where(eq(vans.id, onlyVanId));
    const [verdict, free] = await db.transaction(async (tx) => [
      await assessCapacity(tx, { tourId, date: DATE, pax: 2 }),
      await vansFreeOn(tx, DATE, 2),
    ]);
    expect(free.some((v) => v.id === onlyVanId)).toBe(verdict.ok);
  });

  it('orders vans smallest first so auto-suggest can take [0]', async () => {
    const db = getDb();
    const free = await db.transaction((tx) => vansFreeOn(tx, DATE, 1));
    const caps = free.map((v) => v.capacity);
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
  });

  /**
   * THE AGREEMENT TEST. If checkout accepted a booking, dispatch must be
   * able to fulfil it — a business that sells a trip it cannot run has a
   * worse problem than a failed request. The reverse is NOT asserted:
   * `vansFreeOn` is allowed to be more generous than `assessCapacity`'s
   * arithmetic, because capacity deducts every capacity-holding booking
   * from the fleet whether or not it has a van yet.
   */
  it('can always assign a van and a driver to a booking capacity accepted', async () => {
    const db = getDb();
    const verdict = await db.transaction((tx) =>
      assessCapacity(tx, { tourId, date: DATE, pax: 4 }),
    );
    expect(verdict).toEqual({ ok: true });

    const [freeVans, freeDrivers] = await db.transaction(async (tx) => [
      await vansFreeOn(tx, DATE, 4),
      await driversFreeOn(tx, DATE),
    ]);
    expect(freeVans.length).toBeGreaterThan(0);
    expect(freeDrivers.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- dispatch-availability`
Expected: FAIL — the module does not exist. (If the suite reports **skipped** instead, `describeWithDb` could not see the `vans` table: check `rg_travel_test` is migrated, and never repoint the test at `rg_travel`.)

- [ ] **Step 3: Write `availability.ts`**

Both queries are a filter plus a `NOT EXISTS` against `bookings`. Use `notExists` with a correlated subquery, **not** a `LEFT JOIN … IS NULL` and **not** a count: two bookings holding the same van would make a count subtract twice, which is the bug the capacity service's Gate 3 comment already warns about for drivers.

```ts
const holdsCapacity = inArray(bookings.status, [...CAPACITY_HOLDING_STATUSES]);

function notBusyOn(
  tx: Transaction,
  date: string,
  column: typeof bookings.vanId,
  opts?: FreeOnOptions,
) {
  const clauses = [eq(bookings.tourDate, date), holdsCapacity, isNotNull(column)];
  if (opts?.excludeBookingId !== undefined) {
    clauses.push(ne(bookings.id, opts.excludeBookingId));
  }
  return notExists(
    tx
      .select({ one: sql`1` })
      .from(bookings)
      .where(and(...clauses, eq(column, /* the outer table's id */ vans.id))),
  );
}
```

Write the van and driver versions explicitly rather than over-generalising this helper — two readable queries beat one clever one, and the outer-table correlation differs between them.

- [ ] **Step 4: Add the index the van query needs**

`bookings_driver_date_idx (driver_id, tour_date)` exists; there is no van equivalent, so the van subquery would scan. Add to `schema.ts`:

```ts
index('bookings_van_date_idx').on(t.vanId, t.tourDate),
```

Generate and apply the migration, checking the next free number yourself.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- dispatch-availability`
Expected: PASS (7 tests).

- [ ] **Step 6: Prove the tests can fail — with an exact-match mutation**

This project has found twelve-plus tests that could not fail, so each mutation below must be applied **by exact string match, and must refuse an ambiguous target**:

1. Drop the `capacity >= minCapacity` clause → "excludes a van that is too small" goes red.
2. Replace `CAPACITY_HOLDING_STATUSES` with every status → "does NOT exclude a van assigned to a booking that no longer holds capacity" goes red.
3. Drop the `excludeBookingId` clause → the re-assign test goes red.
4. Change the leave comparison from `<=`/`>=` to `<`/`>` → the inclusive-leave test goes red.
5. Filter on `status <> 'for_repair'` instead of `eq(status, VAN_STATUS_SELLABLE)` → **the
   status-agreement test goes red for `parked` and `on_trip`**. This is the owner's Q1 test, and
   it is the one that proves the allow-list reaches dispatch and not only capacity.

Restore after each. Any mutation that leaves everything green is a bug — log it in `docs/BUGS_LOG.md`.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/dispatch/availability.ts server/src/db/schema.ts server/src/db/migrations server/src/__tests__/dispatch-availability.test.ts
git commit -m "feat(dispatch): one answer to which van and which driver are free"
```

**✅ DONE 3**

---

### Task 4: Vans CRUD, server side (5A)

**Files:**

- Create: `shared/src/dispatch.ts` (the van half; later tasks add to it)
- Create: `server/src/routers/admin/vans.ts`
- Modify: `server/src/routers/_app.ts` (mount `vans`)
- Test: `server/src/__tests__/admin-vans.test.ts`

**Interfaces:**

- Consumes: `adminProcedure('vansDrivers')`, `writeAudit`, `VAN_STATUSES`.
- Produces: `admin.vans.list` → `VanRow[]`; `admin.vans.create(vanInputSchema)` → `{ id: number }`; `admin.vans.update({ id, patch: vanInputSchema.partial() })` → `{ ok: true }`; `admin.vans.setStatus({ id, status })` → `{ ok: true }`. `vanInputSchema` and `VanRow` are exported from `@rg/shared`.

```ts
// shared/src/dispatch.ts
export const vanInputSchema = z
  .object({
    plate: z.string().trim().min(3).max(20).toUpperCase(),
    model: z.string().trim().min(2).max(120),
    capacity: z.number().int().min(1).max(30),
    odometer: z.number().int().min(0).max(5_000_000).nullable(),
    lastService: civilDateSchema.nullable(),
    nextService: civilDateSchema.nullable(),
    orcrExpiry: civilDateSchema.nullable(),
    franchiseNo: z.string().trim().max(80).nullable(),
    franchiseExpiry: civilDateSchema.nullable(),
    repairNotes: z.string().trim().max(2000).nullable(),
  })
  .strict();
```

`.strict()` is not decoration: it is the same guard the checkout schemas use, and it is what stops a client from posting an `isActive: true` or a `status` through the CRUD door rather than through `setStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/admin-vans.test.ts
import { expect, it } from 'vitest';
import { appRouter } from '../routers/_app';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

describeWithDb('vans', () => {
  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.admin.vans.list()).rejects.toThrow(/UNAUTHORIZED|FORBIDDEN/);
  });

  it('REFUSES a customer session', async () => {
    const api = appRouter.createCaller(customerContext(1) as never);
    await expect(api.admin.vans.list()).rejects.toThrow(/UNAUTHORIZED|FORBIDDEN/);
  });

  it('REFUSES finance — §9 gives vans to owner and dispatcher only', async () => {
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
    await expect(api.admin.vans.list()).rejects.toThrow(/FORBIDDEN/);
    await expect(api.admin.vans.create({ ...VALID_VAN, plate: 'XYZ999' })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });

  it('ALLOWS dispatcher and owner', async () => {
    for (const role of ['owner', 'dispatcher'] as const) {
      const api = appRouter.createCaller(staffContext(idFor(role), role) as never);
      await expect(api.admin.vans.list()).resolves.toBeInstanceOf(Array);
    }
  });

  it('refuses a duplicate plate with a message a human can act on', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await api.admin.vans.create({ ...VALID_VAN, plate: 'ABC123' });
    await expect(api.admin.vans.create({ ...VALID_VAN, plate: 'ABC123' })).rejects.toThrow(
      /already/i,
    );
  });

  it('normalises the plate so ABC123 and abc123 are the same van', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(api.admin.vans.create({ ...VALID_VAN, plate: 'abc123' })).rejects.toThrow(
      /already/i,
    );
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    await expect(
      api.admin.vans.create({ ...VALID_VAN, plate: 'NEW111', isActive: false } as never),
    ).rejects.toThrow();
  });

  it('writes an audit row naming the actor on every change', async () => {
    const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
    const { id } = await api.admin.vans.create({ ...VALID_VAN, plate: 'AUD111' });
    await api.admin.vans.setStatus({ id, status: 'for_repair' });
    const rows = await auditRowsFor('van', id);
    expect(rows.map((r) => r.action)).toEqual(['van_created', 'van_status_changed']);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([ownerId]));
    expect(new Set(rows.map((r) => r.actorType))).toEqual(new Set(['user']));
  });

  it('has no delete mutation — vans are soft-deleted through is_active', () => {
    expect(
      Object.keys(appRouter._def.procedures)
        .filter((k) => /^admin\.vans\./.test(k))
        .sort(),
    ).toEqual([
      'admin.vans.create',
      'admin.vans.list',
      'admin.vans.setStatus',
      'admin.vans.update',
    ]);
  });
});
```

That last test is the house pattern from Week 3's "the success page cannot confirm anything": **enumerate the procedures** so a later task cannot quietly add a fifth one.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- admin-vans`
Expected: FAIL — `admin.vans` does not exist.

- [ ] **Step 3: Write the shared schema and the router**

Every procedure is `adminProcedure('vansDrivers')`. `create` and `update` run in a transaction with `writeAudit`. Catch the duplicate-plate collision with **`isDuplicateKeyError(err)`** from `server/src/db/duplicate-key.ts` (its only export). Do **not** hand-roll the check against `error.code`: Drizzle wraps mysql2 and moves the driver's code onto `.cause`, and this project has already shipped one duplicate-key retry that could never fire for exactly that reason.

- [ ] **Step 4: Mount it and run the tests**

Run: `pnpm --filter @rg/server test -- admin-vans procedure-role-metadata role-isolation`
Expected: PASS. **The two pre-existing role tests must pass without being edited** — if `procedure-role-metadata` fails, a new procedure is not an `adminProcedure`, and the fix is the router, not the test.

- [ ] **Step 5: Prove the security tests can fail**

Change `adminProcedure('vansDrivers')` to `adminProcedure('bookingsView')` on `list` (which admits finance) and confirm the finance test goes red. Restore. This is the "security controls must fail closed, with a test for the failure path" requirement, discharged.

- [ ] **Step 6: Commit**

```bash
git add shared/src/dispatch.ts server/src/routers/admin/vans.ts server/src/routers/_app.ts server/src/__tests__/admin-vans.test.ts
git commit -m "feat(fleet): the vans a dispatcher can edit, and the ones they cannot delete"
```

**✅ DONE 4**

---

### Task 5: The vans screen (5A, client)

**Files:**

- Create: `client/src/pages/admin/AdminVansPage.tsx`
- Create: `client/src/components/admin/EntityForm.tsx`
- Modify: `client/src/App.tsx` (`admin/vans`)
- Test: `client/src/__tests__/admin-vans-page.test.tsx`

**Interfaces:**

- Consumes: `trpc.admin.vans.list | create | update | setStatus`, `vanInputSchema` from `@rg/shared`.
- Produces: `EntityForm`, used again by Task 7:

```tsx
export interface EntityFormField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'textarea' | 'select';
  options?: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
  hint?: string;
}
export interface EntityFormProps {
  fields: readonly EntityFormField[];
  values: Record<string, string>;
  errors: Record<string, string>;
  pending: boolean;
  submitLabel: string;
  onChange: (name: string, value: string) => void;
  onSubmit: () => void;
}
```

**Design (run `ui-ux-pro-max` first).** Queries to run: `"visible labels error near field" --domain ux`, `"progressive disclosure dense admin form" --domain ux`, `"data table mobile responsive overflow" --domain ux`. What the guidance binds, and what the tests below pin:

- **Visible labels, never placeholder-only** — severity High. Every field gets a `<Label htmlFor>`.
- **Errors next to their field**, not only in a summary at the top. (A summary as well is fine; a summary _instead_ is the anti-pattern.)
- **Submit feedback**: pending → result. No silent submit.
- **Tables**: a semantic `<table>` inside an `overflow-x-auto` wrapper at `md:` and above, a card list below it — the pattern `AdminBookingsPage` already uses. The page body must never scroll horizontally at 360px.
- **Progressive disclosure**: eleven van fields is too many for one wall. Plate, model and capacity are the identity; service dates, papers and repair notes go behind a disclosure (the vendored `accordion`), open by default on `lg:` and collapsed on mobile.
- **Status is never colour alone**: each status renders as a `badge` with its text, and the `for_repair` badge is **amber** — never red, whatever an admin would expect from another product.

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/__tests__/admin-vans-page.test.tsx
it('labels every input with a real <label>', () => {
  renderPage();
  for (const name of ['Plate', 'Model', 'Seats for guests']) {
    expect(screen.getByLabelText(new RegExp(name, 'i'))).toBeTruthy();
  }
  // No input may rely on a placeholder for its name.
  for (const input of screen.getAllByRole('textbox')) {
    expect(input.getAttribute('aria-label') ?? input.id).toBeTruthy();
  }
});

it('shows a field error beside the field, not only at the top', async () => {
  renderPage();
  await user.clear(screen.getByLabelText(/plate/i));
  await user.click(screen.getByRole('button', { name: /add van/i }));
  const field = screen.getByLabelText(/plate/i);
  const described = field.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  expect(document.getElementById(described!)?.textContent).toMatch(/required|at least/i);
});

it('renders the repair status as text, not only a colour', () => {
  renderPage({ vans: [{ ...VAN, status: 'for_repair' }] });
  expect(screen.getByText(/for repair/i)).toBeTruthy();
});

/**
 * NOTE ON WHAT THIS TEST CAN AND CANNOT PROVE. jsdom does no layout: it
 * cannot measure a scroll width, so no unit test here can honestly claim
 * "the page never scrolls sideways at 360px". What it CAN prove is that the
 * wide element is inside a scroll container of its own, which is the
 * mechanism that prevents the page from scrolling. The test is named for
 * the mechanism it checks, not for the outcome it would like to claim —
 * a name that over-claims is the same defect as an assertion that is
 * missing, and harder to spot, because the name reads like coverage.
 *
 * The 360px outcome itself is verified by hand in Task 16's walkthrough.
 */
it('wraps the table in its own horizontal scroll container', () => {
  renderPage({ vans: [VAN, { ...VAN, id: 2, plate: 'DEF456' }] });
  const wrapper = document.querySelector('[data-testid="vans-table-wrapper"]');
  expect(wrapper).not.toBeNull();
  expect(wrapper!.className).toMatch(/overflow-x-auto/);
  // The table must be INSIDE the scroll container, not a sibling of it —
  // a wrapper with the class and the table outside it scrolls nothing.
  expect(wrapper!.querySelector('table')).not.toBeNull();
});

it('gives every control a 44px tap target', () => {
  renderPage();
  for (const button of screen.getAllByRole('button')) {
    expect(button.className).toMatch(/tap-target|h-11|h-12|size-11/);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- admin-vans-page`
Expected: FAIL — page does not exist.

- [ ] **Step 3: Build `EntityForm`, then the page**

`EntityForm` owns the label/error/`aria-describedby` wiring once. The page owns the field list, the mutation calls and the optimistic-free refetch (`invalidate` after a successful mutation — no optimistic update, because a duplicate plate is a real and common failure and an optimistic row that vanishes is worse than a short wait).

Validate on the client with the **same** `vanInputSchema` from `@rg/shared` that the server uses. One schema, two consumers — the pattern Week 3's Q10 established for phone numbers, for the same reason: a client that accepts what the server rejects is a form that cannot be submitted and does not say why.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/client test -- admin-vans-page`
Expected: PASS (5 tests).

- [ ] **Step 5: Prove the tests can fail**

Remove the `aria-describedby` wiring in `EntityForm`, confirm the error-beside-the-field test goes red, restore. Replace the status badge text with an empty string, confirm the colour-alone test goes red, restore.

- [ ] **Step 6: Run the guard suites**

Run: `pnpm --filter @rg/client test -- no-red contrast`
Expected: PASS. If `contrast` fails, a new `bg-brand-*`/`text-brand-*` pairing is below AA — fix the pairing, never the guard.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/AdminVansPage.tsx client/src/components/admin/EntityForm.tsx client/src/App.tsx client/src/__tests__/admin-vans-page.test.tsx
git commit -m "feat(fleet): the vans screen, eleven fields without a wall of inputs"
```

**✅ DONE 5**

---

### Task 6: Drivers, leaves and PIN reset, server side (5B)

**Files:**

- Modify: `shared/src/dispatch.ts` (driver + leave schemas)
- Create: `server/src/routers/admin/drivers.ts`
- Modify: `server/src/routers/_app.ts`
- Test: `server/src/__tests__/admin-drivers.test.ts`

**Interfaces:**

- Consumes: `adminProcedure('vansDrivers')`, `hashPassword()` from `server/src/services/password.ts` (the scrypt helper — **owner decision 2026-10-14**, the same one staff passwords use), `writeAudit`.
- Produces: `admin.drivers.list | create | update | addLeave | removeLeave | resetPin`.

**`resetPin` is the one procedure in this week that touches auth**, so it is specified tightly and nothing is left to the implementer's judgment:

- The server **generates** the six-digit PIN. The client never sends one — a client-chosen PIN means "123456" on every driver in the fleet.
- The PIN is returned **once**, in the mutation's response, for the dispatcher to read out to the driver. It is never stored in plaintext, never written to `audit_log`, never logged, and never returned by `list` or `update`.
- Generate it with `crypto.randomInt(0, 1_000_000)` zero-padded to six digits — **not** `Math.random()`.
- The reset **clears the lockout state**: `failed_attempts = 0`, `locked_until = null`, `lockout_count = 0`, `lockout_window_started_at = null`, `requires_admin_unlock = false`. A PIN reset that leaves a driver locked out is a support call that cannot be resolved.
- The audit row is `driver_pin_reset` with `data: { clearedLockout: true }` — **the PIN itself must not appear in `data`**, and a test asserts that.

See **Q5** on whether a dispatcher may reset a PIN or only an owner. Until it is answered, the procedure is `adminProcedure('vansDrivers')` (owner + dispatcher), matching §9's "Vans, drivers" row, which is where §9 lists PIN reset.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/admin-drivers.test.ts
it('generates a six-digit PIN and returns it exactly once', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  const { pin } = await api.admin.drivers.resetPin({ id: driverId });
  expect(pin).toMatch(/^[0-9]{6}$/);

  const listed = await api.admin.drivers.list();
  const row = listed.find((d) => d.id === driverId)!;
  expect(JSON.stringify(row)).not.toContain(pin);
  expect(row).not.toHaveProperty('pinHash');
});

it('never writes the PIN into the audit log', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  const { pin } = await api.admin.drivers.resetPin({ id: driverId });
  const rows = await auditRowsFor('driver', driverId);
  expect(JSON.stringify(rows)).not.toContain(pin);
  expect(rows.at(-1)?.action).toBe('driver_pin_reset');
});

it('stores a scrypt hash that verifies the new PIN and not the old one', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  const first = await api.admin.drivers.resetPin({ id: driverId });
  const second = await api.admin.drivers.resetPin({ id: driverId });
  const hash = await pinHashFor(driverId);
  expect(hash.startsWith('scrypt$')).toBe(true);
  await expect(verifyPassword(second.pin, hash)).resolves.toBe(true);
  await expect(verifyPassword(first.pin, hash)).resolves.toBe(false);
});

it('clears the lockout so a locked-out driver can sign in again', async () => {
  const db = getDb();
  await db
    .update(drivers)
    .set({
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 9e5),
      lockoutCount: 3,
      requiresAdminUnlock: true,
    })
    .where(eq(drivers.id, driverId));
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await api.admin.drivers.resetPin({ id: driverId });
  const [row] = await db.select().from(drivers).where(eq(drivers.id, driverId));
  expect({
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
    lockoutCount: row.lockoutCount,
    requiresAdminUnlock: row.requiresAdminUnlock,
  }).toEqual({ failedAttempts: 0, lockedUntil: null, lockoutCount: 0, requiresAdminUnlock: false });
});

it('REFUSES finance on every drivers procedure', async () => {
  const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
  await expect(api.admin.drivers.list()).rejects.toThrow(/FORBIDDEN/);
  await expect(api.admin.drivers.resetPin({ id: driverId })).rejects.toThrow(/FORBIDDEN/);
  await expect(api.admin.drivers.addLeave(VALID_LEAVE)).rejects.toThrow(/FORBIDDEN/);
});

it('refuses a backwards leave range at the Zod boundary, before the DB CHECK', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await expect(
    api.admin.drivers.addLeave({
      driverId,
      startDate: '2026-11-10',
      endDate: '2026-11-03',
      reason: null,
    }),
  ).rejects.toThrow(/end/i);
});

it('refuses a leave that overlaps one the driver already has', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await api.admin.drivers.addLeave({
    driverId,
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    reason: null,
  });
  await expect(
    api.admin.drivers.addLeave({
      driverId,
      startDate: '2026-11-12',
      endDate: '2026-11-14',
      reason: null,
    }),
  ).rejects.toThrow(/overlap/i);
});

it('refuses leave on a date the driver is already assigned to a trip', async () => {
  // Otherwise dispatch and the leave calendar disagree about one day, and
  // the driver finds out on the morning.
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await getDb()
    .update(bookings)
    .set({ driverId, status: 'assigned' })
    .where(eq(bookings.id, bookingId));
  await expect(
    api.admin.drivers.addLeave({
      driverId,
      startDate: TOUR_DATE,
      endDate: TOUR_DATE,
      reason: null,
    }),
  ).rejects.toThrow(/assigned/i);
});
```

The overlap test closes the gap `schema.ts` names as a service-layer concern: the DB CHECK constrains one row, two rows are the service's job, and this is the service.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- admin-drivers`
Expected: FAIL — `admin.drivers` does not exist.

- [ ] **Step 3: Write the schemas and the router**

`driverLeaveInputSchema` carries the `endDate >= startDate` refinement (string comparison on zero-padded `YYYY-MM-DD`, the discipline `isDriverVisible` already uses). The overlap and the already-assigned checks are queries inside the `addLeave` transaction. `list` selects an explicit column list that **omits `pin_hash`** — never `select()` with no projection on `drivers`, because that ships the hash to the browser.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- admin-drivers procedure-role-metadata role-isolation`
Expected: PASS.

- [ ] **Step 5: Prove the tests can fail — four exact-match mutations**

1. Return `pin` from `list` → the "never leaks" test goes red.
2. Put the PIN into the audit `data` → the audit test goes red.
3. Drop the lockout-clearing fields from the `resetPin` update → the lockout test goes red.
4. Delete the overlap query → the overlap test goes red.

Restore after each. If (1) or (2) stays green, the test is asserting nothing — log it in `docs/BUGS_LOG.md` before continuing.

- [ ] **Step 6: Commit**

```bash
git add shared/src/dispatch.ts server/src/routers/admin/drivers.ts server/src/routers/_app.ts server/src/__tests__/admin-drivers.test.ts
git commit -m "feat(drivers): leaves that cannot overlap, and a PIN nobody can read twice"
```

**✅ DONE 6**

---

### Task 7: The drivers screen (5B, client)

**Files:**

- Create: `client/src/pages/admin/AdminDriversPage.tsx`
- Modify: `client/src/App.tsx` (`admin/drivers`)
- Test: `client/src/__tests__/admin-drivers-page.test.tsx`

**Interfaces:**

- Consumes: `EntityForm` (Task 5), `trpc.admin.drivers.*`, `driverInputSchema` / `driverLeaveInputSchema`.
- Produces: nothing other tasks consume.

**Design (run `ui-ux-pro-max` first).** Queries: `"destructive action confirmation"`, `"submit feedback loading state"`, `"one time secret reveal copy"` in `--domain ux`. Binding decisions:

- **The PIN reveal is the whole design problem on this screen.** The new PIN arrives once, in a mutation response. It renders in an amber panel with `role="status"`, a copy button, the driver's name, and the sentence that it will not be shown again. It must **not** be a browser `alert()` (the harness notes forbid dialogs, and a dialog is unreadable to a dispatcher holding a phone), and it must not persist across a route change or a refetch.
- **The reset is a confirmed action**, because it invalidates the PIN the driver is currently using. Confirmation is an inline two-step (button → "Reset PIN for Maria Santos?" with confirm/cancel in the same panel), not a modal — there is no vendored `dialog`, and adding one is **Q8**.
- The confirm button is `brand-blue`, not red. There is no red anywhere, and a destructive-looking control here would be the first.
- **Leave ranges** render as a list with an explicit "to" and both dates spelled out (`10 Nov 2026 to 12 Nov 2026`), because an en-dash between two numerals is ambiguous at a glance and a leave off by one day puts a driver on a trip.
- Personal data (phone, licence number, emergency contact) is visible on this admin screen and **nowhere else** (RA 10173).

- [ ] **Step 1: Write the failing test**

```tsx
it('reveals a reset PIN once, in a status region, and not after a refetch', async () => {
  renderPage();
  await user.click(screen.getByRole('button', { name: /reset pin/i }));
  await user.click(screen.getByRole('button', { name: /^reset pin for/i }));
  const status = await screen.findByRole('status');
  expect(status.textContent).toMatch(/[0-9]{6}/);
  expect(status.textContent).toMatch(/not be shown again/i);

  await user.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByRole('status')).toBeNull();
});

it('asks before resetting, and cancelling resets nothing', async () => {
  const calls: unknown[] = [];
  renderPage({ onResetPin: (v: unknown) => calls.push(v) });
  await user.click(screen.getByRole('button', { name: /reset pin/i }));
  await user.click(screen.getByRole('button', { name: /cancel/i }));
  expect(calls).toEqual([]);
});

it('spells out both ends of a leave range', () => {
  renderPage({ leaves: [{ id: 1, startDate: '2026-11-10', endDate: '2026-11-12', reason: null }] });
  expect(screen.getByText(/10 Nov 2026 to 12 Nov 2026/i)).toBeTruthy();
});

it('shows the server error beside the leave form when ranges overlap', async () => {
  renderPage({ addLeaveError: 'That overlaps an existing leave.' });
  await user.click(screen.getByRole('button', { name: /add leave/i }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/overlaps/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- admin-drivers-page`
Expected: FAIL — page does not exist.

- [ ] **Step 3: Build the page**

Reuse `EntityForm` for the driver fields. The PIN panel is local state cleared on dismiss, on route change, and on any subsequent mutation. The leave list and the leave form sit in their own section with their own error region.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/client test -- admin-drivers-page`
Expected: PASS (4 tests).

- [ ] **Step 5: Prove the tests can fail**

Make the confirm step call the mutation directly (skipping confirmation) → the cancel test goes red. Restore. Keep the PIN panel mounted after dismiss → the reveal test goes red. Restore.

- [ ] **Step 6: Guards, then commit**

```bash
pnpm --filter @rg/client test -- no-red contrast
git add client/src/pages/admin/AdminDriversPage.tsx client/src/App.tsx client/src/__tests__/admin-drivers-page.test.tsx
git commit -m "feat(drivers): a PIN shown once, and leave dates nobody can misread"
```

**✅ DONE 7**

---

### Task 8: The month query (5C, server)

**Files:**

- Modify: `shared/src/dispatch.ts` (`calendarMonthSchema`, `CalendarDay`, `CalendarTrip`)
- Create: `server/src/routers/admin/calendar.ts`
- Modify: `server/src/routers/_app.ts`
- Test: `server/src/__tests__/admin-calendar.test.ts`

**Interfaces:**

- Consumes: `adminProcedure('bookingsView')` for `month` (§9 gives Dashboard and Bookings-view to all three roles, so **finance may read the calendar**) and `adminProcedure('assignVanDriver')` for `dayOptions` (the dropdown contents are a dispatch tool, and finance has no business assigning).
- Produces:

```ts
export interface CalendarTrip {
  bookingId: number;
  ref: string;
  tourTitle: string;
  pax: number;
  status: BookingStatus;
  vanId: number | null;
  vanPlate: string | null;
  driverId: number | null;
  driverName: string | null;
  needsAssignment: boolean;
  /**
   * `status === 'pending_verification'` — a receipt is in, nobody has
   * checked it yet (owner-decided 2026-10-14, Q2). The calendar SHOWS these
   * trips, labelled in TEXT ("awaiting payment check"), they never count
   * toward `needsAssignment`, and dispatch may still pre-assign them.
   */
  awaitingPaymentCheck: boolean;
}
export interface CalendarDay {
  /** Civil date, `YYYY-MM-DD`, Asia/Manila. */
  date: string;
  trips: CalendarTrip[];
  needsAssignmentCount: number;
}
// admin.calendar.month({ year, month }) -> { days: CalendarDay[] }
// admin.calendar.dayOptions({ bookingId }) -> { vans: FreeVan[]; drivers: FreeDriver[] }
```

`needsAssignment` is computed **once, on the server**: `status IN ('confirmed', 'assigned') AND (van_id IS NULL OR driver_id IS NULL)`. Both unpaid statuses are excluded — `pending_payment` because a fifteen-minute hold is not a dispatch problem, and `pending_verification` because the owner decided so (Q2): it shows on the calendar and may be pre-assigned, but it never lights the dot and never inflates the dashboard count. Marking either would make the gold dot meaningless by lighting up every hold every morning.

**Owner-decided 2026-10-14 (Q2), and all four parts are testable here:** a `pending_verification` trip (1) appears in `trips`, (2) carries `awaitingPaymentCheck: true` which the client renders as **text, not colour**, (3) contributes **0** to `needsAssignmentCount`, and (4) is assignable — which is Task 10's half of the ruling.

The month is **Manila-local**: `month: 11, year: 2026` means the days whose Manila civil date falls in November, and `tour_date` is already a civil date, so the query is a `BETWEEN` on strings with no timezone conversion at all. Do not build this from a `Date` range.

- [ ] **Step 1: Write the failing test**

```ts
it('returns every day of the month, including empty ones', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  expect(days).toHaveLength(30);
  expect(days[0].date).toBe('2026-11-01');
  expect(days.at(-1)!.date).toBe('2026-11-30');
});

it('does not bleed a trip from an adjacent month', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-12-01', status: 'confirmed' });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  expect(days.flatMap((d) => d.trips)).toHaveLength(0);
});

it('marks a confirmed trip with no van as needing assignment', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-11-10', status: 'confirmed', vanId: null, driverId: null });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  const day = days.find((d) => d.date === '2026-11-10')!;
  expect(day.needsAssignmentCount).toBe(1);
  expect(day.trips[0].needsAssignment).toBe(true);
});

it('marks a trip with a van but no driver as STILL needing assignment', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-11-11', status: 'confirmed', vanId, driverId: null });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  expect(days.find((d) => d.date === '2026-11-11')!.needsAssignmentCount).toBe(1);
});

it('does NOT mark an unpaid hold as needing assignment, but still SHOWS it', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-11-12', status: 'pending_payment' });
  await makeBooking({ tourDate: '2026-11-12', status: 'pending_verification' });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  const day = days.find((d) => d.date === '2026-11-12')!;
  // Both are visible — a dispatcher planning a week needs to see probable
  // trips — and neither counts. Q2.
  expect(day.trips).toHaveLength(2);
  expect(day.needsAssignmentCount).toBe(0);
});

it('flags a pending_verification trip as awaiting a payment check', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-11-14', status: 'pending_verification' });
  await makeBooking({ tourDate: '2026-11-14', status: 'confirmed' });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  const day = days.find((d) => d.date === '2026-11-14')!;
  expect(day.trips.filter((t) => t.awaitingPaymentCheck)).toHaveLength(1);
  expect(day.trips.find((t) => t.status === 'confirmed')!.awaitingPaymentCheck).toBe(false);
  // It is awaiting a payment check AND unstaffed, and still counts zero.
  expect(day.needsAssignmentCount).toBe(1);
});

it('does NOT mark a cancelled or expired trip', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await makeBooking({ tourDate: '2026-11-13', status: 'cancelled' });
  await makeBooking({ tourDate: '2026-11-13', status: 'expired' });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });
  expect(days.find((d) => d.date === '2026-11-13')!.needsAssignmentCount).toBe(0);
});

it('never exposes a guest email or phone through the calendar', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await makeBooking({
    tourDate: '2026-11-18',
    status: 'confirmed',
    leadEmail: 'guest@example.com',
    leadPhone: '+639081234567',
  });
  const { days } = await api.admin.calendar.month({ year: 2026, month: 11 });

  // VACUITY GUARD, and it is the whole test. A "no email appears" assertion
  // over an empty month passes perfectly while proving nothing, so the
  // booking above is seeded with a known address and number, and this line
  // insists the payload actually contains trips before the absence below
  // means anything.
  const trips = days.flatMap((d) => d.trips);
  expect(trips.length).toBeGreaterThan(0);

  const payload = JSON.stringify(days);
  expect(payload).not.toContain('guest@example.com');
  expect(payload).not.toContain('+639081234567');
  expect(payload).not.toMatch(/@|\+639/);
});

it('lets finance READ the month but not the dropdown options', async () => {
  const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
  await expect(api.admin.calendar.month({ year: 2026, month: 11 })).resolves.toBeTruthy();
  await expect(api.admin.calendar.dayOptions({ bookingId })).rejects.toThrow(/FORBIDDEN/);
});

it('rejects a month outside 1..12 and a year outside 2020..2100', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  await expect(api.admin.calendar.month({ year: 2026, month: 13 })).rejects.toThrow();
  await expect(api.admin.calendar.month({ year: 1999, month: 1 })).rejects.toThrow();
});
```

The "never exposes a guest email" test matters because the calendar is the first admin read whose rows are a _list of other people's bookings_ rather than one booking a dispatcher opened deliberately. The month view needs a ref and a tour title; it does not need contact details, and RA 10173 says it should not carry them.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test -- admin-calendar`
Expected: FAIL — `admin.calendar` does not exist.

- [ ] **Step 3: Write the shared types and the router**

The day list is generated from the month (so empty days exist) and trips are bucketed into it in one pass — not one query per day. `dayOptions` reads the booking's `tour_date` and `pax`, then calls `vansFreeOn(tx, date, pax, { excludeBookingId: bookingId })` and `driversFreeOn(tx, date, { excludeBookingId: bookingId })`. **It must not reimplement the exclusion rules**; a reviewer should reject any SQL in `calendar.ts` that filters vans or drivers.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- admin-calendar`
Expected: PASS (9 tests).

- [ ] **Step 5: Prove the tests can fail**

Include `pending_payment` in the needs-assignment condition → the unpaid-hold test goes red. Restore. Include `pending_verification` → the awaiting-payment-check test's `needsAssignmentCount` assertion goes red. Restore. Change the `needsAssignment` condition from `OR` to `AND` on the two null checks → the van-but-no-driver test goes red. Restore. Hard-code `awaitingPaymentCheck: false` → its test goes red. Restore. Add `leadEmail` to the trip projection → the privacy test goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add shared/src/dispatch.ts server/src/routers/admin/calendar.ts server/src/routers/_app.ts server/src/__tests__/admin-calendar.test.ts
git commit -m "feat(dispatch): a month of trips, and which of them nobody has staffed"
```

**✅ DONE 8**

---

### Task 9: The month grid (5C, client)

**Files:**

- Create: `client/src/components/admin/MonthGrid.tsx`
- Create: `client/src/pages/admin/AdminCalendarPage.tsx`
- Modify: `client/src/App.tsx` (`admin/calendar`)
- Test: `client/src/__tests__/month-grid.test.tsx`

**Interfaces:**

- Consumes: `CalendarDay` / `CalendarTrip` from `@rg/shared`, `trpc.admin.calendar.month`.
- Produces: `MonthGrid` with props `{ days: CalendarDay[]; selected: string | null; onSelect(date: string): void }`, reused by nothing else this week but deliberately separable from the page so the grid can be tested without a query client.

**Design — and the one real accessibility decision in this plan.**

§9 says "**Gold dot** = needs assignment". A dot of colour is, on its own, exactly the WCAG 1.4.1 failure the `ui-ux-pro-max` Accessibility guidance names first: _"Don't convey information by color alone — use icons/text in addition to color."_ It is also unreadable to the dispatcher using this screen at 7am in sunlight on a phone.

So the dot stays, and it stops being the only signal:

- the day cell shows the **count** as a numeral beside the dot (`2`), not just the dot;
- the cell's accessible name is built from text: `10 November, 3 trips, 2 need assignment`;
- the dot is `brand-gold-600`, which `CLAUDE.md` permits for a non-text decorative element, while the numeral beside it is `brand-gold-800` or darker to clear AA at that size;
- a day with trips but none needing assignment gets no dot and no numeral — absence is the signal, and absence needs no colour.

Grid mechanics, from the UX guidance (`"calendar grid keyboard navigation month"` → Keyboard Navigation, severity High):

- the grid is a `<table role="grid">` with a `<caption>` naming the month, seven `<th scope="col">` weekday headers abbreviated with a `<abbr title="Monday">`;
- **one tab stop for the whole grid** (`tabIndex=0` on the selected cell, `-1` on the rest), with arrow keys moving by day, `PageUp`/`PageDown` by month, `Home`/`End` to the ends of the week — the roving-tabindex pattern, because 30 tab stops to cross a month is the "100 tabs to reach content" anti-pattern in miniature;
- **at 360px the grid does not try to show trips inside cells.** Each cell is a date, a trip count and the marker; selecting a day renders that day's trips in a list **below** the grid. That is the progressive-disclosure call, and it is what keeps a seven-column grid usable at 45px per column;
- week starts **Monday** (Philippine business convention), and the leading/trailing cells from adjacent months are rendered empty and `aria-hidden`, never clickable.

- [ ] **Step 1: Write the failing test**

```tsx
it('names each day cell in text, not by colour', () => {
  render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
  const cell = screen.getByRole('gridcell', { name: /10 November, 3 trips, 2 need assignment/i });
  expect(cell).toBeTruthy();
});

it('shows the needs-assignment count as a numeral beside the dot', () => {
  render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
  const cell = screen.getByRole('gridcell', { name: /10 November/i });
  expect(cell.textContent).toMatch(/\b2\b/);
});

it('marks a day with no unstaffed trips without any dot at all', () => {
  render(
    <MonthGrid
      days={[{ date: '2026-11-04', trips: [TRIP_STAFFED], needsAssignmentCount: 0 }]}
      selected={null}
      onSelect={noop}
    />,
  );
  expect(document.querySelector('[data-testid="needs-assignment-dot"]')).toBeNull();
});

it('keeps exactly one tab stop in the grid', () => {
  render(<MonthGrid days={DAYS} selected="2026-11-10" onSelect={noop} />);
  const focusable = screen
    .getAllByRole('gridcell')
    .filter((c) => c.getAttribute('tabindex') === '0');
  expect(focusable).toHaveLength(1);
  expect(focusable[0].getAttribute('aria-selected')).toBe('true');
});

it('moves selection with the arrow keys', async () => {
  const picked: string[] = [];
  render(<MonthGrid days={DAYS} selected="2026-11-10" onSelect={(d) => picked.push(d)} />);
  const cell = screen.getByRole('gridcell', { name: /10 November/i });
  cell.focus();
  await user.keyboard('{ArrowRight}');
  expect(picked).toEqual(['2026-11-11']);
});

it('does not make adjacent-month padding cells reachable', () => {
  render(<MonthGrid days={DAYS} selected={null} onSelect={noop} />);
  for (const pad of document.querySelectorAll('[data-testid="pad-cell"]')) {
    expect(pad.getAttribute('aria-hidden')).toBe('true');
    expect(pad.getAttribute('tabindex')).toBeNull();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/client test -- month-grid`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Build `MonthGrid`, then the page**

The page owns the month state, the query and the selected-day trip list. The grid is presentational and takes no query.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/client test -- month-grid`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove the accessibility tests can fail**

This is the step that matters most in this task, because an accessibility test that cannot fail is worse than none — it certifies the thing it never checked:

1. Remove the `2 need assignment` clause from the accessible name → test 1 goes red.
2. Render the numeral as `aria-hidden` → test 2 goes red.
3. Give every cell `tabIndex=0` → test 4 goes red.

Restore after each.

- [ ] **Step 6: Motion, last and optional**

Only after the layout is right, and only via `emilkowalski-motion`: the selected-day list may fade/slide in over ~150ms. It must be wrapped in a `prefers-reduced-motion` guard. No motion on the grid cells themselves — a dispatcher scanning a month does not need 30 things animating.

- [ ] **Step 7: Guards, then commit**

```bash
pnpm --filter @rg/client test -- no-red contrast month-grid
git add client/src/components/admin/MonthGrid.tsx client/src/pages/admin/AdminCalendarPage.tsx client/src/App.tsx client/src/__tests__/month-grid.test.tsx
git commit -m "feat(dispatch): the month at a glance, and a gold dot that also says what it means"
```

**✅ DONE 9**

---

### Task 10: The assignment mutation (5D, server) — the dangerous one

**Files:**

- Create: `server/src/services/dispatch/assign.ts`
- Create: `server/src/routers/admin/dispatch.ts`
- Modify: `server/src/routers/_app.ts`, `shared/src/dispatch.ts` (`assignInputSchema`)
- Test: `server/src/__tests__/dispatch-assign.test.ts`

**Interfaces:**

- Consumes: `vansFreeOn` / `driversFreeOn` (Task 3), `takeSlotLocks` (`services/capacity.ts`), `writeAudit`, `adminProcedure('assignVanDriver')`.
- Produces:

```ts
export type AssignRefusal =
  | 'booking_not_found'
  | 'booking_not_assignable'
  | 'van_unavailable'
  | 'driver_unavailable'
  | 'van_too_small'
  /** An in_progress re-assignment arrived without a reason (Q3). */
  | 'reason_required';
export async function assignVanAndDriver(
  tx: Transaction,
  input: {
    bookingId: number;
    vanId: number;
    driverId: number;
    actorUserId: number;
    /** REQUIRED when the booking is `in_progress` (owner-decided 2026-10-14,
     *  Q3); ignored — and must not be demanded — otherwise. */
    reason?: string;
  },
): Promise<{ ok: true } | { ok: false; reason: AssignRefusal }>;
// admin.dispatch.assign(assignInputSchema) -> { ok: true }, or a TRPCError carrying the reason

// shared/src/dispatch.ts
export const assignInputSchema = z
  .object({
    bookingId: z.number().int().positive(),
    vanId: z.number().int().positive(),
    driverId: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
```

**`reason` is optional in Zod and required by the service, deliberately.** Zod cannot see the
booking's status, so it cannot know whether a reason is owed — the requirement is a function of
the row, not of the input. Enforcing it in Zod would mean either demanding a reason for every
first assignment (noise the owner did not ask for) or trusting the client to tell the truth about
the status. So Zod bounds the string and `assignVanAndDriver()` decides, inside the transaction,
after it has read the status under the lock. The refusal is `reason_required`.

```ts

```

**This is the first code in the project's history to write `bookings.van_id`.** Four rules, each of which has a test below, and none of which is negotiable:

1. **Lock before you look.** Take `takeSlotLocks(tx, booking.tourId, booking.tourDate)` — fleet row then tour row, the established global order — **before** reading availability. This project has already been bitten by the opposite: under InnoDB's REPEATABLE READ, a non-locking read taken before the lock returns the pre-lock snapshot even after the lock is granted, which is exactly how the cash double-verify bug worked. Acquire the locks, then read.
2. **Re-check inside the lock.** The dropdown the dispatcher clicked was rendered seconds ago. Re-run `vansFreeOn` / `driversFreeOn` inside the transaction and refuse if the chosen van or driver is no longer free. The dropdown is a convenience; this check is the enforcement.
3. **No money, no payment fields.** The update writes `van_id`, `driver_id`, `status` and nothing else.
4. **Audit with the actor, and name the action for what happened.** `booking_assigned` for a
   first assignment or a pre-departure re-assignment; **`booking_reassigned_in_progress`** for a
   Q3 mid-trip change, whose `data` additionally carries the **`reason`**. Both carry
   `previousVanId` and `previousDriverId` - old to new, as the owner required. Two action names
   rather than one, because "a van was swapped mid-trip" is the row an operations review will go
   looking for, and it should not have to infer it from a timestamp.

```ts
writeAudit(tx, {
  actorType: 'user',
  actorId: actorUserId,
  action: wasInProgress ? 'booking_reassigned_in_progress' : 'booking_assigned',
  entity: 'booking',
  entityId: bookingId,
  data: { vanId, driverId, previousVanId, previousDriverId, ...(reason ? { reason } : {}) },
});
```

**Which statuses may be assigned — owner-decided 2026-10-14 (Q2 and Q3 together):**

| Status                              | Assignable? | Reason required? | Why                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`                         | ✅          | no               | The normal first assignment. Status moves to `assigned`.                                                                                                                                                                                    |
| `assigned`                          | ✅          | no               | Re-assignment before departure. Nothing is being undone.                                                                                                                                                                                    |
| `pending_verification`              | ✅ **(Q2)** | no               | A receipt is in and the trip is probable, so dispatch may **pre-assign**. **The status does NOT change** — it stays `pending_verification` until the payment is checked, and the assignment carries an "unpaid" label wherever it is shown. |
| `in_progress`                       | ✅ **(Q3)** | **YES**          | A van breaking down mid-trip is real, and the record must be able to say so. Status stays `in_progress`.                                                                                                                                    |
| `pending_payment`                   | ❌          | —                | A fifteen-minute unpaid hold. Staffing it is staffing nothing.                                                                                                                                                                              |
| `completed`, `cancelled`, `expired` | ❌          | —                | The day is over or called off; the capacity is already released.                                                                                                                                                                            |

**The status transition is now conditional, and that is the subtlety a reviewer should check first.**
`confirmed` → `assigned` is the only status _change_ this mutation makes. `pending_verification`
and `in_progress` keep their status — writing `assigned` over either would be a lie, and over
`pending_verification` it would also be a **money lie**, because `assigned` reads as paid
everywhere else in the system (§5's status table) and the receipt has not been checked. A single
unconditional `status: 'assigned'` write is the bug this table exists to prevent.

- [ ] **Step 1: Write the failing test**

```ts
it('assigns a van and a driver and moves the booking to assigned', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
    ok: true,
  });
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
  expect({ vanId: row.vanId, driverId: row.driverId, status: row.status }).toEqual({
    vanId,
    driverId,
    status: 'assigned',
  });
});

it('writes an audit row naming the actor and both previous values', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  const [row] = await auditRowsFor('booking', bookingId);
  expect(row.action).toBe('booking_assigned');
  expect(row.actorId).toBe(dispatcherId);
  expect(row.data).toMatchObject({ vanId, driverId, previousVanId: null, previousDriverId: null });
});

it('changes no money and no payment row', async () => {
  const before = await moneySnapshot(bookingId);
  // VACUITY GUARD: two empty snapshots are equal, so a `moneySnapshot` that
  // silently returns nothing would make this test pass while watching
  // nothing at all. Assert it actually captured the money columns first.
  expect(before).toMatchObject({
    totalCentavos: expect.any(Number),
    amountPaidCentavos: expect.any(Number),
  });

  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  expect(await moneySnapshot(bookingId)).toEqual(before);
});

/**
 * `moneySnapshot` must read EVERY money-bearing column on the booking plus
 * its payment rows, or the test above is only as good as its projection.
 * Define it in this file as:
 *
 *   async function moneySnapshot(id: number) {
 *     const [b] = await getDb()
 *       .select({
 *         subtotalCentavos: bookings.subtotalCentavos,
 *         discountCentavos: bookings.discountCentavos,
 *         totalCentavos: bookings.totalCentavos,
 *         amountPaidCentavos: bookings.amountPaidCentavos,
 *         payMode: bookings.payMode,
 *       })
 *       .from(bookings)
 *       .where(eq(bookings.id, id));
 *     const rows = await getDb()
 *       .select({ id: payments.id, status: payments.status, amount: payments.amountCentavos })
 *       .from(payments)
 *       .where(eq(payments.bookingId, id))
 *       .orderBy(payments.id);
 *     return { ...b, payments: rows };
 *   }
 *
 * Check the exact column names in `server/src/db/schema.ts` before writing
 * it — do not guess them from this comment.
 */

it('REFUSES finance — §9 gives assignment to owner and dispatcher only', async () => {
  const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
    /FORBIDDEN/,
  );
});

it('refuses a pending_payment hold', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await getDb()
    .update(bookings)
    .set({ status: 'pending_payment' })
    .where(eq(bookings.id, bookingId));
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
    /not_assignable/,
  );
});

it('refuses a completed, cancelled or expired booking', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  for (const status of ['completed', 'cancelled', 'expired'] as const) {
    await getDb().update(bookings).set({ status }).where(eq(bookings.id, bookingId));
    await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
      /not_assignable/,
    );
  }
});

/* ---- Q2: pre-assigning an unverified receipt (owner-decided 2026-10-14) ---- */

it('ALLOWS pre-assigning a pending_verification booking', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await getDb()
    .update(bookings)
    .set({ status: 'pending_verification' })
    .where(eq(bookings.id, bookingId));
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
    ok: true,
  });
});

it('does NOT move a pre-assigned booking to assigned - it is still unpaid', async () => {
  // `assigned` reads as paid everywhere else in the system (section 5's
  // status table). Writing it over an unchecked receipt would be a money lie.
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await getDb()
    .update(bookings)
    .set({ status: 'pending_verification' })
    .where(eq(bookings.id, bookingId));
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
  expect(row.status).toBe('pending_verification');
  expect({ vanId: row.vanId, driverId: row.driverId }).toEqual({ vanId, driverId });
});

/* ---- Q3: re-assigning a trip already under way (owner-decided 2026-10-14) ---- */

it('ALLOWS re-assigning an in_progress trip when a reason is given', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
  await expect(
    api.admin.dispatch.assign({
      bookingId,
      vanId: otherVanId,
      driverId: otherDriverId,
      reason: 'Van ABC 123 broke down at Carcar; swapped to DEF 456.',
    }),
  ).resolves.toEqual({ ok: true });
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, bookingId));
  expect(row.status).toBe('in_progress'); // the trip is still under way
});

it('REFUSES an in_progress re-assignment with no reason', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
  await expect(
    api.admin.dispatch.assign({ bookingId, vanId: otherVanId, driverId: otherDriverId }),
  ).rejects.toThrow(/reason_required/);
});

it('REFUSES an in_progress re-assignment whose reason is only whitespace', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
  await expect(
    api.admin.dispatch.assign({
      bookingId,
      vanId: otherVanId,
      driverId: otherDriverId,
      reason: '   ',
    }),
  ).rejects.toThrow();
});

it('does NOT demand a reason for an ordinary first assignment', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).resolves.toEqual({
    ok: true,
  });
});

it('audits an in_progress re-assignment with old -> new values and the reason', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
  await api.admin.dispatch.assign({
    bookingId,
    vanId: otherVanId,
    driverId: otherDriverId,
    reason: 'Breakdown at Carcar',
  });
  const rows = await auditRowsFor('booking', bookingId);
  const last = rows.at(-1)!;
  expect(last.action).toBe('booking_reassigned_in_progress');
  expect(last.actorId).toBe(dispatcherId);
  expect(last.data).toMatchObject({
    previousVanId: vanId,
    previousDriverId: driverId,
    vanId: otherVanId,
    driverId: otherDriverId,
    reason: 'Breakdown at Carcar',
  });
});

it('REFUSES finance an in_progress re-assignment', async () => {
  const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);
  await getDb().update(bookings).set({ status: 'in_progress' }).where(eq(bookings.id, bookingId));
  await expect(
    api.admin.dispatch.assign({ bookingId, vanId, driverId, reason: 'Breakdown' }),
  ).rejects.toThrow(/FORBIDDEN/);
});

it('refuses a van too small for the group', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await expect(
    api.admin.dispatch.assign({ bookingId, vanId: tinyVanId, driverId }),
  ).rejects.toThrow(/van_too_small|van_unavailable/);
});

it('refuses a driver who is on leave that day', async () => {
  await getDb().insert(driverLeaves).values({ driverId, startDate: TOUR_DATE, endDate: TOUR_DATE });
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await expect(api.admin.dispatch.assign({ bookingId, vanId, driverId })).rejects.toThrow(
    /driver_unavailable/,
  );
});

/**
 * THE CONCURRENCY TEST. Two dispatchers, one van, one date. Exactly one
 * must win. This is the test that justifies the lock, and it must be
 * written as two overlapping transactions — not two sequential calls,
 * which pass with no lock at all.
 */
it('gives one van to exactly one of two simultaneous assignments', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  const results = await Promise.allSettled([
    api.admin.dispatch.assign({ bookingId: firstBookingId, vanId, driverId: driverA }),
    api.admin.dispatch.assign({ bookingId: secondBookingId, vanId, driverId: driverB }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  expect(fulfilled).toHaveLength(1);

  const rows = await getDb()
    .select({ id: bookings.id, vanId: bookings.vanId })
    .from(bookings)
    .where(inArray(bookings.id, [firstBookingId, secondBookingId]));
  expect(rows.filter((r) => r.vanId === vanId)).toHaveLength(1);
});

it('gives one driver to exactly one of two simultaneous assignments', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  const results = await Promise.allSettled([
    api.admin.dispatch.assign({ bookingId: firstBookingId, vanId: vanA, driverId }),
    api.admin.dispatch.assign({ bookingId: secondBookingId, vanId: vanB, driverId }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});

it('lets a booking keep the van it already has when re-assigning the driver', async () => {
  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await api.admin.dispatch.assign({ bookingId, vanId, driverId });
  await expect(
    api.admin.dispatch.assign({ bookingId, vanId, driverId: otherDriverId }),
  ).resolves.toEqual({
    ok: true,
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- dispatch-assign`
Expected: FAIL — `admin.dispatch` does not exist.

- [ ] **Step 3: Write `assign.ts` and the router**

Order inside the transaction, and it is the whole implementation:

```
1. read the booking (FOR UPDATE)            -- tourId, tourDate, pax, status, current van/driver
2. refuse unless status is in the assignable set   (the Q2/Q3 table above)
3. refuse 'reason_required' if status is in_progress and no trimmed reason came in
4. takeSlotLocks(tx, booking.tourId, booking.tourDate)
5. vansFreeOn(tx, tourDate, booking.pax, { excludeBookingId: bookingId })
6. driversFreeOn(tx, tourDate, { excludeBookingId: bookingId })
7. refuse unless the chosen ids are in those lists
8. update bookings SET van_id, driver_id
      , status = 'assigned'  ONLY IF the current status is 'confirmed' or 'assigned'
                             -- never over pending_verification, never over in_progress
9. writeAudit (action depends on whether the status was in_progress)
```

Step 1 is `.for('update')` and step 3's locks come **before** steps 4 and 5. Both facts are load-bearing; put the reason in a comment, because the next person to read this will want to "simplify" the double locking.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- dispatch-assign`
Expected: PASS (10 tests).

- [ ] **Step 5: Prove the concurrency tests can fail — this is the critical mutation**

1. **Delete the `takeSlotLocks` call.** Both concurrency tests must go red. If they stay green, they are not testing concurrency — they are two sequential calls wearing a `Promise.allSettled`, and the lock is unproven. **Log it and fix the test before continuing.**
2. **Move `takeSlotLocks` to after the availability reads.** At least one concurrency test must go red — this is the REPEATABLE READ snapshot trap, and if neither test notices, neither test is sensitive to lock ordering.
3. Drop the `excludeBookingId` from step 5 -> the re-assignment test goes red.
4. Remove the status guard -> the `pending_payment` and completed/cancelled/expired tests go red.
5. Make the status write unconditional (`status: 'assigned'` always) -> **the pre-assignment test
   "does NOT move a pre-assigned booking to assigned" goes red**, and so does the `in_progress`
   one. This is the money-adjacent mutation in this task; if both stay green, neither test is
   reading the status back and both are worthless.
6. Drop the `reason_required` check -> the no-reason test goes red.
7. Use one audit action name for both paths -> the `booking_reassigned_in_progress` test goes red.

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/dispatch/assign.ts server/src/routers/admin/dispatch.ts server/src/routers/_app.ts shared/src/dispatch.ts server/src/__tests__/dispatch-assign.test.ts
git commit -m "feat(dispatch): one van, one driver, one trip - under the fleet lock"
```

**✅ DONE 10**

---

### Task 11: Auto-suggest (5D, server)

**Files:**

- Create: `server/src/services/dispatch/suggest.ts`
- Modify: `server/src/routers/admin/dispatch.ts` (`suggest`)
- Test: `server/src/__tests__/dispatch-suggest.test.ts`

**Interfaces:**

- Consumes: `vansFreeOn`, `driversFreeOn`.
- Produces:

```ts
export interface Suggestion {
  van: FreeVan | null;
  driver: FreeDriver | null;
  /** Why nothing was suggested, when either side is null. */
  note: 'ok' | 'no_van_fits' | 'no_driver_free' | 'nothing_free';
}
export async function suggestAssignment(tx: Transaction, bookingId: number): Promise<Suggestion>;
// admin.dispatch.suggest({ bookingId }) -> Suggestion
```

§5: "Admin calendar **auto-suggests** a van (smallest that fits) and an available driver."

**Smallest that fits** is unambiguous and falls straight out of Task 3's ordering: `vansFreeOn(...)[0]`. Suggest nothing rather than something wrong — a `null` with a note the UI can explain beats a van that does not fit.

**"An available driver" is ambiguous, and the plan must not pretend otherwise.** Lowest id would mean the same driver gets every trip, which is a fairness and fatigue problem a dispatcher would have to undo by hand every day. So the rule here is **the free driver with the fewest assigned trips in the seven days centred on the tour date, tie-broken by name then id** — spreading work without needing a new column. This is a developer proposal, not R&G policy: it is **Q6**, and it is marked in the code as `proposed by developer — pending R&G confirmation`, the same convention Week 4's twelve-hour window uses.

**Suggest never writes.** It returns a suggestion; the dispatcher presses Assign, and Task 10's locked mutation is the only writer. A suggest that assigned would be a dispatcher's mis-click becoming a driver's morning.

- [ ] **Step 1: Write the failing test**

```ts
it('suggests the smallest van that fits, not the first one', async () => {
  // Fleet: 6-seater, 10-seater, 15-seater. Group of 7.
  const { van } = await getDb().transaction((tx) => suggestAssignment(tx, bookingFor7));
  expect(van?.capacity).toBe(10);
});

it('suggests nothing, with a reason, when no van fits', async () => {
  const result = await getDb().transaction((tx) => suggestAssignment(tx, bookingFor99));
  expect(result).toMatchObject({ van: null, note: 'no_van_fits' });
});

it('spreads work: suggests the free driver with the fewest nearby trips', async () => {
  // driverA has 2 assigned trips in the window, driverB has none.
  const { driver } = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
  expect(driver?.id).toBe(driverB);
});

it('breaks a tie by name so the suggestion is stable across calls', async () => {
  const first = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
  const second = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
  expect(first.driver?.id).toBe(second.driver?.id);
});

it('never suggests a van or driver that assign() would refuse', async () => {
  // The property that matters: suggest and assign must agree, because a
  // suggestion the mutation rejects makes the button look broken.
  //
  // NO `if (s.van && s.driver)` GUARD AROUND THE ASSERTION. An earlier draft
  // of this test wrapped the body in exactly that condition, which makes the
  // test pass by asserting NOTHING the moment `suggestAssignment` returns
  // nulls — and returning nulls is the most likely way for it to be broken.
  // The fixture guarantees a free van and a free driver, so nulls here are a
  // failure, and the two assertions below say so out loud before the
  // agreement is checked at all.
  const s = await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
  expect(s.van, 'fixture guarantees a free van; a null here is the bug').not.toBeNull();
  expect(s.driver, 'fixture guarantees a free driver; a null here is the bug').not.toBeNull();

  const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
  await expect(
    api.admin.dispatch.assign({ bookingId, vanId: s.van!.id, driverId: s.driver!.id }),
  ).resolves.toEqual({ ok: true });
});

it('writes nothing at all', async () => {
  const before = await bookingSnapshot(bookingId);
  await getDb().transaction((tx) => suggestAssignment(tx, bookingId));
  expect(await bookingSnapshot(bookingId)).toEqual(before);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- dispatch-suggest`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Both lists come from `availability.ts`. The driver load count is one grouped query over `bookings` for the seven-day window, restricted to `CAPACITY_HOLDING_STATUSES`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- dispatch-suggest`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove they can fail**

Sort the van list descending → the smallest-that-fits test goes red. Pick `drivers[0]` without the load count → the spreading test goes red. Restore both.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/dispatch/suggest.ts server/src/routers/admin/dispatch.ts server/src/__tests__/dispatch-suggest.test.ts
git commit -m "feat(dispatch): a suggestion that fits, and that spreads the work"
```

**✅ DONE 11**

---

### Task 12: The assignment UI (5D, client)

**Files:**

- Create: `client/src/components/admin/AssignPanel.tsx`
- Modify: `client/src/pages/admin/AdminCalendarPage.tsx`, `client/src/pages/admin/AdminBookingDetailPage.tsx`
- Test: `client/src/__tests__/assign-panel.test.tsx`

**Interfaces:**

- Consumes: `trpc.admin.calendar.dayOptions`, `trpc.admin.dispatch.suggest | assign`, the vendored `select`.
- Produces: `AssignPanel` with props `{ bookingId: number; pax: number; status: BookingStatus; currentVanId: number | null; currentDriverId: number | null; onAssigned(): void }` — used from the calendar's day list **and** from the booking detail page, since §9 lists "Assign van + driver" under Bookings detail as well. One component, two mount points, so the two surfaces cannot drift. **`status` is a required prop**, not derived inside the component: it decides whether the unpaid label shows (Q2) and whether the reason field exists and is required (Q3), and a component that guessed it would guess wrong on the detail page.

**Design (run `ui-ux-pro-max` first).** Queries: `"select dropdown structure" --stack shadcn`, `"submit feedback loading state" --domain ux`, `"inline validation error clarity" --domain ux`. Binding decisions:

- Use the vendored `Select` with the full `SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem` structure — a bare `<select>` is the named anti-pattern, and a `SelectValue` omitted is severity High.
- **The dropdowns contain only what the server said is free.** No disabled-but-visible options for excluded vans: §9 says the dropdowns _exclude_, and a greyed row inviting a click that will be refused is worse than an absence. The count of excluded vans is reported as plain text beneath (`3 vans are unavailable that day`) so the absence is explained rather than mysterious.
- **Error handling follows `QueryBoundary`'s existing rules**: the dropdown contents are handled by hand rather than by `QueryBoundary`, because that component renders a "Try again" `<button>` on failure and a button must never appear inside a Radix listbox — this is the exact lesson `HeroSection.tsx` already carries in a comment. On failure the panel shows an error region **outside** the listbox and keeps the Assign button disabled.
- **Auto-suggest fills the dropdowns; it does not assign.** The button's label is "Suggest", the result is two pre-selected values and a line saying why, and the dispatcher still presses "Assign".
- **The "unpaid" label (owner-decided 2026-10-14, Q2).** When the booking is `pending_verification`, the panel and the assignment it produces both carry an **"unpaid - receipt not yet checked"** label, in **text**, beside the van and driver. Amber, never red. A dispatcher looking at tomorrow's board must be able to see which staffed trips are still unverified without clicking anything, because that is the set where the money can still fall through.
- **The panel renders only for owner and dispatcher** (controller ruling, 2026-10-14).
  `admin.calendar.month` is `bookingsView`, so **finance can open the calendar**, but `dayOptions`
  and `dispatch.assign` are `assignVanDriver`. Without a gate, a finance user would trip a
  `FORBIDDEN` just by selecting a day. So read the role from `staffAuth.me`, render nothing for
  finance, and **do not issue the `dayOptions` query at all** in that case. **Hiding the panel is
  not the access control** — `CLAUDE.md` is explicit about that, and the server procedures stay the
  enforcement (Task 8's role test already proves finance is refused). The gate only stops showing
  someone an error for a thing they never asked for.
- **The reason field appears only for an `in_progress` trip (Q3)**, where it is **required**: a labelled `<textarea>`, a visible "Required" hint, and the Assign button disabled until it is non-empty. It is **absent** for every other status rather than present-and-optional, because an optional box beside a van swap invites a blank one.
- Pending state on both buttons, and a `role="status"` confirmation naming the van and the driver after a successful assignment.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers only the vans the server returned', async () => {
  renderPanel({ options: { vans: [VAN_10], drivers: [DRIVER_A] }, excludedVanCount: 3 });
  await user.click(screen.getByRole('combobox', { name: /van/i }));
  const items = screen.getAllByRole('option');
  expect(items).toHaveLength(1);
  expect(items[0].textContent).toMatch(/ABC 123/);
  expect(screen.getByText(/3 vans are unavailable/i)).toBeTruthy();
});

it('puts no button inside the listbox', async () => {
  renderPanel({ optionsError: 'boom' });
  const listboxes = document.querySelectorAll('[role="listbox"]');
  for (const box of listboxes) {
    expect(box.querySelector('button')).toBeNull();
  }
  expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
  expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
});

it('suggest fills the dropdowns and assigns nothing', async () => {
  const assigns: unknown[] = [];
  renderPanel({
    suggestion: { van: VAN_10, driver: DRIVER_A, note: 'ok' },
    onAssign: (v) => assigns.push(v),
  });
  await user.click(screen.getByRole('button', { name: /suggest/i }));
  expect(screen.getByRole('combobox', { name: /van/i }).textContent).toMatch(/ABC 123/);
  expect(assigns).toEqual([]);
});

it('explains a suggestion that found nothing', async () => {
  renderPanel({ suggestion: { van: null, driver: null, note: 'no_van_fits' } });
  await user.click(screen.getByRole('button', { name: /suggest/i }));
  expect((await screen.findByRole('status')).textContent).toMatch(/no van .*fits/i);
});

it('confirms the assignment by naming the van and the driver', async () => {
  renderPanel({ options: { vans: [VAN_10], drivers: [DRIVER_A] } });
  await pickBoth();
  await user.click(screen.getByRole('button', { name: /^assign$/i }));
  expect((await screen.findByRole('status')).textContent).toMatch(/ABC 123.*Maria/i);
});

/* ---- Q2: the unpaid label ---- */

it('labels a pending_verification assignment as unpaid, in text', () => {
  renderPanel({ status: 'pending_verification', options: { vans: [VAN_10], drivers: [DRIVER_A] } });
  const label = screen.getByText(/unpaid .*receipt not yet checked/i);
  expect(label).toBeTruthy();
  expect(label.closest('[data-testid="unpaid-label"]')?.className).not.toMatch(
    /red|rose|destructive/,
  );
});

it('shows no unpaid label for a confirmed booking', () => {
  renderPanel({ status: 'confirmed', options: { vans: [VAN_10], drivers: [DRIVER_A] } });
  expect(screen.queryByText(/unpaid/i)).toBeNull();
});

/* ---- Q3: the reason field, only where it is required ---- */

it('requires a reason before assigning an in_progress trip', async () => {
  renderPanel({ status: 'in_progress', options: { vans: [VAN_10], drivers: [DRIVER_A] } });
  await pickBoth();
  const reason = screen.getByLabelText(/reason/i);
  expect(reason).toBeTruthy();
  expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
  await user.type(reason, 'Breakdown at Carcar');
  expect(screen.getByRole('button', { name: /^assign$/i })).toBeEnabled();
});

it('offers no reason field at all for a confirmed booking', () => {
  renderPanel({ status: 'confirmed', options: { vans: [VAN_10], drivers: [DRIVER_A] } });
  expect(screen.queryByLabelText(/reason/i)).toBeNull();
});

/* ---- Controller ruling: finance sees no panel and triggers no query ---- */

it('renders nothing for finance, and asks for no options', () => {
  const queries: string[] = [];
  renderPanel({ role: 'finance', onQuery: (name: string) => queries.push(name) });
  expect(screen.queryByRole('button', { name: /^assign$/i })).toBeNull();
  expect(queries).not.toContain('dayOptions');
});

it('renders the panel for owner and for dispatcher', () => {
  for (const role of ['owner', 'dispatcher'] as const) {
    const { unmount } = renderPanel({ role, options: { vans: [VAN_10], drivers: [DRIVER_A] } });
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeTruthy();
    unmount();
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/client test -- assign-panel`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Build the panel and mount it in both places**

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/client test -- assign-panel`
Expected: PASS (5 tests).

- [ ] **Step 5: Prove they can fail**

Render excluded vans as disabled options -> the first test goes red. Have "Suggest" call assign -> the third test goes red. Show the reason field for every status -> the "no reason field for a confirmed booking" test goes red. Drop the disabled state while the reason is empty -> the required-reason test goes red. Restore each.

- [ ] **Step 6: Guards, then commit**

```bash
pnpm --filter @rg/client test -- no-red contrast
git add client/src/components/admin/AssignPanel.tsx client/src/pages/admin/AdminCalendarPage.tsx client/src/pages/admin/AdminBookingDetailPage.tsx client/src/__tests__/assign-panel.test.tsx
git commit -m "feat(dispatch): two dropdowns that only offer what is actually free"
```

**✅ DONE 12**

---

### Task 13: The five dashboard alerts (5E, server)

**Files:**

- Create: `server/src/services/dispatch/alerts.ts`
- Create: `server/src/routers/admin/dashboard.ts`
- Modify: `server/src/routers/_app.ts`, `shared/src/dispatch.ts` (the three thresholds)
- Test: `server/src/__tests__/dashboard-alerts.test.ts`

**Interfaces:**

- Consumes: `adminProcedure('dashboard')`. **Verified to exist** — `ROLE_MATRIX.dashboard` is `['owner', 'dispatcher', 'finance']` (`server/src/middleware/require-role.ts:40`), matching §9's Dashboard row, so no role work is needed and **no new area may be invented**: adding one is a role change and needs the owner.
- Produces:

```ts
export const UNASSIGNED_ALERT_HOURS = 48; // §9, counted BACK from the tour date (Q7)
export const SERVICE_DUE_DAYS = 14; // §9 "Van service due within 14 days"
export const PAPERS_EXPIRING_DAYS = 30; // §9 "licence, OR/CR and franchise expiring within 30 days"

/**
 * Every alert function takes an EXPLICIT `now` (controller ruling,
 * 2026-10-14). A time-dependent query that reads the system clock
 * internally cannot be tested at a boundary without faking timers
 * globally — which is exactly how a timezone bug survives its own test
 * suite. The router passes `new Date()`; the CLIENT never supplies a time,
 * so nobody can move the alert window from a browser.
 *
 * Same discipline as `isDriverVisible(status, tourDate, now)` and
 * `bookableDateRange(settings, now)` in `/shared`.
 */
export interface DashboardAlert {
  kind:
    'payments_to_verify' | 'unassigned_soon' | 'vans_in_repair' | 'service_due' | 'papers_expiring';
  count: number;
  /** At most five examples, for the card's secondary line. Never the whole list. */
  examples: Array<{ id: number; label: string; date: string | null }>;
}
export async function unassignedSoon(tx: Transaction, now: Date): Promise<DashboardAlert>;
export async function paymentsToVerify(tx: Transaction, now: Date): Promise<DashboardAlert>;
export async function vansInRepair(tx: Transaction, now: Date): Promise<DashboardAlert>;
export async function serviceDue(tx: Transaction, now: Date): Promise<DashboardAlert>;
export async function papersExpiring(tx: Transaction, now: Date): Promise<DashboardAlert>;
// admin.dashboard.alerts() -> DashboardAlert[]  (always five entries, zeroes included)
// The procedure takes NO input: it passes its own `new Date()`.
```

**Always five entries, zeroes included.** A dashboard that hides the empty alerts teaches an operator that an absent card means "fine", which is indistinguishable from "the query broke". Five cards, every load, each saying its number.

All date arithmetic goes through `shared/src/time.ts`. The expiry comparisons are string comparisons on civil dates.

**The 48-hour alert — owner-decided 2026-10-14 (Q7), which also settles BUILD_SPEC §15 open question 1.** It counts **back from the tour date**: flag `confirmed` bookings whose tour date falls within the next 48 hours in **Asia/Manila** and which still lack a van **OR** a driver.

Three things that decision pins, each with a test below:

1. **Back from the tour date**, not forward from the booking. The risk being managed is a trip departing unstaffed, not a dispatcher being slow.
2. **`OR`, not `AND`.** A trip with a van and no driver is exactly as stranded as one with neither, and an `AND` would hide the half-staffed trips a dispatcher most needs.
3. **The window is Manila-local, and this is where the bug would be.** `tour_date` is a civil date; the server's clock is UTC. A naive `now + 48h` compared against a civil date is out by eight hours, which for tours that leave at dawn is a whole tour day — the alert would either nag a day early or, worse, stay silent on the morning that matters. Build the window with `manilaCivilDate()` and `manilaInstant()` and compare civil date to civil date. **No `new Date()` arithmetic in this query.**

`confirmed` only, per the decision — `pending_verification` is visible on the calendar but never counted (Q2), and `assigned` trips by definition have both.

- [ ] **Step 1: Write the failing test**

```ts
it('always returns all five alerts, including the empty ones', async () => {
  const api = appRouter.createCaller(staffContext(ownerId, 'owner') as never);
  const alerts = await api.admin.dashboard.alerts();
  expect(alerts.map((a) => a.kind).sort()).toEqual([
    'papers_expiring',
    'payments_to_verify',
    'service_due',
    'unassigned_soon',
    'vans_in_repair',
  ]);
  expect(alerts.every((a) => typeof a.count === 'number')).toBe(true);
});

it('counts a confirmed trip inside the window with no driver', async () => {
  await makeBooking({ tourDate: inManilaDays(1), status: 'confirmed', vanId, driverId: null });
  const alerts = await callAlerts();
  expect(alertFor(alerts, 'unassigned_soon').count).toBe(1);
});

it('does NOT count a trip outside the window', async () => {
  await makeBooking({
    tourDate: inManilaDays(5),
    status: 'confirmed',
    vanId: null,
    driverId: null,
  });
  expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
});

it('counts a trip with a driver but NO van - OR, not AND', async () => {
  await makeBooking({ tourDate: inManilaDays(1), status: 'confirmed', vanId: null, driverId });
  expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(1);
});

/* ---- Q7: the boundary, in Manila time (owner-decided 2026-10-14) ---- */

/**
 * The owner named these tests, and the reason is that a timezone slip here
 * is invisible: every assertion passes in UTC+0 and the alert is wrong by a
 * tour day in Manila. `atManila()` builds a fixed instant from a civil date
 * and a Manila wall-clock time, so these cases do not drift with the day
 * the suite happens to run.
 */
it('counts a trip just INSIDE 48 hours, Manila', async () => {
  // Manila "now" = 2026-11-10 08:00. Tour date 2026-11-12 is 40 hours out.
  const now = atManila('2026-11-10', '08:00');
  await makeBooking({ tourDate: '2026-11-12', status: 'confirmed', vanId: null, driverId: null });
  expect(alertFor(await callAlerts({ now }), 'unassigned_soon').count).toBe(1);
});

it('does NOT count a trip just OUTSIDE 48 hours, Manila', async () => {
  // Manila "now" = 2026-11-10 08:00. Tour date 2026-11-13 is 64 hours out.
  const now = atManila('2026-11-10', '08:00');
  await makeBooking({ tourDate: '2026-11-13', status: 'confirmed', vanId: null, driverId: null });
  expect(alertFor(await callAlerts({ now }), 'unassigned_soon').count).toBe(0);
});

it('does not shift the boundary across Manila midnight', async () => {
  // 23:30 Manila on the 10th is 15:30 UTC on the 10th. A UTC-based window
  // would place "now" on a different civil day and move the boundary by one
  // whole tour date. The 12th must still be inside; the 13th must not.
  const now = atManila('2026-11-10', '23:30');
  await makeBooking({ tourDate: '2026-11-12', status: 'confirmed', vanId: null, driverId: null });
  await makeBooking({ tourDate: '2026-11-13', status: 'confirmed', vanId: null, driverId: null });
  expect(alertFor(await callAlerts({ now }), 'unassigned_soon').count).toBe(1);
});

it('counts a trip departing TODAY that is still unstaffed', async () => {
  // The most urgent case of all, and the one a strict "> now" window drops.
  const now = atManila('2026-11-10', '06:00');
  await makeBooking({ tourDate: '2026-11-10', status: 'confirmed', vanId: null, driverId: null });
  expect(alertFor(await callAlerts({ now }), 'unassigned_soon').count).toBe(1);
});

it('does NOT count an unpaid hold as an unassigned trip', async () => {
  await makeBooking({ tourDate: inManilaDays(1), status: 'pending_payment' });
  expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
});

it('does NOT count a fully staffed trip', async () => {
  await makeBooking({ tourDate: inManilaDays(1), status: 'assigned', vanId, driverId });
  expect(alertFor(await callAlerts(), 'unassigned_soon').count).toBe(0);
});

it('counts a van whose service is due inside 14 days and not one at 15', async () => {
  await makeVan({ plate: 'DUE111', nextService: inManilaDays(14) });
  await makeVan({ plate: 'FAR111', nextService: inManilaDays(15) });
  const alert = alertFor(await callAlerts(), 'service_due');
  expect(alert.count).toBe(1);
  expect(alert.examples[0].label).toMatch(/DUE111/);
});

it('counts an OVERDUE service as well as an upcoming one', async () => {
  // A van whose service date has passed is more urgent, not less. A naive
  // BETWEEN(today, today+14) silently drops it.
  await makeVan({ plate: 'LATE111', nextService: inManilaDays(-3) });
  expect(alertFor(await callAlerts(), 'service_due').count).toBe(1);
});

it('counts licence, OR/CR and franchise expiries in one alert', async () => {
  await makeDriver({ licenseExpiry: inManilaDays(10) });
  await makeVan({ plate: 'ORC111', orcrExpiry: inManilaDays(20) });
  await makeVan({ plate: 'FRA111', franchiseExpiry: inManilaDays(29) });
  expect(alertFor(await callAlerts(), 'papers_expiring').count).toBe(3);
});

it('ignores an inactive van and an inactive driver everywhere', async () => {
  await makeVan({
    plate: 'OLD111',
    status: 'for_repair',
    isActive: false,
    nextService: inManilaDays(1),
  });
  await makeDriver({ licenseExpiry: inManilaDays(1), isActive: false });
  const alerts = await callAlerts();
  expect(alertFor(alerts, 'vans_in_repair').count).toBe(0);
  expect(alertFor(alerts, 'service_due').count).toBe(0);
  expect(alertFor(alerts, 'papers_expiring').count).toBe(0);
});

it('caps examples at five however many rows match', async () => {
  for (let i = 0; i < 9; i += 1) await makeVan({ plate: `REP${i}1`, status: 'for_repair' });
  const alert = alertFor(await callAlerts(), 'vans_in_repair');
  expect(alert.count).toBe(9);
  expect(alert.examples).toHaveLength(5);
});

it('reads thresholds from /shared, so changing one changes the query', async () => {
  // Guards against a hardcoded 14 or 30 drifting from the constant the UI
  // shows. If this fails, a number is written twice somewhere.
  expect(UNASSIGNED_ALERT_HOURS).toBe(48);
  expect(SERVICE_DUE_DAYS).toBe(14);
  expect(PAPERS_EXPIRING_DAYS).toBe(30);
});

it('is readable by all three roles — §9 gives Dashboard to everyone', async () => {
  for (const role of ['owner', 'dispatcher', 'finance'] as const) {
    const api = appRouter.createCaller(staffContext(idFor(role), role) as never);
    await expect(api.admin.dashboard.alerts()).resolves.toHaveLength(5);
  }
});
```

The overdue-service test is the one worth noticing: `next_service <= today + 14` catches the overdue van, `BETWEEN today AND today + 14` silently drops it, and both look correct when you read them.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- dashboard-alerts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the five queries**

One exported function each, each returning `DashboardAlert`, each with its own `COUNT(*)` plus a `LIMIT 5` example query. Not one clever union — five legible queries a reviewer can check against §9 line by line.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/server test -- dashboard-alerts`
Expected: PASS (12 tests).

- [ ] **Step 5: Prove they can fail**

1. Change `next_service <= today + SERVICE_DUE_DAYS` to a `BETWEEN` → the overdue test goes red.
2. Drop the `is_active` filter → the inactive test goes red.
3. Include `pending_payment` in the unassigned query -> that test goes red.
4. Return only the non-empty alerts -> the five-entries test goes red.
5. **Change the `OR` between the two null checks to an `AND`** -> the driver-but-no-van test goes red.
6. **Build the window from `new Date()` + 48h instead of the Manila helpers** -> the midnight test
   goes red. If it stays green, the boundary tests are not timezone-sensitive and Q7's named
   requirement is unmet, whatever the other assertions say. Log it and fix the test first.
7. Change the tour-date comparison from `<=` to `<` -> the departing-today test goes red.

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/dispatch/alerts.ts server/src/routers/admin/dashboard.ts server/src/routers/_app.ts shared/src/dispatch.ts server/src/__tests__/dashboard-alerts.test.ts
git commit -m "feat(admin): five alerts, including the ones that say zero"
```

**✅ DONE 13**

---

### Task 14: The dashboard screen (5E, client)

**Files:**

- Create: `client/src/pages/admin/AdminDashboardPage.tsx`
- Create: `client/src/components/admin/AlertCard.tsx`
- Modify: `client/src/App.tsx` (`admin` index route)
- Test: `client/src/__tests__/admin-dashboard-page.test.tsx`

**Interfaces:**

- Consumes: `trpc.admin.dashboard.alerts`, `DashboardAlert` from `@rg/shared`.
- Produces: `AlertCard` with props `{ alert: DashboardAlert }`.

**Design (run `ui-ux-pro-max` first).** Queries: `"live badge count screen reader" --domain ux`, `"card grid dashboard density" --domain ux`, `"status dot color alone meaning" --domain ux`. Binding decisions:

- **Amber, never red** — `CLAUDE.md` is absolute, and a dashboard of warnings is exactly where an implementer reaches for red. Amber background, `brand-blue-900` text for the body, and the count in a weight that carries the urgency instead of a colour doing it.
- **Every card states its number in text**: `2 payments to verify`, not a bare `2` beside an icon. The live-badge guidance is explicit — announce "3 items in cart", never a bare number.
- **A zero card looks settled, not alarming**: no amber, a quiet `All clear` line. The card is still present, so an operator can tell "nothing to do" from "nothing loaded".
- **Each card links to the surface that resolves it**: payments → `/admin/bookings?filter=pending_verification`; unassigned → `/admin/calendar`; repair, service, papers → `/admin/vans` and `/admin/drivers`. An alert with no route to its fix is a nag.
- **One `role="status"` region for the whole set**, not one per card — five competing live regions is the named anti-pattern.
- The dashboard says plainly that **today's departures with check-in progress arrive in Week 6**, rather than leaving a blank panel the owner has to ask about.

- [ ] **Step 1: Write the failing test**

```tsx
it('states each count in words, not as a bare numeral', () => {
  renderDashboard({ alerts: [{ kind: 'payments_to_verify', count: 2, examples: [] }] });
  expect(screen.getByText(/2 payments to verify/i)).toBeTruthy();
});

it('renders a zero alert as all clear, and still renders the card', () => {
  renderDashboard({ alerts: [{ kind: 'vans_in_repair', count: 0, examples: [] }] });
  expect(screen.getByText(/vans in repair/i)).toBeTruthy();
  expect(screen.getByText(/all clear/i)).toBeTruthy();
});

it('uses amber and never red for an alert', () => {
  renderDashboard({ alerts: [{ kind: 'service_due', count: 3, examples: [] }] });
  const card = screen.getByTestId('alert-service_due');
  expect(card.className).toMatch(/amber/);
  expect(card.className).not.toMatch(/red|rose|destructive/);
});

it('links every non-zero alert to the screen that resolves it', () => {
  renderDashboard({ alerts: ALL_FIVE_NONZERO });
  const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
  expect(hrefs).toContain('/admin/calendar');
  expect(hrefs.some((h) => h?.startsWith('/admin/bookings'))).toBe(true);
});

it('uses one status region for the whole set', () => {
  renderDashboard({ alerts: ALL_FIVE_NONZERO });
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

it('says that live departures are Week 6 rather than showing an empty panel', () => {
  renderDashboard({ alerts: ALL_FIVE_NONZERO });
  expect(screen.getByText(/departure progress .* week 6|coming in week 6/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/client test -- admin-dashboard-page`
Expected: FAIL — page does not exist.

- [ ] **Step 3: Build `AlertCard` and the page**

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rg/client test -- admin-dashboard-page`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove they can fail**

Render the count as a bare numeral → the first test goes red. Hide zero cards → the second goes red. Give each card its own `role="status"` → the fifth goes red. Restore each.

- [ ] **Step 6: Guards, then commit**

```bash
pnpm --filter @rg/client test -- no-red contrast
git add client/src/pages/admin/AdminDashboardPage.tsx client/src/components/admin/AlertCard.tsx client/src/App.tsx client/src/__tests__/admin-dashboard-page.test.tsx
git commit -m "feat(admin): the dashboard, in amber, with its zeroes showing"
```

**✅ DONE 14**

---

### Task 15: Seed data a dispatcher can actually use

**Files:**

- Modify: `server/src/db/seed-data.ts`
- Test: `server/src/__tests__/seed-dispatch.test.ts`

Every screen in this week is empty on a fresh clone, because the seed has no vans and no drivers. A dispatcher demo with an empty fleet proves nothing, and the Task 16 walkthrough cannot run at all.

**Interfaces:**

- Consumes: nothing new.
- Produces: seeded vans and drivers, plus leave rows, all flagged as development content in the same way the rest of the seed is.

Seed, at minimum: **four vans** (6, 10, 15 and 15 seats, one of them `for_repair` with repair notes, one with `next_service` inside 14 days and one with `franchise_expiry` inside 30 days, so the dashboard has something true to show), **four drivers** (one with a licence expiring inside 30 days, one on leave across a weekend), and **two confirmed unassigned bookings** inside the 48-hour window so the unassigned alert and the gold dot both have a real example.

**Permit and franchise numbers stay fictional-but-obviously-fake** (`FR-SEED-0001`), never a plausible-looking real number. `CLAUDE.md`: never invent an accreditation number. A seeded franchise number that looks real could end up in a screenshot or a demo and be taken as R&G's actual franchise.

- [ ] **Step 1: Write the failing test**

```ts
it('seeds a fleet with a mix of sizes and one van in repair', async () => {
  const rows = await getDb().select().from(vans);
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(new Set(rows.map((v) => v.capacity)).size).toBeGreaterThanOrEqual(3);
  expect(rows.filter((v) => v.status === 'for_repair')).toHaveLength(1);
});

it('seeds every dashboard alert with at least one real row', async () => {
  const alerts = await callAlerts();
  for (const kind of [
    'unassigned_soon',
    'vans_in_repair',
    'service_due',
    'papers_expiring',
  ] as const) {
    expect(alertFor(alerts, kind).count).toBeGreaterThan(0);
  }
});

it('uses obviously fake franchise numbers', async () => {
  const rows = await getDb().select().from(vans);
  for (const van of rows) {
    if (van.franchiseNo) expect(van.franchiseNo).toMatch(/SEED/);
  }
});

it('seeds no plaintext PIN anywhere', async () => {
  const rows = await getDb().select().from(drivers);
  for (const d of rows) expect(d.pinHash.startsWith('scrypt$')).toBe(true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @rg/server test -- seed-dispatch`
Expected: FAIL — no vans seeded.

- [ ] **Step 3: Extend the seed, then re-seed and re-run**

```bash
pnpm --filter @rg/server db:seed
pnpm --filter @rg/server test -- seed-dispatch
```

- [ ] **Step 4: Prove they can fail**

Remove the `for_repair` van → the first test goes red. Restore.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/seed-data.ts server/src/__tests__/seed-dispatch.test.ts
git commit -m "feat(seed): a fleet, four drivers, and an alert for every card"
```

**✅ DONE 15**

---

### Task 16: The Week 5 walkthrough, and closing the week

**Files:**

- Create: `docs/superpowers/plans/2026-10-14-week5-walkthrough.md`
- Modify: `docs/BUILD_SPEC.md` (§13 Week 5), `CLAUDE.md` (the dispatch conventions worth standing)

Not a code task. Drive every 5A–5E flow against the running app and record what was proven, what was mocked, and what failed and was fixed — the same evidence record Week 4's Task 12 produced, and under the same rule: a step that could not be proven is labelled, not papered over.

- [ ] **Step 1:** Vans: create, edit, set each status, confirm the soft-delete has no hard-delete path in the UI or the router.
- [ ] **Step 2:** Drivers: create, edit, add and remove leave, reset a PIN, and confirm the revealed PIN appears exactly once and in no log. **Check the server's stdout for the six digits** — the test asserts the audit row, this step asserts the terminal.
- [ ] **Step 3:** Calendar: a month with trips, a gold-dot day, keyboard-only navigation across a month boundary, and the day list at 360px.
- [ ] **Step 4:** Assignment: assign, re-assign, and the three refusals (too small, driver on leave, unpaid hold). Then **two browser tabs assigning the same van at once** — one wins, and the loser's message names the reason.
- [ ] **Step 5:** Auto-suggest: smallest van that fits, the spread across drivers over several bookings, and the `no_van_fits` explanation.
- [ ] **Step 6:** Dashboard: all five alerts non-zero against the seed, then resolve one and watch its count fall.
- [ ] **Step 7:** Fix anything found, with a test per fix, then re-run the whole pass.
- [ ] **Step 8:** Update `docs/BUILD_SPEC.md` §13's Week 5 preamble, which currently says "Nothing in this week is built." **Rewrite it to say what is true** and mark 5A–5E — the same correction Week 3's Task 13 and Week 4's close both had to make, which is now three weeks in a row and worth doing as part of the week rather than after it.
- [ ] **Step 9a: Record the two carry-forward constraints Week 6 inherits.** Neither is optional
      and neither is visible from Week 6's own task list, so both go into §13's **Week 6**
      preamble, not only into this plan: 1. **`on_trip` must be cleared when a trip completes (from Q1's allow-list).** 6C's
      check-ins are the first code to set it, and `VAN_STATUS_SELLABLE` allow-lists
      `available` alone — so a van left `on_trip` stops being sellable on every future date. 2. **The driver portal must reflect a mid-trip re-assignment (owner-decided 2026-10-14,
      Q3).** A driver whose trip was taken off them must stop seeing it, and the driver who
      received it must start. 6A/6B build that portal; this week creates the event it has to
      respond to.

- [ ] **Step 9:** Add to `CLAUDE.md`: the availability module is the single source of truth for van/driver freeness, and the dispatch lock order is `fleet_date_slots` → `tour_date_slots` → the booking row, matching the existing booking path.
- [ ] **Step 10:** Five checks, **each run separately with its exit code reported**, then commit, then write **✅ WEEK 5 COMPLETE** — with any unproven step named in the marker itself, Week 4's convention.

**✅ DONE 16**

---

## Which test proves which constraint

| Constraint                                                 | Proven by                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A van is never sent to two trips on one day                | Task 10's concurrent-assignment test, with the lock deleted as the mutation                      |
| A driver is never sent to two trips on one day             | Task 10's concurrent-driver test                                                                 |
| A driver on leave is never dispatched                      | Task 3 (inclusive range) + Task 10's refusal test                                                |
| A van too small is never dispatched                        | Task 3 + Task 10                                                                                 |
| A van in repair is never sold or dispatched                | Task 2's capacity test + Task 3's exclusion                                                      |
| A parked van is never sold                                 | Task 2's `assessCapacity` test (gated on Q1)                                                     |
| Everything checkout accepted can be dispatched             | Task 3's agreement test                                                                          |
| A cancelled trip gives its van back                        | Task 3's non-holding-status test                                                                 |
| Assignment changes no money                                | Task 10's money-snapshot test                                                                    |
| Only a webhook or an admin approval marks a booking paid   | Unchanged from Week 3; Task 10 adds no path, and its money snapshot proves it                    |
| Finance cannot assign, edit vans, or edit drivers          | Tasks 4, 6 and 10's role refusals, each proven by widening the area and watching the test go red |
| A guest's email never reaches the month view               | Task 8's privacy test                                                                            |
| A driver's PIN is never readable twice, logged, or audited | Task 6's three PIN tests                                                                         |
| A locked-out driver can be recovered                       | Task 6's lockout-clearing test                                                                   |
| Two leaves for one driver cannot overlap                   | Task 6's overlap test (the gap `schema.ts` names)                                                |
| An overdue service is still an alert                       | Task 13's overdue test                                                                           |
| A zero alert is visible, not hidden                        | Task 13's five-entries test + Task 14's all-clear test                                           |
| Information is never conveyed by colour alone              | Task 9's accessible-name tests + Task 14's count-in-words test                                   |
| The grid is crossable by keyboard                          | Task 9's roving-tabindex and arrow-key tests                                                     |
| No red anywhere                                            | The existing `no-red` guard, run in Tasks 5, 7, 12 and 14                                        |
| AA contrast on every new pairing                           | The existing `contrast` guard, which reads real source                                           |
| Every admin procedure has role middleware                  | The existing `procedure-role-metadata` test, which fails if a new router forgets                 |

---

## Questions — ask before the task that needs each

Listed, not guessed. **Q1, Q2, Q3 and Q7 block tasks** and are marked so. The rest have a stated default that the plan implements if no answer arrives, and each default is the conservative choice.

### Q1 — ✅ ANSWERED: add `parked`, and make Gate 2 an ALLOW-LIST (owner-decided 2026-10-14)

**Owner decision.** Add §9's fourth van status, and change `assessCapacity()`'s Gate 2 from a
deny-list to an **allow-list**: **only `status = 'available'` counts as sellable fleet.** Never
`status <> 'for_repair'`. A new or unknown status is therefore excluded by default.

This is a stronger answer than the plan's option (a), and the reason is the direction it fails in.
A deny-list says "everything is sellable except the things I remembered to list", so the next
status anyone adds — `parked`, `impounded`, `sold` — is silently sellable until someone notices.
An allow-list says "nothing is sellable unless it is available", and a forgotten status costs a
refused booking instead of an oversold trip. **Fail closed**, which is `CLAUDE.md`'s rule for
exactly this kind of gate.

Two tests came with the decision, and Task 2 owes both: **every non-`available` status is
excluded**, and **capacity and dispatch availability agree** on what a van's status means.

**One consequence to carry into Week 6, flagged rather than buried.** `on_trip` is now unsellable
too. §9 says "'On tour' is derived from in-progress trips", so it is meant to be a _today_ status
that clears when the trip ends — and while nothing in the codebase sets or clears it (check-ins
are Week 6, 6C), no van is ever `on_trip` and the allow-list costs nothing. **When Week 6 starts
writing `on_trip`, it must also clear it**, or a van that drove one trip stops being bookable for
every future date. Task 2 writes that requirement into the schema comment beside the status, where
the person building 6C will actually read it.

### Q2 — ✅ ANSWERED: visible, labelled, not counted, and pre-assignable (owner-decided 2026-10-14)

**Owner decision**, and it is four separate rulings on one booking status:

1. A `pending_verification` booking **appears on the dispatch calendar** — it is a probable trip
   and a dispatcher planning a week needs to see it.
2. It is **labelled "awaiting payment check"** — **as text, not as a colour** (the §9 gold-dot rule
   applies to every marker on this screen, not only that one).
3. It does **not** count toward **"needs assignment"**, so it never lights the gold dot and never
   inflates the dashboard's unassigned count.
4. Dispatch **may pre-assign** it, and the assignment then **shows an "unpaid" label** wherever it
   appears.

They keep holding capacity exactly as today — `CAPACITY_HOLDING_STATUSES` is unchanged.

This changes the plan as written in two places, and both changes are real work, not wording:
**Task 8** gains the `awaitingPaymentCheck` flag on `CalendarTrip` and a test that it is text;
**Task 10**'s status guard must now **admit `pending_verification`**, where the plan's default
refused it. `pending_payment` is still refused — an unpaid hold with fifteen minutes left on it is
not something to staff a van against.

### Q3 — ✅ ANSWERED: yes, `in_progress` may be re-assigned, with a required reason (owner-decided 2026-10-14)

**Owner decision.** A trip already under way **may** have its van and/or its driver changed —
a van breaking down mid-trip is a real morning, and dispatch must be able to record what actually
happened rather than leave the record wrong.

Four conditions came with it, all binding on Task 10:

1. **Owner and dispatcher only** — `adminProcedure('assignVanDriver')`, which is already that pair.
   Finance is refused, and owes a test.
2. **A reason is REQUIRED** for an `in_progress` re-assignment. Not optional, not defaulted.
3. **The audit row carries old → new values** for both van and driver, plus the reason.
4. **The driver portal must reflect the change.** That portal does not exist yet — it is Week 6
   (6A/6B) — so this becomes a **carry-forward constraint on Week 6**, recorded in Task 16 and in
   §13's Week 6 preamble rather than silently owed: a driver whose trip was taken off them must
   stop seeing it, and the driver who received it must start.

Three named tests: **a missing reason is refused**, **finance is refused**, **the audit row is
written** with both old and new values.

The reason is required only where the owner required it — an `in_progress` change. A
`confirmed → assigned` first assignment and a `confirmed`/`assigned` re-assignment before
departure take no reason, because nothing is being undone.

### Q4 — Does `drivers.status = 'off_duty'` block dispatch? (Task 3)

§9 lists driver status as `active / on leave (with date ranges) / inactive`, and the schema's enum is `available / on_trip / off_duty`. Leave is a date range, so it answers "is this driver working on 12 November". The flag answers "is this driver working right now".

The plan **does not** exclude `off_duty` drivers from future dates, because a flag set today would otherwise hide a driver from every date in the calendar until someone remembered to clear it.

**Confirm:** is `off_duty` a today-only signal (the plan's reading), or does it mean "do not dispatch at all until I say otherwise"?

**Default if unanswered:** today-only; leave ranges are what block a date.

### Q5 — Who may reset a driver's PIN? (Task 6)

§9's role matrix has a "Vans, drivers" row (owner ✅, dispatcher ✅, finance ❌) and lists PIN reset under Drivers, so the plan makes `resetPin` an `adminProcedure('vansDrivers')` — a dispatcher can do it.

That is probably right operationally: a driver locked out at 5am needs the dispatcher on duty, not the owner. But a PIN reset is a credential operation, and the row it sits in was written for "edit a van's odometer".

**Confirm:** dispatcher **and** owner (the plan's default), or owner only?

### Q6 — How should auto-suggest pick a driver? (Task 11)

§5 says "auto-suggests a van (smallest that fits) and **an available driver**". The van half is unambiguous; the driver half is not.

The plan proposes **the free driver with the fewest assigned trips in the seven days centred on the tour date**, tie-broken by name, so work spreads instead of landing on whoever has the lowest id. It is marked in the code as _proposed by developer — pending R&G confirmation_.

**Alternatives:** by language match against the booking's requests; by the driver's average rating; by seniority; or genuinely arbitrary, leaving fairness to the dispatcher. **Default if unanswered:** fewest nearby trips, as proposed.

### Q7 — ✅ ANSWERED: count BACK from the tour date (owner-decided 2026-10-14)

**Owner decision**, which also settles BUILD_SPEC §15's open question 1. The alert flags
**`confirmed` bookings whose tour date is within 48 hours (Asia/Manila) and which still lack a van
OR a driver.** Back from the tour date, not forward from the booking.

`OR`, not `AND`: a trip with a van and no driver is just as stranded as one with neither, and an
`AND` would hide exactly the half-staffed trips a dispatcher most needs to see.

**Tests at the 48-hour boundary, in Manila time** — named by the owner, and the reason they are
named is that this is the one calculation in the week where a timezone slip is invisible. The
server stores UTC and the boundary is Manila-local, so a naive `now + 48h` against a civil
`tour_date` is wrong by eight hours — which, for a business whose tours leave at dawn, is a whole
tour day. The window comes from `manilaCivilDate()` / `manilaInstant()` in `shared/src/time.ts`,
never from `new Date()` arithmetic.

### Q8 — May this week vendor three more shadcn primitives? (Tasks 5, 7, 12)

Only `accordion`, `badge`, `button`, `card`, `input`, `label` and `select` are vendored. This week wants a data table, a confirmation, a free-text field and a status toggle, and the plan builds all four from what exists: a semantic `<table>` with Tailwind (the pattern `AdminBookingsPage` already uses), an inline two-step confirm instead of a modal, a plain `<textarea>`, and a labelled `Select` instead of a switch.

That keeps `CLAUDE.md`'s "no libraries not in the spec without asking" cleanly satisfied, and `shadcn add table dialog textarea switch` would vendor source files rather than add runtime dependencies — but it still adds files and patterns, so it is an ask rather than a judgment call.

**Default if unanswered:** build from the vendored seven, as written.

### Q9 — Should a van or driver edit be blocked while it has upcoming trips? (Tasks 4 and 6)

Dropping a van's `capacity` from 15 to 10 does not re-check the trips already assigned to it, so a 12-guest trip can end up on a 10-seat van and nothing complains until the morning. The same applies to deactivating a driver who has three trips next week.

**Options:** (a) refuse the edit while the van or driver has capacity-holding assigned trips that the change would break, naming them; (b) allow it and raise a sixth dashboard alert for "assignment no longer fits"; (c) allow it silently, and trust the dispatcher.

**Default if unanswered:** (a) for the specific case of shrinking capacity below an assigned trip's `pax`, and for deactivating a driver or van with upcoming assigned trips — refuse, and name the trips. It is the conservative choice and the only one that cannot strand a guest. **It adds two queries to Task 4 and Task 6 that are not in their test lists above**, so if the owner prefers (b) or (c), those two tasks get smaller.

### Q10 — Does the dashboard need a "today's departures" placeholder at all? (Task 14)

§9's dashboard leads with "today's departures with stop-by-stop progress bars", which needs `trip_checkpoints` writes that arrive in Week 6 (6D). The plan renders a one-line note saying so.

**Confirm:** a note (the default), or omit the panel entirely until Week 6 builds it?

---

## Self-review

**1. Spec coverage.** §13's Week 5 lines map as: **5A** → Tasks 4 + 5 (+ Task 2 for the fourth status, gated); **5B** → Tasks 6 + 7; **5C** → Tasks 8 + 9; **5D** → Tasks 10 + 11 + 12; **5E** → Tasks 13 + 14. §9's "Calendar" exclusion list → Task 3, which is the module all of 5C/5D read. §9's "Vans" field list → already in the schema, surfaced by Task 4. §9's "Drivers" field list including PIN reset → Task 6. §9's five dashboard alerts → Task 13, one function each. §5's assignment rule (auto-suggest, smallest van that fits, the 48-hour alert) → Tasks 11 and 13. §15 open question 1 → **Q7**, asked rather than assumed. Seed and evidence → Tasks 15 and 16.

**Gaps I am declaring rather than hiding:**

- §9's dashboard "today's departures with stop-by-stop progress bars" needs `trip_checkpoints` writes, which are **Week 6 (6D)**. Task 14 renders a note; **Q10** asks whether that is wanted.
- §9's "Bookings → Send reminder (email/SMS)", "Mark completed", "Cancel/refund" and "Record a manual payment" sit on the bookings **detail** page, and none of them is a Week 5 line. Cancel/refund is **6F**; the reminder email is the Week 4 carry-forward; "mark completed" belongs with check-ins in Week 6. **No task here touches them**, deliberately — this week writes no money.
- Two overlapping **leaves** are now refused (Task 6), closing a gap `schema.ts` names. Two overlapping **assignments** for one driver are refused by Task 3 plus Task 10's lock. Neither change touches the DB CHECK, which still constrains one row only — correctly, since the multi-row rule needs a query.
- `vans.odometer` is editable but nothing updates it from a trip; §9 lists it as a field, not as a workflow. Left as a plain field.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N" — each task repeats the code it needs. Tasks 1–3 and 8–14 carry full test code. Tasks 4, 5, 6, 7, 12, 13 and 14 carry full test code for the assertions that matter and **named** implementation shapes rather than complete component bodies, because the JSX depends on a `ui-ux-pro-max` query the implementer must actually run — a plan that pre-writes the markup would make that query decorative. Task 2 is deliberately incomplete until **Q1** is answered, and says so in its first line rather than hiding it behind a guess.

**3. Type consistency.** Checked across tasks: `FreeVan` / `FreeDriver` / `FreeOnOptions` are defined in Task 3 and consumed unchanged by Tasks 8, 10, 11 and 12. `vansFreeOn(tx, date, minCapacity, opts?)` — four parameters, that order — is called identically in Tasks 8, 10 and 11. `driversFreeOn(tx, date, opts?)` likewise. `CalendarDay` / `CalendarTrip` are defined in Task 8 and consumed by Task 9. `DashboardAlert` is defined in Task 13 and consumed by Task 14. `EntityFormProps` is defined in Task 5 and reused in Task 7. `AssignRefusal`'s five members are the only refusal strings Task 12's UI maps to copy. **`VAN_STATUS_SELLABLE` is produced by Task 2 and consumed by both Task 3 and `assessCapacity()`** — the single allow-listed status, which is what makes Task 2's agreement test possible at all. Task 2 is no longer gated (Q1 answered), so Task 3's dependency on it is a plain ordering requirement: Task 2 ships first.

**4. One thing I want to flag rather than bury.** Task 10 is the first code in this project to write `bookings.van_id`, and its two concurrency tests are the only thing standing between this week and a van sent to two trips on one morning. Both tests are written as overlapping transactions, and Task 10's Step 5 requires deleting the lock and watching them go red **before** the task is allowed to close. If either test stays green with the lock deleted, it is not testing what it claims, and this project has already found twelve-plus tests in exactly that condition. That step is not optional polish; it is the task.
