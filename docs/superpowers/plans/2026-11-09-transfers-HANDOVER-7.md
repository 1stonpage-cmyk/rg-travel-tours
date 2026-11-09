# Transfers — Handover 7, 2026-11-09 (DEMO POLISH batch, owner decisions 2026-11-09)

**Status: 1A–1H all done, reviewed, and committed. 2A (admin QA) done. 2B (re-check) done — all items confirmed fixed. Not pushed. Next task: T17.**

`main` was at `5b4dc88` (Handover 6) when this batch started. This batch closes all four Must-fix findings Handover 6's QA walkthrough logged — the `/transfer` overflow, the hardcoded "Book a tour" CTA, the blank 404, and BUG-124 — plus three fresh owner decisions (branded 404, transfer-first copy, route-before-type hint) and one piece of housekeeping (dotenv's tip line). See Handover 6 for everything before this batch; this doc does not repeat it.

## Commits, this batch

| Task | Commit    | Label                                                                                            |
| ---- | --------- | ------------------------------------------------------------------------------------------------ |
| 1G   | `93736c3` | chore(scripts): silence dotenv's promotional tip line in db-preflight                            |
| 1E   | `d3f5acd` | feat(seed): transfer-first base seed copy for the hero/how-it-works/why-book/FAQ blocks          |
| 1C   | `405334f` | feat(client): branded 404 page via a catch-all route                                             |
| 1B   | `aad5fa2` | feat(client): gate remaining guest CTAs on show_tours                                            |
| 1A   | `92894f4` | fix(transfer): route-card place names no longer force horizontal overflow at 360px               |
| 1D   | `41e7287` | fix(reviews): BUG-124 -- no tour-identifying data from reviews.published while show_tours is off |
| 1F   | `cdd2216` | feat(transfer): show a clear next step when a route is picked before a type                      |
| 1H   | `5226a17` | test(client): fix a pre-existing motion.test.tsx assertion broken by 1B's async CTA              |

`git log --oneline -1` on `main` currently shows `5226a17`, eight commits ahead of `5b4dc88`. **Nothing in this batch has been pushed.**

## Owner decisions this batch (given directly by the owner, 2026-11-09)

1. **Every guest-facing CTA follows `show_tours`**: OFF → "Book a transfer" → `/transfer`; ON → keep the current tour CTA. Read the existing setting; no new setting added. Built in 1B.
2. **Unknown URLs get a branded 404 page inside the normal layout**, with links to Home and "Book a transfer." The server's existing 404 status/title behaviour is unchanged. Built in 1C.
3. **BUG-124**: while `show_tours` is OFF, review cards on public pages show no tour name, tour link, or tour-identifying text — rating, review text, guest first name, and date only. ON is unchanged. Applies to every public surface rendering review cards, JSON-LD included. Built in 1D.
4. **Seed copy rewritten transfer-first** for the home/hero/section copy, so the site reads as a transfer service while `show_tours` is off. Base seed stays insert-only — new installs get the new copy, this already-seeded database does not (confirmed, see 2B below). Built in 1E.

## What each task built

**1G** — `server/scripts/db-preflight.mjs` now passes `quiet: true` to dotenv's `config()` call, matching the two other call sites (`env.ts`, `drizzle.config.ts`) that already had it. Verified directly: the promotional tip line is gone from `node scripts/db-preflight.mjs` output.

**1E** (decision 4) — `server/src/db/seed-data.ts`'s `SEED_SETTINGS`: hero headline/subtitle rewritten transfer-first, `how_it_works[0]` and two `why_book_direct` entries reworded off "tour," two FAQ entries reworded ("private or shared transfer," "transfer day"). `hero.ctaLabel` was changed to "Book a transfer" by the implementer and **reverted by the controller** to `'Search tours'` — it is exclusively the label of the ON-state secondary tour-search form (`HeroSection.tsx:447`), which decision 1 says must keep its current tour CTA; changing it would have broken that decision for the ON state. No stats, ratings, permits, or prices invented. `insertSettingIfMissing`/`seedBase` untouched — still insert-only.

**1C** (decision 2) — new `client/src/pages/public/NotFoundPage.tsx` (Compass icon, "Error 404" eyebrow, Home + "Book a transfer" buttons, both `tap-target`-sized) plus a `<Route path="*" element={<NotFoundPage />} />` added last inside `App.tsx`'s `<PublicLayout>` block. `document.title` deliberately untouched — the server-injected title for an unmatched path already stands. Confirmed live this session that an unmatched `/admin/*` path **also** falls through to this same public catch-all, losing the admin shell entirely — see 2A finding below.

**1B** (decision 1) — three previously-hardcoded CTAs made settings-driven, reusing the existing `settings.get` query: `FloatingWhatsApp.tsx`'s mobile sticky bar, `CheckoutPage.tsx`'s "no selection" empty state, `BookingStatusPage.tsx`'s bottom CTA. `SiteHeader.tsx` deliberately **not** touched — it already hardcodes "Book a transfer" unconditionally per an earlier owner decision (T14), and that is correct, not a gap decision 1 reopens.

**1A** — `RoutePicker.tsx`'s route-card place-name label had `truncate` (forcing `white-space:nowrap`) on a flex row that was already `min-w-0`; `min-w-0` alone cannot fix already-unbreakable text. Fix: `truncate` → `min-w-0 break-words`. Confirmed this session via a true 360px iframe render (see below) that `scrollWidth === clientWidth` (341px, no overflow) on `/transfer`.

**1D** (decision 3, BUG-124) — `reviews.published` now reads `showTours` first (matching `forTour`'s existing BUG-122 pattern), nulls `tourId`/`tourTitle` on every output item when off, and — the dedicated Opus reviewer's addition — computes `effectiveTourId = showTours ? input.tourId : undefined` so the INPUT filter can no longer be used as an existence/popularity oracle over a hidden tour via a direct `{tourId: N}` call. Confirmed live this session: the home page's review cards show zero tour-identifying text while `show_tours` is off.

**1F** — `TransferTypePicker.tsx` exports a stable element id; `TransferBookingPage.tsx` now shows "Choose a transfer type above first" via the picker's existing `error` prop and scrolls it into view (respecting `prefers-reduced-motion`) when a route is picked before a type. Route selection is preserved, not reset, when the hint fires. Confirmed live this session on desktop: hint appears, clears on type selection, route stays selected.

**1H** (five checks) — full-suite `pnpm test` surfaced a pre-existing `motion.test.tsx` assertion broken by 1B's new async `settings.get` dependency in `FloatingWhatsApp` (synchronous `getByRole` caught the component mid-render, before `showTours` resolved from its `?? false` default). Fixed by awaiting `findByRole`. Also found and cleaned up 2 stray `rg_travel_test.users` rows (`#95342`/`#95343`, zero dependent rows) that the leak-detector guard caught mid-run — see "Known gaps" below, this is a recurrence worth tracking, not a one-off.

## Rulings made this batch

1. **`hero.ctaLabel` reverted from "Book a transfer" back to "Search tours"** (1E) — it is the ON-state-only secondary tour-search form's label; decision 1 says the ON state keeps its current tour CTA, so changing this string would have silently broken that for anyone who later turns `show_tours` back on. Both decision 4 and decision 1 apply here; decision 1 wins for this one field.
2. **`SiteHeader.tsx`'s unconditional "Book a transfer" was left untouched** (1B) — it predates and is independent of decision 1's gating (set in task T14), not a gap decision 1 reopens.
3. **1D's client-side test for the no-tour-title behaviour was deleted, not kept** — the dedicated Opus reviewer proved it couldn't fail (the mock data was already pre-nulled, so deleting the component's guard left all tests green) and found the identical coverage already existed, and already mutation-fails correctly, in a pre-existing test (`packages-reviews.test.tsx`). `client/src/__tests__/home.test.tsx`'s diff is empty as a result — it is not part of the 1D commit.
4. **1D's server-side fix was extended beyond the implementer's first pass** — nulling only the output fields left the procedure's `tourId` INPUT parameter still driving the `WHERE` clause and both aggregate calls, so a direct `{tourId: N}` call while `show_tours` was off still answered a hidden tour's real rating and review count. The dedicated Opus reviewer judged this genuinely in scope (BUG-124's own framing is "an existence-and-popularity oracle over a sequential integer") and fixed it directly with `effectiveTourId`, adding two more mutation-proven tests.

## 2A — Admin QA (read-only, owner's existing session)

Walked `/admin`, `/admin/vehicle-types`, `/admin/transfer-places`, `/admin/transfer-routes` (opened the edit form — combobox + "Add new place", hours+minutes, price table, reverse toggle, all confirmed working), `/admin/vans`, `/admin/drivers` (confirmed the transfer-jobs-override field and its helper text), `/admin/bookings`, `/admin/settings` (confirmed `show_tours` is OFF on this database; viewed only, never changed). Nothing was submitted, saved, or changed. Checked at the environment's actual desktop width (~1920px, which exercises the same top-tier Tailwind breakpoint 1440px would) and, via a same-origin 360px `<iframe>` harness injected into a loaded page (the documented workaround for this environment's broken window-resize tool, logged as BUG-074 in `docs/BUGS_LOG.md`), at a genuine 360px mobile viewport.

### Must fix before demo

None found.

### Should fix

1. **An unmatched `/admin/*` path falls through to the full PUBLIC 404 page**, not an admin-shell not-found. Confirmed live at `/admin/this-does-not-exist`: public header, nav (Transfers/Packages/Reviews/FAQ/Contact), WhatsApp/Viber bubbles, and the "Book a transfer" CTA render — the admin sidebar, staff identity, and all admin navigation are gone. A staff member who mistypes an admin URL loses their console context entirely and sees guest-facing content instead. This is a direct, foreseeable side effect of 1C's catch-all route (which was correctly scoped to the public layout per decision 2's wording) rather than a defect in 1C itself — decision 2 did not carve out admin paths, and fixing it would need either an admin-specific catch-all nested inside `AdminLayout` or a redirect-to-login for an unauthenticated unmatched admin path. Page: any unmatched `/admin/*` path, confirmed at both 1920px and 360px.
2. **The Transfer-routes edit form's "Save changes" button sits above the "Prices per vehicle type" table, and the price table's own section ends with only a "Cancel" button** — no second save control near the prices. It is not visually obvious to a dispatcher editing only a price whether the (now scrolled-past) "Save changes" button above also covers the price table below, or whether prices save through some other path. Not tested to confirm or rule out an actual functional gap (2A is read-only, and finding out would require submitting the form) — flagging as a UX clarity concern for a sighted follow-up, not a confirmed bug. Page: `/admin/transfer-routes` (edit form), confirmed at both 1920px and 360px.

### Nice to have

- None beyond the two Should-fix items above. Vehicle types, transfer places, vans, drivers, and bookings pages were all clean at both sizes: no overflow, no red, consistent tap-target sizing, admin nav correctly collapses to a bottom tab bar on mobile, status badges use blue/grey/amber (never red).

## 2B — Re-check of 1A–1F at 360px and 1440px

All confirmed fixed. Checked at the environment's actual desktop width and via the same 360px iframe harness used for 2A.

1. **1A (`/transfer` overflow)** — **Fixed.** `scrollWidth === clientWidth` (341px) measured directly inside the 360px iframe on `/transfer`; the long route-card label now wraps across three lines with zero horizontal overflow.
2. **1B (guest CTAs)** — **Fixed**, all three surfaces: the mobile sticky bar's "Book a transfer" link (confirmed in the DOM and visually in the 360px render, alongside the WhatsApp bubble), `CheckoutPage`'s "Select a tour first" empty state ("Book a transfer" → `/transfer`, confirmed at `/checkout/:tourSlug` with no hold selected), and `BookingStatusPage`'s bottom CTA (confirmed on a real booking, `RG-VVBQ5T`). All three read `show_tours` (currently OFF) correctly.
3. **1C (branded 404)** — **Fixed.** Confirmed on a public unmatched path at both sizes: full site chrome, Error 404 eyebrow, Home + "Book a transfer" buttons, no overflow at 360px.
4. **1D (BUG-124)** — **Fixed.** The home page's "What guests say" section shows star rating, placeholder review copy, guest first name, and date only — zero tour name or tour link anywhere — confirmed at both sizes.
5. **1E (transfer-first copy)** — **Correctly unchanged on this live database**, which is the expected and correct outcome, not a bug: the base seed is insert-only, so `rg_travel`'s already-seeded `settings` rows keep the old tour-centric strings (confirmed live: the hero still reads "Private Cebu day tours, booked direct..."). The fix was verified against the source instead — `git show d3f5acd` against `SEED_SETTINGS`, confirming `insertSettingIfMissing` is still the writer. A fresh install, or an admin manually re-entering the copy in Settings → Home content, will show the new strings. Do not read the unchanged live copy as a failure of this task.
6. **1F (route-before-type hint)** — **Fixed.** Selecting a route before a transfer type shows "Choose a transfer type above first" beside the type picker with the route selection preserved; selecting a type afterward clears the hint. Confirmed on desktop.
7. **HeroSection's secondary tour-search form** — confirmed correctly **hidden** on this live database (`show_tours` OFF), both sizes — no stray "Search tours" form visible anywhere on the hero. Worth noting as a latent code-quality item, not a live bug: `HeroSection.tsx:374`'s gate is `showTours !== false` rather than the `?? false` every other gated component in this codebase uses, which could in principle render the secondary form during a brief loading state before `settings.get` resolves (when `showTours` is `undefined`, `undefined !== false` is `true`). This was not reproduced — by the time the page is interactive the query has resolved — so it is not a confirmed bug, just an inconsistency worth a future cleanup pass.

## Known gaps / parked findings

- **(Recurrence, not new) Stray `rg_travel_test.users` rows blocked the server suite mid-batch a second time**, in a session where Handover 6's leak-detector guard (`assertNoPreExistingUsers()`) was already active and working exactly as designed — it caught the rows and refused to let the suite run silently past them. That the guard fired again, during a session with no other failure and heavy parallel-agent test activity, means the guard is doing its job but nothing yet prevents the leak itself. The rows (`#95342`/`#95343`, "Reset Fixture"/"Reset Inactive Fixture", zero dependent `sessions`/`audit_log` rows, same signature as Handover 5's four) were deleted via a guarded scratch script and the files removed immediately after. The underlying cause — almost certainly a `password-reset.test.ts` run whose `afterAll` cleanup never fires on some exit path — is still unfixed and will very likely recur a third time. Worth root-causing before the next batch, rather than continuing to rely on the guard to catch it after the fact.
- Carried from Handover 6, still open and untouched by this batch: the four-sibling-field (`name`/`code`/`licenseNo`/`emergencyContact`) normalization asymmetry on `AdminDriversPage.tsx` — confirmed latent, not live.
- Carried from Handover 6, still open: Handover 5's open question on day-use overrun legal/content gap and "Operated by R&G Travel & Tours" regulatory language for transfers.

## Migrations owed on the server

**0015 through 0024, in order — unchanged from Handover 5 and 6.** No new migration this batch. **0024 removes columns — back up the server database before applying it.**

**After applying migrations, re-run `pnpm --filter @rg/server db:seed`** (insert-only base seed — this batch's 1E copy changes live in `SEED_SETTINGS` and will only reach the server database's `settings` table on first insert there, i.e. only if those specific keys were never seeded before; an already-seeded server database, like this local one, will need the copy entered by hand in Settings → Home content, or a fresh install). Do **not** run `db:seed:demo` against the server.

## Test counts

Full suite at this batch's final commit (`5226a17`), confirmed via the controller's own direct re-runs of every task's affected files plus one full-suite run (not only trusted from any agent's self-report):

- shared: 8 files, 99 tests
- client: 79 files, 1001 tests
- server: 129 files, 2631 tests
- **Total: 216 files, 3731 tests, all green.**

All five checks pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

## Unrelated bugs found

Per CLAUDE.md's unrelated-bugs rule — listed, not fixed:

1. **Admin-subpath → public-404 chrome loss** (2A Should-fix #1 above) — an unmatched `/admin/*` path renders full public site chrome instead of staying inside the admin shell.
2. **Transfer-routes edit form's ambiguous Save-button placement** relative to its own price table (2A Should-fix #2 above) — not confirmed as a functional bug, flagged for UX review.
3. **`HeroSection.tsx:374`'s `!== false` gate** instead of the codebase's usual `?? false` pattern (2B item 7 above) — latent, not reproduced as live.
4. Carried forward, still open: the four-sibling-field normalization asymmetry on `AdminDriversPage.tsx` (Handover 6).

---

**Next task: T17** (`inquiries` schema extension, per the transfers-launch plan's Batch 5, which also starts the new `transferQuoting` role boundary) — unchanged from Handover 6.

Before T17 begins, the root cause of the recurring stray-test-user leak (Known gaps, above) is worth a short investigation — it has now happened twice with the guard active both times, which means the guard is a safety net, not a fix.
