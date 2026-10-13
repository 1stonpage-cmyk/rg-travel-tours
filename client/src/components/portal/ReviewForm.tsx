/**
 * The post-tour review form (BUILD_SPEC §7, Week 4 Task 10).
 *
 * A rating, a few words, and four optional sub-scores. It appears only
 * when the server says `canReview` — after `completed`, and only if the
 * guest has not already written one.
 *
 * ## Radio groups, not clickable stars
 *
 * Each rating is a real `<fieldset>` of five radio inputs, visually styled
 * as stars. That is the accessible-name guidance followed rather than
 * worked around: a row of five buttons needs five `aria-label`s and still
 * leaves a screen-reader user guessing what the group is for, while a
 * fieldset with a legend announces "Overall rating, 4 of 5" by itself and
 * arrow-keys between options for free. The stars are `aria-hidden`
 * decoration over the control, never the control.
 *
 * ## The sub-scores are optional, and the form says so
 *
 * §7 asks for sub-scores; it does not ask for four compulsory ones. A form
 * that demands them gets fewer reviews, not better ones — so each carries
 * a visible "(optional)" and the server's schema agrees.
 *
 * ## Nothing here publishes anything
 *
 * The mutation sends a rating, a body and the sub-scores. The booking, the
 * tour, the guest's name and the `pending` status are all the server's
 * (`portal.submitReview`), so there is no field in this form that could
 * put a review on the public site.
 *
 * Mobile-first: one column at 360px, 44px targets on every star row, amber
 * for any refusal and no red.
 */
import { useState, type FormEvent } from 'react';
import { Loader2, Star } from 'lucide-react';
import {
  REVIEW_BODY_MAX,
  REVIEW_SUBSCORES,
  REVIEW_SUBSCORE_LABELS,
  type ReviewSubscore,
} from '@rg/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';

const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * One rating as a radio group. `name` makes the five inputs one control;
 * the legend is what a screen reader announces for the group.
 */
function StarChoice({
  name,
  legend,
  optional,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  optional?: boolean;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  return (
    <fieldset>
      <legend className="text-brand-blue-900 text-sm font-medium">
        {legend}
        {optional ? <span className="text-muted-foreground font-normal"> (optional)</span> : null}
      </legend>
      <div className="mt-1 flex items-center gap-1">
        {SCORES.map((score) => (
          <label
            key={score}
            className="tap-target focus-within:ring-brand-blue-600 flex cursor-pointer items-center justify-center rounded-md px-1 focus-within:ring-2"
          >
            <input
              type="radio"
              name={name}
              value={score}
              checked={value === score}
              onChange={() => onChange(score)}
              className="sr-only"
            />
            <span className="sr-only">
              {score} {score === 1 ? 'star' : 'stars'}
            </span>
            <Star
              aria-hidden="true"
              className={cn(
                'size-7 transition-colors',
                value !== undefined && score <= value
                  ? 'fill-brand-gold-600 text-brand-gold-600'
                  : 'text-brand-blue-200',
              )}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type Props = {
  /** Called after a successful submission, so the page can refetch. */
  onSubmitted?: () => void;
};

export default function ReviewForm({ onSubmitted }: Props) {
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [body, setBody] = useState('');
  const [subscores, setSubscores] = useState<Partial<Record<ReviewSubscore, number>>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = trpc.portal.submitReview.useMutation({
    onSuccess: () => onSubmitted?.(),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    submit.reset();

    if (rating === undefined) {
      setLocalError('Please choose a star rating.');
      return;
    }
    submit.mutate({ rating, body: body.trim(), ...subscores });
  }

  if (submit.isSuccess) {
    return (
      <p
        role="status"
        className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-lg border p-4 text-sm font-medium"
      >
        Thank you — your review is with our team and will appear on the site once it has been
        checked.
      </p>
    );
  }

  const error = localError ?? (submit.isError ? submit.error.message : null);

  return (
    <form onSubmit={onSubmit} aria-labelledby="review-heading" className="space-y-5">
      <div>
        <h2 id="review-heading" className="text-brand-blue-900 text-base font-semibold">
          How was your tour?
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your review appears on the site once our team has checked it.
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
        >
          {error}
        </p>
      ) : null}

      <StarChoice name="rating" legend="Overall rating" value={rating} onChange={setRating} />

      <div className="space-y-4">
        {REVIEW_SUBSCORES.map((field) => (
          <StarChoice
            key={field}
            name={field}
            legend={REVIEW_SUBSCORE_LABELS[field]}
            optional
            value={subscores[field]}
            onChange={(next) => setSubscores((current) => ({ ...current, [field]: next }))}
          />
        ))}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="review-body" className="text-brand-blue-900 text-sm font-medium">
          Your review
        </label>
        <textarea
          id="review-body"
          name="body"
          rows={5}
          maxLength={REVIEW_BODY_MAX}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="border-input bg-background focus-visible:ring-brand-blue-600 w-full rounded-md border p-3 text-sm focus-visible:outline-none focus-visible:ring-2"
          placeholder="What did you enjoy? Anything we could do better?"
        />
      </div>

      <Button type="submit" disabled={submit.isPending} className="tap-target w-full">
        {submit.isPending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            Sending…
          </>
        ) : (
          'Send review'
        )}
      </Button>
    </form>
  );
}
