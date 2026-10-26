import type { ReactNode } from 'react';

/**
 * Every [PLACEHOLDER] in the owner-approved drafts (C:\dev\project-notes\RGTravelTours\legal\)
 * that is genuinely unconfirmed renders through this component, never as plain bracket text
 * (owner decision 2026-10-27, #2). Visible text is always exactly "To be confirmed" — `context`
 * is sr-only, so a screen reader hears what's pending when several chips sit close together (a
 * table full of them) without changing what a sighted reader sees.
 *
 * Amber, never red (CLAUDE.md) — `brand-gold-100`/`brand-gold-800` is the same contrast-safe
 * pairing the existing settings-driven legal pages already used for their own "needs review"
 * notice (BUG-080: `text-brand-warning` on `bg-brand-gold-100` measured only 4.51:1, no headroom).
 */
export function PlaceholderChip({ context }: { context: string }) {
  return (
    <span className="bg-brand-gold-100 text-brand-gold-800 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold">
      {context ? <span className="sr-only">{context}: </span> : null}
      To be confirmed
    </span>
  );
}

export type LegalSection = {
  id: string;
  heading: string;
  body: ReactNode;
};

export type LegalPageContent = {
  title: string;
  /** Rendered next to "Effective date:" — a `PlaceholderChip` until R&G confirms one. */
  effectiveDate: ReactNode;
  sections: LegalSection[];
};

/** Shared scroll-inside-a-box wrapper for any table, per task 2B (360px requirement). */
export function ScrollableTable({ children }: { children: ReactNode }) {
  return (
    <div className="border-border mt-3 overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[480px] text-left text-sm">{children}</table>
    </div>
  );
}
