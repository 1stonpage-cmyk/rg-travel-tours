# Week 7, Task 21 — the walkthrough, and what it could not prove

Driven on **2026-10-30** against the running dev servers (client `5180`, server `3100`) and the
live `rg_travel` database.

**The guest half was driven for real, in Chrome, end to end. The owner/staff half was not, and
could not be: no staff credentials exist in this environment.** That split is the single most
important thing to read before any line below — it is spelled out in full in the next section
rather than buried, because every batch this week hit the same wall and each one said so.

Plan: `docs/superpowers/plans/2026-10-23-week7.md` (21 tasks). The owner's 2026-10-29 prompt added
work beyond it (A1–A10, including three launch blockers found after the plan was written); the
controller's record of that is `.superpowers/sdd/2026-10-23-week7/task-21-batch6-addendum.md`, and
this document covers both. **82 commits**, `f422782..5f5d900`.

---

## What "driven for real" means here, and where it stops

**The guest half: a browser, on the real pages, against the real database.** Chrome drove
`/tours` → a tour detail page → the server's own quote → `/checkout` → a hold → the booking-status
page, plus a case-insensitive ref lookup and all three branches of the sub-floor refusal. Every
number below with a ₱ sign in it was read off a rendered page or off a `curl` response, not off a
source file.

**The staff half: nothing was signed into.** `.env` carries no `OWNER_EMAIL` / `OWNER_PASSWORD`,
and the seed prints `owner: SKIPPED` by design — the staff-accounts decision of 2026-10-23 made the
env seed create-only, and this box has never had an owner created through the UI. Minting one would
mean writing a password into a database from a walkthrough script, which is exactly what this
project's standing rule forbids, so **no admin screen was rendered in a signed-in state at any
point this week** — not in Task 7, 8, 9, 11, 12, 13, 15 or 16, and not here. What was done instead
is in [the staff half](#the-staff-half--what-was-actually-verified), and it is narrower than a
walkthrough: the gates were measured over HTTP, and the screens were read as source.

**The viewport tooling is still broken, the same way it has been since Week 2.** `resize_window`
reported success and `window.innerWidth` stayed **1920** — Chrome ignores bounds changes on a
maximised window. So:

- the real end-to-end flow was driven at **1920 CSS px**, not the 1440 the plan asked for. Stated
  plainly rather than relabelled; 1440 was never measured.
- the narrow pass was driven inside a **same-origin 360×780 iframe** of the real dev server, the
  same harness Week 6's step 9 and every client task this week used. An iframe is a genuine
  viewport for CSS, so the numbers are measured at 360 CSS px — but it is **not** a device: no
  touch, no on-screen keyboard, and `env(safe-area-inset-bottom)` resolves to 0 on a desktop, so
  the notch padding remains unproven. A phone in a hand is still the only way to close that.

**One fixture was staged and removed.** Three throwaway coupons (`WTFLOOR1`, `WTFLOOR2`,
`WTFLOOR3`) were inserted into `rg_travel` to reach the three branches of the gateway-minimum
message, since the seed ships no coupons at all. They were deleted afterwards, behind a guard that
refused to delete them if any `coupon_redemptions` row existed — see
[housekeeping](#housekeeping-what-this-pass-left-behind).

---

## Step 1 — the guest, `/tours` to a held booking

### `/tours` and the tour detail page: **PROVEN**

| Measured                                 | Value                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `/tours` HTTP / title                    | `200` · `Cebu Day Tours \| TravelSugbo`                                             |
| `<h1>`                                   | one, "All Cebu day tours"                                                           |
| tour cards                               | **6**, each linking its own `/tours/:slug`                                          |
| active destination filter                | rendered with a real `aria-current`, not a colour change                            |
| `/tours/kawasan-falls-canyoneering` HTTP | `200`                                                                               |
| its title                                | `Kawasan Falls Canyoneering — Badian / Kawasan day tour from ₱2,150 \| TravelSugbo` |
| its JSON-LD                              | `TouristTrip` **and** `TravelAgency`                                                |
| `aggregateRating` anywhere in the page   | **absent** — the key is omitted, not zeroed                                         |
| canonical                                | present, self-referential                                                           |

2C and 2D are real pages now, and the title above is the point: it is **composed from the database
row by the server-side resolver**, not typed into a shell. The absent `aggregateRating` is the
other point — the seed's six reviews are all `is_sample`, `realAggregate()` finds nothing, and the
key is left out entirely rather than emitted as a zero. With this seed, no rating is emitted
anywhere on the site.

### The price comes from the server: **PROVEN**

The detail page's booking panel bounded its own date input at `min=2026-10-31`,
`max=2027-04-28` — the server's pre-resolved `bookingWindow.earliest`/`.latest`, not client-side
date arithmetic — and capped guests at `max=12`.

Setting 3 guests on 2026-11-20 made the panel read **"Total for 3 guests · ₱7,050"**. The tour's
"from" price is ₱2,150 (the 7–12 tier); 3 guests sit in the 3–6 tier at ₱2,350. **The page showed
₱7,050, which is 3 × ₱2,350 and not 3 × ₱2,150** — so the panel is rendering a number it asked the
server for, and cannot have derived it from the "from" price it displays two inches higher.

### The hold: **PROVEN**

"Book this tour" went to `/checkout/kawasan-falls-canyoneering?date=2026-11-20&pax=3&addons=` —
browsing never created a hold (owner Q8), the hold is the checkout page's own act. The checkout
page's own summary:

| Line                           | Value    |
| ------------------------------ | -------- |
| `₱2,350 per person · 3 guests` | `₱7,050` |
| Total                          | `₱7,050` |
| Deposit due now (30%)          | `₱2,115` |
| due on tour day                | `₱4,935` |

Submitting produced **`RG-2G9Q27`**, `pending_payment`, with a live **14:57** countdown and "Your
spot is held for about 15 minutes." The row in `bookings` reads `total_centavos 705000` and
`tour_date 2026-11-19T16:00:00Z` — **the Manila civil date 2026-11-20 stored as UTC**, which is the
convention stated and now observed on a real row.

### A case-insensitive ref lookup: **PROVEN on all three procedures**

Task 20 / BUG-108. Three variants of `RG-2G9Q27`, over HTTP:

| Procedure                | `RG-2G9Q27` | `rg-2g9q27`          | `"  Rg-2g9Q27  "` (padded) |
| ------------------------ | ----------- | -------------------- | -------------------------- |
| `checkout.bookingStatus` | `200`       | **`200`**            | **`200`**                  |
| `checkout.bookingLookup` | `200`       | **`200`**            | —                          |
| `checkout.startPayment`  | —           | **`503`, not `400`** | —                          |

Every successful answer carried `"ref":"RG-2G9Q27"` — **the canonical uppercase, echoed back from
whichever spelling went in**. Before Task 20, the lowercase and padded variants were refused at
input validation by two of these three procedures while the third accepted them only because
`bookings.ref`'s collation matched case-insensitively on its own; the normalisation is now in
`bookingRefSchema` itself and true by construction.

The `startPayment` row is the one worth reading twice. **A `503` is the proof, where a `400` would
have been the refutation:** the ref got past input validation and the request reached the gateway
step, which then refused for its own reason (PayMongo is unconfigured on this box) with the
guest-safe sentence _"Online payment is temporarily unavailable. Please try again shortly, or
contact us to pay another way."_ That single response proves Task 20's normalisation **and** A5's
part 3 — the 503 keeps the server's own sentence instead of being masked by a generic "something
went wrong" — in one measurement.

### The sub-floor refusal, all three branches: **PROVEN**

Task 19 / BUG-110, and its fix round's three-way message. Driven in the browser on 1-pax Kawasan
(₱2,550), with a staged coupon per branch:

| Coupon     | Discount | Total | Due now | Held?  | The sentence the guest actually saw                                                                                                                                  |
| ---------- | -------- | ----- | ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WTFLOOR1` | −₱2,250  | ₱300  | ₱90     | **no** | "Online payments must be at least ₱100. Please **pay in full** instead of a deposit if that reaches ₱100, or contact us to pay by bank transfer or QR code instead." |
| `WTFLOOR2` | −₱2,500  | ₱50   | ₱15     | **no** | "Online payments must be at least ₱100, **and this booking's total comes to less than that.** Please contact us to pay by bank transfer or QR code instead."         |
| `WTFLOOR3` | 100% off | ₱0    | ₱0      | **no** | "This booking's total comes to **₱0, so there's nothing to pay online.** Please contact us directly to confirm it."                                                  |

All three branches fire, and each one offers only a way out that exists for it. The first names
pay-in-full because ₱300 genuinely clears the floor; the second does not, because it would be the
same refusal again; the third names no payment method at all, because there is no amount. That is
exactly what the fix round was for, and it is now observed guest-side rather than asserted in a
unit test.

**And the refusal wrote nothing.** Read out of `rg_travel` after all three:

- **no `bookings` row** — `RG-2G9Q27` was still the newest booking, created before these three
  attempts.
- **no `coupon_redemptions` row** — the table was empty, and all three coupons still read
  `used_count = 0`.
- **no slot lock either.** There is no `tour_date_slots` row for `(tour_id 7, 2026-11-20T16:00Z)`,
  which is the Kawasan-on-2026-11-21-Manila key all three refusals would have taken. The only row
  on that date belongs to tour 8, from a hold a previous session left behind. So the whole
  transaction really does unwind — `create-hold.ts`'s claim that "a refusal leaves no booking, no
  slot and nothing for the expiry sweep" is now a measurement, not a comment.

### The launch blockers, guest-side: **PROVEN, with one disclosed limit**

**A4 (raw Zod JSON).** A 44-character coupon code, applied on the real checkout page, rendered
**"Enter a coupon code of up to 40 characters."** — a sentence, under the coupon field. No braces,
no `"code":`, nothing JSON-shaped anywhere on the page. This is the exact path that was still live
after A4's first five commits (the coupon error is a _query_, not a mutation, so the original sweep
missed it) and was closed by `8150353`. **Closed, confirmed on the rendered page.**

**A4's disclosed limit, now measured on screen.** `createHoldInput.lead` is a nested object, so the
server's `fieldErrors` groups all three lead fields under one key. Submitting a valid name and
email with the phone `12345` put **"Enter a valid PH mobile number, like 0917 123 4567" under the
Full name field and under the Email field as well as under Mobile number** — all three got
`aria-invalid="true"` and the same message. The message is friendly and the launch blocker is
genuinely closed; the _attribution_ is imprecise, and a guest who mistyped their phone is told
their name is wrong too. A4's implementer flagged this shape, and its reviewer ruled the grouping
itself correct and not to be reworked. It had no bug number; it has one now
([BUG-120](#bugs-logged-by-this-pass)).

One smaller note from the same attempt: an invalid email never reaches the server at all, because
`type="email"` makes Chrome refuse the submit first ("Please include an '@' in the email
address."). The server's own message for that field is therefore unexercised through a browser,
though it exists and is unit-tested.

**A5 (offering a payment that cannot work).** The dev box is **state 2 of A5's three** — PayMongo
unconfigured, all six payment methods enabled — confirmed from the wire: `settings.get` answers
`onlinePaymentEnabled: false` and carries **no `paymongoConfigured` field at all**. The client gets
the decision, not the ingredients to re-derive it.

On screen, after the hold: **no "Pay now" button**, with "Pay by GCash, Maya or bank transfer"
standing as the only and primary option, and no apologetic "instead". And the hold sentence —
A5's own fix round, `5f5d900` — read:

> Booking reference RG-2G9Q27. We've reserved your spot — it's confirmed once we've received
> payment, so please **arrange that** before the hold below runs out, and keep this reference for
> your records.

"Arrange that" rather than "pay now": state-neutral, so it cannot be false in any of the three
states. **Closed, confirmed on the rendered page.**

**State 1 (online available) and state 3 (neither available) were not reproduced**, and cannot be
here: state 1 needs a real PayMongo key, state 3 needs the manual QR switched off as well. Both are
covered by client tests only. Said plainly because A5's own report said it first.

### 360 CSS px: measured in the iframe harness

| Route             | Overflow | `<h1>`                       | Images missing alt | Controls under 44 px                                |
| ----------------- | -------- | ---------------------------- | ------------------ | --------------------------------------------------- |
| `/tours`          | **none** | "All Cebu day tours"         | 0 of 8             | the skip link only                                  |
| `/tours/:slug`    | **none** | "Kawasan Falls Canyoneering" | 0 of 3             | the skip link only                                  |
| `/checkout/:slug` | **none** | "Checkout"                   | 0 of 2             | 2 radios + 1 checkbox (20 px), 3 inline legal links |
| `/portal/login`   | **none** | "Your booking"               | 0 of 1             | **none**                                            |

`scrollWidth` was 345 against a 360 viewport on three of the four and 360 on the fourth — no page
scrolls sideways at 360.

The under-44 list needs reading carefully rather than counting:

- the **skip link** is the standard visually-hidden a11y control, 32 px wide. Not a guest-facing
  target.
- the two pay-mode radios and the consent checkbox are **20 × 20 px glyphs**, which on its own
  would fail CLAUDE.md's 44 px rule — but each has a real `<label for>` whose own box is
  **313 × 62 px** (the radios) and **283 × 114 px** (the consent). The tap target is the label, and
  it is well over 44. Not a defect; worth writing down because a bare measurement of the input
  looks like one.
- the three legal links (Terms / Privacy / Refund) are **19 px tall** inline text inside the
  consent sentence. Inline links in a paragraph are the documented exception to the target-size
  rule; left as-is.
- the real controls all pass: both text inputs **313 × 44**, the submit button **313 × 44**.

`/portal/login`'s one image carries `alt=""` deliberately — a decorative brand mark, which is the
correct treatment, not a missing alt. (A first sweep counted it as missing; it is not.)

---

## Step 1, second half — the staff half: what was actually verified

Not a walkthrough. Three things, each honestly labelled.

### The role gates, over HTTP: **PROVEN for the anonymous case, and only that**

Every Week 7 admin surface, called with no cookie:

| Procedure                   | Answer                                         |
| --------------------------- | ---------------------------------------------- |
| `admin.tours.list`          | `401 UNAUTHORIZED` · "Admin sign-in required." |
| `admin.coupons.list`        | the same, byte for byte                        |
| `admin.settings.all`        | the same                                       |
| `admin.reviews.queue`       | the same                                       |
| `admin.reports.byTour`      | the same                                       |
| `admin.reports.outstanding` | the same                                       |
| `admin.packages.list`       | the same                                       |
| `admin.inquiries.list`      | the same                                       |
| `admin.drivers.list`        | the same                                       |
| `admin.bookings.list`       | the same                                       |
| `admin.dashboard.alerts`    | the same                                       |

Eleven procedures, one identical refusal — no procedure distinguishes itself by code or message, so
the set of admin endpoints is not enumerable from the outside. Each was called with an empty input
`{}` that several of them would reject on Zod grounds, and **the session gate fired first in every
case**, which is the correct ordering.

**What this does NOT prove, and it is the important half: nothing here tests one role against
another.** Owner-vs-finance-vs-dispatcher is the thing §9 exists for, and it is covered by the
suite — `procedure-role-metadata.test.ts` enumerates every procedure's declared area, and
`role-isolation.test.ts` parses §9's own table out of `BUILD_SPEC.md` and pins 23 allowed and 13
denied across 36 role × area cases — but **not by this pass**. A dispatcher being refused a receipt
(Task 4, owner Q2) and finance being refused the vans/drivers area are test facts this week, not
observed facts.

### The other security gates, over HTTP: **PROVEN**

| Request                                         | Answer                                |
| ----------------------------------------------- | ------------------------------------- |
| `POST admin.newsletter.export`, **no `Origin`** | `403 Forbidden`                       |
| the same, `Origin: http://evil.example`         | `403 Forbidden`                       |
| `GET /trpc/%zz`                                 | `400`, body `{"error":"Bad Request"}` |
| `GET /api/receipts/1`, no session               | `404`, body `{"error":"Not found"}`   |

Two things worth naming. The CSRF check is **outside** the session gate — both mutations were
refused `403` before anything looked for a cookie, so a cross-origin attempt never even reaches the
role layer. And the receipt route answers **`404`, not `401`** to a stranger, which is the same
answer Task 4 made a dispatcher get: a `403` would confirm the receipt exists.

The malformed-URL result is also a bug-log correction — see
[BUG-041](#bugs-logged-by-this-pass).

### Per-route head content and the indexing gates: **PROVEN**

Measured with `curl -H "Accept: text/html"` (a bare `curl` sends `*/*` and falls through the dev
middleware, which is its own trap):

| Path                                   | HTTP      | robots             | `<title>`                                     |
| -------------------------------------- | --------- | ------------------ | --------------------------------------------- |
| `/`                                    | `200`     | `noindex,nofollow` | TravelSugbo — Cebu Day Tours & Packages       |
| `/tours`                               | `200`     | `noindex,nofollow` | Cebu Day Tours \| TravelSugbo                 |
| `/tours/kawasan-falls-canyoneering`    | `200`     | `noindex,nofollow` | Kawasan Falls Canyoneering — … \| TravelSugbo |
| `/packages/cebu-highlights-3d2n`       | `200`     | `noindex,nofollow` | Cebu Highlights — … \| TravelSugbo            |
| `/admin`                               | `200`     | `noindex,nofollow` | **Staff console** \| TravelSugbo              |
| `/driver`                              | `200`     | `noindex,nofollow` | **Driver portal** \| TravelSugbo              |
| `/portal`                              | `200`     | `noindex,nofollow` | **My booking** \| TravelSugbo                 |
| `/checkout/kawasan-falls-canyoneering` | **`404`** | `noindex,nofollow` | **Page not found** \| TravelSugbo             |
| `/booking/RG-2G9Q27`                   | **`404`** | `noindex,nofollow` | **Page not found** \| TravelSugbo             |
| `/nonsense-xyz`                        | `404`     | `noindex,nofollow` | Page not found \| TravelSugbo                 |

The three app surfaces are the Week 6.5 fix holding: `200` with their own titles, where they used
to be `404` "Page not found" for a whole shift. The last three rows are **BUG-116, confirmed
byte-identical to a nonsense URL** — and it was visible in the browser too: the tab read "Page not
found | TravelSugbo" throughout the entire sub-floor walk, because that walk loaded `/checkout`
directly. `/booking/:ref` is the worse of the two, being PayMongo's own `success_url`.

`robots.txt` answers the whole site:

```
# This site is not currently published for indexing.
User-agent: *
Disallow: /
```

…because `settings.content_unverified` is still `true`. That one flag is doing three jobs at once
here: the amber on-site banner (visible on every page of this pass), the `noindex` on all ten rows
above, and `Disallow: /`.

**And it exposes an imprecision in a rule, not a bug in the code.** `/sitemap.xml` lists **15
URLs** right now, while every one of those URLs is served `noindex`. CLAUDE.md states, flatly, "A
sitemap must never list a URL that says `noindex`." Taken literally that is false today. The real
rule — which the code and its guard test both implement correctly — is that **no URL whose own
resolver says `noindex` may be listed**; the site-wide `content_unverified` gate is answered by
`Disallow: /` instead, and the guard test (`sitemap-robots.test.ts`, "lists no URL that says
noindex") explicitly clears the flag first so the site-wide gate cannot make it pass vacuously.
CLAUDE.md's wording is corrected in this task rather than the code.

### What the staff screens got instead of a walkthrough

Read as source, not rendered signed-in. `/admin/tours`, `/admin/coupons`, `/admin/settings`,
`/admin/reviews`, `/admin/reports`, `/admin/packages`, `/admin/drivers` and the payment queue all
exist as routes, all carry a denied-state branch, and each was reviewed by a dedicated reviewer at
the time it was built (see `.superpowers/sdd/2026-10-23-week7/progress.md` for the per-task
verdicts — every one of them is a ✅, with 1 Critical, 9 Important and ~70 Minor findings raised
and the Critical plus all nine Importants fixed and independently re-verified). That is real
assurance and it is not the same as having opened the screens. **The 360 px pass for every admin
screen Week 7 built is unperformed**, for the same credential reason, and that is the largest
single gap this week leaves.

---

## Step 1, third half — the five jobs now registered

Read from `jobs/index.ts`, pinned by `jobs-registration.test.ts` (7N item 8), not run:

| Job               | Cron         | Zone                   |
| ----------------- | ------------ | ---------------------- |
| `expire-holds`    | `* * * * *`  | — (instant arithmetic) |
| `prune-sessions`  | `30 3 * * *` | Asia/Manila            |
| `orphaned-vans`   | `0 7 * * *`  | Asia/Manila            |
| `review-requests` | `0 7 * * *`  | Asia/Manila            |
| `trip-reminders`  | `0 16 * * *` | Asia/Manila            |

Five, not the four the plan's own item 8 anticipated — Q5 required `review-requests` to be its own
job rather than logic folded into `orphaned-vans`, and the registration test pins five. The two
staff-facing sweeps sit at 07:00 and the one guest-facing reminder at 16:00, deliberately.

**No email left this machine.** Every notification suite uses the mock transport, and the two new
jobs were never ticked here.

---

## Step 1, last — the five checks, each run separately, in order

| Check                                  | Exit                        |
| -------------------------------------- | --------------------------- |
| `pnpm lint`                            | **0**                       |
| `pnpm typecheck`                       | **0**                       |
| `pnpm test`                            | **0**                       |
| `pnpm format:check`                    | **1** — one file, see below |
| `ALLOW_PLACEHOLDER_BUILD=1 pnpm build` | **0**                       |

**3,100 tests — 93 shared, 869 client, 2,138 server — across 184 test files, 0 skipped**, plus the
`check:coming-soon` and `check:contact` guards `pnpm test` runs first (both clean). Week 6 closed at
2,127 tests across 136 files, so this week added **973 tests and 48 test files**.

`format:check`'s single failure is **`.claude/settings.local.json`**, which is untracked, is a local
harness/permissions file, and is not this week's work — confirmed as the _only_ warn line in the
output. Every file this task touched passes `prettier --check` on its own. It is deliberately not
added to `.prettierignore` here: that is a harness decision for the owner, and it has been raised
by three separate agents this week without being acted on unilaterally.

**Migration 0014** (`0014_hot_the_stranger.sql`, foreign keys on the three tour child tables) is the
week's only schema change and is applied to both `rg_travel` and `rg_travel_test`, verified by
direct `information_schema` query during A1 rather than inferred from a passing test.

---

## What this pass did NOT prove

Named rather than glossed over, in rough order of how much it matters.

- **Any admin screen, rendered, signed in.** The single biggest gap. No owner, finance or
  dispatcher session has ever existed on this box, so every Week 7 admin screen — tours and price
  tiers, coupons, settings, review moderation, reports and their CSVs, packages and inquiries, the
  newsletter export, the payment queue's new card details, the Unlock button, the staff name in the
  greeting — is proven by tests and by review, and by nothing a human has looked at. **Including at
  360 px.** This is a prerequisite for Week 8's 8B, not an optional extra.
- **One role against another.** Only the anonymous refusal was driven. Owner-vs-finance-vs-dispatcher
  is a test fact (`role-isolation.test.ts`, 36 cases) and not an observed one.
- **The gateway.** Unchanged from Week 6 and still the oldest blocker: `PAYMONGO_SECRET_KEY` is
  empty on this box, `provider.refund()` has only ever run against the mock, and **no real payment
  and no real refund has ever been issued.** A5's state 1 is unreachable for the same reason, and so
  is BUG-109's four-required-attributes question.
- **The 1440 px viewport the plan asked for.** The flow was driven at 1920 and measured at 360.
  1440 was never rendered.
- **A real device.** No touch, no on-screen keyboard shrinking the viewport, no
  `env(safe-area-inset-bottom)`, no sunlight on a driver's phone. Week 6 said this and it is still
  true.
- **Email and SMS actually sending.** Five jobs are registered; none was ticked, and every suite
  uses the mock transport. SMS is built and off by default (owner Q6 — email only).
- **The driver portal, this week.** Week 7 touched the lockout policy (Task 5), the Unlock button
  (5b) and the payment box's `completed` state, but **no driver signed in during this pass** — the
  shared-cookie problem below is precisely why that is awkward to do in the same browser as
  anything else. The lockout backoff's three tiers are proven by `driver-lockout.test.ts`'s C7
  block, not here.
- **Review submission and moderation end to end.** `portal.submitReview` needs a completed booking
  and a portal session; the moderation half needs staff. Neither was driven.
- **A refund, a cancel, or a cash claim.** None was exercised; all are Week 5/6 paths this week did
  not change.
- **Concurrency through the UI.** No two tabs. The real races are proven by the suite's concurrent
  tests with the locks removed as the mutation.

---

## Findings this pass produced that the tests did not

1. **`/trpc/%zz` returns a clean `400` — BUG-041 has been fixed for weeks and the log still says
   `500`.** Measured: `400`, body `{"error":"Bad Request"}`, no stack, no filesystem path.
   `server/src/middleware/malformed-url.ts` was added in `96a8562` ("malformed request URLs return
   a clean 400, not a 500") and CLAUDE.md's security section already describes the fixed behaviour —
   but BUG-041's row sat in the Open table reading "queued → Phase 4 candidate". Moved to Fixed in
   this task. The lesson is the uncomfortable one: a bug log and a conventions file disagreed for
   weeks and only opening a URL caught it.
2. **CLAUDE.md's sitemap rule is literally false as written.** 15 URLs are listed while every route
   says `noindex`. The code is right and the guard test is right; the sentence is too absolute.
   Corrected in this task — the rule is about each URL's _own resolver_, with the site-wide gate
   answered by `Disallow: /`.
3. **The grouped `lead` validation message lands under three fields at once, on screen.** A bad
   phone number marks Full name and Email invalid too, with the phone's own sentence. Disclosed by
   A4 and ruled correct-by-design at the architecture level; now measured in a browser and given a
   number (BUG-120), because "the guest is told their name is wrong" is worth more than a line in a
   review report.
4. **BUG-116 is visible as a browser tab title, not just a status code.** The tab read "Page not
   found | TravelSugbo" for the whole sub-floor walk. A direct load of `/checkout/:slug` or
   `/booking/:ref` is byte-identical to `/nonsense-xyz`, and `/booking/:ref` is the page PayMongo
   redirects a paying guest to.
5. **A native `type="email"` field pre-empts the server's own message.** Chrome refuses the submit
   before the request is made, so the server's email-field sentence is never seen through a
   browser. Not a defect — the server-side validation still exists and is tested — but it means one
   of A4's messages has no browser-observable path.
6. **The seed ships zero coupons**, so Week 7's whole coupon feature (7B) has no demonstrable
   content on a fresh clone — the same shape as Week 6's "zero itinerary stops" finding, which Week
   6.5 fixed. This pass had to insert three coupons to have anything to apply. Not a code defect; a
   content gap that makes 7B undemonstrable, and one 7F's editing screens do cover (the coupons
   admin exists), so it is cheaper to fix than the stops were.

---

## Still open, and carried into Week 8

Numbered so a Week 8 plan can reference them. **Items 1 and 2 are owner decisions, not work
waiting to be scheduled** — nobody should build either without an answer.

1. **⚠️ `db:seed` still silently overwrites admin-edited content in six tables.** The launch
   blocker A2 fixed is fixed **for `settings` only**. The same overwrite shape is live in
   `upsertTour` (including **price tiers** — a reverted tier silently undercharges every subsequent
   booking, and that fails _open_), `tours` itself (title, badge, and the `alertNote` that would
   carry a typhoon suspension), `tour_images`, `upsertPackage`, `upsertReview` (which can
   **re-publish the six `is_sample` reviews** the launch checklist tells a deployer to hide), and
   `upsertFleet` (which can un-deactivate a driver with no audit row, and reset an `on_trip` van to
   `available` mid-trip, breaking the `on_trip` invariant). All six key on admin-editable natural
   keys, so an _edited_ slug or plate produces a **duplicate insert** rather than an overwrite — a
   second placeholder tour live on the public site. The A2 reviewer's own summary: **"one of seven
   doors is shut."** `docs/LAUNCH_CHECKLIST.md`'s "re-seeding is safe" claim was struck in
   `a1d4808`, so nothing now _tells_ a deployer to do the dangerous thing — but the mechanism is
   untouched. **Logged as [BUG-118](#bugs-logged-by-this-pass). Needs an owner decision**: which
   tables does the seed own and which do the admin screens own.
2. **⚠️ BUG-117 — `checkout.startPayment` does not enforce the methods-disabled half of A5's
   gate.** The PayMongo-unconfigured half _is_ enforced server-side (measured above: a `503` with
   the guest-safe sentence). The methods-disabled half is enforced by the UI alone, so when PayMongo
   is configured and an admin then switches every method off, a stale tab, a back-button return or a
   direct tRPC call still creates a real PayMongo session. Money still lands correctly and the
   webhook still confirms — this is a control that **fails open**, not a money-safety defect — but
   CLAUDE.md's "hiding a button is not access control" names it exactly. **Not reproducible on this
   box** (no key, so the first gate always fires first), which is part of why it needs a decision
   rather than a quick patch. **Needs an owner decision** before launch.
3. **7G — motion polish, deferred to Week 8 by owner answer Q9.** Not built this week, not a
   failure, not silently dropped. The home page's motion layer exists from the dynamic-site plan;
   what remains is the portal, driver and admin surfaces, with `emilkowalski-motion`, subtle only,
   respecting `prefers-reduced-motion`.
4. **No staff session has ever existed on this box**, so every admin screen built in Weeks 5, 6 and
   7 is unverified in a browser, at any width. **This is Week 8's 8B and 8C blocker, and it is
   cheap to unblock**: one owner account, created once, through the UI the staff-accounts plan
   built. Until then every client-side admin task will keep reporting the same gap.
5. **All three surfaces share one session cookie** (A9, report-only). `rg_session` has one name and
   one path for admin, driver and portal subjects (`server/src/middleware/session-cookie.ts`), so a
   guest signing into "My Booking" in the same browser **overwrites a staff session**, and vice
   versa. Nobody decided this; it is how the code happens to behave, and it is the reason two tasks
   this week could not run a browser check after using the driver login. **Do not read "session
   isolation between surfaces" into anything — there is none.** Logged as
   [BUG-119](#bugs-logged-by-this-pass).
6. **Should a ₱0 booking be allowed to confirm with no payment step at all?** Today a 100%-off
   coupon is refused at hold time (measured above, branch 3) and only the wording improved. The
   Task 19 reviewer split this correctly: the sentence was a defect and was fixed; whether such a
   booking should confirm is a product decision. **Owner question.**
7. **BUG-116** — `/checkout/:slug` and `/booking/:ref` serve `404` "Page not found". Same defect
   class Task 9 fixed for the three app surfaces; the fix is an `appSurfaceMeta`-shaped entry per
   route. Small, known, open.
8. **BUG-120** — the grouped `lead` field error (finding 3 above).
9. **BUG-109 and the gateway** — four `/checkout_sessions` attributes PayMongo documents as required
   and `createCheckout` does not send. Unverifiable without a test-mode key; must be checked before
   the first real payment.
10. **`.claude/settings.local.json` fails `format:check`.** Untracked, local, harness-owned. Three
    agents have now raised it. The fix is one line in `.prettierignore` and it needs the owner to
    say so.
11. **Roughly 70 Minor findings are deferred in the SDD ledger**, never folded into a cleanup task
    because Task 17's scope was frozen before Tasks 14–16 and A2–A7 produced theirs. They are all
    recorded per-task in `.superpowers/sdd/2026-10-23-week7/progress.md`. A Week 8 cleanup batch
    should sweep them the way 7N swept Tasks 8–13's.
12. **Week 6's two still-open items stand**: `TripProgressStop` carries no checkpoint id (undo label
    only), and the gateway wire check (item 9 above).

---

## Bugs logged by this pass

Appended to `docs/BUGS_LOG.md` in this task:

| ID      | Sev       | What                                                                                      |
| ------- | --------- | ----------------------------------------------------------------------------------------- |
| BUG-118 | critical  | `db:seed` still overwrites admin-edited rows in six tables (carry-forward 1 above)        |
| BUG-119 | important | all three surfaces share one `rg_session` cookie, so a guest login evicts a staff session |
| BUG-120 | minor     | the grouped `lead` field error renders under Full name and Email as well as Mobile        |

And one correction: **BUG-041 moved from Open to Fixed** (`96a8562`), having been measured as a
clean `400`.

**BUG-044, BUG-108 and BUG-110 were each confirmed present in the Fixed table with a real commit
hash** — Step 5's check, done: BUG-044 closed as stale in `285e615` (A1), BUG-108 in `cc2223f`
(A7), BUG-110 in `f601e85` + `e92bdb0` (A6). BUG-116 and BUG-117 are correctly in the Open table as
owner-decision items.

---

## Housekeeping: what this pass left behind

- **Three staged coupons: deleted.** `WTFLOOR1`, `WTFLOOR2`, `WTFLOOR3` were removed behind a guard
  that aborted if any `coupon_redemptions` row existed (none did) and after asserting
  `DATABASE() = 'rg_travel'`. `coupons` is back to **0 rows**, which is exactly what a fresh seed
  leaves.
- **One hold left to lapse: `RG-2G9Q27`.** Deliberately **not** deleted — CLAUDE.md's "never
  hard-delete bookings or payments" is not suspended for a walkthrough. It is `pending_payment` with
  a 15-minute hold and `expire-holds` runs every minute, so it will become `expired` on its own and
  join the three other `expired` holds previous sessions left in this database the same way. No
  payment row, no coupon redemption, nothing to unwind.
- **`rg_travel` otherwise untouched.** No settings row was written (A2's insert-only seed was not
  run either), no fleet or driver row was touched, no admin mutation was called — there was no
  session to call one with.
- **`rg_travel_test` untouched by this pass** except by the suite itself, which was run against it
  **twice** — once before the documents were written and once after all four commits — both times
  `3,100 passed`, identical counts, leak detector silent.
- **The browser tab this pass created was closed.**

---

## Step 7 — the week's closing statement

**✅ WEEK 7 COMPLETE** — for the lettered scope: **7A–7F and 7H–7P**, plus the owner's three
post-plan launch blockers (A2's settings half, A4, A5), all built, all reviewed, all five checks
green bar the one untracked harness file.

**Two named items are NOT closed and must not be read as closed:** carry-forward 1 (the seed's
overwrite shape in six tables, BUG-118) and carry-forward 2 (BUG-117). Both are explicitly owner
decisions, both are recorded in §13's Week 8 section and in `docs/BUGS_LOG.md`, and neither was
built unilaterally — the same treatment **7G** got, which is deferred to Week 8 by the owner's own
answer rather than dropped.
