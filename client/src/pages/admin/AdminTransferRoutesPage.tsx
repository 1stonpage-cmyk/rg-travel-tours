/**
 * The private-transfer route screen — the routes guests can book a van or SUV
 * for, and the per-vehicle-type prices each one carries (transfers-launch
 * plan, Task T4; Architecture §1 and §5).
 *
 * `admin.transferRoutes.*` is `adminProcedure('toursPricing')` server-side —
 * owner only, the same area tours and coupons use — so this screen offers no
 * control a dispatcher or finance role could use. It does not re-check the
 * role itself for enforcement (CLAUDE.md: hiding a button is not access
 * control) but, the same shape `AdminToursPage.tsx` and `AdminCouponsPage.tsx`
 * use, it shows a plain "owner only" denied state rather than a blank page or
 * raw data, from either of the two places a non-owner could reach it: the
 * role this session already knows (`staffAuth.me`), and a refused
 * `admin.transferRoutes.list` call (a stale session, or a role that changed
 * mid-visit).
 *
 * ## Form layout: `EntityForm`, flattened — not a bespoke section
 *
 * `prices` is the one genuinely nested piece of this input (`{ van: { ... },
 * suv: { ... } }`), and `EntityForm` has no concept of a nested object field.
 * Rather than inventing a bespoke price-card section the way
 * `AdminToursPage.tsx` did for its REPEATING arrays (price tiers, images,
 * itinerary, add-ons), this screen flattens the price card to four scalar
 * fields at the form layer — `vanOneWayPesos`, `vanDayUsePesos`,
 * `suvOneWayPesos`, `suvDayUsePesos` — and reassembles the nested `prices`
 * object when the mutation is called. That is the same move
 * `AdminCouponsPage.tsx` already makes for its own single money field
 * (`discountValue`, converted to `percentBp`/`amountCentavos` at the submit
 * boundary): a bespoke section earns its keep only when there is a REPEATING
 * structure to add/remove rows from, and a fixed two-by-two price card is not
 * that — it is four named numbers, which `EntityForm`'s flat field list
 * already renders and labels for free.
 *
 * ## Money
 *
 * Every price is typed in pesos and converted to integer centavos at the
 * form boundary (`lib/money-input.ts`, `pesosToCentavos`) — the server never
 * sees a float or a peso string (CLAUDE.md, "Money"). The four price fields
 * stay in the flat, always-visible part of the form (not behind "More
 * details") because a route with the wrong price is the one mistake this
 * screen exists to prevent.
 *
 * ## There is no delete
 *
 * A route is retired with Deactivate, behind the same confirm-then-commit
 * `AdminCouponsPage.tsx` uses for its own soft delete, and the word "Delete"
 * appears nowhere — the server has no delete mutation either
 * (`server/src/routers/admin/transfer-routes.ts`). Deactivating keeps the
 * route on this list, which is the only place to switch it back on.
 *
 * ## The duplicate-destination/slug `CONFLICT`
 *
 * The server's own `DUPLICATE_TRANSFER_ROUTE_MESSAGE` deliberately names BOTH
 * possibilities in one sentence ("that destination, or that slug") rather
 * than trying to tell them apart — it cannot, without parsing mysql2's own
 * error text (see `services/transfers/upsert-route.ts`). So, exactly as
 * `AdminCouponsPage.tsx` shows its own ambiguous duplicate-code `CONFLICT` as
 * a banner rather than guessing which single field to blame, this screen does
 * the same: the server's sentence renders in the alert banner above the form,
 * not pinned to one of the two fields it cannot itself distinguish between.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  formatPeso,
  transferRouteCreateInputSchema,
  transferRouteUpdateInputSchema,
  type TransferRouteAdminRow,
  type VehicleType,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import { centavosToPesosInput, pesosToCentavos } from '@/lib/money-input';
import { firstValidationMessage, splitFieldErrors } from '@/lib/field-errors';
import { trpc } from '@/lib/trpc';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';
const PRIMARY_BUTTON =
  'tap-target bg-brand-blue-700 hover:bg-brand-blue-800 rounded-[10px] font-semibold text-white transition-colors';
const OUTLINE_BUTTON =
  'tap-target border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 hover:text-brand-blue-800 rounded-[10px] font-semibold transition-colors';

const STATUS_BADGE_CLASS: Record<'Active' | 'Inactive', string> = {
  Active: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  Inactive: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeTransferRouteError(error: unknown, fallback: string): string {
  /*
   * Task A4's rule, same as every other admin screen: an input-validation
   * failure's `message` is tRPC's own default for a `ZodError` — a raw JSON
   * blob — so returning it here would put that blob in the banner. The
   * schema's own sentence is the thing a human can act on; the per-field
   * messages go to the form's `errors` map in `onError` besides.
   */
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

/** "₱1,500.00 one-way · ₱2,800.00 day-use", or a flag for a missing price row. */
function priceWords(row: TransferRouteAdminRow, vehicleType: VehicleType): string {
  const price = row.prices[vehicleType];
  if (!price) return 'Price missing';
  return `${formatPeso(price.oneWayPriceCentavos)} one-way · ${formatPeso(price.dayUsePriceCentavos)} day-use`;
}

function durationWords(minutes: number): string {
  return `${minutes} min`;
}

/* ------------------------------------------------------------------- The form */

interface DestinationOption {
  id: number;
  name: string;
}

/** The field names `EntityForm` renders here, for `splitFieldErrors` (task A4). */
const TRANSFER_ROUTE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'destinationId',
  'slug',
  'sortOrder',
  'estimatedDurationMinutes',
  'freeCancelHours',
  'inclusionsText',
  'exclusionsText',
  'vanOneWayPesos',
  'vanDayUsePesos',
  'suvOneWayPesos',
  'suvDayUsePesos',
]);

/** Scalar field names recognised at depth 1 — everything but the price card. */
const SCALAR_FIELD_NAMES: ReadonlySet<string> = new Set([
  'destinationId',
  'slug',
  'sortOrder',
  'estimatedDurationMinutes',
  'freeCancelHours',
  'inclusionsText',
  'exclusionsText',
]);

/** `prices.<vehicleType>.<column>` (as a dot path) -> this form's flat field name. */
const PRICE_FIELD_BY_PATH: Record<string, string> = {
  'van.oneWayPriceCentavos': 'vanOneWayPesos',
  'van.dayUsePriceCentavos': 'vanDayUsePesos',
  'suv.oneWayPriceCentavos': 'suvOneWayPesos',
  'suv.dayUsePriceCentavos': 'suvDayUsePesos',
};

/**
 * One zod issue's path -> this form's own field name, or `null` when the
 * issue has no single-input home (a whole-object `.strict()`/`.refine()`
 * failure, say) — those are left for the caller to put in a banner instead.
 *
 * `update`'s payload is `{ id, patch: {...} }`, so a patch issue's path
 * starts with `'patch'`; that prefix is stripped before the same mapping
 * `create`'s flat payload uses is applied.
 */
function formFieldFor(path: readonly PropertyKey[]): string | null {
  const stripped = path[0] === 'patch' ? path.slice(1) : path;
  const [first, ...rest] = stripped;
  if (first === 'prices') {
    return PRICE_FIELD_BY_PATH[rest.join('.')] ?? null;
  }
  return typeof first === 'string' && SCALAR_FIELD_NAMES.has(first) ? first : null;
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

function scalarFields(destinations: readonly DestinationOption[]): EntityFormField[] {
  return [
    {
      name: 'destinationId',
      label: 'Destination',
      type: 'select',
      required: true,
      options: destinations.map((d) => ({ value: String(d.id), label: d.name })),
    },
    {
      name: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      hint: 'Lowercase letters, numbers and hyphens, e.g. mactan-airport.',
    },
    {
      name: 'estimatedDurationMinutes',
      label: 'Estimated duration (minutes)',
      type: 'number',
      required: true,
    },
    {
      name: 'freeCancelHours',
      label: 'Free cancellation window (hours)',
      type: 'number',
      required: true,
    },
    {
      name: 'vanOneWayPesos',
      label: 'Van — one-way price (pesos)',
      type: 'text',
      required: true,
      hint: 'e.g. 1500.00',
    },
    {
      name: 'vanDayUsePesos',
      label: 'Van — day-use price (pesos)',
      type: 'text',
      required: true,
      hint: 'e.g. 3500.00',
    },
    {
      name: 'suvOneWayPesos',
      label: 'SUV — one-way price (pesos)',
      type: 'text',
      required: true,
      hint: 'e.g. 1800.00',
    },
    {
      name: 'suvDayUsePesos',
      label: 'SUV — day-use price (pesos)',
      type: 'text',
      required: true,
      hint: 'e.g. 4000.00',
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
      destinationId: '',
      slug: '',
      estimatedDurationMinutes: '',
      freeCancelHours: '',
      vanOneWayPesos: '',
      vanDayUsePesos: '',
      suvOneWayPesos: '',
      suvDayUsePesos: '',
      sortOrder: '0',
      inclusionsText: '',
      exclusionsText: '',
    };
  }
  return {
    destinationId: String(route.destinationId),
    slug: route.slug,
    estimatedDurationMinutes: String(route.estimatedDurationMinutes),
    freeCancelHours: String(route.freeCancelHours),
    vanOneWayPesos: route.prices.van
      ? centavosToPesosInput(route.prices.van.oneWayPriceCentavos)
      : '',
    vanDayUsePesos: route.prices.van
      ? centavosToPesosInput(route.prices.van.dayUsePriceCentavos)
      : '',
    suvOneWayPesos: route.prices.suv
      ? centavosToPesosInput(route.prices.suv.oneWayPriceCentavos)
      : '',
    suvDayUsePesos: route.prices.suv
      ? centavosToPesosInput(route.prices.suv.dayUsePriceCentavos)
      : '',
    sortOrder: String(route.sortOrder),
    inclusionsText: route.inclusionsText ?? '',
    exclusionsText: route.exclusionsText ?? '',
  };
}

function TransferRouteForm({
  mode,
  initial,
  destinations,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: TransferRouteAdminRow | null;
  destinations: readonly DestinationOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();

  const [values, setValues] = useState<Record<string, string>>(() =>
    scalarValuesFromRoute(initial),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  /*
   * Task A4. A validation refusal's messages go to the inputs they name;
   * the ambiguous duplicate-destination/slug `CONFLICT` (no `zodError` at
   * all) falls through `splitFieldErrors` to the banner — see this file's
   * header for why that is the right place for it, not a guess at one field.
   */
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

    /*
     * The money line (CLAUDE.md, "Money"; constraints, "entered in pesos,
     * converted to centavos ... never the reverse"). Every peso string goes
     * through the same `pesosToCentavos` helper `AdminCouponsPage.tsx` and
     * `AdminToursPage.tsx` already use, so a bad or blank price is a field
     * error here rather than a silently wrong number reaching the mutation.
     */
    const vanOneWay = pesosToCentavos(value('vanOneWayPesos'));
    const vanDayUse = pesosToCentavos(value('vanDayUsePesos'));
    const suvOneWay = pesosToCentavos(value('suvOneWayPesos'));
    const suvDayUse = pesosToCentavos(value('suvDayUsePesos'));

    const conversionErrors: Record<string, string> = {};
    if (vanOneWay === null)
      conversionErrors.vanOneWayPesos = 'Enter a price in pesos, e.g. 1500.00.';
    if (vanDayUse === null)
      conversionErrors.vanDayUsePesos = 'Enter a price in pesos, e.g. 3500.00.';
    if (suvOneWay === null)
      conversionErrors.suvOneWayPesos = 'Enter a price in pesos, e.g. 1800.00.';
    if (suvDayUse === null)
      conversionErrors.suvDayUsePesos = 'Enter a price in pesos, e.g. 4000.00.';
    if (Object.keys(conversionErrors).length > 0) {
      setErrors(conversionErrors);
      return;
    }

    const patch = {
      destinationId: Number(value('destinationId')),
      slug: value('slug'),
      sortOrder: Number(value('sortOrder') || '0'),
      estimatedDurationMinutes: Number(value('estimatedDurationMinutes')),
      freeCancelHours: Number(value('freeCancelHours')),
      inclusionsText: value('inclusionsText') === '' ? null : value('inclusionsText'),
      exclusionsText: value('exclusionsText') === '' ? null : value('exclusionsText'),
      prices: {
        van: { oneWayPriceCentavos: vanOneWay!, dayUsePriceCentavos: vanDayUse! },
        suv: { oneWayPriceCentavos: suvOneWay!, dayUsePriceCentavos: suvDayUse! },
      },
    };

    const toValidate = mode === 'edit' ? { id: initial!.id, patch } : patch;
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

      <EntityForm
        fields={scalarFields(destinations)}
        values={values}
        errors={errors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add route'}
        onChange={(name, next) => setValues((current) => ({ ...current, [name]: next }))}
        onSubmit={submit}
      />

      <Button
        type="button"
        variant="outline"
        disabled={pending}
        className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
        onClick={onClose}
      >
        Cancel
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ Row actions */

/**
 * Edit, and the soft delete behind a two-step confirm — the same shape
 * `AdminCouponsPage.tsx`'s `CouponActions` uses for its own Deactivate.
 *
 * The confirm names the route's slug, because a list of destinations is easy
 * to misread, and it says "Deactivate" rather than "Delete" because that is
 * what the server does — nothing is removed, and the route's prices stand.
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
      <Button type="button" variant="outline" size="sm" className={OUTLINE_BUTTON} onClick={onEdit}>
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
              size="sm"
              className={`${PRIMARY_BUTTON} whitespace-normal`}
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: route.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${route.slug}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={OUTLINE_BUTTON}
              disabled={setActive.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={OUTLINE_BUTTON}
            aria-label={`Deactivate ${route.slug}`}
            onClick={() => setConfirming(true)}
          >
            Deactivate
          </Button>
        )
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={OUTLINE_BUTTON}
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
  const destinationsQuery = trpc.destinations.list.useQuery();
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

  const destinations: DestinationOption[] = (destinationsQuery.data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
  }));
  const routes = list.data ?? [];
  const editing = typeof editingId === 'number' ? routes.find((r) => r.id === editingId) : null;

  function closeEditor(message: string) {
    setEditingId(null);
    setNotice(message);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Operations
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Transfer routes</h1>
        <p className="text-brand-error text-sm">
          Private van/SUV transfer routes and the one-way and day-use prices a guest is charged for
          each. Deactivating a route stops it being bookable and changes nothing about a booking
          that already took one of its prices.
        </p>
      </header>

      {notice ? (
        <p role="status" className={NOTICE}>
          {notice}
        </p>
      ) : null}

      {editingId === null ? (
        <Button
          type="button"
          className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
          onClick={() => {
            setNotice(null);
            setEditingId('new');
          }}
        >
          Add a transfer route
        </Button>
      ) : (
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
              destinations={destinations}
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
                    <p className="text-brand-ink max-w-full break-all font-semibold">
                      {route.destinationName}
                    </p>
                    <p className="text-brand-error break-all text-xs">{route.slug}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(route.isActive)]}>
                    {statusLabel(route.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-error mt-2 text-xs">
                  {durationWords(route.estimatedDurationMinutes)}
                </p>
                <p className="text-brand-ink mt-1">Van: {priceWords(route, 'van')}</p>
                <p className="text-brand-ink">SUV: {priceWords(route, 'suv')}</p>
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
                    Destination
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Van
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    SUV
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
                      <span className="block">{route.destinationName}</span>
                      <span className="text-brand-error block text-xs">{route.slug}</span>
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      {durationWords(route.estimatedDurationMinutes)}
                    </td>
                    <td className="text-brand-ink px-4 py-3">{priceWords(route, 'van')}</td>
                    <td className="text-brand-ink px-4 py-3">{priceWords(route, 'suv')}</td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(route.isActive)]}>
                        {statusLabel(route.isActive)}
                      </Badge>
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
