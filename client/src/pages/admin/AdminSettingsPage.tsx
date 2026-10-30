/**
 * The settings screens — all seventeen `settings` blocks (Week 7 plan, Task 9;
 * BUILD_SPEC §9 "Users, settings", client half).
 *
 * `admin.settings.*` is `adminProcedure('usersSettings')` server-side — OWNER
 * ONLY — so this screen offers no control a dispatcher or finance role could
 * use. Like `AdminToursPage.tsx` and `AdminCouponsPage.tsx` it does not treat
 * its own role check as enforcement (CLAUDE.md: hiding a button is not access
 * control); it shows a plain "owner only" denied state from either of the two
 * places a non-owner can arrive — the role this session already knows
 * (`staffAuth.me`), and a refused `admin.settings.all` (a stale session, or a
 * role changed mid-visit).
 *
 * ## One declarative field list, seventeen blocks
 *
 * Every block is described once in `components/admin/settings-blocks.ts` — its
 * fields, their kinds, and the words beside them — and three renderers here
 * draw all of them. Seventeen hand-written forms would be seventeen places for
 * a label to go missing, and the shapes are not what varies between them:
 * `faqs` is a list of two-field rows and `how_it_works` is a list of
 * three-field rows, which is a difference in data, not in interface.
 *
 * A block is `object` (one record) or `array` (repeating rows), and
 * `content_unverified` is `flag` — a bare boolean with consequences outside
 * this screen, so it has its own component. Those three are the only shapes
 * the table has.
 *
 * ## Grouped behind disclosures, because seventeen forms is not a page
 *
 * Five `<section>`s — Site & SEO, Home content, Business, Payments, Legal —
 * each holding one `<details>` per block. A native `<details>`/`<summary>`
 * rather than the shadcn `Accordion`: it is keyboard-operable and
 * screen-reader-announced with no JavaScript at all, several may be open at
 * once (an owner comparing the promo with the announcement), and it needs no
 * new dependency. A block's form is mounted on its FIRST open and then stays
 * mounted, so collapsing a section never discards what was typed into it.
 *
 * ## Nothing here computes money, and nothing here validates a block
 *
 * `trust.depositPercent` is typed as the integer percent the server stores and
 * is sent as that integer — this screen does no arithmetic on it, and the
 * deposit a guest is charged is computed server-side from the stored value
 * (CLAUDE.md: the server computes all money). Validation is the server's too:
 * the one validator is `SETTING_SCHEMAS[key]`, and a refusal comes back as a
 * sentence naming the field, rendered in the block's own `role="alert"`
 * banner. The only checks made here are the ones the server cannot express —
 * "that is not a number", "that is not a date and time" — reported inline
 * beside the field that caused them (`ui-ux-pro-max`, Forms / Error
 * Placement). Each block saves on its own, with its own
 * `role="status"` confirmation (Forms / Submit Feedback).
 *
 * ## One thing gets a confirm step
 *
 * Clearing `content_unverified` is the act that PUBLISHES this site to every
 * search index, and it is irreversible in the sense that matters: a crawler
 * that has already read a page has read it. So that direction is a two-step
 * confirm (`ui-ux-pro-max`, Interaction / Confirmation Dialogs) whose wording
 * says what will happen rather than asking "are you sure". Switching it back
 * ON hides the site again and needs no confirm — that direction is safe.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BLOCKS_BY_KEY,
  GROUPS,
  blankRow,
  fromFormRow,
  toFormRow,
  visibleFields,
  type BlockSpec,
  type FieldSpec,
} from '@/components/admin/settings-blocks';
import { firstValidationMessage } from '@/lib/field-errors';
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
const FIELD = 'tap-target border-brand-blue-200 w-full rounded-[10px] bg-white';
const ROW_ERROR = 'text-brand-gold-800 text-xs font-medium';
const SUMMARY =
  'tap-target text-brand-ink hover:bg-brand-blue-50 flex cursor-pointer items-center rounded-[10px] px-3 py-2 text-sm font-bold transition-colors';

/** The server's own sentence for a refusal under 500; a calm fallback otherwise. */
function describeSettingsError(error: unknown, fallback: string): string {
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

/** Is this refusal a role problem (401/403), rather than a network or server fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

/* ------------------------------------------------------------------ One field */

function SettingField({
  idPrefix,
  field,
  value,
  error,
  onChange,
}: {
  idPrefix: string;
  field: FieldSpec;
  value: string;
  error?: string;
  onChange: (next: string) => void;
}) {
  const inputId = `${idPrefix}-${field.name.replace(/\./g, '-')}`;
  const hintId = field.hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={inputId}>{field.label}</Label>

      {field.kind === 'textarea' ? (
        <textarea
          id={inputId}
          rows={field.rows ?? 4}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="tap-target border-brand-blue-200 focus-visible:ring-brand-blue-600 w-full rounded-[10px] border bg-white p-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      ) : field.kind === 'select' ? (
        /*
         * A native `<select>`, not the shadcn `Select`: this screen draws
         * dozens of them, every one is a two- or three-way choice, and a
         * native control is keyboard- and screen-reader-correct with no
         * portal and no extra markup. The styling matches the inputs.
         */
        <select
          id={inputId}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="tap-target border-brand-blue-200 focus-visible:ring-brand-blue-600 w-full rounded-[10px] border bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={inputId}
          type={
            field.kind === 'number'
              ? 'number'
              : field.kind === 'time'
                ? 'time'
                : field.kind === 'manilaDatetime'
                  ? 'datetime-local'
                  : 'text'
          }
          /*
           * `step="any"` on every numeric field, so the BROWSER never decides
           * what a settings number may be. Its default step is 1, which makes
           * `trust.ratingAverage: 4.9` fail native constraint validation and
           * silently block the submit — on a field whose schema is
           * `z.number().nullable()` and allows exactly that. Where a whole
           * number IS required the server's own `.int()` says so by name.
           */
          step={field.kind === 'number' ? 'any' : undefined}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={FIELD}
        />
      )}

      {field.hint ? (
        <p id={hintId} className="text-brand-error text-xs">
          {field.hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={ROW_ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The grid one record's (or one row's) fields are laid out in. */
function FieldGrid({
  idPrefix,
  fields,
  row,
  errors,
  onChange,
}: {
  idPrefix: string;
  fields: readonly FieldSpec[];
  row: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, next: string) => void;
}) {
  return (
    // One column at 360px, two from `sm:` — a textarea always takes the row.
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.name} className={field.kind === 'textarea' ? 'sm:col-span-2' : undefined}>
          <SettingField
            idPrefix={idPrefix}
            field={field}
            value={row[field.name] ?? ''}
            error={errors[field.name]}
            onChange={(next) => onChange(field.name, next)}
          />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------- The write, once, shared */

function useSettingsWrite(block: BlockSpec) {
  const utils = trpc.useUtils();
  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const write = trpc.admin.settings.write.useMutation({
    onSuccess: () => {
      setBanner(null);
      setNotice('Saved.');
      void utils.admin.settings.all.invalidate();
    },
    onError: (error) => {
      setNotice(null);
      setBanner(
        describeSettingsError(error, `Could not save ${block.title}. Nothing was changed.`),
      );
    },
  });

  /** Clears both banners — called before every attempt. */
  function reset() {
    setBanner(null);
    setNotice(null);
  }

  return { write, banner, notice, reset };
}

function BlockBanners({ banner, notice }: { banner: string | null; notice: string | null }) {
  return (
    <>
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
    </>
  );
}

/* ------------------------------------------- The payment QR upload widget */

/** The authenticated route that streams the current QR; it takes no parameter. */
const QR_SRC = '/api/payment-qr';

/**
 * `payment_qr.imagePath` has no text box any more (owner decision 2026-10-28):
 * R&G's owner cannot copy a file onto the server, so this uploads one instead.
 *
 * Preview-before-save, same shape as the portal's `ReceiptUpload`: choosing a
 * file shows it locally (an object URL, never sent yet) with Save and Cancel,
 * so a wrong file can be backed out before it replaces the live QR. `Save`
 * posts straight to `POST /api/payment-qr/upload` — file bytes, not JSON, for
 * the same reason `ReceiptUpload` does not use a tRPC mutation.
 *
 * `onUploaded` writes the new filename into the PARENT's form row, not only
 * into local state: `ObjectBlockEditor`'s `row` is seeded from `stored` once,
 * on mount, so without this the hidden `imagePath` field would still hold the
 * filename from before the upload and a later Save of Account name/number
 * would silently write it back over the image that was just uploaded.
 */
function PaymentQrImage({
  imagePath,
  onUploaded,
}: {
  imagePath: string;
  onUploaded: (path: string) => void;
}) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [cacheBust, setCacheBust] = useState(() => Date.now());
  const [imageMissing, setImageMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const hasImage = imagePath.trim() !== '';

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = event.target.files?.[0] ?? null;
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(file ? { file, url: URL.createObjectURL(file) } : null);
  }

  function cancelPreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function save() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const query = new URLSearchParams({ filename: preview.file.name });
      const response = await fetch(`/api/payment-qr/upload?${query.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': preview.file.type },
        body: preview.file,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'That did not go through. Please try again in a moment.');
        setSaving(false);
        return;
      }

      const result = (await response.json()) as { imagePath: string };
      URL.revokeObjectURL(preview.url);
      setPreview(null);
      setImageMissing(false);
      setCacheBust(Date.now());
      if (fileInput.current) fileInput.current.value = '';
      onUploaded(result.imagePath);
      setSaving(false);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
      setSaving(false);
    }
  }

  return (
    <div className="border-brand-blue-100 bg-brand-blue-50/50 space-y-3 rounded-xl border p-4">
      <p className="text-brand-ink text-sm font-bold">Payment QR image</p>

      {error ? (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <div className="border-brand-blue-200 flex h-28 w-28 shrink-0 items-center justify-center rounded-lg border bg-white p-1">
          {preview ? (
            <img
              src={preview.url}
              alt="New QR, not saved yet"
              className="h-full w-full object-contain"
            />
          ) : hasImage && !imageMissing ? (
            <img
              key={cacheBust}
              src={`${QR_SRC}?v=${cacheBust}`}
              alt="Current payment QR code"
              onError={() => setImageMissing(true)}
              className="h-full w-full object-contain"
            />
          ) : (
            <p className="text-brand-error text-center text-xs">
              {hasImage ? 'Could not load the saved QR.' : 'No QR uploaded yet.'}
            </p>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {preview ? (
            <>
              <p className="text-brand-error text-xs">
                Shown above — not saved yet. Save to make this the live QR, or cancel to keep the
                current one.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={saving}
                  onClick={() => void save()}
                  className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                      Saving…
                    </>
                  ) : (
                    'Save QR'
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={cancelPreview}
                  className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <Label htmlFor="payment-qr-file">
                {hasImage ? 'Upload a new QR' : 'Upload the QR'}
              </Label>
              <Input
                ref={fileInput}
                id="payment-qr-file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={pickFile}
                className="tap-target file:text-brand-blue-900 bg-white py-2 file:mr-3 file:font-medium"
              />
              <p className="text-brand-error text-xs">JPG, PNG or WEBP, up to 5MB.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- The three shapes */

/** One record: the fields, flat, with a single Save. */
function ObjectBlockEditor({ block, stored }: { block: BlockSpec; stored: unknown }) {
  const { write, banner, notice, reset } = useSettingsWrite(block);
  const [row, setRow] = useState<Record<string, string>>(() => toFormRow(stored, block.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        reset();
        const { record, errors: next } = fromFormRow(row, block.fields, 0, new Date());
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        write.mutate({ key: block.key, value: record });
      }}
    >
      <BlockBanners banner={banner} notice={notice} />

      {block.key === 'payment_qr' ? (
        <PaymentQrImage
          imagePath={row.imagePath ?? ''}
          onUploaded={(path) => setRow((current) => ({ ...current, imagePath: path }))}
        />
      ) : null}

      <FieldGrid
        idPrefix={block.key}
        fields={visibleFields(block.fields)}
        row={row}
        errors={errors}
        onChange={(name, next) => setRow((current) => ({ ...current, [name]: next }))}
      />

      <Button
        type="submit"
        disabled={write.isPending}
        className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
      >
        {write.isPending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}

/**
 * A repeating list: one numbered row per entry, with ONE Save for the whole
 * list.
 *
 * One Save because the block is one JSON document — a row cannot be saved
 * without the rows beside it, and a per-row Save button would say otherwise.
 * `business_hours` is `fixedLength`, so it offers no Add and no Remove: the
 * block's schema is exactly seven entries and the weekday is the row's
 * position, not a field anyone types.
 */
function ArrayBlockEditor({ block, stored }: { block: BlockSpec; stored: unknown }) {
  const { write, banner, notice, reset } = useSettingsWrite(block);
  const [rows, setRows] = useState<Record<string, string>[]>(() =>
    (Array.isArray(stored) ? stored : []).map((entry) => toFormRow(entry, block.fields)),
  );
  const [errors, setErrors] = useState<Record<number, Record<string, string>>>({});

  const fields = visibleFields(block.fields);
  const nameOf = (index: number) => (block.rowName ? block.rowName(index) : `Entry ${index + 1}`);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        reset();
        const value: unknown[] = [];
        const next: Record<number, Record<string, string>> = {};
        const now = new Date();
        rows.forEach((row, index) => {
          const { record, errors: rowErrors } = fromFormRow(row, block.fields, index, now);
          if (Object.keys(rowErrors).length > 0) next[index] = rowErrors;
          value.push(record);
        });
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        write.mutate({ key: block.key, value });
      }}
    >
      <BlockBanners banner={banner} notice={notice} />

      {rows.length === 0 ? (
        <p className="text-brand-error text-sm">Nothing here yet — add the first entry below.</p>
      ) : null}

      <ol className="space-y-4">
        {rows.map((row, index) => (
          <li key={index} className="border-brand-blue-100 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-brand-ink text-sm font-bold">{nameOf(index)}</h4>
              {block.fixedLength ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={OUTLINE_BUTTON}
                  aria-label={`Remove ${nameOf(index)}`}
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              )}
            </div>
            <div className="mt-3">
              <FieldGrid
                idPrefix={`${block.key}-${index}`}
                fields={fields}
                row={row}
                errors={errors[index] ?? {}}
                onChange={(name, next) =>
                  setRows((current) =>
                    current.map((entry, i) => (i === index ? { ...entry, [name]: next } : entry)),
                  )
                }
              />
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={write.isPending}
          className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
        >
          {write.isPending ? 'Saving…' : 'Save'}
        </Button>
        {block.fixedLength ? null : (
          <Button
            type="button"
            variant="outline"
            className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
            onClick={() => setRows((current) => [...current, blankRow(block.fields)])}
          >
            Add an entry
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * `content_unverified` — the one block that is a bare boolean, and the one
 * with a consequence outside this screen.
 *
 * While it is on, `robots.txt` says `Disallow: /`, every page is served
 * `noindex,nofollow`, the amber placeholder banner shows and a production
 * build is blocked. Clearing it publishes the site, which is why that
 * direction is a two-step confirm and switching it back on is not.
 */
function FlagBlockEditor({ block, stored }: { block: BlockSpec; stored: unknown }) {
  const { write, banner, notice, reset } = useSettingsWrite(block);
  const [confirming, setConfirming] = useState(false);
  /*
   * FAILS CLOSED, mirroring `readContentUnverified`'s own rule (7N, Task 9):
   * an absent or unreadable row there resolves to `true` ("treating the site
   * as unverified"), because an unproven state must not be read as safe to
   * publish. This editor used to read the mirror image — `stored === true`
   * treats anything that is not the literal boolean `true` (missing,
   * `null`, a malformed value) as VERIFIED, which is fail-OPEN on a security-
   * relevant gate (robots.txt, noindex, the production build guard).
   * `!== false` is the fail-closed form: only the literal `false` the
   * server actually writes reads as "verified"; everything else, including
   * a row this screen has not loaded yet, reads as unverified.
   */
  const unverified = stored !== false;

  function save(next: boolean) {
    reset();
    setConfirming(false);
    write.mutate({ key: block.key, value: next });
  }

  return (
    <div className="space-y-4">
      <BlockBanners banner={banner} notice={notice} />

      <p className={unverified ? ALERT : NOTICE}>
        {unverified
          ? 'The content is marked UNVERIFIED. The site is hidden from every search engine, the amber placeholder banner is shown, and a production build is blocked.'
          : 'The content is marked verified. The site is open to search engines and a production build is allowed.'}
      </p>

      {unverified ? (
        confirming ? (
          <div
            role="group"
            aria-label="Confirm publishing the site to search engines"
            className="space-y-3"
          >
            <p className={NOTICE}>
              This opens the whole site to Google and every other crawler and removes the
              placeholder banner. Do it only once the real content, prices and reviews are in place
              — a page a crawler has already read has been read.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={write.isPending}
                className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                onClick={() => save(false)}
              >
                {write.isPending ? 'Saving…' : 'Yes, publish the site to search engines'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={write.isPending}
                className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
            onClick={() => setConfirming(true)}
          >
            Mark the content verified
          </Button>
        )
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={write.isPending}
          className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
          onClick={() => save(true)}
        >
          {write.isPending ? 'Saving…' : 'Mark the content unverified again'}
        </Button>
      )}
    </div>
  );
}

/**
 * One block behind a native disclosure.
 *
 * The editor is mounted on the FIRST open and stays mounted afterwards, so an
 * owner who collapses a section to look at another one does not lose what they
 * typed — and a page of seventeen blocks does not build every input on load.
 */
function BlockDisclosure({ block, stored }: { block: BlockSpec; stored: unknown }) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className={`${CARD} px-2 py-1`}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className={SUMMARY}>{block.title}</summary>
      <div className="space-y-4 px-1 pb-4 pt-2">
        <p className="text-brand-error text-sm">{block.blurb}</p>
        {opened ? (
          block.shape === 'flag' ? (
            <FlagBlockEditor block={block} stored={stored} />
          ) : block.shape === 'array' ? (
            <ArrayBlockEditor block={block} stored={stored} />
          ) : (
            <ObjectBlockEditor block={block} stored={stored} />
          )
        ) : null}
      </div>
    </details>
  );
}

/** The same denied markup `AdminToursPage.tsx` and `AdminCouponsPage.tsx` render. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Settings</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner can change the settings.
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

function SettingsAdmin() {
  const all = trpc.admin.settings.all.useQuery(undefined, { retry: false });

  // The second denial layer: the role check in `AdminSettingsPage` catches only
  // a session this client already knows is not the owner. A session that LOOKS
  // like an owner here but whose `usersSettings` grant the server has since
  // revoked surfaces only when the query itself comes back refused.
  if (all.isError && isRoleRefusal(all.error)) {
    return <DeniedState />;
  }

  const stored = all.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Settings</h1>
        <p className="text-brand-error text-sm">
          Everything the public site reads from the database: its words, its hours, its contact
          details, the deposit taken at checkout, and whether search engines may see any of it. Each
          block is saved on its own.
        </p>
      </header>

      {all.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading settings…
        </p>
      ) : all.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the settings. Sign in again, or try once more in a moment.
        </p>
      ) : (
        GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`settings-${group.id}`} className="space-y-3">
            <div>
              <h2 id={`settings-${group.id}`} className="text-brand-ink text-lg font-bold">
                {group.title}
              </h2>
              <p className="text-brand-error text-sm">{group.blurb}</p>
            </div>
            <div className="space-y-2">
              {group.keys.map((key) => {
                const block = BLOCKS_BY_KEY.get(key);
                if (!block) return null;
                return <BlockDisclosure key={key} block={block} stored={stored?.[key]} />;
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.settings`
 * call from anyone but the owner. This stops a dispatcher or finance user who
 * types the address from being shown seventeen forms that can only be refused.
 */
export default function AdminSettingsPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner') {
    return <DeniedState />;
  }

  return <SettingsAdmin />;
}
