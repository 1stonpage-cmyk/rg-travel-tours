/**
 * The review moderation queue (Week 7 plan, Task 11; BUILD_SPEC §4 "Reviews",
 * §9 "Reviews moderation").
 *
 * `admin.reviews.*` is `adminProcedure('reviewsModeration')` server-side —
 * owner and dispatcher, never finance — so this screen offers no control a
 * finance role could use. It does not re-check the role itself for
 * enforcement (CLAUDE.md: hiding a button is not access control) but, the
 * same shape `AdminCouponsPage.tsx` uses, it shows a plain denied state
 * rather than a blank page or raw data, from either of the two places a
 * refused role could reach it: the role this session already knows
 * (`staffAuth.me`), and a refused `admin.reviews.queue` call (a stale
 * session, or a role that changed mid-visit).
 *
 * ## Pending first, decided reviews stay visible
 *
 * The server's own order — pending above everything, then newest first — is
 * trusted as-is; this screen does not re-sort. A hidden review stays in the
 * list (the public site cannot show it, so this screen is the only place it
 * is visible at all), which is also the only way it can be published again.
 *
 * ## `pending` is not a state a moderator can SET
 *
 * `reviewStatusInput` refuses it server-side, so the two action buttons are
 * "Publish" and "Hide" only — there is no "send back to the queue" button to
 * build, because that is not a thing the schema allows.
 *
 * ## A reply is a replacement, never a thread
 *
 * The textarea is pre-filled with the review's current reply (or empty), and
 * saving overwrites the one `reply` column and re-stamps `repliedAt` — there
 * is no way to clear a reply back to null, matching the server's own note on
 * why that was never asked for.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  REVIEW_REPLY_MAX,
  REVIEW_SUBSCORE_LABELS,
  REVIEW_SUBSCORES,
  type ReviewModerationRow,
  type ReviewModerationStatus,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import StarRating from '@/components/common/StarRating';
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
const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';

const STATUS_LABEL: Record<ReviewModerationRow['status'], string> = {
  pending: 'Pending',
  published: 'Published',
  hidden: 'Hidden',
};

const STATUS_BADGE_CLASS: Record<ReviewModerationRow['status'], string> = {
  pending: 'border-0 bg-brand-gold-100 text-brand-gold-800',
  published: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  hidden: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeReviewError(error: unknown, fallback: string): string {
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

/** "Guide 5 · Value 4" — only the sub-scores a guest actually rated. */
function subscoresInWords(row: ReviewModerationRow): string | null {
  const parts = REVIEW_SUBSCORES.filter((key) => row[key] !== null).map(
    (key) => `${REVIEW_SUBSCORE_LABELS[key]} ${row[key]}`,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The one place this screen names the booking, for looking it up elsewhere — never a guest's contact details. */
function bookingInWords(row: ReviewModerationRow): string {
  return row.bookingRef === null ? 'No booking linked' : `Booking ${row.bookingRef}`;
}

/* ------------------------------------------------------------------ Reply form */

function ReplyForm({
  row,
  onClose,
  onSaved,
}: {
  row: ReviewModerationRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(row.reply ?? '');
  const [error, setError] = useState<string | null>(null);

  const reply = trpc.admin.reviews.reply.useMutation({
    onSuccess: onSaved,
    onError: (err) => setError(describeReviewError(err, 'Could not save this reply.')),
  });

  function submit() {
    setError(null);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError('Write a reply before saving.');
      return;
    }
    if (trimmed.length > REVIEW_REPLY_MAX) {
      setError(`Keep it under ${REVIEW_REPLY_MAX} characters.`);
      return;
    }
    reply.mutate({ id: row.id, reply: trimmed });
  }

  return (
    <div className="mt-3 space-y-2">
      <label htmlFor={`reply-${row.id}`} className="text-brand-ink text-xs font-semibold">
        {row.reply ? 'Edit reply' : 'Write a reply'}
      </label>
      <textarea
        id={`reply-${row.id}`}
        value={text}
        maxLength={REVIEW_REPLY_MAX}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        className={`${FIELD} w-full p-2 text-sm`}
      />
      {error ? (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className={PRIMARY_BUTTON}
          disabled={reply.isPending}
          onClick={submit}
        >
          {reply.isPending ? 'Saving…' : 'Save reply'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={OUTLINE_BUTTON}
          disabled={reply.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- One row */

function ReviewRow({ row }: { row: ReviewModerationRow }) {
  const utils = trpc.useUtils();
  const [replying, setReplying] = useState(false);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const setStatus = trpc.admin.reviews.setStatus.useMutation({
    onSuccess: () => {
      setRowBanner(null);
      void utils.admin.reviews.queue.invalidate();
    },
    onError: (error) =>
      setRowBanner(
        describeReviewError(error, 'Could not change this review. Nothing was changed.'),
      ),
  });

  function changeStatus(status: ReviewModerationStatus) {
    setStatus.mutate({ id: row.id, status });
  }

  const subscores = subscoresInWords(row);

  return (
    <li className={`${CARD} space-y-3 p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StarRating value={row.rating} size="sm" />
          <Badge className={STATUS_BADGE_CLASS[row.status]}>{STATUS_LABEL[row.status]}</Badge>
          {row.verified ? (
            <Badge className="bg-brand-blue-50 text-brand-blue-800 border-0">
              Verified booking
            </Badge>
          ) : null}
          {row.isSample ? (
            <Badge className="text-brand-ink border-0 bg-slate-100">Seed content</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{utcIsoToManilaLabel(row.createdAt)}</p>
      </div>

      <div className="text-sm">
        <p className="text-brand-ink font-semibold">{row.name}</p>
        <p className="text-muted-foreground text-xs">
          {row.tourTitle ?? 'General feedback (no tour)'} · {bookingInWords(row)}
        </p>
      </div>

      {subscores ? <p className="text-brand-ink text-xs">{subscores}</p> : null}

      <p className="text-brand-ink text-sm leading-relaxed">{row.body}</p>

      {row.reply ? (
        <div className="border-brand-gold-500 bg-brand-blue-50 rounded-lg border-l-4 p-3">
          <p className="text-brand-blue-900 text-xs font-semibold">Our reply</p>
          <p className="text-brand-ink mt-1 text-sm leading-relaxed">{row.reply}</p>
          {row.repliedAt ? (
            <p className="text-muted-foreground mt-1 text-xs">
              Replied {utcIsoToManilaLabel(row.repliedAt)}
            </p>
          ) : null}
        </div>
      ) : null}

      {rowBanner ? (
        <p role="alert" className={ALERT}>
          {rowBanner}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className={row.status === 'published' ? OUTLINE_BUTTON : PRIMARY_BUTTON}
          disabled={row.status === 'published' || setStatus.isPending}
          onClick={() => changeStatus('published')}
        >
          {row.status === 'published' ? 'Published' : 'Publish'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={OUTLINE_BUTTON}
          disabled={row.status === 'hidden' || setStatus.isPending}
          onClick={() => changeStatus('hidden')}
        >
          {row.status === 'hidden' ? 'Hidden' : 'Hide'}
        </Button>
        {!replying ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={OUTLINE_BUTTON}
            onClick={() => setReplying(true)}
          >
            {row.reply ? 'Edit reply' : 'Add a reply'}
          </Button>
        ) : null}
      </div>

      {replying ? (
        <ReplyForm
          row={row}
          onClose={() => setReplying(false)}
          onSaved={() => {
            setReplying(false);
            void utils.admin.reviews.queue.invalidate();
          }}
        />
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------- Denied state */

function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner and dispatcher only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Reviews</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner and dispatcher can moderate reviews.
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

function ReviewsAdmin() {
  const list = trpc.admin.reviews.queue.useQuery(undefined, { retry: false });

  // The second denial layer: the ROLE check in `AdminReviewsPage` only
  // catches a session this client already knows is refused. A session that
  // LOOKS allowed to this page but whose `reviewsModeration` grant the
  // server has since revoked only surfaces here, when the queue itself comes
  // back refused.
  if (list.isError && isRoleRefusal(list.error)) {
    return <DeniedState />;
  }

  const rows = list.data ?? [];
  const pendingCount = rows.filter((row) => row.status === 'pending').length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Operations
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Reviews</h1>
        <p className="text-brand-error text-sm">
          Guest reviews waiting for a decision, and every review that has already been published or
          hidden. Publishing and hiding are both reversible.
        </p>
      </header>

      {list.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading reviews…
        </p>
      ) : list.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the reviews. Sign in again, or try once more in a moment.
        </p>
      ) : rows.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>No reviews yet.</p>
      ) : (
        <>
          <p role="status" className={NOTICE}>
            {pendingCount === 0
              ? 'Nothing waiting for a decision.'
              : `${pendingCount} ${pendingCount === 1 ? 'review' : 'reviews'} waiting for a decision.`}
          </p>
          <ul className="space-y-3">
            {rows.map((row) => (
              <ReviewRow key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.reviews`
 * call from anyone but owner and dispatcher. This just stops a finance user
 * who types the address from being shown a form that can only be refused.
 * The second denial layer — a refused `admin.reviews.queue` this role check
 * did not catch — lives inside `ReviewsAdmin`, beside the query it guards.
 */
export default function AdminReviewsPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner' && me.data.role !== 'dispatcher') {
    return <DeniedState />;
  }

  return <ReviewsAdmin />;
}
