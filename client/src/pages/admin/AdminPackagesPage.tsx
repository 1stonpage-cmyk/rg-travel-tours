/**
 * Packages, the enquiries about them, and the newsletter export (Week 7 plan,
 * Task 13 — 7C; BUILD_SPEC §9 "Packages: multi-day packages and their
 * inquiries", client half).
 *
 * ## One screen, TWO server gates
 *
 * `admin.packages.*` and `admin.inquiries.*` are
 * `adminProcedure('packagesInquiries')` — owner and dispatcher, never finance.
 * `admin.newsletter.export` is `adminProcedure('usersSettings')` — **owner
 * only**. That is owner decision 2026-10-23 (Q3, option c), and it is why this
 * page draws the export button for an owner and not for a dispatcher.
 *
 * **That button's absence is cosmetic** (CLAUDE.md: hiding a button is not
 * access control). The server refuses a dispatcher's export with `FORBIDDEN`
 * whether or not the button was drawn, and `admin-packages.test.ts` is what
 * proves it. What the hidden button buys is that a dispatcher is not shown a
 * control that can only refuse them.
 *
 * The role-denied state follows the same two-layer shape `AdminCouponsPage.tsx`
 * and `AdminReviewsPage.tsx` use: the role this session already knows
 * (`staffAuth.me`), and a refused `admin.packages.list` call (a stale session,
 * or a role that changed mid-visit).
 *
 * ## Money
 *
 * Both prices are typed in pesos and converted to integer centavos at the form
 * boundary (`lib/money-input.ts`), and the payload is validated against the
 * real `packageCreateInput` / `packageUpdateInput` before it is posted — so a
 * "was" price that is not actually higher, and an image with no alt text, are
 * refused beside the field that caused them rather than as a server error.
 *
 * ## There is no delete
 *
 * A package is retired with Deactivate, behind the same confirm-then-commit
 * `AdminCouponsPage.tsx` uses, and the word "Delete" appears nowhere. The
 * screen says what deactivating does and does not do: the enquiries about it
 * stay exactly where they are.
 *
 * ## An enquiry's status is the whole of what an admin can change
 *
 * The guest's words are read-only here — the server offers no way to edit them
 * and should not. All four statuses are offered, `new` included, because
 * putting a wrongly-closed enquiry back into the waiting count is the one
 * correction an office actually needs (see `inquiryStatusInput`).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  formatPeso,
  INQUIRY_STATUS_LABELS,
  INQUIRY_STATUSES,
  packageCreateInput,
  packageUpdateInput,
  type InquiryAdminRow,
  type InquiryStatus,
  type PackageAdminRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EntityForm, { type EntityFormField } from '@/components/admin/EntityForm';
import { centavosToPesosInput, pesosToCentavos } from '@/lib/money-input';
import { utcIsoToManilaLabel } from '@/lib/manila-datetime';
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

/** Amber for "needs attention", neutral for a decided enquiry. Never red. */
const INQUIRY_BADGE_CLASS: Record<InquiryStatus, string> = {
  new: 'border-0 bg-brand-gold-100 text-brand-gold-800',
  read: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  replied: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  closed: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeError(error: unknown, fallback: string): string {
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

/** "3 days" / "1 day". */
function daysInWords(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "2 enquiries" / "1 enquiry" / "No enquiries yet". */
function enquiriesInWords(count: number): string {
  if (count === 0) return 'No enquiries yet';
  return `${count} ${count === 1 ? 'enquiry' : 'enquiries'}`;
}

/* ------------------------------------------------------------------- The form */

const PACKAGE_FIELDS: readonly EntityFormField[] = [
  {
    name: 'slug',
    label: 'Slug',
    type: 'text',
    required: true,
    hint: 'The address on the site: /packages/your-slug. Lowercase letters, numbers and hyphens.',
  },
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'days', label: 'Days', type: 'number', required: true },
  {
    name: 'newPrice',
    label: 'Price now (pesos)',
    type: 'text',
    required: true,
    hint: 'Up to two decimal places, e.g. 9800.00.',
  },
  {
    name: 'oldPrice',
    label: 'Was price (pesos)',
    type: 'text',
    hint: 'The struck-through price beside it. Leave blank if there is no discount — it has to be higher than the price now.',
  },
  { name: 'description', label: 'Description', type: 'textarea' },
  {
    name: 'highlights',
    label: 'Highlights',
    type: 'textarea',
    hint: 'One per line.',
  },
  { name: 'imagePath', label: 'Image path', type: 'text' },
  {
    name: 'imageAlt',
    label: 'Image alt text',
    type: 'text',
    hint: 'What a screen reader says. Required whenever there is an image.',
  },
  { name: 'sortOrder', label: 'Sort order', type: 'number' },
  { name: 'seoTitle', label: 'SEO title', type: 'text' },
  { name: 'seoDescription', label: 'SEO description', type: 'textarea' },
  { name: 'ogImage', label: 'Social share image', type: 'text' },
];

function valuesFromPackage(row: PackageAdminRow | null): Record<string, string> {
  if (!row) {
    return {
      slug: '',
      title: '',
      days: '3',
      newPrice: '',
      oldPrice: '',
      description: '',
      highlights: '',
      imagePath: '',
      imageAlt: '',
      sortOrder: '0',
      seoTitle: '',
      seoDescription: '',
      ogImage: '',
    };
  }
  return {
    slug: row.slug,
    title: row.title,
    days: String(row.days),
    newPrice: centavosToPesosInput(row.newPriceCentavos),
    oldPrice: row.oldPriceCentavos === null ? '' : centavosToPesosInput(row.oldPriceCentavos),
    description: row.description ?? '',
    highlights: (row.highlights ?? []).join('\n'),
    imagePath: row.imagePath ?? '',
    imageAlt: row.imageAlt ?? '',
    sortOrder: String(row.sortOrder),
    seoTitle: row.seoTitle ?? '',
    seoDescription: row.seoDescription ?? '',
    ogImage: row.ogImage ?? '',
  };
}

/**
 * First zod issue per field, keyed by the FORM's field name.
 *
 * The form's names and the schema's keys are not the same vocabulary — a price
 * is typed in pesos and stored in centavos — so the mapping is stated here,
 * which keeps every refusal beside the input that caused it (`ui-ux-pro-max`,
 * Forms / Error Placement: an inline error connected to that field, never a
 * summary alone).
 */
function fieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const byKey: Record<string, string> = {
    slug: 'slug',
    title: 'title',
    days: 'days',
    newPriceCentavos: 'newPrice',
    oldPriceCentavos: 'oldPrice',
    description: 'description',
    highlights: 'highlights',
    imagePath: 'imagePath',
    imageAlt: 'imageAlt',
    sortOrder: 'sortOrder',
    seoTitle: 'seoTitle',
    seoDescription: 'seoDescription',
    ogImage: 'ogImage',
  };
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = byKey[String(issue.path[0] ?? '')];
    if (!field || field in out) continue;
    out[field] = issue.message;
  }
  return out;
}

/** `''` reads as "no value" for every nullable column on this form. */
function orNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function PackageForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial: PackageAdminRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Record<string, string>>(() => valuesFromPackage(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const create = trpc.admin.packages.create.useMutation({
    onSuccess: () => {
      void utils.admin.packages.list.invalidate();
      onSaved('Package added.');
    },
    onError: (error) => setBanner(describeError(error, 'Could not add this package.')),
  });
  const update = trpc.admin.packages.update.useMutation({
    onSuccess: () => {
      void utils.admin.packages.list.invalidate();
      onSaved('Changes saved.');
    },
    onError: (error) => setBanner(describeError(error, 'Could not save this package.')),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    setBanner(null);
    const next: Record<string, string> = {};
    const value = (name: string) => values[name] ?? '';

    const newPriceCentavos = pesosToCentavos(value('newPrice'));
    if (newPriceCentavos === null) {
      next.newPrice = 'Enter an amount in pesos, e.g. 9800.00.';
    }
    const oldRaw = value('oldPrice').trim();
    const oldPriceCentavos = oldRaw === '' ? null : pesosToCentavos(oldRaw);
    if (oldRaw !== '' && oldPriceCentavos === null) {
      next.oldPrice = 'Enter an amount in pesos, e.g. 12500.00, or leave it blank.';
    }

    const daysRaw = value('days').trim();
    const sortRaw = value('sortOrder').trim();

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    const payload = {
      slug: value('slug').trim(),
      title: value('title').trim(),
      days: Number(daysRaw),
      oldPriceCentavos,
      newPriceCentavos,
      description: orNull(value('description')),
      imagePath: orNull(value('imagePath')),
      imageAlt: orNull(value('imageAlt')),
      // One highlight per line, blanks dropped. `null` when the box is empty,
      // which is what the column holds for a package with no bullet list.
      highlights:
        value('highlights').trim() === ''
          ? null
          : value('highlights')
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
      sortOrder: sortRaw === '' ? 0 : Number(sortRaw),
      seoTitle: orNull(value('seoTitle')),
      seoDescription: orNull(value('seoDescription')),
      ogImage: orNull(value('ogImage')),
    };

    const parsed =
      mode === 'edit'
        ? packageUpdateInput.safeParse({ ...payload, id: initial!.id })
        : packageCreateInput.safeParse(payload);
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
        fields={PACKAGE_FIELDS}
        values={values}
        errors={errors}
        pending={pending}
        submitLabel={mode === 'edit' ? 'Save changes' : 'Add package'}
        onChange={(name, nextValue) => setValues((current) => ({ ...current, [name]: nextValue }))}
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
 * Edit, and the soft delete behind a two-step confirm.
 *
 * The confirm names the package, because a list of titles is easy to misread,
 * and it says "Deactivate" rather than "Delete" because that is what the server
 * does — nothing is removed, and the enquiries about it stay where they are.
 */
function PackageActions({ row, onEdit }: { row: PackageAdminRow; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setActive = trpc.admin.packages.setActive.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setRowBanner(null);
      void utils.admin.packages.list.invalidate();
    },
    onError: (error) => {
      setConfirming(false);
      setRowBanner(describeError(error, 'Could not change this package. Nothing was changed.'));
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/*
       * The `aria-label` names the package. Every row draws a button reading
       * "Edit", so without it a screen-reader user tabbing the list hears
       * "Edit" five times with nothing to tell the five apart.
       */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={OUTLINE_BUTTON}
        aria-label={`Edit ${row.title}`}
        onClick={onEdit}
      >
        Edit
      </Button>

      {row.isActive ? (
        confirming ? (
          <div
            role="group"
            aria-label={`Confirm deactivating ${row.title}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              type="button"
              size="sm"
              className={PRIMARY_BUTTON}
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: row.id, isActive: false })}
            >
              {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${row.title}`}
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
            aria-label={`Deactivate ${row.title}`}
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
          aria-label={`Reactivate ${row.title}`}
          onClick={() => setActive.mutate({ id: row.id, isActive: true })}
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

/* -------------------------------------------------------------- One enquiry */

function InquiryRow({ row }: { row: InquiryAdminRow }) {
  const utils = trpc.useUtils();
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setStatus = trpc.admin.inquiries.setStatus.useMutation({
    onSuccess: () => {
      setRowBanner(null);
      void utils.admin.inquiries.list.invalidate();
    },
    onError: (error) =>
      setRowBanner(describeError(error, 'Could not change this enquiry. Nothing was changed.')),
  });

  return (
    <li className={`${CARD} space-y-3 p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={INQUIRY_BADGE_CLASS[row.status]}>
            {INQUIRY_STATUS_LABELS[row.status]}
          </Badge>
          <p className="text-brand-ink text-sm font-semibold">{row.name}</p>
        </div>
        <p className="text-muted-foreground text-xs">{utcIsoToManilaLabel(row.createdAt)}</p>
      </div>

      <p className="text-brand-error text-xs">
        {row.packageTitle === null ? 'General enquiry' : `About ${row.packageTitle}`}
      </p>

      <div className="text-sm">
        <p className="text-brand-ink">
          {/*
           * `break-all`, not `truncate`: an address a guest typed is the one
           * thing the office has to be able to read and copy, and at 360px an
           * unbroken 50-character email would push the card sideways
           * (CLAUDE.md: the page body must never scroll horizontally).
           */}
          <a
            href={`mailto:${row.email}`}
            className="text-brand-blue-700 hover:text-brand-blue-900 break-all underline underline-offset-4 transition-colors"
          >
            {row.email}
          </a>
        </p>
        {row.phone === null ? null : <p className="text-brand-ink">{row.phone}</p>}
      </div>

      <p className="text-brand-ink whitespace-pre-line text-sm leading-relaxed">{row.message}</p>

      {rowBanner ? (
        <p role="alert" className={ALERT}>
          {rowBanner}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * The visible word is short ("Mark read") and the `aria-label` names
         * the guest: every enquiry in the list draws the same three buttons, so
         * the label is the only thing that tells a screen-reader user which
         * enquiry they are about to close.
         */}
        {INQUIRY_STATUSES.filter((status) => status !== row.status).map((status) => (
          <Button
            key={status}
            type="button"
            variant="outline"
            size="sm"
            className={OUTLINE_BUTTON}
            disabled={setStatus.isPending}
            aria-label={`Mark ${INQUIRY_STATUS_LABELS[status].toLowerCase()} — enquiry from ${row.name}`}
            onClick={() => setStatus.mutate({ id: row.id, status })}
          >
            {`Mark ${INQUIRY_STATUS_LABELS[status].toLowerCase()}`}
          </Button>
        ))}
      </div>
    </li>
  );
}

/* --------------------------------------------------------- Newsletter export */

/**
 * A UTF-8 byte-order mark.
 *
 * Excel on Windows guesses a CSV's encoding and gets it wrong without this.
 * Built from its code point rather than typed, because the literal character is
 * invisible in a diff and `no-irregular-whitespace` rightly refuses it in
 * source. (The same constant, for the same reason, as `AdminReportsPage.tsx`.)
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
 * The owner-only control, and the only part of this screen gated on
 * `usersSettings`.
 *
 * A MUTATION rather than a query, because the server audits the export — an
 * export of every subscriber's address is a disclosure under RA 10173, so it is
 * an event rather than a read, and a query that writes must never be retried or
 * prefetched. See `server/src/routers/admin/newsletter.ts`.
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
          variant="outline"
          size="sm"
          className={OUTLINE_BUTTON}
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

/* ------------------------------------------------------------- Denied state */

function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner and dispatcher only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Packages</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner and dispatcher can manage packages and enquiries.
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

/* ------------------------------------------------------------------ The page */

function PackagesAdmin({ isOwner }: { isOwner: boolean }) {
  const list = trpc.admin.packages.list.useQuery(undefined, { retry: false });
  const inquiryList = trpc.admin.inquiries.list.useQuery(undefined, { retry: false });
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The second denial layer: the ROLE check in `AdminPackagesPage` only catches
  // a session this client already knows is refused. A session that LOOKS
  // allowed to this page but whose `packagesInquiries` grant the server has
  // since revoked only surfaces here, when the list itself comes back refused.
  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const rows = list.data ?? [];
  const editing = typeof editingId === 'number' ? rows.find((row) => row.id === editingId) : null;
  const inquiries = inquiryList.data ?? [];
  const waiting = inquiries.filter((row) => row.status === 'new').length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Operations
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Packages</h1>
        <p className="text-brand-error text-sm">
          Multi-day packages, the enquiries guests send about them, and the newsletter list.
          Deactivating a package takes it off the site and keeps every enquiry about it.
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
          Add a package
        </Button>
      ) : (
        <Card className={CARD}>
          <CardHeader>
            <CardTitle className="text-brand-ink text-lg font-bold">
              {editingId === 'new' ? 'Add a package' : 'Edit package'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PackageForm
              key={editingId}
              mode={editingId === 'new' ? 'create' : 'edit'}
              initial={editing ?? null}
              onClose={() => setEditingId(null)}
              onSaved={(message) => {
                setEditingId(null);
                setNotice(message);
              }}
            />
          </CardContent>
        </Card>
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Packages</h2>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading packages…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the packages. Sign in again, or try once more in a moment.
        </p>
      ) : rows.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>
          No packages yet — add the first one above.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className={`${CARD} space-y-3 p-4 text-sm`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-brand-ink font-semibold">{row.title}</p>
                  {/* A slug is one unspaced token, so it needs `break-all` at 360px. */}
                  <p className="text-brand-error break-all text-xs">
                    /packages/{row.slug} · {daysInWords(row.days)}
                  </p>
                </div>
                <Badge className={STATUS_BADGE_CLASS[statusLabel(row.isActive)]}>
                  {statusLabel(row.isActive)}
                </Badge>
              </div>

              <p className="text-brand-ink">
                <span className="font-semibold">{formatPeso(row.newPriceCentavos)}</span>
                {row.oldPriceCentavos === null ? null : (
                  <span className="text-brand-error ml-2 text-xs">
                    was <s>{formatPeso(row.oldPriceCentavos)}</s>
                  </span>
                )}
              </p>

              <p className="text-brand-error text-xs">{enquiriesInWords(row.inquiryCount)}</p>

              <PackageActions row={row} onEdit={() => setEditingId(row.id)} />
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-brand-ink -mb-3 text-lg font-bold">Enquiries</h2>

      {inquiryList.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading enquiries…
        </p>
      ) : inquiryList.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the enquiries. Sign in again, or try once more in a moment.
        </p>
      ) : inquiries.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>No enquiries yet.</p>
      ) : (
        <>
          <p role="status" className={NOTICE}>
            {waiting === 0
              ? 'Nothing waiting for an answer.'
              : `${waiting} ${waiting === 1 ? 'enquiry' : 'enquiries'} waiting for an answer.`}
          </p>
          <ul className="space-y-3">
            {inquiries.map((row) => (
              <InquiryRow key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}

      {/*
       * Owner only, cosmetically — `admin.newsletter.export` is gated
       * `usersSettings` on the server and refuses a dispatcher whether or not
       * this card was drawn.
       */}
      {isOwner ? <NewsletterExportCard /> : null}
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.packages` and
 * `admin.inquiries` call from anyone but owner and dispatcher, and every
 * `admin.newsletter` call from anyone but the owner. This just stops a finance
 * user who types the address from being shown a screen that can only be
 * refused. The second denial layer — a refused `admin.packages.list` this role
 * check did not catch — lives inside `PackagesAdmin`, beside the query it
 * guards.
 */
export default function AdminPackagesPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner' && me.data.role !== 'dispatcher') {
    return <DeniedState />;
  }

  return <PackagesAdmin isOwner={me.data?.role === 'owner'} />;
}
