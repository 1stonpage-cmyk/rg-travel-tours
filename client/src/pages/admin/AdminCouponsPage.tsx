/**
 * The coupon screens — codes, discounts, validity windows, usage caps, and
 * the redemption log (Week 7 plan, Task 8; BUILD_SPEC §9 "Coupons", client
 * half).
 *
 * `admin.coupons.*` is `adminProcedure('toursPricing')` server-side — owner
 * only, the same area as tours and pricing — so this screen offers no control
 * a dispatcher or finance role could use. It does not re-check the role itself
 * for enforcement (CLAUDE.md: hiding a button is not access control) but, the
 * same shape `AdminToursPage.tsx` uses, it shows a plain "owner only" denied
 * state rather than a blank page or raw data, from either of the two places a
 * non-owner could reach it: the role this session already knows
 * (`staffAuth.me`), and a refused `admin.coupons.list` call (a stale session,
 * or a role that changed mid-visit).
 *
 * ## Money and percentages
 *
 * A fixed discount is typed in pesos and converted to integer centavos at the
 * form boundary (`lib/money-input.ts`); a percentage is typed as a percent and
 * converted to integer BASIS POINTS (`lib/percent-input.ts`). The server never
 * sees a float or a peso string, and the payload is validated against the real
 * `couponCreateInput` / `couponUpdateInput` before it is posted — so the two
 * discount columns are already in a shape `coupons_discount_shape` accepts.
 *
 * ## The validity window is Manila wall clock, stored as UTC
 *
 * `coupons.starts_at` / `.ends_at` are UTC instants. The two
 * `<input type="datetime-local">` fields read Manila wall clock, which is what
 * an owner in Cebu means when they type a date, and `lib/manila-datetime.ts`
 * converts both ways. The fields sit in their own section rather than inside
 * `EntityForm`, which has no datetime field type and no place to say which
 * zone it means — the section says "Asia/Manila" in words, right beside them.
 *
 * ## There is no delete
 *
 * A coupon is retired with Deactivate, behind the same confirm-then-commit
 * `AdminToursPage.tsx` uses, and the word "Delete" appears nowhere. The
 * screen says what deactivating does and does not do, because the usage
 * numbers beside it stay exactly where they are: the bookings that already
 * used the code keep their discount.
 *
 * ## Two usage numbers, deliberately
 *
 * `coupons.used_count` is a cached counter and the `coupon_redemptions` rows
 * are the record. The list shows the counter ("3 of 50 used") and, when they
 * disagree, says so in words — a drift between them is the one thing this
 * screen can surface that a query nobody runs cannot.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  couponCreateInput,
  couponUpdateInput,
  formatPeso,
  type CouponAdminRow,
  type SignupSubscriberRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import FormActions from '@/components/admin/FormActions';
import { centavosToPesosInput, pesosToCentavos } from '@/lib/money-input';
import {
  manilaLocalToUtcIso,
  utcIsoToManilaLabel,
  utcIsoToManilaLocal,
} from '@/lib/manila-datetime';
import {
  basisPointsToPercentInput,
  basisPointsToPercentLabel,
  percentToBasisPoints,
} from '@/lib/percent-input';
import { firstValidationMessage, splitFieldErrors } from '@/lib/field-errors';
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

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeCouponError(error: unknown, fallback: string): string {
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

/** Is this refusal a role problem (401/403), as opposed to a network or server fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

/* ------------------------------------------------------------------ Wording */

/** "10% off" or "₱250 off" — the discount as a person would say it. */
function discountInWords(coupon: CouponAdminRow): string {
  if (coupon.discountType === 'percent') {
    // Null here would mean a row that `coupons_discount_shape` forbids; the
    // fallback exists for the type, not for a state the database allows.
    return coupon.percentBp === null
      ? 'Discount not set'
      : `${basisPointsToPercentLabel(coupon.percentBp)} off`;
  }
  return coupon.amountCentavos === null
    ? 'Discount not set'
    : `${formatPeso(coupon.amountCentavos)} off`;
}

/** "3 of 50 used", or "3 used" when there is no cap. */
function usageInWords(coupon: CouponAdminRow): string {
  return coupon.usageLimit === null
    ? `${coupon.usedCount} used`
    : `${coupon.usedCount} of ${coupon.usageLimit} used`;
}

/** "No minimum" or "Minimum spend ₱2,000". */
function minSpendInWords(coupon: CouponAdminRow): string {
  return coupon.minSpendCentavos === null
    ? 'No minimum spend'
    : `Minimum spend ${formatPeso(coupon.minSpendCentavos)}`;
}

/** The validity window in Manila wall clock, in words. */
function windowInWords(coupon: CouponAdminRow): string {
  const from = coupon.startsAt === null ? null : utcIsoToManilaLabel(coupon.startsAt);
  const until = coupon.endsAt === null ? null : utcIsoToManilaLabel(coupon.endsAt);
  if (from === null && until === null) return 'No date limit';
  if (from !== null && until !== null) return `${from} to ${until}`;
  return from !== null ? `From ${from}` : `Until ${until}`;
}

/**
 * The one place this screen says the counter and the record disagree.
 *
 * `used_count` is a cache over `coupon_redemptions`; they are written in one
 * transaction, so a mismatch means something went wrong somewhere else — and
 * an owner reading "3 of 50 used" deserves to be told when the rows say two.
 */
function driftInWords(coupon: CouponAdminRow): string | null {
  if (coupon.usedCount === coupon.redemptionCount) return null;
  return `Counter says ${coupon.usedCount}, the redemption log has ${coupon.redemptionCount}.`;
}

/**
 * Display only (owner decision, 2026-10-27, batch-3 answer 1). `validateCoupon`
 * already refuses an inverted window cleanly at checkout — this is not a
 * validation gap, just a sentence so an owner reading the list notices before
 * a guest ever tries the code.
 */
function windowWarningInWords(coupon: CouponAdminRow): string | null {
  if (coupon.startsAt === null || coupon.endsAt === null) return null;
  if (new Date(coupon.endsAt).getTime() >= new Date(coupon.startsAt).getTime()) return null;
  return 'This window ends before it starts — the code will never be accepted.';
}

/* ------------------------------------------------------------------- The form */

type DiscountType = 'percent' | 'fixed';

/**
 * The field names `EntityForm` renders here, for `splitFieldErrors` (task
 * A4). `scalarFields()` builds the same list per discount type and the names
 * never vary with it, so this is written once rather than derived per call.
 */
const COUPON_FIELD_NAMES: ReadonlySet<string> = new Set([
  'code',
  'discountType',
  'discountValue',
  'minSpend',
  'usageLimit',
]);

function scalarFields(discountType: DiscountType): EntityFormField[] {
  return [
    {
      name: 'code',
      label: 'Code',
      type: 'text',
      required: true,
      hint: 'What a guest types at checkout. Saved in capitals, so SAVE10 and save10 are the same code.',
    },
    {
      name: 'discountType',
      label: 'Discount type',
      type: 'select',
      required: true,
      options: [
        { value: 'percent', label: 'Percentage off' },
        { value: 'fixed', label: 'Fixed amount off' },
      ],
    },
    {
      name: 'discountValue',
      label: discountType === 'percent' ? 'Discount (%)' : 'Discount (pesos)',
      type: 'text',
      required: true,
      hint:
        discountType === 'percent'
          ? 'Up to two decimal places, e.g. 10 or 2.5. Maximum 100.'
          : 'Up to two decimal places, e.g. 250.00.',
    },
    {
      name: 'minSpend',
      label: 'Minimum spend (pesos)',
      type: 'text',
      hint: 'Leave blank for no minimum.',
    },
    {
      name: 'usageLimit',
      label: 'Total uses allowed',
      type: 'number',
      hint: 'Leave blank for unlimited.',
    },
  ];
}

function scalarValuesFromCoupon(coupon: CouponAdminRow | null): Record<string, string> {
  if (!coupon) {
    return {
      code: '',
      discountType: 'percent',
      discountValue: '',
      minSpend: '',
      usageLimit: '',
    };
  }
  return {
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue:
      coupon.discountType === 'percent'
        ? coupon.percentBp === null
          ? ''
          : basisPointsToPercentInput(coupon.percentBp)
        : coupon.amountCentavos === null
          ? ''
          : centavosToPesosInput(coupon.amountCentavos),
    minSpend: coupon.minSpendCentavos === null ? '' : centavosToPesosInput(coupon.minSpendCentavos),
    usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
  };
}

/** First zod issue per field, keyed by the FORM's field name. */
function fieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  /*
   * The form's names and the schema's keys are not the same vocabulary: one
   * "discountValue" input stands for whichever of `percentBp` /
   * `amountCentavos` the chosen type uses, and the peso/percent fields are
   * named for what is typed rather than for the column. Mapping here keeps
   * every refusal beside the input that caused it (`ui-ux-pro-max`, Forms /
   * Error Placement: an inline error connected to that field, never a summary
   * alone).
   */
  const byKey: Record<string, string> = {
    code: 'code',
    percentBp: 'discountValue',
    amountCentavos: 'discountValue',
    discountType: 'discountType',
    minSpendCentavos: 'minSpend',
    usageLimit: 'usageLimit',
    startsAt: 'startsAt',
    endsAt: 'endsAt',
  };
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = byKey[String(issue.path[0] ?? '')];
    if (!field || field in out) continue;
    out[field] = issue.message;
  }
  return out;
}

function CouponForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: CouponAdminRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();

  const [values, setValues] = useState<Record<string, string>>(() =>
    scalarValuesFromCoupon(initial),
  );
  const [startsAt, setStartsAt] = useState<string>(() =>
    initial?.startsAt ? utcIsoToManilaLocal(initial.startsAt) : '',
  );
  const [endsAt, setEndsAt] = useState<string>(() =>
    initial?.endsAt ? utcIsoToManilaLocal(initial.endsAt) : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  /*
   * Task A4. A validation refusal's messages go to the inputs they name;
   * anything the form has no box for stays in the banner rather than being
   * dropped. `percentBp`/`amountCentavos` are that case — the form has one
   * `discountValue` box in human units — and so are `startsAt`/`endsAt`,
   * which are their own datetime controls outside `EntityForm`.
   */
  function reportSaveError(error: unknown, fallback: string) {
    const validation = splitFieldErrors(error, COUPON_FIELD_NAMES);
    if (validation) {
      setErrors(validation.fields);
      setBanner(validation.banner);
      return;
    }
    setBanner(describeCouponError(error, fallback));
  }

  const create = trpc.admin.coupons.create.useMutation({
    onSuccess: () => {
      void utils.admin.coupons.list.invalidate();
      onSaved('Coupon added.');
    },
    onError: (error) => reportSaveError(error, 'Could not add this coupon.'),
  });
  const update = trpc.admin.coupons.update.useMutation({
    onSuccess: () => {
      void utils.admin.coupons.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => reportSaveError(error, 'Could not save this coupon.'),
  });
  const pending = create.isPending || update.isPending;

  const discountType = (values.discountType === 'fixed' ? 'fixed' : 'percent') as DiscountType;

  function submit() {
    setBanner(null);
    const next: Record<string, string> = {};
    const value = (name: string) => (values[name] ?? '').trim();

    /*
     * The two discount columns, from the ONE value an owner typed. The unused
     * column is explicitly `null` rather than omitted: the shared input is a
     * discriminated union whose members require both keys, which is how the
     * payload and `coupons_discount_shape` end up agreeing by construction.
     */
    const typed = value('discountValue');
    const percentBp = discountType === 'percent' ? percentToBasisPoints(typed) : null;
    const amountCentavos = discountType === 'fixed' ? pesosToCentavos(typed) : null;
    if (discountType === 'percent' && percentBp === null) {
      next.discountValue = 'Enter a percentage, e.g. 10 or 2.5.';
    }
    if (discountType === 'fixed' && amountCentavos === null) {
      next.discountValue = 'Enter an amount in pesos, e.g. 250.00.';
    }

    const minSpendRaw = value('minSpend');
    const minSpendCentavos = minSpendRaw === '' ? null : pesosToCentavos(minSpendRaw);
    if (minSpendRaw !== '' && minSpendCentavos === null) {
      next.minSpend = 'Enter an amount in pesos, e.g. 2000.00, or leave it blank.';
    }

    const startsIso = startsAt.trim() === '' ? null : manilaLocalToUtcIso(startsAt);
    if (startsAt.trim() !== '' && startsIso === null) {
      next.startsAt = 'Enter a date and time, or leave it blank.';
    }
    const endsIso = endsAt.trim() === '' ? null : manilaLocalToUtcIso(endsAt);
    if (endsAt.trim() !== '' && endsIso === null) {
      next.endsAt = 'Enter a date and time, or leave it blank.';
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    const usageRaw = value('usageLimit');
    const payload = {
      code: value('code'),
      discountType,
      percentBp,
      amountCentavos,
      minSpendCentavos,
      startsAt: startsIso,
      endsAt: endsIso,
      usageLimit: usageRaw === '' ? null : Number(usageRaw),
    };

    const toValidate = mode === 'edit' ? { ...payload, id: initial!.id } : payload;
    const schema = mode === 'edit' ? couponUpdateInput : couponCreateInput;
    const parsed = schema.safeParse(toValidate);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
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
        fields={scalarFields(discountType)}
        values={values}
        errors={errors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add coupon'}
        onChange={(name, next) =>
          setValues((current) => ({
            ...current,
            [name]: next,
            /*
             * Switching discount type carries the typed NUMBER across units
             * (7N, Task 8): a `10` meant as 10% silently became ₱10.00 once
             * the type flipped to fixed, with no re-type and no warning.
             * Clearing the value on the one field whose meaning just
             * changed is cheaper than guessing a conversion nobody asked
             * for, and matches `scalarValuesFromCoupon`'s own blank default
             * for a type with no existing amount.
             */
            ...(name === 'discountType' ? { discountValue: '' } : {}),
          }))
        }
        onSubmit={submit}
        hideSubmit
      />

      <div className={SECTION}>
        <h3 className="text-brand-ink text-sm font-bold">When the coupon is valid</h3>
        <p className="text-brand-error mt-1 text-xs">
          Times are Asia/Manila. Leave a field blank for no limit — blank on both means the coupon
          runs until it is switched off.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <div className="min-w-0 flex-[1_1_220px] space-y-1">
            <Label htmlFor="coupon-starts-at">Starts (optional)</Label>
            <Input
              id="coupon-starts-at"
              type="datetime-local"
              className={`${FIELD} w-full`}
              value={startsAt}
              aria-invalid={errors.startsAt ? true : undefined}
              aria-describedby={errors.startsAt ? 'coupon-starts-at-error' : undefined}
              onChange={(event) => setStartsAt(event.target.value)}
            />
            {errors.startsAt ? (
              <p id="coupon-starts-at-error" role="alert" className={ROW_ERROR}>
                {errors.startsAt}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 flex-[1_1_220px] space-y-1">
            <Label htmlFor="coupon-ends-at">Ends (optional)</Label>
            <Input
              id="coupon-ends-at"
              type="datetime-local"
              className={`${FIELD} w-full`}
              value={endsAt}
              aria-invalid={errors.endsAt ? true : undefined}
              aria-describedby={errors.endsAt ? 'coupon-ends-at-error' : undefined}
              onChange={(event) => setEndsAt(event.target.value)}
            />
            {errors.endsAt ? (
              <p id="coupon-ends-at-error" role="alert" className={ROW_ERROR}>
                {errors.endsAt}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/*
       * The single save action for the whole coupon — the scalar fields and
       * the validity window together — now sits in this footer, after the
       * window section, paired with Cancel (B2, DEMO POLISH batch,
       * 2026-11-09): `EntityForm`'s own submit button used to render ABOVE
       * the window section while Cancel sat alone below it.
       */}
      <FormActions
        onCancel={onClose}
        saveLabel={mode === 'edit' ? 'Save changes' : 'Add coupon'}
        pending={pending}
        submitType="button"
        onSave={submit}
      />
    </div>
  );
}

/* --------------------------------------------------------- The redemption log */

function RedemptionLog({ coupon }: { coupon: CouponAdminRow }) {
  const log = trpc.admin.coupons.redemptions.useQuery({ couponId: coupon.id }, { retry: false });

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-brand-ink text-lg font-bold">
          Redemptions of {coupon.code}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {log.isPending ? (
          <p className="text-brand-error flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading redemptions…
          </p>
        ) : log.isError ? (
          <p role="alert" className={ALERT}>
            {describeCouponError(log.error, 'Could not load the redemption log. Try again.')}
          </p>
        ) : log.data.length === 0 ? (
          <p className="text-brand-error text-sm">Nobody has used this coupon yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="text-brand-error pb-2 text-left text-xs">
                {log.data.length} {log.data.length === 1 ? 'booking' : 'bookings'}, most recent
                first.
              </caption>
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Booking
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Trip date
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Discount given
                  </th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((row) => (
                  <tr key={row.id} className="border-brand-blue-100 border-b last:border-0">
                    <td className="text-brand-ink px-3 py-2 font-semibold">{row.bookingRef}</td>
                    <td className="text-brand-ink px-3 py-2">{row.tourDate}</td>
                    <td className="text-brand-ink px-3 py-2">{row.bookingStatus}</td>
                    <td className="text-brand-ink px-3 py-2">{formatPeso(row.discountCentavos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ Row actions */

function statusLabel(isActive: boolean): 'Active' | 'Inactive' {
  return isActive ? 'Active' : 'Inactive';
}

/**
 * Edit, the soft delete behind a two-step confirm, and the log toggle.
 *
 * The confirm names the coupon, because a list of codes is easy to misread,
 * and it says "Deactivate" rather than "Delete" because that is what the
 * server does — nothing is removed.
 */
function CouponActions({
  coupon,
  onEdit,
  logOpen,
  onToggleLog,
}: {
  coupon: CouponAdminRow;
  onEdit: () => void;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.coupons.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.coupons.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(
        describeCouponError(error, 'Could not change this coupon. Nothing was changed.'),
      );
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="row" onClick={onEdit}>
        Edit
      </Button>

      <Button
        type="button"
        variant="row"
        aria-expanded={logOpen}
        aria-label={`${logOpen ? 'Hide' : 'Show'} redemptions of ${coupon.code}`}
        onClick={onToggleLog}
      >
        {logOpen ? 'Hide redemptions' : `Redemptions (${coupon.redemptionCount})`}
      </Button>

      {coupon.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${coupon.code}`}
            className="flex flex-wrap items-center gap-2"
          >
            {/*
             * BUG FIX (same shape as AdminVehicleTypesPage's destructive-
             * confirm fix): this was a solid blue `PRIMARY_BUTTON` for an
             * actual destructive confirm, contradicting owner decision 1
             * ("Deactivate = amber outline pill. Never red"). `whitespace-
             * normal` overrides the variant's own `whitespace-nowrap` (7N,
             * Task 8): a 40-character code makes "Yes, deactivate <code>"
             * the longest string on this screen, and nowrap pushed it past
             * the card's edge at 360px.
             */}
            <Button
              type="button"
              variant="row-amber"
              className="whitespace-normal"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: coupon.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${coupon.code}`}
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
            aria-label={`Deactivate ${coupon.code}`}
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
          aria-label={`Reactivate ${coupon.code}`}
          onClick={() => setActive.mutate({ id: coupon.id, isActive: true })}
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

/* ------------------------------------------------------------ Sign-up coupons */

/**
 * The "Sign-up coupons" section (sign-up coupons plan, Task 1C, decision 5):
 * the % and expiry the newsletter form mints codes with, the subscriber
 * list and its count, and the CSV export (moved here from
 * `AdminPackagesPage.tsx`, since both are owner-only, `usersSettings`
 * disclosures about the same table).
 *
 * Every piece on this page is already owner-only — `AdminCouponsPage`'s own
 * role check and `CouponsAdmin`'s second denial layer both run before this
 * ever mounts — so no third denial layer is added here. `admin.newsletter.*`
 * and `admin.settings.*` are `usersSettings`, the SAME area `admin.coupons.*`
 * is `toursPricing` under, both owner-only; a role that loses one grant but
 * keeps the other is not a case this codebase's role matrix produces.
 */

/** `signupCouponSchema`'s own bounds (`server/src/content/settings-schema.ts`). */
const MIN_DISCOUNT_PERCENT = 1;
const MAX_DISCOUNT_PERCENT = 100;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 365;

interface SignupCouponSetting {
  discountPercent: number;
  expiryDays: number;
}

function isSignupCouponSetting(value: unknown): value is SignupCouponSetting {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.discountPercent === 'number' && typeof record.expiryDays === 'number';
}

/** The two field names this form renders, for `splitFieldErrors`. */
const SIGNUP_COUPON_FIELD_NAMES: ReadonlySet<string> = new Set(['discountPercent', 'expiryDays']);

/**
 * The % off and expiry window a sign-up code is minted with.
 *
 * A second, more convenient place to edit the SAME `signup_coupon` settings
 * row the generic Settings screen already covers (`AdminSettingsPage.tsx`,
 * "Payments" group) — not a replacement for it. Numbers are typed and sent
 * as whole numbers, matching `signupCouponSchema`'s own `z.number().int()`
 * bounds, which is why this form does none of the peso/basis-point unit
 * conversion `CouponForm` above does: there is no unit to convert.
 */
function SignupCouponSettingsForm({ stored }: { stored: unknown }) {
  const utils = trpc.useUtils();
  const initial = isSignupCouponSetting(stored) ? stored : null;

  const [discountPercent, setDiscountPercent] = useState(
    initial ? String(initial.discountPercent) : '',
  );
  const [expiryDays, setExpiryDays] = useState(initial ? String(initial.expiryDays) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const write = trpc.admin.settings.write.useMutation({
    onSuccess: () => {
      setBanner(null);
      setErrors({});
      setNotice('Saved.');
      void utils.admin.settings.all.invalidate();
    },
    onError: (error) => {
      setNotice(null);
      const validation = splitFieldErrors(error, SIGNUP_COUPON_FIELD_NAMES);
      if (validation) {
        setErrors(validation.fields);
        setBanner(validation.banner);
        return;
      }
      setBanner(
        describeCouponError(
          error,
          'Could not save the sign-up coupon settings. Nothing was changed.',
        ),
      );
    },
  });

  function submit() {
    setBanner(null);
    setNotice(null);
    const next: Record<string, string> = {};

    const percentRaw = discountPercent.trim();
    const percentValue = Number(percentRaw);
    const percentValid =
      percentRaw !== '' &&
      Number.isInteger(percentValue) &&
      percentValue >= MIN_DISCOUNT_PERCENT &&
      percentValue <= MAX_DISCOUNT_PERCENT;
    if (!percentValid) {
      next.discountPercent = `Enter a whole number from ${MIN_DISCOUNT_PERCENT} to ${MAX_DISCOUNT_PERCENT}.`;
    }

    const daysRaw = expiryDays.trim();
    const daysValue = Number(daysRaw);
    const daysValid =
      daysRaw !== '' &&
      Number.isInteger(daysValue) &&
      daysValue >= MIN_EXPIRY_DAYS &&
      daysValue <= MAX_EXPIRY_DAYS;
    if (!daysValid) {
      next.expiryDays = `Enter a whole number from ${MIN_EXPIRY_DAYS} to ${MAX_EXPIRY_DAYS}.`;
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setErrors({});
    write.mutate({
      key: 'signup_coupon',
      value: { discountPercent: percentValue, expiryDays: daysValue },
    });
  }

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-brand-ink text-lg font-bold">Sign-up coupon settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-brand-error text-sm">
          The discount and expiry a newsletter sign-up code is minted with. Changing this affects
          only codes minted after Save — a code already issued keeps the percent and expiry it was
          given.
        </p>

        {banner ? (
          <p role="alert" className={ALERT}>
            {banner}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className={NOTICE}>
            {notice}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="signup-coupon-discount-percent">Discount percentage</Label>
            <Input
              id="signup-coupon-discount-percent"
              type="number"
              step="1"
              className={FIELD}
              value={discountPercent}
              aria-invalid={errors.discountPercent ? true : undefined}
              aria-describedby={
                errors.discountPercent ? 'signup-coupon-discount-percent-error' : undefined
              }
              onChange={(event) => setDiscountPercent(event.target.value)}
            />
            {errors.discountPercent ? (
              <p id="signup-coupon-discount-percent-error" role="alert" className={ROW_ERROR}>
                {errors.discountPercent}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="signup-coupon-expiry-days">Expires after (days)</Label>
            <Input
              id="signup-coupon-expiry-days"
              type="number"
              step="1"
              className={FIELD}
              value={expiryDays}
              aria-invalid={errors.expiryDays ? true : undefined}
              aria-describedby={errors.expiryDays ? 'signup-coupon-expiry-days-error' : undefined}
              onChange={(event) => setExpiryDays(event.target.value)}
            />
            {errors.expiryDays ? (
              <p id="signup-coupon-expiry-days-error" role="alert" className={ROW_ERROR}>
                {errors.expiryDays}
              </p>
            ) : null}
          </div>
        </div>

        {/* secondary-pill, not primary-pill: the page's one true primary is
            the header's "Add a coupon" CRUD action (CLAUDE.md "one primary
            pill per visible region"), the same precedent AdminPackagesPage.tsx
            already set for its own always-visible Newsletter-card action. */}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="secondary-pill"
            disabled={write.isPending}
            onClick={submit}
          >
            {write.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** "Unused" / "Used on RG-7KQ4M9" / "Expired" / "No code yet". */
function subscriberStatusInWords(row: SignupSubscriberRow): string {
  switch (row.status) {
    case 'none':
      return 'No code yet';
    case 'unused':
      return 'Unused';
    case 'used':
      return row.usedBookingRef ? `Used on ${row.usedBookingRef}` : 'Used';
    case 'expired':
      return 'Expired';
  }
}

const SUBSCRIBER_STATUS_BADGE_CLASS: Record<SignupSubscriberRow['status'], string> = {
  none: 'border-0 bg-slate-100 text-brand-ink',
  unused: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  used: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  expired: 'border-0 bg-brand-gold-100 text-brand-gold-800',
};

/**
 * Every newsletter subscriber, their minted code (if any) and its status —
 * the on-screen counterpart of the CSV export below, read through
 * `admin.newsletter.list` rather than `export`. See that procedure's own
 * doc comment for why viewing this is not the same disclosure event as
 * downloading the file.
 */
function SignupSubscribersList({ rows }: { rows: SignupSubscriberRow[] }) {
  return (
    <div className="space-y-3">
      <p className="text-brand-ink text-sm font-semibold">
        {rows.length === 1 ? '1 sign-up' : `${rows.length} sign-ups`}
      </p>

      {rows.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>No newsletter sign-ups yet.</p>
      ) : (
        <>
          {/* Phone: one card per subscriber. */}
          <ul className="space-y-3 md:hidden">
            {rows.map((row) => (
              <li key={row.email} className={`${CARD} p-4 text-sm`}>
                <p className="text-brand-ink max-w-full break-all font-semibold">{row.email}</p>
                <p className="text-brand-error text-xs">
                  Signed up {utcIsoToManilaLabel(row.createdAt)}
                </p>
                <p className="text-brand-ink mt-1 max-w-full break-all">{row.code ?? '—'}</p>
                <Badge className={`${SUBSCRIBER_STATUS_BADGE_CLASS[row.status]} mt-2`}>
                  {subscriberStatusInWords(row)}
                </Badge>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="signup-subscribers-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Signed up
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.email} className="border-brand-blue-100 border-b last:border-0">
                    <td className="text-brand-ink max-w-0 break-all px-4 py-3">{row.email}</td>
                    <td className="text-brand-ink px-4 py-3">
                      {utcIsoToManilaLabel(row.createdAt)}
                    </td>
                    <td className="text-brand-ink max-w-0 break-all px-4 py-3">
                      {row.code ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={SUBSCRIBER_STATUS_BADGE_CLASS[row.status]}>
                        {subscriberStatusInWords(row)}
                      </Badge>
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
 * A UTF-8 byte-order mark.
 *
 * Excel on Windows guesses a CSV's encoding and gets it wrong without this.
 * Built from its code point rather than typed, because the literal character
 * is invisible in a diff and `no-irregular-whitespace` rightly refuses it in
 * source. (The same constant, for the same reason, as `AdminReportsPage.tsx`
 * — and, until this task moved it here, `AdminPackagesPage.tsx`.)
 */
const BOM = String.fromCharCode(0xfeff);

/** Hands the browser a file built from a string it already has. */
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The owner-only CSV export, moved here from `AdminPackagesPage.tsx`
 * (sign-up coupons plan, Task 1C, decision 5) — the subscriber list belongs
 * beside the coupons it now mints, not beside packages. The server
 * procedure, `admin.newsletter.export`, is unchanged.
 *
 * A MUTATION rather than a query, because the server audits the export — an
 * export of every subscriber's address is a disclosure under RA 10173, so it
 * is an event rather than a read, and a query that writes must never be
 * retried or prefetched. See `server/src/routers/admin/newsletter.ts`.
 */
function NewsletterExportCard() {
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportList = trpc.admin.newsletter.export.useMutation({
    onSuccess: (file) => {
      setError(null);
      setResult({ count: file.count });
      downloadCsv(file.filename, file.csv);
    },
    onError: () => {
      setResult(null);
      setError('Could not build that file. Try again in a moment.');
    },
  });

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-brand-ink text-lg font-bold">Newsletter list</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-brand-error text-sm">
          Everybody who has signed up on the site, as a CSV with one address per line. Subscriber
          addresses are personal data — the download is recorded against your account, and only the
          owner can take it.
        </p>
        <Button
          type="button"
          variant="secondary-pill"
          disabled={exportList.isPending}
          onClick={() => exportList.mutate()}
        >
          {exportList.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="mr-2 size-4" aria-hidden="true" />
          )}
          Export the newsletter list (CSV)
        </Button>
        {result ? (
          <p role="status" className={NOTICE}>
            {result.count === 1 ? '1 address' : `${result.count} addresses`} downloaded.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The whole "Sign-up coupons" section: settings, subscriber list, export.
 * Each query is read independently, so one failing does not blank the
 * others — the same "small inline could not load message" convention
 * `RedemptionLog` already follows on this page.
 */
function SignupCouponsSection() {
  const settings = trpc.admin.settings.all.useQuery(undefined, { retry: false });
  const subscribers = trpc.admin.newsletter.list.useQuery(undefined, { retry: false });

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-brand-ink -mb-1 text-lg font-bold">Sign-up coupons</h2>
      <p className="text-brand-error text-sm">
        The newsletter sign-up form mints one of these codes per address. The settings below decide
        every code minted from now on; the list is every address that has ever signed up.
      </p>

      {settings.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading settings…
        </p>
      ) : settings.isError ? (
        <p role="alert" className={ALERT}>
          Could not load the sign-up coupon settings. Try again in a moment.
        </p>
      ) : (
        <SignupCouponSettingsForm stored={settings.data.signup_coupon} />
      )}

      {subscribers.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading sign-ups…
        </p>
      ) : subscribers.isError ? (
        <p role="alert" className={ALERT}>
          Could not load the sign-up list. Try again in a moment.
        </p>
      ) : (
        <SignupSubscribersList rows={subscribers.data} />
      )}

      <NewsletterExportCard />
    </div>
  );
}

/** The same denied markup `AdminToursPage.tsx` renders, for both denial layers. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Coupons</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can manage coupons.
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

function CouponsAdmin() {
  const list = trpc.admin.coupons.list.useQuery(undefined, { retry: false });
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [logId, setLogId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The second denial layer: the ROLE check in `AdminCouponsPage` only catches
  // a session this client already knows is not the owner. A session that LOOKS
  // like an owner to this page but whose `toursPricing` grant the server has
  // since revoked only surfaces here, when the list itself comes back refused.
  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const coupons = list.data ?? [];
  const editing = typeof editingId === 'number' ? coupons.find((c) => c.id === editingId) : null;
  const logCoupon = logId === null ? null : coupons.find((c) => c.id === logId);

  function closeEditor(message: string) {
    setEditingId(null);
    setNotice(message);
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        eyebrow="Operations"
        title="Coupons"
        description="Discount codes a guest types at checkout, and the bookings that have used them. Deactivating a code stops it being accepted and changes nothing a guest has already booked."
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
              Add a coupon
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
              {editingId === 'new' ? 'Add a coupon' : 'Edit coupon'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CouponForm
              key={editingId}
              mode={editingId === 'new' ? 'create' : 'edit'}
              initial={editing ?? null}
              onClose={() => setEditingId(null)}
              onSaved={closeEditor}
            />
          </CardContent>
        </Card>
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Codes</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading coupons…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the coupons. Sign in again, or try once more in a moment.
        </p>
      ) : coupons.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No coupons yet — add the first one above.
        </p>
      ) : (
        <>
          {/* Phone: one card per coupon. */}
          <ul className="space-y-3 md:hidden">
            {coupons.map((coupon) => (
              <li key={coupon.id} className={`${CARD} p-4 text-sm`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 max-w-full">
                    {/* A code can run to 40 characters with no spaces — `break-all`
                        so one long, unspaced token wraps instead of overflowing
                        the card at 360px (7N, Task 8). */}
                    <p className="text-brand-ink max-w-full break-all font-semibold">
                      {coupon.code}
                    </p>
                    <p className="text-brand-ink">{discountInWords(coupon)}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(coupon.isActive)]}>
                    {statusLabel(coupon.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-error mt-2 text-xs">{minSpendInWords(coupon)}</p>
                <p className="text-brand-error text-xs">{windowInWords(coupon)}</p>
                {windowWarningInWords(coupon) ? (
                  <p role="alert" className={`${ALERT} mt-2`}>
                    {windowWarningInWords(coupon)}
                  </p>
                ) : null}
                <p className="text-brand-ink mt-1">{usageInWords(coupon)}</p>
                {driftInWords(coupon) ? (
                  <p role="alert" className={`${ALERT} mt-2`}>
                    {driftInWords(coupon)}
                  </p>
                ) : null}
                <div className="mt-3">
                  <CouponActions
                    coupon={coupon}
                    onEdit={() => setEditingId(coupon.id)}
                    logOpen={logId === coupon.id}
                    onToggleLog={() => setLogId(logId === coupon.id ? null : coupon.id)}
                  />
                </div>
              </li>
            ))}
          </ul>

          {/* Laptop and up: the table, inside its own horizontal scroll container. */}
          <div
            data-testid="coupons-table-wrapper"
            className={`${CARD} hidden overflow-x-auto md:block`}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Discount
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Conditions
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Usage
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
                {coupons.map((coupon) => (
                  <tr
                    key={coupon.id}
                    className="border-brand-blue-100 hover:bg-brand-blue-50/50 border-b transition-colors last:border-0"
                  >
                    <td className="text-brand-ink px-4 py-3 font-semibold">{coupon.code}</td>
                    <td className="text-brand-ink px-4 py-3">{discountInWords(coupon)}</td>
                    <td className="text-brand-ink px-4 py-3">
                      <span className="block">{minSpendInWords(coupon)}</span>
                      <span className="text-brand-error block text-xs">
                        {windowInWords(coupon)}
                      </span>
                      {windowWarningInWords(coupon) ? (
                        <span
                          role="alert"
                          className="text-brand-gold-800 block text-xs font-medium"
                        >
                          {windowWarningInWords(coupon)}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-brand-ink px-4 py-3">
                      <span className="block">{usageInWords(coupon)}</span>
                      {driftInWords(coupon) ? (
                        <span
                          role="alert"
                          className="text-brand-gold-800 block text-xs font-medium"
                        >
                          {driftInWords(coupon)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE_CLASS[statusLabel(coupon.isActive)]}>
                        {statusLabel(coupon.isActive)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <CouponActions
                        coupon={coupon}
                        onEdit={() => setEditingId(coupon.id)}
                        logOpen={logId === coupon.id}
                        onToggleLog={() => setLogId(logId === coupon.id ? null : coupon.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {logCoupon ? <RedemptionLog coupon={logCoupon} /> : null}
        </>
      )}

      <SignupCouponsSection />
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.coupons`
 * call from anyone but the owner. This just stops a dispatcher or finance user
 * who types the address from being shown a form that can only be refused. The
 * second denial layer — a refused `admin.coupons.list` this role check did not
 * catch — lives inside `CouponsAdmin`, beside the query it guards.
 */
export default function AdminCouponsPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <CouponsAdmin />;
}
