/**
 * The private-transfer route screen — the routes guests can book a vehicle
 * for, and the per-vehicle-type prices each one carries. Rebuilt 2026-11-08
 * (owner decision: flexible places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`) to replace the old
 * "one route per destination, van/SUV" shape with admin-managed places on
 * both ends and an admin-managed, open-ended list of vehicle types.
 *
 * `admin.transferRoutes.*` is `adminProcedure('toursPricing')` server-side —
 * owner only, the same area tours and coupons use — so this screen offers no
 * control a dispatcher or finance role could use. It does not re-check the
 * role itself for enforcement (CLAUDE.md: hiding a button is not access
 * control) but shows the same plain "owner only" denied state every sibling
 * `toursPricing` screen in this tree uses.
 *
 * ## The price card: THE rule to get right on this screen
 *
 * `shared/src/transfers-admin.ts`'s own header spells out the contract: a
 * `prices` object the form posts is read as the COMPLETE price card for the
 * route — every active vehicle type the admin wants offered, keyed by its
 * id, with a key simply ABSENT meaning "not offered" (design note §1.4). A
 * hand-trimmed subset would silently un-offer every type left out of it. So
 * `submit()` below always builds `prices` from EVERY ACTIVE vehicle type
 * (`activeVehicleTypes`, from `admin.vehicleTypes.list`) — a type whose two
 * boxes are both left blank gets an explicit `null` entry (not offered),
 * never an omitted key, and a type the admin never touched on an EDIT still
 * gets its stored price restated in full, because `priceValuesFor()` falls
 * back to the stored card for any type the local state has not overridden.
 *
 * ## Duration: hours + minutes is a UI nicety only
 *
 * `transfer_routes.estimated_duration_minutes` is still stored and sent as a
 * single integer. Splitting it into two number inputs is this screen's own
 * convenience — `totalMinutesFrom()`/`hoursAndMinutesFrom()` are the only two
 * places the conversion happens, both ways.
 *
 * ## Both places come from one reusable combobox
 *
 * `TransferPlaceCombobox` (`components/admin/TransferPlaceCombobox.tsx`) is
 * mounted twice — "From place" and "To place" — and owns its own "+ Add new
 * place" inline create, so this form never has to know how a place is made.
 *
 * ## There is no delete
 *
 * A route is retired with Deactivate, behind the same confirm-then-commit
 * `AdminCouponsPage.tsx` uses for its own soft delete. Deactivating keeps the
 * route on this list, which is the only place to switch it back on.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  transferRouteCreateInputSchema,
  transferRouteUpdateInputSchema,
  type TransferRouteAdminRow,
  type VehicleTypeAdminRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import FormActions from '@/components/admin/FormActions';
import TransferPlaceCombobox from '@/components/admin/TransferPlaceCombobox';
import { exactDuration } from '@/lib/duration-words';
import { centavosToPesosInput, pesosToCentavos } from '@/lib/money-input';
import { firstValidationMessage, splitFieldErrors } from '@/lib/field-errors';
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { trpc } from '@/lib/trpc';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';
const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';
const ROW_ERROR = 'text-brand-gold-800 text-xs font-medium';
const SECTION = 'border-brand-blue-100 rounded-xl border p-4';

const STATUS_BADGE_CLASS: Record<'Active' | 'Inactive', string> = {
  Active: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  Inactive: 'border-0 bg-slate-100 text-brand-ink',
};

/**
 * Owner decision 2026-11-08: sellability depends on BOTH places being
 * active, not one destination — retargeted from the 2026-11-06 rule this
 * label used to describe. Amber, never red (CLAUDE.md), matching
 * `AssignPanel.tsx`'s existing warning styling.
 *
 * A plain `<p>` rather than `<Badge>`: `Badge`'s base class is
 * `whitespace-nowrap` and `w-fit`, which is fine for a one-word status but
 * would force this sentence onto one unbroken line and overflow a 360px
 * phone card — this needs to wrap instead.
 */
const INACTIVE_PLACE_CLASS =
  'mt-2 rounded-[8px] border border-amber-300 bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900';

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeTransferRouteError(error: unknown, fallback: string): string {
  const validation = firstValidationMessage(error);
  if (validation !== null) return validation;
  if (
    error instanceof TRPCClientError &&
    typeof error.data?.httpStatus === 'number' &&
    error.data.httpStatus < 500
  ) {
    return error.message;
  }
  return fallback;
}

/** Is this refusal a role problem (401/403), as opposed to a network or server fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

/* ------------------------------------------------------------------ Wording */

function statusLabel(isActive: boolean): 'Active' | 'Inactive' {
  return isActive ? 'Active' : 'Inactive';
}

/** "2 of 3 vehicle types priced" — the list screen's stand-in for a fixed price table. */
function priceSummaryWords(route: TransferRouteAdminRow): string {
  const total = route.prices.length;
  if (total === 0) return 'No active vehicle types yet';
  const priced = route.prices.filter((p) => p.price !== null).length;
  return `${priced} of ${total} vehicle types priced`;
}

/**
 * "{fromIcon} {fromName} → {toIcon} {toName}" — shared by the mobile card
 * and the desktop table so the two surfaces cannot drift (Task 1C).
 */
function RouteFromTo({ route }: { route: TransferRouteAdminRow }) {
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
}

/** Which of the route's two places are inactive, in words — or `null` when both are active. */
function inactivePlaceWarning(route: TransferRouteAdminRow): string | null {
  const names = [route.fromPlace, route.toPlace].filter((p) => !p.isActive).map((p) => p.name);
  if (names.length === 0) return null;
  const verb = names.length > 1 ? 'are' : 'is';
  return `${names.join(' and ')} ${verb} inactive — hidden from guests`;
}

/* ------------------------------------------------------------------- The form */

/** `hours*60 + minutes`, from the two UI-only inputs. */
function totalMinutesFrom(hours: string, minutes: string): number | null {
  const h = Number(hours.trim() === '' ? '0' : hours.trim());
  const m = Number(minutes.trim() === '' ? '0' : minutes.trim());
  if (!Number.isInteger(h) || h < 0 || !Number.isInteger(m) || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** The inverse, for pre-filling an edit form from the stored total. */
function hoursAndMinutesFrom(totalMinutes: number): { hours: string; minutes: string } {
  return { hours: String(Math.floor(totalMinutes / 60)), minutes: String(totalMinutes % 60) };
}

/** The field names `EntityForm` renders here, for `splitFieldErrors`. */
const TRANSFER_ROUTE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'fromPlaceId',
  'toPlaceId',
  'slug',
  'sortOrder',
  'freeCancelHours',
  'inclusionsText',
  'exclusionsText',
]);

function scalarFields(): EntityFormField[] {
  return [
    {
      name: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      hint: 'Lowercase letters, numbers and hyphens, e.g. mactan-airport.',
    },
    {
      name: 'freeCancelHours',
      label: 'Free cancellation window (hours)',
      type: 'number',
      required: true,
    },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'number',
      hint: 'Lower numbers show first in the list. Leave blank for 0.',
    },
    {
      name: 'inclusionsText',
      label: 'Inclusions',
      type: 'textarea',
      hint: 'What the price includes, e.g. fuel, driver, tolls.',
    },
    {
      name: 'exclusionsText',
      label: 'Exclusions',
      type: 'textarea',
      hint: 'What is not included, e.g. meals.',
    },
  ];
}

function scalarValuesFromRoute(route: TransferRouteAdminRow | null): Record<string, string> {
  if (!route) {
    return {
      slug: '',
      freeCancelHours: '24',
      sortOrder: '0',
      inclusionsText: '',
      exclusionsText: '',
    };
  }
  return {
    slug: route.slug,
    freeCancelHours: String(route.freeCancelHours),
    sortOrder: String(route.sortOrder),
    inclusionsText: route.inclusionsText ?? '',
    exclusionsText: route.exclusionsText ?? '',
  };
}

/** One vehicle type's stored price, in the pesos strings the two boxes show. */
function storedPriceStrings(
  type: VehicleTypeAdminRow,
  route: TransferRouteAdminRow | null,
): { oneWay: string; dayUse: string } {
  const stored = route?.prices.find((p) => p.vehicleTypeId === type.id)?.price ?? null;
  if (!stored) return { oneWay: '', dayUse: '' };
  return {
    oneWay: centavosToPesosInput(stored.oneWayPriceCentavos),
    dayUse: centavosToPesosInput(stored.dayUsePriceCentavos),
  };
}

/**
 * One zod issue's path -> this form's own field/error key, or `null` when
 * the issue has no single-input home (a whole-object `.strict()`/`.refine()`
 * failure) — those are left for the caller to put in a banner instead.
 *
 * `update`'s payload is `{ id, patch: {...} }`, so a patch issue's path
 * starts with `'patch'`; that prefix is stripped before the mapping below.
 */
function formFieldFor(path: readonly PropertyKey[]): string | null {
  const stripped = path[0] === 'patch' ? path.slice(1) : path;
  const [first, second] = stripped;
  if (first === 'prices') {
    return typeof second === 'string' || typeof second === 'number' ? `price_${second}` : null;
  }
  if (first === 'estimatedDurationMinutes') return 'duration';
  const SCALAR = new Set([
    'fromPlaceId',
    'toPlaceId',
    'reverseEnabled',
    'slug',
    'sortOrder',
    'freeCancelHours',
    'inclusionsText',
    'exclusionsText',
  ]);
  return typeof first === 'string' && SCALAR.has(first) ? first : null;
}

/** First zod issue per field, keyed by this form's own field name. */
function fieldErrorsFromIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = formFieldFor(issue.path);
    if (!field || field in out) continue;
    out[field] = issue.message;
  }
  return out;
}

function TransferRouteForm({
  mode,
  initial,
  places,
  activeVehicleTypes,
  vehicleTypesLoading,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: TransferRouteAdminRow | null;
  places: Parameters<typeof TransferPlaceCombobox>[0]['places'];
  activeVehicleTypes: readonly VehicleTypeAdminRow[];
  vehicleTypesLoading: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();

  const [values, setValues] = useState<Record<string, string>>(() =>
    scalarValuesFromRoute(initial),
  );
  const [fromPlaceId, setFromPlaceId] = useState<number | null>(initial?.fromPlace.id ?? null);
  const [toPlaceId, setToPlaceId] = useState<number | null>(initial?.toPlace.id ?? null);
  const [reverseEnabled, setReverseEnabled] = useState<boolean>(initial?.reverseEnabled ?? true);
  const initialDuration = initial ? hoursAndMinutesFrom(initial.estimatedDurationMinutes) : null;
  const [durationHours, setDurationHours] = useState<string>(initialDuration?.hours ?? '');
  const [durationMinutes, setDurationMinutes] = useState<string>(initialDuration?.minutes ?? '0');
  // Keyed by stringified vehicle-type id. A type with NO entry here falls
  // back to its stored price (`storedPriceStrings`) when read — see this
  // file's header. That is what keeps a type correct even if
  // `admin.vehicleTypes.list` resolves after this form has already mounted.
  const [priceOverrides, setPriceOverrides] = useState<
    Record<string, { oneWay: string; dayUse: string }>
  >({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  function priceValuesFor(type: VehicleTypeAdminRow): { oneWay: string; dayUse: string } {
    return priceOverrides[String(type.id)] ?? storedPriceStrings(type, initial);
  }

  function reportSaveError(error: unknown, fallback: string) {
    const validation = splitFieldErrors(error, TRANSFER_ROUTE_FIELD_NAMES);
    if (validation) {
      setErrors(validation.fields);
      setBanner(validation.banner);
      return;
    }
    setBanner(describeTransferRouteError(error, fallback));
  }

  const create = trpc.admin.transferRoutes.create.useMutation({
    onSuccess: () => {
      void utils.admin.transferRoutes.list.invalidate();
      onSaved('Transfer route added.');
    },
    onError: (error) => reportSaveError(error, 'Could not add this transfer route.'),
  });
  const update = trpc.admin.transferRoutes.update.useMutation({
    onSuccess: () => {
      void utils.admin.transferRoutes.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => reportSaveError(error, 'Could not save this transfer route.'),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    setBanner(null);
    const value = (name: string) => (values[name] ?? '').trim();
    const conversionErrors: Record<string, string> = {};

    if (fromPlaceId === null) conversionErrors.fromPlaceId = 'Select a place.';
    if (toPlaceId === null) conversionErrors.toPlaceId = 'Select a place.';

    const totalMinutes = totalMinutesFrom(durationHours, durationMinutes);
    if (totalMinutes === null || totalMinutes < 1) {
      conversionErrors.duration = 'Enter a valid duration — hours 0 or more, minutes 0 to 59.';
    }

    /*
     * THE completeness contract (this file's header). Every ACTIVE vehicle
     * type gets a key, never a hand-trimmed subset — a type whose boxes are
     * both blank gets an explicit `null`, and a type the admin never
     * touched still restates whatever `priceValuesFor` resolves it to
     * (its stored price on an edit, blank on a create).
     */
    const prices: Record<
      string,
      { oneWayPriceCentavos: number; dayUsePriceCentavos: number } | null
    > = {};
    for (const type of activeVehicleTypes) {
      const key = String(type.id);
      const { oneWay, dayUse } = priceValuesFor(type);
      const oneWayRaw = oneWay.trim();
      const dayUseRaw = dayUse.trim();
      if (oneWayRaw === '' && dayUseRaw === '') {
        prices[key] = null;
        continue;
      }
      if (oneWayRaw === '' || dayUseRaw === '') {
        conversionErrors[`price_${key}`] = 'Enter both prices, or leave both blank.';
        continue;
      }
      const oneWayCentavos = pesosToCentavos(oneWayRaw);
      const dayUseCentavos = pesosToCentavos(dayUseRaw);
      if (oneWayCentavos === null || dayUseCentavos === null) {
        conversionErrors[`price_${key}`] = 'Enter a price in pesos, e.g. 1500.00.';
        continue;
      }
      prices[key] = { oneWayPriceCentavos: oneWayCentavos, dayUsePriceCentavos: dayUseCentavos };
    }

    if (Object.keys(conversionErrors).length > 0) {
      setErrors(conversionErrors);
      return;
    }

    const payload = {
      fromPlaceId: fromPlaceId!,
      toPlaceId: toPlaceId!,
      reverseEnabled,
      slug: value('slug'),
      sortOrder: value('sortOrder') === '' ? undefined : Number(value('sortOrder')),
      estimatedDurationMinutes: totalMinutes!,
      freeCancelHours: Number(value('freeCancelHours')),
      inclusionsText: value('inclusionsText') === '' ? null : value('inclusionsText'),
      exclusionsText: value('exclusionsText') === '' ? null : value('exclusionsText'),
      prices,
    };

    const toValidate = mode === 'edit' ? { id: initial!.id, patch: payload } : payload;
    const schema =
      mode === 'edit' ? transferRouteUpdateInputSchema : transferRouteCreateInputSchema;
    const parsed = schema.safeParse(toValidate);
    if (!parsed.success) {
      setErrors(fieldErrorsFromIssues(parsed.error.issues));
      return;
    }

    setErrors({});
    if (mode === 'edit') {
      update.mutate(parsed.data as never);
    } else {
      create.mutate(parsed.data as never);
    }
  }

  return (
    <div className="space-y-4">
      {banner ? (
        <p role="alert" className={ALERT}>
          {banner}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TransferPlaceCombobox
          label="From place"
          places={places}
          value={fromPlaceId}
          onChange={setFromPlaceId}
          error={errors.fromPlaceId}
        />
        <TransferPlaceCombobox
          label="To place"
          places={places}
          value={toPlaceId}
          onChange={setToPlaceId}
          error={errors.toPlaceId}
        />
      </div>

      <label className="tap-target flex items-center gap-2 text-sm" htmlFor="route-reverse-enabled">
        <input
          id="route-reverse-enabled"
          type="checkbox"
          checked={reverseEnabled}
          onChange={(event) => setReverseEnabled(event.target.checked)}
        />
        Also bookable in reverse (same price and duration, the other way)
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="route-duration-hours">Duration — hours</Label>
          <Input
            id="route-duration-hours"
            type="number"
            min={0}
            className={FIELD}
            value={durationHours}
            onChange={(event) => setDurationHours(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="route-duration-minutes">Duration — minutes</Label>
          <Input
            id="route-duration-minutes"
            type="number"
            min={0}
            max={59}
            className={FIELD}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(event.target.value)}
          />
        </div>
      </div>
      {errors.duration ? (
        <p role="alert" className={ROW_ERROR}>
          {errors.duration}
        </p>
      ) : null}

      <EntityForm
        fields={scalarFields()}
        values={values}
        errors={errors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add route'}
        onChange={(name, next) => setValues((current) => ({ ...current, [name]: next }))}
        onSubmit={submit}
        hideSubmit
      />

      <div className={SECTION}>
        <h3 className="text-brand-ink text-sm font-bold">Prices per vehicle type</h3>
        <p className="text-brand-error mt-1 text-xs">
          Leave both boxes blank for a vehicle type not offered on this route.
        </p>
        {vehicleTypesLoading ? (
          <p className="text-brand-error mt-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading vehicle types…
          </p>
        ) : activeVehicleTypes.length === 0 ? (
          <p className="text-brand-error mt-3 text-sm">
            No active vehicle types yet — add one on the Vehicle types screen first.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {activeVehicleTypes.map((type) => {
              const key = String(type.id);
              const current = priceValuesFor(type);
              return (
                <div key={key} className="border-brand-blue-100 rounded-[10px] border p-3">
                  <p className="text-brand-ink text-sm font-semibold">{type.name}</p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <div className="min-w-0 flex-[1_1_160px] space-y-1">
                      <Label htmlFor={`route-price-${key}-oneway`}>One-way (pesos)</Label>
                      <Input
                        id={`route-price-${key}-oneway`}
                        type="text"
                        inputMode="decimal"
                        placeholder="1500.00"
                        className={`${FIELD} w-full`}
                        value={current.oneWay}
                        onChange={(event) =>
                          setPriceOverrides((prev) => ({
                            ...prev,
                            [key]: { ...current, oneWay: event.target.value },
                          }))
                        }
                      />
                    </div>
                    <div className="min-w-0 flex-[1_1_160px] space-y-1">
                      <Label htmlFor={`route-price-${key}-dayuse`}>Day-use (pesos)</Label>
                      <Input
                        id={`route-price-${key}-dayuse`}
                        type="text"
                        inputMode="decimal"
                        placeholder="3500.00"
                        className={`${FIELD} w-full`}
                        value={current.dayUse}
                        onChange={(event) =>
                          setPriceOverrides((prev) => ({
                            ...prev,
                            [key]: { ...current, dayUse: event.target.value },
                          }))
                        }
                      />
                    </div>
                  </div>
                  {errors[`price_${key}`] ? (
                    <p role="alert" className={`${ROW_ERROR} mt-2`}>
                      {errors[`price_${key}`]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <FormActions
        onCancel={onClose}
        saveLabel={mode === 'edit' ? 'Save changes' : 'Add route'}
        pending={pending}
        submitType="button"
        onSave={submit}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Row actions */

/**
 * Edit, and the soft delete behind a two-step confirm — the same shape
 * `AdminCouponsPage.tsx`'s `CouponActions` uses for its own Deactivate.
 */
function RouteActions({ route, onEdit }: { route: TransferRouteAdminRow; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.transferRoutes.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.transferRoutes.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(
        describeTransferRouteError(error, 'Could not change this route. Nothing was changed.'),
      );
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="row" onClick={onEdit}>
        Edit
      </Button>

      {route.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${route.slug}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              type="button"
              variant="row-amber"
              className="whitespace-normal"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: route.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${route.slug}`}
            </Button>
            <Button
              type="button"
              variant="row"
              disabled={setActive.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="row-amber"
            aria-label={`Deactivate ${route.slug}`}
            onClick={() => setConfirming(true)}
          >
            Deactivate
          </Button>
        )
      ) : (
        <Button
          type="button"
          variant="row"
          disabled={setActive.isPending}
          aria-label={`Reactivate ${route.slug}`}
          onClick={() => setActive.mutate({ id: route.id, isActive: true })}
        >
          {setActive.isPending ? 'Reactivating…' : 'Reactivate'}
        </Button>
      )}

      {rowBanner ? (
        <p role="alert" className={`${ALERT} w-full`}>
          {rowBanner}
        </p>
      ) : null}
    </div>
  );
}

/** The same denied markup `AdminCouponsPage.tsx`/`AdminToursPage.tsx` render. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Transfer routes</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can manage transfer routes.
      </p>
      <Link
        to="/admin"
        className="tap-target text-brand-blue-700 hover:text-brand-blue-900 inline-flex items-center text-sm font-semibold underline underline-offset-4 transition-colors"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}

function TransferRoutesAdmin() {
  const list = trpc.admin.transferRoutes.list.useQuery(undefined, { retry: false });
  const placesQuery = trpc.admin.transferPlaces.list.useQuery();
  const vehicleTypesQuery = trpc.admin.vehicleTypes.list.useQuery();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The second denial layer: the ROLE check in `AdminTransferRoutesPage` only
  // catches a session this client already knows is not the owner. A session
  // that LOOKS like an owner to this page but whose `toursPricing` grant the
  // server has since revoked only surfaces here, when the list itself comes
  // back refused.
  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const places = placesQuery.data ?? [];
  const activeVehicleTypes = (vehicleTypesQuery.data ?? []).filter((type) => type.isActive);
  const routes = list.data ?? [];
  const editing = typeof editingId === 'number' ? routes.find((r) => r.id === editingId) : null;

  function closeEditor(message: string) {
    setEditingId(null);
    setNotice(message);
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        eyebrow="Operations"
        title="Transfer routes"
        description="Private transfer routes between two places, and the one-way and day-use prices a guest is charged for each vehicle type. Deactivating a route stops it being bookable and changes nothing about a booking that already took one of its prices."
        action={
          editingId === null ? (
            <Button
              type="button"
              variant="primary-pill"
              onClick={() => {
                setNotice(null);
                setEditingId('new');
              }}
            >
              Add a transfer route
            </Button>
          ) : undefined
        }
      />

      {notice ? (
        <p role="status" className={NOTICE}>
          {notice}
        </p>
      ) : null}

      {editingId === null ? null : (
        <Card className={CARD}>
          <CardHeader>
            <CardTitle className="text-brand-ink text-lg font-bold">
              {editingId === 'new' ? 'Add a transfer route' : 'Edit transfer route'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TransferRouteForm
              key={editingId}
              mode={editingId === 'new' ? 'create' : 'edit'}
              initial={editing ?? null}
              places={places}
              activeVehicleTypes={activeVehicleTypes}
              vehicleTypesLoading={vehicleTypesQuery.isPending}
              onClose={() => setEditingId(null)}
              onSaved={closeEditor}
            />
          </CardContent>
        </Card>
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Routes</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading transfer routes…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the transfer routes. Sign in again, or try once more in a moment.
        </p>
      ) : routes.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No transfer routes yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per route. */}
          <ul className="space-y-3 md:hidden">
            {routes.map((route) => (
              <li key={route.id} className={`${CARD} p-4 text-sm`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 max-w-full">
                    <p className="text-brand-ink max-w-full break-words font-semibold">
                      <RouteFromTo route={route} />
                    </p>
                    <p className="text-brand-error break-all text-xs">{route.slug}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(route.isActive)]}>
                    {statusLabel(route.isActive)}
                  </Badge>
                </div>
                {inactivePlaceWarning(route) ? (
                  <p data-testid="inactive-place-label" className={INACTIVE_PLACE_CLASS}>
                    {inactivePlaceWarning(route)}
                  </p>
                ) : null}
                <p className="text-brand-error mt-2 text-xs">
                  {exactDuration(route.estimatedDurationMinutes)} ·{' '}
                  {route.reverseEnabled ? 'Reverse bookable' : 'One direction only'}
                </p>
                <p className="text-brand-ink mt-1">{priceSummaryWords(route)}</p>
                <div className="mt-3">
                  <RouteActions route={route} onEdit={() => setEditingId(route.id)} />
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="transfer-routes-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Route
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Reverse
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Prices
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr
                    key={route.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-semibold">
                      <span className="block">
                        <RouteFromTo route={route} />
                      </span>
                      <span className="text-brand-error block text-xs">{route.slug}</span>
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      {exactDuration(route.estimatedDurationMinutes)}
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      {route.reverseEnabled ? 'Yes' : 'No'}
                    </td>
                    <td className="text-brand-ink px-4 py-3">{priceSummaryWords(route)}</td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(route.isActive)]}>
                        {statusLabel(route.isActive)}
                      </Badge>
                      {inactivePlaceWarning(route) ? (
                        <p data-testid="inactive-place-label" className={INACTIVE_PLACE_CLASS}>
                          {inactivePlaceWarning(route)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RouteActions route={route} onEdit={() => setEditingId(route.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every
 * `admin.transferRoutes` call from anyone but the owner. This just stops a
 * dispatcher or finance user who types the address from being shown a form
 * that can only be refused. The second denial layer — a refused
 * `admin.transferRoutes.list` this role check did not catch — lives inside
 * `TransferRoutesAdmin`, beside the query it guards.
 */
export default function AdminTransferRoutesPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <TransferRoutesAdmin />;
}
