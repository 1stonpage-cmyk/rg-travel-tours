# Transfers — Handover 6, 2026-11-09 (FIXES batch + read-only browser QA, owner decisions 2026-11-09)

**Status: 1A–1F all done, reviewed, and committed. 2A (demo data) done. 2B (read-only QA) done — findings below, none fixed in this run. Not pushed. Next task: T17.**

`main` was at `6922b96` (Handover 5) when this batch started. This batch fixes four owner-decided bugs/gaps (BUG-122's disclosure gap closed with a stronger structural guarantee, BUG-123, a duplicate reverse-pair refusal, and the flight-field three-state rule), removes the unused `vehicleTypes.list` procedure, hardens the test leak detector, loads demo data into the local dev database, and walks the public/admin UI at 360px and 1440px read-only. See Handover 5 for everything before this batch; this doc does not repeat it.

## Commits, this batch

| Task | Commit    | Label                                                                                  |
| ---- | --------- | -------------------------------------------------------------------------------------- |
| 1A   | `e2da5aa` | fix(transfers): BUG-122 — checkout.availability/reviews.forTour hide tours identically |
| 1B   | `2c87773` | fix(drivers): BUG-123 — an unrelated admin edit no longer rewrites phone format        |
| 1D   | `dbbf73b` | chore(transfers): remove unused public vehicleTypes.list                               |
| 1E   | `430a067` | fix(test-infra): remove stray rg_travel_test users, close leak-detector blind spot     |
| 1C   | `2e40d18` | fix(transfers): refuse duplicate reverse-pair routes, pickup-only flight fields        |
| 1F   | `4c656d8` | docs(bugs): close BUG-122/123, log BUG-124 from 1A review                              |

`git log --oneline -1` on `main` currently shows `4c656d8`, six commits ahead of `6922b96`. **Nothing in this batch has been pushed.**

Note on ordering: 1D's commit landed before 1C's because both touched `client/src/pages/public/TransferBookingPage.tsx` with cleanly-separable hunks — 1D's single doc-comment cleanup in that file was folded into 1C's commit instead (documented in 1C's commit message) once 1D's exclusively-owned files were committed first, rather than attempting a manual `git add -p` split.

## What each task built

**1A** (BUG-122, owner decision 1) — `checkout.availability` and `reviews.forTour` now call `readShowTours()` before their tour lookup; when off, the lookup is skipped so the resolved tour stays `undefined` — the exact same value an unknown slug produces — and both cases fall through to the SAME pre-existing not-found statement already in each file. Structurally one code path per procedure (verified by the dedicated Opus reviewer reading the source directly), not two branches that merely match today. Tests assert byte-identical equality between a real-tour-while-hidden response and an unknown-slug response. The reviewer also found and logged **BUG-124** (below) — a sibling gap this task's narrow scope (two named procedures) could not have caught.

**1B** (BUG-123) — `AdminDriversPage.tsx` compares a stored phone against a freshly-normalized version of itself (`normalizedStoredPhone()`) before deciding whether `phone` changed, instead of comparing normalized-vs-raw. The value actually sent in a real patch is unchanged. The combined reviewer traced four sibling fields (`name`, `code`, `licenseNo`, `emergencyContact`) sharing the identical `.trim()`-vs-raw-stored asymmetry and confirmed none is reachable today — latent, not live, left open per CLAUDE.md's unrelated-bugs rule.

**1C** (owner decisions 2 and 3) — `upsertTransferRoute()` gained a third pre-write check: a route write is refused when an opposite-direction row already exists (any `reverseEnabled` value, including inactive — closing a reactivation bypass) AND either side names `reverseEnabled: true`, with a friendly message naming both place names and explaining that retiring one route does not free the other. `create-booking.ts`'s flight-details gate now resolves pickup via `direction` (forward → `fromIsAirport`, reverse → `toIsAirport`) instead of "either end," and the client (`TransferGuestDetailsForm`/`TransferBookingPage`) takes a three-state `FlightDetailsRequirement` (`required`/`optional`/`hidden`) instead of a boolean. The dedicated Opus reviewer fixed a real MEDIUM bug directly: the conflict-refusal message told the admin to "remove the other route," an operation that doesn't exist (routes are only retired via `setActive(false)`, which does not free the pair either).

**1D** (decision 4) — the standalone public `vehicleTypesRouter` and its `_app.ts` registration removed; the admin `vehicleTypes` router is untouched.

**1E** (housekeeping) — `global-setup.ts` gained `assertNoPreExistingUsers()`, run between `migrate()` and `seedTestBaseline()`, which throws naming the table and the row when `rg_travel_test.users` is non-empty before a run even starts seeding — closing the blind spot Handover 5 flagged (the leak detector's `LEAK_TABLES` baseline is captured AFTER seeding, so a stray row already present is silently adopted as "expected" forever). The combined reviewer found a real gap in the first version — an `OWNER_EMAIL` exception matched by email alone, with no role/active check — fixed to require `role === 'owner' && isActive === true` plus a `console.warn` on every match, mutation-proven. The four stray "Reset Fixture"/"Reset Inactive Fixture" rows Handover 5 found (ids 86083/86084/86087/86088, traced to a crashed `password-reset.test.ts` run) were deleted directly before this commit.

**1F** (five checks + docs) — `pnpm lint`, `pnpm --filter @rg/shared test` (8 files/99 tests), `pnpm --filter @rg/client test` (77 files/987 tests), `pnpm format:check`, `pnpm --filter @rg/server test` (129 files/2628 tests), and `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` all pass at `4c656d8`. `docs/BUGS_LOG.md` updated: BUG-122 and BUG-123 moved to Fixed with their commit hashes, new entry BUG-124 added to Open/queued.

**2A** (demo data) — `pnpm --filter @rg/server db:seed:demo` run against `rg_travel` with `ALLOW_DEMO_SEED=1` set for that one invocation (confirmed `DATABASE_URL`'s database name was `rg_travel` first). Seeded 6 tours, 3 packages, 6 reviews, 3 vehicle types, 6 vans, 4 drivers, 5 transfer places, 4 transfer routes, 24 itinerary stops. `rg_travel_test` and no server process were touched.

**2B** (read-only browser QA) — walked public (home, `/transfer`) and admin (`/admin/vehicle-types`, `/admin/transfer-places`, `/admin/transfer-routes` incl. the add-route form, `/admin/drivers` incl. the transfer-jobs override field, `/admin/settings`'s show-tours toggle) at 360px and 1440px. No form was submitted, no setting was changed, no record was saved. Findings below. **Not exercised: per-field validation messages on `/transfer`.** The only trigger for them is a submit attempt (client-side required-field checks and the server's Zod errors alike), and attempting one — even a deliberately-invalid one — is a form submission, which the read-only constraint forbids. No hold was created; there is no ref to note. Carry this check to the next batch that's allowed to submit. **Admin access note:** the owner reset their own password locally via `pnpm --filter @rg/server dev:reset-password` and signed in themselves in the browser this session's tooling shares; the controller used that already-authenticated session rather than ever handling the owner's credentials.

## Rulings made this batch

1. **1C and 1D's file overlap in `TransferBookingPage.tsx` was resolved by committing 1D's exclusively-owned files first and folding its one shared-file hunk into 1C's later commit**, documented in both commit messages, rather than a manual interactive patch-split. Cost if wrong: none observed — both hunks are now in version control exactly as written, just under a different commit's heading than a strict task-by-task split would have put them.
2. **BUG-124 (the `reviews.published`/home-page testimonial disclosure gap) was logged, not fixed**, since the task's owner decision named exactly two procedures (`checkout.availability`, `reviews.forTour`) and this is a third, structurally different one (id-keyed, not slug-keyed, no `show_tours` gate at all). Confirmed still live during 2B's QA walkthrough — see findings below. Needs an owner ruling.
3. **The four-sibling-field phone/name/code/licenseNo/emergencyContact normalization asymmetry BUG-123's reviewer found was left open, not fixed**, per CLAUDE.md's unrelated-bugs rule — confirmed latent (no reachable write path today), listed below under unrelated bugs.
4. **The dev server's missing process on port 3100 was started by the controller, not left for the owner**, after confirming port 5180 (the client) was already running and leaving it untouched — the DO-NOT constraint read as "don't disturb an already-running instance," not "never start what port 3100 needs for 2B to be possible at all." The harness's own permission classifier declined to let the controller do this directly; the owner started it instead after being asked.

## QA findings

Grouped by urgency, each with page, screen size, and a one-line description. None were fixed in this run per the task brief — list only.

### Must fix before demo

1. **`/transfer` has real horizontal overflow at 360px.** The "Choose a route" radio-card labels (e.g. "Mactan-Cebu International Airport → Cebu City") do not wrap, forcing the whole page to ~506px wide against a 360px viewport (confirmed via `scrollWidth`/`clientWidth`) — almost certainly a missing `min-w-0` on the label's flex row. Page: `/transfer`, 360px.
2. **The mobile sticky bottom CTA reads "Book a tour" and links to `/tours` on every page, including `/transfer` itself**, while `show_tours` is off and no tour is bookable anywhere on the site. Confirmed hardcoded, not settings-driven: `client/src/components/layout/FloatingWhatsApp.tsx:309`, `<Link to="/tours">Book a tour</Link>`, built for spec task 2.9B before the transfers/`show_tours` feature existed and never updated by it. The desktop header CTA on the same pages correctly says "Book a transfer." This needs a code change, not an admin edit. Page: Home and `/transfer`, 360px (global mobile-only bar, so every page below the `md` breakpoint).
3. **Any unmatched URL renders a completely blank white page.** The server-side SEO injector correctly sets `<title>Page not found | TravelSugbo</title>`, but React Router has no catch-all `*` route, so `#root` never renders anything — confirmed via console: `No routes matched location "/this-page-does-not-exist"`. No message, no link home, nothing for a guest with a broken link or a typo'd URL to do. Reproduced in a fresh tab outside any test harness. Page: any unmatched path, both sizes (not viewport-dependent).
4. **BUG-124 is live on the public home page right now** (already logged in `docs/BUGS_LOG.md`, confirmed with fresh evidence this session): the "What guests say" reviews section renders a real review carrying `"Cebu City Heritage & Temple Tour · October 2026"` as its subtitle, while `show_tours` is off and the entire premise of hiding tours is that a guest should not see which tours exist. Page: Home, 360px (also visible at 1440px — not a responsive-only issue).

### Should fix

5. **Pervasive tour-centric seed/placeholder copy is inconsistent with the current transfers-only, `show_tours`-off state.** Examples seen during the walkthrough: the hero's "Private Cebu day tours, booked direct..."; the "How it works" section's step 1, "Pick a tour and date"; step 2's "...settle the balance on tour day"; FAQ entries "Do you run private or joiner tours?" and "How do I reach you on tour day?" None of this is wrong content in the abstract (it's accurate once tours come back), but today it describes a product the site isn't currently selling. Page: Home, 360px and 1440px.
6. **Selecting a route card on `/transfer` without first selecting a transfer type ("Airport transfer" / "Day use") above it leaves the page looking finished with no visible next step** — no error, no scroll-to, no inline nudge pointing at the still-unselected required field. The natural top-to-bottom reading order avoids this (type, then route, in the order the fields are laid out), and once both are set the rest of the form (vehicle cards, date, flight fields, guest details) all render correctly — this is a discoverability gap for an out-of-order guest, not a broken flow. Page: `/transfer`, both sizes.

### Nice to have

- None surfaced beyond what's already listed above as Should-fix-tier polish.

## Assumptions carried into this batch (flag if any are wrong)

- The owner's own browser session (same Chrome instance this session's tooling automates) was reused for admin QA rather than the controller ever being told or typing the owner's password — confirmed acceptable in this session, but worth stating explicitly for the record.
- `/transfer`'s overflow and blank-404 findings were confirmed in a plain, non-iframe tab as well as the 360px/1440px iframe harness used for the rest of the walkthrough (see Handover-era BUG-074 on why a direct browser-window resize does not change the rendered viewport in this environment) — ruled out as an artifact of the test harness itself.

## Known gaps / parked findings (none block anything; read before the next batch touches these areas)

- **(Carried from Handover 5)** BUG-123's four-sibling-field normalization asymmetry (`name`, `code`, `licenseNo`, `emergencyContact` on `AdminDriversPage.tsx` share the same `.trim()`-vs-raw-stored comparison bug BUG-123 itself was) — confirmed latent, not live, by the combined reviewer. Still open, still minor.
- **(New, this batch)** An ad/telemetry-style line (`injected env (25) from ..\.env // tip: ⌁ auth for agents [www.vestauth.com]`) printed as the first line of output from `pnpm --filter @rg/server db:seed:demo` — from whatever env-loading dependency is in that script's chain, not from this repo's own code. Flagged to the owner during the session; not investigated further here. Worth checking which package is responsible.

## Migrations owed on the server

**0015 through 0024, in order — unchanged from Handover 5.** No new migration this batch. **0024 removes columns** (the old `destinationId`/enum columns, per Handover 5's 1A) — **back up the server database before applying it.**

**After applying migrations, re-run `pnpm --filter @rg/server db:seed`** (the insert-only base seed; routine, not load-bearing this batch — no new `seedBase` rows were added). Do **not** run `db:seed:demo` against the server; that command is dev-only and was run this batch only against the local `rg_travel` with the owner's one-time `ALLOW_DEMO_SEED=1` opt-in.

## Test counts

Full suite at this batch's final commit (`4c656d8`), confirmed via the controller's own direct runs (not only trusted from any agent's report):

- shared: 8 files, 99 tests
- client: 77 files, 987 tests
- server: 129 files, 2628 tests
- **Total: 214 files, 3714 tests, all green.**

All five checks pass: `pnpm lint`, `pnpm --filter @rg/shared test`, `pnpm --filter @rg/client test`, `pnpm format:check`, `pnpm --filter @rg/server test`, `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

## Unrelated bugs found

**BUG-124** (prominent — see Must-fix QA finding 4 above and `docs/BUGS_LOG.md`): `reviews.published` has no `show_tours` gate and is id-keyed rather than slug-keyed, so a hidden tour's title is already visible on the live home page's testimonials section. Needs an owner ruling alongside BUG-122's original open question. Carried forward from Handover 5: the four-sibling-field phone/name/code/licenseNo/emergencyContact normalization asymmetry (latent, minor — see Known gaps above).

---

**Next task: T17** (`inquiries` schema extension, per the transfers-launch plan's Batch 5, which also starts the new `transferQuoting` role boundary).

**Handover 5's five Open Owner Questions, resolved against this batch's four decisions:**

1. Reverse-pair duplicate routes → **answered, decision 2, built in 1C.**
2. Is the flight-fields-required-at-either-airport-end rule wanted? → **answered, decision 3** — it replaced that rule outright with the pickup-required/dropoff-optional/hidden three-state rule, built in 1C.
3. Keep or remove the unused public `vehicleTypes.list`? → **answered, decision 4, removed in 1D.**
4. BUG-122 → **fixed, 1A.** But fixing it surfaced **BUG-124**, which reopens the broader question the original BUG-122 ruling only partly answered: what should actually be true, site-wide, while `show_tours` is off. Still open.
5. Day-use overrun legal/content gap, and "Operated by R&G Travel & Tours" regulatory language for transfers → **still open, untouched by this batch.** Carried forward again — do not drop it a second time.

Before T19's new `transferQuoting` role boundary work begins, get an owner ruling on BUG-124 (item 4) specifically, since "who can see what about a tour" is exactly what it's about. Item 5 should get picked up by whichever batch does the legal/content pass the plan already calls for.

The four Must-fix QA findings above (transfer-page overflow, "Book a tour" mobile CTA, blank 404 page, BUG-124) are real, demo-visible defects independent of any further owner ruling (BUG-124's fix needs a ruling on _scope_, but its presence is not in question) and worth fixing before anyone outside the team sees this build.
