/**
 * The drivers admin screen (Week 5 plan, Task 7; BUILD_SPEC §9 "Drivers" /
 * §5B, client half). `admin.drivers.*` (Task 6) already exists and is
 * `vansDrivers`-gated (owner/dispatcher, never finance) server-side; this
 * page offers no control a less-privileged role could use, but — same
 * discipline as `AdminVansPage.tsx` — it does not re-check the role itself.
 * Hiding a button is not access control; that refusal is the server's.
 *
 * ## The whole design problem on this screen
 *
 * `resetPin` (and `create`, which also mints a PIN because `pin_hash` is
 * `NOT NULL`) returns the new six-digit PIN exactly once, in the mutation's
 * response. It is never in `list`, never in an audit row, never logged —
 * this screen is the only place it is ever visible. `pinPanel` below is
 * local state, not server state, and it is cleared on THREE triggers:
 * Dismiss, any OTHER mutation succeeding (a PIN left on screen while the
 * dispatcher does something else is a credential sitting in a shared
 * office), and a route change (the `useLocation` effect). `create` and
 * `resetPin` themselves REPLACE the panel with their own fresh reveal
 * rather than clearing it — same panel, same once-only contract, per the
 * brief's instruction not to build a second mechanism.
 *
 * The reset itself is a two-step inline confirm, not a modal (no `dialog`
 * is vendored, and adding one is out of scope): "Reset PIN" becomes a
 * button literally labelled `Reset PIN for ${name}?`, which doubles as
 * both the question and the confirm action, plus a separate Cancel. It is
 * `brand-blue` (the default `Button` variant), never a destructive-looking
 * colour — there is no red anywhere in this project, and a reset is a
 * correction a dispatcher makes routinely, not a one-way deletion.
 *
 * ## Deactivating a driver (Week 6.5, D4)
 *
 * "Deactivate" signs the driver out of the driver portal on the spot
 * (`admin.drivers.setActive` deletes their sessions in the same transaction
 * as the write), so it gets the same inline two-step confirm as the PIN
 * reset — still no modal — and the confirm says plainly what it does,
 * because a dispatcher who taps it mid-shift has just cut someone off from
 * the job in their hand. Focus moves to Cancel when the confirm opens, so
 * a stray Enter keeps the driver signed in: the safe answer is the default
 * one. The confirm is amber, never red.
 *
 * "Reactivate" has NO confirm: it is the undo, it signs nobody out and
 * restores nothing but the roster, and putting a question in front of the
 * correction would make the mistake harder to fix than to make. The driver
 * signs in again with their PIN; their old sessions stay gone.
 *
 * The server's answer is the source of truth for the badge: the page
 * invalidates `list` and renders what comes back, so a refused call
 * (finance, an expired session) leaves the card exactly as it was and shows
 * the reason in an amber banner rather than flipping optimistically.
 *
 * ## Leaves — now a real, server-sourced list (fix round 1, 2026-10-14)
 *
 * The first version of this page could not fetch a driver's leaves at all
 * (Task 6 shipped `addLeave` / `removeLeave` with no way to read one back),
 * so it kept a client-only cache seeded from this session's own mutations.
 * That was worse than a display gap: `removeLeave` took a leave id the
 * client had no way to obtain, and `addLeave`'s overlap refusal named no
 * row the dispatcher could see. The controller's fix added `leaves` to
 * `DriverRow` (`shared/src/dispatch.ts`) and to `admin.drivers.list`'s
 * response (one grouped query, soonest first, past leaves included) — so
 * this page now reads `driver.leaves` straight off the query result. There
 * is no local cache and no test-only seam: every leave shown here, and
 * every id `removeLeave` is called with, came from the server.
 *
 * ## No lockout state shown
 *
 * `list`'s projection has no lockout columns either (by Task 6's own
 * design), so this screen cannot show "locked out" truthfully and does not
 * try to. The PIN panel still says a reset clears any lockout — that is a
 * true statement about what the action DOES, not a fabricated prior-state
 * badge, so it does not run afoul of "never convey meaning by colour
 * alone" or invented state.
 *
 * ## Personal data
 *
 * Phone, licence number and emergency contact are shown on every driver's
 * card — RA 10173 personal data that belongs on this admin screen and
 * nowhere else; there is no public or portal surface that renders any of
 * it.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  driverInputSchema,
  driverLeaveInputSchema,
  driverAvailability,
  manilaCivilDate,
  type DriverInput,
  type DriverRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import { trpc } from '@/lib/trpc';

const DRIVER_STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  on_trip: 'On trip',
  off_duty: 'Off duty',
};

/** Status is always rendered as text too — colour is reinforcement only. */
const DRIVER_STATUS_BADGE_CLASS: Record<string, string> = {
  available: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  on_trip: 'border-0 bg-brand-blue-100 text-brand-blue-900',
  off_duty: 'border-0 bg-muted text-foreground',
};

const DRIVER_FIELDS: readonly EntityFormField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  {
    name: 'code',
    label: 'Driver code',
    type: 'text',
    required: true,
    hint: 'What the driver types to sign in.',
  },
  { name: 'phone', label: 'Phone', type: 'text', required: true },
  { name: 'licenseNo', label: 'Licence number', type: 'text' },
  { name: 'licenseExpiry', label: 'Licence expiry', type: 'date' },
  {
    name: 'languages',
    label: 'Languages',
    type: 'text',
    hint: 'Comma-separated, e.g. English, Cebuano.',
  },
  {
    name: 'emergencyContact',
    label: 'Emergency contact',
    type: 'text',
    hint: 'Name and phone number.',
  },
];

const LEAVE_FIELDS: readonly EntityFormField[] = [
  { name: 'startDate', label: 'Start date', type: 'date', required: true },
  { name: 'endDate', label: 'End date', type: 'date', required: true },
  { name: 'reason', label: 'Reason', type: 'textarea' },
];

const EMPTY_DRIVER_VALUES: Record<string, string> = Object.fromEntries(
  DRIVER_FIELDS.map((field) => [field.name, '']),
);

/** Today, in Asia/Manila — a leave form that validates the moment it opens. */
function defaultLeaveValues(): Record<string, string> {
  const today = manilaCivilDate(new Date());
  return { startDate: today, endDate: today, reason: '' };
}

/** The typed-but-unparsed shape `driverInputSchema` expects. */
function rawDriverFromValues(values: Record<string, string>) {
  const languagesText = (values.languages ?? '').trim();
  const languages = languagesText
    ? languagesText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : null;
  return {
    name: values.name ?? '',
    code: values.code ?? '',
    phone: values.phone ?? '',
    licenseNo: values.licenseNo || null,
    licenseExpiry: values.licenseExpiry || null,
    languages,
    emergencyContact: values.emergencyContact || null,
  };
}

/** A driver row's typed fields, as the strings `EntityForm` wants to display. */
function valuesFromDriverRow(row: DriverRow): Record<string, string> {
  return {
    name: row.name,
    code: row.code,
    phone: row.phone,
    licenseNo: row.licenseNo ?? '',
    licenseExpiry: row.licenseExpiry ?? '',
    languages: row.languages ? row.languages.join(', ') : '',
    emergencyContact: row.emergencyContact ?? '',
  };
}

/** Only the keys that actually changed — the empty-patch rule (`AdminVansPage.tsx`). */
function buildDriverPatch(next: DriverInput, original: DriverRow): Partial<DriverInput> {
  const patch: Partial<DriverInput> = {};
  if (next.name !== original.name) patch.name = next.name;
  if (next.code !== original.code) patch.code = next.code;
  if (next.phone !== original.phone) patch.phone = next.phone;
  if (next.licenseNo !== original.licenseNo) patch.licenseNo = next.licenseNo;
  if (next.licenseExpiry !== original.licenseExpiry) patch.licenseExpiry = next.licenseExpiry;
  if (JSON.stringify(next.languages) !== JSON.stringify(original.languages)) {
    patch.languages = next.languages;
  }
  if (next.emergencyContact !== original.emergencyContact) {
    patch.emergencyContact = next.emergencyContact;
  }
  return patch;
}

/** The first issue per field, keyed by field name — what `EntityForm.errors` wants. */
function fieldErrors(
  values: Record<string, string>,
  fields: readonly EntityFormField[],
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
): Record<string, string> {
  const out: Record<string, string> = {};
  if (result.success || !result.error) return out;
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!key || key in out) continue;
    const field = fields.find((candidate) => candidate.name === key);
    const isEmpty = !values[key] || values[key]!.trim() === '';
    out[key] = field?.required && isEmpty ? `${field.label} is required.` : issue.message;
  }
  return out;
}

/** The server's own sentence when there is one — same technique as `AdminBookingDetailPage.tsx`. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * `'2026-11-10'` → `'10 Nov 2026'`. Reformats the civil-date STRING directly
 * rather than building a `Date` and relying on `toLocaleDateString` — a
 * locale/ICU-dependent day/month ORDER is exactly the ambiguity this format
 * exists to avoid, so the order is spelled out by hand instead.
 */
function formatCivilDate(civilDate: string): string {
  const [year, month, day] = civilDate.split('-').map(Number);
  const name = MONTHS_SHORT[(month ?? 1) - 1] ?? '';
  return `${day} ${name} ${year}`;
}

interface LeaveFormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  banner: string | null;
}

function freshLeaveFormState(): LeaveFormState {
  return { values: defaultLeaveValues(), errors: {}, banner: null };
}

/** Everything about one driver's personal data — RA 10173, this screen only. */
function DriverPersonalData({ driver }: { driver: DriverRow }) {
  return (
    <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Phone</dt>
        <dd>{driver.phone}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Licence</dt>
        <dd>
          {driver.licenseNo ?? '—'}
          {driver.licenseExpiry ? ` (expires ${formatCivilDate(driver.licenseExpiry)})` : ''}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Languages</dt>
        <dd>
          {driver.languages && driver.languages.length > 0 ? driver.languages.join(', ') : '—'}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Emergency contact</dt>
        <dd>{driver.emergencyContact ?? '—'}</dd>
      </div>
    </dl>
  );
}

/**
 * BUILD_SPEC §9's roster state — `active / on leave (with date ranges) /
 * inactive` — which the database does not store (controller fix,
 * 2026-10-14). `driverAvailability()` derives it from `is_active` plus the
 * leave rows `admin.drivers.list` now returns.
 *
 * It renders BESIDE `drivers.status`, not instead of it, because the two
 * answer different questions: this one is "are they on the roster today",
 * `status` is "what are they doing right now" (`available` / `on_trip` /
 * `off_duty`). Collapsing them would lose one.
 *
 * Why this exists at all: `is_active` was fetched and never shown, so a
 * soft-deleted driver looked identical to a working one — and soft-delete is
 * the ONLY way a driver is ever removed (`CLAUDE.md`: never hard-delete),
 * which made the one state that matters invisible.
 *
 * Text in every case, never colour alone. Amber for on-leave, neutral grey
 * for inactive, and no red anywhere.
 */
/**
 * §9's "average rating", DERIVED and shown only when it means something
 * (owner-decided 2026-10-15).
 *
 * The server sends `rating: null` below `DRIVER_RATING_MIN_RATINGS`, and
 * this renders WORDS for that case rather than a number. No zero, no dash,
 * no "4.0 (1 review)": anything numeric on screen is read as a measurement,
 * and one five from a guest's good mood is not one.
 *
 * The count travels with the average on purpose — "4.3 from 7 ratings" is a
 * claim a dispatcher can weigh, and "4.3" alone is not.
 */
function RatingBadge({ driver }: { driver: DriverRow }) {
  if (driver.rating === null) {
    return <Badge className="bg-muted text-foreground border-0">New driver — no ratings yet</Badge>;
  }
  return (
    <Badge className="bg-brand-blue-50 text-brand-blue-900 border-0">
      {driver.rating.average.toFixed(1)}★ guide · from {driver.rating.count}{' '}
      {driver.rating.count === 1 ? 'rating' : 'ratings'}
    </Badge>
  );
}

function AvailabilityBadge({ driver }: { driver: DriverRow }) {
  const availability = driverAvailability(driver, manilaCivilDate(new Date()));

  if (availability.state === 'inactive') {
    return (
      <Badge className="bg-muted text-foreground border-0">Inactive — not on the roster</Badge>
    );
  }
  if (availability.state === 'on_leave') {
    return (
      <Badge className="border-0 bg-amber-100 text-amber-900">
        On leave to {formatCivilDate(availability.until)}
      </Badge>
    );
  }
  return <Badge className="bg-brand-blue-50 text-brand-blue-900 border-0">Active</Badge>;
}

export default function AdminDriversPage() {
  const utils = trpc.useUtils();
  const location = useLocation();
  const list = trpc.admin.drivers.list.useQuery(undefined, { retry: false });

  const [createValues, setCreateValues] = useState<Record<string, string>>(EMPTY_DRIVER_VALUES);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [createBanner, setCreateBanner] = useState<string | null>(null);

  const [editingDriver, setEditingDriver] = useState<DriverRow | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>(EMPTY_DRIVER_VALUES);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [editBanner, setEditBanner] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  /** The once-only PIN reveal — see the module note. Local state, not server state. */
  const [pinPanel, setPinPanel] = useState<{
    kind: 'create' | 'reset';
    name: string;
    pin: string;
  } | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<number | null>(null);
  const [confirmDeactivateId, setConfirmDeactivateId] = useState<number | null>(null);
  const [activeBanner, setActiveBanner] = useState<string | null>(null);
  const [activeNotice, setActiveNotice] = useState<string | null>(null);
  /** The confirm's Cancel button, so opening the confirm can put focus on the safe answer. */
  const cancelDeactivateRef = useRef<HTMLButtonElement | null>(null);

  const [leaveForms, setLeaveForms] = useState<Record<number, LeaveFormState>>({});
  const [removeLeaveBanner, setRemoveLeaveBanner] = useState<string | null>(null);

  // Trigger 3 of 3: a route change clears the reveal, not only Dismiss and
  // not only a subsequent mutation. On a page with no nested routes the
  // component also simply unmounts on navigation, but this is explicit
  // rather than relying on that incidental fact.
  useEffect(() => {
    setPinPanel(null);
    setConfirmResetId(null);
    setConfirmDeactivateId(null);
  }, [location.pathname]);

  useEffect(() => {
    if (confirmDeactivateId !== null) cancelDeactivateRef.current?.focus();
  }, [confirmDeactivateId]);

  function leaveFormFor(driverId: number): LeaveFormState {
    return leaveForms[driverId] ?? freshLeaveFormState();
  }

  const create = trpc.admin.drivers.create.useMutation({
    onSuccess: (data, variables) => {
      void utils.admin.drivers.list.invalidate();
      setCreateValues(EMPTY_DRIVER_VALUES);
      setCreateErrors({});
      setCreateBanner(null);
      setPinPanel({ kind: 'create', name: variables.name, pin: data.pin });
    },
    onError: (error) => {
      if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
        setCreateErrors((current) => ({ ...current, code: error.message }));
        setCreateBanner(null);
      } else {
        setCreateBanner(errorMessage(error, 'Could not add this driver. Please try again.'));
      }
    },
  });

  const update = trpc.admin.drivers.update.useMutation({
    onSuccess: () => {
      void utils.admin.drivers.list.invalidate();
      setEditingDriver(null);
      setEditErrors({});
      setEditBanner(null);
      setEditNotice(null);
      setPinPanel(null);
    },
    onError: (error) => {
      setEditNotice(null);
      if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
        setEditErrors((current) => ({ ...current, code: error.message }));
        setEditBanner(null);
      } else {
        setEditBanner(errorMessage(error, 'Could not save this driver. Please try again.'));
      }
    },
  });

  const resetPin = trpc.admin.drivers.resetPin.useMutation({
    onSuccess: (data, variables) => {
      const driver = (list.data ?? []).find((candidate) => candidate.id === variables.id);
      setPinPanel({ kind: 'reset', name: driver?.name ?? 'this driver', pin: data.pin });
      setConfirmResetId(null);
    },
  });

  const setActive = trpc.admin.drivers.setActive.useMutation({
    onMutate: () => {
      setActiveBanner(null);
      setActiveNotice(null);
    },
    onSuccess: (_data, variables) => {
      const driver = (list.data ?? []).find((candidate) => candidate.id === variables.id);
      const name = driver?.name ?? 'This driver';
      setPinPanel(null);
      setConfirmDeactivateId(null);
      setActiveNotice(
        variables.isActive
          ? `${name} is back on the roster. They sign in again with their PIN.`
          : `${name} is deactivated and signed out of the driver portal.`,
      );
      void utils.admin.drivers.list.invalidate();
    },
    onError: (error) => {
      setConfirmDeactivateId(null);
      setActiveBanner(errorMessage(error, 'Could not change this driver. Nothing was changed.'));
    },
  });

  /**
   * `leaves` is server state now — no local cache to update. `onSuccess`
   * only has to invalidate `list` (which re-fetches with the new leave
   * included, soonest-first) and reset this driver's form back to today's
   * defaults.
   */
  const addLeave = trpc.admin.drivers.addLeave.useMutation({
    onSuccess: (_data, variables) => {
      setPinPanel(null);
      void utils.admin.drivers.list.invalidate();
      setLeaveForms((current) => ({ ...current, [variables.driverId]: freshLeaveFormState() }));
    },
    onError: (error, variables) => {
      // The dispatcher needs to see the row that caused an overlap refusal
      // to act on the message — `driver.leaves` below is rendered
      // unconditionally, so the full list (soonest first, past leaves
      // included) stays visible right alongside this banner, not hidden
      // behind the pending/error state.
      setLeaveForms((current) => ({
        ...current,
        [variables.driverId]: {
          ...(current[variables.driverId] ?? freshLeaveFormState()),
          banner: errorMessage(error, 'Could not add that leave. Please try again.'),
        },
      }));
    },
  });

  const removeLeave = trpc.admin.drivers.removeLeave.useMutation({
    onSuccess: () => {
      setPinPanel(null);
      setRemoveLeaveBanner(null);
      void utils.admin.drivers.list.invalidate();
    },
    onError: (error) => {
      setRemoveLeaveBanner(errorMessage(error, 'Could not remove that leave. Please try again.'));
    },
  });

  function submitCreate() {
    setCreateBanner(null);
    const parsed = driverInputSchema.safeParse(rawDriverFromValues(createValues));
    if (!parsed.success) {
      setCreateErrors(fieldErrors(createValues, DRIVER_FIELDS, parsed));
      return;
    }
    setCreateErrors({});
    create.mutate(parsed.data);
  }

  function startEdit(row: DriverRow) {
    setEditingDriver(row);
    setEditValues(valuesFromDriverRow(row));
    setEditErrors({});
    setEditBanner(null);
    setEditNotice(null);
  }

  function submitEdit() {
    if (!editingDriver) return;
    setEditNotice(null);
    setEditBanner(null);
    const parsed = driverInputSchema.safeParse(rawDriverFromValues(editValues));
    if (!parsed.success) {
      setEditErrors(fieldErrors(editValues, DRIVER_FIELDS, parsed));
      return;
    }
    const patch = buildDriverPatch(parsed.data, editingDriver);
    if (Object.keys(patch).length === 0) {
      setEditErrors({});
      setEditNotice('No changes to save.');
      return;
    }
    setEditErrors({});
    update.mutate({ id: editingDriver.id, patch });
  }

  function submitAddLeave(driverId: number) {
    const form = leaveFormFor(driverId);
    const parsed = driverLeaveInputSchema.safeParse({
      driverId,
      startDate: form.values.startDate ?? '',
      endDate: form.values.endDate ?? '',
      reason: form.values.reason?.trim() ? form.values.reason.trim() : null,
    });
    if (!parsed.success) {
      setLeaveForms((current) => ({
        ...current,
        [driverId]: {
          ...form,
          errors: fieldErrors(form.values, LEAVE_FIELDS, parsed),
          banner: null,
        },
      }));
      return;
    }
    setLeaveForms((current) => ({ ...current, [driverId]: { ...form, errors: {}, banner: null } }));
    addLeave.mutate(parsed.data);
  }

  function copyPin(pin: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(pin).catch(() => {});
    }
  }

  const drivers = list.data ?? [];

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-brand-blue-900 text-2xl font-bold">Drivers</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Everyone who drives for us. PIN resets and leave come straight from here.
      </p>

      {pinPanel ? (
        <div
          role="status"
          className="border-brand-gold-400 bg-brand-gold-50 text-brand-gold-900 mt-6 rounded-xl border p-4 text-sm"
        >
          <p className="font-semibold">
            {pinPanel.kind === 'create' ? 'New driver, new PIN' : 'New PIN'} for {pinPanel.name}
          </p>
          <p
            className="mt-2 font-mono text-2xl font-bold tracking-widest"
            aria-label={`PIN ${pinPanel.pin}`}
          >
            {pinPanel.pin}
          </p>
          <p className="mt-2">
            This PIN will not be shown again — write it down or hand it to {pinPanel.name} now.
            {pinPanel.kind === 'reset'
              ? ' Any sign-in lockout on this driver has also been cleared.'
              : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="tap-target"
              onClick={() => copyPin(pinPanel.pin)}
            >
              Copy PIN
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tap-target"
              onClick={() => setPinPanel(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {activeNotice ? (
        <p
          role="status"
          className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 mt-6 rounded-lg border p-3 text-sm font-medium"
        >
          {activeNotice}
        </p>
      ) : null}

      {activeBanner ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-6 rounded-lg border p-3 text-sm font-medium"
        >
          {activeBanner}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-brand-blue-900 text-base">Add a driver</CardTitle>
        </CardHeader>
        <CardContent>
          {createBanner ? (
            <p
              role="alert"
              className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mb-4 rounded-lg border p-3 text-sm font-medium"
            >
              {createBanner}
            </p>
          ) : null}
          <EntityForm
            fields={DRIVER_FIELDS}
            values={createValues}
            errors={createErrors}
            pending={create.isPending}
            submitLabel="Add driver"
            onChange={(name, value) =>
              setCreateValues((current) => ({ ...current, [name]: value }))
            }
            onSubmit={submitCreate}
          />
        </CardContent>
      </Card>

      {editingDriver ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-brand-blue-900 text-base">
              Edit {editingDriver.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {editNotice ? (
              <p
                role="status"
                className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 mb-4 rounded-lg border p-3 text-sm font-medium"
              >
                {editNotice}
              </p>
            ) : null}
            {editBanner ? (
              <p
                role="alert"
                className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mb-4 rounded-lg border p-3 text-sm font-medium"
              >
                {editBanner}
              </p>
            ) : null}
            <EntityForm
              fields={DRIVER_FIELDS}
              values={editValues}
              errors={editErrors}
              pending={update.isPending}
              submitLabel="Save changes"
              onChange={(name, value) =>
                setEditValues((current) => ({ ...current, [name]: value }))
              }
              onSubmit={submitEdit}
            />
            <Button
              type="button"
              variant="outline"
              className="tap-target mt-3 w-full sm:w-auto"
              onClick={() => setEditingDriver(null)}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <h2 className="text-brand-blue-900 mt-8 text-lg font-semibold">The roster</h2>

      {removeLeaveBanner ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-4 rounded-lg border p-3 text-sm font-medium"
        >
          {removeLeaveBanner}
        </p>
      ) : null}

      {list.isPending ? (
        <p className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading drivers…
        </p>
      ) : list.isError ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-4 rounded-lg border p-3 text-sm font-medium"
        >
          We could not load the drivers. Sign in again, or try once more in a moment.
        </p>
      ) : drivers.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">
          No drivers yet — add the first one above.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {drivers.map((driver) => {
            const leaves = driver.leaves;
            const leaveForm = leaveFormFor(driver.id);
            const leaveMutationPending =
              addLeave.isPending && addLeave.variables?.driverId === driver.id;
            const resettingThisDriver = resetPin.isPending && resetPin.variables?.id === driver.id;
            const changingThisDriver = setActive.isPending && setActive.variables?.id === driver.id;

            return (
              <li key={driver.id}>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-brand-blue-900 font-semibold">{driver.name}</p>
                        <p className="text-muted-foreground font-mono text-sm">{driver.code}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <RatingBadge driver={driver} />
                        <AvailabilityBadge driver={driver} />
                        <Badge
                          className={
                            DRIVER_STATUS_BADGE_CLASS[driver.status] ??
                            'bg-muted text-foreground border-0'
                          }
                        >
                          {DRIVER_STATUS_LABELS[driver.status] ?? driver.status}
                        </Badge>
                      </div>
                    </div>

                    <DriverPersonalData driver={driver} />

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="tap-target"
                        onClick={() => startEdit(driver)}
                      >
                        Edit
                      </Button>

                      {confirmResetId === driver.id ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            className="tap-target"
                            disabled={resetPin.isPending}
                            onClick={() => resetPin.mutate({ id: driver.id })}
                          >
                            {resettingThisDriver ? 'Resetting…' : `Reset PIN for ${driver.name}?`}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="tap-target"
                            disabled={resetPin.isPending}
                            onClick={() => setConfirmResetId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          onClick={() => setConfirmResetId(driver.id)}
                        >
                          Reset PIN
                        </Button>
                      )}

                      {driver.isActive ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          disabled={setActive.isPending}
                          aria-label={`Deactivate ${driver.name}`}
                          onClick={() => {
                            setActiveNotice(null);
                            setConfirmDeactivateId(driver.id);
                          }}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          disabled={setActive.isPending}
                          aria-label={`Reactivate ${driver.name}`}
                          onClick={() => setActive.mutate({ id: driver.id, isActive: true })}
                        >
                          {changingThisDriver ? 'Reactivating…' : 'Reactivate'}
                        </Button>
                      )}
                    </div>

                    {confirmDeactivateId === driver.id && driver.isActive ? (
                      <div
                        role="group"
                        aria-label={`Confirm deactivating ${driver.name}`}
                        className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-3 rounded-lg border p-3 text-sm"
                      >
                        <p className="font-medium">
                          Deactivate {driver.name}? This signs them out of the driver portal
                          immediately, and takes them off the roster. Their upcoming trips will show
                          as needing a driver.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="tap-target"
                            disabled={setActive.isPending}
                            onClick={() => setActive.mutate({ id: driver.id, isActive: false })}
                          >
                            {changingThisDriver
                              ? 'Deactivating…'
                              : `Yes, deactivate ${driver.name}`}
                          </Button>
                          <Button
                            ref={cancelDeactivateRef}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="tap-target"
                            disabled={setActive.isPending}
                            onClick={() => setConfirmDeactivateId(null)}
                          >
                            Keep {driver.name} active
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-5 border-t pt-4">
                      <h3 className="text-brand-blue-900 text-sm font-semibold">Leave</h3>

                      {leaves.length === 0 ? (
                        <p className="text-muted-foreground mt-2 text-sm">No leave on file.</p>
                      ) : (
                        <ul className="mt-2 space-y-1">
                          {leaves.map((leave) => (
                            <li
                              key={leave.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span>
                                {formatCivilDate(leave.startDate)} to{' '}
                                {formatCivilDate(leave.endDate)}
                                {leave.reason ? ` (${leave.reason})` : ''}
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="tap-target"
                                disabled={
                                  removeLeave.isPending && removeLeave.variables?.id === leave.id
                                }
                                onClick={() => removeLeave.mutate({ id: leave.id })}
                              >
                                Remove
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {leaveForm.banner ? (
                        <p
                          role="alert"
                          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 mt-3 rounded-lg border p-3 text-sm font-medium"
                        >
                          {leaveForm.banner}
                        </p>
                      ) : null}

                      <div className="mt-3">
                        <EntityForm
                          fields={LEAVE_FIELDS}
                          values={leaveForm.values}
                          errors={leaveForm.errors}
                          pending={leaveMutationPending}
                          submitLabel="Add leave"
                          onChange={(name, value) =>
                            setLeaveForms((current) => ({
                              ...current,
                              [driver.id]: {
                                ...leaveFormFor(driver.id),
                                values: { ...leaveFormFor(driver.id).values, [name]: value },
                              },
                            }))
                          }
                          onSubmit={() => submitAddLeave(driver.id)}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
