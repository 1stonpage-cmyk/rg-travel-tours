/**
 * The transfer-places admin screen (owner decision 2026-11-08: flexible
 * places/routes/vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`). A "place" is
 * anything a transfer route runs between — an airport, a pier, a town —
 * which used to be hard-coded as "the airport, and an existing tour
 * destination." This screen is what lets an owner grow that list directly.
 *
 * `admin.transferPlaces.*` is `adminProcedure('toursPricing')` server-side —
 * owner only, the same area tours, coupons, transfer routes and vehicle
 * types already use — so this screen offers no control a dispatcher or
 * finance role could use. It does not re-check the role itself for
 * enforcement (CLAUDE.md: hiding a button is not access control) but shows
 * the same plain "owner only" denied state every sibling `toursPricing`
 * screen in this tree uses.
 *
 * ## The destination cross-link is informational only
 *
 * `destinationId` is an optional pointer at an existing tour destination —
 * useful for a future "see the Moalboal page" link, never consulted by
 * sellability, pricing or capacity (design note §1.2). The dropdown is
 * sourced from the PUBLIC `destinations.list` (active destinations only),
 * the same source `AdminTransferRoutesPage.tsx` already uses for its own
 * destination picker — there is no admin-only destinations list in this
 * codebase to prefer instead.
 *
 * ## There is no delete
 *
 * A place is retired with Deactivate, the same confirm-then-commit every
 * other `toursPricing` screen uses. `transfer_routes.from_place_id`/
 * `.to_place_id` are RESTRICT foreign keys, so a hard delete could never
 * have worked once any route referenced a place — soft delete is the only
 * option, and the server has no delete mutation either.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  transferPlaceCreateInputSchema,
  transferPlaceUpdateInputSchema,
  type TransferPlaceAdminListRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import FormActions from '@/components/admin/FormActions';
import { firstValidationMessage, splitFieldErrors } from '@/lib/field-errors';
import { trpc } from '@/lib/trpc';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';

const STATUS_BADGE_CLASS: Record<'Active' | 'Inactive', string> = {
  Active: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  Inactive: 'border-0 bg-slate-100 text-brand-ink',
};

/** No value means "none" — the only option besides a real destination id. */
const NO_DESTINATION_VALUE = '__none__';

function describeTransferPlaceError(error: unknown, fallback: string): string {
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

function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

function statusLabel(isActive: boolean): 'Active' | 'Inactive' {
  return isActive ? 'Active' : 'Inactive';
}

interface DestinationOption {
  id: number;
  name: string;
}

function destinationWords(
  destinationId: number | null,
  destinations: readonly DestinationOption[],
): string {
  if (destinationId === null) return 'No linked destination';
  const match = destinations.find((d) => d.id === destinationId);
  return match ? `Linked to ${match.name}` : 'Linked destination (retired)';
}

/* ------------------------------------------------------------------- The form */

const TRANSFER_PLACE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'name',
  'isAirport',
  'destinationId',
  'sortOrder',
]);

function scalarFields(destinations: readonly DestinationOption[]): EntityFormField[] {
  return [
    {
      name: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      hint: 'e.g. Mactan-Cebu International Airport.',
    },
    {
      name: 'isAirport',
      label: 'Is an airport',
      type: 'select',
      required: true,
      options: [
        { value: 'false', label: 'No' },
        { value: 'true', label: 'Yes' },
      ],
    },
    {
      name: 'destinationId',
      label: 'Linked destination (optional)',
      type: 'select',
      options: [
        { value: NO_DESTINATION_VALUE, label: 'None' },
        ...destinations.map((d) => ({ value: String(d.id), label: d.name })),
      ],
      hint: 'Informational only — never used to decide pricing or availability.',
    },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'number',
      hint: 'Lower numbers show first in the list. Leave blank for 0.',
    },
  ];
}

function valuesFromPlace(place: TransferPlaceAdminListRow | null): Record<string, string> {
  if (!place) {
    return {
      name: '',
      isAirport: 'false',
      destinationId: NO_DESTINATION_VALUE,
      sortOrder: '0',
    };
  }
  return {
    name: place.name,
    isAirport: String(place.isAirport),
    destinationId:
      place.destinationId === null ? NO_DESTINATION_VALUE : String(place.destinationId),
    sortOrder: String(place.sortOrder),
  };
}

function fieldErrorsFromIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const stripped = issue.path[0] === 'patch' ? issue.path[1] : issue.path[0];
    const key = typeof stripped === 'string' ? stripped : null;
    if (!key || !TRANSFER_PLACE_FIELD_NAMES.has(key) || key in out) continue;
    out[key] = issue.message;
  }
  return out;
}

function TransferPlaceForm({
  mode,
  initial,
  destinations,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: TransferPlaceAdminListRow | null;
  destinations: readonly DestinationOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Record<string, string>>(() => valuesFromPlace(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  function reportSaveError(error: unknown, fallback: string) {
    const validation = splitFieldErrors(error, TRANSFER_PLACE_FIELD_NAMES);
    if (validation) {
      setErrors(validation.fields);
      setBanner(validation.banner);
      return;
    }
    setBanner(describeTransferPlaceError(error, fallback));
  }

  const create = trpc.admin.transferPlaces.create.useMutation({
    onSuccess: () => {
      void utils.admin.transferPlaces.list.invalidate();
      onSaved('Transfer place added.');
    },
    onError: (error) => reportSaveError(error, 'Could not add this transfer place.'),
  });
  const update = trpc.admin.transferPlaces.update.useMutation({
    onSuccess: () => {
      void utils.admin.transferPlaces.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => reportSaveError(error, 'Could not save this transfer place.'),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    setBanner(null);
    const value = (name: string) => (values[name] ?? '').trim();

    const destinationRaw = value('destinationId');
    const payload = {
      name: value('name'),
      isAirport: value('isAirport') === 'true',
      destinationId:
        destinationRaw === NO_DESTINATION_VALUE || destinationRaw === ''
          ? null
          : Number(destinationRaw),
      sortOrder: value('sortOrder') === '' ? undefined : Number(value('sortOrder')),
    };

    const toValidate = mode === 'edit' ? { id: initial!.id, patch: payload } : payload;
    const schema =
      mode === 'edit' ? transferPlaceUpdateInputSchema : transferPlaceCreateInputSchema;
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
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add place'}
        onChange={(name, next) => setValues((current) => ({ ...current, [name]: next }))}
        onSubmit={submit}
        hideSubmit
      />

      <FormActions
        onCancel={onClose}
        saveLabel={mode === 'edit' ? 'Save changes' : 'Add place'}
        pending={pending}
        submitType="button"
        onSave={submit}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Row actions */

function PlaceActions({ place, onEdit }: { place: TransferPlaceAdminListRow; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.transferPlaces.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.transferPlaces.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(
        describeTransferPlaceError(error, 'Could not change this place. Nothing was changed.'),
      );
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="row" onClick={onEdit}>
        Edit
      </Button>

      {place.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${place.name}`}
            className="flex flex-wrap items-center gap-2"
          >
            {/*
             * BUG FIX (same shape as AdminVehicleTypesPage's destructive-
             * confirm fix): this was a solid blue `PRIMARY_BUTTON` for an
             * actual destructive confirm, contradicting owner decision 1
             * ("Deactivate = amber outline pill. Never red").
             */}
            <Button
              type="button"
              variant="row-amber"
              className="whitespace-normal"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: place.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${place.name}`}
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
            aria-label={`Deactivate ${place.name}`}
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
          aria-label={`Reactivate ${place.name}`}
          onClick={() => setActive.mutate({ id: place.id, isActive: true })}
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

function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Transfer places</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can manage transfer places.
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

function TransferPlacesAdmin() {
  const list = trpc.admin.transferPlaces.list.useQuery(undefined, { retry: false });
  const destinationsQuery = trpc.destinations.list.useQuery();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const destinations: DestinationOption[] = (destinationsQuery.data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
  }));
  const places = list.data ?? [];
  const editing = typeof editingId === 'number' ? places.find((p) => p.id === editingId) : null;

  function closeEditor(message: string) {
    setEditingId(null);
    setNotice(message);
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        eyebrow="Operations"
        title="Transfer places"
        description="Every pickup and drop-off point a transfer route can run between — airports, piers, towns. Deactivating a place stops any route it is part of being sellable, and changes nothing a route or a booking already has."
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
              Add a transfer place
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
              {editingId === 'new' ? 'Add a transfer place' : 'Edit transfer place'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TransferPlaceForm
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

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Places</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading transfer places…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the transfer places. Sign in again, or try once more in a moment.
        </p>
      ) : places.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No transfer places yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per place. */}
          <ul className="space-y-3 md:hidden">
            {places.map((place) => (
              <li key={place.id} className={`${CARD} p-4 text-sm`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 max-w-full">
                    <p className="text-brand-ink max-w-full break-all font-semibold">
                      {place.name}
                    </p>
                    <p className="text-brand-error text-xs">
                      {place.isAirport ? 'Airport' : 'Not an airport'}
                    </p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(place.isActive)]}>
                    {statusLabel(place.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-ink mt-2">
                  {destinationWords(place.destinationId, destinations)}
                </p>
                <div className="mt-3">
                  <PlaceActions place={place} onEdit={() => setEditingId(place.id)} />
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="transfer-places-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Airport
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Linked destination
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
                {places.map((place) => (
                  <tr
                    key={place.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-semibold">{place.name}</td>
                    <td className="text-brand-ink px-4 py-3">{place.isAirport ? 'Yes' : 'No'}</td>
                    <td className="text-brand-ink px-4 py-3">
                      {destinationWords(place.destinationId, destinations)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(place.isActive)]}>
                        {statusLabel(place.isActive)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PlaceActions place={place} onEdit={() => setEditingId(place.id)} />
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
 * `admin.transferPlaces` call from anyone but the owner. This just stops a
 * dispatcher or finance user who types the address from being shown a form
 * that can only be refused. The second denial layer — a refused
 * `admin.transferPlaces.list` this role check did not catch — lives inside
 * `TransferPlacesAdmin`, beside the query it guards.
 */
export default function AdminTransferPlacesPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <TransferPlacesAdmin />;
}
