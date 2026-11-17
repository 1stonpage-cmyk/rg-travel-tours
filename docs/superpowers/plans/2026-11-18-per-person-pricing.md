# Per-Person Pricing Switch (Transfers + Packages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **ONE implementer at a time — never dispatch implementers in parallel.**

**Goal:** Give the admin a "Per vehicle" / "Per person" pricing switch on every transfer route, and a "Per person" / "Per group" display switch on every package, without touching tour pricing, existing bookings, or any money path the server doesn't own.

**Architecture:** Add `pricing_mode` (+ `min_paying_pax`) to `transfer_routes`, and `pricing_mode` to `packages`. One new pure function, `transferSubtotalCentavos()`, is the only place a transfer's unit price is multiplied by a paying head count; every caller computes the subtotal through it _before_ handing that number to the existing, unchanged `quoteTransfer()` arithmetic. Packages get no new arithmetic at all — there is no package checkout — only a stored label that swaps "per person" / "per group" copy on two public pages.

**Tech Stack:** Drizzle + MySQL 8, Zod (shared), tRPC, React + TS, Tailwind v4.

**Spec:** `docs/BUILD_SPEC.md` and `CLAUDE.md` (money, soft-delete, Clean Pill, mobile-first rules below bind every task equally).

## Global Constraints

- Money is integer centavos everywhere; the server computes every total, the browser never multiplies or discounts.
- Day-tour pricing (`tour_price_tiers`, `services/pricing.ts`) is untouched.
- No existing booking, `price_snapshot`, or `bookings` money column is ever rewritten. `bookings.amount_paid_centavos` is written only by `record-payment.ts`.
- 30% deposit rule and the ₱100 PayMongo floor are unchanged, applied to the new (possibly multiplied) total.
- No red anywhere; admin buttons use the six Clean Pill variants (`primary-pill`/`secondary-pill`/`admin-ghost`/`amber-pill`/`row`/`row-amber`), never a bare `size`. 44px tap targets. Mobile-first at 360px.
- Additive only: new columns have safe defaults; existing rows behave exactly as they do today unless a Decision below says otherwise.
- Every new test must be provably able to fail (break it, see red, restore) before being left green.
- Package has no checkout path — `pricing_mode` there is display-only. Never add arithmetic that doesn't exist today.

---

## Decisions — confirmed by owner, 2026-11-18

1. **Seat cap applies to BOTH pricing modes.** This is a new rule — there is no seat-fit check anywhere today (`sellableVehiclesByType()` is "deliberately NOT filtered by seat capacity"; `transfers-checkout.ts`'s `pax` is documented "NOT a capacity check"; `vehicle_types.default_seats` is documented "PREFILL ONLY"). `default_seats` is repurposed as the guest-facing cap on every transfer booking, per-vehicle included; `null` = no cap.
2. **Staff custom-quote conversion stays OUT OF SCOPE.** `convertTransferQuote` / `ConvertInquiryForm.tsx` are unchanged — staff keep entering one total price regardless of pax. `services/transfers/display.ts` needs no change (title-only, no price logic).
3. **Package default is `per_group`, NOT `per_person`.** Keeps every existing package's public copy exactly as it reads today — no silent copy change on deploy. New packages default the form to `per_group`; an admin may switch any package to `per_person` any time.
4. **`quoteTransferInput.pax` is required, no default.** Matches this codebase's convention for money-affecting inputs.
5. **The price snapshot carries the full breakdown.** `pricingMode`, `paxCharged` (after the minimum), `minPayingPax` — all `.optional()` for legacy rows, which render as "per vehicle, no multiplication" when absent.
6. **A vehicle the party can't fit stays visible, disabled, with a reason** — never silently removed from the list.

---

## Schema

**Migration 0029** (next after `0028_nasty_vampiro.sql`), additive only:

```sql
ALTER TABLE `transfer_routes`
  ADD COLUMN `pricing_mode` ENUM('per_vehicle','per_person') NOT NULL DEFAULT 'per_vehicle',
  ADD COLUMN `min_paying_pax` INT NOT NULL DEFAULT 1;

ALTER TABLE `packages`
  ADD COLUMN `pricing_mode` ENUM('per_person','per_group') NOT NULL DEFAULT 'per_group';
```

No change to `transfer_route_vehicle_prices`, `tour_price_tiers`, `vehicle_types`, or any booking/payment table. `vehicle_types.default_seats`'s doc comment (schema.ts) and its admin-form hint (`AdminVehicleTypesPage.tsx`) each get one added sentence recording its new second job (Task 3).

## The one multiply function

`server/src/services/transfers/pricing.ts`, new export beside `quoteTransfer()` (not inside it):

```ts
export type TransferPricingMode = 'per_vehicle' | 'per_person';

export function transferSubtotalCentavos(args: {
  pricingMode: TransferPricingMode;
  unitPriceCentavos: number;
  pax: number;
  minPayingPax: number;
}): { subtotalCentavos: number; paxCharged: number } {
  if (args.pricingMode === 'per_vehicle') {
    return { subtotalCentavos: args.unitPriceCentavos, paxCharged: args.pax };
  }
  const paxCharged = Math.max(args.pax, args.minPayingPax);
  return { subtotalCentavos: args.unitPriceCentavos * paxCharged, paxCharged };
}
```

`quoteTransfer()` is **not modified**. Every caller computes `transferSubtotalCentavos()` first and passes its `subtotalCentavos` in as `priceCentavos`, exactly as today's callers already do for a `per_vehicle` route (where this is a no-op pass-through). This is what keeps `transfer-pricing.test.ts`'s existing "has NO pax parameter" pin on `quoteTransfer()` true and unchanged.

---

## Task 1 (brief label: 2A) — Schema + migration

**Files:**

- Modify: `server/src/db/schema.ts` (`transferRoutes`, `packages` table defs; `vehicleTypes.defaultSeats` doc comment)
- Create: `server/src/db/migrations/0029_<drizzle-generated-name>.sql` (via `pnpm --filter @rg/server db:generate`, not hand-written)
- Modify: `shared/src/transfers.ts` (new `TRANSFER_PRICING_MODES`/`TransferPricingMode` export — the single vocabulary every later task imports, mirroring how `TRANSFER_PRODUCT_TYPES` is declared there)
- Modify: `shared/src/packages-admin.ts` (new `PACKAGE_PRICING_MODES`/`PackagePricingMode` export, same pattern as `INQUIRY_TYPES`)

**Interfaces produced (every later task consumes these exact names):**

- `shared/src/transfers.ts`: `export const TRANSFER_PRICING_MODES = ['per_vehicle', 'per_person'] as const; export type TransferPricingMode = (typeof TRANSFER_PRICING_MODES)[number];`
- `shared/src/packages-admin.ts`: `export const PACKAGE_PRICING_MODES = ['per_person', 'per_group'] as const; export type PackagePricingMode = (typeof PACKAGE_PRICING_MODES)[number];`
- `schema.ts`: `transferRoutes.pricingMode` (mysqlEnum, NOT NULL, default `'per_vehicle'`), `transferRoutes.minPayingPax` (int, NOT NULL, default `1`), `packages.pricingMode` (mysqlEnum, NOT NULL, default `'per_group'`).

- [ ] **Step 1:** Add `pricingMode: mysqlEnum('pricing_mode', TRANSFER_PRICING_MODES).notNull().default('per_vehicle')` and `minPayingPax: int('min_paying_pax').notNull().default(1)` to the `transferRoutes` table definition in `schema.ts`, right after `freeCancelHours` (keep related money/pricing fields together). Add a doc comment: "Owner decision 2026-11-18 (per-person pricing plan): a route prices per vehicle (flat catalog rate, today's behaviour) or per person (`transferSubtotalCentavos()` multiplies by `max(pax, minPayingPax)`). Default `per_vehicle`/`1` so every existing route is unchanged."
- [ ] **Step 2:** Add `pricingMode: mysqlEnum('pricing_mode', PACKAGE_PRICING_MODES).notNull().default('per_group')` to the `packages` table definition, after `newPriceCentavos`. Doc comment: "Display-only — there is no package checkout. Default `per_group` matches today's hardcoded public copy exactly; an admin may switch a package to `per_person` any time (owner decision 2026-11-18)."
- [ ] **Step 3:** Add one sentence to `vehicleTypes.defaultSeats`'s existing doc comment: "As of the per-person pricing plan (2026-11-18), this is ALSO the guest-facing passenger cap on every transfer booking of this vehicle type (`pax_exceeds_vehicle_seats` refusal) — `null` means no cap. Still not authoritative for dispatch, which reads a specific van's own `capacity`."
- [ ] **Step 4:** Run `pnpm --filter @rg/server db:generate`. Confirm the generated SQL only adds columns (no data loss, no table rewrite requiring a default backfill beyond the two `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` statements).
- [ ] **Step 5:** Run `pnpm --filter @rg/server db:migrate` against local `rg_travel` to prove it applies cleanly.
- [ ] **Step 6:** Add a schema test (follow the pattern in `server/src/__tests__/schema.test.ts` or `schema-fleet.test.ts`): insert a `transfer_routes` row with no `pricing_mode`/`min_paying_pax` given, read it back, assert `pricingMode === 'per_vehicle'` and `minPayingPax === 1`. Same for a `packages` row defaulting to `pricingMode === 'per_group'`. Break each assertion first (assert the wrong default) to prove the test can fail, then fix and commit.
- [ ] **Step 7:** Commit (migration file, schema.ts, the two shared constant exports, the new test).

---

## Task 2 (brief label: 2B) — Server pricing: the shared function, wire types, and callers

**Depends on Task 1's `TransferPricingMode`, `transferRoutes.pricingMode`/`minPayingPax`, `vehicleTypes.defaultSeats`.**

**Files:**

- Modify: `server/src/services/transfers/pricing.ts` — add `transferSubtotalCentavos()` (code above); widen `TransferVehiclePrice` with `pricingMode: TransferPricingMode`, `minPayingPax: number`, `defaultSeats: number | null`; widen `vehiclePriceForRouteAndType()`'s `SELECT` to read the three new columns (joins to `transferRoutes`/`vehicleTypes` already exist — no new query).
- Modify: `server/src/services/transfers/create-booking.ts` — seat-cap check, reordered multiply, snapshot fields.
- Modify: `shared/src/booking.ts` — `transferPriceSnapshotSchema` gains `pricingMode`, `paxCharged`, `minPayingPax` (all `.optional()`).
- Modify: `shared/src/transfers.ts` — `quoteTransferInput` gains required `pax` (same bounds as the hold input's: `z.number().int().min(1).max(30)`); `quoteTransferResultSchema` gains `pricingMode: z.enum(TRANSFER_PRICING_MODES)` and `paxCharged: z.number().int().positive()`; `TransferRoutePublicVehiclePrice` gains `defaultSeats: z.number().int().positive().nullable()` equivalent on the plain interface (it's a TS interface, not a Zod schema — just add the field) and `pricingMode`/`minPayingPax` move to `TransferRoutePublicRow` (route-level, not per-vehicle).
- Modify: `server/src/routers/public/checkout.ts` — `quoteTransfer` resolver: seat-cap refusal, `transferSubtotalCentavos()` call, `validateCoupon` against the subtotal (not the unit price), return the two new result fields.
- Modify: `server/src/routers/public/transfers.ts` — `list` selects/returns `pricingMode`/`minPayingPax` on the route and `defaultSeats` per vehicle price row; `featured` resolves a per-person route's `cheapestOneWay` label.
- Modify: `shared/src/transfers.ts` — `TransferRouteHomeCard.cheapestOneWay` gains `pricingMode: TransferPricingMode` so `PopularTransfers.tsx` never has to guess the unit from the vehicle name.
- Test files: `server/src/__tests__/transfer-pricing.test.ts`, `server/src/__tests__/transfer-create-booking.test.ts`, a new `server/src/__tests__/checkout-quote-transfer-pax.test.ts`.

**Interfaces consumed:** `TransferPricingMode`/`TRANSFER_PRICING_MODES` (Task 1).
**Interfaces produced (Task 4/5 consume these):** `transferSubtotalCentavos()`, the widened `TransferVehiclePrice`/`TransferRoutePublicRow`/`QuoteTransferResult`/`TransferPriceSnapshot` shapes named above.

- [ ] **Step 1 — failing test for the pure function.** In `transfer-pricing.test.ts`, add:
  ```ts
  describe('transferSubtotalCentavos', () => {
    it('per_vehicle ignores pax entirely', () => {
      const result = transferSubtotalCentavos({
        pricingMode: 'per_vehicle',
        unitPriceCentavos: 150_000,
        pax: 6,
        minPayingPax: 1,
      });
      expect(result).toEqual({ subtotalCentavos: 150_000, paxCharged: 6 });
    });
    it('per_person multiplies by pax', () => {
      const result = transferSubtotalCentavos({
        pricingMode: 'per_person',
        unitPriceCentavos: 35_000,
        pax: 3,
        minPayingPax: 1,
      });
      expect(result).toEqual({ subtotalCentavos: 105_000, paxCharged: 3 });
    });
    it('per_person floors pax at the minimum', () => {
      const result = transferSubtotalCentavos({
        pricingMode: 'per_person',
        unitPriceCentavos: 35_000,
        pax: 1,
        minPayingPax: 2,
      });
      expect(result).toEqual({ subtotalCentavos: 70_000, paxCharged: 2 });
    });
  });
  ```
  Run it — it must fail (`transferSubtotalCentavos` is not defined yet).
- [ ] **Step 2 — implement `transferSubtotalCentavos()`** exactly as specified above in `pricing.ts`. Re-run Step 1's tests; confirm green.
- [ ] **Step 3 — widen the catalog read.** In `vehiclePriceForRouteAndType()`, add `pricingMode: transferRoutes.pricingMode, minPayingPax: transferRoutes.minPayingPax, defaultSeats: vehicleTypes.defaultSeats` to the `SELECT`, and the three fields to the returned `TransferVehiclePrice` object and its interface.
- [ ] **Step 4 — snapshot schema.** In `shared/src/booking.ts`, add to `transferPriceSnapshotSchema`:
  ```ts
  pricingMode: z.enum(TRANSFER_PRICING_MODES).optional(),
  paxCharged: z.number().int().positive().optional(),
  minPayingPax: z.number().int().positive().optional(),
  ```
  Add a test in `shared/src/__tests__` (or wherever `transferPriceSnapshotSchema` is already tested) proving a snapshot object with NEITHER field still parses (legacy row) — break it first by making the fields required, confirm it fails to parse a legacy fixture, then restore `.optional()`.
- [ ] **Step 5 — the seat cap + reordered multiply in `createTransferBooking()`.**
  - Add `'pax_exceeds_vehicle_seats'` to `TRANSFER_BOOKING_SHAPE_PROBLEMS`, documented as a third exception to "checked before the transaction opens" (same footing as `reverse_not_enabled_for_route`/`flight_details_required_for_airport_route` — needs the resolved vehicle type).
  - Widen `loadVehicleTypeName()` (rename to `loadVehicleType()`, update its one call site) to also select and return `defaultSeats`.
  - Right after the catalog read (step 3a in the existing file), before the capacity check: `const seats = catalog?.defaultSeats ?? (await loadVehicleType(tx, input.vehicleTypeId)).defaultSeats; if (seats !== null && input.pax > seats) throw new TransferBookingShapeError('pax_exceeds_vehicle_seats', \`pax ${input.pax} exceeds vehicle type's ${seats} seats\`);`
  - Replace the existing `const priceCentavos = input.priceSource.kind === 'staff' ? ... : catalog!.priceCentavos;` block: on the `catalog` branch, compute `const { subtotalCentavos, paxCharged } = transferSubtotalCentavos({ pricingMode: catalog!.pricingMode, unitPriceCentavos: catalog!.priceCentavos, pax: input.pax, minPayingPax: catalog!.minPayingPax });` — the STAFF branch keeps `priceCentavos = input.priceSource.priceCentavos` unchanged and `paxCharged = input.pax`, `pricingMode = 'per_vehicle'` (Decision 2: staff quotes stay flat).
  - Move the `validateCoupon(...)` call to run against `subtotalCentavos` (catalog branch) or `priceCentavos` (staff branch, unchanged) — NOT the unit rate.
  - Pass `subtotalCentavos`/`priceCentavos` into `quoteTransfer({ priceCentavos: <that value>, coupon, depositPercent })` — `quoteTransfer()` itself is untouched.
  - In `buildTransferSnapshot()`, add `pricingMode: priced.pricingMode, paxCharged: priced.paxCharged, minPayingPax: priced.minPayingPax` to the object passed to `transferPriceSnapshotSchema.parse()` (staff branch: `minPayingPax: 1`).
- [ ] **Step 6 — test the seat cap and the reordering** in `transfer-create-booking.test.ts`:
  - `pax` greater than the vehicle type's `defaultSeats` is refused with `pax_exceeds_vehicle_seats`, for a `per_vehicle` route AND a `per_person` route (Decision 1 — both modes). Break the check (comment it out), confirm the test goes red, restore.
  - A vehicle type with `defaultSeats: null` is never capped, any pax up to the existing max-30 bound.
  - A `per_person` route with `minPayingPax: 2` and a booking of `pax: 1` stores `subtotalCentavos = unitPrice * 2` and a `price_snapshot.paxCharged === 2`.
  - Deposit is 30% of the multiplied total, not the unit rate (assert the number, not just that it's "some positive amount").
  - A coupon with a minimum-spend rule validates against the multiplied subtotal (construct a coupon whose minimum sits between the unit price and the multiplied subtotal; assert it is accepted on the multiplied total and would have been refused on the unit price alone — prove this by temporarily reverting Step 5's coupon-ordering and watching the test fail before restoring).
- [ ] **Step 7 — `checkout.quoteTransfer` resolver.** Add `pax: z.number().int().min(1).max(30)` to `quoteTransferInput` (shared/src/transfers.ts). In the resolver: after the existing `catalog` null-check, add the seat-cap refusal (`BAD_REQUEST`, message from one new shared helper — see Task 5's `seatCapMessage(seats)` — reused by both this resolver and `translateHoldTransferError`'s new `pax_exceeds_vehicle_seats` branch so the two surfaces say the identical sentence); compute `transferSubtotalCentavos(...)`; call `validateCoupon(code, subtotalCentavos, ...)`; call `quoteTransfer({ priceCentavos: subtotalCentavos, coupon, depositPercent })`; return `{ ...quote, freeCancelHours: catalog.freeCancelHours, pricingMode: catalog.pricingMode, paxCharged }`.
- [ ] **Step 8 — test the quote resolver** in the new `checkout-quote-transfer-pax.test.ts`: a per-person quote with `pax: 3` returns `totalCentavos` equal to `unitPrice * 3` minus any discount; `pax` over the seat cap is refused with the plain seat-cap sentence; a per-vehicle route's quote is byte-identical to today's (no behaviour change) when `pax: 1`.
- [ ] **Step 9 — public `transfers.ts` router.** `list`: select `transferRoutes.pricingMode, transferRoutes.minPayingPax` on the route query, `vehicleTypes.defaultSeats` on the price-row query; add both to the returned `TransferRoutePublicRow`/`TransferRoutePublicVehiclePrice`. `featured`: when resolving `cheapestOffer`, carry the route's `pricingMode` through to `cheapestOneWay`.
- [ ] **Step 10 — run the full server test suite for files touched** (`pnpm --filter @rg/server test -- transfer-pricing transfer-create-booking checkout-quote-transfer-pax checkout-router transfers-public`, or the project's equivalent filter) and confirm green.
- [ ] **Step 11 — commit.**

---

## Task 3 (brief label: 2C) — Admin transfer route form

**Depends on Task 1/2's schema fields and shared types.**

**Files:**

- Modify: `shared/src/transfers-admin.ts` — `transferRouteFieldsSchema` gains `pricingMode: z.enum(TRANSFER_PRICING_MODES).optional()`, `minPayingPax: z.number().int().min(1).max(30).optional()`; `mergeTransferRoutePatch()` gets the two fields with the `!== undefined` spelling; `TransferRouteAdminRow` gains `pricingMode`, `minPayingPax`.
- Modify: `server/src/services/transfers/upsert-route.ts` — `routeValues()` gets `pricingMode: params.pricingMode ?? 'per_vehicle', minPayingPax: params.minPayingPax ?? 1`.
- Modify: `server/src/routers/admin/transfer-routes.ts` — `list`/`detail` (wherever `TransferRouteAdminRow` is assembled) select and return the two new columns.
- Modify: `client/src/pages/admin/AdminTransferRoutesPage.tsx` — pricing-mode radio pair + minimum-passengers input in the "Prices per vehicle type" section; price-box labels flip "(pesos)" → "(pesos / vehicle)" / "(pesos / person)"; compute and pass the form's own lowest non-blank one-way price + mode into the preview.
- Modify: `client/src/components/admin/HomeTransferCardPreview.tsx` — accept `lowestOneWayPesos: number | null` and `pricingMode: TransferPricingMode`, render the real figure and correct label instead of the `₱X per vehicle` placeholder.
- Test: `client/src/__tests__/admin-transfer-routes-page.test.tsx`, `server/src/__tests__/admin-transfer-routes.test.ts`.

- [ ] **Step 1 — shared schema + merge.** Add the two optional fields to `transferRouteFieldsSchema` (next to `prices`); add them to `mergeTransferRoutePatch()`'s returned object using the file's existing `!== undefined ? patch.x : stored.x` spelling; add `pricingMode: TransferPricingMode, minPayingPax: number` to `TransferRouteAdminRow`.
- [ ] **Step 2 — failing server test.** In `admin-transfer-routes.test.ts`: create a route with `pricingMode: 'per_person', minPayingPax: 2` in the input, read it back via `admin.transferRoutes.list`, assert both fields round-trip. Then a SEPARATE test: create a route with NEITHER field in the input (today's existing fixture shape, unchanged), assert it defaults to `per_vehicle`/`1` — this is the proof the additive default doesn't disturb existing callers. Run both; the first fails until Step 3.
- [ ] **Step 3 — server write path.** `routeValues()` in `upsert-route.ts`: add the two columns with the `?? 'per_vehicle'` / `?? 1` fallback (mirrors the existing `sortOrder: params.sortOrder ?? 0` line immediately above it). Update the admin router's `list`/`detail` SELECTs. Re-run Step 2's tests; confirm green.
- [ ] **Step 4 — admin form UI.** In `AdminTransferRoutesPage.tsx`'s `TransferRouteForm`, inside the existing `<div className={SECTION}>` ("Prices per vehicle type"), add — directly under the `<h3>`, above the "Leave both boxes blank…" hint:
  ```tsx
  <fieldset className="space-y-2">
    <legend className="text-brand-ink text-sm font-semibold">Pricing</legend>
    <div className="flex flex-wrap gap-4">
      <label
        className="tap-target flex items-center gap-2 text-sm"
        htmlFor="route-pricing-per-vehicle"
      >
        <input
          id="route-pricing-per-vehicle"
          type="radio"
          name="pricingMode"
          checked={pricingMode === 'per_vehicle'}
          onChange={() => setPricingMode('per_vehicle')}
        />
        Per vehicle
      </label>
      <label
        className="tap-target flex items-center gap-2 text-sm"
        htmlFor="route-pricing-per-person"
      >
        <input
          id="route-pricing-per-person"
          type="radio"
          name="pricingMode"
          checked={pricingMode === 'per_person'}
          onChange={() => setPricingMode('per_person')}
        />
        Per person
      </label>
    </div>
    {pricingMode === 'per_person' && (
      <div className="space-y-1.5">
        <Label htmlFor="route-min-paying-pax">Minimum paying passengers</Label>
        <Input
          id="route-min-paying-pax"
          type="number"
          min={1}
          className={`${FIELD} w-24`}
          value={minPayingPax}
          onChange={(event) => setMinPayingPax(event.target.value)}
        />
      </div>
    )}
  </fieldset>
  ```
  Add `pricingMode`/`setPricingMode` and `minPayingPax`/`setMinPayingPax` state (same pattern as `reverseEnabled`/`setReverseEnabled` and `homePageOrder`/`setHomePageOrder` elsewhere in this component), initialised from the edited route (`'per_vehicle'`/`'1'` on create). Include both in `submit()`'s payload.
  Change each vehicle type's two `<Label>`s from `"One-way (pesos)"`/`"Day-use (pesos)"` to a computed label: `` `One-way (pesos / ${pricingMode === 'per_person' ? 'person' : 'vehicle'})` `` (and the `Day-use` counterpart).
- [ ] **Step 5 — fix the preview placeholder.** In `TransferRouteForm`, compute `const lowestOneWayPesos = /* min of every non-blank oneWay box across priceValuesFor(type), parsed as a number, or null if none are filled in */` and pass it plus `pricingMode` to `<HomeTransferCardPreview>`. In `HomeTransferCardPreview.tsx`, replace the hardcoded `<p>...One-way from ₱X per vehicle</p>` with: `lowestOneWayPesos === null ? <p>...No price entered yet</p> : <p>...One-way from {formatPesosInput(lowestOneWayPesos)} per {pricingMode === 'per_person' ? 'person' : 'vehicle'}</p>` (reuse whatever peso-formatting helper this file's siblings already use for a pesos-typed-as-string value — do not invent a second one). Update this component's own header doc comment: it no longer previews a universal placeholder; it previews the form's own typed lowest price.
- [ ] **Step 6 — client test.** `admin-transfer-routes-page.test.tsx`: flipping the radio to "Per person" shows the minimum-passengers box and changes both price labels to "/ person"; the preview shows a real computed price once a one-way box has a value, and the correct unit word in both modes. Break the label-flip logic first (hardcode "vehicle"), confirm red, fix, confirm green.
- [ ] **Step 7 — verify Clean Pill / mobile-first:** no new button was added (radios + number input only) — confirm nothing here needs a Button variant change. Check the new fieldset at 360px width (via the project's existing responsive test pattern or manual check) — radios must not wrap awkwardly against the 44px tap-target rule.
- [ ] **Step 8 — commit.**

---

## Task 4 (brief label: 2D) — Admin package form

**Depends on Task 1's `PackagePricingMode`/`packages.pricingMode`.**

**Files:**

- Modify: `shared/src/packages-admin.ts` — `packageFields` gains `pricingMode: z.enum(PACKAGE_PRICING_MODES)` (REQUIRED — this file's every other field is required on a full-replacement create/update); `PackageAdminRow` gains `pricingMode`.
- Modify: `server/src/routers/admin/packages.ts` — `packageColumns()` gains `pricingMode`; `auditDataFor()` unchanged (not money); `list` SELECT gains the column.
- Modify: `server/src/routers/public/packages.ts` — `PackageListItem`/`PackageDetail` gain `pricingMode`; both `list` and `bySlug` SELECT/return it.
- Modify: `client/src/pages/admin/AdminPackagesPage.tsx` — new `EntityFormField` (`type: 'select'`), `valuesFromPackage()`/submit payload/`fieldErrors` map updates.
- Test: `server/src/__tests__/admin-packages.test.ts`, `client/src/__tests__/admin-packages-page.test.tsx`.

- [ ] **Step 1 — shared schema.** Add `pricingMode: z.enum(PACKAGE_PRICING_MODES)` to `packageFields` in `packages-admin.ts`, next to `newPriceCentavos`. Add `pricingMode: PackagePricingMode` to `PackageAdminRow`.
- [ ] **Step 2 — failing server test.** `admin-packages.test.ts`: create a package with `pricingMode: 'per_person'`, read it back via `admin.packages.list`, assert it round-trips. A second test: posting `pricingMode: 'per_group'` and reading the package through the PUBLIC `packages.list`/`packages.bySlug` also returns it. A third: `pricingMode: 'invalid'` is refused by the Zod schema (400, not a 500).
- [ ] **Step 3 — server write/read paths.** `packageColumns()` in `admin/packages.ts`: add `pricingMode: input.pricingMode`. The `list` query's `SELECT`: add `pricingMode: packages.pricingMode`, and its map at the bottom: add `pricingMode: row.pricingMode`. `public/packages.ts`: add `pricingMode: packages.pricingMode` to both `list`'s and `bySlug`'s `SELECT`/return shape (these currently use `db.select()` with no column list for `bySlug` and an explicit list for `list` — match each query's existing style). Run Step 2's tests; confirm green.
- [ ] **Step 4 — admin form UI.** In `AdminPackagesPage.tsx`'s `PACKAGE_FIELDS` array, add, right after the `oldPrice` entry:
  ```tsx
  {
    name: 'pricingMode',
    label: 'Pricing',
    type: 'select',
    required: true,
    options: [
      { value: 'per_person', label: 'Per person' },
      { value: 'per_group', label: 'Per group' },
    ],
    hint: 'How the price is labelled on the public page. Display only — nothing is multiplied.',
  },
  ```
  Add `pricingMode` to `PACKAGE_FIELD_NAMES` (automatic — it reads off `PACKAGE_FIELDS`), to `fieldErrors()`'s `byKey` map (`pricingMode: 'pricingMode'`), to `valuesFromPackage()` (new package default: `pricingMode: 'per_group'`; editing an existing one: `pricingMode: row.pricingMode`), and to `submit()`'s payload (`pricingMode: value('pricingMode') as 'per_person' | 'per_group'`, validated by the Zod schema server-side — no new client-side check needed since a `select` can only produce one of its own option values).
- [ ] **Step 5 — client test.** `admin-packages-page.test.tsx`: the select renders with "Per group" preselected on a new package, the stored value preselected on edit, and the chosen value appears in the submitted payload. Break the default (hardcode "per_person"), confirm red, fix, confirm green.
- [ ] **Step 6 — commit.**

---

## Task 5 (brief label: 2E) — Public surfaces: cards, booking page reorder + seat-fit UX, package pages

**Depends on Tasks 2, 3, 4's wire shapes.**

**Known red going into this task** (confirmed by Task 3's implementer via `git stash` — these errors exist identically with none of Tasks 2/3's changes applied, so they are Task 1/2's public-type additions outrunning their own consumers, not a regression introduced later): `pnpm --filter @rg/client typecheck` currently fails on `client/src/pages/public/TransferBookingPage.tsx` (missing `pax` on a `quoteTransfer` call — exactly what Step 3 below fixes) and on these test/fixture files, which all need the newer `defaultSeats`/`pricingMode`/`minPayingPax`/`paxCharged` fields added to their literals: `client/src/__tests__/helpers/fixtures.ts`, `client/src/__tests__/route-picker.test.tsx`, `client/src/__tests__/route-picker-overflow.test.tsx`, `client/src/__tests__/hero-trust.test.tsx`, `client/src/__tests__/transfer-booking-page.test.tsx`, `client/src/__tests__/vehicle-option-card.test.tsx`. This task is NOT done until `pnpm --filter @rg/client typecheck` is clean — add these six files to the Files list below.

**Files:**

- Modify: `client/src/components/home/PopularTransfers.tsx` — remove `.toLowerCase()`; render "per person" for a per-person route's cheapest card instead of the vehicle name.
- Modify: `client/src/components/transfer/VehicleOptionCard.tsx` — new `seatsExceeded`/seat-count prop and visual state (Addition 6).
- Modify: `client/src/pages/public/TransferBookingPage.tsx` — move the passenger-count field above vehicle selection; add `pax` to every `quoteTransfer` query call; pass each vehicle option's `defaultSeats` into `VehicleOptionCard`; checkout-summary "× N pax =" line.
- Modify: `client/src/components/transfer/TransferGuestDetailsForm.tsx` — remove the `pax` input (moved up a level; `luggageCount` stays).
- Modify: `client/src/pages/public/PackageDetailPage.tsx:85`, `client/src/components/home/PackagesSection.tsx:254` — read `pkg.pricingMode` instead of the hardcoded `"per group"`.
- Test: `client/src/__tests__/popular-transfers*.test.tsx` (existing file, name TBD by implementer — grep first), `client/src/__tests__/transfer-booking-page.test.tsx`, `client/src/__tests__/package-detail-page.test.tsx`, `client/src/__tests__/packages-reviews.test.tsx` (or wherever `PackagesSection` is covered — grep first).

- [ ] **Step 1 — PopularTransfers.tsx.** Change `per {cheapest.vehicleTypeName.toLowerCase()}` to: when `cheapest.pricingMode === 'per_person'` render `per person`; otherwise keep today's `per {cheapest.vehicleTypeName}` with its ORIGINAL casing (drop `.toLowerCase()` — Task 6/3A also touches this line; if Task 6 runs first, coordinate so the final line reads correctly once, not twice). Test: a per-vehicle route's card reads "per SUV" (not "per suv"); a per-person route's card reads "per person" regardless of vehicle name.
- [ ] **Step 2 — VehicleOptionCard seat-fit state.** Add a `seatCap: number | null` prop. Compute `const seatsExceeded = seatCap !== null && pax > seatCap;` in the parent (Step 3) and pass a resolved `unavailableReason: string | null` prop instead of recomputing inside the card (keeps this component's existing "never computes money or capacity itself" contract). Render: when `unavailableReason` is set, same disabled visual treatment the existing `unavailable` branch uses (opacity, `cursor-not-allowed`, radio `disabled`), but the text reads the reason verbatim (e.g. `"Seats up to 4"`) instead of "Not available for this route". The radio's `aria-describedby` still points at `detailsId` so the reason is announced. Mobile-first: the reason text sits in the same `text-sm`/`text-muted-foreground` slot the existing states use, so the card's height doesn't jump between states at 360px.
- [ ] **Step 3 — TransferBookingPage.tsx reorder.**
  - Lift `pax` (and `luggageCount`, since it's in the same visual group today) to page-level controlled state: `const [pax, setPax] = useState(1); const [luggageCount, setLuggageCount] = useState(0);`.
  - Render a "Passengers" (+ "Luggage (bags)") input block between the route picker and the vehicle-option cards (see mockup) — same `Input`/`Label` pattern `TransferGuestDetailsForm.tsx` used for these fields, moved up.
  - `TransferGuestDetailsForm.tsx` drops its own `pax`/`PAX_ERROR_ID` input (keeps `luggageCount` if that one stays lower in the plan's mockup — confirm against the mockup: both move up together). Keep its own named-field contract (`PLACED_HOLD_FIELDS` already lists `pax`/`luggageCount` at the page level; since both become controlled state at the page, they must now be added to the submitted `FormData` explicitly on submit, e.g. hidden inputs or by merging `{ pax, luggageCount }` into the payload object built from `FormData` — follow this file's existing `optionalField`/direct-field assembly pattern for `routeId`/`direction`/`vehicleTypeId`, which are already page-state fields merged in the same way).
  - Add `pax` to every `t.checkout.quoteTransfer(...)` call in the `useQueries` block.
  - Add `pax` (and route id/productType, already there) to the `lastGoodQuotes` reset `useEffect`'s dependency array — a stale quote from a different pax count must never be offered as anyone's fallback, mirroring the existing `routeId`/`productType` reset.
  - For each `vehicleOptions[i]`, compute `unavailableReason`: `isLoading` → none (card shows its own skeleton); else if `pax > option.defaultSeats` (when not null) → `` `Seats up to ${option.defaultSeats}` ``; else if `quote === undefined` → `"Not available for this route"` (today's existing message); else `null`. Pass to `VehicleOptionCard`.
  - Checkout summary: once a vehicle is selected and its quote resolved, render `` `${formatPeso(unitPrice)} × ${quote.paxCharged} pax = ${formatPeso(quote.subtotalCentavos)}` `` when `quote.pricingMode === 'per_person'` (unit price read from the selected `vehicleOptions[i].oneWayPriceCentavos`/`dayUsePriceCentavos` depending on `productType`, already on hand); per-vehicle mode shows today's existing summary unchanged.
- [ ] **Step 4 — client tests.**
  - `transfer-booking-page.test.tsx`: passengers field renders above the vehicle cards; changing pax re-fires every vehicle's quote query; a vehicle whose `defaultSeats` is below the typed pax renders disabled with "Seats up to N" and stays in the list (query for the card by test id / role, assert it is present AND disabled — not absent); a per-person route's checkout summary shows the "× N pax =" line with the server's own `paxCharged`/`subtotalCentavos`, never a client-side `unitPrice * pax` computation (grep the diff for any such multiplication and fail the review if found).
  - Break the "stays visible" behaviour first (temporarily filter it out of the rendered list), confirm the test catches the regression, restore.
- [ ] **Step 5 — package pages.** `PackageDetailPage.tsx:85`: `{pkg.pricingMode === 'per_person' ? 'per person' : 'per group'}`. `PackagesSection.tsx:254`: same. Tests: `package-detail-page.test.tsx` / the `PackagesSection` test file — one case per mode, using the fixture helpers in `client/src/__tests__/helpers/fixtures.ts` (add `pricingMode` to the base package fixture there, defaulting to `'per_group'` so every existing test using that fixture keeps passing unchanged).
- [ ] **Step 6 — mobile check.** Confirm the moved passenger/luggage inputs and the vehicle card's new disabled-reason text at 360px: no horizontal scroll, 44px tap targets preserved on the (unchanged) radio control.
- [ ] **Step 7 — run the full client test suite for files touched and commit.**

---

## Task 6 (brief label: 3A–3D) — Independent copy fixes

**One batched implementer dispatch — four small, same-shape string/test edits, each its own commit so they can be reported separately.**

- [ ] **3A** — `client/src/components/home/PopularTransfers.tsx:129`: remove `.toLowerCase()` (already covered by Task 5 Step 1 if that task ran first — if so, this step is "confirm it's already fixed," not a second edit). Keep the admin-entered vehicle name's original casing ("per SUV").
- [ ] **3B** — `client/src/components/home/PopularTransfers.tsx:53`: `"Private van transfers across Cebu"` → `"Private transfers across Cebu"`.
- [ ] **3C** — Footer tagline. First: `grep -rn "Cebu day tours and multi-day packages, booked direct" client/src server/src` to confirm the three known sites (`client/src/lib/site.ts:25`, `server/src/db/seed-data.ts:714`, and `server/src/seo/resolvers.ts:389`'s 404 description uses different wording — adapt, don't copy verbatim: `"This page does not exist. Browse Cebu day tours and multi-day packages on ${BRAND}."` → `"This page does not exist. Browse private airport and island transfers across Cebu on ${BRAND}."`). Change `SITE.tagline` (site.ts:25) and the seed default (seed-data.ts:714) to `'Private airport and island transfers across Cebu, booked direct.'` — these two are pinned equal by `server/src/__tests__/seed-parity.test.ts`, so both must change together or that test fails (which is the point: it proves they're still in sync). **Before editing**, confirm with a read of `client/src/components/layout/SiteFooter.tsx` and `settings.contact.tagline`'s current seeded value whether a STAGING database already has a live `settings.contact.tagline` row (it does, per `insertSettingIfMissing` — base seed is insert-only). State plainly in the task report: editing `seed-data.ts`'s default changes only a FRESH `db:seed` run's inserted value, never an already-seeded database's live row. If the owner wants staging's live footer text changed, the admin field is Settings → Contact → Tagline (owner edits it there; this task does not touch any DB row). Also note in the report: after this change, `siteTagline(true)` and `siteTagline(false)` (`client/src/lib/site.ts`) return the same string — not a bug, just confirm no test currently asserts they differ in a way this would break (grep `site-tagline.test.ts` first).
- [ ] **3D** — `client/src/components/layout/FloatingWhatsApp.tsx:250`: ``const message = showTours ? `Hi ${SITE.name}! I'd like to ask about a Cebu tour.` : `Hi ${SITE.name}! I'd like to ask about a transfer.`;`` (the `showTours` binding already exists in this component at line 225).
- [ ] **Update tests that pin the old strings**: grep each changed literal across `client/src/__tests__` before editing; update every match in the same commit as its source change (no file left referencing a string that no longer exists). Each test must be run red-then-green on its specific assertion, not just "the suite passes."
- [ ] **Four commits** (or one commit per lettered item if the implementer prefers — report each as its own `✅ DONE 3X` regardless of commit granularity).

---

## Final verification (after Task 6)

Run in order, exactly as CLAUDE.md requires: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`. Never report done on an unrun command.

---

## ASCII Mockups

**Admin — Transfer route form (price card section)**

```
┌ Prices per vehicle type ──────────────────────────────────┐
│ Pricing                                                    │
│  (•) Per vehicle      ( ) Per person                        │
│                                                              │
│  Minimum paying passengers   [ 1 ]                          │
│  (used only in "Per person" mode)                           │
│                                                              │
│  Leave both boxes blank for a vehicle type not offered.     │
│                                                              │
│  ┌ Van ──────────────────────────────────────────────────┐ │
│  │ One-way (pesos / vehicle)   Day-use (pesos / vehicle)  │ │
│  │ [ 1500.00          ]        [ 3500.00           ]      │ │
│  └──────────────────────────────────────────────────────── ┘ │
│  ┌ SUV ──────────────────────────────────────────────────┐ │
│  │ One-way (pesos / vehicle)   Day-use (pesos / vehicle)  │ │
│  │ [ 2200.00          ]        [ 4800.00           ]      │ │
│  └──────────────────────────────────────────────────────── ┘ │
└──────────────────────────────────────────────────────────┘

  ↓ admin flips the radio to "Per person":

┌ Prices per vehicle type ──────────────────────────────────┐
│ Pricing                                                    │
│  ( ) Per vehicle      (•) Per person                        │
│                                                              │
│  Minimum paying passengers   [ 2 ]                           │
│                                                              │
│  ┌ Van ──────────────────────────────────────────────────┐ │
│  │ One-way (pesos / person)    Day-use (pesos / person)   │ │
│  │ [ 350.00           ]        [ 650.00            ]      │ │
│  └──────────────────────────────────────────────────────── ┘ │
└──────────────────────────────────────────────────────────┘
```

**Admin — Package form**

```
┌ Add / Edit package ───────────────────────────────────────┐
│ Slug            [ bohol-3d2n                     ]          │
│ Title           [ Bohol Countryside 3D2N          ]         │
│ Days            [ 3 ]                                       │
│ Price now (pesos)   [ 9800.00 ]                              │
│ Was price (pesos)   [ 12500.00 ]                             │
│ Pricing             [ Per group           ▾ ]  ← default for a new package
│                       Per person                             │
│                       Per group                              │
│ ...                                                           │
└──────────────────────────────────────────────────────────┘
```

**Public — Popular transfers card (per-vehicle route, casing fixed)**

```
┌─────────────────────────────┐
│ [ photo ]           Most booked │
│                         45 min  │
├─────────────────────────────┤
│ 🛫 Mactan Airport → Moalboal     │
│ Fixed price, door to door.       │
│ [Van] [SUV]                      │
│ One-way from ₱5,700 per SUV      │   ← was "per suv"
│ [ Book this transfer → ]          │
└─────────────────────────────┘
```

**Public — Popular transfers card (per-person route)**

```
┌─────────────────────────────┐
│ [ photo ]                       │
│                         30 min  │
├─────────────────────────────┤
│ 🛫 Mactan Airport → Oslob         │
│ Shared-style group pricing.       │
│ [Van]                             │
│ One-way from ₱800 per person      │   ← label, not vehicle name
│ [ Book this transfer → ]          │
└─────────────────────────────┘
```

**Public — /transfer booking page (pax moves above vehicle selection; seat-fit shown, not hidden)**

```
1) Transfer type        [One-way] [Day-use]
2) Route                [Mactan Airport → Oslob  ▾]
3) Passengers            [ 5 ]           ← MOVED here (was lower, in guest details)
   Luggage (bags)        [ 2 ]

4) Choose a vehicle
   ┌ Van ─────────────┐   ┌ SUV ─────────────┐
   │ [image]          │   │ [image]  (greyed) │
   │ Van        ●     │   │ SUV               │
   │ ₱800 per person   │   │ Seats up to 4     │  ← disabled, reason shown,
   │ ₱4,000 total       │   │ (not selectable)  │    card stays in the list
   │ ₱1,200 due now     │   │                   │
   └──────────────────┘   └───────────────────┘

5) Checkout summary
   ₱800 × 5 pax = ₱4,000
   30% due now: ₱1,200
```

**Public — Package detail page**

```
3 days / 2 nights
Bohol Countryside 3D2N
  ₱12,500̶   ₱9,800   per group         ← default copy, unchanged from today
```

```
3 days / 2 nights
Bohol Countryside 3D2N (admin switched this one to "Per person")
  ₱12,500̶   ₱9,800   per person        ← reads from pkg.pricingMode, no longer hardcoded
```
