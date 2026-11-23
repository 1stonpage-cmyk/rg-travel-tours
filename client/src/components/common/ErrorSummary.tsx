import { scrollToAndFocus } from '@/lib/scroll-to-field';

export interface ErrorSummaryItem {
  /** The invalid control's own `id`, so a click can scroll+focus it. */
  id: string;
  /** Human field name, e.g. "Mobile number". */
  label: string;
  message: string;
}

/**
 * "Book now" doing nothing visible, closed. Rendered directly above the
 * submit button on every guest form (task brief, 2B) — amber, not
 * `text-brand-error`'s dark blue-grey, because this is the form telling the
 * guest where to look next, which CLAUDE.md's palette rule treats as a
 * warning/attention cue rather than the settled "here is what went wrong"
 * sentence `FieldError` already renders in brand-error ink beside each
 * field (unchanged by this component). See the plan's Flag 1.
 *
 * `bg-brand-gold-50` (#fffbeb) + `text-brand-ink` (#0f172e) are both real
 * `@theme` tokens (verified in `client/src/index.css`), and the pairing
 * clears AA by a wide margin (very dark ink on a near-white wash), so
 * `contrast.test.ts`'s scan of this class string is expected to pass with
 * no further adjustment — run it anyway, as the step below requires.
 */
export default function ErrorSummary({ items }: { items: ErrorSummaryItem[] }) {
  if (items.length === 0) return null;
  return (
    <div
      role="alert"
      className="border-brand-warning/40 bg-brand-gold-50 text-brand-ink rounded-xl border p-4 text-sm"
    >
      <p className="font-semibold">
        Check {items.length} {items.length === 1 ? 'field' : 'fields'} above:{' '}
        {items.map((item) => item.label).join(', ')}
      </p>
      <ul className="mt-2 list-inside list-disc space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="text-brand-blue-700 underline underline-offset-2"
              onClick={(e) => {
                e.preventDefault();
                scrollToAndFocus(item.id);
              }}
            >
              {item.label}
            </a>
            : {item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
