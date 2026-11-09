import type { ReactNode } from 'react';

export interface AdminPageHeaderProps {
  /** Short uppercase section label, e.g. "Operations". */
  eyebrow: string;
  title: string;
  description?: string;
  /**
   * The page's one primary action (CLAUDE.md "Admin buttons": at most ONE
   * primary per view) — typically `<Button variant="primary-pill">`. Forced
   * full-width only below `sm`, auto-width from `sm` up, via the `[&>*]`
   * child selector below, so a caller never has to remember to pass
   * `w-full sm:w-auto` on the button itself.
   */
  action?: ReactNode;
}

/**
 * B1 (DEMO POLISH batch, 2026-11-09): the shared page-header shape every
 * admin screen already hand-rolled (eyebrow / `<h1>` / description), paired
 * with the owner's placement rule for the primary action (decision 1):
 * "the main action sits top-right next to the title (wraps under it at
 * 360px; full width only there)". Replaces the old pattern of a full-width
 * primary button rendered on its OWN row below the header, which read as
 * the generic blue CTA bar the owner specifically disliked.
 */
export default function AdminPageHeader({
  eyebrow,
  title,
  description,
  action,
}: AdminPageHeaderProps) {
  return (
    <header className="flex flex-col flex-wrap items-start justify-between gap-4 sm:flex-row sm:items-center">
      <div className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          {eyebrow}
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">{title}</h1>
        {description ? <p className="text-brand-error text-sm">{description}</p> : null}
      </div>
      {action ? (
        <div className="w-full sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">{action}</div>
      ) : null}
    </header>
  );
}
