# HANDOVER-18 — Real photos for transfers from free, legal stock

**Date:** 2026-11-10
**Task:** Replace the transfer vehicle-card placeholder imagery with free,
legally-licensed stock photos, until R&G supplies its own fleet photography.

## Owner decision (2026-11-10)

Replace the transfer placeholders with free stock photos legal for
commercial website use, until R&G supplies its own. Vehicle photos are
illustrative only and are labelled as such ("Sample vehicle").

Sources restricted to Unsplash and Pexels only, under their free licences,
verified on each photo's own page. No visible plates, no prominent company
names/logos, no identifiable faces as the main subject, no watermarks.
Vehicles are generic (not mistakeable for a specific operator).

## Scope decision (this session)

Before sourcing anything, I confirmed with the owner that `RoutePicker.tsx`
(the `/transfer` route-selection cards) has **zero image slots** — text and
icons only — so "replacing placeholder imagery" cannot apply to something
that doesn't exist there. The owner chose **"Vehicle cards only"**: this
task touches only the four vehicle-type card images in
`VehicleOptionCard.tsx` (`van`, `suv`, `mpv`, and the generic fallback).
No route-card or destination imagery was added. The home hero was already a
real photo before this task (out of scope); the Tours/Packages destination
placeholders are a separate feature (`showTours`, currently off) and were
not touched either.

## 1A — Shot list

Four slots, all inside `VehicleOptionCard.tsx` (`h-20 w-full object-cover`,
landscape source, ≥1600px-wide original per 1B):

| Slot | Subject | Caption |
|---|---|---|
| `vehicle-van` | Generic white passenger van (windowed, not cargo) | "Sample vehicle" |
| `vehicle-suv` | Generic white/neutral crossover SUV | "Sample vehicle" |
| `vehicle-mpv` | Generic people-carrier minivan | "Sample vehicle" |
| `vehicle-generic` | A fourth, distinct generic vehicle — fallback for any future admin-added vehicle type | "Sample vehicle" |

## 1B — Sourcing

All four photos, their photographers, photo-page URLs, licences and the
no-plates/logos/faces check are recorded in **`docs/IMAGE_CREDITS.md`**.
Summary:

| Slot | Source | Photographer | Licence |
|---|---|---|---|
| van | Pexels | Yazid N | Pexels License |
| suv | Unsplash | Kern Morris | Unsplash License |
| mpv | Pexels | Jeremy Li | Pexels License |
| generic | Pexels | Mehrajul Karim | Pexels License |

Every candidate was checked on its own photo page for the free licence
badge (rejecting anything Unsplash+/premium/sponsored/iStock-linked), zoomed
in to check for a visible plate or a prominent badge/logo, and judged by
what survives the `h-20` `object-cover` crop (not by how the full photo
looks) before being accepted. Several candidates were rejected along the
way and are not listed in the credits file — see "What I skipped, and why"
below.

Originals stored at `client/public/images/transfers/{slug}-original.jpg`
(not served by any component — kept as the full-resolution source record).
Web-sized derivatives at `{slug}-480.jpg` / `{slug}-800.jpg`, generated with
`ffmpeg` (a system tool already on this machine, not a new repo
dependency — the repo has no image encoder, confirmed via
`shared/src/constants.ts`'s own comment and a grep of every `package.json`;
WebP was tried once before, BUG-103, and removed for being larger than
JPEG, so this uses optimised JPEG only, per the task's own pre-authorised
fallback). All four images' 480w/800w files are 14–94 KB — comfortably
under the ~300 KB budget (see 1F).

### What I skipped, and why

- A Range Rover Evoque (white, nicely framed) — the "RANGE ROVER" wordmark
  is printed large across the hood, which reads as a prominent brand name,
  not an incidental badge.
- An Infiniti SUV front 3/4 shot — same reason, large diamond badge
  dead-centre on the grille.
- A Honda Pilot SUV — acceptable on the plate/logo/face checks, but the
  photo is a tall portrait crop with the vehicle small and high in frame;
  the `h-20` strip across its vertical middle would show mostly sky and
  grass, not the vehicle.
- A Suzuki Vitara side-view on a misty road — same crop-survivability
  problem: the vehicle sits in the lower third of a tall frame.
- Two Toyota taxi/liveried SUVs (one with a taxi-company decal, one with a
  "Makita" sticker) and a white minivan with a legible plate
  ("07 AA 20xx") visible on the front bumper — all skipped on the
  no-logos / no-plates rule.

## 1C — Mapping module

`client/src/lib/transfer-images.ts` is now the **one shared source of
truth** for which vehicle-type slug has a photo. `VehicleOptionCard.tsx`
imports `vehicleImageFor()` and `VEHICLE_IMAGE_SLUGS` from it, in place of
the local set it used to keep in sync with `generate-placeholders.mjs`'s
`TILES` array by hand — this resolves **BUG-130**. The generator no longer
has any vehicle entries in `TILES`; there is nothing left for it to
generate once every vehicle-card slug resolves to a real photo instead of
an SVG tile. The four now-unused `vehicle-*.svg` placeholder files were
deleted (confirmed nothing else referenced them before deleting).

An unrecognised or missing slug still falls back cleanly — now to
`GENERIC_VEHICLE_IMAGE` (a real sample photo) rather than the old blue/gold
gradient tile — so a vehicle type the admin adds tomorrow renders correctly
with no code change, same promise the component always made.

**Accessibility finding, fixed in the same commit.** Giving the photo real,
descriptive alt text (required by this task and by CLAUDE.md's "alt text on
every image") initially broke 12 existing integration tests in
`transfer-booking-page.test.tsx`: the `<img>` sits inside the same
`<label>` as the vehicle's radio `<input>`, and an accessible-name
computation for a label-wrapped control includes the label's full text
content, alt text included. The radio's accessible name silently changed
from "Van ₱1,500…" to "Sample vehicle — a white passenger van… Van
₱1,500…". Fixed by giving the `<input>` an explicit `aria-label`
(the vehicle type name alone, matching the previous effective naming
pattern) and moving the price/status block into `aria-describedby` — which
is also the more correct ARIA mapping (supplementary detail, not the
choice's identifying name) and keeps that figure reachable by assistive
tech rather than losing it. Covered by two new tests; see 1E.

## 1D — `/photo-credits` page

A new public page (`client/src/pages/public/PhotoCreditsPage.tsx`) credits
all four photographers, linked from the footer beside the other legal
links. Not required by the licences, but good practice.

Registered through the same system every other static public page uses
(`STATIC_PUBLIC_TITLES` in `@rg/shared`, and a `resolvePhotoCredits` entry
in `server/src/seo/resolvers.ts`) — skipping this would have hit the exact
BUG-116/QA-1 defect already fixed twice in this file: an unregistered real
route falls through to `notFoundMeta` and is served as a genuine HTTP 404
titled "Page not found". Deliberately **`noindex,nofollow`** and **not**
added to `sitemap.ts`'s four-legal-pages list — unlike `/privacy`,
`/terms`, `/refund-policy` and `/cookies`, this is thin, non-marketing
content, not a legal page, so it gets the same "real page, nothing worth
indexing" treatment `/checkout` and `/booking` already get.

I judged this one small SEO-registration step to be within "do 1D
properly" rather than new unrelated scope, since skipping it would ship a
page with a real, reproducible defect (served as 404). It touches no
money, auth, roles, or schema. Flagging it here in case the owner would
rather this stayed unregistered — it is two generators' worth of deletion
if so (`STATIC_PUBLIC_TITLES['/photo-credits']` and the `resolvePhotoCredits`
entry + `ROUTES` line).

## 1E — Tests

- `transfer-images.test.ts` (new): every known slug → its own distinct
  photo; unknown/missing slug → generic; every mapped 480w/800w file exists
  on disk (so BUG-130 cannot recur silently); alt text always present and
  says "Sample vehicle".
- `vehicle-option-card.test.tsx`: updated the three existing image-src
  assertions for the new real paths; added tests for alt text, the visible
  caption, lazy-loading, the radio's accessible name staying just the
  vehicle type, and the price/status block staying reachable via
  `aria-describedby`.
- `legal-pages.test.tsx`: the footer's new Photo Credits link;
  `PhotoCreditsPage` crediting all four photographers with working links.
- `seo-resolvers.test.ts`: `/photo-credits` resolves as a real 200 page
  with its own title, and stays `noindex,nofollow` even once
  `content_unverified` is cleared (proving the resolver itself, not just
  the site-wide gate, is responsible).

Every new assertion was broken, confirmed red, and restored during
development (CLAUDE.md's "every new test must be proven able to fail").
`no-red.test.ts` and `contrast.test.ts` still pass unmodified.

## 1F — Verification

All five, in order, from the repo root:

1. `pnpm lint` — clean.
2. `pnpm typecheck` — clean (`shared`, `client`, `server`).
3. `pnpm test` — **client**: 86/86 files, 1118/1118 tests, clean.
   **server**: 138/139 files, 2727/2728 tests. The one failure
   (`schema-conventions.test.ts`, "never hard-deletes a booking or a
   payment") is **pre-existing** and unrelated to this task — see
   "Unrelated bugs found" below. (An earlier run showed 106 failures across
   unrelated dispatch/booking/trip-checkin suites; that was my own mistake —
   I had accidentally launched three `pnpm test` runs concurrently against
   the same local MySQL test database, which deadlocked each other. A clean
   solo re-run confirmed all of those were contention artifacts, not real
   failures.)
4. `pnpm format:check` — clean except one pre-existing, unrelated file
   (`.design-preview/admin-dashboard.html`, untouched by this task).
5. `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` — clean (both `client` and
   `server`).

Page-weight check: every served transfer image (480w/800w, all four slugs)
is 14–94 KB, well under the ~300 KB budget. The `*-original.jpg` files
(210–656 KB) are stored but **not referenced by any component** — they sit
in `client/public/images/transfers/` as the kept source copies per 1B's
instruction, not served to a normal page visit. The hero image is
untouched (289 KB at 1920w, under the ~400 KB budget).

## 1G — Chrome check (read-only)

Checked `/` (home), `/transfer` (vehicle cards, after selecting a transfer
type and route), and `/photo-credits`, at both 1440px and 360px (the latter
via the usual same-origin iframe-harness workaround, deleted afterward — the
automation's own resize tool doesn't change the rendered viewport here).

- Home: unchanged, hero and layout intact at both widths.
- `/transfer`: all three real photos (van/suv/mpv) render at full card
  width, object-cover fills the 80px strip cleanly with the actual vehicle
  body (not sky/ground), the "Sample vehicle" caption is legible in the
  bottom-right corner, no overflow at 360px.
- `/photo-credits`: all four credits render, links work, no overflow at
  360px; the server-injected `<title>Photo Credits | TravelSugbo</title>`
  was confirmed by the tab title changing on navigation.

Dev servers (5180/3100) were already running before this task started —
neither was started nor stopped.

## Commits

- `695ec44` - 1B: source four free-licence transfer vehicle photos (Unsplash/Pexels)
- `08e1680` - 1C: wire real vehicle photos through transfer-images.ts, resolving BUG-130
- `bc2c6dc` - 1D: add the /photo-credits page, a footer link, and its SEO resolver entry
- `1b9d9b1` - 1E: tests for the transfer-images mapping, alt text, and /photo-credits

(1A had no file of its own to commit — the shot list is the table above.
1F/1G are verification steps, not code changes.)

## What still needs R&G's own photography

All four vehicle photos are temporary stock photography, not R&G's fleet.
Replacing them with real photos is a drop-in file swap — put the new
JPEGs at the same paths under `client/public/images/transfers/`
(`{slug}-480.jpg` / `{slug}-800.jpg`, 480/800px wide) and nothing else needs
to change. At that point:
- `docs/IMAGE_CREDITS.md` and `PhotoCreditsPage.tsx` should be updated to
  drop the retired photo's entry (or the whole page/footer link removed,
  once no stock photo remains).
- The "Sample vehicle" caption and its mention in the alt text
  (`transfer-images.ts`) should come off for whichever slug now has a real
  R&G photo.

## Unrelated bugs found (not fixed, per standing instruction)

- **`schema-conventions.test.ts` fails on `main`, independent of this
  task**: "never hard-deletes a booking or a payment anywhere in the server
  source" is red because `server/src/db/clear-demo-transfer-bookings.ts`
  (committed earlier this session, `28a4bc6`, task "1E: add
  db:clear-demo-transfers") calls `db.delete(bookings)` and
  `db.delete(payments)` directly. That script is a dev-only demo-data reset
  tool, gated behind `ALLOW_DEMO_SEED=1` and never-production, but it is a
  real, literal hard delete of a `bookings`/`payments` row, which
  CLAUDE.md's "Never hard-delete bookings or payments" rule forbids
  outright. Worth a look — either the rule needs a carve-out for this
  specific dev-only script, or the script needs to soft-delete /
  guard differently.
- **`.design-preview/admin-dashboard.html` fails `prettier --check`**,
  pre-existing, untouched by this task.

✅ PHOTOS COMPLETE
