# HANDOVER-16 (FINAL): T26–T29 complete, Batch 7 closed, transfers-launch plan closed

Continues HANDOVER-15 (T25b, T20b, T21b). This handover closes Batch 7 — the last
batch of `docs/superpowers/plans/2026-10-31-transfers-launch.md` — and the plan
itself. All 29 tasks (T1–T29) are now complete; see that plan's own new
"Execution status" section for the closing summary.

Process for this batch, per the resume brief: controller (Sonnet) with Opus
advisor, consulted before the batch and again before T26 specifically (one
combined round-trip covered both, per the advisor's own direction — see T26
below). Implemented directly, no subagent dispatch, matching HANDOVER-15's own
precedent for Sonnet/combined-review tasks. One combined self-review per task,
no dedicated Opus pass (none of T26–T29 is Opus-tier per the plan's own task
table).

## T26 — placeholder vehicle-card imagery

**Commit `c1fe9fe`.** The demo-routes half of T26 was already delivered early by
the flexible-routes batch's Task 1G (see the note above the Batch 7 table in the
plan) — four real-named routes, `seedDemo`-only. This task was the other half:
placeholder imagery on the guest vehicle cards.

**The trap, and how it was avoided.** `VehicleOptionCard.tsx` carries a standing
design decision (owner decision 2026-11-08): vehicle types are an admin-managed
list of arbitrary size, so the component deliberately hard-codes nothing
per-type — "a type the admin adds tomorrow has no icon this component could
have known to draw." A naive per-slug image with no fallback would have
regressed that promise (a broken `<img>` for any admin-added type). Instead:

- `generate-placeholders.mjs` gained four tiles: `vehicle-van`, `vehicle-suv`,
  `vehicle-mpv` (slugs matching `SEED_VEHICLE_TYPES`), and `vehicle-generic` —
  the fallback that preserves the admin-extensible promise. Compact 640×360,
  not the 1200×800 destination/package tiles.
- `VehicleOptionCard` takes an optional `vehicleTypeSlug` prop (already
  available on the parent's data —
  `TransferRoutePublicVehiclePrice.slug` — no schema change). A known slug
  resolves to its tile; anything else, including no slug at all, resolves to
  `vehicle-generic.svg`.
- `TransferBookingPage.tsx` passes `option.slug` through.
- Test: `vehicle-option-card.test.tsx` gained three cases (known slug → its
  tile, unknown slug → generic, no slug → generic). **Proven able to fail**:
  temporarily hard-coded the resolver to always build the path from the raw
  slug (no fallback branch), confirmed the "unknown slug" and "no slug" cases
  went red with the exact wrong path (`vehicle-coaster.svg`,
  `vehicle-undefined.svg`), then restored.

Verified live in Chrome, not just in tests: Van/SUV/MPV cards on the real
`/transfer` page (owner's existing admin-logged-in session reused, read-only)
each render their correct gradient tile with the `PLACEHOLDER` label, both at
desktop width and inside the 360px iframe harness (see T27).

**Residual, flagged at the T29 advisor checkpoint, logged as BUG-130, not
fixed:** `VEHICLE_IMAGE_SLUGS` (the component) and `TILES` (the generator
script) agree on which slugs have a tile only by hand — no shared constant
ties them, and no test checks that the file a known slug resolves to actually
exists on disk. A future rename or drop of a tile from `TILES` without the
matching edit to `VEHICLE_IMAGE_SLUGS` would pass the whole suite and still
show a broken image — the exact failure this task's fallback was built to
prevent, just moved one layer over.

## T27 — design/UX pass, 360px and 1440px

**No commit — no code changes were needed.** The transfer flow was already
polished by prior DEMO POLISH batches; this pass found nothing to fix.

**Mobile-viewport verification used the BUG-074 workaround**, not Chrome's
window-resize tool (which this project's own BUGS_LOG already proved does not
change the rendered viewport in this environment): a temporary same-origin page
at `client/public/_qa-iframe-360.html` with a 360px-wide `<iframe src="/transfer">`,
served by the running dev server and deleted after use (never committed — `git
status` confirms it never touched the tree).

Walked, read-only, through: product-type pick → route pick → vehicle cards (all
three, with their new imagery) → guest-details form (pickup date/time,
passengers/bags, pickup/drop-off, flight fields, special requests, name/email/
phone) → pay-mode radios → consent → the "Book now, hold my spot" CTA. No
layout, spacing, or copy defects at either width. One candidate "fix" was
considered and correctly rejected: the vehicle-card grid showing an orphaned
third card at wide viewports turned out to be the page's own deliberate
`max-w-2xl` narrow-column form design (checkout-style), not a bug — a 3-column
grid at that column width would have cramped the price/due-now text, so the
2-column grid was left as-is.

**What could not be checked, and why:** BookingStatusPage and My Booking's
transfer-specific rendering (T25b's own surfaces). Dev seed data has zero
transfer bookings — `admin.bookings.list` shows 14 rows, all tours — and the
resume brief forbids creating holds or saving records to generate one. T25b's
own passing component tests (`booking-status.test.tsx`,
`manual-qr-page.test.tsx`) are the coverage for that surface; nothing here
contradicts them, but nothing here independently re-verified them live either.
**If a real visual check of those two pages is wanted, it needs either a seeded
transfer booking or an explicit owner go-ahead to create one.**

## T28 — legal/content checklist

**Commit `1284a76`.** `docs/TRANSFER_LEGAL_CHECKLIST.md`, text not written in the
plan itself. Union of the plan's own six items (lines 458–466 of
`2026-10-31-transfers-launch.md`) and the resume brief's two additional items
(child seats/children on laps, ferry/entrance fees not included) — the brief's
list and the plan's list didn't fully overlap, so this is the union of both, as
instructed. Eight items total; each states what R&G must supply, where it
surfaces in the product today (page, setting, or admin field — several already
exist and are wired, just empty), and who decides. **No legal text drafted, no
accreditation or permit numbers invented** — DOT/DTI/BIR stay "— pending —"
exactly as `docs/LAUNCH_CHECKLIST.md`'s existing "Permits and legal" section
already has them.

## T29 — this closing sweep

**Five checks, all green:**

| Check                                  | Result                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm lint`                            | clean                                                                         |
| `pnpm typecheck`                       | clean (shared, client, server)                                                |
| `pnpm test`                            | guards + shared 109 + client 1074/84 files + server 2709/137 files, all green |
| `pnpm format:check`                    | clean (see formatting sweep below)                                            |
| `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` | clean (client + server)                                                       |

Server test count is unchanged from HANDOVER-15 (137 files / 2709 tests) — T26–T29
touched no server code. Client gained the three new `VehicleOptionCard` cases
(T26): 84 files / 1074 tests.

**Formatting sweep, its own commit (`b4531fe`), logged as BUG-129.** `pnpm
format:check` was failing on six files this batch never touched —
`.design-preview/admin-buttons.html` (gitignored, so not actually committed
here) and five `docs/superpowers/plans/2026-11-10-transfers-HANDOVER-{9,10,11,12,15}.md`
files. Fixed with `prettier --write` on just those files, verified `format:check`
went green, committed separately from any content change per CLAUDE.md's "keep
formatting changes in their own commit."

**`docs/BUGS_LOG.md` updated** — BUG-125 through BUG-130:

- BUG-125: `dispatch-assign.test.ts`'s missing `audit_log` teardown (carried
  from HANDOVER-14/15, still nobody's). Open.
- BUG-126: admin cash panel's "tour day" wording should say "trip day" (carried
  from HANDOVER-15). Open.
- BUG-127: a T17 input schema missing `.strict()` (carried from an earlier
  handover via HANDOVER-15). Open.
- BUG-128: `dispatch.ts`'s missing-booking-id log gap (carried from an earlier
  handover via HANDOVER-15). Open.
- BUG-129: the pre-existing format drift (below). **Fixed**, `b4531fe` — moved
  to the Fixed table, not left open.
- BUG-130: the `VEHICLE_IMAGE_SLUGS`/`TILES` hand-sync residual from T26
  (above). Open, flagged not fixed.

BUG-125–128 and BUG-130 are carry-forwards or residuals, none a new defect
introduced by this batch's own code changes; BUG-129 is the one item this
batch both found and fixed.

**Plan's "Execution status" closed out** — see
`docs/superpowers/plans/2026-10-31-transfers-launch.md`'s new final section,
added this handover, recording all 29 tasks complete and pointing to each
HANDOVER file for batch-by-batch detail rather than re-deriving six batches of
history here.

**`pnpm --filter @rg/server db:seed` run locally**, against this machine's dev
`rg_travel` database, as the resume brief's final step (insert-only, safe —
owner, destinations, settings).

---

## Migrations owed on the server (production `rg_travel`)

**Eleven migrations, 0015 through 0025, not yet applied to the production
database.** All eleven exist locally (confirmed against
`server/src/db/migrations/meta/_journal.json`) and are covered by this
project's existing test suite. None of this batch's own tasks (T26–T29) added
a new migration — this list is unchanged from what HANDOVER-15 and earlier
handovers already owed; it is restated here in full because this is the final
handover for the batch that asked for it.

| Migration                                 | What it does                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `0015_amused_scalphunter`                 | Adds `vans.vehicle_type` (`van`/`suv` enum, default `van`).                                                           |
| `0016_salty_skreet`                       | Creates `transfer_route_vehicle_prices` (route × vehicle-type pricing).                                               |
| `0017_ambiguous_meteorite`                | Creates `booking_transfer_details`.                                                                                   |
| `0018_tricky_lady_ursula`                 | Redefines `bookings_product_type_shape` CHECK constraint for the transfer product type.                               |
| `0019_cool_swordsman`                     | Adds `drivers.max_transfer_jobs_per_day`.                                                                             |
| `0020_living_sprite`                      | Adds `booking_transfer_details.route_duration_minutes_used`.                                                          |
| `0021_clammy_thunderball`                 | Adds `vans.luggage_capacity`.                                                                                         |
| `0022_solid_william_stryker`              | Creates `password_reset_tokens`.                                                                                      |
| `0023_flexible_routes_stage1_additive`    | Flexible routes, stage 1 of 2 — **additive only**: new tables/nullable columns alongside the old ones, plus backfill. |
| `0024_flexible_routes_stage2_subtractive` | Flexible routes, stage 2 of 2 — **subtractive**. See below.                                                           |
| `0025_military_mauler`                    | Widens `inquiries.type` enum to include `transfer_custom`; adds `inquiries.requested_date`, `inquiries.pax`.          |

**`0024_flexible_routes_stage2_subtractive` drops columns — back up the
production database before applying it.** Confirmed by reading the file
directly, not inferred from the filename. It drops, in order: the FK and unique
index backing `transfer_routes.destination_id`, the `bookings_product_type_shape`
CHECK (recreated after), the FK and primary key on
`transfer_route_vehicle_prices` (recreated after, on the new columns), then
four `DROP COLUMN` statements:

- `bookings.vehicle_type_requested`
- `transfer_route_vehicle_prices.vehicle_type`
- `transfer_routes.destination_id`
- `vans.vehicle_type`

All four are the old fixed-enum columns the flexible-routes model (admin-managed
vehicle types and places) replaces. **0023 must be applied and its backfill
confirmed before 0024 runs** — 0024 assumes every row already has the new
columns populated, since it makes them NOT NULL and then deletes the old ones
they're replacing. Apply them as a pair, in order, with a database backup taken
before 0024 specifically (0015–0023 and 0025 are all additive or constraint-only
and do not need the same caution).

**Migration command:** `pnpm --filter @rg/server db:migrate` (name preflight;
see CLAUDE.md's root-vs-filtered command note — a bare `pnpm db:migrate` from
the repo root fails).

---

## Owner questions still open (none blocking this batch)

- **BUG-124** — `reviews.published` shows a hidden tour's title on the home page
  while `settings.show_tours` is off. Needs an owner ruling on "what should
  actually be true while `show_tours` is off" (see HANDOVER-6). Pre-dates this
  batch, unrelated to T26–T29, not fixed here per the "unrelated bugs" rule.
- **Item 4 of `docs/TRANSFER_LEGAL_CHECKLIST.md`** (day-use overrun policy) —
  still genuinely open, no default anywhere in the 2026-10-31 owner answers.
- **Item 8 of `docs/TRANSFER_LEGAL_CHECKLIST.md`** (whether transfers need a
  separate LTFRB/transport permit distinct from the tour-operator
  accreditation) — open, predates this batch.
- Whether the owner wants a real visual check of BookingStatusPage/My Booking's
  transfer rendering (T27's one gap) badly enough to seed a transfer booking or
  explicitly authorize creating one in dev.

## Unrelated bugs found this session

Two found, handled differently per CLAUDE.md's rule ("flag immediately if it
blocks the current task"):

- **BUG-129** (format drift) blocked T29's own five-check pass from reporting
  clean, so it was fixed immediately, in its own commit (`b4531fe`), rather
  than only logged.
- **BUG-130** (the vehicle-slug/tile hand-sync residual from T26, above) does
  not block anything currently working — it is logged, not fixed, per the
  "flag, don't fix" default for anything outside the current task.

BUG-125 through BUG-128 are not newly found — they are carry-forwards from
HANDOVER-15 given tracking IDs for the first time (they were already known and
named there, just not yet logged with numbers).

## Local URLs

- Client (Vite dev server): `http://localhost:5180`
- Server (Express + tRPC): `http://localhost:3100`
- Transfer booking flow: `http://localhost:5180/transfer`
- Admin: `http://localhost:5180/admin`

Both were already running (owner-started) throughout this session and were not
started or stopped by this work.
