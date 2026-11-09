/**
 * The vans admin screen (Week 5 plan, Task 5; BUILD_SPEC §9 "Vans" / §5A,
 * client half). `admin.vans.*` (Task 4) already exists and is `owner` /
 * `dispatcher` only server-side — this page offers no control a
 * `vansDrivers`-less role could use, but it does not re-check the role
 * itself; that refusal is the server's (CLAUDE.md: hiding a button is not
 * access control).
 *
 * ## One schema, two consumers
 *
 * Both the "Add a van" and "Edit van" forms validate with the exact
 * `vanInputSchema` the server imports from `@rg/shared` — the same rule
 * Week 3's Q10 established for phone numbers. A client that accepted a
 * plate the server would reject would be a form that cannot be submitted
 * and does not say why.
 *
 * ## No optimistic update
 *
 * A duplicate plate is a real, common failure on this screen (two people
 * typing the same plate into two tabs, or a typo matching an existing
 * van). An optimistic row that then has to vanish is worse than a short
 * wait for the real list — so every mutation here waits for the server and
 * then invalidates `admin.vans.list`, never writes to the cache itself.
 *
 * ## The empty-patch rule
 *
 * `admin.vans.update`'s patch must contain at least one field — a no-op
 * patch is a validation error by design on the server (it used to write an
 * audit row for a change that never happened). So `submitEdit` below diffs
 * the parsed form values against the van being edited and only calls
 * `update.mutate` when that diff is non-empty; an unchanged form shows a
 * neutral notice and never reaches the network.
 *
 * ## The duplicate-plate path
 *
 * `create`/`update` throw `CONFLICT` with a human sentence when the plate
 * already exists. That is surfaced on the plate field itself (wired
 * through `EntityForm`'s `errors` map), not as a bare toast — it is the
 * most common real failure here, and a banner that does not point at the
 * field that caused it makes the admin go hunting.
 *
 * ## Status
 *
 * `on_trip` is derived from trips, never set by hand (§9) — so the status
 * control only offers `available`, `parked` and `for_repair`, and is
 * hidden entirely (leaving just the badge) while a van is `on_trip`. Every
 * status renders as text inside its badge; colour is reinforcement, never
 * the only signal, and `for_repair` is amber, never red.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { vanInputSchema, type VanInput, type VanRow } from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import FormActions from '@/components/admin/FormActions';
import { firstValidationMessage, splitFieldErrors } from '@/lib/field-errors';
import { trpc } from '@/lib/trpc';

/**
 * The three statuses a human may set. `on_trip` is deliberately absent —
 * see the module note. Server-authoritative `VAN_STATUSES` lives in
 * `server/src/db/schema.ts`; `@rg/shared` does not re-export it (`VanRow`'s
 * own doc comment), so this short, settable-only subset is kept here.
 */
const SETTABLE_STATUSES = ['available', 'parked', 'for_repair'] as const;
type SettableStatus = (typeof SETTABLE_STATUSES)[number];

const STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  on_trip: 'On trip',
  parked: 'Parked',
  for_repair: 'For repair',
};

/** Amber for `for_repair`, never red — text always renders too (no-colour-alone). */
const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 mb-4 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';

const STATUS_BADGE_CLASS: Record<string, string> = {
  available: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  on_trip: 'border-0 bg-brand-blue-100 text-brand-blue-900',
  parked: 'border-0 bg-slate-100 text-brand-ink',
  for_repair: 'border-0 bg-brand-gold-100 text-brand-gold-800',
};

/**
 * `vehicleTypeId` is built per-render from the live `admin.vehicleTypes.list`
 * (owner decision 2026-11-08: vehicle types are an admin-managed list, not a
 * `van`/`suv` enum) — every OTHER field is static, so only this one varies.
 * Inactive types are left out of the options: a retired type is not a valid
 * choice for a NEW van, the same reasoning `transferRoutes.list` applies to
 * an inactive vehicle type's price (`AdminTransferRoutesPage.tsx`). An
 * existing van already pointed at a since-deactivated type still shows that
 * type's name as a disabled-looking extra option, so editing a van's OTHER
 * fields is never blocked by a type that is no longer offered.
 */
function vanFields(
  activeTypes: readonly { id: number; name: string }[],
  currentTypeId: { id: number; name: string } | null,
): EntityFormField[] {
  const options = activeTypes.map((type) => ({ value: String(type.id), label: type.name }));
  const hasCurrent = currentTypeId !== null && activeTypes.some((t) => t.id === currentTypeId.id);
  const vehicleTypeOptions =
    currentTypeId !== null && !hasCurrent
      ? [...options, { value: String(currentTypeId.id), label: `${currentTypeId.name} (inactive)` }]
      : options;

  return [
    { name: 'plate', label: 'Plate', type: 'text', required: true },
    { name: 'model', label: 'Model', type: 'text', required: true },
    { name: 'capacity', label: 'Seats for guests', type: 'number', required: true },
    {
      name: 'luggageCapacity',
      label: 'Luggage capacity (bags)',
      type: 'number',
      hint: "Leave blank if it hasn't been measured yet.",
    },
    {
      name: 'vehicleTypeId',
      label: 'Vehicle type',
      type: 'select',
      required: true,
      options: vehicleTypeOptions,
    },
    {
      name: 'odometer',
      label: 'Odometer (km)',
      type: 'number',
      hint: "Leave blank if you don't know it.",
    },
    { name: 'lastService', label: 'Last service', type: 'date' },
    { name: 'nextService', label: 'Next service due', type: 'date' },
    { name: 'orcrExpiry', label: 'OR/CR expiry', type: 'date' },
    { name: 'franchiseNo', label: 'Franchise number', type: 'text' },
    { name: 'franchiseExpiry', label: 'Franchise expiry', type: 'date' },
    { name: 'repairNotes', label: 'Repair notes', type: 'textarea', hint: 'Only shown to staff.' },
  ];
}

/**
 * Static metadata for every `vanFields()` row — everything but
 * `vehicleTypeId`'s dynamic `options`, which depends on the live vehicle-
 * types list and so cannot be read from a plain constant. Used for the
 * empty-values map and for `errorsFromParse`'s "is this field required"
 * lookup, which needs to know that without re-deriving `vanFields()` (and
 * therefore the vehicle-types list) just to answer it.
 */
const VAN_FIELD_META: Record<string, { label: string; required?: boolean }> = {
  plate: { label: 'Plate', required: true },
  model: { label: 'Model', required: true },
  capacity: { label: 'Seats for guests', required: true },
  luggageCapacity: { label: 'Luggage capacity (bags)' },
  vehicleTypeId: { label: 'Vehicle type', required: true },
  odometer: { label: 'Odometer (km)' },
  lastService: { label: 'Last service' },
  nextService: { label: 'Next service due' },
  orcrExpiry: { label: 'OR/CR expiry' },
  franchiseNo: { label: 'Franchise number' },
  franchiseExpiry: { label: 'Franchise expiry' },
  repairNotes: { label: 'Repair notes' },
};

/** The field names every `vanFields()` call renders, for `splitFieldErrors`. */
const VAN_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(VAN_FIELD_META));

const EMPTY_VALUES: Record<string, string> = Object.fromEntries(
  Array.from(VAN_FIELD_NAMES, (name) => [name, '']),
);

/** The typed-but-unparsed shape `vanInputSchema` expects, built from the form's strings. */
function rawFromValues(values: Record<string, string>) {
  return {
    plate: values.plate ?? '',
    model: values.model ?? '',
    capacity:
      values.capacity === '' || values.capacity === undefined ? NaN : Number(values.capacity),
    /*
     * Blank ↔ `null`, a typed number ↔ that number — `odometer`'s own
     * nullable-number shape, copied rather than re-invented. Note the test
     * reads the form's STRING, so a typed `0` survives (`!'0'` is false) and
     * lands as `0`: `vanInputSchema` allows `.min(0)` on purpose, because a
     * vehicle that carries no luggage at all is a fact worth recording and
     * is the opposite of NULL's "not measured yet" — the one value that
     * makes the dispatch soft-check skip its luggage half.
     */
    luggageCapacity: !values.luggageCapacity ? null : Number(values.luggageCapacity),
    vehicleTypeId:
      values.vehicleTypeId === '' || values.vehicleTypeId === undefined
        ? NaN
        : Number(values.vehicleTypeId),
    odometer: !values.odometer ? null : Number(values.odometer),
    lastService: values.lastService || null,
    nextService: values.nextService || null,
    orcrExpiry: values.orcrExpiry || null,
    franchiseNo: values.franchiseNo || null,
    franchiseExpiry: values.franchiseExpiry || null,
    repairNotes: values.repairNotes || null,
  };
}

/** A van row's typed fields, as the strings `EntityForm` wants to display. */
function valuesFromRow(row: VanRow): Record<string, string> {
  return {
    plate: row.plate,
    model: row.model,
    capacity: String(row.capacity),
    luggageCapacity: row.luggageCapacity === null ? '' : String(row.luggageCapacity),
    vehicleTypeId: String(row.vehicleTypeId),
    odometer: row.odometer === null ? '' : String(row.odometer),
    lastService: row.lastService ?? '',
    nextService: row.nextService ?? '',
    orcrExpiry: row.orcrExpiry ?? '',
    franchiseNo: row.franchiseNo ?? '',
    franchiseExpiry: row.franchiseExpiry ?? '',
    repairNotes: row.repairNotes ?? '',
  };
}

/**
 * The first issue per field, keyed by field name — what `EntityForm.errors`
 * wants. A required field left empty gets its own plain "X is required."
 * message rather than zod's own wording: zod v4's default `min()` message
 * ("Too small: expected string to have >=3 characters") is correct but
 * does not read like a form error for a blank field, and an empty plate is
 * the single most common way this form gets submitted wrong. Anything
 * else — a value that is present but still invalid — keeps zod's message.
 */
function errorsFromParse(
  values: Record<string, string>,
  result: ReturnType<typeof vanInputSchema.safeParse>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (result.success) return out;
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!key || key in out) continue;
    const field = VAN_FIELD_META[key];
    const isEmpty = !values[key] || values[key]!.trim() === '';
    out[key] = field?.required && isEmpty ? `${field.label} is required.` : issue.message;
  }
  return out;
}

/** Only the keys that actually changed from `original` — the empty-patch rule. */
function buildPatch(next: VanInput, original: VanRow): Partial<VanInput> {
  const patch: Partial<VanInput> = {};
  if (next.plate !== original.plate) patch.plate = next.plate;
  if (next.model !== original.model) patch.model = next.model;
  if (next.capacity !== original.capacity) patch.capacity = next.capacity;
  if (next.luggageCapacity !== original.luggageCapacity)
    patch.luggageCapacity = next.luggageCapacity;
  if (next.vehicleTypeId !== original.vehicleTypeId) patch.vehicleTypeId = next.vehicleTypeId;
  if (next.odometer !== original.odometer) patch.odometer = next.odometer;
  if (next.lastService !== original.lastService) patch.lastService = next.lastService;
  if (next.nextService !== original.nextService) patch.nextService = next.nextService;
  if (next.orcrExpiry !== original.orcrExpiry) patch.orcrExpiry = next.orcrExpiry;
  if (next.franchiseNo !== original.franchiseNo) patch.franchiseNo = next.franchiseNo;
  if (next.franchiseExpiry !== original.franchiseExpiry)
    patch.franchiseExpiry = next.franchiseExpiry;
  if (next.repairNotes !== original.repairNotes) patch.repairNotes = next.repairNotes;
  return patch;
}

/** Any refusal under 500 carries the server's own human sentence; anything else is generic. */
function describeVanError(error: unknown): string {
  /*
   * Task A4. An input-validation failure's `message` is tRPC's own default
   * for a `ZodError` — `JSON.stringify(issues, null, 2)` — so returning it
   * here put a JSON blob in the banner. The schema's own sentence is what a
   * human can act on; the per-field messages go to `createErrors`/`editErrors`
   * in `onError` besides.
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
  return 'Something went wrong saving this van. Please try again.';
}

function StatusCell({
  van,
  onSetStatus,
  pending,
}: {
  van: VanRow;
  onSetStatus: (id: number, status: SettableStatus) => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className={STATUS_BADGE_CLASS[van.status] ?? 'text-brand-ink border-0 bg-slate-100'}>
        {STATUS_LABELS[van.status] ?? van.status}
      </Badge>
      {van.status === 'on_trip' ? null : (
        // Deliberately uncontrolled-looking: `value` always stays `''` so
        // `SelectValue` shows the "Change status" placeholder rather than
        // mirroring the current status a second time — the badge above is
        // the one place that status text lives. Each list only offers the
        // OTHER two settable statuses, since re-picking the current one is
        // a no-op write. `on_trip` itself is never offered (§9: derived
        // from trips, never set by hand).
        <Select
          value=""
          onValueChange={(value) => onSetStatus(van.id, value as SettableStatus)}
          disabled={pending}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Change status for ${van.plate}`}
            className="tap-target border-brand-blue-200 rounded-[10px] bg-white"
          >
            <SelectValue placeholder="Change status" />
          </SelectTrigger>
          <SelectContent>
            {SETTABLE_STATUSES.filter((value) => value !== van.status).map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export default function AdminVansPage() {
  const utils = trpc.useUtils();
  const list = trpc.admin.vans.list.useQuery(undefined, { retry: false });
  const vehicleTypesQuery = trpc.admin.vehicleTypes.list.useQuery();
  const activeVehicleTypes = (vehicleTypesQuery.data ?? []).filter((type) => type.isActive);

  const [createValues, setCreateValues] = useState<Record<string, string>>(EMPTY_VALUES);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [createBanner, setCreateBanner] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  const [editingVan, setEditingVan] = useState<VanRow | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>(EMPTY_VALUES);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [editBanner, setEditBanner] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  const create = trpc.admin.vans.create.useMutation({
    onSuccess: () => {
      void utils.admin.vans.list.invalidate();
      setCreateValues(EMPTY_VALUES);
      setCreateErrors({});
      setCreateBanner(null);
      setCreateNotice('Van added.');
    },
    onError: (error) => {
      setCreateNotice(null);
      const validation = splitFieldErrors(error, VAN_FIELD_NAMES);
      if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
        setCreateErrors((current) => ({ ...current, plate: error.message }));
        setCreateBanner(null);
      } else if (validation) {
        setCreateErrors((current) => ({ ...current, ...validation.fields }));
        setCreateBanner(validation.banner);
      } else {
        setCreateBanner(describeVanError(error));
      }
    },
  });

  const update = trpc.admin.vans.update.useMutation({
    onSuccess: () => {
      void utils.admin.vans.list.invalidate();
      setEditingVan(null);
      setEditErrors({});
      setEditBanner(null);
      setEditNotice(null);
    },
    onError: (error) => {
      setEditNotice(null);
      const validation = splitFieldErrors(error, VAN_FIELD_NAMES);
      if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
        setEditErrors((current) => ({ ...current, plate: error.message }));
        setEditBanner(null);
      } else if (validation) {
        setEditErrors((current) => ({ ...current, ...validation.fields }));
        setEditBanner(validation.banner);
      } else {
        setEditBanner(describeVanError(error));
      }
    },
  });

  const setStatus = trpc.admin.vans.setStatus.useMutation({
    onSuccess: () => void utils.admin.vans.list.invalidate(),
  });

  function submitCreate() {
    setCreateNotice(null);
    setCreateBanner(null);
    const parsed = vanInputSchema.safeParse(rawFromValues(createValues));
    if (!parsed.success) {
      setCreateErrors(errorsFromParse(createValues, parsed));
      return;
    }
    setCreateErrors({});
    create.mutate(parsed.data);
  }

  function startEdit(row: VanRow) {
    setEditingVan(row);
    setEditValues(valuesFromRow(row));
    setEditErrors({});
    setEditBanner(null);
    setEditNotice(null);
  }

  function submitEdit() {
    if (!editingVan) return;
    setEditNotice(null);
    setEditBanner(null);
    const parsed = vanInputSchema.safeParse(rawFromValues(editValues));
    if (!parsed.success) {
      setEditErrors(errorsFromParse(editValues, parsed));
      return;
    }
    const patch = buildPatch(parsed.data, editingVan);
    if (Object.keys(patch).length === 0) {
      setEditErrors({});
      setEditNotice('No changes to save.');
      return;
    }
    setEditErrors({});
    update.mutate({ id: editingVan.id, patch });
  }

  const vans = list.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/*
       * No `action`: the "Add a van" form below is always rendered (never
       * toggled behind an "Add" button), so its own `EntityForm` Save
       * button is already this page's one primary pill — a header action
       * here would be a second one in the same region.
       */}
      <AdminPageHeader
        eyebrow="Operations"
        title="Vans"
        description={
          'The fleet. Plate, model and seats are what every other screen needs; service dates, papers and repair notes live behind "More details".'
        }
      />

      <Card className={CARD}>
        <CardHeader>
          <CardTitle className="text-brand-ink text-lg font-bold">Add a van</CardTitle>
        </CardHeader>
        <CardContent>
          {createNotice ? (
            <p role="status" className={NOTICE}>
              {createNotice}
            </p>
          ) : null}
          {createBanner ? (
            <p role="alert" className={`${ALERT} mb-4`}>
              {createBanner}
            </p>
          ) : null}
          <EntityForm
            fields={vanFields(activeVehicleTypes, null)}
            values={createValues}
            errors={createErrors}
            pending={create.isPending}
            submitLabel="Add van"
            onChange={(name, value) =>
              setCreateValues((current) => ({ ...current, [name]: value }))
            }
            onSubmit={submitCreate}
          />
        </CardContent>
      </Card>

      {editingVan ? (
        <Card className={CARD}>
          <CardHeader>
            <CardTitle className="text-brand-ink text-lg font-bold">
              Edit {editingVan.plate}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {editNotice ? (
              <p role="status" className={NOTICE}>
                {editNotice}
              </p>
            ) : null}
            {editBanner ? (
              <p role="alert" className={`${ALERT} mb-4`}>
                {editBanner}
              </p>
            ) : null}
            <EntityForm
              fields={vanFields(
                activeVehicleTypes,
                editingVan
                  ? { id: editingVan.vehicleTypeId, name: editingVan.vehicleTypeName }
                  : null,
              )}
              values={editValues}
              errors={editErrors}
              pending={update.isPending}
              submitLabel="Save changes"
              onChange={(name, value) =>
                setEditValues((current) => ({ ...current, [name]: value }))
              }
              onSubmit={submitEdit}
              hideSubmit
            />
            <FormActions
              onCancel={() => setEditingVan(null)}
              saveLabel="Save changes"
              pending={update.isPending}
              submitType="button"
              onSave={submitEdit}
            />
          </CardContent>
        </Card>
      ) : null}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Fleet</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading vans…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the fleet. Sign in again, or try once more in a moment.
        </p>
      ) : vans.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No vans yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per van. */}
          <ul className="space-y-3 md:hidden">
            {vans.map((van) => (
              <li key={van.id} className={`${CARD} p-4 text-sm`}>
                <p className="text-brand-ink font-mono font-semibold">{van.plate}</p>
                <p className="text-brand-error">
                  {van.model} · {van.capacity} seats · {van.vehicleTypeName}
                </p>
                <div className="mt-2">
                  <StatusCell
                    van={van}
                    onSetStatus={(id, status) => setStatus.mutate({ id, status })}
                    pending={setStatus.isPending}
                  />
                </div>
                <div className="mt-3">
                  <Button type="button" variant="row" onClick={() => startEdit(van)}>
                    Edit
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="vans-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Plate
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Model
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Seats
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Type
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
                {vans.map((van) => (
                  <tr
                    key={van.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-mono font-semibold">
                      {van.plate}
                    </td>
                    <td className="text-brand-ink px-4 py-3">{van.model}</td>
                    <td className="text-brand-ink px-4 py-3 tabular-nums">{van.capacity}</td>
                    <td className="px-4 py-3">
                      <Badge className="bg-brand-blue-50 text-brand-blue-800 border-0">
                        {van.vehicleTypeName}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <StatusCell
                        van={van}
                        onSetStatus={(id, status) => setStatus.mutate({ id, status })}
                        pending={setStatus.isPending}
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button type="button" variant="row" onClick={() => startEdit(van)}>
                        Edit
                      </Button>
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
