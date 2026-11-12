# Sign-up coupons + small cleanups — design note (Task 1A)

Owner decisions given directly 2026-11-12/13. This note covers schema, how
sign-up codes plug into the EXISTING coupon apply/redeem/release paths (no
second money path), and the test plan. Written after reading CLAUDE.md,
`PromoNewsletter.tsx`, the `newsletter_subscribers`/`coupons`/
`coupon_redemptions` schema, `routers/public/newsletter.ts`,
`routers/admin/newsletter.ts`, the coupon apply/redeem/release paths in
`services/coupons.ts`, `services/create-hold.ts` and
`services/transfers/create-booking.ts`, `AdminCouponsPage.tsx`,
`AdminPackagesPage.tsx`'s Newsletter card, `client/src/lib/site.ts`, and
`coming-soon/index.html`.

## Current migration state

Highest applied migration is `0025_military_mauler.sql`. The next one this
plan writes is **0026** (matches the task's own numbering). Generated with
`pnpm --filter @rg/server db:generate` after editing `schema.ts` — never
hand-written — so the Drizzle meta snapshot stays in sync. Applied to
**both** `rg_travel` and `rg_travel_test` locally; the owner applies it on
the server after this ships (handover line).

## Schema (migration 0026)

1. `coupons.restricted_to_email` — nullable `varchar(200)`. NULL for every
   ordinary admin-created coupon (unchanged behaviour). Set, normalised
   (trim + lowercase) at issuance, for a sign-up coupon. `validateCoupon()`
   grows one new optional check against it (see below) — the column is
   never read or written by `admin.coupons.*` (same reasoning as `usedCount`
   and `isActive` already being unreachable from those `.strict()` inputs:
   `shared/src/coupons-admin.ts`'s own note explains why extending that union
   is the safe way to add an admin-reachable field, and this is deliberately
   NOT one).
2. `newsletter_subscribers.coupon_id` — nullable `int`, `references coupons.id`.
   Null until a code has been issued for that address. This is what makes
   "one code per email ever" checkable without a second table.
3. **No other columns.** Expiry is `coupons.ends_at` (existing column,
   existing `CouponExpiredError` check). "Valid for one booking" is
   `coupons.usage_limit = 1` (existing column, existing usage-limit checks).
   "Codes keep the % they were issued with" is `coupons.percent_bp`, set once
   at issuance and never re-derived from the live setting afterward — no new
   column needed for either.
4. New settings key `signup_coupon` (20th entry in `SETTING_KEYS` /
   `SETTING_SCHEMAS`, same owner-only `usersSettings` write gate every
   settings key already shares): `{ discountPercent: int 1..100, expiryDays: int
   1..365 }`. Stored as a **whole percent** (matching `trust.depositPercent`'s
   existing convention — plain int, not basis points), converted to basis
   points (`discountPercent * 100`) only at the moment a code is minted, the
   same unit conversion `AdminCouponsPage.tsx`'s own form already does by hand
   for an admin-typed percentage. Default `{ discountPercent: 5, expiryDays:
   60 }`, inserted by `seedBase` (insert-only, same as every other settings
   row) so a fresh clone and the server's existing `rg_travel` both gain the
   row without overwriting anything.

Adding a settings KEY does not add a settings AREA — `usersSettings` already
exists and is already owner-only — so `role-isolation.test.ts`'s §9 table
counts do **not** change. `admin-settings.test.ts`'s "SETTING_KEYS matches
SETTING_SCHEMAS" guard will catch a one-sided edit.

## Why this is not a second money path

Every rule CLAUDE.md protects is satisfied by data already flowing through
`validateCoupon()` / `recordRedemption()` / `releaseRedemption()` /
`reserveCouponUnderLock()` — **zero new functions in that chain, one new
guard inside `validateCoupon()` itself:**

- `validateCoupon(code, subtotalCentavos, now, db, email?)` grows a 5th,
  **optional** parameter. When the loaded row's `restricted_to_email` is
  non-null AND `email` is given, compare
  `email.trim().toLowerCase() === restricted_to_email` (already normalised
  at write time) and throw a new `CouponEmailMismatchError` on a mismatch.
  The message **never echoes the restricted address** — RA 10173: a
  stranger who found or guessed a WELCOME code must not be able to learn
  whose inbox it was issued to.
- **Ruling (recorded — see Rulings below):** the two `checkout.quote` /
  `quoteTransfer` preview call sites have no lead email at all (`quoteInput`
  carries no email field, and widening it is out of this task's scope) — so
  they call `validateCoupon` exactly as today, with `email` omitted, and the
  email rule is simply not checked at preview time. The **authoritative**
  calls, inside `createHold()`'s and `services/transfers/create-booking.ts`'s
  own transactions, already have `input.lead.email` in scope at the exact
  line that calls `validateCoupon(..., tx)` — one extra argument, no
  restructuring, no new lock. A guest previewing a sign-up code before
  typing their email sees it provisionally accepted; if they then check out
  with a different email, the hold is refused there, same as any other
  coupon rule a preview cannot fully see. Money is never computed or
  committed from the unchecked preview path — only from the authoritative,
  transactional one — so this costs nothing CLAUDE.md protects.
- One new case in `translateCouponError()` (`routers/public/checkout.ts`) —
  the single shared translator all three resolvers (`quote`, `quoteTransfer`,
  `createHold`'s router caller) already go through — so one line covers
  every surface.
- Usage cap (1), expiry, active/inactive, min-spend, "can't combine with
  another coupon on one booking" (already true by construction — `couponCode`
  is a single field): all pre-existing checks, untouched.
- `recordRedemption` / `releaseRedemption`: untouched. A sign-up coupon's
  redemption row and `used_count` bump/undo on expiry-sweep or cancel are
  identical to any other coupon's.

## Issuing a code (`newsletter.subscribe`)

New first-time subscriber (insert succeeds):
1. Insert the `newsletter_subscribers` row.
2. Mint a coupon: `WELCOME-XXXXXXXX`, **8** characters from the existing
   `REF_ALPHABET` (`services/booking-ref.ts` — already excludes
   `0/O/1/I/L/U`, "unambiguous characters" for free; 30^8 ≈ 6.6×10^11,
   against 30^4 ≈ 810k for a 4-character code — see the enumeration note
   under Rulings), via `node:crypto` `randomInt`, retried on a
   unique-constraint collision — same shape as `insertBookingWithRef`, new
   sibling helper in `services/coupons.ts` (or a new
   `services/signup-coupons.ts`; implementer's call, documented inline).
   `discountType: 'percent'`, `percentBp: discountPercent * 100`,
   `usageLimit: 1`, `endsAt: now + expiryDays`, `restrictedToEmail:
   normalizedEmail`, `isActive: true`.
3. Link `newsletter_subscribers.coupon_id` to the new coupon, in the **same
   transaction** as steps 1–2 (one subscriber row and one coupon row commit
   together or not at all).
4. **After commit**, `await` a dedicated sender — not a `NotifyEvent`
   (`NotifyPayload` is booking-shaped, exactly the reasoning
   `staff-password-reset.ts` and `notify/inquiry.ts` already give for their
   own senders) — `sendSignupCouponEmail(email, code, discountPercent,
   expiryDays)` in a new `services/notify/signup-coupon.ts`, built on the
   shared `mailDocument`/`mailLink` shell. Cannot throw, same discipline as
   every other sender in that directory. **The code is never returned to the
   caller** — `subscribe`'s response carries no code, matching decision 1.

Repeat signup, same email (insert hits the unique-key duplicate):
1. Look up the existing subscriber row **`FOR UPDATE`, in a short
   transaction** (closes an otherwise-real race: two near-simultaneous
   signups for a brand-new address could otherwise both see `coupon_id IS
   NULL` and both mint a coupon, violating "one code per email ever").
2. `coupon_id IS NULL` (a subscriber who predates this feature, or who lost
   a race): mint one now, exactly as step 2 above, under the same lock —
   this is their **first** code, not a second one, so it does not conflict
   with decision 2's "no second code" rule. *(Ruling — see below.)*
3. `coupon_id` set: load that coupon. If it is `is_active` **and** unused
   (`usage_limit` not yet exhausted — i.e. no `coupon_redemptions` row for
   it) **and** unexpired (`ends_at` is null or in the future): resend that
   exact code by email, **rate-limited per address** — a new in-process
   throttle (`services/notify/signup-coupon.ts`), one resend per address per
   hour, the same `Map<string, Attempts>` shape `notify/inquiry.ts`'s
   `isInquiryAckThrottled`/`recordInquiryAckSent` already use and for the
   identical reason: the newsletter form is a public text box, and without
   a per-address cap it is a tool for bombing a third party's inbox with
   repeat "here is your code" mail.
4. Used or expired or inactive: no resend. (Decision 2 says "unused,
   unexpired" explicitly — resending a spent or dead code would just
   confuse the guest.)
5. The procedure's return shape is unchanged either way:
   `{ ok: true, alreadySubscribed: true }` — no code, no status, nothing
   about whether a mail was actually sent (consistent with decision 1 and
   with the existing duplicate-signup response already saying nothing about
   row contents).

## Turnstile + rate limits

- `newsletterInput` grows the same `turnstileToken: z.string().optional()`
  field `inquiryInput` already has; `newsletter.subscribe` checks it with
  the existing `verifyTurnstile()` / `turnstileRefusedError()` **before any
  write**, mirroring `inquiries.create`'s own first line exactly.
- `newsletter.subscribe` is already in `app.ts`'s shared 5-per-15-minutes
  limiter (`createProcedureRateLimit(['inquiries.create',
  'newsletter.subscribe'], …)`) — unchanged, still covers first-time signup
  abuse from one IP.
- The resend path adds its own **per-email** cap (above) — a different axis
  (address, not IP) from the existing per-IP limiter, the same two-axis
  shape `driver-lockout`/`staff-login` already use elsewhere in this
  codebase.

## Admin screen (decision 5)

No new procedures needed for the % / expiry settings — the existing
`admin.settings.write({ key: 'signup_coupon', value })` /
`admin.settings.all` cover read/write; the Coupons page just adds a small
section that calls them directly (same owner-only gate either screen
reaches it from).

One new query is needed for the subscriber list, since `admin.newsletter`
currently only has `export` (CSV, no per-row read): `admin.newsletter.list`
— same `adminProcedure('usersSettings')` gate as `export` — returning
`{ email, createdAt, code: string | null, status: 'unused' | 'used' |
'expired', usedBookingRef: string | null }[]`, derived by joining
`newsletter_subscribers` → `coupons` → `coupon_redemptions` → `bookings`.
`export` itself is **unchanged** server-side; only its client card moves
from `AdminPackagesPage.tsx` to the new "Sign-up coupons" section of
`AdminCouponsPage.tsx` (decision 5's "CSV export moved here from Packages").

## Public panel (decision 1, 3, 6)

`PromoNewsletter.tsx` stops reading `promo.code` and showing it. Its CTA
copy reads the new public field the settings payload needs to expose for
this (`signupCoupon: { discountPercent: number }` — percent only; the
expiry day count is email-copy, not page copy) so "Sign up for 5% off"
tracks the live admin setting. **This is a required field on
`SettingsPayload`, not optional** — adding it touches two places beyond
`settings-schema.ts`/`settings.ts`'s `blocks.*` → payload assembly (around
line 497): `client/src/__tests__/helpers/fixtures.ts`'s full settings
fixture (already seen carrying `promo` at line 101) needs the new field
added or every client test using that fixture breaks, and the 1C/1D
implementer owns that fixture update as part of the task — not a follow-up,
and not "make the field optional to stop the red tests," which would let
the panel silently render "Sign up for off". On success it shows "Check your inbox for
your code" (`role="status"`) regardless of `alreadySubscribed` — the server
already treats a repeat signup as success, and the screen must say nothing
that reveals whether this was a first signup or a resend. Turnstile widget
(light theme — already `TurnstileWidget`'s only theme) sits above the
submit button, token included in the mutation payload, reset on error the
same way every other Turnstile-gated form here does.

## Decision 7 (RGTOURS10)

No `coupons` row named `RGTOURS10` exists in this repo's seed data — if one
exists in production it was created by hand through the admin Coupons
screen, which already has a Deactivate control. **This is an operational
step for the owner** (Admin → Coupons → find `RGTOURS10` → Deactivate), not
a code change, and is called out in the handover rather than attempted here
against a database this session cannot reach. The code-side cleanup is: the
seed/fixture literal `'RGTOURS10'` (`server/src/db/seed-data.ts`,
`client/src/__tests__/helpers/fixtures.ts`) is removed from the `promo`
settings block's seeded content, since after this task `PromoNewsletter`
no longer reads or displays `promo.code` at all — the field becomes dead
weight in sample content, not a live public mention, but is cleaned up
anyway so nothing in this repo's own fixtures still names a deactivated
code.

## Rulings

1. **Email-mismatch check is best-effort at preview, authoritative at
   hold.** `quote`/`quoteTransfer` do not gain a lead-email field; the rule
   is enforced for real only inside `createHold()` /
   `create-booking.ts`'s transactions. Cost if wrong: a guest sees a
   sign-up code provisionally accepted in the live price preview before
   typing their email, then refused at submit if the emails don't match —
   a worse-than-ideal but truthful UX, never a money error.
   **Enumeration risk, named rather than waved away:** because `email` is
   never passed at the `quote`/`quoteTransfer` preview call sites,
   `CouponEmailMismatchError` cannot fire there at all — the only place it
   can fire is the authoritative `createHold`/`createHoldTransfer` path,
   which is already behind the existing 5-per-15-minutes-per-IP checkout
   hold limiter (`CHECKOUT_HOLD_PROCEDURES`, `middleware/rate-limit.ts`) —
   the same budget that already bounds guessing against the general
   "does this coupon code exist" question `CouponNotFoundError` answers for
   every coupon, sign-up or not. The 8-character code (above) is the
   primary mitigation for low-cost guessing at the unbounded `quote`
   endpoint, where a found-but-mismatched sign-up code would in any case
   only confirm the code EXISTS, not that the guesser can spend it — it
   stays bound to one specific address they would still have to know.
2. **A pre-existing subscriber with no coupon yet (`coupon_id IS NULL`) gets
   one minted on their next signup**, under a row lock to prevent a
   double-mint race. This is read as "their first code," not "a second
   code," and is not contradicted by decision 2's text. Cost if wrong: a
   subscriber from before this feature shipped gets a welcome code they
   arguably weren't promised: harmless, and reversible by deactivating that
   one coupon by hand if the owner disagrees.
3. **Settings store a whole percent, not basis points**, matching
   `trust.depositPercent`'s existing convention rather than
   `coupons.percent_bp`'s. Cost if wrong: trivial to change before launch;
   nothing downstream depends on the settings block's own unit once a code
   is minted, since the mint step is the one and only place that converts.

## Test plan (Task 1B)

- `validateCoupon`: wrong email refused (`CouponEmailMismatchError`,
  message does not contain the restricted address); matching email (any
  case/whitespace) accepted; `email` omitted still works (back-compat for
  the two preview call sites); non-restricted coupons unaffected by the new
  parameter.
- Issuance: first signup mints exactly one coupon row, linked; second
  signup with the same email mints no second coupon (`used_count`/row count
  assertions); a signup racing itself (two concurrent calls, same new
  email) still ends with exactly one coupon for that address.
- Expiry: a sign-up coupon past `ends_at` is refused the same way any
  coupon is (reuses `CouponExpiredError` — no new test infra needed beyond
  asserting the sign-up path sets `ends_at` correctly from the setting).
  `expire-holds.ts`'s existing release path, exercised against a HELD
  booking paid with a sign-up coupon, must still release it as today.
  Cancel's `releaseRedemption` call: same.
- Percent snapshot: change the `signup_coupon` setting after a code was
  issued; the already-issued code's `percentBp` is unchanged.
- Turnstile: `newsletter.subscribe` refused with no/garbage token when
  `TURNSTILE_ENABLED=1`; unaffected when the feature flag is off (matching
  every other Turnstile-gated procedure's own test shape).
- No code anywhere on the wire: assert the mutation's resolved value
  (success and `alreadySubscribed` branches alike) has no `code` key, by
  reading the actual TS return type as well as a runtime check.
- Resend throttle: second resend attempt inside the window is silently
  skipped (no second `sendMail` call); a reset-the-clock test proves the
  window actually expires (same shape as `inquiry-notify.test.ts`'s own
  throttle tests).
- Each test is proven able to fail (CLAUDE.md) by breaking the guard under
  test and watching it go red before the real implementation is restored.

## Execution split for 1B

1B is too wide a surface for one dispatch. Split sequentially into two
implementer briefs, reviewed together as ONE Opus review over the combined
range afterward (the owner asked for one dedicated reviewer on 1B, not
two) — the split is for implementer coherence, not extra review seats.

- **1B-i**: migration 0026 (`restricted_to_email`, `newsletter_subscribers
  .coupon_id`, the `signup_coupon` settings key + schema + `seedBase` row),
  `validateCoupon`'s new optional `email` parameter + `CouponEmailMismatchError`
  + the `translateCouponError` case, and threading `input.lead.email` into
  the two authoritative call sites (`create-hold.ts`, `transfers/create-
  booking.ts`). Tests: the `validateCoupon` matrix (wrong email, matching
  email any case/whitespace, `email` omitted is back-compat, non-restricted
  coupons unaffected).
- **1B-ii**: the mint helper (8-char `WELCOME-` code, retry-on-collision),
  `newsletter.subscribe`'s rewrite (both branches, the `FOR UPDATE` path on
  repeat signup), `services/notify/signup-coupon.ts` (sender + per-email
  resend throttle), `newsletterInput`'s `turnstileToken` + the
  `verifyTurnstile`/`turnstileRefusedError` wiring. Tests: issuance mints
  exactly one coupon; a race on a brand-new email still ends with exactly
  one; resend throttle; no `code` key anywhere on the wire; percent
  snapshot survives a later settings change; Turnstile refusal. The
  expire-holds/cancel release tests in this group are **regression
  assertions over `releaseRedemption`, which 1B-ii does not modify** — a
  sign-up coupon's redemption row is released exactly like any other
  coupon's, and the test proves that remains true rather than teaching
  `releaseRedemption` anything new about coupon kinds.

Proceeding to 1B-i.
