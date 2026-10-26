# Legal pages + cookie consent banner — owner decisions and architecture

**Goal:** Four public legal pages (`/privacy`, `/terms`, `/refund-policy`, `/cookies`) built from
owner-approved drafts, plus a cookie consent banner gating GA4/Meta Pixel. Source drafts:
`C:\dev\project-notes\RGTravelTours\legal\` (01–05, owner-approved 2026-10-27, "DRAFT for R&G
review" — not legal advice).

## Owner decisions (2026-10-27)

| #   | Decision                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GA4 and Meta Pixel, **both opt-in only**. Essential cookies always on, no toggle.                                                                                                     |
| 2   | Refund rules and business details are **not confirmed** by R&G yet. Every `[PLACEHOLDER]` in the source drafts stays **visible** on the live site as an amber "To be confirmed" chip. |
| 3   | GA4/Pixel IDs come from `VITE_GA_MEASUREMENT_ID` / `VITE_META_PIXEL_ID` client env vars, added **empty** to `.env.example` only. Empty ID = that tool never loads, even with consent. |

## Architecture decision — made mid-task, 2026-10-27

Research before writing any page turned up something the task brief didn't mention: `/privacy`
and `/terms` **already exist** as a working, tested, admin-editable CMS pair — markdown stored in
`settings.legal_privacy` / `settings.legal_terms`, edited through the generic admin "Legal"
settings screen, rendered by the hand-rolled `client/src/components/common/Markdown.tsx`, with
its own passing suite (`legal-pages.test.tsx`: exactly one `<h1>`, an Asia/Manila "Last updated"
conversion, an amber TODO-review blockquote). None of that is this task's doing — it predates it
(Task 3.6).

That's a different architecture from what this task asks for: all **four** pages as hand-authored
static TSX in one module ("so it can be replaced in one commit when R&G confirms"), explicitly
without a markdown renderer. Stopped and asked rather than guess. **Owner's call: replace.**

- `/privacy` and `/terms` are rebuilt from the new static content module, matching
  `/refund-policy` and `/cookies` — all four pages, one architecture, one content module.
- The `settings.legal_privacy` / `settings.legal_terms` DB columns, Zod schema entries, and the
  admin "Legal" settings-editor block **stay in place, untouched** — no schema change, no admin UI
  change. They simply go unread by the client from this point on. Reviving them (or deleting them)
  is a separate future decision, not this one.
- `legal-pages.test.tsx` assertions that pinned the old settings-driven behaviour (markdown from
  `settings.legal.*`, the Asia/Manila `updatedAt` conversion, the seed-specific TODO blockquote)
  are rewritten to assert the new static pages instead — each change proven to fail first.

## Content module

`client/src/content/legal/` — one file per page (`privacy.tsx`, `terms.tsx`,
`refundPolicy.tsx`, `cookies.tsx`) plus `shared.tsx` (the `PlaceholderChip` component and the
shared content shape). A single `LegalPage` layout component (title, effective-date line, in-page
anchor nav, sections) renders all four. Real values already confirmed in `client/src/lib/site.ts`
(`SITE.contact.email`, `SITE.contact.phone.display`) are substituted in directly, never shown as a
placeholder — only genuinely unconfirmed values (business name, address, effective date, every
refund number, retention periods, wait time, balance rule) render as chips.

## Consent system

`client/src/lib/consent/` — localStorage key `ts_consent = {v, analytics, marketing, at}`, 12-month
expiry, version bump re-asks. Google Consent Mode v2 defaults denied. Script injection is gated on
three independent conditions, all required: consent granted for that category, the matching env ID
is non-empty, and the page is a public page (the banner/provider mount inside `PublicLayout` only —
`/admin`, `/driver`, `/portal` never mount it, structurally, not by a runtime path check).

No CSP exists in this repo today (confirmed by full read of `server/src/app.ts` — no `helmet`, no
`Content-Security-Policy` header anywhere). Adding GTM/Pixel script tags is not modifying an
existing allowlist; nothing here changes security headers.
