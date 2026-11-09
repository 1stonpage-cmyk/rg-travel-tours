# Admin buttons — Handover 8, 2026-11-09 (Batch 4c: Option A rollout + pre-tasks, crash-recovery resume)

**Status: R1/R2 (crash recovery) done. 0A, 0B, B1, B3 were already committed before this
session (crashed session, confirmed via its own compacted transcript and git history). This
session: finished B2 across every remaining admin page and two shared components it surfaced,
did B4 (this file's sibling section in `CLAUDE.md`), and did B5 (read-only Chrome QA). Batch
4c is now complete. Not pushed.**

`main` was at `dd59773` (B2 part 1 — vehicle types/transfer routes only) when this session
started, after a Bun segfault crashed the prior session mid-batch. See "Crash recovery" below
for what was actually found versus what the resume prompt assumed.

## Crash recovery (R1/R2)

The resume prompt assumed two background agents ("B2 buttons: dashboard/bookings/payments
group" and "B2 buttons: dispatch/fleet group") were mid-edit when the Bun segfault hit, and
asked for `git status`/`git diff --stat` to find and triage their uncommitted work.

**What was actually found:** the working tree was completely clean at `dd59773` — `git
status` showed nothing staged, modified, or untracked, and `git stash list` was empty. Both
agents' own task-output files on disk were **0 bytes**, confirming they crashed before
producing any output at all — there was nothing to triage or revert.

What the resume prompt's own "✅ DONE R1/R2/R3" markers could not have reflected (they were
stale — this session verified the real state from scratch, not from those markers) is that a
**real, separate bug existed at `dd59773` itself**, caught by running the five checks as a
baseline before touching anything (per the resume instructions' own emphasis on this): 0B's
new test (`admin-transfer-routes.test.ts`, committed `e26d10b` by the crashed session) cleaned
up its booking fixture with `getDb().delete(bookings)` — a Drizzle hard-delete on `bookings`,
which `schema-conventions.test.ts`'s "never hard-deletes a booking or a payment anywhere in
the server source" guard forbids **project-wide, test files included, by design** (the guard's
own comment: "no allow-list to rot"). Fixed by switching to the same raw-SQL cleanup idiom
`record-payment.test.ts` already established for exactly this purpose
(`getPool().query('DELETE FROM bookings WHERE id = ?', [bookingId])`), which the guard's
raw-SQL check deliberately scopes to app source, not tests. Commit `a81ce54`.

The B4/B5 task definitions were not written down anywhere in the repo (no plan doc existed for
this batch — it was a single large chat prompt to the crashed session). They were recovered
from that session's own compacted-conversation summary, found in its transcript file
(`2d23808e-9b48-4049-bd05-9047016e6422.jsonl` under this machine's Claude project data),
rather than re-invented.

## Commits, this session

| Task               | Commit    | Label                                                                         |
| ------------------ | --------- | ----------------------------------------------------------------------------- |
| R2 (baseline fix)  | `a81ce54` | fix(test-infra): 0B's own cleanup hard-deleted a booking via drizzle          |
| B2 (part 2)        | `f461490` | feat(admin): B2 (part 2) -- Clean Pill buttons on dashboard/bookings/payments |
| B2 (part 3)        | `608fda3` | feat(admin): B2 (part 3) -- Clean Pill buttons on dispatch/fleet pages        |
| B2 (part 4)        | `bf4e66e` | feat(admin): B2 (part 4) -- Clean Pill buttons on the shared AssignPanel      |
| B2 (part 5)        | `469682d` | feat(admin): B2 (part 5) -- Clean Pill buttons on content pages               |
| B2 (part 6)        | `fc55c5c` | feat(admin): B2 (part 6) -- Clean Pill buttons on settings/staff/reports      |
| B2 (part 7, final) | `7269c1b` | feat(admin): B2 (part 7, final) -- Clean Pill buttons on the pre-auth pages   |
| B4                 | `6ffd803` | docs(admin): B4 -- CLAUDE.md "Admin buttons" section                          |
| B2 (part 8)        | `22221a9` | feat(admin): B2 (part 8) -- Clean Pill buttons on CancelRefundPanel           |

`git log --oneline -1` on `main` now shows `22221a9`, nine commits ahead of `dd59773` (fifteen
ahead of `5b4dc88`, Handover 6). **Nothing this session has been pushed.**

Carried from before this session (already committed, not redone): `93736c3` (1G),
`d3f5acd` (1E), `405334f` (1C), `aad5fa2` (1B), `92894f4` (1A), `41e7287` (1D), `cdd2216`
(1F), `5226a17` (1H), `2fc9c48` (Handover 7), `afb04a6` (0A), `e26d10b` (0B), `568cc7d` (B1),
`3d3ed97` (B1 follow-up), `1ab01d7` (B3), `dd59773` (B2 part 1).

## B2, finished — every admin page, in full

Dispatched one implementer at a time (never in parallel — the crash happened with several
running at once), each scoped to 4–5 files, each verified by the controller (diff read in
full, its own affected test files run, `eslint --max-warnings=0`, project-wide `tsc --noEmit`,
`prettier --check`) before committing. Groups, in order:

1. **dashboard/bookings/payments** (`f461490`) — AdminDashboardPage, AdminBookingsPage,
   AdminBookingDetailPage, AdminPaymentsPage. Added `AdminPageHeader`'s `titleClassName` prop
   to restore the booking ref's `font-mono` styling, which moving its `<h1>` into the shared
   component would otherwise have silently dropped.
2. **dispatch/fleet** (`608fda3`) — AdminCalendarPage, AdminDeparturesPage, AdminVansPage,
   AdminDriversPage. **Bug fixed**: AdminDriversPage's standalone "Yes, deactivate
   {name}"/"Keep {name} active" confirm was solid blue, contradicting the file's own doc
   comment — now amber-pill/admin-ghost.
3. **the shared AssignPanel** (`bf4e66e`) — flagged twice by group 2 as still carrying the old
   look even though both its host pages (AdminCalendarPage, AdminBookingDetailPage) were
   already converted; fixed directly (Suggest → secondary-pill, Assign → primary-pill).
4. **content pages** (`469682d`) — AdminToursPage, AdminPackagesPage, AdminCouponsPage,
   AdminReviewsPage, AdminTransferPlacesPage. **Bug fixed** in all four CRUD pages: each
   "Yes, deactivate ___" confirm was solid blue → now row-amber. AdminReviewsPage (a
   moderation queue, no add-form) treats Publish as `row` and Hide as `row-amber` per-row,
   never a page-level primary.
5. **settings/staff/reports** (`fc55c5c`) — AdminSettingsPage, AdminStaffPage,
   AdminReportsPage, AdminChangePasswordPage. **Bugs fixed**: AdminSettingsPage's "Mark the
   content verified" confirm and AdminStaffPage's "Yes, deactivate"/"Reset and sign out"
   confirms were all solid blue → now amber-pill. AdminSettingsPage's multi-section shape
   (19 independent save regions) keeps one primary **per section**, not per page.
6. **pre-auth pages** (`7269c1b`) — AdminLoginPage, AdminForgotPasswordPage,
   AdminResetPasswordPage. Each had one hand-rolled full-width solid-blue button → primary-pill
   (auto-width, matching the AdminChangePasswordPage precedent from group 5), header left alone
   (different shape — centered logo/eyebrow, no sidebar, no action slot to speak of).
7. **CancelRefundPanel** (`22221a9`) — found during **B5's QA pass**, not any B2 dispatch
   group (it is a shared component mounted by AdminBookingDetailPage, which every group's file
   list missed). Same bug as everywhere else: both the cancel and refund "Yes —" confirms (and
   their own triggers) were solid/outline blue for actions this file's own doc comment calls
   irreversible — now amber-pill/admin-ghost, full-size (each sits alone in its own section,
   not a dense row).

**Every admin page now uses the Option A system.** The repeated destructive-confirm-color bug
(found and fixed independently in six separate places: AdminVehicleTypesPage pre-session,
AdminDriversPage, AdminToursPage, AdminPackagesPage, AdminCouponsPage, AdminTransferPlacesPage,
AdminSettingsPage, AdminStaffPage, and CancelRefundPanel) is the single most consequential
finding of this whole batch — a real, repeated safety-color defect that predates this
project's button redesign and was only surfaced because the redesign touched every file that
had it.

## B4 — CLAUDE.md documentation

Commit `6ffd803`. Written last, per the task brief, once B2's actual adoption had settled —
documents all six variants, the "one primary per visible region" rule including its
multi-section/moderation-queue reading (as actually shipped on AdminSettingsPage/
AdminReviewsPage, not as originally imagined), `AdminPageHeader`/`FormActions`, and the admin 404. Calls out the two deliberate deviations from the owner's spoken description: `admin-ghost`
(not the bare word "ghost" — that key is the public site's own variant) and 44px, not 40px.

## B5 — Read-only Chrome QA (owner's existing logged-in session)

Checked `/admin/vehicle-types`, `/admin/transfer-routes` (add + edit), `/admin/drivers`,
`/admin/bookings` (list + one booking detail), `/admin/settings` (several sections opened) —
at the environment's actual desktop width (1920px) and, since this environment's screenshot
tool (`Page.captureScreenshot`) timed out/failed consistently (a new instance of the same class
of problem as BUG-074, the documented broken window-resize tool — the workaround is the same:
measure programmatically rather than trust a rendered pixel), via `scrollWidth`/`clientWidth`
and computed-style checks run directly against the page (desktop) and against a same-origin
360px `<iframe>` (mobile), which is more rigorous than an eyeballed screenshot since it reads
the real box model rather than a raster image. Nothing was submitted, saved, or changed —
forms were opened/closed and `<details>` blocks expanded via clicks and `.open = true`, never
a Save/confirm click.

**Findings:**

- No overflow at 360px or 1920px on any of the five checked pages, including with the
  transfer-routes add form, the transfer-routes edit form, the drivers edit panel, and two
  settings sections open simultaneously.
- Exactly one `primary-pill` per visible region everywhere checked: vehicle-types list (one
  header "Add"), transfer-routes add/edit forms (one footer "Add route"/"Save changes"),
  drivers list (one header "Add driver", plus one `primary-pill` **per open** "More details"
  disclosure for that driver's own "Add leave" — correctly scoped, not a page-level violation),
  bookings list (no page primary — a pager only), booking detail (one footer "Save note"),
  settings (one `primary-pill` **per open section**, by design).
- Zero red anywhere (checked computed `background-color`/`border-color`/`color` across every
  button on every page, not just a visual glance).
- Focus-visible rings are real and confirmed via actual keyboard `Tab` presses (not
  programmatic `.focus()`, which Chrome does not always resolve to `:focus-visible` the same
  way) — `document.activeElement.matches(':focus-visible')` was `true` with a visible
  box-shadow ring on a tabbed-to control on the booking detail page.
- The booking-ref `font-mono` title and the AssignPanel/CancelRefundPanel fixes (group 1,
  part 4, part 8 above) were all re-confirmed live in the browser after their commits, not
  only in the diff.
- **CancelRefundPanel's blue destructive confirms**, found here and fixed in part 8 above —
  the one new finding this QA pass surfaced beyond what the B2 dispatch groups' own file lists
  already covered.

No must-fix or should-fix items remain open from this pass.

## Owner decisions recorded this batch (unchanged from the original prompt, restated here per

instructions)

1. **ADMIN BUTTONS = Option A "Clean Pill"**, exactly as in `.design-preview/admin-buttons.html`
   (local, git-excluded): primary = solid blue pill, auto-width, at most one per view;
   secondary = white pill, blue outline; ghost = transparent Cancel-type control; destructive
   confirm = amber outline pill, never red; table-row actions = compact pills with a real 44px
   tap target. Page header: action top-right next to the title. Forms: Cancel+Save in a footer
   at the bottom. Unknown `/admin/*` paths render a 404 inside the admin layout.
2. **Public-site buttons are not changed in this run.** Confirmed untouched — no file under
   `client/src/pages/public/` or `client/src/components/public/` was touched by any commit in
   this batch.

## Test counts

Full suite at this batch's final commit (`22221a9`), confirmed via the controller's own direct
re-run of the whole suite (not only trusted from any dispatched agent's self-report, each of
whom ran only their own scoped test files as instructed, to avoid the concurrent-test-DB
contention that contributed to the crash):

- shared: 8 files, 99 tests
- client: 83 files, 1028 tests
- server: 129 files, 2636 tests
- **Total: 220 files, 3763 tests, all green.**

All five checks pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`
(the one pre-existing warning on `.design-preview/admin-buttons.html` is expected — that file
is deliberately git-excluded and was never staged), `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

## Migrations owed on the server

**0015 through 0024, in order — unchanged from Handover 5, 6 and 7.** No new migration this
batch (B2/B4/B5 and the 0B fixup are schema-free). **0024 removes columns — back up the server
database before applying it.** After applying, re-run `pnpm --filter @rg/server db:seed`
(see Handover 7 for the full insert-only-base-seed caveat, unchanged).

## Unrelated bugs found

Per CLAUDE.md's unrelated-bugs rule — listed, not fixed, beyond what this batch's own task
(the destructive-confirm color bug, fixed everywhere it was found) already covered:

1. Carried from Handover 7, still open: admin-subpath → public-404 chrome loss is **actually
   now fixed** by B3 (done before this session) — `AdminNotFoundPage.tsx` exists and
   `App.tsx`'s admin route block carries its own catch-all. Removing this from the open list.
2. Carried from Handover 7, still open: Transfer-routes edit form's ambiguous Save-button
   placement relative to the price table — **also now fixed**, by B2 part 1 (before this
   session): `EntityForm`'s `hideSubmit` + a trailing `FormActions` footer moved the Save
   below the price table. Removing this from the open list too.
3. Carried from Handover 6/7, still open and untouched by this batch: the four-sibling-field
   (`name`/`code`/`licenseNo`/`emergencyContact`) normalization asymmetry on
   `AdminDriversPage.tsx`.
4. Carried from Handover 7, still open: Handover 5's open question on day-use overrun
   legal/content gap and "Operated by R&G Travel & Tours" regulatory language for transfers.
5. New, noticed in passing during B2 part 3 (not fixed, out of scope): driver leave's "Remove"
   action is colored `row` (non-destructive) rather than `row-amber`, even though it deletes a
   leave record — a real row delete, but routine/low-stakes, not account-level like Deactivate.
   Flagged by the implementer as a judgment call worth a second opinion, not a confirmed bug.

## Known gaps

- The recurring stray-`rg_travel_test.users`-row leak (Handover 7's "Known gaps") was not
  investigated this session — this batch's own work never touched `password-reset.test.ts` or
  ran the full suite concurrently with other test-writing work, so there was no new
  opportunity to reproduce or root-cause it. Still open, still worth investigating before the
  next batch that runs many test files in parallel.
- This environment's screenshot tool (`Page.captureScreenshot`) failed on every attempt during
  B5 (timeout, "renderer may be frozen or unresponsive"), a new instance of the same class of
  problem BUG-074 already documents for the window-resize tool. Worked around entirely via
  programmatic DOM/computed-style measurement (see B5 above), which is arguably more rigorous
  for this kind of check, but a future QA pass that specifically needs a _visual_ read (e.g.
  checking a gradient or an icon's actual rendering) will need the screenshot tool working, or
  the built-in browser, or a different approach.

---

**Next task: T17** (`inquiries` schema extension, Batch 5 of the transfers-launch plan) —
unchanged from Handover 6 and 7. Before starting it, re-brief against CURRENT code as the
original merged-run prompt instructed (the transfers-launch plan's T17–T29 text predates the
flexible-routes work), and consider root-causing the stray-test-user leak above first, since it
has now recurred twice with the guard active both times.

Batch 4c is a full session's own work, as flagged in the original merged-run prompt and
reconfirmed by the crashed session's own advisor consultation — Batch 5 deliberately does not
begin in this same session.
