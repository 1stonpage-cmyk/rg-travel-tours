/**
 * The receipt upload control (§6 step 3, Week 4 Task 8).
 *
 * Three fields and a button: which app the guest paid with, the reference
 * that app gave them, and the screenshot or PDF.
 *
 * ## Why this posts with `fetch` rather than a tRPC mutation
 *
 * It sends FILE BYTES. tRPC carries its arguments in a JSON body, so a 5MB
 * photograph would have to be base64-encoded into a 6.7MB string and parsed
 * twice. `POST /api/receipts/upload` takes the file as the raw body with its
 * metadata in the query string instead (see the route's own note), so the
 * browser streams the file it already has.
 *
 * `credentials: 'include'` because the portal session is an httpOnly
 * cookie, and the `Origin` header a browser always sends is what satisfies
 * the CSRF middleware.
 *
 * ## The booking is NOT a prop
 *
 * There is no booking reference or id in what this sends. The server reads
 * the booking from the session — a booking id in an upload payload is an
 * IDOR with a form around it — so this component has nothing to get wrong.
 *
 * ## Errors are the server's own sentences, in amber
 *
 * Every refusal the route produces is written for a guest ("that file is
 * larger than 5MB", "you have already uploaded five receipts"). They are
 * shown verbatim rather than translated into something vaguer, and in amber
 * — never red (CLAUDE.md), because a receipt that needs re-taking is a
 * normal step, not a failure.
 *
 * ## Per-field messages here come from the SHARED schema, not from zodError
 *
 * Task A4 asks for the reference-number message beside the reference box and
 * the file message beside the file box. This form is the one of the six that
 * is **not a tRPC mutation**, so there is no `error.data.zodError` to read —
 * the route answers `{ error: <one sentence> }` (`refuse()` in
 * `server/src/routers/receipts.ts`) and nothing in it says which field a 400
 * was about.
 *
 * So the two fields are checked here, before the request, against
 * {@link transferReferenceSchema} — the SAME schema the server parses with,
 * imported rather than reimplemented, so there is no second rule and no
 * second wording. The server still validates exactly as it did; this only
 * decides where the sentence appears. Anything the server refuses for a
 * reason the browser could not know (the five-upload cap, a file that is too
 * large once read, an expired session) keeps the amber notice above the
 * form, unchanged.
 */
import { useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, Upload } from 'lucide-react';
import {
  MANUAL_TRANSFER_METHODS,
  transferReferenceSchema,
  type ManualTransferMethod,
} from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The labels a guest recognises, for the three methods the server accepts. */
const METHOD_LABELS: Record<ManualTransferMethod, string> = {
  gcash: 'GCash',
  maya: 'Maya',
  bank_transfer: 'Bank transfer',
};

type Props = {
  /** From `portal.manualPayment`. At zero the form is replaced by a notice. */
  uploadsRemaining: number;
  /** Called after a successful upload, so the page can refetch its status. */
  onUploaded?: () => void;
};

const ERROR_ID = 'receipt-upload-error';
const REF_ERROR_ID = 'receipt-ref-error';
const FILE_ERROR_ID = 'receipt-file-error';

export default function ReceiptUpload({ uploadsRemaining, onUploaded }: Props) {
  const [method, setMethod] = useState<ManualTransferMethod>('gcash');
  const [txnRef, setTxnRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setRefError(null);
    setFileError(null);

    /*
     * Both fields are checked before anything is sent, so each message lands
     * under its own box. The reference's rule and its wording are the shared
     * schema's ("Please enter the reference number from your transfer." /
     * "Please use only the characters your transfer receipt shows.") — this
     * reads them, it does not restate them.
     */
    const parsedRef = transferReferenceSchema.safeParse(txnRef);
    if (!parsedRef.success) {
      setRefError(
        parsedRef.error.issues[0]?.message ?? 'Please check the reference number and try again.',
      );
    }
    if (!file) {
      setFileError('Please choose the photo or PDF of your transfer receipt.');
    }
    if (!parsedRef.success || !file) return;

    setState('sending');
    try {
      const query = new URLSearchParams({
        method,
        txnRef: txnRef.trim(),
        filename: file.name,
      });
      const response = await fetch(`/api/receipts/upload?${query.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': file.type },
        body: file,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        // The server's own guest-safe sentence, or a fallback for the case
        // where the response was not JSON at all (a proxy error page).
        setError(body?.error ?? 'That did not go through. Please try again in a moment.');
        setState('idle');
        return;
      }

      setState('done');
      setTxnRef('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onUploaded?.();
    } catch {
      // A dropped connection, which on a Cebu mobile signal is the likely
      // one. Never a stack trace, never a red box.
      setError('We could not reach the server. Check your connection and try again.');
      setState('idle');
    }
  }

  if (uploadsRemaining <= 0) {
    return (
      <p
        role="status"
        className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
      >
        You have already uploaded five receipts for this booking, which is the most we can accept
        here. Please message us and we will sort it out with you directly.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} aria-labelledby="receipt-upload-heading" className="space-y-4">
      <h3 id="receipt-upload-heading" className="text-brand-blue-900 text-base font-semibold">
        Send us your receipt
      </h3>

      {error ? (
        <p
          id={ERROR_ID}
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
        >
          {error}
        </p>
      ) : null}

      {state === 'done' ? (
        <p
          role="status"
          className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 flex items-start gap-2 rounded-lg border p-3 text-sm font-medium"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Got it — we are checking your transfer now and will email you as soon as it is
            confirmed, usually within a few hours.
          </span>
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="receipt-method">How did you pay?</Label>
        <select
          id="receipt-method"
          name="method"
          value={method}
          onChange={(event) => setMethod(event.target.value as ManualTransferMethod)}
          className="border-input bg-background tap-target w-full rounded-md border px-3 text-sm"
        >
          {MANUAL_TRANSFER_METHODS.map((value) => (
            <option key={value} value={value}>
              {METHOD_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="receipt-ref">Reference number from your transfer</Label>
        <Input
          id="receipt-ref"
          name="txnRef"
          value={txnRef}
          onChange={(event) => {
            setTxnRef(event.target.value);
            setRefError(null);
          }}
          placeholder="e.g. 1234567890123"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-describedby={
            refError ? `${REF_ERROR_ID} receipt-ref-help` : error ? ERROR_ID : 'receipt-ref-help'
          }
          aria-invalid={refError ? true : undefined}
          className="tap-target font-mono"
        />
        <p id="receipt-ref-help" className="text-muted-foreground text-xs">
          Your GCash, Maya or bank app shows this on the receipt.
        </p>
        <FieldError id={REF_ERROR_ID} message={refError ?? undefined} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="receipt-file">Photo or PDF of the receipt</Label>
        <Input
          ref={fileInput}
          id="receipt-file"
          name="receipt"
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          required
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setFileError(null);
          }}
          aria-describedby={fileError ? FILE_ERROR_ID : undefined}
          aria-invalid={fileError ? true : undefined}
          className="tap-target file:text-brand-blue-900 py-2 file:mr-3 file:font-medium"
        />
        <p className="text-muted-foreground text-xs">
          JPG, PNG, WEBP or PDF, up to 5MB.{' '}
          {uploadsRemaining === 1
            ? 'This is your last upload for this booking.'
            : `${uploadsRemaining} uploads left for this booking.`}
        </p>
        <FieldError id={FILE_ERROR_ID} message={fileError ?? undefined} />
      </div>

      <Button type="submit" disabled={state === 'sending'} className="tap-target w-full">
        {state === 'sending' ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            Sending…
          </>
        ) : (
          <>
            <Upload className="mr-2 size-4" aria-hidden="true" />
            Send receipt
          </>
        )}
      </Button>
    </form>
  );
}
