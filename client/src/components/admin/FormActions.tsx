import { Button } from '@/components/ui/button';

export interface FormActionsProps {
  onCancel?: () => void;
  cancelLabel?: string;
  saveLabel: string;
  pending?: boolean;
  /**
   * `'submit'` (default) — the primary button is `type="submit"` and relies
   * on an ancestor `<form onSubmit>` to fire, the way `EntityForm` already
   * works. `'button'` — the primary button calls `onSave` directly via
   * `onClick`; use this when the fields this footer saves are NOT all
   * inside one `<form>` (e.g. a price table rendered as plain divs after
   * `EntityForm`'s own fields — see `AdminTransferRoutesPage.tsx`), so the
   * footer can sit visually AFTER that content without a native submit
   * event needing to reach back across non-form markup.
   */
  submitType?: 'submit' | 'button';
  onSave?: () => void;
  /**
   * Pins the footer to the bottom of the viewport for a long form, so the
   * save/cancel pair stays reachable without scrolling back up — CLAUDE.md
   * "Forms: ... sticky on long forms". Off by default: a short form (most
   * of this codebase's admin screens) reads better as part of the normal
   * flow than pinned.
   */
  sticky?: boolean;
}

/**
 * B1 (DEMO POLISH batch, 2026-11-09) — the shared form footer (owner
 * decision 1): "actions in a footer at the bottom, right-aligned (Cancel,
 * then primary)". Cancel renders first in the DOM/reading order and visually
 * first (left of) the primary action, matching the design file's own
 * left-to-right "Cancel, Save changes" layout — "right-aligned" describes
 * the PAIR's position within the footer, not swapping which comes first.
 */
export default function FormActions({
  onCancel,
  cancelLabel = 'Cancel',
  saveLabel,
  pending = false,
  submitType = 'submit',
  onSave,
  sticky = false,
}: FormActionsProps) {
  return (
    <div
      className={
        sticky
          ? 'bg-background/95 border-brand-blue-100 sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6'
          : 'flex flex-wrap items-center justify-end gap-3'
      }
    >
      {onCancel ? (
        <Button type="button" variant="admin-ghost" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        type={submitType}
        variant="primary-pill"
        disabled={pending}
        onClick={submitType === 'button' ? onSave : undefined}
      >
        {pending ? 'Saving…' : saveLabel}
      </Button>
    </div>
  );
}
