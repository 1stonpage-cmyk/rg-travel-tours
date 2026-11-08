/**
 * The vehicle-types admin screen (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). `van`/`suv` used
 * to be a hard-coded two-member enum; this screen is what lets an owner grow
 * that list — add an "MPV", retire one nobody books any more — without a
 * code change.
 *
 * `admin.vehicleTypes.*` is `adminProcedure('toursPricing')` server-side —
 * owner only, the same area tours, coupons and transfer routes already use
 * — so this screen offers no control a dispatcher or finance role could use.
 * It does not re-check the role itself for enforcement (CLAUDE.md: hiding a
 * button is not access control) but, the same shape every other
 * `toursPricing` screen in this tree uses, it shows a plain "owner only"
 * denied state rather than a blank page or raw data, from either of the two
 * places a non-owner could reach it: the role this session already knows
 * (`staffAuth.me`), and a refused `admin.vehicleTypes.list` call (a stale
 * session, or a role that changed mid-visit).
 *
 * ## `defaultSeats`/`defaultLuggage` are prefill only
 *
 * Neither number feeds capacity or dispatch — a van's own `capacity`/
 * `luggageCapacity` stay authoritative (`AdminVansPage.tsx`). They exist so
 * the "Add a van" form can suggest a starting number once a type is picked,
 * which is a later task's job; this screen only collects and shows them.
 * Both are nullable, and blank means "no default yet" rather than zero.
 *
 * ## There is no delete
 *
 * A vehicle type is retired with Deactivate, behind the same confirm-then-
 * commit `AdminCouponsPage.tsx`/`AdminTransferRoutesPage.tsx` use, and the
 * word "Delete" appears nowhere — the server has no delete mutation either
 * (vans, bookings and transfer-route prices all reference this table with a
 * RESTRICT foreign key, so a hard delete could never have worked anyway).
 * Deactivating keeps the type on this list, which is the only place to
 * switch it back on, and does not touch any van, booking or route that
 * already uses it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  vehicleTypeCreateInputSchema,
  vehicleTypeUpdateInputSchema,
  type VehicleTypeAdminRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
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
function describeVehicleTypeError(error: unknown, fallback: string): string {
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

function statusLabel(isActive: boolean): 'Active' | 'Inactive' {
  return isActive ? 'Active' : 'Inactive';
}

/** "10 seats" / "Not set yet", for the fleet-prefill numbers. */
function seatsWords(seats: number | null): string {
  return seats === null ? 'No seat default yet' : `${seats} seats by default`;
}

function luggageWords(luggage: number | null): string {
  return luggage === null ? 'No luggage default yet' : `${luggage} bags by default`;
}

/* ------------------------------------------------------------------- The form */

const VEHICLE_TYPE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'name',
  'slug',
  'defaultSeats',
  'defaultLuggage',
  'sortOrder',
]);

const VEHICLE_TYPE_FIELDS: readonly EntityFormField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, hint: 'e.g. Van, SUV, MPV.' },
  {
    name: 'slug',
    label: 'Slug',
    type: 'text',
    required: true,
    hint: 'Lowercase letters, numbers and hyphens, e.g. mini-van.',
  },
  {
    name: 'defaultSeats',
    label: 'Default seats',
    type: 'number',
    hint: 'Pre-fills the "Add a van" form only — a van’s own seat count always wins.',
  },
  {
    name: 'defaultLuggage',
    label: 'Default luggage (bags)',
    type: 'number',
    hint: 'Pre-fills the "Add a van" form only — a van’s own luggage capacity always wins.',
  },
  {
    name: 'sortOrder',
    label: 'Sort order',
    type: 'number',
    hint: 'Lower numbers show first in the list. Leave blank for 0.',
  },
];

function valuesFromType(type: VehicleTypeAdminRow | null): Record<string, string> {
  if (!type) {
    return { name: '', slug: '', defaultSeats: '', defaultLuggage: '', sortOrder: '0' };
  }
  return {
    name: type.name,
    slug: type.slug,
    defaultSeats: type.defaultSeats === null ? '' : String(type.defaultSeats),
    defaultLuggage: type.defaultLuggage === null ? '' : String(type.defaultLuggage),
    sortOrder: String(type.sortOrder),
  };
}

/** First zod issue per field, keyed by this form's own field name. */
function fieldErrorsFromIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const stripped = issue.path[0] === 'patch' ? issue.path[1] : issue.path[0];
    const key = typeof stripped === 'string' ? stripped : null;
    if (!key || !VEHICLE_TYPE_FIELD_NAMES.has(key) || key in out) continue;
    out[key] = issue.message;
  }
  return out;
}

function VehicleTypeForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: VehicleTypeAdminRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Record<string, string>>(() => valuesFromType(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  function reportSaveError(error: unknown, fallback: string) {
    const validation = splitFieldErrors(error, VEHICLE_TYPE_FIELD_NAMES);
    if (validation) {
      setErrors(validation.fields);
      setBanner(validation.banner);
      return;
    }
    setBanner(describeVehicleTypeError(error, fallback));
  }

  const create = trpc.admin.vehicleTypes.create.useMutation({
    onSuccess: () => {
      void utils.admin.vehicleTypes.list.invalidate();
      onSaved('Vehicle type added.');
    },
    onError: (error) => reportSaveError(error, 'Could not add this vehicle type.'),
  });
  const update = trpc.admin.vehicleTypes.update.useMutation({
    onSuccess: () => {
      void utils.admin.vehicleTypes.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => reportSaveError(error, 'Could not save this vehicle type.'),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    setBanner(null);
    const value = (name: string) => (values[name] ?? '').trim();

    const payload = {
      name: value('name'),
      slug: value('slug'),
      defaultSeats: value('defaultSeats') === '' ? null : Number(value('defaultSeats')),
      defaultLuggage: value('defaultLuggage') === '' ? null : Number(value('defaultLuggage')),
      sortOrder: value('sortOrder') === '' ? undefined : Number(value('sortOrder')),
    };

    const toValidate = mode === 'edit' ? { id: initial!.id, patch: payload } : payload;
    const schema = mode === 'edit' ? vehicleTypeUpdateInputSchema : vehicleTypeCreateInputSchema;
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
        fields={VEHICLE_TYPE_FIELDS}
        values={values}
        errors={errors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add vehicle type'}
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

function TypeActions({ type, onEdit }: { type: VehicleTypeAdminRow; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.vehicleTypes.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.vehicleTypes.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(
        describeVehicleTypeError(error, 'Could not change this vehicle type. Nothing was changed.'),
      );
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" className={OUTLINE_BUTTON} onClick={onEdit}>
        Edit
      </Button>

      {type.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${type.name}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              type="button"
              size="sm"
              className={`${PRIMARY_BUTTON} whitespace-normal`}
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: type.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${type.name}`}
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
            aria-label={`Deactivate ${type.name}`}
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
          aria-label={`Reactivate ${type.name}`}
          onClick={() => setActive.mutate({ id: type.id, isActive: true })}
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

/** The same denied markup every other `toursPricing` screen renders. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Vehicle types</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can manage vehicle types.
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

function VehicleTypesAdmin() {
  const list = trpc.admin.vehicleTypes.list.useQuery(undefined, { retry: false });
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const types = list.data ?? [];
  const editing = typeof editingId === 'number' ? types.find((t) => t.id === editingId) : null;

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
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Vehicle types</h1>
        <p className="text-brand-error text-sm">
          The kinds of vehicle a van can be, and a transfer route can be priced for. Deactivating a
          type stops it being offered to new vans or new route prices, and changes nothing a van or
          a booking already has.
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
          Add a vehicle type
        </Button>
      ) : (
        <Card className={CARD}>
          <CardHeader>
            <CardTitle className="text-brand-ink text-lg font-bold">
              {editingId === 'new' ? 'Add a vehicle type' : 'Edit vehicle type'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <VehicleTypeForm
              key={editingId}
              mode={editingId === 'new' ? 'create' : 'edit'}
              initial={editing ?? null}
              onClose={() => setEditingId(null)}
              onSaved={closeEditor}
            />
          </CardContent>
        </Card>
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Types</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading vehicle types…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the vehicle types. Sign in again, or try once more in a moment.
        </p>
      ) : types.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No vehicle types yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per type. */}
          <ul className="space-y-3 md:hidden">
            {types.map((type) => (
              <li key={type.id} className={`${CARD} p-4 text-sm`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 max-w-full">
                    <p className="text-brand-ink max-w-full break-all font-semibold">{type.name}</p>
                    <p className="text-brand-error break-all text-xs">{type.slug}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(type.isActive)]}>
                    {statusLabel(type.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-ink mt-2">{seatsWords(type.defaultSeats)}</p>
                <p className="text-brand-ink">{luggageWords(type.defaultLuggage)}</p>
                <div className="mt-3">
                  <TypeActions type={type} onEdit={() => setEditingId(type.id)} />
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="vehicle-types-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Default seats
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Default luggage
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
                {types.map((type) => (
                  <tr
                    key={type.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-semibold">
                      <span className="block">{type.name}</span>
                      <span className="text-brand-error block text-xs">{type.slug}</span>
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      {type.defaultSeats === null ? '—' : type.defaultSeats}
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      {type.defaultLuggage === null ? '—' : type.defaultLuggage}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(type.isActive)]}>
                        {statusLabel(type.isActive)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <TypeActions type={type} onEdit={() => setEditingId(type.id)} />
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
 * `admin.vehicleTypes` call from anyone but the owner. This just stops a
 * dispatcher or finance user who types the address from being shown a form
 * that can only be refused. The second denial layer — a refused
 * `admin.vehicleTypes.list` this role check did not catch — lives inside
 * `VehicleTypesAdmin`, beside the query it guards.
 */
export default function AdminVehicleTypesPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <VehicleTypesAdmin />;
}
