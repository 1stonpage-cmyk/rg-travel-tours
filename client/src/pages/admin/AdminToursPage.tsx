/**
 * The tour editing screens — title, slug, destination, pricing tiers,
 * gallery images, itinerary stops and add-ons (Week 7 plan, Task 7;
 * BUILD_SPEC §9 "Tours & pricing", client half). `admin.tours.*` (Task 6) is
 * `adminProcedure('toursPricing')` — owner only — so this screen offers no
 * control a dispatcher or finance role could use. It does not re-check the
 * role itself for enforcement (CLAUDE.md: hiding a button is not access
 * control) but — same shape as `AdminStaffPage.tsx` — it does show a plain
 * "owner only" denied state rather than a blank page or raw data, from
 * either of the two places a non-owner could reach this screen: the role
 * this session already knows (`staffAuth.me`), and a refused
 * `admin.tours.list` call (a stale session, or a role that changed
 * mid-visit).
 *
 * ## The four repeating arrays, and why `EntityForm` could not hold them
 *
 * This task's brief said to reuse `EntityForm.tsx` and put the repeating
 * arrays behind its "More details" accordion. `EntityForm`'s actual props
 * are `Record<string, string>` — flat scalar fields only, with no
 * accordion-of-ROWS concept at all. So `EntityForm` is used here for
 * exactly what it is good at: the tour's own scalar columns (title, slug,
 * destination, duration, SEO fields, ...), split flat/collapsed by the
 * `required` flag the way `AdminVansPage.tsx` already does. The four arrays
 * — `priceTiers`, `images`, `itinerary`, `addons` — are each a small,
 * self-contained add/remove-row section below it, in the same card, built
 * from local component state rather than `EntityForm` fields: the same
 * shape `AdminDriversPage.tsx`'s leave list uses for "a repeating list
 * inside a bigger entity's screen," adapted for rows that post as part of
 * ONE save rather than firing their own mutation. `EntityForm`'s own submit
 * button stays the single save action for the whole tour — its `onSubmit`
 * callback reads the scalar values AND the four array states together and
 * posts the full `tourCreateInput`/`tourUpdateInput` shape in one call,
 * because the server replaces every child table wholesale on every save
 * (`shared/src/tours-admin.ts`).
 *
 * ## Money
 *
 * Every price is typed in pesos and converted to integer centavos at the
 * form boundary (`lib/money-input.ts`, `pesosToCentavos`) — the server never
 * sees a float or a peso string (CLAUDE.md, "Money").
 *
 * ## Add-ons are deactivated, not deleted
 *
 * `TourAddonRow.isActive` comes back from `detail` for retired add-ons too
 * (the router's own doc comment: "there is no `is_active` filter on that
 * read"). This screen shows every add-on it is handed and lets the owner
 * tick/untick "Active" directly; there is no "remove" control for a SAVED
 * add-on, because unticking it already says what dropping one means on the
 * server (`services/tours/upsert.ts`: a posted `isActive: false` on a row
 * that still carries its id is an UPDATE, not a disappearance). A brand-new,
 * never-saved add-on row (no id yet) can be removed outright — there is
 * nothing on the server yet to deactivate.
 *
 * ## Itinerary stops can refuse to be removed
 *
 * Removing a stop a driver has already checked in at is refused with
 * `CONFLICT`, naming the stop (`services/tours/upsert.ts`,
 * `checkedInStopMessage`). This screen shows that sentence exactly as the
 * server wrote it, in the same amber alert every other refusal here uses —
 * it does not invent its own wording for a case the server already explains
 * well.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  TOUR_BADGES,
  formatPeso,
  tourCreateInput,
  tourUpdateInput,
  type TourAdminDetail,
  type TourAdminListItem,
  type TourBadge,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';
const ROW_ERROR = 'text-brand-gold-800 text-xs font-medium';
const SECTION = 'border-brand-blue-100 rounded-xl border p-4';

const BADGE_LABELS: Record<TourBadge, string> = {
  none: 'None',
  best_seller: 'Best seller',
  new: 'New',
  seasonal: 'Seasonal',
};

const STATUS_BADGE_CLASS: Record<'Active' | 'Inactive', string> = {
  Active: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  Inactive: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeTourError(error: unknown, fallback: string): string {
  /*
   * Task A4. An input-validation failure's `message` is tRPC's own default
   * for a `ZodError` — `JSON.stringify(issues, null, 2)` — so returning it
   * here put a JSON blob in the banner. The schema's own sentence is the
   * thing a human can act on, and the per-field messages go to the form's
   * `errors` map in `onError` besides.
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

let rowKeyCounter = 0;
/** A locally-unique React key for a repeating-row field. Never sent to the server. */
function nextRowKey(): string {
  rowKeyCounter += 1;
  return `row-${rowKeyCounter}`;
}

interface TierRow {
  key: string;
  minPax: string;
  maxPax: string;
  pricePesos: string;
}
interface ImageRow {
  key: string;
  path: string;
  alt: string;
  width: string;
  height: string;
}
interface StopRow {
  key: string;
  id?: number;
  name: string;
  description: string;
}
interface AddonRow {
  key: string;
  id?: number;
  name: string;
  pricePesos: string;
  perPerson: boolean;
  isActive: boolean;
}

function emptyTierRow(): TierRow {
  return { key: nextRowKey(), minPax: '', maxPax: '', pricePesos: '' };
}
function emptyImageRow(): ImageRow {
  return { key: nextRowKey(), path: '', alt: '', width: '', height: '' };
}
function emptyStopRow(): StopRow {
  return { key: nextRowKey(), name: '', description: '' };
}
function emptyAddonRow(): AddonRow {
  return { key: nextRowKey(), name: '', pricePesos: '', perPerson: false, isActive: true };
}

function tierRowsFromDetail(detail: TourAdminDetail): TierRow[] {
  return detail.priceTiers.map((tier) => ({
    key: nextRowKey(),
    minPax: String(tier.minPax),
    maxPax: String(tier.maxPax),
    pricePesos: centavosToPesosInput(tier.pricePerPersonCentavos),
  }));
}
function imageRowsFromDetail(detail: TourAdminDetail): ImageRow[] {
  return detail.images.map((image) => ({
    key: nextRowKey(),
    path: image.path,
    alt: image.alt,
    width: image.width === null ? '' : String(image.width),
    height: image.height === null ? '' : String(image.height),
  }));
}
function stopRowsFromDetail(detail: TourAdminDetail): StopRow[] {
  return detail.itinerary.map((stop) => ({
    key: nextRowKey(),
    id: stop.id,
    name: stop.name,
    description: stop.description ?? '',
  }));
}
function addonRowsFromDetail(detail: TourAdminDetail): AddonRow[] {
  return detail.addons.map((addon) => ({
    key: nextRowKey(),
    id: addon.id,
    name: addon.name,
    pricePesos: centavosToPesosInput(addon.priceCentavos),
    perPerson: addon.perPerson,
    isActive: addon.isActive,
  }));
}

function scalarValuesFromDetail(detail: TourAdminDetail | null): Record<string, string> {
  if (!detail) {
    return {
      title: '',
      slug: '',
      destinationId: '',
      groupsPerDay: '2',
      maxGuests: '12',
      summary: '',
      about: '',
      durationHours: '',
      freeCancelHours: '',
      isFeatured: 'false',
      sortOrder: '0',
      badge: 'none',
      alertNote: '',
      seoTitle: '',
      seoDescription: '',
      ogImage: '',
    };
  }
  return {
    title: detail.title,
    slug: detail.slug,
    destinationId: String(detail.destinationId),
    groupsPerDay: String(detail.groupsPerDay),
    maxGuests: String(detail.maxGuests),
    summary: detail.summary ?? '',
    about: detail.about ?? '',
    durationHours: detail.durationHours === null ? '' : String(detail.durationHours),
    freeCancelHours: detail.freeCancelHours === null ? '' : String(detail.freeCancelHours),
    isFeatured: String(detail.isFeatured),
    sortOrder: String(detail.sortOrder),
    badge: detail.badge,
    alertNote: detail.alertNote ?? '',
    seoTitle: detail.seoTitle ?? '',
    seoDescription: detail.seoDescription ?? '',
    ogImage: detail.ogImage ?? '',
  };
}

/** First zod issue per top-level scalar field, keyed by field name. */
function scalarIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
  scalarNames: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (!key || key in out || !scalarNames.includes(key)) continue;
    out[key] = issue.message;
  }
  return out;
}

/** First zod issue per row of one array field, keyed by row index then field name. */
function arrayIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
  arrayName: string,
): Record<number, Record<string, string>> {
  const out: Record<number, Record<string, string>> = {};
  for (const issue of issues) {
    if (issue.path[0] !== arrayName) continue;
    const index = issue.path[1];
    if (typeof index !== 'number') continue;
    const field = typeof issue.path[2] === 'string' ? issue.path[2] : '_row';
    out[index] = { ...(out[index] ?? {}), [field]: issue.message };
  }
  return out;
}

const SCALAR_NAMES = [
  'title',
  'slug',
  'destinationId',
  'groupsPerDay',
  'maxGuests',
  'summary',
  'about',
  'durationHours',
  'freeCancelHours',
  'isFeatured',
  'sortOrder',
  'badge',
  'alertNote',
  'seoTitle',
  'seoDescription',
  'ogImage',
] as const;

/** The same names as a Set, for `splitFieldErrors` (task A4). */
const SCALAR_NAME_SET: ReadonlySet<string> = new Set(SCALAR_NAMES);

interface DestinationOption {
  id: number;
  name: string;
}

function scalarFields(destinations: readonly DestinationOption[]): EntityFormField[] {
  return [
    { name: 'title', label: 'Title', type: 'text', required: true },
    {
      name: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      hint: 'Lowercase letters, numbers and hyphens, e.g. island-hopping-tour.',
    },
    {
      name: 'destinationId',
      label: 'Destination',
      type: 'select',
      required: true,
      options: destinations.map((d) => ({ value: String(d.id), label: d.name })),
    },
    { name: 'groupsPerDay', label: 'Groups per day', type: 'number', required: true },
    { name: 'maxGuests', label: 'Max guests per group', type: 'number', required: true },
    { name: 'summary', label: 'Summary', type: 'textarea' },
    { name: 'about', label: 'About this tour', type: 'textarea' },
    { name: 'durationHours', label: 'Duration (hours)', type: 'number' },
    {
      name: 'freeCancelHours',
      label: 'Free cancellation window (hours)',
      type: 'number',
    },
    {
      name: 'isFeatured',
      label: 'Featured',
      type: 'select',
      options: [
        { value: 'false', label: 'No' },
        { value: 'true', label: 'Yes' },
      ],
    },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'number',
      hint: 'Lower numbers show first in the public list.',
    },
    {
      name: 'badge',
      label: 'Badge',
      type: 'select',
      options: TOUR_BADGES.map((badge) => ({ value: badge, label: BADGE_LABELS[badge] })),
    },
    {
      name: 'alertNote',
      label: 'Alert note',
      type: 'textarea',
      hint: 'A short notice shown on the public tour page, e.g. "Sea conditions permitting."',
    },
    { name: 'seoTitle', label: 'SEO title', type: 'text' },
    { name: 'seoDescription', label: 'SEO description', type: 'textarea' },
    { name: 'ogImage', label: 'Social share image path', type: 'text' },
  ];
}

/** ---------------------------------------------------------------- Price tiers */

function PriceTiersSection({
  idPrefix,
  rows,
  errors,
  onChange,
}: {
  idPrefix: string;
  rows: TierRow[];
  errors: Record<number, Record<string, string>>;
  onChange: (next: TierRow[]) => void;
}) {
  function updateRow(index: number, patch: Partial<TierRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className={SECTION}>
      <h3 className="text-brand-ink text-sm font-bold">Price tiers</h3>
      <p className="text-brand-error mt-1 text-xs">
        Every tier needs its own party-size range. A tour with no tiers cannot be booked.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((row, index) => {
          const base = `${idPrefix}-tier-${row.key}`;
          const rowErrors = errors[index] ?? {};
          return (
            <div key={row.key} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${base}-min`}>Minimum guests</Label>
                <Input
                  id={`${base}-min`}
                  type="number"
                  className={`${FIELD} w-24`}
                  value={row.minPax}
                  onChange={(e) => updateRow(index, { minPax: e.target.value })}
                />
                {rowErrors.minPax ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.minPax}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${base}-max`}>Maximum guests</Label>
                <Input
                  id={`${base}-max`}
                  type="number"
                  className={`${FIELD} w-24`}
                  value={row.maxPax}
                  onChange={(e) => updateRow(index, { maxPax: e.target.value })}
                />
                {rowErrors.maxPax ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.maxPax}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${base}-price`}>Price per person (pesos)</Label>
                <Input
                  id={`${base}-price`}
                  type="text"
                  inputMode="decimal"
                  placeholder="1999.00"
                  className={`${FIELD} w-32`}
                  value={row.pricePesos}
                  onChange={(e) => updateRow(index, { pricePesos: e.target.value })}
                />
                {rowErrors.pricePerPersonCentavos ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.pricePerPersonCentavos}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={OUTLINE_BUTTON}
                onClick={() => removeRow(index)}
              >
                Remove tier
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${OUTLINE_BUTTON} mt-3`}
        onClick={() => onChange([...rows, emptyTierRow()])}
      >
        + Add a price tier
      </Button>
    </div>
  );
}

/** -------------------------------------------------------------------- Images */

function ImagesSection({
  idPrefix,
  rows,
  errors,
  onChange,
}: {
  idPrefix: string;
  rows: ImageRow[];
  errors: Record<number, Record<string, string>>;
  onChange: (next: ImageRow[]) => void;
}) {
  function updateRow(index: number, patch: Partial<ImageRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className={SECTION}>
      <h3 className="text-brand-ink text-sm font-bold">Gallery images</h3>
      <p className="text-brand-error mt-1 text-xs">Every image needs alt text.</p>
      <div className="mt-3 space-y-3">
        {rows.map((row, index) => {
          const base = `${idPrefix}-image-${row.key}`;
          const rowErrors = errors[index] ?? {};
          return (
            <div key={row.key} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-[2_1_220px] space-y-1">
                <Label htmlFor={`${base}-path`}>Image path</Label>
                <Input
                  id={`${base}-path`}
                  className={FIELD}
                  value={row.path}
                  onChange={(e) => updateRow(index, { path: e.target.value })}
                />
                {rowErrors.path ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.path}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0 flex-[2_1_220px] space-y-1">
                <Label htmlFor={`${base}-alt`}>Alt text</Label>
                <Input
                  id={`${base}-alt`}
                  className={FIELD}
                  value={row.alt}
                  onChange={(e) => updateRow(index, { alt: e.target.value })}
                />
                {rowErrors.alt ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.alt}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={OUTLINE_BUTTON}
                onClick={() => removeRow(index)}
              >
                Remove image
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${OUTLINE_BUTTON} mt-3`}
        onClick={() => onChange([...rows, emptyImageRow()])}
      >
        + Add an image
      </Button>
    </div>
  );
}

/** ----------------------------------------------------------- Itinerary stops */

function ItinerarySection({
  idPrefix,
  rows,
  errors,
  onChange,
}: {
  idPrefix: string;
  rows: StopRow[];
  errors: Record<number, Record<string, string>>;
  onChange: (next: StopRow[]) => void;
}) {
  function updateRow(index: number, patch: Partial<StopRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className={SECTION}>
      <h3 className="text-brand-ink text-sm font-bold">Itinerary stops</h3>
      <p className="text-brand-error mt-1 text-xs">
        Removing a stop a driver has already checked in at will be refused — the save will say which
        one.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((row, index) => {
          const base = `${idPrefix}-stop-${row.key}`;
          const rowErrors = errors[index] ?? {};
          return (
            <div key={row.key} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-[1_1_200px] space-y-1">
                <Label htmlFor={`${base}-name`}>Stop name</Label>
                <Input
                  id={`${base}-name`}
                  className={FIELD}
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                />
                {rowErrors.name ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.name}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0 flex-[2_1_260px] space-y-1">
                <Label htmlFor={`${base}-description`}>Description</Label>
                <textarea
                  id={`${base}-description`}
                  rows={2}
                  className="border-brand-blue-200 tap-target focus-visible:ring-brand-blue-600 w-full rounded-[10px] border bg-white p-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                  value={row.description}
                  onChange={(e) => updateRow(index, { description: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={OUTLINE_BUTTON}
                onClick={() => removeRow(index)}
              >
                Remove stop
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${OUTLINE_BUTTON} mt-3`}
        onClick={() => onChange([...rows, emptyStopRow()])}
      >
        + Add a stop
      </Button>
    </div>
  );
}

/** ------------------------------------------------------------------ Add-ons */

function AddonsSection({
  idPrefix,
  rows,
  errors,
  onChange,
}: {
  idPrefix: string;
  rows: AddonRow[];
  errors: Record<number, Record<string, string>>;
  onChange: (next: AddonRow[]) => void;
}) {
  function updateRow(index: number, patch: Partial<AddonRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className={SECTION}>
      <h3 className="text-brand-ink text-sm font-bold">Add-ons</h3>
      <p className="text-brand-error mt-1 text-xs">
        Unticking "Active" retires an add-on without deleting it — a guest may already have bought
        one. Tick it again to bring it back.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((row, index) => {
          const base = `${idPrefix}-addon-${row.key}`;
          const rowErrors = errors[index] ?? {};
          return (
            <div key={row.key} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-[2_1_200px] space-y-1">
                <Label htmlFor={`${base}-name`}>Add-on name</Label>
                <Input
                  id={`${base}-name`}
                  className={FIELD}
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                />
                {rowErrors.name ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.name}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${base}-price`}>Price (pesos)</Label>
                <Input
                  id={`${base}-price`}
                  type="text"
                  inputMode="decimal"
                  placeholder="150.00"
                  className={`${FIELD} w-28`}
                  value={row.pricePesos}
                  onChange={(e) => updateRow(index, { pricePesos: e.target.value })}
                />
                {rowErrors.priceCentavos ? (
                  <p role="alert" className={ROW_ERROR}>
                    {rowErrors.priceCentavos}
                  </p>
                ) : null}
              </div>
              <label className="tap-target flex items-center gap-2 text-sm" htmlFor={`${base}-pp`}>
                <input
                  id={`${base}-pp`}
                  type="checkbox"
                  checked={row.perPerson}
                  onChange={(e) => updateRow(index, { perPerson: e.target.checked })}
                />
                Per person
              </label>
              <label
                className="tap-target flex items-center gap-2 text-sm"
                htmlFor={`${base}-active`}
              >
                <input
                  id={`${base}-active`}
                  type="checkbox"
                  checked={row.isActive}
                  onChange={(e) => updateRow(index, { isActive: e.target.checked })}
                />
                Active
              </label>
              {row.id === undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={OUTLINE_BUTTON}
                  onClick={() => removeRow(index)}
                >
                  Remove unsaved add-on
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={`${OUTLINE_BUTTON} mt-3`}
        onClick={() => onChange([...rows, emptyAddonRow()])}
      >
        + Add an add-on
      </Button>
    </div>
  );
}

/** ---------------------------------------------------------------- The form */

function TourForm({
  mode,
  initial,
  destinations,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: TourAdminDetail | null;
  destinations: readonly DestinationOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const idPrefix = useId();
  const utils = trpc.useUtils();

  const [scalarValues, setScalarValues] = useState<Record<string, string>>(() =>
    scalarValuesFromDetail(initial),
  );
  const [scalarErrors, setScalarErrors] = useState<Record<string, string>>({});
  const [tiers, setTiers] = useState<TierRow[]>(() => (initial ? tierRowsFromDetail(initial) : []));
  const [tierErrors, setTierErrors] = useState<Record<number, Record<string, string>>>({});
  const [images, setImages] = useState<ImageRow[]>(() =>
    initial ? imageRowsFromDetail(initial) : [],
  );
  const [imageErrors, setImageErrors] = useState<Record<number, Record<string, string>>>({});
  const [stops, setStops] = useState<StopRow[]>(() => (initial ? stopRowsFromDetail(initial) : []));
  const [stopErrors, setStopErrors] = useState<Record<number, Record<string, string>>>({});
  const [addons, setAddons] = useState<AddonRow[]>(() =>
    initial ? addonRowsFromDetail(initial) : [],
  );
  const [addonErrors, setAddonErrors] = useState<Record<number, Record<string, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);

  /*
   * Task A4. A validation refusal's messages go to the scalar fields they
   * name; anything the form cannot place against an input (a `priceTiers` or
   * `images` message, whose own errors are keyed by ROW here, not by field)
   * stays in the banner rather than being dropped.
   */
  function reportSaveError(error: unknown, fallback: string) {
    const validation = splitFieldErrors(error, SCALAR_NAME_SET);
    if (validation) {
      setScalarErrors(validation.fields);
      setBanner(validation.banner);
      return;
    }
    setBanner(describeTourError(error, fallback));
  }

  const create = trpc.admin.tours.create.useMutation({
    onSuccess: () => {
      void utils.admin.tours.list.invalidate();
      onSaved('Tour added.');
    },
    onError: (error) => reportSaveError(error, 'Could not add this tour.'),
  });
  const update = trpc.admin.tours.update.useMutation({
    onSuccess: () => {
      void utils.admin.tours.list.invalidate();
      void utils.admin.tours.detail.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => reportSaveError(error, 'Could not save this tour.'),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    setBanner(null);

    const nextTierErrors: Record<number, Record<string, string>> = {};
    const priceTiers = tiers.map((row, index) => {
      const minPax = Number(row.minPax);
      const maxPax = Number(row.maxPax);
      const pricePerPersonCentavos = pesosToCentavos(row.pricePesos);
      if (pricePerPersonCentavos === null) {
        nextTierErrors[index] = {
          ...(nextTierErrors[index] ?? {}),
          pricePerPersonCentavos: 'Enter a valid price in pesos, e.g. 1999.00.',
        };
      }
      return { minPax, maxPax, pricePerPersonCentavos: pricePerPersonCentavos ?? Number.NaN };
    });

    const nextAddonErrors: Record<number, Record<string, string>> = {};
    const addonInputs = addons.map((row, index) => {
      const priceCentavos = pesosToCentavos(row.pricePesos);
      if (priceCentavos === null) {
        nextAddonErrors[index] = {
          ...(nextAddonErrors[index] ?? {}),
          priceCentavos: 'Enter a valid price in pesos, e.g. 150.00.',
        };
      }
      return {
        ...(row.id !== undefined ? { id: row.id } : {}),
        name: row.name.trim(),
        priceCentavos: priceCentavos ?? Number.NaN,
        perPerson: row.perPerson,
        isActive: row.isActive,
      };
    });

    const hasConversionErrors =
      Object.keys(nextTierErrors).length > 0 || Object.keys(nextAddonErrors).length > 0;
    if (hasConversionErrors) {
      setTierErrors(nextTierErrors);
      setAddonErrors(nextAddonErrors);
      return;
    }

    const imageInputs = images.map((row, index) => ({
      path: row.path.trim(),
      alt: row.alt.trim(),
      width: row.width.trim() === '' ? null : Number(row.width),
      height: row.height.trim() === '' ? null : Number(row.height),
      sortOrder: index,
    }));

    const itineraryInputs = stops.map((row, index) => ({
      ...(row.id !== undefined ? { id: row.id } : {}),
      sortOrder: index,
      name: row.name.trim(),
      description: row.description.trim() === '' ? null : row.description.trim(),
    }));

    // `Record<string, string>` indexing is `string | undefined` under
    // `noUncheckedIndexedAccess`; every key here always has a default (see
    // `scalarValuesFromDetail`), so `?? ''` is a type-level formality, not a
    // real fallback.
    const scalar = (name: string) => (scalarValues[name] ?? '').trim();
    const payload = {
      title: scalar('title'),
      slug: scalar('slug'),
      destinationId: Number(scalarValues.destinationId),
      summary: scalar('summary') === '' ? null : scalar('summary'),
      about: scalar('about') === '' ? null : scalar('about'),
      inclusions: initial?.inclusions ?? null,
      exclusions: initial?.exclusions ?? null,
      durationHours: scalar('durationHours') === '' ? null : Number(scalar('durationHours')),
      groupsPerDay: Number(scalarValues.groupsPerDay),
      maxGuests: Number(scalarValues.maxGuests),
      freeCancelHours: scalar('freeCancelHours') === '' ? null : Number(scalar('freeCancelHours')),
      isFeatured: scalarValues.isFeatured === 'true',
      sortOrder: Number(scalarValues.sortOrder || '0'),
      badge: scalarValues.badge as TourBadge,
      alertNote: scalar('alertNote') === '' ? null : scalar('alertNote'),
      seoTitle: scalar('seoTitle') === '' ? null : scalar('seoTitle'),
      seoDescription: scalar('seoDescription') === '' ? null : scalar('seoDescription'),
      ogImage: scalar('ogImage') === '' ? null : scalar('ogImage'),
      priceTiers,
      images: imageInputs,
      itinerary: itineraryInputs,
      addons: addonInputs,
    };

    const toValidate = mode === 'edit' ? { ...payload, id: initial!.id } : payload;
    const schema = mode === 'edit' ? tourUpdateInput : tourCreateInput;
    const parsed = schema.safeParse(toValidate);
    if (!parsed.success) {
      setScalarErrors(scalarIssues(parsed.error.issues, SCALAR_NAMES));
      setTierErrors(arrayIssues(parsed.error.issues, 'priceTiers'));
      setImageErrors(arrayIssues(parsed.error.issues, 'images'));
      setStopErrors(arrayIssues(parsed.error.issues, 'itinerary'));
      setAddonErrors(arrayIssues(parsed.error.issues, 'addons'));
      return;
    }

    setScalarErrors({});
    setTierErrors({});
    setImageErrors({});
    setStopErrors({});
    setAddonErrors({});

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
        values={scalarValues}
        errors={scalarErrors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add tour'}
        onChange={(name, value) => setScalarValues((current) => ({ ...current, [name]: value }))}
        onSubmit={submit}
      />

      <PriceTiersSection idPrefix={idPrefix} rows={tiers} errors={tierErrors} onChange={setTiers} />
      <ImagesSection idPrefix={idPrefix} rows={images} errors={imageErrors} onChange={setImages} />
      <ItinerarySection idPrefix={idPrefix} rows={stops} errors={stopErrors} onChange={setStops} />
      <AddonsSection idPrefix={idPrefix} rows={addons} errors={addonErrors} onChange={setAddons} />

      {/*
       * `EntityForm`'s own submit button (above, labelled "Add tour" or
       * "Save changes") is the single save action for the whole tour —
       * scalar fields and all four arrays together. Only Cancel needs a
       * second control down here, now that the arrays are below the fold.
       */}
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

/** ------------------------------------------------------- Editor card wrapper */

function TourEditorCard({
  editingId,
  destinations,
  onClose,
  onSaved,
}: {
  editingId: number | 'new';
  destinations: readonly DestinationOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const detailQuery = trpc.admin.tours.detail.useQuery(
    { id: typeof editingId === 'number' ? editingId : 1 },
    { enabled: typeof editingId === 'number', retry: false },
  );

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-brand-ink text-lg font-bold">
          {editingId === 'new' ? 'Add a tour' : 'Edit tour'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {editingId === 'new' ? (
          <TourForm
            mode="create"
            initial={null}
            destinations={destinations}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : detailQuery.isPending ? (
          <p className="text-brand-error flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading tour…
          </p>
        ) : detailQuery.isError ? (
          <p role="alert" className={ALERT}>
            {describeTourError(detailQuery.error, 'Could not load this tour. Try again.')}
          </p>
        ) : (
          <TourForm
            key={detailQuery.data!.id}
            mode="edit"
            initial={detailQuery.data!}
            destinations={destinations}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** ------------------------------------------------------------------- The list */

function statusLabel(isActive: boolean): 'Active' | 'Inactive' {
  return isActive ? 'Active' : 'Inactive';
}

function priceSummary(tour: TourAdminListItem): string {
  if (tour.priceTierCount === 0 || tour.fromPriceCentavos === null) {
    return 'No price set — nobody can book this tour';
  }
  return `From ${formatPeso(tour.fromPriceCentavos)} · ${tour.priceTierCount} ${
    tour.priceTierCount === 1 ? 'tier' : 'tiers'
  }`;
}

function DeactivateControl({ tour, onEdit }: { tour: TourAdminListItem; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.tours.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.tours.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(describeTourError(error, 'Could not change this tour. Nothing was changed.'));
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" className={OUTLINE_BUTTON} onClick={onEdit}>
        Edit
      </Button>

      {tour.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${tour.title}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              type="button"
              size="sm"
              className={PRIMARY_BUTTON}
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: tour.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${tour.title}`}
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
            aria-label={`Deactivate ${tour.title}`}
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
          aria-label={`Reactivate ${tour.title}`}
          onClick={() => setActive.mutate({ id: tour.id, isActive: true })}
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

/** The same denied markup `AdminStaffPage.tsx`'s role gate renders, reused by the second layer. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Tours &amp; pricing</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can manage tours and pricing.
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

/** Is this refusal a role problem (401/403), as opposed to a network or server fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

function ToursAdmin() {
  const list = trpc.admin.tours.list.useQuery(undefined, { retry: false });
  const destinationsQuery = trpc.destinations.list.useQuery();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const destinations: DestinationOption[] = (destinationsQuery.data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
  }));

  // The second denial layer: the ROLE check in `AdminToursPage` only catches
  // a session this client already knows is not the owner. A session that
  // LOOKS like an owner to this page but whose `toursPricing` grant the
  // server has since revoked only surfaces here, when the list itself comes
  // back refused — same words, never raw data, never a blank screen.
  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const tours = list.data ?? [];

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
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Tours &amp; pricing</h1>
        <p className="text-brand-error text-sm">
          Title, pricing tiers, gallery, itinerary and add-ons for every tour in the catalog.
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
          Add a tour
        </Button>
      ) : (
        <TourEditorCard
          editingId={editingId}
          destinations={destinations}
          onClose={() => setEditingId(null)}
          onSaved={closeEditor}
        />
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Catalog</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading tours…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the catalog. Sign in again, or try once more in a moment.
        </p>
      ) : tours.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No tours yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per tour. */}
          <ul className="space-y-3 md:hidden">
            {tours.map((tour) => (
              <li key={tour.id} className={`${CARD} p-4 text-sm`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-brand-ink font-semibold">{tour.title}</p>
                    <p className="text-brand-error text-xs">{tour.destination.name}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(tour.isActive)]}>
                    {statusLabel(tour.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-ink mt-2">{priceSummary(tour)}</p>
                <div className="mt-3">
                  <DeactivateControl tour={tour} onEdit={() => setEditingId(tour.id)} />
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="tours-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Tour
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Destination
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Price
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody>
                {tours.map((tour) => (
                  <tr
                    key={tour.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-semibold">{tour.title}</td>
                    <td className="text-brand-ink px-4 py-3">{tour.destination.name}</td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(tour.isActive)]}>
                        {statusLabel(tour.isActive)}
                      </Badge>
                    </td>
                    <td className="text-brand-ink px-4 py-3">{priceSummary(tour)}</td>
                    <td className="px-4 py-3 text-right">
                      <DeactivateControl tour={tour} onEdit={() => setEditingId(tour.id)} />
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
 * A convenience, not the control: the server refuses every `admin.tours`
 * call from anyone but the owner. This just stops a dispatcher or finance
 * user who types the address from being shown a form that can only be
 * refused. The second denial layer — a refused `admin.tours.list` call this
 * role check did not catch — lives inside `ToursAdmin` itself, right beside
 * the query it is guarding.
 */
export default function AdminToursPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <ToursAdmin />;
}
