# Home Page, Login Redirect & Place Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the public reviews section/nav link when there are zero real reviews; fix the admin "expired session" dead-end by redirecting to `/admin/login`; add a required Place Type (replacing the `isAirport` boolean) with icons across admin and public transfer UI; add a "Show on home page" flag to transfer routes and a "Popular transfers" card section on the home page; add optional ferry pickup fields (vessel name, arrival time) for pier pickups, mirroring the existing flight-details pattern.

**Architecture:** One migration (`0027` + `0028`, additive-then-subtractive, mirroring the existing `0023`/`0024` two-stage pattern) adds `transfer_places.place_type`, four `transfer_routes` home-page columns, and two `booking_transfer_details` ferry columns, then drops the old `is_airport` boolean. Every reader of `isAirport` (shared types, the create-booking service, public/admin routers, admin and public client UI) is swapped to `placeType` in lockstep. The reviews boolean and the home-page route list both follow the existing "server decides, client only renders" pattern already used for `showTours`/`onlinePaymentEnabled`.

**Tech Stack:** React + TypeScript + Vite + Tailwind v4 + shadcn/ui + React Router · Express + tRPC · Drizzle + MySQL 8 · Zod (shared) · lucide-react icons (already a dependency — no new packages).

**Spec:** The owner's brief, given directly in this conversation on 2026-11-13 ("TravelSugbo — Hide empty reviews + admin login redirect + place types & home 'Popular transfers' cards"), plus `CLAUDE.md` at the repo root, which wins any disagreement with this plan.

## Global Constraints

- **Money:** integer centavos everywhere; the server computes all money; the client never re-derives a price. The "Popular transfers" card price is read verbatim from the server, never summed/computed in the browser.
- **No red anywhere.** Warnings/errors use amber/blue-grey, never red. The guard tests (`no-red.test.ts`, `contrast.test.ts`) must keep passing.
- **Admin buttons:** only the six `Button` variants (`primary-pill`, `secondary-pill`, `admin-ghost`, `amber-pill`, `row`, `row-amber`) on admin screens, never a paired `size`. One primary pill per visible region. Destructive/irreversible confirms are `amber-pill`/`row-amber`, never blue or red.
- **Public site buttons** use the plain shadcn variants (`default`, `outline`, etc.) with the `tap-target` class — never the admin pill variants.
- **44px minimum tap targets, visible focus states, alt text, AA contrast, mobile-first at 360px.**
- **Soft deletes only.** Never hard-delete a place, route, or booking. `isActive`/status flags only.
- **No new dependencies.** lucide-react is already installed; use its existing icons.
- **No fake social proof, no invented prices/ratings/accreditation numbers.**
- **DO NOT** push, run `/loop`, schedule wakeups, touch the VPS, weaken auth/Turnstile/rate limits, change money math/holds/roles, or add dependencies.
- **ONE implementer at a time.** Tasks below run sequentially, each as its own subagent dispatch with a review gate before the next starts.
- **Review assignment (owner-specified):** Task 1 (the migration) and Task 2 (the admin session redirect, owner item 1B) each get a **dedicated Opus-level review** before moving on. Tasks 3–8 (owner items 1C–1E, 1A) get **one combined Sonnet-level review** after all of them are implemented, before the final verification pass.
- **Commits:** one commit per task, in the form `hash - short label`. Keep any `pnpm format` sweep in its own separate commit.
- **Tests:** every new test must be provably able to fail (break the code, watch it go red, restore it). A test that cannot fail is logged in `docs/BUGS_LOG.md`, not shipped as decoration. Security/destructive paths need a test of the failure path specifically.
- **Full verification, once, at the end, in this order:** `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm format:check` → `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Never report work done on an unrun command.
- **After the schema migration, remind the user to apply it on the server database** (this is a local/staging plan only — no deploy).
- **Unrelated bugs found along the way:** list them at the end (name + one-line description); do not fix them unless they block the current task.

---

## Task 1: Migration `0027`/`0028` — place types, home-page route fields, ferry fields

**[DEDICATED OPUS REVIEW before continuing to Task 2.]**

This is pure schema + migration. No application code reads the new columns yet (that is Tasks 3–7); this task only adds them and retires `is_airport`, following the exact two-stage additive/subtractive shape `0023`/`0024` already established for this schema (see that file's own header comment: splitting additive from subtractive avoids `drizzle-kit generate`'s column-rename heuristic firing on an enum swap).

**Files:**

- Modify: `shared/src/transfers.ts` (add `TRANSFER_PLACE_TYPES`/`TransferPlaceType`, update `TransferPlacePublicRow`)
- Modify: `server/src/db/schema.ts` (`transferPlaces`, `transferRoutes`, `bookingTransferDetails`)
- Create: `server/src/db/migrations/0027_<drizzle-generated-name>.sql` (additive)
- Create: `server/src/db/migrations/0028_<drizzle-generated-name>.sql` (subtractive)

**Interfaces:**

- Produces: `TRANSFER_PLACE_TYPES = ['airport', 'pier', 'city', 'destination'] as const`, `type TransferPlaceType`, DB column `transfer_places.place_type` (enum, NOT NULL, default `'destination'`), `transfer_routes.show_on_home_page` (boolean NOT NULL default false), `transfer_routes.home_page_badge` (varchar(20), nullable), `transfer_routes.home_page_order` (int NOT NULL default 0), `transfer_routes.home_page_short_description` (varchar(120), nullable), `booking_transfer_details.ferry_vessel_name` (varchar(120), nullable), `booking_transfer_details.ferry_arrival_time` (varchar(5), nullable). Every later task consumes these exact names.

- [ ] **Step 1: Add the shared place-type vocabulary**

In `shared/src/transfers.ts`, beside the existing `TRANSFER_DIRECTIONS` export (near line 40):

```ts
/**
 * What a pickup/drop-off place IS — replaces the old `isAirport` boolean
 * (owner decision 2026-11-13). `'airport'` keeps every existing flight-field
 * rule unchanged (it is the same gate `isAirport === true` used to be);
 * `'pier'` is new and gates the ferry fields (Task 1E); `'city'` and
 * `'destination'` carry no special field requirements today but exist so a
 * place's type is always a real fact, never a residual "false".
 */
export const TRANSFER_PLACE_TYPES = ['airport', 'pier', 'city', 'destination'] as const;
export type TransferPlaceType = (typeof TRANSFER_PLACE_TYPES)[number];
```

Then change `TransferPlacePublicRow` (near line 104):

```ts
export interface TransferPlacePublicRow {
  id: number;
  name: string;
  placeType: TransferPlaceType;
}
```

(removes `isAirport: boolean`).

- [ ] **Step 2: Edit `server/src/db/schema.ts`**

Add `TRANSFER_PLACE_TYPES` to the existing `@rg/shared` import at the top of the file (it already imports `TRANSFER_DIRECTIONS` from the same line per the file's existing pattern).

Replace, in `transferPlaces` (around line 274):

```ts
isAirport: boolean('is_airport').notNull().default(false),
```

with:

```ts
placeType: mysqlEnum('place_type', TRANSFER_PLACE_TYPES).notNull().default('destination'),
```

Add four columns to `transferRoutes`, immediately after `exclusionsText` (around line 337), before `createdAt`:

```ts
/**
 * "Popular transfers" home-page card (owner decision 2026-11-13, Task 1D).
 * Independent of `isActive`/`sortOrder` — a route can be sellable without
 * being featured, and vice versa is refused nowhere (an inactive route
 * simply never reaches the public list `homeFeaturedTransferRoutes()`
 * reads, same as it never reaches `transferRoutes.list`).
 */
showOnHomePage: boolean('show_on_home_page').notNull().default(false),
/** Short label shown as an amber pill on the card, e.g. "Most booked". Optional. */
homePageBadge: varchar('home_page_badge', { length: 20 }),
/** Where this route sorts among OTHER featured routes, lowest first. Not the same ordering as `sortOrder`. */
homePageOrder: int('home_page_order').notNull().default(0),
/** Optional card copy, shown under the From → To title. */
homePageShortDescription: varchar('home_page_short_description', { length: 120 }),
```

Add two columns to `bookingTransferDetails`, immediately after `airline` (around line 1652):

```ts
/** Pier/port pickups or drop-offs only — the ferry-leg counterpart of `flightNumber`. */
ferryVesselName: varchar('ferry_vessel_name', { length: 120 }),
/** "HH:mm" civil label, Asia/Manila — same convention as `pickupTime`. Pier/port only. */
ferryArrivalTime: varchar('ferry_arrival_time', { length: 5 }),
```

- [ ] **Step 3: Generate and hand-finish migration `0027` (additive)**

Run:

```bash
pnpm --filter @rg/server db:generate
```

This should produce one new file (no rename prompt, since nothing is being dropped in this stage — only columns added). Rename/confirm it is numbered `0027`. Open it and append the backfill statements after the generated `ALTER TABLE ... ADD` statements (the generated statements for the 7 new columns should already be correct; verify `place_type` defaults to `'destination'` and the four `transfer_routes`/two `booking_transfer_details` columns match Step 2 exactly). Append:

```sql
--> statement-breakpoint
-- Backfill (owner decision 2026-11-13). A no-op on an empty `transfer_places`
-- table — mirrors 0023/0024's own "no-op on a fresh/empty table" backfills.
UPDATE `transfer_places` SET `place_type` = 'airport' WHERE `is_airport` = true;
--> statement-breakpoint
-- Owner-named overrides, by the normalized `name_key` (never a literal id —
-- same discipline `upsertTransferPlace()` uses). No-op if the named row
-- does not exist on this database.
UPDATE `transfer_places` SET `place_type` = 'pier' WHERE `name_key` = 'hagnaya port';
--> statement-breakpoint
UPDATE `transfer_places` SET `place_type` = 'city' WHERE `name_key` = 'cebu city';
```

Add a header comment to the top of the file matching the `0023` file's own style, explaining this is stage 1 of 2 and naming `0028` as stage 2.

- [ ] **Step 4: Generate and hand-finish migration `0028` (subtractive)**

Nothing in `schema.ts` needs to change again — `is_airport` was already removed from the Drizzle schema in Step 2, so `drizzle-kit generate` now detects it as a column to drop (the TS schema no longer declares it, but the database still has it from before this task started). Run:

```bash
pnpm --filter @rg/server db:generate
```

Confirm the generated file (numbered `0028`) contains exactly:

```sql
ALTER TABLE `transfer_places` DROP COLUMN `is_airport`;
```

Add a one-line header comment: "Stage 2 of 2 — see migration 0027's header. Drops `is_airport` now that every reader has moved to `place_type`."

- [ ] **Step 5: Apply to local `rg_travel` and verify**

```bash
pnpm --filter @rg/server db:migrate
```

Confirm it exits 0. `rg_travel_test` is **not** migrated by this command — `server/scripts/db-preflight.mjs` refuses any database name but `rg_travel`. The test database is migrated automatically by Vitest's `global-setup.ts`, which runs Drizzle's programmatic `migrate()` against `TEST_DATABASE_URL` at the start of the next `pnpm test` run. Confirm this works by running the server test suite once now:

```bash
pnpm --filter @rg/server test -- --run schema-smoke 2>&1 | tail -30
```

(or any single fast existing server test file — the goal is only to confirm `global-setup.ts` applies `0027`/`0028` to `rg_travel_test` with no error; a full-suite run happens later at the Global Constraints verification step, after Tasks 3–7 have updated every `isAirport` reader — running the full suite now will fail on every file still referencing `isAirport`/`is_airport`, which is expected and not a migration bug).

- [ ] **Step 6: Commit**

```bash
git add shared/src/transfers.ts server/src/db/schema.ts server/src/db/migrations/0027_*.sql server/src/db/migrations/0028_*.sql server/src/db/migrations/meta/
git commit -m "feat(schema): place types, home-page route fields, ferry fields (migration 0027/0028)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**STOP. Request the dedicated Opus review for this task before starting Task 2.** The review should check: the backfill order (airport-by-flag first, then the two name-based overrides, so a row matching both rules ends up correctly overridden by name), that `0028` drops only `is_airport` and nothing else, and that no application code was touched (this task is schema-only).

---

## Task 2: Owner item 1B — Admin session expired → redirect to login

**[DEDICATED OPUS REVIEW before continuing to Task 3.]**

Client-only. No change to session lifetime, cookie flags, or server auth logic.

**Files:**

- Create: `client/src/lib/admin-redirect.ts`
- Modify: `client/src/components/layout/AdminLayout.tsx`
- Modify: `client/src/pages/admin/AdminLoginPage.tsx`
- Test: `client/src/__tests__/admin-layout.test.tsx` (extend)
- Test: `client/src/__tests__/admin-login-redirect.test.tsx` (new)

**Interfaces:**

- Produces: `sanitizeAdminRedirect(raw: string | null): string | null` — exported from `client/src/lib/admin-redirect.ts`. Task 2 is the only consumer; no other task depends on it.

- [ ] **Step 1: Write the failing tests first**

Create `client/src/__tests__/admin-redirect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeAdminRedirect } from '@/lib/admin-redirect';

describe('sanitizeAdminRedirect', () => {
  it('accepts a same-origin admin path', () => {
    expect(sanitizeAdminRedirect('/admin/bookings/42')).toBe('/admin/bookings/42');
  });

  it('accepts an admin path with a query string', () => {
    expect(sanitizeAdminRedirect('/admin/bookings?status=pending')).toBe(
      '/admin/bookings?status=pending',
    );
  });

  it('refuses a protocol-relative URL (open-redirect attempt)', () => {
    expect(sanitizeAdminRedirect('//evil.example.com/admin')).toBeNull();
  });

  it('refuses an absolute external URL', () => {
    expect(sanitizeAdminRedirect('https://evil.example.com/admin')).toBeNull();
  });

  it('refuses a path outside /admin', () => {
    expect(sanitizeAdminRedirect('/checkout')).toBeNull();
  });

  it('refuses null and empty input', () => {
    expect(sanitizeAdminRedirect(null)).toBeNull();
    expect(sanitizeAdminRedirect('')).toBeNull();
  });
});
```

Add to `client/src/__tests__/admin-layout.test.tsx` (beside the existing "keeps the sign-out button reachable when staffAuth.me errors" test, which mocks `INTERNAL_SERVER_ERROR` and must keep passing unchanged):

```ts
it('redirects to /admin/login with the intended path when staffAuth.me is UNAUTHORIZED', async () => {
  mockTrpcError('staffAuth.me', 'UNAUTHORIZED', 'Admin sign-in required.');
  renderAdminLayoutAt('/admin/bookings/42'); // use this file's existing render helper
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: /staff sign-in/i })).toBeInTheDocument();
  });
  // AdminLoginPage is rendered standalone (outside AdminLayout) in this test's
  // router — assert the URL carries the encoded redirect, via whatever this
  // test file's harness exposes (history object / MemoryRouter's location).
});

it('does not redirect when staffAuth.me fails with a non-auth error', async () => {
  mockTrpcError('staffAuth.me', 'INTERNAL_SERVER_ERROR', 'boom');
  renderAdminLayoutAt('/admin/bookings');
  expect(await screen.findByText(/could not confirm your session/i)).toBeInTheDocument();
});
```

(Adjust to this test file's actual existing helper names — read the file first; it already has a render helper and `mockTrpcError` import per the earlier research. The second test pins the existing "no redirect on a 500" behavior so this task provably does not regress it.)

Create `client/src/__tests__/admin-login-redirect.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc } from './helpers/mock-trpc';

// (Follow this repo's existing render-with-providers convention from
// admin-session-switch.test.tsx — MemoryRouter + TrpcProviders wrapping a
// single <Routes> with /admin/login and /admin/change-password defined, plus
// a stand-in /admin route so a successful navigate({to: '/admin'}) has
// somewhere to land and can be asserted on.)

it('sends the guest to the ?redirect= path after a successful login', async () => {
  mockTrpc({ 'staffAuth.login': { role: 'owner', mustChangePassword: false } });
  // render at /admin/login?redirect=%2Fadmin%2Fbookings%2F42
  // fill email/password, submit
  // assert the test's stand-in /admin/bookings/:id route rendered
});

it('falls back to /admin when the redirect value is unsafe', async () => {
  mockTrpc({ 'staffAuth.login': { role: 'owner', mustChangePassword: false } });
  // render at /admin/login?redirect=https%3A%2F%2Fevil.example.com
  // fill, submit
  // assert the stand-in /admin dashboard route rendered, NOT a navigation to evil.example.com
});

it('shows "Your session expired" when navigated here with sessionExpired router state', () => {
  // render at /admin/login with router state { sessionExpired: true }
  expect(screen.getByRole('status')).toHaveTextContent(/your session expired/i);
});
```

- [ ] **Step 2: Run the new tests, confirm they fail**

```bash
pnpm --filter @rg/client test -- admin-redirect admin-login-redirect admin-layout
```

Expected: `admin-redirect.test.ts` fails (module doesn't exist yet); the two new `admin-layout.test.tsx` cases fail (no redirect happens today — the screen stays on "Could not confirm your session"); the three `admin-login-redirect.test.tsx` cases fail.

- [ ] **Step 3: Implement `sanitizeAdminRedirect`**

`client/src/lib/admin-redirect.ts`:

```ts
/**
 * The ONLY path shape this helper accepts: a same-origin, relative path
 * starting with `/admin` — never a protocol, never `//host/...` (the
 * classic protocol-relative open-redirect), and never a path outside the
 * admin tree. CLAUDE.md: "same-origin relative paths only — no open
 * redirect."
 */
const SAFE_ADMIN_REDIRECT = /^\/admin(?:\/[^\s]*)?$/;

/** The sanitized `?redirect=` value, or `null` when it is missing or unsafe. */
export function sanitizeAdminRedirect(raw: string | null): string | null {
  if (!raw) return null;
  if (!SAFE_ADMIN_REDIRECT.test(raw)) return null;
  return raw;
}
```

- [ ] **Step 4: Wire the redirect into `AdminLayout.tsx`**

Add an `isUnauthorized` check and an early `<Navigate>`, placed right before the existing `mustChange` guard (around line 184):

```tsx
import { TRPCClientError } from '@trpc/client';
// ...
function isUnauthorized(error: unknown): boolean {
  return error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED';
}
```

Inside `AdminLayout()`, right after `const me = trpc.staffAuth.me.useQuery(...)`:

```tsx
if (me.isError && isUnauthorized(me.error)) {
  const redirect = `${location.pathname}${location.search}`;
  return (
    <Navigate
      to={`/admin/login?redirect=${encodeURIComponent(redirect)}`}
      state={{ sessionExpired: true }}
      replace
    />
  );
}
```

This must come before the `mustChange` guard (an unauthenticated visitor has no `mustChangePassword` to read either way, but ordering it first keeps the two guards independent and easy to reason about). A `FORBIDDEN` (403 — wrong role, valid session) error must **not** match `isUnauthorized` and must **not** redirect — those screens already show their own "owner only"/role-denied state.

- [ ] **Step 5: Wire `?redirect=` and the expired-session message into `AdminLoginPage.tsx`**

Add imports:

```tsx
import { useSearchParams } from 'react-router-dom';
import { sanitizeAdminRedirect } from '@/lib/admin-redirect';
```

Inside the component, beside the existing `passwordReset` read:

```tsx
const [searchParams] = useSearchParams();
const safeRedirect = sanitizeAdminRedirect(searchParams.get('redirect'));
const sessionExpired =
  (location.state as { sessionExpired?: boolean } | null)?.sessionExpired === true;
```

Change the login mutation's `onSuccess`:

```tsx
onSuccess: (result) => {
  queryClient.clear();
  navigate(result.mustChangePassword ? '/admin/change-password' : (safeRedirect ?? '/admin'), {
    replace: true,
  });
},
```

Add a banner, directly above the existing `passwordReset` banner block, using the identical `role="status"` blue style:

```tsx
{
  sessionExpired && !login.isError ? (
    <p
      role="status"
      className="bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200 rounded-xl border p-3 text-sm font-medium"
    >
      Your session expired — please sign in again.
    </p>
  ) : null;
}
```

- [ ] **Step 6: Run the tests, confirm they pass**

```bash
pnpm --filter @rg/client test -- admin-redirect admin-login-redirect admin-layout
```

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/admin-redirect.ts client/src/components/layout/AdminLayout.tsx client/src/pages/admin/AdminLoginPage.tsx client/src/__tests__/admin-redirect.test.ts client/src/__tests__/admin-login-redirect.test.tsx client/src/__tests__/admin-layout.test.tsx
git commit -m "fix(admin): redirect an expired/missing staff session to /admin/login (1B)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**STOP. Request the dedicated Opus review for this task before starting Task 3.** The review should check: the redirect only fires on 401/`UNAUTHORIZED`, never on 403/`FORBIDDEN`; the open-redirect refusal test actually exercises `sanitizeAdminRedirect` being called from the real login flow (not just the unit test in isolation); and that no session cookie, TTL, or server auth code was touched.

---

## Task 3: Owner item 1C (server half) — `isAirport` → `placeType` everywhere it's read/written

Combined review (with Tasks 4–8) happens after Task 8. This task makes the schema change from Task 1 actually load-bearing: every place that reads or writes `isAirport` moves to `placeType`.

**Files — production code (every file a repo-wide grep for `isAirport` found, server side):**

- Modify: `shared/src/transfers-admin.ts` (`TransferPlaceAdminRow.isAirport` → `placeType`; `transferPlaceFieldsSchema.isAirport` → `placeType`)
- Modify: `server/src/db/seed-data.ts` (`SeedTransferPlace.isAirport` → `placeType`; `SEED_TRANSFER_PLACES` entries)
- Modify: `server/src/db/seed.ts` and/or `server/src/db/seed-demo.ts` (whichever function actually consumes `SEED_TRANSFER_PLACES` — grep `SEED_TRANSFER_PLACES` to find it; update its `isAirport` read)
- Modify: `server/src/services/transfers/create-booking.ts` (`RouteShape`, `loadRouteShape`, the pickup-airport check, plus the new pier/ferry check — see Task 6 for the ferry half, done together since they touch the same function)
- Modify: `server/src/routers/public/transfers.ts` (the `transferRoutes.list` select/map)
- Modify: `server/src/routers/admin/transfer-places.ts` (wherever it maps `TransferPlaceAdminRow`/`TransferPlaceAdminListRow`)
- Modify: `server/src/routers/admin/transfer-routes.ts` (wherever it maps `TransferPlaceAdminRow` for `fromPlace`/`toPlace`)
- Test: `server/src/__tests__/transfer-create-booking.test.ts`, `admin-reports.test.ts`, `seed-demo-transfer-bookings.test.ts`, `admin-transfer-routes.test.ts`, `driver-transfer-trip.test.ts`, `admin-transfer-places.test.ts` (every server test file the grep found — update fixtures from `isAirport: true/false` to `placeType: 'airport'/'destination'`)

**Interfaces:**

- Consumes: `TRANSFER_PLACE_TYPES`/`TransferPlaceType` from Task 1.
- Produces: `TransferPlaceAdminRow { id: number; name: string; placeType: TransferPlaceType; isActive: boolean }`, `TransferPlaceAdminListRow` (same, plus `sortOrder`, `destinationId`), `transferPlaceFieldsSchema` with `placeType: z.enum(TRANSFER_PLACE_TYPES)` replacing `isAirport: z.boolean()`. Task 4 (admin UI) and Task 6 (public UI) both consume these exact shapes.

- [ ] **Step 1: `shared/src/transfers-admin.ts`**

Add the import: `import { TRANSFER_PLACE_TYPES } from './transfers';` (the file already imports from `./transfers` for `TRANSFER_PRODUCT_TYPES`).

Change `TransferPlaceAdminRow` (line ~261):

```ts
export interface TransferPlaceAdminRow {
  id: number;
  name: string;
  placeType: TransferPlaceType;
  isActive: boolean;
}
```

(add `import type { TransferPlaceType } from './transfers';` alongside the value import, or combine into one import statement).

Change `transferPlaceFieldsSchema` (line ~377):

```ts
const transferPlaceFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    placeType: z.enum(TRANSFER_PLACE_TYPES),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    destinationId: z.number().int().positive().nullable(),
  })
  .strict();
```

- [ ] **Step 2: `server/src/db/seed-data.ts`**

Change `SeedTransferPlace` (line ~899) and `SEED_TRANSFER_PLACES` (line ~908):

```ts
export interface SeedTransferPlace {
  name: string;
  placeType: TransferPlaceType;
  sortOrder: number;
}

export const SEED_TRANSFER_PLACES: SeedTransferPlace[] = [
  { name: SEED_TRANSFER_AIRPORT_NAME, placeType: 'airport', sortOrder: 0 },
  { name: 'Cebu City', placeType: 'city', sortOrder: 1 },
  { name: 'Moalboal', placeType: 'destination', sortOrder: 2 },
  { name: 'Oslob', placeType: 'destination', sortOrder: 3 },
  { name: 'Hagnaya Port', placeType: 'pier', sortOrder: 4 },
];
```

(Add `import type { TransferPlaceType } from '@rg/shared';` at the top if not already imported. Note this demo seed now matches the owner's own example mapping — Cebu City is `city`, Hagnaya Port is `pier` — one-for-one with the migration's backfill in Task 1.)

- [ ] **Step 3: Find and fix the `SEED_TRANSFER_PLACES` consumer**

```bash
grep -rn "SEED_TRANSFER_PLACES" server/src/db/
```

Update whichever `upsertTransferPlace`-calling writer this finds (likely in `seed-demo.ts`) to pass `placeType: place.placeType` instead of `isAirport: place.isAirport`.

- [ ] **Step 4: `server/src/services/transfers/create-booking.ts` — `RouteShape` and the airport check**

Change `RouteShape` (line ~417):

```ts
interface RouteShape {
  reverseEnabled: boolean;
  fromPlaceType: TransferPlaceType;
  toPlaceType: TransferPlaceType;
}
```

Change `loadRouteShape` (line ~422):

```ts
async function loadRouteShape(tx: Transaction, routeId: number): Promise<RouteShape | null> {
  const [row] = await tx
    .select({
      reverseEnabled: transferRoutes.reverseEnabled,
      fromPlaceType: fromPlace.placeType,
      toPlaceType: toPlace.placeType,
    })
    .from(transferRoutes)
    .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
    .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
    .where(eq(transferRoutes.id, routeId))
    .limit(1);
  return row ?? null;
}
```

Change the pickup check (line ~724), replacing `routeShape.fromIsAirport`/`.toIsAirport` with the new field names and comparing to `'airport'`:

```ts
const pickupPlaceType =
  input.direction === 'forward' ? routeShape.fromPlaceType : routeShape.toPlaceType;
if (
  input.productType === 'transfer_one_way' &&
  pickupPlaceType === 'airport' &&
  (blank(input.flightNumber) || blank(input.airline))
) {
  throw new TransferBookingShapeError(
    'flight_details_required_for_airport_route',
    `route ${input.routeId} direction ${input.direction} has an airport pickup; flight number and airline are both required`,
  );
}
```

(The matching ferry/pier check is added in Task 6, immediately after this block, since both read `pickupPlaceType` — doing them in the same task avoids computing it twice or threading it through an extra parameter.)

- [ ] **Step 5: `server/src/routers/public/transfers.ts`**

Change the two `select` fields (`fromPlaceIsAirport`/`toPlaceIsAirport`, line ~73/76) to:

```ts
fromPlaceType: fromPlace.placeType,
toPlaceType: toPlace.placeType,
```

Change the returned shape (line ~155/160):

```ts
fromPlace: { id: row.fromPlaceId, name: row.fromPlaceName, placeType: row.fromPlaceType },
toPlace: { id: row.toPlaceId, name: row.toPlaceName, placeType: row.toPlaceType },
```

- [ ] **Step 6: `server/src/routers/admin/transfer-places.ts` and `transfer-routes.ts`**

Grep each file for `isAirport` and change every `select`/mapping site from `transferPlaces.isAirport` to `transferPlaces.placeType`, and every returned object's `isAirport: ...` key to `placeType: ...`. (These two files were not read in full during research — read each file's `isAirport` occurrences directly before editing; the shape mirrors Step 5 above exactly, since both routers build the same `TransferPlaceAdminRow`/`TransferRoutePublicRow`-shaped places.)

- [ ] **Step 7: Update every test fixture the grep found**

```bash
grep -rln "isAirport" server/src/__tests__/
```

For each file in the result (`transfer-create-booking.test.ts`, `admin-reports.test.ts`, `seed-demo-transfer-bookings.test.ts`, `admin-transfer-routes.test.ts`, `driver-transfer-trip.test.ts`, `admin-transfer-places.test.ts`, and any other this grep surfaces), replace `isAirport: true` → `placeType: 'airport'` and `isAirport: false` → `placeType: 'destination'` (unless the specific fixture is testing a pier/city place specifically for a reason visible in that test's own name/comments — read each site, don't blind-replace a fixture that's deliberately testing a non-default case).

- [ ] **Step 8: Run the server test suite, fix remaining breakage**

```bash
pnpm --filter @rg/server test
```

Iterate until green. Expect `tsc`/vitest to surface any remaining `isAirport` reference as a type error or failing assertion — that is the mechanism proving this rename is complete, not a separate test to write (there is nothing new to assert here beyond "every existing test still passes under the new field name").

- [ ] **Step 9: Commit**

```bash
git add shared/src/transfers-admin.ts server/src/db/seed-data.ts server/src/db/seed-demo.ts server/src/services/transfers/create-booking.ts server/src/routers/public/transfers.ts server/src/routers/admin/transfer-places.ts server/src/routers/admin/transfer-routes.ts server/src/__tests__/
git commit -m "refactor(transfers): isAirport boolean -> placeType enum, server side (1C)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Owner item 1C (client half) — Place Type pills, icons, list columns

**Files:**

- Modify: `client/src/pages/admin/AdminTransferPlacesPage.tsx`
- Modify: `client/src/components/admin/TransferPlaceCombobox.tsx`
- Modify: `client/src/pages/admin/AdminTransferRoutesPage.tsx` (route list icons, Routes-count column prerequisite — see note in Step 5)
- Modify: `client/src/components/transfer/RoutePicker.tsx`
- Modify: `client/src/pages/public/TransferBookingPage.tsx` (icon usage flows from the same place-type data, see Task 6 — only the icon import/display lands here, the ferry-field logic is Task 6)
- Test: `client/src/__tests__/admin-transfer-places-page.test.tsx`, `route-picker.test.tsx`, `admin-transfer-routes-page.test.tsx`, `transfer-place-combobox.test.tsx` (every client test the grep found)

**Interfaces:**

- Consumes: `TransferPlaceAdminRow`/`TransferPlaceAdminListRow` with `placeType` (Task 3), `TransferPlacePublicRow` with `placeType` (Task 1).
- Produces: `PLACE_TYPE_ICON: Record<TransferPlaceType, LucideIcon>` and `PLACE_TYPE_LABEL: Record<TransferPlaceType, string>`, exported from a new small file `client/src/lib/place-types.ts` so every surface (admin places list, admin route list, public route picker, public place combobox) shares one icon/label mapping rather than four independent `switch` statements drifting apart.

- [ ] **Step 1: One shared icon/label map**

Create `client/src/lib/place-types.ts`:

```ts
import { Building2, MapPin, Plane, Ship, type LucideIcon } from 'lucide-react';
import type { TransferPlaceType } from '@rg/shared';

/**
 * One icon per place type, shared by the admin places screen, the admin
 * route list, the public route picker, and the admin place combobox — a
 * second independent mapping is how these four surfaces would silently
 * drift (owner decision 2026-11-13, Task 1C).
 *
 * `MapPin` for `'destination'` reuses the pin already used throughout this
 * codebase for "a place on a map" (RoutePicker.tsx's own leg label) rather
 * than introducing a new, unrelated beach/travel icon.
 */
export const PLACE_TYPE_ICON: Record<TransferPlaceType, LucideIcon> = {
  airport: Plane,
  pier: Ship,
  city: Building2,
  destination: MapPin,
};

export const PLACE_TYPE_LABEL: Record<TransferPlaceType, string> = {
  airport: 'Airport',
  pier: 'Pier / port',
  city: 'City / hotel area',
  destination: 'Destination',
};

export const PLACE_TYPE_OPTIONS: ReadonlyArray<{ value: TransferPlaceType; label: string }> = [
  { value: 'airport', label: PLACE_TYPE_LABEL.airport },
  { value: 'pier', label: PLACE_TYPE_LABEL.pier },
  { value: 'city', label: PLACE_TYPE_LABEL.city },
  { value: 'destination', label: PLACE_TYPE_LABEL.destination },
];
```

Run `pnpm --filter @rg/client typecheck` immediately after this file alone to confirm `Building2`, `MapPin`, `Plane`, `Ship` all resolve against the installed `lucide-react` version (`^0.545.0`) before building on top of them — `Plane`, `MapPin`, and `Ship` are already imported elsewhere in this codebase (`RoutePicker.tsx`), so only `Building2` is unverified; it is a long-standing stable lucide icon name and should resolve without issue.

- [ ] **Step 2: `AdminTransferPlacesPage.tsx` — pill selector replaces the Yes/No dropdown**

`EntityForm` has no icon-pill field type (confirmed by research — only `text`/`number`/`date`/`textarea`/`select`). Follow the same pattern `AdminTransferRoutesPage.tsx` already uses for its duration/price fields: remove `isAirport` from `scalarFields()`'s returned array entirely, and render the Place Type selector as custom JSX sitting beside `<EntityForm hideSubmit>`, with its own local state merged into the submit payload — exactly as that file's `durationHours`/`durationMinutes`/`priceOverrides` already are.

Remove the `isAirport` entry from `scalarFields()` (line ~123-132). Remove `isAirport` from `valuesFromPlace()`'s returned object and from `TRANSFER_PLACE_FIELD_NAMES`; add `'placeType'` to `TRANSFER_PLACE_FIELD_NAMES` instead.

Add local state to `TransferPlaceForm`, beside the existing `values`/`errors` state:

```tsx
const [placeType, setPlaceType] = useState<TransferPlaceType>(initial?.placeType ?? 'destination');
```

Render the pill selector between the Name field and the destination dropdown (i.e. split `scalarFields()`'s rendering so Name renders via `<EntityForm>` first, then this block, then the rest via a second `<EntityForm>` call, OR — simpler, matching the Routes page's own layout — render the whole `<EntityForm fields={scalarFields(destinations)} ... hideSubmit />` as today, and add this block immediately ABOVE it, since Place Type has no ordering dependency on the other fields and "Name, Status, then Place Type" from the spec is satisfied by Name (first `EntityForm` field) then Status (handled by the existing Deactivate/Reactivate flow on the list, not this create/edit form — the form itself only ever creates/edits an active-by-default place, matching the existing pattern where `isActive` is form-unreachable, same as `transferPlaceFieldsSchema`'s `.strict()` already enforces) then Place Type:

```tsx
<fieldset className="space-y-2">
  <legend className="text-sm font-medium">Place type</legend>
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {PLACE_TYPE_OPTIONS.map(({ value, label }) => {
      const Icon = PLACE_TYPE_ICON[value];
      const selected = placeType === value;
      return (
        <button
          key={value}
          type="button"
          onClick={() => setPlaceType(value)}
          aria-pressed={selected}
          className={cn(
            'tap-target flex flex-col items-center gap-1.5 rounded-xl border-2 p-3 text-xs font-medium transition-colors',
            selected
              ? 'border-brand-blue-600 text-brand-blue-700 bg-brand-blue-50'
              : 'border-brand-blue-100 text-brand-ink hover:bg-brand-blue-50/50 bg-white',
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
          {label}
        </button>
      );
    })}
  </div>
  <p className="text-brand-error text-xs">
    Airport = flight fields required on pickup. Pier / port = optional ferry name and arrival time.
  </p>
  {errors.placeType ? (
    <p role="alert" className="text-brand-gold-800 text-xs font-medium">
      {errors.placeType}
    </p>
  ) : null}
</fieldset>
```

(Add `import { cn } from '@/lib/utils';` and `import { PLACE_TYPE_ICON, PLACE_TYPE_OPTIONS } from '@/lib/place-types';` and `import type { TransferPlaceType } from '@rg/shared';` to this file's imports.)

Update `submit()` to send `placeType` instead of `isAirport`:

```tsx
const payload = {
  name: value('name'),
  placeType,
  destinationId: /* unchanged */,
  sortOrder: /* unchanged */,
};
```

Update `valuesFromPlace()` — it no longer needs to seed `isAirport` into the string-values record (placeType has its own `useState`), but `TransferPlaceForm`'s `key={editingId}` remount already re-initializes `placeType` correctly per place when switching between edit targets, same as the existing `durationHours` pattern in the Routes page.

- [ ] **Step 3: Admin places list — icon, Type, Routes (count), Status**

The list's data source, `admin.transferPlaces.list`, does **not** currently return a per-place route count. Add it: in `server/src/routers/admin/transfer-places.ts`'s list query, add a `routeCount` computed via a `COUNT(*)` subquery or a second grouped query against `transferRoutes` counting rows where `fromPlaceId = place.id OR toPlaceId = place.id`, and add `routeCount: number` to `TransferPlaceAdminListRow` in `shared/src/transfers-admin.ts`.

In the mobile card list (line ~488-511) and the desktop table (line ~519-562) of `AdminTransferPlacesPage.tsx`:

- Replace the `{place.isAirport ? 'Airport' : 'Not an airport'}` mobile line and the `{place.isAirport ? 'Yes' : 'No'}` desktop cell with the icon + `PLACE_TYPE_LABEL[place.placeType]`.
- Add a `Routes` column/line showing `place.routeCount`.
- Add the icon before the place name itself (mobile card's name `<p>` and the desktop table's Name `<td>`), per the spec's "The icon also shows before place names in the admin route list and the public /transfer route picker" (this line is about the ROUTE list and the public picker specifically, but showing it beside the name on the PLACES list too is the natural reading of "icon before each name" from the places-list bullet — do both).

Add the new `Routes` header cell to the desktop `<thead>` between `Linked destination` and `Status`.

- [ ] **Step 4: `TransferPlaceCombobox.tsx` — icon before each place name**

Add the icon (from `PLACE_TYPE_ICON[place.placeType]`) before each option's rendered name, matching whatever existing structure renders `place.name` today (read the file's render function first — it is a combobox listbox, so this is one small JSX addition per option row, not a restructure).

- [ ] **Step 5: Admin route list — icons before place names**

In `AdminTransferRoutesPage.tsx`, both the mobile card (`{route.fromPlace.name} → {route.toPlace.name}`, line ~796) and the desktop table cell (line ~857), add the two places' icons before their respective names:

```tsx
{
  (() => {
    const FromIcon = PLACE_TYPE_ICON[route.fromPlace.placeType];
    const ToIcon = PLACE_TYPE_ICON[route.toPlace.placeType];
    return (
      <span className="inline-flex items-center gap-1">
        <FromIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {route.fromPlace.name}
        {' → '}
        <ToIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {route.toPlace.name}
      </span>
    );
  })();
}
```

(Replace the inline IIFE with two small locals if preferred — either is fine; `TransferRouteAdminRow.fromPlace`/`.toPlace` are `TransferPlaceAdminRow`, which Task 3 already gave a `placeType` field.)

- [ ] **Step 6: Public route picker — icon before each place name, replacing the airport-only `Plane` badge**

In `RoutePicker.tsx`, `legsFor()` currently computes `touchesAirport: route.fromPlace.isAirport || route.toPlace.isAirport` (line ~84) and renders a single trailing `Plane` badge when true (line ~150-155). Per the spec ("origin type icon, From → To"), the picker should show the **pickup place's own icon** beside the "From" name, not a single "touches airport anywhere" badge. Change `RouteLeg`:

```ts
type RouteLeg = {
  direction: TransferDirection;
  fromName: string;
  toName: string;
  fromPlaceType: TransferPlaceType;
};
```

In `legsFor()`:

```ts
function legsFor(route: TransferRoutePublicRow): RouteLeg[] {
  const forward: RouteLeg = {
    direction: 'forward',
    fromName: route.fromPlace.name,
    toName: route.toPlace.name,
    fromPlaceType: route.fromPlace.placeType,
  };
  if (!route.reverseEnabled) return [forward];
  const reverse: RouteLeg = {
    direction: 'reverse',
    fromName: route.toPlace.name,
    toName: route.fromPlace.name,
    fromPlaceType: route.toPlace.placeType,
  };
  return [forward, reverse];
}
```

Replace the render (line ~143-161) so the leading icon is `PLACE_TYPE_ICON[leg.fromPlaceType]`, always shown (not conditional), immediately before `leg.fromName`:

```tsx
<span className="text-brand-blue-900 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold">
  {(() => {
    const Icon = PLACE_TYPE_ICON[leg.fromPlaceType];
    return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
  })()}
  <span className="min-w-0 break-words">
    {leg.fromName}
    {' → '}
    {leg.toName}
  </span>
  {selected && <CheckCircle2 className="text-brand-blue-700 size-4 shrink-0" aria-hidden="true" />}
</span>
```

Remove the now-unused `Plane` import if nothing else in the file needs it (check — it may still be needed if a `sr-only` "Airport pickup" announcement should be kept for screen readers; if so, keep an `sr-only` span naming the place type instead: `<span className="sr-only">{PLACE_TYPE_LABEL[leg.fromPlaceType]} pickup</span>`).

- [ ] **Step 7: Update every client test the grep found**

```bash
grep -rln "isAirport" client/src/
```

For `route-picker.test.tsx`, `hero-trust.test.tsx`, `admin-transfer-places-page.test.tsx`, `admin-transfer-routes-page.test.tsx`, `transfer-booking-page.test.tsx`, `route-picker-overflow.test.tsx`, `transfer-place-combobox.test.tsx`: replace `isAirport: true/false` fixtures with `placeType: 'airport'/'destination'` (or `'pier'`/`'city'` where the test is specifically about a non-airport, non-default place — read each site). Update any assertion that looked for the text "Airport"/"Not an airport"/"Yes"/"No" to match the new `PLACE_TYPE_LABEL` wording, and any assertion keyed on the old single `Plane`-badge-only-when-airport behavior in `route-picker.test.tsx`/`route-picker-overflow.test.tsx` to match the new always-shown-leading-icon behavior from Step 6.

- [ ] **Step 8: Run the client test suite, fix remaining breakage**

```bash
pnpm --filter @rg/client test
```

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/place-types.ts client/src/pages/admin/AdminTransferPlacesPage.tsx client/src/pages/admin/AdminTransferRoutesPage.tsx client/src/components/admin/TransferPlaceCombobox.tsx client/src/components/transfer/RoutePicker.tsx shared/src/transfers-admin.ts server/src/routers/admin/transfer-places.ts client/src/__tests__/
git commit -m "feat(admin+transfer): place-type pills, icons, routes-count column (1C)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Owner item 1E — Ferry pickup fields

Builds directly on Task 1's new columns and Task 3's `placeType` plumbing. Mirrors the flight-details pattern throughout, with two deliberate differences (confirmed during research, not assumptions): **"ferry arrival time" is a civil `HH:mm` clock field** (there is no existing "flight time" field to copy — the closest analog is `pickupTime`/`dayUseEndTime`, not `flightNumber`/`airline`), and the gate is `placeType === 'pier'` on the PICKUP place (mirroring the narrowed, direction-aware airport rule from owner decision 3, 2026-11-09 — not the older "either end" rule).

**Files:**

- Modify: `shared/src/transfers-checkout.ts` (`createHoldTransferInput` — new fields + `superRefine`)
- Modify: `shared/src/transfers-admin.ts` (`transferQuoteConvertInput` — new optional fields, mirroring `flightNumber`/`airline`)
- Modify: `server/src/services/transfers/create-booking.ts` (new `TRANSFER_BOOKING_SHAPE_PROBLEMS` member, `CreateTransferBookingInput` fields, the pier check beside the airport check from Task 3 Step 4, the INSERT)
- Modify: `server/src/routers/public/checkout.ts` (`TRANSFER_SHAPE_MESSAGES`, the call site passing fields to `createTransferBooking`)
- Modify: `server/src/routers/admin/transfer-quotes.ts` (the convert call site, mirroring `flightNumber`/`airline`)
- Modify: `server/src/routers/public/driver.ts`, `server/src/routers/public/portal.ts` (all 4 portal occurrences), `server/src/routers/admin/bookings.ts` (select/map the two new fields)
- Modify: `shared/src/driver.ts` (`TripDetail` — two new fields)
- Modify: `client/src/components/transfer/TransferGuestDetailsForm.tsx` (new conditional fields, mirroring flight fields' three-state-adjacent pattern but simpler — see Step 6)
- Modify: `client/src/pages/public/TransferBookingPage.tsx` (compute `ferryDetailsVisible`, pass through to form and to the submit payload)
- Modify: `client/src/pages/driver/DriverTripPage.tsx`, `client/src/pages/admin/AdminBookingDetailPage.tsx`, `client/src/pages/portal/PortalBookingPage.tsx`, `client/src/pages/public/BookingStatusPage.tsx`, `client/src/pages/portal/ManualQrPage.tsx` (new null-guarded display block, mirroring the existing flight block exactly)
- Test: new assertions alongside the existing flight-field tests in `transfer-create-booking.test.ts`, `transfer-booking-page.test.tsx`, plus one new display test per the five display surfaces (can be added to each surface's existing test file)

**Interfaces:**

- Consumes: `TransferPlaceType`, `placeType` (Tasks 1/3), `bookingTransferDetails.ferryVesselName`/`ferryArrivalTime` columns (Task 1).
- Produces: `CreateTransferBookingInput.ferryVesselName: string | null`, `.ferryArrivalTime: string | null`; `TripDetail.ferryVesselName: string | null`, `.ferryArrivalTime: string | null` — read by Task 5's own display steps only (no other task depends on these).

- [ ] **Step 1: Shared Zod — `createHoldTransferInput`**

In `shared/src/transfers-checkout.ts`, add two fields to the `.extend({...})` object, immediately after `airline` (line ~165):

```ts
/**
 * One-way only, refused on a day-use hire by the `superRefine` below —
 * the pier/port counterpart of `flightNumber`/`airline`. Optional at this
 * Zod layer even on a one-way trip to a pier, for the same reason
 * `flightNumber` is: whether the pickup is actually a pier is resolved
 * server-side, after the catalog read.
 */
ferryVesselName: z.string().max(120, 'Enter a shorter vessel name.').optional(),
/** Civil `HH:mm`, Asia/Manila — same pattern as `pickupTime`/`dayUseEndTime`, not a copy of `flightNumber`. */
ferryArrivalTime: clockTimeField('Enter an arrival time as HH:mm, like 14:30.').optional(),
```

In the `superRefine`'s day-use branch (line ~229), add the mirror of the flight-fields loop immediately after it:

```ts
for (const field of ['ferryVesselName', 'ferryArrivalTime'] as const) {
  if (value[field] !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: 'A day-use hire carries no ferry leg — please leave the ferry details blank.',
    });
  }
}
```

(Placed right after the existing `flightNumber`/`airline` loop, inside the same `if (value.productType === 'transfer_day_use')` block.)

- [ ] **Step 2: Shared Zod — `transferQuoteConvertInput` (staff conversion)**

In `shared/src/transfers-admin.ts`, add the same two optional fields immediately after `airline` (line ~609) in the `.object({...})`:

```ts
ferryVesselName: z.string().max(120, 'Enter a shorter vessel name.').optional(),
ferryArrivalTime: z
  .string()
  .regex(CLOCK_TIME_PATTERN, 'Enter an arrival time as HH:mm, like 14:30.')
  .optional(),
```

In the `superRefine`'s day-use branch (line ~659), add to the existing `for (const field of ['flightNumber', 'airline'] as const)` loop's field list (extend the tuple rather than duplicating the loop):

```ts
for (const field of ['flightNumber', 'airline', 'ferryVesselName', 'ferryArrivalTime'] as const) {
```

(keep the same message, or split into two loops with field-specific messages — either is acceptable; a single shared message is simpler and this file already uses one shared message for the flight pair).

- [ ] **Step 3: `create-booking.ts` — `CreateTransferBookingInput`, the day-use refusal, the INSERT**

**Both ferry fields are optional everywhere, full stop — there is no pier-required-field enforcement, unlike the airport/flight pair.** The owner's spec says explicitly "optional 'Ferry / vessel name' and 'Ferry arrival time'" for 1E, in contrast to flight details, which the spec and the existing code genuinely require on an airport pickup. Mirroring the airport pattern literally (refusing a blank vessel name on a pier pickup) would contradict that explicit word, so this plan does not add it. The only new refusal is the day-use mirror, because a day-use hire has no leg at all for either flight or ferry details to describe.

Append to `TRANSFER_BOOKING_SHAPE_PROBLEMS` (line ~317), after the existing `'flight_details_required_for_airport_route'`:

```ts
export const TRANSFER_BOOKING_SHAPE_PROBLEMS = [
  // ...all existing members, unchanged...
  'flight_details_required_for_airport_route',
  'ferry_details_on_day_use',
] as const;
```

Add to `CreateTransferBookingInput` (line ~191), immediately after `airline`:

```ts
ferryVesselName: string | null;
ferryArrivalTime: string | null;
```

Add the day-use refusal to `assertBookableShape`, immediately after the existing flight-on-day-use check (line ~587):

```ts
if (input.ferryVesselName !== null || input.ferryArrivalTime !== null) {
  refuse('ferry_details_on_day_use', 'a day-use hire carries no ferry leg');
}
```

Do **not** add anything to the `if (routeShape !== null) { ... }` block from Task 3 Step 4 — `pickupPlaceType === 'pier'` is read only by the CLIENT (Step 7 below), to decide whether to show the fields at all; the server never gates on it, since there is nothing to require.

Add to the INSERT (line ~899-919), immediately after `airline`:

```ts
ferryVesselName: input.ferryVesselName,
ferryArrivalTime: input.ferryArrivalTime,
```

- [ ] **Step 4: `checkout.ts` — messages dictionary and call site**

Add to `TRANSFER_SHAPE_MESSAGES` (line ~596-635), one new key (TypeScript's `Record<TransferBookingShapeProblem, string>` typing will refuse to compile until it is present):

```ts
ferry_details_on_day_use:
  'A day-use hire carries no ferry leg — please leave the ferry details blank.',
```

Add to the `createTransferBooking({...})` call site (line ~1193-1216), immediately after `airline`:

```ts
ferryVesselName: input.ferryVesselName ?? null,
ferryArrivalTime: input.ferryArrivalTime ?? null,
```

- [ ] **Step 5: `transfer-quotes.ts` — staff conversion call site**

In `server/src/routers/admin/transfer-quotes.ts`, add to the existing object (line ~269-270), immediately after `airline`:

```ts
ferryVesselName: input.ferryVesselName ?? null,
ferryArrivalTime: input.ferryArrivalTime ?? null,
```

- [ ] **Step 6: `TransferGuestDetailsForm.tsx` — the new fields**

Add a new prop, mirroring `flightDetailsRequirement` but simpler (the spec says these fields are always optional, never required-with-a-banner, so a boolean is enough — no three-state type needed):

```ts
/** Whether the selected route's resolved PICKUP place is a pier/port. */
ferryDetailsVisible: boolean;
```

Add the two error id constants beside the existing flight ones:

```ts
const FERRY_VESSEL_NAME_ERROR_ID = 'transfer-ferry-vessel-name-error';
const FERRY_ARRIVAL_TIME_ERROR_ID = 'transfer-ferry-arrival-time-error';
```

Read the two field errors beside the existing ones:

```ts
const ferryVesselNameError = fieldErrors?.ferryVesselName;
const ferryArrivalTimeError = fieldErrors?.ferryArrivalTime;
```

Render a new block, structurally identical to the flight block (line ~292-338) but gated on `isOneWay && ferryDetailsVisible`, with both fields always optional:

```tsx
{
  isOneWay && ferryDetailsVisible && (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        This trip touches a pier — if you know it, share the ferry details (optional).
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="transfer-ferry-vessel-name">Ferry / vessel name (optional)</Label>
          <Input
            id="transfer-ferry-vessel-name"
            name="ferryVesselName"
            maxLength={120}
            aria-describedby={ferryVesselNameError ? FERRY_VESSEL_NAME_ERROR_ID : undefined}
            aria-invalid={ferryVesselNameError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={FERRY_VESSEL_NAME_ERROR_ID} message={ferryVesselNameError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transfer-ferry-arrival-time">Ferry arrival time (optional)</Label>
          <Input
            id="transfer-ferry-arrival-time"
            name="ferryArrivalTime"
            type="time"
            aria-describedby={ferryArrivalTimeError ? FERRY_ARRIVAL_TIME_ERROR_ID : undefined}
            aria-invalid={ferryArrivalTimeError ? true : undefined}
            className="tap-target"
          />
          <FieldError id={FERRY_ARRIVAL_TIME_ERROR_ID} message={ferryArrivalTimeError} />
        </div>
      </div>
    </div>
  );
}
```

(This matches Step 3's design: both fields are optional everywhere, so the copy says "if you know it" rather than warning of a requirement — there is no case where the server refuses a submission for a blank vessel name.)

- [ ] **Step 7: `TransferBookingPage.tsx` — compute `ferryDetailsVisible`, submit the fields**

Beside the existing `flightDetailsRequirement` computation (line ~267-276), add:

```ts
const ferryDetailsVisible =
  selectedRoute !== null &&
  (direction === 'forward'
    ? selectedRoute.fromPlace.placeType
    : selectedRoute.toPlace.placeType) === 'pier';
```

Add `'ferryVesselName'`/`'ferryArrivalTime'` to `PLACED_HOLD_FIELDS` (line ~156-177).

Pass the prop to `<TransferGuestDetailsForm ferryDetailsVisible={ferryDetailsVisible} ... />` (line ~602-609).

Add to the mutation payload (line ~463-490), immediately after `airline`:

```ts
ferryVesselName: optionalField(data, 'ferryVesselName'),
ferryArrivalTime: optionalField(data, 'ferryArrivalTime'),
```

- [ ] **Step 8: Read side — driver, portal, admin bookings routers**

`server/src/routers/public/driver.ts`: add `ferryVesselName: bookingTransferDetails.ferryVesselName` and `ferryArrivalTime: bookingTransferDetails.ferryArrivalTime` to the select (beside `flightNumber`/`airline`, line ~314-328) and to the final mapped output (line ~466-470).

`server/src/routers/public/portal.ts`: add the same two fields to **all four** occurrences (line ~178-182, 243-247, 318-321, 461-463).

`server/src/routers/admin/bookings.ts`: add the same two fields beside `flightNumber`/`airline` (line ~559-560).

`shared/src/driver.ts`: add to `TripDetail` (line ~355-365), immediately after `airline`:

```ts
/** Pier/port pickups only. NULL otherwise. */
ferryVesselName: string | null;
ferryArrivalTime: string | null;
```

(Whatever admin-bookings-detail shared type mirrors `TripDetail` for the admin surface — grep `flightNumber` in `shared/src/` to find it if it's a separate interface from `TripDetail` — gets the same two fields.)

- [ ] **Step 9: Display — five client surfaces, mirroring the existing flight block exactly**

`DriverTripPage.tsx` (after the existing flight block, line ~224):

```tsx
{
  trip.ferryVesselName === null && trip.ferryArrivalTime === null ? null : (
    <p className="text-brand-blue-900 text-base">
      Ferry {trip.ferryVesselName ?? '(vessel not given)'}
      {trip.ferryArrivalTime === null ? null : ` — arriving ${trip.ferryArrivalTime}`}
    </p>
  );
}
```

`AdminBookingDetailPage.tsx` (after the existing flight block, line ~244):

```tsx
{
  booking.ferryVesselName === null && booking.ferryArrivalTime === null ? null : (
    <div className="flex gap-2">
      <dt className="text-brand-error w-28 shrink-0">Ferry</dt>
      <dd className="text-brand-ink font-medium">
        {booking.ferryVesselName ?? '(vessel not given)'}
        {booking.ferryArrivalTime === null ? null : ` — arriving ${booking.ferryArrivalTime}`}
      </dd>
    </div>
  );
}
```

`PortalBookingPage.tsx` (after the existing flight block, line ~200):

```tsx
{
  booking.ferryVesselName === null && booking.ferryArrivalTime === null ? null : (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">Ferry</dt>
      <dd className="text-brand-blue-900 font-semibold">
        {booking.ferryVesselName ?? '(vessel not given)'}
        {booking.ferryArrivalTime === null ? null : ` — arriving ${booking.ferryArrivalTime}`}
      </dd>
    </div>
  );
}
```

`BookingStatusPage.tsx` (after the existing flight block, line ~317):

```tsx
{
  data.ferryVesselName !== null && (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">Ferry</dt>
      <dd className="text-brand-blue-900 font-medium">
        {data.ferryVesselName}
        {data.ferryArrivalTime !== null ? ` — arriving ${data.ferryArrivalTime}` : ''}
      </dd>
    </div>
  );
}
```

`ManualQrPage.tsx` (after the existing flight block, line ~209): identical shape to `BookingStatusPage.tsx` above, reading `booking.ferryVesselName`/`booking.ferryArrivalTime`.

- [ ] **Step 10: Tests**

Extend `transfer-create-booking.test.ts` with: "refuses ferry details on a day-use hire" (mirroring the existing flight-on-day-use test) and "stores ferry vessel name and arrival time on a pier pickup" (a happy-path insert assertion). Extend `transfer-booking-page.test.tsx` with: "shows the ferry fields when the pickup place is a pier" and "hides the ferry fields when the pickup place is not a pier" (mirroring the existing flight-field visibility tests, substituting `placeType: 'pier'` for the route fixture's `fromPlace`/`toPlace`). Add one assertion to each of the five display surfaces' existing test files: render with `ferryVesselName`/`ferryArrivalTime` set, assert the new "Ferry ..." text appears; render with both `null`, assert it does not.

Run and confirm each new test is provably able to fail (temporarily comment out the new display block / remove the new Zod fields, confirm red, restore).

- [ ] **Step 11: Run the full suite for this task, commit**

```bash
pnpm --filter @rg/server test
pnpm --filter @rg/client test
```

```bash
git add shared/src/transfers-checkout.ts shared/src/transfers-admin.ts shared/src/driver.ts server/src/services/transfers/create-booking.ts server/src/routers/public/checkout.ts server/src/routers/admin/transfer-quotes.ts server/src/routers/public/driver.ts server/src/routers/public/portal.ts server/src/routers/admin/bookings.ts client/src/components/transfer/TransferGuestDetailsForm.tsx client/src/pages/public/TransferBookingPage.tsx client/src/pages/driver/DriverTripPage.tsx client/src/pages/admin/AdminBookingDetailPage.tsx client/src/pages/portal/PortalBookingPage.tsx client/src/pages/public/BookingStatusPage.tsx client/src/pages/portal/ManualQrPage.tsx
git commit -m "feat(transfers): optional ferry vessel name + arrival time for pier pickups (1E)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Owner item 1D — "Show on home page" admin fields + preview

**Files:**

- Modify: `shared/src/transfers-admin.ts` (`transferRouteFieldsSchema`, `TransferRouteAdminRow`)
- Modify: `server/src/routers/admin/transfer-routes.ts` (select/map the four new columns)
- Modify: `client/src/pages/admin/AdminTransferRoutesPage.tsx` (new dashed-border section + live preview)
- Test: `admin-transfer-routes.test.ts`, `admin-transfer-routes-page.test.tsx`

**Interfaces:**

- Consumes: Task 1's four `transfer_routes` columns.
- Produces: `TransferRouteAdminRow.showOnHomePage/homePageBadge/homePageOrder/homePageShortDescription` — consumed by Task 7's public router.

- [ ] **Step 1: Shared Zod**

In `shared/src/transfers-admin.ts`, add four fields to `transferRouteFieldsSchema` (line ~146-169), immediately after `exclusionsText`:

```ts
showOnHomePage: z.boolean(),
homePageBadge: z.string().trim().max(20, 'Keep the badge to 20 characters or fewer.').nullable(),
homePageOrder: z.number().int().min(0).max(9999).optional(),
homePageShortDescription: z
  .string()
  .trim()
  .max(120, 'Keep the description to 120 characters or fewer.')
  .nullable(),
```

Add the same four fields to `TransferRouteAdminRow` (line ~428-451):

```ts
showOnHomePage: boolean;
homePageBadge: string | null;
homePageOrder: number;
homePageShortDescription: string | null;
```

- [ ] **Step 2: Server router**

In `server/src/routers/admin/transfer-routes.ts`, add the four columns to the list query's `select` and to the returned row mapping (mirror whatever existing pattern handles `sortOrder`/`inclusionsText` — read the file first; this is a mechanical four-field addition to an existing select/map, not a new query shape). Confirm `admin.transferRoutes.update`'s patch-merge logic (`mergeTransferRoutePatch` or equivalent, per `transferRoutePatchSchema`'s `.partial()` contract from the file header) passes these four fields through like every other scalar field — no special "sparse card" handling applies to them (that discipline is specific to `prices`).

- [ ] **Step 3: Admin route form — the new section**

In `AdminTransferRoutesPage.tsx`, add local state to `TransferRouteForm` beside `reverseEnabled`:

```tsx
const [showOnHomePage, setShowOnHomePage] = useState<boolean>(initial?.showOnHomePage ?? false);
const [homePageBadge, setHomePageBadge] = useState<string>(initial?.homePageBadge ?? '');
const [homePageOrder, setHomePageOrder] = useState<string>(String(initial?.homePageOrder ?? 0));
const [homePageShortDescription, setHomePageShortDescription] = useState<string>(
  initial?.homePageShortDescription ?? '',
);
```

Render a new dashed-border section, after the price-card section (after line ~574, before `<FormActions>`):

```tsx
<div className="border-brand-blue-200 rounded-xl border-2 border-dashed p-4">
  <h3 className="text-brand-ink text-sm font-bold">Show on home page</h3>
  <label className="tap-target mt-2 flex items-center gap-2 text-sm" htmlFor="route-show-on-home">
    <input
      id="route-show-on-home"
      type="checkbox"
      checked={showOnHomePage}
      onChange={(event) => setShowOnHomePage(event.target.checked)}
    />
    Adds this route to "Popular transfers"
  </label>

  {showOnHomePage && (
    <div className="mt-3 space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="route-home-badge">Badge (optional)</Label>
        <Input
          id="route-home-badge"
          maxLength={20}
          placeholder="Most booked"
          className={`${FIELD} w-full`}
          value={homePageBadge}
          onChange={(event) => setHomePageBadge(event.target.value)}
        />
        {errors.homePageBadge ? <p className={ROW_ERROR}>{errors.homePageBadge}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="route-home-order">Order on home page</Label>
        <Input
          id="route-home-order"
          type="number"
          min={0}
          className={`${FIELD} w-full`}
          value={homePageOrder}
          onChange={(event) => setHomePageOrder(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="route-home-description">Short description (optional, 120 characters)</Label>
        <textarea
          id="route-home-description"
          maxLength={120}
          rows={2}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          value={homePageShortDescription}
          onChange={(event) => setHomePageShortDescription(event.target.value)}
        />
        {errors.homePageShortDescription ? (
          <p className={ROW_ERROR}>{errors.homePageShortDescription}</p>
        ) : null}
      </div>

      <div>
        <p className="text-brand-ink text-xs font-semibold uppercase tracking-wide">Preview</p>
        <p className="text-brand-error mb-2 text-xs">
          Price and photo are automatic: lowest van price on this route, and the destination's
          photo.
        </p>
        <HomeTransferCardPreview
          fromName={places.find((p) => p.id === fromPlaceId)?.name ?? 'From'}
          toName={places.find((p) => p.id === toPlaceId)?.name ?? 'To'}
          fromPlaceType={places.find((p) => p.id === fromPlaceId)?.placeType ?? 'destination'}
          durationMinutes={totalMinutesFrom(durationHours, durationMinutes) ?? 0}
          badge={homePageBadge.trim() === '' ? null : homePageBadge.trim()}
          shortDescription={
            homePageShortDescription.trim() === '' ? null : homePageShortDescription.trim()
          }
        />
      </div>
    </div>
  )}
</div>
```

Create a small presentational-only `client/src/components/admin/HomeTransferCardPreview.tsx` (no tRPC calls — pure props, since this is a live local preview of unsaved form state):

```tsx
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { friendlyDuration } from '@/lib/duration-words';
import type { TransferPlaceType } from '@rg/shared';

export default function HomeTransferCardPreview({
  fromName,
  toName,
  fromPlaceType,
  durationMinutes,
  badge,
  shortDescription,
}: {
  fromName: string;
  toName: string;
  fromPlaceType: TransferPlaceType;
  durationMinutes: number;
  badge: string | null;
  shortDescription: string | null;
}) {
  const Icon = PLACE_TYPE_ICON[fromPlaceType];
  return (
    <div className="border-brand-blue-100 relative max-w-xs overflow-hidden rounded-xl border bg-white">
      <div className="bg-brand-blue-50 text-brand-blue-400 relative flex h-24 items-center justify-center text-xs">
        Photo
        {badge ? (
          <span className="absolute left-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
            {badge}
          </span>
        ) : null}
        {durationMinutes > 0 ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            About {friendlyDuration(durationMinutes)}
          </span>
        ) : null}
      </div>
      <div className="p-3">
        <p className="text-brand-ink flex items-center gap-1 text-sm font-semibold">
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          {fromName} → {toName}
        </p>
        {shortDescription ? (
          <p className="text-brand-error mt-1 text-xs">{shortDescription}</p>
        ) : null}
        <p className="text-brand-error mt-2 text-xs">One-way from ₱X per van</p>
      </div>
    </div>
  );
}
```

Add these four fields to `submit()`'s payload (around line ~399-410), immediately after `exclusionsText`:

```ts
showOnHomePage,
homePageBadge: homePageBadge.trim() === '' ? null : homePageBadge.trim(),
homePageOrder: homePageOrder.trim() === '' ? undefined : Number(homePageOrder.trim()),
homePageShortDescription:
  homePageShortDescription.trim() === '' ? null : homePageShortDescription.trim(),
```

Add the four field names to `TRANSFER_ROUTE_FIELD_NAMES` and to `formFieldFor()`'s `SCALAR` set (both near line ~161-264).

- [ ] **Step 4: Tests**

Extend `admin-transfer-routes.test.ts`: "stores the home-page fields on create/update" and "refuses a badge longer than 20 characters" / "refuses a description longer than 120 characters". Extend `admin-transfer-routes-page.test.tsx`: "shows the home-page section fields only when the toggle is on" and "shows a live preview reflecting the typed badge and description".

- [ ] **Step 5: Run tests, commit**

```bash
pnpm --filter @rg/server test -- admin-transfer-routes
pnpm --filter @rg/client test -- admin-transfer-routes-page
```

```bash
git add shared/src/transfers-admin.ts server/src/routers/admin/transfer-routes.ts client/src/pages/admin/AdminTransferRoutesPage.tsx client/src/components/admin/HomeTransferCardPreview.tsx server/src/__tests__/admin-transfer-routes.test.ts client/src/__tests__/admin-transfer-routes-page.test.tsx
git commit -m "feat(admin): 'Show on home page' fields + live preview on transfer routes (1D admin)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Owner item 1D — Public "Popular transfers" home section

**Files:**

- Modify: `server/src/routers/public/transfers.ts` (new `featured` query, or extend `list` — see Step 1)
- Modify: `shared/src/transfers.ts` (new `TransferRouteHomeCard` type)
- Create: `client/src/components/home/PopularTransfers.tsx`
- Modify: `client/src/pages/public/HomePage.tsx` (mount the new section, add `#popular-transfers` to `REVEAL_SECTIONS`' exclusion list if it stagger-animates its own cards)
- Modify: `client/src/pages/public/TransferBookingPage.tsx` (read `direction` from the URL, per Step 4)
- Modify: `client/src/components/home/ContactSection.tsx` (read a query param to preselect "Custom trip request")
- Test: new server test for the featured-route query; new client test for the home section

**Interfaces:**

- Consumes: `TransferRouteAdminRow`'s home-page fields via the DB (Task 6), `vehicleImageFor`/destination `imagePath` (existing), `PLACE_TYPE_ICON` (Task 4).
- Produces: nothing consumed by a later task — this is the last public-facing piece of 1D.

- [ ] **Step 1: Server — `transferRoutes.featured` query**

Add a new procedure to `server/src/routers/public/transfers.ts`, beside `list`, rather than overloading `list` with a new filter param (keeps the existing `list` query's cache key and shape untouched for `/transfer`'s own picker):

```ts
/**
 * "Popular transfers" home-page cards (owner decision 2026-11-13, Task 1D).
 * Same two active-place/active-route filters as `list`, narrowed further to
 * `show_on_home_page = true`, ordered by `home_page_order`. The lowest
 * one-way VAN price is resolved here, server-side — CLAUDE.md: "DO NOT
 * trust prices... computed in the browser" — falling back to the lowest
 * OFFERED type's price when no van price exists on this route (never a
 * price of zero; `transferPriceCentavosSchema.min(1)` makes that
 * structurally impossible — the fallback is about an ABSENT van row, not a
 * zero-priced one).
 */
featured: publicProcedure.query(async (): Promise<TransferRouteHomeCard[]> => {
  const db = getDb();
  const rows = await db
    .select({
      id: transferRoutes.id,
      fromPlaceId: fromPlace.id,
      fromPlaceName: fromPlace.name,
      fromPlaceType: fromPlace.placeType,
      toPlaceId: toPlace.id,
      toPlaceName: toPlace.name,
      toPlaceDestinationId: toPlace.destinationId,
      estimatedDurationMinutes: transferRoutes.estimatedDurationMinutes,
      homePageBadge: transferRoutes.homePageBadge,
      homePageShortDescription: transferRoutes.homePageShortDescription,
    })
    .from(transferRoutes)
    .innerJoin(fromPlace, eq(fromPlace.id, transferRoutes.fromPlaceId))
    .innerJoin(toPlace, eq(toPlace.id, transferRoutes.toPlaceId))
    .where(
      and(
        eq(transferRoutes.isActive, true),
        eq(transferRoutes.showOnHomePage, true),
        eq(fromPlace.isActive, true),
        eq(toPlace.isActive, true),
      ),
    )
    .orderBy(asc(transferRoutes.homePageOrder), asc(toPlace.name));

  if (rows.length === 0) return [];

  const types = await db
    .select({ id: vehicleTypes.id, name: vehicleTypes.name, slug: vehicleTypes.slug })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.isActive, true))
    .orderBy(asc(vehicleTypes.sortOrder));

  const priceRows = await db
    .select({
      routeId: transferRouteVehiclePrices.routeId,
      vehicleTypeId: transferRouteVehiclePrices.vehicleTypeId,
      oneWayPriceCentavos: transferRouteVehiclePrices.oneWayPriceCentavos,
    })
    .from(transferRouteVehiclePrices)
    .where(
      inArray(
        transferRouteVehiclePrices.routeId,
        rows.map((row) => row.id),
      ),
    );

  const sellable = await sellableVehiclesByType(db);
  const vanType = types.find((t) => t.slug === 'van') ?? null;

  // Destination photo lookup — `destinations` is the tour-destinations
  // table; `toPlace.destinationId` is the nullable, informational-only
  // cross-link (schema.ts's own note). A card whose `toPlace` has no linked
  // destination gets `imagePath: null` and the client falls back to a
  // placeholder — never a fabricated path.
  const destinationIds = rows
    .map((row) => row.toPlaceDestinationId)
    .filter((id): id is number => id !== null);
  const destinationImages =
    destinationIds.length === 0
      ? new Map<number, string | null>()
      : new Map(
          (
            await db
              .select({ id: destinations.id, imagePath: destinations.imagePath })
              .from(destinations)
              .where(inArray(destinations.id, destinationIds))
          ).map((d) => [d.id, d.imagePath]),
        );

  return rows.map((row) => {
    const offered = types
      .map((type) => {
        const price = priceRows.find(
          (p) => p.routeId === row.id && p.vehicleTypeId === type.id,
        );
        if (!price) return null;
        if ((sellable.get(type.id) ?? 0) < 1) return null;
        return { vehicleTypeId: type.id, name: type.name, slug: type.slug, priceCentavos: price.oneWayPriceCentavos };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const vanOffer = vanType ? offered.find((o) => o.vehicleTypeId === vanType.id) : undefined;
    const cheapestOffer =
      vanOffer ?? offered.slice().sort((a, b) => a.priceCentavos - b.priceCentavos)[0] ?? null;

    return {
      id: row.id,
      fromPlace: { id: row.fromPlaceId, name: row.fromPlaceName, placeType: row.fromPlaceType },
      toPlace: { id: row.toPlaceId, name: row.toPlaceName },
      estimatedDurationMinutes: row.estimatedDurationMinutes,
      badge: row.homePageBadge,
      shortDescription: row.homePageShortDescription,
      imagePath: row.toPlaceDestinationId === null ? null : destinationImages.get(row.toPlaceDestinationId) ?? null,
      offeredVehicles: offered.map((o) => ({ name: o.name, slug: o.slug })),
      // Null only when NO vehicle type is offered at all (e.g. fleet fully
      // booked) — the card's price line then reads "Price unavailable" on
      // the client, never ₱0.
      cheapestOneWay: cheapestOffer
        ? { vehicleTypeName: cheapestOffer.name, priceCentavos: cheapestOffer.priceCentavos }
        : null,
    };
  });
}),
```

(Import `destinations` from `'../../db/schema'` alongside the existing imports; `sellableVehiclesByType` and `inArray` are already imported in this file.)

- [ ] **Step 2: Shared type**

In `shared/src/transfers.ts`, add:

```ts
export interface TransferRouteHomeCard {
  id: number;
  fromPlace: { id: number; name: string; placeType: TransferPlaceType };
  toPlace: { id: number; name: string };
  estimatedDurationMinutes: number;
  badge: string | null;
  shortDescription: string | null;
  imagePath: string | null;
  offeredVehicles: { name: string; slug: string }[];
  cheapestOneWay: { vehicleTypeName: string; priceCentavos: number } | null;
}
```

- [ ] **Step 3: `PopularTransfers.tsx`**

```tsx
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatPeso } from '@rg/shared';
import QueryBoundary from '@/components/common/QueryBoundary';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { friendlyDuration } from '@/lib/duration-words';
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { trpc } from '@/lib/trpc';
import { useCardStagger } from '@/lib/use-scroll-reveal';

/**
 * "Popular transfers" (owner decision 2026-11-13, Task 1D). Server-decided
 * membership (`show_on_home_page`), server-computed price (CLAUDE.md: the
 * server computes all money) — this component only renders what it is
 * given. Hidden entirely when no route is featured, per the spec's "hide
 * the whole section if none."
 */
export default function PopularTransfers() {
  const query = trpc.transferRoutes.featured.useQuery();
  const gridRef = useRef<HTMLUListElement>(null);
  useCardStagger(gridRef, 'li', query.data?.length ?? 0);

  if (query.data && query.data.length === 0) return null;

  return (
    <section id="popular-transfers" className="bg-background">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Popular transfers"
          title="Private van transfers across Cebu"
          subtitle="Fixed price per vehicle, door to door. Book online in a minute."
        />

        <QueryBoundary
          query={query}
          skeleton={<PopularTransfersSkeleton />}
          errorTitle="Transfers could not load"
        >
          {(routes) => (
            <ul ref={gridRef} className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {routes.map((route) => {
                const Icon = PLACE_TYPE_ICON[route.fromPlace.placeType];
                return (
                  <li
                    key={route.id}
                    className="border-brand-blue-100 overflow-hidden rounded-xl border bg-white"
                  >
                    <div className="bg-brand-blue-50 relative h-36 w-full">
                      {route.imagePath ? (
                        <img src={route.imagePath} alt="" className="size-full object-cover" />
                      ) : null}
                      {route.badge ? (
                        <span className="absolute left-3 top-3 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                          {route.badge}
                        </span>
                      ) : null}
                      <span className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
                        About {friendlyDuration(route.estimatedDurationMinutes)}
                      </span>
                    </div>
                    <div className="p-4">
                      <p className="text-brand-blue-900 flex items-center gap-1.5 text-base font-semibold">
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {route.fromPlace.name}
                        <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                        {route.toPlace.name}
                      </p>
                      {route.shortDescription ? (
                        <p className="text-muted-foreground mt-1.5 text-sm">
                          {route.shortDescription}
                        </p>
                      ) : null}
                      {route.offeredVehicles.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {route.offeredVehicles.map((v) => (
                            <span
                              key={v.slug}
                              className="bg-brand-blue-50 text-brand-blue-800 rounded-full px-2 py-0.5 text-xs font-medium"
                            >
                              {v.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3 flex items-center justify-between border-t pt-3">
                        <span className="text-sm">
                          {route.cheapestOneWay ? (
                            <>
                              <span className="text-muted-foreground">One-way from </span>
                              <span className="text-brand-blue-900 font-bold">
                                {formatPeso(route.cheapestOneWay.priceCentavos)}
                              </span>
                              <span className="text-muted-foreground"> per van</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Price unavailable</span>
                          )}
                        </span>
                      </div>
                      <Button asChild size="lg" className="tap-target mt-3 w-full">
                        <Link
                          to={`/transfer?productType=transfer_one_way&routeId=${route.id}&direction=forward`}
                        >
                          Book this transfer{' '}
                          <ArrowRight className="ml-1 size-4" aria-hidden="true" />
                        </Link>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>

        <p className="text-muted-foreground mt-8 text-center text-sm">
          Going somewhere else?{' '}
          <Link
            to="/transfer"
            className="text-brand-blue-700 underline underline-offset-4 hover:no-underline"
          >
            See all routes
          </Link>{' '}
          or{' '}
          <Link
            to="/#contact?type=transfer_custom"
            className="text-brand-blue-700 underline underline-offset-4 hover:no-underline"
          >
            request a custom trip
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

function PopularTransfersSkeleton() {
  return (
    <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="bg-brand-blue-50 h-80 animate-pulse rounded-xl" />
      ))}
    </ul>
  );
}
```

(`direction` on the deep link is always `forward` here, deliberately — a "Popular transfers" card always reads "pickup → drop-off" in the stored order, same as the admin route list; Step 4 below still adds general `direction` URL support to `TransferBookingPage.tsx` since the spec explicitly asks for "route AND direction preselected," which matters once a reversed route is ever featured directly, even though this card always links forward.)

- [ ] **Step 4: `TransferBookingPage.tsx` — read `direction` from the URL**

Add, beside the existing `readInitialProductType`/`readInitialRouteId` (line ~119-129):

```ts
function readInitialDirection(raw: string | null): TransferDirection {
  return raw === 'reverse' ? 'reverse' : 'forward';
}
```

Change the `direction` state initializer (line ~202) from the hardcoded `'forward'` to:

```ts
const [direction, setDirection] = useState<TransferDirection>(() =>
  readInitialDirection(searchParams.get('direction')),
);
```

- [ ] **Step 5: `HomePage.tsx` — mount the section**

```tsx
import PopularTransfers from '@/components/home/PopularTransfers';
// ...
<HeroSection />
<TrustBar />
{showTours && <CatalogPreview />}
<HowItWorks />
<PopularTransfers />
<WhyBookDirect />
```

Add `:not(#popular-transfers)` to `REVEAL_SECTIONS` (line ~29), since this section staggers its own `<li>`s via `useCardStagger` exactly like `#tours`/`#packages`/`#reviews` do — leaving it out of the exclusion list would double-animate it, the same bug `#reviews` was deliberately excluded to avoid.

- [ ] **Step 6: `ContactSection.tsx` — preselect "Custom trip request" from a query param**

Read a `type` query param (via `useSearchParams()`, or a hash-query hybrid if the home page's `/#contact` anchor doesn't carry query params cleanly through a client-side route — confirm by testing the actual link in a browser during Step 8's manual check) and, when it equals `transfer_custom`, initialize `requestKind` to `'transfer_custom'` instead of the current hardcoded `'contact'` default:

```ts
const [searchParams] = useSearchParams();
const [requestKind, setRequestKind] = useState<'contact' | 'transfer_custom'>(() =>
  searchParams.get('type') === 'transfer_custom' ? 'transfer_custom' : 'contact',
);
```

(If `ContactSection.tsx` is not already inside a React Router context that resolves query params against the CURRENT path correctly when linked via a hash fragment like `/#contact?type=transfer_custom`, verify in the browser: a hash-route SPA sometimes treats everything after `#` as the hash and query params need to go BEFORE the hash instead — `/?type=transfer_custom#contact`. Use whichever form actually survives client-side routing in this app; `PopularTransfers.tsx`'s link in Step 3 must be updated to match if the `#contact?type=...` form doesn't work as given.)

- [ ] **Step 7: Tests**

Server: new test file or addition to `server/src/__tests__/public-queries.test.ts` — "featured transfer routes" suite: "returns only active, show-on-home-page routes, ordered by homePageOrder", "computes the lowest VAN one-way price", "falls back to the lowest offered type when no van price row exists", "returns an empty array when nothing is featured".

Client: new `client/src/__tests__/popular-transfers.test.tsx` — "renders nothing when the featured list is empty", "renders a card per featured route with badge/duration/description/vehicle chips/price", "the Book button links to /transfer with productType, routeId and direction preselected". Extend `home.test.tsx` if it asserts the full section order, to include `#popular-transfers` between `#how-it-works` (or whatever `HowItWorks`'s id is) and `WhyBookDirect`'s section.

- [ ] **Step 8: Manual verification + run tests**

Start the dev server (`pnpm dev`) and open the home page in a browser: confirm the section renders once at least one route is featured (requires Task 6's admin form to have been used on at least one route — use a temporary local test route if staging data isn't ready yet), confirm the "Book this transfer" link lands on `/transfer` with the route/type/direction preselected, confirm "request a custom trip" actually pre-selects the radio button on the contact form.

```bash
pnpm --filter @rg/server test -- public-queries
pnpm --filter @rg/client test -- popular-transfers home transfer-booking-page
```

- [ ] **Step 9: Commit**

```bash
git add server/src/routers/public/transfers.ts shared/src/transfers.ts client/src/components/home/PopularTransfers.tsx client/src/pages/public/HomePage.tsx client/src/pages/public/TransferBookingPage.tsx client/src/components/home/ContactSection.tsx server/src/__tests__/ client/src/__tests__/
git commit -m "feat(public): 'Popular transfers' home section with server-priced cards (1D public)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Owner item 1A — Hide empty reviews section + nav link

**Files:**

- Modify: `server/src/content/settings.ts` (`SettingsPayload`, `toSettingsPayload`, `getSettingsPayload`)
- Modify: `client/src/components/home/ReviewsSection.tsx` (render nothing when `hasRealReviews` is false)
- Modify: `client/src/pages/public/HomePage.tsx` (don't mount `<ReviewsSection>` at all when hidden — mirrors the existing `showTours` pattern)
- Modify: `client/src/lib/site.ts` (`visibleNav` gains a second parameter)
- Modify: `client/src/components/layout/SiteHeader.tsx`, `SiteFooter.tsx` (pass the new flag through)
- Modify: `client/src/__tests__/helpers/fixtures.ts` (`SETTINGS_FIXTURE` gains `hasRealReviews`)
- Test: `server/src/__tests__/public-queries.test.ts` or a new settings test (server), `layout.test.tsx` + `home.test.tsx` (client)

**Interfaces:**

- Consumes: `realAggregate()` from `server/src/services/ratings.ts` (existing).
- Produces: `SettingsPayload.hasRealReviews: boolean`, `visibleNav(showTours: boolean, hasRealReviews: boolean)`.

- [ ] **Step 1: Server — compute and publish `hasRealReviews`**

In `server/src/content/settings.ts`, add the import: `import { realAggregate } from '../services/ratings';`.

Change `getSettingsPayload()` (line ~536-539):

```ts
export async function getSettingsPayload(now: Date = new Date()): Promise<SettingsPayload> {
  const [blocks, hasRealReviews] = await Promise.all([
    readSettings(),
    realAggregate().then((aggregate) => (aggregate?.count ?? 0) > 0),
  ]);
  return toSettingsPayload(blocks, now, isPaymongoConfigured(), hasRealReviews);
}
```

Add `hasRealReviews: boolean` to the `toSettingsPayload` signature (line ~498-502) and thread it straight into the return object (mirroring exactly how `paymongoConfigured` is threaded into `onlinePaymentEnabled`):

```ts
export function toSettingsPayload(
  blocks: SettingsBlocks,
  now: Date,
  paymongoConfigured: boolean,
  hasRealReviews: boolean,
): SettingsPayload {
  // ...unchanged...
  return {
    // ...unchanged fields...
    hasRealReviews,
  };
}
```

Add the field to `SettingsPayload` (near `onlinePaymentEnabled`, line ~436), with a doc comment mirroring that field's own style:

```ts
/**
 * Whether at least one real review (published, `is_sample = 0`) exists
 * (owner decision 2026-11-13, Task 1A) — reuses `realAggregate()`, the
 * SAME function the JSON-LD `aggregateRating` key is gated on, so the two
 * can never disagree about what "a real review" means. Drives whether the
 * public "What guests say" section and the "Reviews" nav link exist at
 * all, not merely whether they show an empty state.
 */
hasRealReviews: boolean;
```

- [ ] **Step 2: Client — `visibleNav`**

In `client/src/lib/site.ts`, change `visibleNav` (line ~115-118):

```ts
export function visibleNav(showTours: boolean, hasRealReviews: boolean) {
  const hiddenWhileToursOff = new Set(['/tours', '/#packages']);
  return SITE.nav.filter((item) => {
    if (item.href === '/#reviews') return hasRealReviews;
    return !hiddenWhileToursOff.has(item.href) || showTours;
  });
}
```

In `SiteHeader.tsx` (line ~45-46) and `SiteFooter.tsx` (line ~104-105), change the call site:

```ts
const nav = visibleNav(settings?.showTours ?? false, settings?.hasRealReviews ?? false);
```

(Defaulting to `false` before `settings.get` resolves — same "hidden until proven otherwise" default the `showTours` gate already uses, and the right default for "no fake social proof": never show a reviews link before the server has confirmed one exists.)

- [ ] **Step 3: Client — `ReviewsSection.tsx` and `HomePage.tsx`**

Mirror the existing `showTours`-gated sections exactly: in `HomePage.tsx`, read `settings?.hasRealReviews ?? false` and wrap the mount:

```tsx
{
  settings?.hasRealReviews && <ReviewsSection />;
}
```

This makes `ReviewsSection.tsx` itself simpler, not more complex — it no longer needs to handle a "zero reviews" render path at all for the SITE-WIDE case, since it is never mounted when `hasRealReviews` is false. Its existing `EmptyState` fallback (`isEmpty={(data) => data.items.length === 0}`) stays exactly as is for a narrower, legitimate edge case: `hasRealReviews` is true (at least one real review exists SITE-WIDE) but a tour-scoped call to this same component (if one exists elsewhere, e.g. a tour detail page's own reviews block uses a _different_ component, `ReviewsBlock.tsx`, per the research — confirm `ReviewsSection.tsx` really is home-page-only before deciding whether to touch its empty-state fallback at all; if it is home-page-only, the `EmptyState` branch becomes dead code once this section is conditionally mounted, and may be deleted — but only if a direct repo-wide usage check confirms `ReviewsSection` has no caller besides `HomePage.tsx`).

```bash
grep -rln "ReviewsSection" client/src/
```

If `HomePage.tsx` is the only caller, delete the now-unreachable `EmptyState`/`isEmpty` branch from `ReviewsSection.tsx` for clarity (CLAUDE.md: "Build additively... but" — dead code from a no-longer-reachable state is not a feature to keep). If it keep the `isEmpty` prop anyway because `QueryBoundary` requires it as non-optional, confirm from that component's own type signature before deciding to remove vs. keep it as inert.

- [ ] **Step 4: Fixtures**

In `client/src/__tests__/helpers/fixtures.ts`, add `hasRealReviews: true` to `SETTINGS_FIXTURE` (so every existing test that doesn't care about this flag keeps seeing the reviews section/link exactly as before — `true` is the least disruptive default for the existing suite, flipped to `false` only in the new tests that specifically exercise the hidden case).

- [ ] **Step 5: Tests**

Server — add to `server/src/__tests__/public-queries.test.ts` (or wherever `settings.get`/`getSettingsPayload` is already tested): "settings.get reports hasRealReviews: false when no published, non-sample review exists" and "... true once one is published" (seed/insert a review row, assert the flag flips — mirror whatever existing test in this file already seeds a review to test `reviews.published`'s own `realAggregate`).

Client — extend `client/src/__tests__/layout.test.tsx`'s nav-hiding `describe` block (the one that already tests `showTours` across desktop/mobile/footer) with the identical shape for `hasRealReviews`: spread `{ ...SETTINGS_FIXTURE, hasRealReviews: false }` and assert the "Reviews" link is absent from all three navs; spread `hasRealReviews: true` and assert it's present. Extend `client/src/__tests__/home.test.tsx`: "does not render the reviews section when hasRealReviews is false" and "renders it when true" (mock `'settings.get'` with each value, assert `getByRole('heading', { name: /what guests say/i })` is absent/present).

- [ ] **Step 6: Run the tests, confirm each new one is provably able to fail**

Temporarily hardcode `hasRealReviews: true` unconditionally in `toSettingsPayload`, confirm the new "false" tests go red, restore. Then:

```bash
pnpm --filter @rg/server test -- public-queries
pnpm --filter @rg/client test -- layout home
```

- [ ] **Step 7: Commit**

```bash
git add server/src/content/settings.ts client/src/components/home/ReviewsSection.tsx client/src/pages/public/HomePage.tsx client/src/lib/site.ts client/src/components/layout/SiteHeader.tsx client/src/components/layout/SiteFooter.tsx client/src/__tests__/helpers/fixtures.ts server/src/__tests__/ client/src/__tests__/
git commit -m "feat(public): hide the reviews section and nav link when no real reviews exist (1A)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Combined Sonnet review (Tasks 3–8) + fixes

Dispatch a dedicated review pass (per `superpowers:requesting-code-review`/`receiving-code-review`) covering every change from Task 3 through Task 8 — the owner's instruction is "one combined Sonnet review for the rest," i.e. everything except the migration (Task 1) and the admin-session redirect (Task 2), which already had their own dedicated Opus reviews.

Particular things to verify, flagged during planning:

- Every `isAirport` reference is gone (not just renamed in the files this plan named — run `grep -rln "isAirport" server/ client/ shared/` and confirm zero production-code hits; test-file hits are expected to be gone too after Task 3/4's cleanup).
- The ferry-vessel-name field really is optional end-to-end (Task 5 Step 3's explicit design choice, matching the spec's own word "optional") — confirm no pier-required enum member, message, or throw site was added anywhere.
- `TRANSFER_BOOKING_SHAPE_PROBLEMS`/`TRANSFER_SHAPE_MESSAGES` stay in lockstep (TypeScript's own `Record<...>` typing should already force this, but confirm `pnpm typecheck` was actually green, not merely assumed).
- The home-page "Popular transfers" price is never computed client-side — re-read `PopularTransfers.tsx` and confirm no arithmetic on `priceCentavos` beyond passing it to `formatPeso`.
- `role-isolation.test.ts`'s parsed `docs/BUILD_SPEC.md` §9 table counts are unchanged (no new `ROLE_MATRIX` area was added by this plan — confirm the test still passes with no edit to that table).
- No red anywhere in any new UI (the amber pill badge, the place-type selected border, etc.) — re-check against `client/src/__tests__/no-red.test.ts` and `contrast.test.ts`.
- `REVEAL_SECTIONS` in `HomePage.tsx` correctly excludes both `#popular-transfers` and `#reviews` (the latter is now conditionally mounted, not merely conditionally empty — confirm the selector still makes sense when `#reviews` isn't in the DOM at all).

Apply any fixes the review surfaces as their own follow-up commit(s), each still scoped to the task it corrects (don't squash a Task 6 fix into Task 7's commit).

---

## Task 10: Final verification

Run the full five checks, once, in order, exactly as CLAUDE.md specifies — do not report done on any unrun command:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
ALLOW_PLACEHOLDER_BUILD=1 pnpm build
```

If `pnpm format:check` fails, run `pnpm format` and commit the sweep **separately** from any other change.

Confirm `pnpm test` ran the standalone guards too (`check:coming-soon`, `check:contact`) per CLAUDE.md — it should, since `pnpm test` already wires them in; just don't skip reading the output to confirm they ran green.

---

## Reporting back to the owner (after Task 10 is green)

State, in the final message to the owner:

1. **The new migration numbers**: `0027` (additive) and `0028` (subtractive) — both must be applied to the server's `rg_travel` database via `pnpm --filter @rg/server db:migrate` (CLAUDE.md: remind the user after any schema change). `rg_travel_test` needs no manual step — it is migrated automatically the next time the test suite runs.

2. **Exact admin steps on staging**, in this order:
   - **(1) Set place types:** Admin → Transfers setup → Transfer places. Open each existing place's Edit form, pick its Place Type pill (the migration backfilled the obvious cases — airport-flagged places to Airport, "Hagnaya Port" to Pier / port, "Cebu City" to City / hotel area, everything else to Destination — but confirm each one and correct any that need it), Save.
   - **(2) Add "Cebu Pier 1" and its Moalboal route:** Admin → Transfer places → "Add a transfer place" → Name "Cebu Pier 1", Place Type "Pier / port", Save. Then Admin → Transfer routes → "Add a transfer route" → From "Cebu Pier 1", To "Moalboal", fill duration/free-cancellation/prices per vehicle type, Save.
   - **(3) Feature two routes on the home page:** Admin → Transfer routes → Edit the existing Airport → Moalboal route → toggle "Show on home page" on, optionally set a badge/order/description, Save. Repeat for the new Cebu Pier 1 → Moalboal route. Reload the public home page and confirm both cards appear under "Popular transfers."

3. **Unrelated bugs found along the way** (list only — do not fix): populate this list from whatever Task 3–9's implementers and reviewers actually encountered (this plan cannot predict them; the executing agent must append real findings here as they occur, e.g. in a running note, and copy them into the final report — do not invent placeholder bugs to fill this section).

4. Last line of the final report, verbatim: **"✅ HOME + LOGIN FIXES COMPLETE"**
