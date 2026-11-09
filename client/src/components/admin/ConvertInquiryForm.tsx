/**
 * `ConvertInquiryForm` — turning one `transfer_custom` inquiry into a real,
 * held transfer booking (transfers-launch plan, Task T20; §6 step 2).
 *
 * ## Where the fields come from
 *
 * `inquiries.pax` and `.phone` pre-fill `pax`/`leadPhone` when the guest gave
 * them — both are nullable on the inquiry, and `admin.transferQuotes.convert`
 * requires them anyway (T19's own doc comment on why: a null-skipping guest
 * must not become a permanently unconvertible request). `leadPhone` is left
 * BLANK, never a placeholder, when the guest gave no number: a shared
 * placeholder would trip `assertUnderHoldCaps`'s 2-active-holds-per-phone cap
 * on a third such conversion (T19's own operational caveat on this field).
 * `routeDescription` and the guest's message ride through unedited on the
 * server — this form has no box for either, by the same design.
 *
 * ## One schema, two shapes of the same trip
 *
 * `transferQuoteConvertInput`'s `superRefine` requires
 * `customRouteDurationMinutes` on a one-way trip and refuses it (along with
 * flight details) on a day-use hire — the mirror image of `dayUseEndTime`.
 * The field LIST below is rebuilt on every render from the current
 * `productType` value so only the fields that apply to it ever appear, and
 * `onProductTypeChange` clears the other shape's boxes when switching — not
 * just hiding them — so a value typed before a switch never rides along
 * inside `transferQuoteConvertInput.safeParse`'s payload for a shape it no
 * longer belongs to.
 *
 * ## Two steps, `primary-pill` not `amber-pill`
 *
 * This creates a real `pending_payment` hold, not a destructive action — the
 * hold is itself cancellable, the way any guest hold is — so the house
 * two-step confirm (`CancelRefundPanel.tsx`) is kept but its amber trigger is
 * not: `amber-pill` is reserved for irreversible money-out actions. The
 * confirm step still states the price in figures AND in words
 * (`@/lib/peso-words`), because a staff-typed price is the one figure in this
 * form that came from a human and is about to be frozen onto a real booking.
 *
 * The confirm button is worded "Confirm — convert to a booking", not "Yes —
 * …": `admin-destructive-confirm-color.test.ts` treats every "Yes, …"/"Yes —
 * …" button as the house phrasing for a DESTRUCTIVE confirm and requires it
 * be `amber-pill`. This confirm is deliberately not amber (it is not
 * destructive), so it is also deliberately not phrased "Yes" — the two are
 * the same house convention read from both directions.
 *
 * ## `priceCentavos` errors ARE placed on the price box
 *
 * Unlike `PackageForm`'s `newPriceCentavos`/`oldPriceCentavos` (which have no
 * box of the same name and so fall to the banner by design), this form has
 * exactly one price box and the server key maps onto it 1:1 —
 * `toFormFieldName` does that remapping for both the client-side schema check
 * below and a server refusal (e.g. T19's own `MAX_CENTAVOS` cap message), so
 * either lands beside the box a staff member is looking at.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  formatPeso,
  transferQuoteConvertInput,
  type InquiryAdminRow,
  type TransferProductType,
  type TransferQuoteConvertInput,
  type VehicleTypeAdminRow,
} from '@rg/shared';
import { Button } from '@/components/ui/button';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import FormActions from '@/components/admin/FormActions';
import { pesosToCentavos } from '@/lib/money-input';
import { pesosInWords } from '@/lib/peso-words';
import { firstValidationMessage, getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { trpc } from '@/lib/trpc';

const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';

const PRODUCT_TYPE_OPTIONS = [
  { value: 'transfer_one_way', label: 'One-way transfer' },
  { value: 'transfer_day_use', label: 'Day-use hire' },
] as const;

/** `transferQuoteConvertInput` fields one-way and day-use do NOT share. */
const ONE_WAY_ONLY_FIELDS = ['customRouteDurationMinutes', 'flightNumber', 'airline'];
const DAY_USE_ONLY_FIELDS = ['dayUseEndTime'];

/** The form's own names for every box rendered. */
const FORM_FIELD_NAMES: ReadonlySet<string> = new Set([
  'vehicleTypeId',
  'productType',
  'date',
  'pickupTime',
  'dayUseEndTime',
  'customRouteDurationMinutes',
  'pax',
  'luggageCount',
  'dropoffAddress',
  'leadPhone',
  'priceInput',
  'pickup',
  'pickupMapUrl',
  'dropoffMapUrl',
  'flightNumber',
  'airline',
]);

/** The schema's field name, onto this form's own box name — only `priceCentavos` differs. */
function toFormFieldName(schemaField: string): string {
  return schemaField === 'priceCentavos' ? 'priceInput' : schemaField;
}

function initialValues(
  inquiry: InquiryAdminRow,
  defaultVehicleTypeId: string,
): Record<string, string> {
  return {
    vehicleTypeId: defaultVehicleTypeId,
    productType: 'transfer_one_way',
    date: inquiry.requestedDate ?? '',
    pickupTime: '',
    dayUseEndTime: '',
    customRouteDurationMinutes: '',
    pax: inquiry.pax === null ? '' : String(inquiry.pax),
    luggageCount: '0',
    dropoffAddress: '',
    leadPhone: inquiry.phone ?? '',
    priceInput: '',
    pickup: '',
    pickupMapUrl: '',
    dropoffMapUrl: '',
    flightNumber: '',
    airline: '',
  };
}

/** First zod issue per field, keyed by this form's own box names. */
function fieldErrorsFromIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = toFormFieldName(String(issue.path[0] ?? ''));
    if (!FORM_FIELD_NAMES.has(field) || field in out) continue;
    out[field] = issue.message;
  }
  return out;
}

export interface ConvertInquiryFormProps {
  inquiry: InquiryAdminRow;
  vehicleTypes: readonly VehicleTypeAdminRow[];
  onClose: () => void;
  onConverted: (bookingRef: string) => void;
}

export default function ConvertInquiryForm({
  inquiry,
  vehicleTypes,
  onClose,
  onConverted,
}: ConvertInquiryFormProps) {
  const utils = trpc.useUtils();
  const activeVehicleTypes = vehicleTypes.filter((type) => type.isActive);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(inquiry, activeVehicleTypes[0] ? String(activeVehicleTypes[0].id) : ''),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<TransferQuoteConvertInput | null>(null);

  const convert = trpc.admin.transferQuotes.convert.useMutation({
    onSuccess: (result) => {
      void utils.admin.inquiries.list.invalidate();
      onConverted(result.ref);
    },
    onError: (error) => {
      setPendingPayload(null);
      const rawFields = getFieldErrors(error);
      const formErrors = getFormErrors(error);
      if (rawFields !== null || formErrors.length > 0) {
        const fields: Record<string, string> = {};
        const leftover: string[] = [];
        for (const [rawField, message] of Object.entries(rawFields ?? {})) {
          const field = toFormFieldName(rawField);
          if (FORM_FIELD_NAMES.has(field)) fields[field] = message;
          else leftover.push(message);
        }
        setErrors(fields);
        setBanner(formErrors[0] ?? leftover[0] ?? null);
        return;
      }
      setBanner(describeError(error));
    },
  });

  function describeError(error: unknown): string {
    const validation = firstValidationMessage(error);
    if (validation !== null) return validation;
    if (
      error instanceof TRPCClientError &&
      typeof error.data?.httpStatus === 'number' &&
      error.data.httpStatus < 500
    ) {
      return error.message;
    }
    return 'Could not convert this request. Nothing was changed.';
  }

  const productType = (
    values.productType === 'transfer_day_use' ? 'transfer_day_use' : 'transfer_one_way'
  ) as TransferProductType;

  function setValue(name: string, nextValue: string) {
    setValues((current) => ({ ...current, [name]: nextValue }));
  }

  function onProductTypeChange(nextValue: string) {
    const clearedFields =
      nextValue === 'transfer_day_use' ? ONE_WAY_ONLY_FIELDS : DAY_USE_ONLY_FIELDS;
    setValues((current) => {
      const next: Record<string, string> = { ...current, productType: nextValue };
      for (const field of clearedFields) next[field] = '';
      return next;
    });
    setErrors((current) => {
      const next = { ...current };
      for (const field of clearedFields) delete next[field];
      return next;
    });
  }

  const fields: EntityFormField[] = [
    {
      name: 'vehicleTypeId',
      label: 'Vehicle type',
      type: 'select',
      required: true,
      options: activeVehicleTypes.map((type) => ({ value: String(type.id), label: type.name })),
    },
    {
      name: 'productType',
      label: 'Trip type',
      type: 'select',
      required: true,
      options: PRODUCT_TYPE_OPTIONS,
    },
    { name: 'date', label: 'Pickup date', type: 'date', required: true },
    {
      name: 'pickupTime',
      label: 'Pickup time',
      type: 'text',
      required: true,
      hint: 'HH:mm, 24-hour, Asia/Manila — e.g. 08:30.',
    },
    productType === 'transfer_day_use'
      ? {
          name: 'dayUseEndTime',
          label: 'Vehicle needed until',
          type: 'text',
          required: true,
          hint: 'HH:mm, 24-hour — e.g. 18:00.',
        }
      : {
          name: 'customRouteDurationMinutes',
          label: 'Trip duration (minutes)',
          type: 'number',
          required: true,
          hint: 'How long this one-way trip takes, confirmed with the guest.',
        },
    { name: 'pax', label: 'Passengers', type: 'number', required: true },
    { name: 'luggageCount', label: 'Luggage (bags)', type: 'number', required: true },
    { name: 'dropoffAddress', label: 'Drop-off address', type: 'text', required: true },
    {
      name: 'leadPhone',
      label: 'Phone we can call',
      type: 'text',
      required: true,
      hint: 'A PH mobile number — confirmed with the guest, not a placeholder.',
    },
    {
      name: 'priceInput',
      label: 'Quoted price (pesos)',
      type: 'text',
      required: true,
      hint: 'Up to two decimal places, e.g. 2500.00.',
    },
    { name: 'pickup', label: 'Pickup address', type: 'text' },
    { name: 'pickupMapUrl', label: 'Pickup map link', type: 'text' },
    { name: 'dropoffMapUrl', label: 'Drop-off map link', type: 'text' },
    ...(productType === 'transfer_day_use'
      ? []
      : [
          { name: 'flightNumber', label: 'Flight number', type: 'text' as const },
          { name: 'airline', label: 'Airline', type: 'text' as const },
        ]),
  ];

  function review() {
    setBanner(null);
    const value = (name: string) => values[name] ?? '';

    const priceCentavos = pesosToCentavos(value('priceInput'));
    if (priceCentavos === null) {
      setErrors({ priceInput: 'Enter a quoted price in pesos, e.g. 2500.00.' });
      return;
    }

    const base: Record<string, unknown> = {
      inquiryId: inquiry.id,
      vehicleTypeId: Number(value('vehicleTypeId')),
      productType,
      date: value('date').trim(),
      pickupTime: value('pickupTime').trim(),
      pax: Number(value('pax')),
      luggageCount: Number(value('luggageCount')),
      dropoffAddress: value('dropoffAddress').trim(),
      leadPhone: value('leadPhone').trim(),
      priceCentavos,
    };
    if (productType === 'transfer_day_use') {
      base.dayUseEndTime = value('dayUseEndTime').trim();
    } else {
      base.customRouteDurationMinutes = Number(value('customRouteDurationMinutes'));
      const flightNumber = value('flightNumber').trim();
      const airline = value('airline').trim();
      if (flightNumber !== '') base.flightNumber = flightNumber;
      if (airline !== '') base.airline = airline;
    }
    const pickup = value('pickup').trim();
    if (pickup !== '') base.pickup = pickup;
    const pickupMapUrl = value('pickupMapUrl').trim();
    if (pickupMapUrl !== '') base.pickupMapUrl = pickupMapUrl;
    const dropoffMapUrl = value('dropoffMapUrl').trim();
    if (dropoffMapUrl !== '') base.dropoffMapUrl = dropoffMapUrl;

    const parsed = transferQuoteConvertInput.safeParse(base);
    if (!parsed.success) {
      setErrors(fieldErrorsFromIssues(parsed.error.issues));
      return;
    }

    setErrors({});
    setPendingPayload(parsed.data);
  }

  const selectedVehicleType = activeVehicleTypes.find(
    (type) => String(type.id) === values.vehicleTypeId,
  );

  if (pendingPayload) {
    return (
      <div className="space-y-4">
        <p className="text-brand-ink text-sm font-semibold">
          Convert this request to a held booking for {inquiry.name}?
        </p>
        <p className="text-brand-ink text-sm">
          {formatPeso(pendingPayload.priceCentavos)} will be quoted —{' '}
          {pesosInWords(pendingPayload.priceCentavos)}.{' '}
          {selectedVehicleType ? `${selectedVehicleType.name}, ` : ''}
          {pendingPayload.date} at {pendingPayload.pickupTime}.
        </p>
        <p className="text-brand-error text-sm">
          This creates a real hold the guest must pay to keep — it does not charge them yet.
        </p>
        {banner ? (
          <p role="alert" className={ALERT}>
            {banner}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="primary-pill"
            disabled={convert.isPending}
            onClick={() => convert.mutate(pendingPayload)}
          >
            {convert.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Converting…
              </>
            ) : (
              'Confirm — convert to a booking'
            )}
          </Button>
          <Button
            type="button"
            variant="admin-ghost"
            disabled={convert.isPending}
            onClick={() => setPendingPayload(null)}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {banner ? (
        <p role="alert" className={ALERT}>
          {banner}
        </p>
      ) : null}

      <EntityForm
        fields={fields}
        values={values}
        errors={errors}
        pending={false}
        submitLabel="Review & convert"
        onChange={(name, nextValue) =>
          name === 'productType' ? onProductTypeChange(nextValue) : setValue(name, nextValue)
        }
        onSubmit={review}
        hideSubmit
      />

      <FormActions
        onCancel={onClose}
        saveLabel="Review & convert"
        submitType="button"
        onSave={review}
      />
    </div>
  );
}
