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
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { couponCreateInput, couponUpdateInput, formatPeso, type CouponAdminRow } from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
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

const STATUS_BADGE_CLASS: Record<'Active' | 'Inactive', string> = {
  Active: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  Inactive: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeCouponError(error: unknown, fallback: string): string {
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

/* ------------------------------------------------------------------- The form */

type DiscountType = 'percent' | 'fixed';

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

  const create = trpc.admin.coupons.create.useMutation({
    onSuccess: () => {
      void utils.admin.coupons.list.invalidate();
      onSaved('Coupon added.');
    },
    onError: (error) => setBanner(describeCouponError(error, 'Could not add this coupon.')),
  });
  const update = trpc.admin.coupons.update.useMutation({
    onSuccess: () => {
      void utils.admin.coupons.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => setBanner(describeCouponError(error, 'Could not save this coupon.')),
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
        onChange={(name, next) => setValues((current) => ({ ...current, [name]: next }))}
        onSubmit={submit}
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
       * `EntityForm`'s own submit button (above, "Add coupon" or "Save
       * changes") is the single save action for the whole coupon — the scalar
       * fields and the window together. Only Cancel needs a second control
       * down here, now that the window section is below it.
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
                    Tour date
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
      <Button type="button" variant="outline" size="sm" className={OUTLINE_BUTTON} onClick={onEdit}>
        Edit
      </Button>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className={OUTLINE_BUTTON}
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
            <Button
              type="button"
              size="sm"
              className={PRIMARY_BUTTON}
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: coupon.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${coupon.code}`}
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
            aria-label={`Deactivate ${coupon.code}`}
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
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Operations
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Coupons</h1>
        <p className="text-brand-error text-sm">
          Discount codes a guest types at checkout, and the bookings that have used them.
          Deactivating a code stops it being accepted and changes nothing a guest has already
          booked.
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
          Add a coupon
        </Button>
      ) : (
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
                  <div>
                    <p className="text-brand-ink font-semibold">{coupon.code}</p>
                    <p className="text-brand-ink">{discountInWords(coupon)}</p>
                  </div>
                  <Badge className={STATUS_BADGE_CLASS[statusLabel(coupon.isActive)]}>
                    {statusLabel(coupon.isActive)}
                  </Badge>
                </div>
                <p className="text-brand-error mt-2 text-xs">{minSpendInWords(coupon)}</p>
                <p className="text-brand-error text-xs">{windowInWords(coupon)}</p>
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
