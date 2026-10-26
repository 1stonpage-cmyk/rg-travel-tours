import type { LegalPageContent } from '@/content/legal/shared';

/**
 * Shared shell for all four static legal pages (/privacy, /terms, /refund-policy, /cookies —
 * task 2B, 2026-10-27). Replaces the old per-page `PrivacyPage.tsx`/`TermsPage.tsx` that each
 * fetched `settings.legal.*` and ran it through `Markdown` (Task 3.6) — see
 * docs/superpowers/plans/2026-10-27-legal-pages.md for why: the owner's drafts are static content
 * meant to be swapped in one commit when confirmed, not admin-edited markdown.
 *
 * Same reading-measure choices Task 3.6 already settled on (`max-w-[65ch]`, `leading-relaxed`),
 * kept for visual consistency with the rest of the site. Exactly one `<h1>` — this component's
 * own heading; every section heading below it is an `<h2>`.
 */
export default function LegalPage({ content }: { content: LegalPageContent }) {
  return (
    <article className="mx-auto w-full max-w-[65ch] px-4 py-12 text-base leading-relaxed sm:px-6">
      <h1 className="text-brand-blue-900 text-3xl font-bold tracking-tight">{content.title}</h1>
      <p className="text-muted-foreground mt-2 text-sm">Effective date: {content.effectiveDate}</p>

      <nav aria-label="Sections" className="border-border mt-6 rounded-lg border p-4">
        <p className="text-brand-blue-900 text-sm font-semibold">On this page</p>
        <ol className="mt-2 space-y-1 text-sm">
          {content.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="text-brand-blue-700 hover:underline">
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {content.sections.map((section) => (
        <section key={section.id} id={section.id} className="mt-8 scroll-mt-20">
          <h2 className="text-brand-blue-900 text-xl font-bold tracking-tight">
            {section.heading}
          </h2>
          <div className="mt-2 space-y-3">{section.body}</div>
        </section>
      ))}
    </article>
  );
}
