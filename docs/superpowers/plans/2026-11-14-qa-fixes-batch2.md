# QA Fixes Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six QA issues found in local testing of the just-merged home/login-fixes batch: a wrong "from" price on the Popular Transfers card, a blank photo box when a featured route's destination has no linked photo, tour-wording copy that's actually settings-stored (report only, no code/data change), a rating badge that shows while reviews are hidden, a wrong "session expired" message on a genuine first visit, and a verification-only check of the pier ferry fields.

**Architecture:** All fixes are narrow, surgical corrections to code merged in the previous batch — no new features, no schema changes, no data changes. 1A is a one-line server logic fix (the "van preference" shortcut never compared against cheaper non-van prices). 1B adds a CSS-only brand-gradient fallback tile (no new assets/libraries) plus one new field on an existing server query. 1C is investigation-only — the content in question turns out to already be settings-stored with transfer wording, so the fix is reporting the exact admin field, not touching code or data. 1D adds one boolean to an existing conditional. 1E adds a tiny `localStorage` marker (mirroring an existing pattern in this codebase) so the client can tell "this browser already had a valid admin session" from "this browser never signed in," without any server-side change. 1F is verification only.

**Tech Stack:** React + TypeScript + Vite + Tailwind v4 + shadcn/ui · Express + tRPC · Drizzle + MySQL 8 (read-only for this batch — no migrations, no schema changes). lucide-react icons already in use — no new packages.

**Spec:** The owner's QA brief, given directly in this conversation on 2026-11-14, plus `CLAUDE.md` at the repo root, which wins any disagreement with this plan.

## Global Constraints

- **No red anywhere.** Warnings/fallbacks use brand blue/gold/amber, never red.
- **No new dependencies.**
- **No migrations, no schema changes, no database row changes** (settings, places, routes). If a fix would require changing stored content, STOP and name the exact admin screen + field instead of touching data.
- **Do not touch payments, deposit math, `amount_paid`, auth/session logic, roles.** 1E's fix is deliberately scoped to client-side MESSAGING only (which sentence a guest sees) — it must not change the redirect logic itself (still fires only on `UNAUTHORIZED`, never `FORBIDDEN`), the safe-redirect sanitization, cookies, or TTLs.
- **Money stays server-computed.** 1A's fix is server-side; the client already renders whatever vehicle name the server returns (confirmed — no client change needed for the price itself).
- **44px tap targets, AA contrast, mobile-first at 360px.**
- **Use ui-ux-pro-max for any UI/visual change** (1A's admin-preview copy, 1B's fallback tile, 1D's conditional hide) — invoke it before writing JSX/classes for these.
- **ONE implementer at a time** — parallel implementer subagents are forbidden in this repo's environment (crashes Bun). Tasks run sequentially.
- **Tests:** run only the tests related to each task; run the full five checks (`pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm format:check` → `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`) once, at the very end. Every new/changed test must be provably able to fail.
- **No `/loop`, no scheduled wakeups, no push, no deploy, no VPS/Kong/port changes.**
- **Commits:** one commit per task, `hash - short label` format in the final report. Keep any formatting sweep in its own commit.
- **Unrelated bugs found along the way:** list at the end, don't fix.
- **When in doubt:** stop and ask before changing anything touching money, auth, roles, schema, or a feature that already works beyond what's described here.

---

## Task 1A: Popular Transfers card — genuine lowest price, not van-preferred

**Files:**

- Modify: `server/src/routers/public/transfers.ts` (the `featured` procedure's price-selection logic)
- Modify: `client/src/components/admin/HomeTransferCardPreview.tsx` (static preview copy only)
- Modify: `server/src/__tests__/public-queries.test.ts` (the `transferRoutes.featured` describe block)

**Interfaces:**

- No shape change: `TransferRouteHomeCard.cheapestOneWay` stays `{ vehicleTypeName: string; priceCentavos: number } | null` (`shared/src/transfers.ts`). The client (`PopularTransfers.tsx`) already renders `per {cheapest.vehicleTypeName.toLowerCase()}` — confirmed by direct read, **no client change needed** for the real card.

**The bug, exactly:** `server/src/routers/public/transfers.ts` (around line 276-278) currently does:

```ts
const vanOffer = vanType ? offered.find((o) => o.vehicleTypeId === vanType.id) : undefined;
const cheapestOffer =
  vanOffer ?? offered.slice().sort((a, b) => a.priceCentavos - b.priceCentavos)[0] ?? null;
```

This prefers the van's price whenever a van is offered at all, even when a cheaper type is also offered — the exact opposite of what `RoutePicker.tsx`'s own `cheapestOneWay()` helper does for the same data on the `/transfer` booking page (`Math.min(...)` across every offered type, no preference). The owner's QA caught the resulting disagreement directly.

- [ ] **Step 1: Fix the server logic**

Replace the quoted block with a genuine minimum across every offered type:

```ts
const cheapestOffer = offered.slice().sort((a, b) => a.priceCentavos - b.priceCentavos)[0] ?? null;
```

Remove the now-unused `vanOffer`/`vanType` lookup if nothing else in the function reads `vanType` (read the surrounding ~30 lines first to confirm — if `vanType` is used for anything else, leave that other use and only remove the preference logic shown above).

Update the function's doc comment (the block starting "resolved here, server-side... falling back to the lowest OFFERED type's price when no van price exists") to describe the real behavior: the genuine minimum across every priced-and-sellable offered type, full stop — no van preference, no fallback framing.

- [ ] **Step 2: Fix the admin preview's static copy**

`client/src/components/admin/HomeTransferCardPreview.tsx` line ~61 currently hardcodes:

```tsx
<p className="text-brand-error mt-2 text-xs">One-way from ₱X per van</p>
```

This is static placeholder text (the component's own doc comment already says price/photo are deliberately not previewed with real data) — but it should stop implying "van" specifically, since the real card may show any vehicle type. Invoke **ui-ux-pro-max** before touching this, then change the wording to not name a specific vehicle, e.g.:

```tsx
<p className="text-brand-error mt-2 text-xs">One-way from ₱X per vehicle</p>
```

- [ ] **Step 3: Fix the test that currently encodes the bug**

`server/src/__tests__/public-queries.test.ts`, the test named `'prefers the VAN price as the headline figure, even when a cheaper SUV price is also offered'` (around lines 883-899) currently asserts the buggy behavior is correct:

```ts
expect(card!.cheapestOneWay).toEqual({ vehicleTypeName: 'Van', priceCentavos: 250_000 });
```

Rename the test and flip the assertion to match the fix — the exact scenario the owner's bug report used (van ₱6,200, SUV ₱5,700 → card shows ₱5,700):

```ts
it('picks the genuine lowest price across every offered type, not the van specifically', async () => {
  const routeId = await makeRoute({ showOnHomePage: true, homePageBadge: 'Most booked' });
  // Van priced HIGHER than SUV — the server must pick the SUV's lower price,
  // not prefer the van just because a van is offered (owner QA, 2026-11-14).
  await makePrice(routeId, VAN_ID, 620_000);
  await makePrice(routeId, SUV_ID, 570_000);
  await makeVan(VAN_ID);
  await makeVan(SUV_ID);

  const result = await caller.transferRoutes.featured();
  const card = result.find((r) => r.id === routeId);
  expect(card).toBeDefined();
  expect(card!.badge).toBe('Most booked');
  expect(card!.cheapestOneWay).toEqual({ vehicleTypeName: 'SUV', priceCentavos: 570_000 });
});
```

Run this test BEFORE Step 1's fix (temporarily, or just reason about it): against the current (unfixed) server code, `vanOffer` is truthy (van is offered), so `cheapestOffer` becomes the van's ₱6,200 row — this new assertion (`SUV`, `570_000`) fails against that, red. After Step 1's fix, it passes, green. This is your proof the test can fail — document the actual command output for both states in your report.

Leave the adjacent `'falls back to the lowest offered type when no van price row exists'` test (lines ~901-911) alone — it already asserts the correct behavior for the no-van-row case and still passes identically after the fix (there's nothing to prefer when no van row exists, so the old and new logic agree there).

- [ ] **Step 4: Run the related tests, commit**

```bash
pnpm --filter @rg/server test -- public-queries
```

```bash
git add server/src/routers/public/transfers.ts client/src/components/admin/HomeTransferCardPreview.tsx server/src/__tests__/public-queries.test.ts
git commit -m "fix(public): Popular Transfers card shows the genuine lowest price, not van-preferred (QA 1A)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Write **✅ DONE 1A**.

---

## Task 1B: Brand-gradient fallback tile when a featured route has no photo

**Files:**

- Modify: `server/src/routers/public/transfers.ts` (`featured` procedure — add `toPlace.placeType` to the row it returns)
- Modify: `shared/src/transfers.ts` (`TransferRouteHomeCard.toPlace` — add `placeType`)
- Modify: `client/src/components/home/PopularTransfers.tsx` (the photo tile's "no imagePath" branch)
- Modify: `client/src/components/admin/HomeTransferCardPreview.tsx` (the same fallback treatment, static preview)
- Modify: `client/src/pages/admin/AdminTransferRoutesPage.tsx` (pass a `toPlaceType` prop to the preview, mirroring how it already passes `fromPlaceType`)
- Test: `client/src/__tests__/popular-transfers.test.tsx`, `client/src/__tests__/admin-transfer-routes-page.test.tsx`

**Interfaces:**

- Produces: `TransferRouteHomeCard.toPlace: { id: number; name: string; placeType: TransferPlaceType }` (adds `placeType`, matching `fromPlace`'s existing shape — `TransferRouteHomeCard.fromPlace` already carries it).

**The bug, exactly:** `PopularTransfers.tsx` renders nothing when `route.imagePath` is `null` (confirmed — the ternary's false branch is a bare `null`), leaving only the plain `bg-brand-blue-50` div fill showing — the "blank grey box" the owner describes. This happens whenever the featured route's `toPlace` has no linked `destinations` row (or that row has no `imagePath`).

Invoke **ui-ux-pro-max** before writing the fallback tile's markup/classes.

- [ ] **Step 1: Add `toPlace.placeType` to the server query and shared type**

In `shared/src/transfers.ts`, change `TransferRouteHomeCard`'s `toPlace` field:

```ts
toPlace: {
  id: number;
  name: string;
  placeType: TransferPlaceType;
}
```

In `server/src/routers/public/transfers.ts`'s `featured` procedure: add `toPlaceType: toPlace.placeType` to the `select` (the query already selects `toPlace.id`/`toPlace.name`/`toPlace.destinationId` as `toPlaceId`/`toPlaceName`/`toPlaceDestinationId` — add the sibling `toPlaceType: toPlace.placeType` the same way), and update the returned row's `toPlace` object to include `placeType: row.toPlaceType`.

- [ ] **Step 2: Add the fallback tile in `PopularTransfers.tsx`**

Replace the "no imagePath" branch (currently a bare `null` inside the ternary at the top of the photo `<div>`) with a brand-gradient tile. Use a blue-only gradient (not blue-to-gold) to sidestep this project's own documented gold-contrast risk (CLAUDE.md: `brand-gold-600` fails AA for normal text on several backgrounds) — white text on a dark blue gradient is unambiguously safe:

```tsx
{
  route.imagePath ? (
    <img src={route.imagePath} alt="" className="size-full object-cover" />
  ) : (
    <div className="from-brand-blue-700 to-brand-blue-950 flex size-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br text-white">
      {(() => {
        const ToIcon = PLACE_TYPE_ICON[route.toPlace.placeType];
        return <ToIcon className="size-6" aria-hidden="true" />;
      })()}
      <span className="px-2 text-center text-xs font-semibold">{route.toPlace.name}</span>
    </div>
  );
}
```

(`PLACE_TYPE_ICON` is already imported in this file from `@/lib/place-types` for the from-place label — reuse the same import.)

- [ ] **Step 3: Same fallback in `HomeTransferCardPreview.tsx`**

This component currently renders a plain "Photo" text placeholder regardless of real data (it's a static mockup — no real image/destination is ever resolved here). Add a `toPlaceType: TransferPlaceType` prop (new, alongside the existing `fromPlaceType` prop) and render the identical gradient tile treatment, using `toName` (already a prop) as the label:

```tsx
<div className="from-brand-blue-700 to-brand-blue-950 flex size-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br text-white">
  {(() => {
    const ToIcon = PLACE_TYPE_ICON[toPlaceType];
    return <ToIcon className="size-6" aria-hidden="true" />;
  })()}
  <span className="px-2 text-center text-xs font-semibold">{toName}</span>
</div>
```

Replace whatever the component's current "Photo" placeholder markup is with this (read the file first — this is a mockup preview, so it should always show the fallback tile, never attempt a real `<img>`, since the real photo is explicitly not previewed per this component's own existing doc comment).

- [ ] **Step 4: Wire the new prop from `AdminTransferRoutesPage.tsx`**

Find where `<HomeTransferCardPreview>` is rendered (it already passes `fromPlaceType={places.find((p) => p.id === fromPlaceId)?.placeType ?? 'destination'}`) and add the sibling:

```tsx
toPlaceType={places.find((p) => p.id === toPlaceId)?.placeType ?? 'destination'}
```

- [ ] **Step 5: Tests**

`popular-transfers.test.tsx`: add a test where a featured card's `imagePath` is `null` — assert the fallback tile renders (the destination name text is present, the place-type icon is present via its `aria-hidden` svg or a role check, and no `<img>` element exists in that card). Prove it can fail (temporarily revert to the old bare-`null` branch, confirm red, restore, confirm green).

`admin-transfer-routes-page.test.tsx`: add/extend a test asserting the preview's fallback tile shows the correct `toName` and `toPlaceType`-derived icon when a "To place" is selected in the form.

- [ ] **Step 6: Run the related tests, commit**

```bash
pnpm --filter @rg/client test -- popular-transfers admin-transfer-routes-page
pnpm --filter @rg/server test -- public-queries
```

```bash
git add shared/src/transfers.ts server/src/routers/public/transfers.ts client/src/components/home/PopularTransfers.tsx client/src/components/admin/HomeTransferCardPreview.tsx client/src/pages/admin/AdminTransferRoutesPage.tsx client/src/__tests__/popular-transfers.test.tsx client/src/__tests__/admin-transfer-routes-page.test.tsx
git commit -m "feat(public): brand-gradient fallback tile when a featured route has no photo (QA 1B)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Write **✅ DONE 1B**.

---

## Task 1C: Tour-wording copy — report only, no code or data change

**This task makes NO code or data change.** Direct research (reading `HeroSection.tsx`, `HowItWorks.tsx`, `server/src/content/settings.ts`, `server/src/content/settings-schema.ts`, and `server/src/db/seed-data.ts`) found:

- The hero `eyebrow`/`headline`/`subtitle` and the four how-it-works step `title`/`body` fields are **100% settings-stored**, read via `trpc.settings.get`, with **zero hardcoded tour-wording strings anywhere in either component**. There is no `siteTagline(showTours)`-style code branch for either file's main copy.
- The CURRENTLY SEEDED values (`server/src/db/seed-data.ts`) are already transfer-wording — e.g. headline `"Private airport and island transfers across Cebu, booked direct with the people who drive them."`, and step 1 `"Pick your transfer and date"` / step 4 `"Meet your driver"`. The literal tour-wording strings the owner's QA observed (`"Private Cebu day tours, booked direct…"`, `"Pick a tour and date"`, `"Meet your guide"`) do not exist anywhere in this repo's source or current seed data.
- Because `seedBase` is insert-only forever (CLAUDE.md: never overwrites an existing settings row), the most likely explanation is that the environment the owner tested against has OLDER tour-wording values already sitting in its `settings` table from before this content was switched to transfer-wording — the insert-only seed would never have touched those rows to update them.
- The rating badge's own fix is handled separately in Task 1D, not here.

- [ ] **Step 1: No implementation step.** Confirm the above by reading the four files named (quick sanity re-check, not full research) if anything about this plan's description of them seems off; otherwise skip straight to reporting.

- [ ] **Step 2: Report the exact admin screens + fields** (to be included verbatim in the final report to the owner):
  - **Home page hero** (admin block titled "Home page hero", blurb "The first thing a guest sees, and its image.") → field **Headline** — currently should read the transfer-wording sentence above; if the owner is seeing tour-wording live, this field on the LIVE site's settings table holds the old value and needs a manual edit here.
  - **How it works** (admin block titled "How it works", blurb "The numbered steps on the home page.") → rows **Step 1** through **Step 4**, each with **Title** and **Body** fields — same situation; edit each step's Title/Body directly if the live site shows tour-wording.
  - No DOT/BIR/other fields are involved; this is purely the Hero and How-it-works blocks on the admin Settings screen.

Write **✅ DONE 1C** (meaning: investigated, confirmed settings-stored, reported — not "fixed in code").

---

## Task 1D: Hide the hero rating badge when there are zero real reviews

**Files:**

- Modify: `client/src/components/home/HeroSection.tsx`
- Test: `client/src/__tests__/hero-trust.test.tsx`

**The fix, exactly:** `HeroSection.tsx` renders the `4.9★` badge whenever `trust.ratingAverage !== null` (line ~186), with no awareness of whether any real review actually exists. `hasRealReviews` already exists on the settings payload (added in the previous batch, computed server-side via `realAggregate()` — the same function that gates the JSON-LD `aggregateRating` key and the "What guests say" section/nav link). Confirmed via repo-wide grep: `HeroSection.tsx` is the ONLY public-page file that renders a star rating — `TrustBar.tsx` has no rating logic at all, so this is a single-file fix.

Invoke **ui-ux-pro-max** before touching the conditional (minor, but it's a visible UI change).

- [ ] **Step 1: Add `hasRealReviews` to the destructure and the condition**

The `QueryBoundary` render-prop currently destructures `{ trust, hero, permits }` (line ~178) from the settings payload. Add `hasRealReviews`:

```tsx
{({ trust, hero, permits, hasRealReviews }) => {
```

Change the rating-badge condition (line ~186) from:

```tsx
if (trust.ratingAverage !== null) {
```

to:

```tsx
if (trust.ratingAverage !== null && hasRealReviews) {
```

Reusing the exact existing boolean — do not add a second condition or re-derive it from anything else.

- [ ] **Step 2: Tests**

`hero-trust.test.tsx` already has rating-related tests (confirmed via grep, around lines 157-171). Add two cases:

- `hasRealReviews: false` with `trust.ratingAverage` set (e.g. `4.9`) → the `★` badge text is absent.
- `hasRealReviews: true` with the same `trust.ratingAverage` set → the badge renders (regression — confirms the existing passing behavior survives the added condition).

Prove the first new test can fail: temporarily revert Step 1's `&& hasRealReviews` back to just `trust.ratingAverage !== null`, confirm the hidden-case test goes red, restore, confirm green.

- [ ] **Step 3: Run the related tests, commit**

```bash
pnpm --filter @rg/client test -- hero-trust
```

```bash
git add client/src/components/home/HeroSection.tsx client/src/__tests__/hero-trust.test.tsx
git commit -m "fix(public): hide the hero rating badge when there are zero real reviews (QA 1D)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Write **✅ DONE 1D**.

---

## Task 1E: "Your session expired" only when a session genuinely existed before

**Files:**

- Create: `client/src/lib/admin-session-marker.ts`
- Modify: `client/src/components/layout/AdminLayout.tsx`
- Test: `client/src/__tests__/admin-layout.test.tsx`

**Interfaces:**

- Produces: `recordAdminSessionConfirmed(): void` and `hadAdminSessionBefore(): boolean`, exported from `client/src/lib/admin-session-marker.ts`.

**The bug, exactly:** `AdminLayout.tsx`'s redirect guard unconditionally sets `state={{ sessionExpired: true }}` on every `UNAUTHORIZED` redirect — including a visitor who has never signed in at all. The server cannot distinguish "never had a session" from "had one, it expired" (both are the identical `UNAUTHORIZED` error), so the distinction must be made client-side via a persistent marker, following this codebase's existing `localStorage`-helper convention (mirrors `client/src/lib/consent/storage.ts`'s shape: one key constant, a getter, a setter).

**Do not touch:** `isUnauthorized`'s check, `sanitizeAdminRedirect`, the redirect URL logic, or anything server-side. This is a messaging-only fix — the redirect still happens exactly the same way for both cases; only which SENTENCE `AdminLoginPage.tsx` shows afterward changes, and that happens automatically once the state value this task controls changes (confirmed: `AdminLoginPage.tsx`'s banner is already `{sessionExpired && !login.isError ? (...) : null}` — when `sessionExpired` is `false`, nothing renders, which satisfies the owner's "show nothing" acceptable option with zero change to `AdminLoginPage.tsx`).

- [ ] **Step 1: Create the marker module**

`client/src/lib/admin-session-marker.ts`:

```ts
/**
 * Whether this browser has ever confirmed a valid admin session — the
 * client-side-only signal that lets AdminLayout's redirect distinguish "a
 * session existed and then expired" from "never signed in at all" (owner QA,
 * 2026-11-14). The server cannot make this distinction itself: both cases
 * surface as the identical UNAUTHORIZED error.
 */
const ADMIN_HAD_SESSION_KEY = 'ts-admin-had-session';

/** Call once `staffAuth.me` has resolved successfully. */
export function recordAdminSessionConfirmed(): void {
  try {
    localStorage.setItem(ADMIN_HAD_SESSION_KEY, '1');
  } catch {
    // Private browsing / storage disabled — degrade to "never had a session",
    // which is the safer default (never show "expired" to someone who can't
    // prove they were ever signed in).
  }
}

/** True only if `recordAdminSessionConfirmed()` has run in this browser before. */
export function hadAdminSessionBefore(): boolean {
  try {
    return localStorage.getItem(ADMIN_HAD_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Wire it into `AdminLayout.tsx`**

Import both functions. Beside the existing `const me = trpc.staffAuth.me.useQuery(...)` call, add an effect that records success (React Query v5 has no per-query `onSuccess` callback, so use `useEffect`):

```tsx
useEffect(() => {
  if (me.isSuccess) recordAdminSessionConfirmed();
}, [me.isSuccess]);
```

Change the redirect guard's state value from the hardcoded `true` to the marker's current value:

```tsx
if (me.isError && isUnauthorized(me.error)) {
  const redirect = `${location.pathname}${location.search}`;
  return (
    <Navigate
      to={`/admin/login?redirect=${encodeURIComponent(redirect)}`}
      state={{ sessionExpired: hadAdminSessionBefore() }}
      replace
    />
  );
}
```

Everything else in this guard (the `UNAUTHORIZED`-only check, the redirect URL, `replace`) stays exactly as it is.

- [ ] **Step 3: Tests**

`admin-layout.test.tsx` doesn't currently clear `localStorage` between tests — add `localStorage.clear()` to this file's `beforeEach` (mirroring the convention already used in `layout.test.tsx`/`motion.test.tsx`), so the new tests (and the existing ones) don't leak the marker across test runs.

Add two new tests, using the existing `renderAt(path)` helper (which already mounts both `AdminLayout` and `AdminLoginPage` in one router tree, so you can assert on the rendered login screen directly after the redirect):

```tsx
it('shows no session-expired message when this browser never had a session', async () => {
  mockTrpcError('staffAuth.me', 'UNAUTHORIZED', 'Admin sign-in required.');
  renderAt('/admin/bookings');
  await screen.findByRole('heading', { name: /staff sign-in/i });
  expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument();
});

it('shows the session-expired message when this browser had a session before', async () => {
  recordAdminSessionConfirmed(); // simulate a prior successful sign-in
  mockTrpcError('staffAuth.me', 'UNAUTHORIZED', 'Admin sign-in required.');
  renderAt('/admin/bookings');
  await screen.findByRole('heading', { name: /staff sign-in/i });
  expect(screen.getByText(/your session expired/i)).toBeInTheDocument();
});
```

(Import `recordAdminSessionConfirmed` from `@/lib/admin-session-marker` for the second test.)

Prove the first test can fail: temporarily revert Step 2's state value back to the hardcoded `true`, confirm the "no prior session" test goes red (the banner now shows when it shouldn't), restore, confirm green.

Confirm the pre-existing tests still pass unchanged — in particular `'redirects to /admin/login with the intended path when staffAuth.me is UNAUTHORIZED'` (only asserts the URL, unaffected) and `'does not redirect when staffAuth.me fails with FORBIDDEN...'` (unaffected — this task never touches the `FORBIDDEN` path).

- [ ] **Step 4: Run the related tests, commit**

```bash
pnpm --filter @rg/client test -- admin-layout
```

```bash
git add client/src/lib/admin-session-marker.ts client/src/components/layout/AdminLayout.tsx client/src/__tests__/admin-layout.test.tsx
git commit -m "fix(admin): only say 'session expired' when a session genuinely existed before (QA 1E)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Write **✅ DONE 1E**.

---

## Task 1F: Verify the pier ferry fields (no change expected)

**No code change expected.** Direct research confirms this is already implemented and tested from the previous batch:

- Client: `client/src/__tests__/transfer-booking-page.test.tsx`, describe block **`'TransferBookingPage — ferry fields on a pier route'`** — two tests, `'shows the ferry fields when the pickup place is a pier'` and `'hides the ferry fields when the pickup place is not a pier'`. `TransferBookingPage.tsx`'s `ferryDetailsVisible` (lines ~297-307) correctly gates on the resolved pickup place's `placeType === 'pier'`, direction-aware (forward reads `fromPlace`, reverse reads `toPlace`) — confirmed by direct read, unchanged since merge.
- Server: `server/src/__tests__/transfer-create-booking.test.ts` — `'stores ferry vessel name and arrival time on a pier pickup'`, `'accepts a pier pickup with no ferry details at all'`, and the day-use refusal cases (`ferry_details_on_day_use`).

- [ ] **Step 1: Run exactly these tests and confirm green**

```bash
pnpm --filter @rg/client test -- transfer-booking-page -t "ferry"
pnpm --filter @rg/server test -- transfer-create-booking -t "ferry"
```

- [ ] **Step 2: If anything is red, investigate and fix minimally** (should not happen — these were part of the previously merged, fully-verified batch). If genuinely broken, report what changed and why before fixing.

- [ ] **Step 3: No commit needed if nothing changed.** If Step 2 required a fix, commit it separately with an honest message describing what was actually broken.

Write **✅ DONE 1F** (naming the exact tests run and their pass/fail result).

---

## Final: Five checks, report, merge

- [ ] Run, in order, from repo root: `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm format:check` → `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Never report done on an unrun command.
- [ ] Merge the batch's branch into `main` locally (fast-forward expected, same as the previous batch's own finish). Do not push.
- [ ] Report every commit as `hash - short label`.
- [ ] Report admin content to edit by hand (from 1C): the "Home page hero" → Headline field, and "How it works" → Step 1-4 Title/Body fields — only if the owner's live environment actually shows tour-wording (this plan found none in source or seed data; the discrepancy is almost certainly a live-database content issue, not a code issue).
- [ ] List unrelated bugs found along the way (name + one line), do not fix them.
- [ ] Final line: **✅ QA FIXES COMPLETE**
