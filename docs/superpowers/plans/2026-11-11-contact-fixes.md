# Contact Fixes (owner decisions 2026-11-11)

Owner-given directly, executed subagent-driven, one implementer at a time. Dedicated Opus
reviewer for Task 1 (1A — Turnstile, auth/abuse-adjacent). Default reviewer for Tasks 2-4.

## Global Constraints

- DO NOT push. DO NOT use /loop. DO NOT touch the VPS.
- DO NOT weaken auth, Turnstile, rate limits, or origin checks.
- DO NOT change money, holds, roles, or the schema.
- DO NOT add dependencies. DO NOT use red. DO NOT print/commit .env values.
- Dev servers on 5180/3100: do not start or kill them.
- Related tests per task. Full five checks (lint, typecheck, test, format:check,
  `ALLOW_PLACEHOLDER_BUILD=1 build`) run ONCE at the very end by the controller, not
  required per task — but each task's own new/changed tests must still be proven able to
  fail (break the code, watch red, restore).
- Commit each task separately: `hash - short label`.
- Unrelated bugs: list at the end, don't fix.

---

## Task 1 (1A): Turnstile on the contact form for BOTH inquiry types

**Current state, researched:** `server/src/routers/public/inquiries.ts`'s `create` mutation
gates Turnstile ONLY inside `if (input.type === 'transfer_custom')`. The owner wants it
enforced for EVERY inquiry type, before any write or email. `client/src/components/home/ContactSection.tsx`
currently renders `<TurnstileWidget>` only inside the `requestKind === 'transfer_custom'` JSX
block (lines ~425-431), positioned inside that conditional's grid, not near the submit button.

**Files:**

- Modify: `server/src/routers/public/inquiries.ts`
- Modify: `client/src/components/home/ContactSection.tsx`
- Modify: `client/src/components/common/TurnstileWidget.tsx` (theme)
- Test: `server/src/__tests__/public-mutations.test.ts` (already has Turnstile tests for
  `transfer_custom`/`contact` from a prior batch — HANDOVER-19 Task 13 — find and extend them)

**Server change:**

Remove the `if (input.type === 'transfer_custom')` scoping. The Turnstile check must run
for EVERY `input.type`, unconditionally, before `getDb()`/the insert — same fail-closed
shape (`turnstileRefusedError()`), same `verifyTurnstile({ token: input.turnstileToken,
remoteIp: ctx.req.ip })` call already imported in this file. Update the comment above it
(currently says "ONLY the custom-trip request kind is gated... the owner's own wording
named 'the public custom trip request form'") — that instruction is now superseded by this
owner decision (2026-11-11): every inquiry type is gated.

**Client change — widget placement and both types:**

Move `<TurnstileWidget>` OUT of the `requestKind === 'transfer_custom'` conditional block.
It must render unconditionally (for both "General message" and "Custom trip request"),
positioned "just above Send message" — i.e. directly above the submit `<Button>`, after the
consent checkbox/error block, not inside the per-type fields grid. Both branches of
`handleSubmit` (the `transfer_custom` branch and the plain `contact` branch) must append
`turnstileToken` to their `sendInquiry.mutate({...})` call — currently only the
`transfer_custom` branch does. The existing `turnstileToken`/`turnstileResetKey` state and
the mutation's own `onError` (bumps the reset key) stay as-is; the widget's own `onError`
prop stays as `() => setTurnstileToken(undefined)` only (HANDOVER-19's own rule: never bump
the reset key from the widget's own onError, that causes an unbounded remount loop on a
persistent render error — see `TurnstileWidget.tsx`'s own doc comment).

**Theme — "light" everywhere:**

Cloudflare's `turnstile.render()` accepts a `theme: 'light' | 'dark' | 'auto'` option; this
app currently passes none (defaults to `'auto'`, which can render dark on a dark-mode
browser). Add `theme: 'light'` to the options object passed to `window.turnstile.render(...)`
inside `TurnstileWidget.tsx` — this is the ONE shared component every Turnstile site in the
app uses (staff login, forgot-password, both booking holds, driver login, and now both
contact-form branches), so a single one-line change there makes every widget in the app
"light", satisfying "use light on all other Turnstile widgets too" without touching any of
the other six call sites.

**Tests — write first, watch fail, then implement:**

1. In `server/src/__tests__/public-mutations.test.ts`, find the existing Turnstile tests for
   `inquiries.create` (added in HANDOVER-19 Task 13 — one proves `transfer_custom` is
   refused without a token, one proves `contact` still SUCCEEDS without a token, proving the
   old scoping). The second test's assertion must now FLIP: with `TURNSTILE_ENABLED=1` and no
   token, a `type: 'contact'` submission must now be REFUSED (same `turnstileRefusedError()`
   shape) and write NO row — mirror the existing `transfer_custom` test's shape exactly for
   `contact`. Add a positive case too: both types ACCEPTED (and a row written) when a valid
   token is supplied under a stubbed/off Turnstile check, or by leaving `TURNSTILE_ENABLED`
   unset (feature-off path, which `verifyTurnstile` already returns `true` for with no
   network call — reuse that path for the "accepted" proof rather than a live network call).
2. Watch the flipped `contact` test fail against the OLD code (still refuses only
   `transfer_custom`).
3. Implement the server change above.
4. Watch it pass.
5. Mutation-testing proof: temporarily re-add the `if (input.type === 'transfer_custom')`
   guard — the new `contact`-refusal test must go red. Restore.

No new client test is required for the widget's repositioning/theme (no existing test
asserts its position or the absence of a theme prop) — but confirm no existing test breaks
(`ContactSection`'s own tests, if any, plus `motion.test.tsx`/`layout.test.tsx`'s
Turnstile-adjacent assertions, if any reference the widget's DOM position).

**Dedicated Opus review** (auth/abuse-adjacent — this is the Turnstile gate itself, same
class of surface as HANDOVER-19 Tasks 1/10-13).

Commit message: `feat(turnstile): gate the contact form for every inquiry type, light theme everywhere (owner decision 2026-11-11, 1A)`

---

## Task 2 (1B): WhatsApp AND Viber move to 0927 737 8431

**Current state, researched — important, read carefully before touching anything:**

- `client/src/lib/site.ts`'s `SITE.contact.phone` (0908 469 6246, Smart, `whatsapp: '639084696246'`)
  is today's WhatsApp/Viber number, via `whatsappLink()`/`viberLink()` (same file, ~line
  118-129), both reading `SITE.contact.phone.whatsapp`/`SITE.contact.phone.tel`.
  `SITE.contact.altPhone` (0927 737 8431, Globe) exists today as a CALLS-ONLY second line —
  **its digit value is ALREADY the number the owner wants for WhatsApp/Viber.** No phone
  number anywhere needs to change digit-for-digit; only WHICH number
  `whatsappLink()`/`viberLink()` read needs to change, from `phone` to `altPhone`.
- **No settings/DB value needs changing.** There is a server-side `settings.contact` block
  (admin-editable, `whatsapp`/`phoneTel`/`altPhoneTel`/etc. fields) that mirrors `site.ts`
  for `seed-parity.test.ts` and is read by `server/src/seo/jsonld.ts` for the
  `TravelAgency.telephone` JSON-LD field (always `phoneTel`, i.e. the PRIMARY Smart number —
  unaffected by this change, since `phoneTel`'s own digit value is unchanged and the
  "Phone/call numbers stay as they are" instruction covers it). Nothing in
  `client/src/lib/site.ts`, `server/src/db/seed-data.ts`, or the admin settings UI needs a
  NEW digit value — confirmed by reading every consumer of `settings.contact.*`. **Do not
  touch `server/src/db/seed-data.ts`'s `contact` block or any settings row for this task.**
  Tell the owner plainly in your report: no staging admin edit is needed for 1B.
- `whatsappLink(message?)` and `viberLink()` are defined in `client/src/lib/site.ts`
  (~line 118-129) and are the ONLY functions that construct these deep links — every caller
  (`ContactSection.tsx`, `FloatingWhatsApp.tsx`, `SiteFooter.tsx`, `PaymentOptions.tsx`) calls
  one of these two functions; none hardcodes a number itself. Fixing the two functions fixes
  every caller's actual link target automatically.
- `SITE.contact.altPhone` currently has NO `whatsapp`-formatted field (the `639...` no-plus-no-spaces
  format `wa.me` needs) — only `phone` has one. Add `whatsapp: '639277378431'` to `altPhone`.
- **Display text that currently shows the WRONG (primary) number next to the WhatsApp/Viber
  buttons must change to show the alt number**, since the link and the displayed number must
  agree:
  - `ContactSection.tsx` (~line 231, 245): the `<span>` under "WhatsApp" and under "Viber"
    both currently render `{SITE.contact.phone.display}` — change both to
    `{SITE.contact.altPhone.display}`.
  - `SiteFooter.tsx` (~line 119-164): the "Primary line" block shows `SITE.contact.phone.display`
    with the WhatsApp/Viber `ChatButton`s beside it and a caption "WhatsApp, Viber and calls"
    (~line 152) right under it; a second block below shows `SITE.contact.altPhone.display` as
    "calls only". Since WhatsApp/Viber now live on the ALT number, this layout's CAPTIONS are
    now backwards. Minimal correct fix: swap which caption goes with which number — the
    primary (Smart) line's caption becomes something like "Calls only" (or similar, matching
    this file's existing tone) and the alt (Globe) line's caption becomes something that
    names WhatsApp+Viber+calls+SMS (read the file's exact current wording at both captions
    before composing the replacement, and keep the WhatsApp/Viber `ChatButton`s rendered
    beside whichever number block they now belong to — do not duplicate the buttons, move
    them). Do NOT reorder which number is "first" unless the caption swap forces it for
    sense — the simplest fix is probably moving the `ChatButton`s + swapping just the two
    caption strings, not restructuring the two `<li>`/block elements themselves.
  - `FloatingWhatsApp.tsx` and `PaymentOptions.tsx` display NO number text next to their
    WhatsApp link (icon-only or a bare "Message us on WhatsApp" label) — confirmed by
    reading both files. No text change needed in either; only `whatsappLink()`'s own fix
    (above) changes their actual link target.
- **`coming-soon/index.html`** (a standalone, no-build-step static page served at the apex
  domain until launch) hardcodes `https://wa.me/639084696246` (two occurrences: the
  `brandbtn__pill--whatsapp` href, and the "Message us" services-line href) and
  `viber://chat?number=%2B639084696246` (one occurrence) — all three must change to
  `639277378431` / `%2B639277378431` respectively. It ALSO has a dev-facing (non-rendered)
  HTML comment near the top (`CONTACT VALUES MIRROR client/src/lib/site.ts...`) stating
  "primary 0908 469 6246 (Smart) — WhatsApp, Viber and calls" / "alternate 0927 737 8431
  (Globe) — calls and SMS" — update this comment to reflect the swap. AND the rendered
  `<ul class="lines">` list (~line 682-693) has two `<li>` rows with `<span class="note">`
  text "WhatsApp, Viber and calls" (Smart row) and "Calls and SMS" (Globe row) — these
  VISIBLE captions must swap the same way `SiteFooter.tsx`'s did (Smart becomes calls-only,
  Globe gains WhatsApp+Viber). The `tel:+639084696246`/`tel:+639277378431` links and "Call
  0908 469 6246" button text are UNCHANGED (phone/call numbers stay as they are).
- **`scripts/check-contact-parity.mjs`** fails the build if `client/src/lib/site.ts` and
  `coming-soon/index.html` disagree, and it is wired into the root `pnpm test` command
  (`node scripts/check-coming-soon.mjs && node scripts/check-contact-parity.mjs && pnpm -r run test`)
  — so this script WILL catch a drift, but its own logic currently assumes `wa.me`/`viber://`
  targets are built from the PRIMARY (`phone`) fields (`expected.whatsapp`, `expected.phoneTel`
  — see its `must`/`allowed` arrays). Since the actual digit values for primary and alt are
  unchanged (only which one backs wa.me/viber changed), **the parity script's `must`/`allowed`
  entries for `'WhatsApp link'` and `'Viber deep link'` need to read the ALT fields instead of
  the primary ones** — change `expected.whatsapp`→ the alt phone's whatsapp-formatted number
  (read it the same way the script already derives `altPhoneDisplay`/`altPhoneTel`, via the
  SECOND regex match in its `matchAll` loops — you will need to add a second `whatsapp:`
  field match the same way, since `site.ts` will now have two `whatsapp:` occurrences after
  your `altPhone.whatsapp` addition above) and `expected.phoneTel`→`expected.altPhoneTel` for
  the Viber line specifically. Read the whole script before editing — it is short (126 lines)
  and entirely regex-based; get the field-extraction order right (first match vs. second
  match) or it will silently compare the wrong thing.
- **Two test files reference WhatsApp/Viber but do NOT hardcode the phone number** —
  `client/src/__tests__/layout.test.tsx` and `client/src/__tests__/motion.test.tsx` both call
  the live `whatsappLink()`/`viberLink()` functions in their own assertions (e.g.
  `expect(pillFor('whatsapp')).toHaveAttribute('href', whatsappLink())`) or match on
  aria-label/text content, not a literal number — confirmed by reading both files. **These
  should need NO changes** and should keep passing automatically once the functions change,
  since they call the same (now-updated) function rather than asserting a hardcoded string.
  Run them to confirm; if either turns out to hardcode a number after all, report it as a
  deviation from this brief rather than silently patching around it.

**Files:**

- Modify: `client/src/lib/site.ts` (add `altPhone.whatsapp`, fix `whatsappLink()`/`viberLink()`)
- Modify: `client/src/components/home/ContactSection.tsx` (displayed number under the two chat rows)
- Modify: `client/src/components/layout/SiteFooter.tsx` (caption swap, chat buttons placement)
- Modify: `coming-soon/index.html` (wa.me/viber hrefs, dev comment, visible `<li>` notes)
- Modify: `scripts/check-contact-parity.mjs` (read the alt fields for the wa.me/viber checks)
- Verify-only (no change expected): `client/src/__tests__/layout.test.tsx`,
  `client/src/__tests__/motion.test.tsx`

**No settings-schema.ts / seed-data.ts / admin settings-blocks.ts change** — confirmed above,
no digit value changes, only link-source code does.

**Tests:**

1. Run `node scripts/check-contact-parity.mjs` standalone BEFORE touching anything, confirm
   it currently passes (baseline).
2. Make the `site.ts` change first; re-run the parity script — it should now FAIL (site.ts
   says alt-number WhatsApp, coming-soon still says primary-number WhatsApp) — this is your
   RED proof that the two files really did agree on the old number and now disagree.
3. Fix `coming-soon/index.html` and the parity script's own field-reading logic together;
   re-run — GREEN.
4. Run `client/src/__tests__/layout.test.tsx` and `client/src/__tests__/motion.test.tsx` to
   confirm no regression (per the note above, these should pass unchanged).
5. Manually confirm (read the diff) that `tel:` links, "Call or text (Smart/Globe)" labels,
   and the two displayed phone numbers for CALLING purposes are byte-identical to before your
   change everywhere — this task must not touch a single calling number or label.

Commit message: `fix(contact): WhatsApp and Viber move to 0927 737 8431, phone numbers unchanged (owner decision 2026-11-11, 1B)`

---

## Task 3 (1C): Contact form emails

**Current state, researched:**

- `server/src/routers/public/inquiries.ts`'s `create` mutation sends NO email today — it only
  inserts a row.
- `notify(event, payload)` (`server/src/services/notify/index.ts`) exists but is
  BOOKING-shaped: `NotifyPayload` requires `ref`, `tourTitle`, `tourDate`, `totalCentavos`,
  `paidCentavos` — none of which an inquiry has. **Do not shoehorn inquiry mail into this
  union.** The established precedent for a non-booking-shaped mail is
  `server/src/services/notify/staff-password-reset.ts`: its own render function, its own
  sender function, reusing `mailDocument`/`mailLink` (exported from
  `server/src/services/notify/templates.ts` as `document_ as mailDocument, linkHtml as
mailLink`) for the same visual shell every other mail uses, and the SAME
  transport/mailFrom/cannot-throw/masked-logging discipline `notify()` and
  `sendStaffPasswordResetEmail` both follow. Follow this exact pattern for inquiry mail:
  create `server/src/services/notify/inquiry.ts`, re-export its two sender functions from
  `server/src/services/notify/index.ts` (mirroring how `sendStaffPasswordResetEmail` is
  re-exported there today).
- **Office recipient = `settings.contact.email`** (the same setting `SITE.contact.email`
  mirrors client-side; server-side, read it via `readSettingBlock('contact')` — same helper
  `server/src/seo/resolvers.ts` already uses for `site_seo`/`hero`, check its exact import
  path and signature before using it). **Do NOT add `OFFICE_NOTIFY_EMAIL` to `.env`** — the
  owner's own instruction was conditional ("if none exists, add..."), and one already exists.
  Say so plainly in your report.
- **Admin link** = `${env.PUBLIC_BASE_URL}/admin/packages` (confirmed: inquiries are managed
  inside `AdminPackagesPage.tsx`'s own "Inquiries" section via `admin.inquiries.list`/
  `setStatus`; there is no dedicated `/admin/inquiries` route — `/admin/packages` is the real,
  existing destination). `env.PUBLIC_BASE_URL` is the same base-URL constant
  `server/src/services/notify/templates.ts` already uses for portal links (confirmed at
  that file's own `~line 269`) — import `env` from `../../env` the same way.
- **Guest acknowledgement rate cap — reuse the EXISTING pattern, do not invent a new one.**
  `server/src/services/password-reset.ts` already implements "N per email address per
  window" via an in-process `Map<string, number[]>` keyed by lowercased email
  (`RESET_MAX_PER_EMAIL`, `RESET_WINDOW_MS`, read that file's own doc comment on WHY an
  in-process Map is correct here — PM2 fork mode, single instance, same reasoning
  `services/staff-auth.ts`'s own throttle gives). Build the inquiry guest-ack cap the same
  way, in whichever file makes sense (either inline in your new `notify/inquiry.ts`, or a
  small sibling `services/inquiries/ack-throttle.ts` if that reads cleaner — your call, but
  do not duplicate the Map-based throttle logic itself, factor it if you need it twice).
  Constants: `INQUIRY_ACK_MAX_PER_EMAIL = 1`, `INQUIRY_ACK_WINDOW_MS = 60 * 60_000` (one hour).
  This cap is on the GUEST ACK only, per the owner's wording ("Max one per email address per
  hour") — the OFFICE notification has no such cap (every genuine inquiry should reach the
  office; the cap exists only to stop someone using the guest-ack as a mail relay/spam
  vector against an arbitrary third-party address).

**What each mail says, exactly as specified:**

- **Office notification**, sent on EVERY inquiry (no rate cap):
  - To: `settings.contact.email`.
  - Subject: `New message from <name>` for `type !== 'transfer_custom'`, or
    `New trip request from <name>` for `type === 'transfer_custom'` — read `input.name`/`input.type`.
  - Body: name, email, mobile (phone), type, and — ONLY IF PRESENT (the `transfer_custom`
    fields are optional on every other type, per `inquiryInput`'s own schema) — trip date
    (`requestedDate`), pax, route (`routeDescription`); then the message text; then a link to
    `${env.PUBLIC_BASE_URL}/admin/packages`. Omit any field-shaped row for an absent optional
    field entirely (same `detailsHtml`/`detailsText` omit-the-row convention
    `notify/templates.ts`'s own doc comment describes for a null `tourTitle` — "a line reading
    `Tour: null` is the failure this nullability exists to make impossible, and an empty label
    is worse than no label" — apply the identical principle here).
- **Guest acknowledgement**, sent after the office mail (both after the DB insert commits —
  this mutation has no explicit transaction today per the file you read; confirm whether the
  `db.insert(inquiries).values({...})` is itself the commit point, and send both mails only
  after that `await` resolves successfully, never before, and never if the insert throws):
  - To: `input.email`.
  - First name only: split `input.name` on whitespace, use the first token (do not invent a
    name-parsing library; a simple `.trim().split(/\s+/)[0]` is correct here — the message's
    whole point is a warm, personal-feeling receipt, not a formal name parse).
  - Body, VERBATIM (owner-specified wording): `"Thanks, <first name> — we got your message and
will reply within business hours (Mon–Sun, 7:00 AM–9:00 PM PHT)."` — do not editorialize
    this sentence.
  - **Must NOT echo the guest's own message text, phone number, or any link/URL they typed**
    (anti-spam-relay — a guest could type an arbitrary URL into the message box hoping this
    system's own outbound mail server echoes it to themselves or a third party they also put
    in the `email` field). The acknowledgement's body is ONLY the fixed sentence above, the
    standard mail shell (`mailDocument`), and nothing guest-supplied except their own first
    name (which is sent back to the address THEY supplied, and is not itself an attacker
    payload the way a message/URL could be).
  - Rate-capped: if this guest's email address (lowercased, matching the password-reset
    throttle's own case-handling) has already received an acknowledgement in the last hour,
    skip sending a second one — but this skip must NOT prevent the office notification or the
    inquiry row from being written; it only skips this one guest-facing mail. Log nothing
    sensitive on skip (a one-line `console.log`/`console.warn` naming the masked email and
    "rate-capped" is fine, mirroring `maskEmail`'s use elsewhere in this codebase — import it
    from `services/password-reset.ts` if that's where it already lives, confirmed at that
    file's own import list).

**Wiring into `inquiries.create`:**

Both sends happen AFTER the `db.insert(inquiries).values({...})` succeeds, via `notify`'s own
cannot-throw discipline (these new sender functions must themselves never throw — mirror
`sendStaffPasswordResetEmail`'s own try/catch-and-log shape exactly, do not let a caller need
its own try/catch). Do not block the mutation's response on slow mail — call both, `await`
them (they resolve fast either way, success or logged-failure) rather than fire-and-forget
with no await, matching how every other `notify(...)` call site in this codebase already
awaits it (confirmed convention, not a new choice).

**Files:**

- Create: `server/src/services/notify/inquiry.ts` (render + send, both directions)
- Modify: `server/src/services/notify/index.ts` (re-export the two new senders)
- Modify: `server/src/routers/public/inquiries.ts` (call both after the insert commits)
- Test: new test file `server/src/__tests__/inquiry-notify.test.ts` (or extend
  `public-mutations.test.ts` if that's where `inquiries.create`'s own tests already live —
  check first), covering: office mail sent for both `contact` and `transfer_custom` types
  with the right subject; optional fields omitted from the body when absent, present when
  given; guest ack sent with the exact sentence, first name only, and provably does NOT
  contain the guest's message text or a URL they supplied; the one-per-email-per-hour cap
  (second inquiry from the same address within the window gets no second ack mail, but DOES
  still get its row written and its office mail sent).

**TDD:** write these tests against the CURRENT (no-email) code first, confirm they fail (no
mail sent at all today), then implement, confirm green. Mutation-testing proof: temporarily
make the guest-ack cap always return "not capped" — the cap test must go red (a second mail
sends). Restore.

Commit message: `feat(contact): office notification and guest acknowledgement emails, rate-capped (owner decision 2026-11-11, 1C)`

---

## Task 4 (1D): Stale tab title on client-side navigation

**Current state, researched — this already has real, partial infrastructure, read before
touching anything:**

- `client/src/hooks/useDocumentTitle.ts` already exists: `useDocumentTitle(name: string |
null)` sets `document.title = ${name} | TravelSugbo` whenever `name` changes, `null` means
  "leave it alone". `client/src/components/layout/PublicLayout.tsx` already calls it with
  `STATIC_PUBLIC_TITLES[pathname]` (from `@rg/shared`) for `/tours`, `/privacy`, `/terms`,
  `/refund-policy`, `/cookies`, `/photo-credits` — these routes are NOT stale today.
- **The actual gap**, confirmed by reading `TourDetailPage.tsx`/`PackageDetailPage.tsx`:
  NEITHER calls `useDocumentTitle` at all. Their titles come from a per-row DB value
  (`seo_title`, with a computed fallback formula — see below) that only the server resolver
  currently applies, on the FIRST load. A client-side navigation to either page (e.g. Home →
  a tour card, or Tour A → Tour B via a related-tours link) leaves `document.title` exactly
  as it was on the PREVIOUS page — this is the stale-tab-title bug.
- **`HomePage.tsx` has the same gap**: `/` is not in `STATIC_PUBLIC_TITLES` (its title is
  `settings.site_seo.title`, a full database-driven string, not a bare name) and nothing sets
  it client-side. Navigating Tour A → Home (client-side) leaves Tour A's title showing
  forever, unless you also fix this.
- **Why the obvious "just call `useDocumentTitle(tour.title)`" is wrong**: the real injected
  title is NOT the bare `tour.title` — it's `tourTitle(tour)` (`server/src/seo/resolvers.ts`,
  private function, ~line 309): `tour.seoTitle` if an admin set one, else
  `` `${tour.title} — ${tour.destinationName} day tour from ${price} | TravelSugbo` ``. Same
  shape for packages (`packageTitle(pkg)`, ~line 333) and for home
  (`settings.site_seo.title`, a complete string with NO further brand-suffix needed — it
  already reads e.g. "TravelSugbo — Cebu Airport & Island Transfers"). **These are already
  fully-formed title strings, not bare names** — passing one through the existing
  `useDocumentTitle` (which APPENDS `" | TravelSugbo"`) would double-brand them. You need a
  second, simpler hook (or a parameter) that sets `document.title` VERBATIM, no suffix.
- **"One source of truth" means reusing the exact formula, not re-deriving it client-side.**
  `tourTitle()`/`packageTitle()` are private to `server/src/seo/resolvers.ts` today. The
  public `tours.bySlug`/`packages.bySlug` tRPC responses already expose a raw `seoTitle:
string | null` field (the admin override only — confirmed by reading both routers), but
  NOT the computed fallback string, so using it directly would show nothing/null for most
  tours (the common case with no admin override). **The correct fix: export `tourTitle` and
  `packageTitle` from `server/src/seo/resolvers.ts` (or move them to a small shared helper
  both that file and the two public routers import, if that avoids an awkward import
  direction — your judgment, but do not duplicate the formula into a second copy), and have
  `tours.bySlug`/`packages.bySlug` compute and include a new field (e.g. `pageTitle: string`)
  in their response using that SAME function, from the SAME row data they already fetch**
  (check `tours.bySlug`'s/`packages.bySlug`'s current `select` includes `destinationName`/
  `fromPriceCentavos`/`days`/`newPriceCentavos` — the fields `tourTitle`/`packageTitle` need;
  add them to the select if missing, they should already be present since the list/detail
  views likely need the same fields for display). The client then calls the new verbatim-title
  hook with `data.pageTitle` directly — byte-identical to what the server already injected on
  a cold load, by construction, since it's the literal same function.
- **Scope boundary — do NOT touch admin/driver/portal surfaces.** `AdminLayout.tsx` and
  `DriverLayout.tsx` already call `useDocumentTitle(APP_SURFACE_TITLES['/admin'|'/driver'])`
  — a FIXED title per surface that never varies by sub-route. CLAUDE.md documents this as a
  known, SEPARATE, already-accepted gap ("nothing sets `document.title` client-side [within
  the surface]... That smaller gap is open; this change did not close it" — from a prior
  task). This owner decision (2026-11-11) is about the PUBLIC site's stale title on
  navigation between tour/package/home pages; leave the three app surfaces exactly as they
  are. Say so explicitly in your report so it isn't mistaken for an oversight.

**Files:**

- Create or modify: `client/src/hooks/useDocumentTitle.ts` (add a verbatim-title export,
  e.g. `useRawDocumentTitle(title: string | null)` — same `null`-means-leave-alone contract,
  no brand suffix appended; keep the existing `useDocumentTitle` export unchanged for its
  current callers)
- Modify: `server/src/seo/resolvers.ts` (export `tourTitle`/`packageTitle`, or extract to a
  shared helper — your judgment on the cleanest import direction)
- Modify: `server/src/routers/public/tours.ts` (`bySlug` response gains `pageTitle`)
- Modify: `server/src/routers/public/packages.ts` (`bySlug` response gains `pageTitle`)
- Modify: `client/src/pages/public/TourDetailPage.tsx` (call the new hook with `data.pageTitle`)
- Modify: `client/src/pages/public/PackageDetailPage.tsx` (same)
- Modify: `client/src/pages/public/HomePage.tsx` (call the new hook with `settings.siteSeo.title`
  — it already fetches `settings.get`, check the exact field name/path on that payload before
  using it, likely `data.siteSeo.title` matching the client-side shape convention this repo
  already uses elsewhere for this same settings block)
- Test: `client/src/__tests__` — find or create the right test file(s) for each of the three
  pages (check for existing `tour-detail-page.test.tsx`/`package-detail-page.test.tsx`/
  `home.test.tsx` naming, use whichever already covers these pages); also a focused test for
  the new hook itself if none of the three page tests exercise it adequately.
- Test (server): extend whichever existing test file covers `tours.bySlug`/`packages.bySlug`
  to assert the new `pageTitle` field is present and matches `tourTitle()`/`packageTitle()`'s
  own output for a representative row (with and without an admin `seoTitle` override, if a
  fixture supports both cheaply — otherwise at least the no-override formula case).

**Tests — write first, watch fail, then implement:**

1. Server-side: assert `tours.bySlug`/`packages.bySlug` responses carry `pageTitle` — fails
   today (field does not exist).
2. Client-side, for each of the three pages: render the page (or a navigation TO it from
   another route, if the existing test harness supports a router-based render), assert
   `document.title` equals the expected fully-formed string. Fails today (nothing sets it).
3. Implement both halves.
4. Watch all pass.
5. Mutation-testing proof: temporarily make one page's title call pass a hardcoded wrong
   string — its own test must redden. Restore. Temporarily revert the `pageTitle` field's
   server-side computation to return `row.title` (bare, not the formula) — the server-side
   assertion must redden. Restore.

Commit message: `fix(seo): client-side navigation sets the real per-page title, not the previous page's (owner decision 2026-11-11, 1D)`

---

## ✅ CONTACT FIXES — closing report

### 1. Commits

**1A — Turnstile on both inquiry types + light theme:**

- `cef608c` - feat(turnstile): gate the contact form for every inquiry type, light theme everywhere
- `8f914db` - test(turnstile): pin that the widened contact-form gate also refuses type=package (superseded by the next commit)
- `ba9219d` - fix(turnstile): exclude package inquiries from the gate — no widget exists on that form (1A ruling)
- `3032c92` - fix(turnstile): correct inverted gate comment, prove the feature-off test can fail (fix round 1)

**1B — WhatsApp/Viber move to 0927 737 8431:**

- `9b1ad20` - fix(contact): WhatsApp and Viber move to 0927 737 8431, phone numbers unchanged

**1C — office + guest emails:**

- `2419ed6` - feat(contact): office notification and guest acknowledgement emails, rate-capped

**1D — stale tab title fix:**

- `3e440e4` - fix(seo): client-side navigation sets the real per-page title, not the previous page's

**Post-batch (final whole-branch review + controller fixes):**

- `3f59bae` - fix: Task 1C's new inquiry emails leaked into an unrelated test's mail-capture array (breaker adjudication) — also adds the missing "Turnstile refusal sends no mail" test
- `775e6bc` - format: prettier sweep on HANDOVER-19's closing report (unrelated gap found while re-running checks for this batch)

9 commits total, local `main`, none pushed.

### 2. Full five checks — final result

`pnpm lint` · `pnpm typecheck` · `pnpm test` (shared 109/109, client 1136/1136, server
2773/2773 + 2 skipped-by-design) · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm
build` — all green on the fully-committed tree.

### 3. New SERVER `.env` lines needed

**None.** All four tasks were additive to existing infrastructure:

- 1A reuses the Turnstile env vars HANDOVER-19 already documented (`TURNSTILE_ENABLED`,
  `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`) — no new ones.
- 1B changes which existing number backs WhatsApp/Viber; no digit value changed anywhere.
- 1C deliberately does NOT add `OFFICE_NOTIFY_EMAIL` — it reuses the existing
  `settings.contact.email` row (see the admin-settings note below).
- 1D is pure client/server plumbing reusing existing data.

### 4. Admin settings you should check on staging

- **1C makes `settings.contact.email` a real, consumed mail address for the first time** —
  every contact-form inquiry now sends an office notification there. **Verify in Admin →
  Settings → Content that this is actually the inbox you want these to land in** before this
  deploys; it was previously descriptive text only (used in JSON-LD and on-page display),
  never an actual mail destination.
- **1C also requires SMTP to already be configured** (the same mail transport booking
  confirmations etc. already use) — if that's not yet set up on staging, these new emails
  will silently log `"SMTP is not configured"` and not send (by design, same fail-silent
  behavior every other notification in this system has), rather than erroring the guest's
  submission.
- **No other settings row needs editing** — 1B's digit values are unchanged, 1D touches no
  settings data.

### 5. Two open questions for you — not fixed, need your decision

**(a) `package`-type inquiries are now both ungated AND emailed, both directions — a bigger
change than it looks.** 1A deliberately left `package` inquiries (a separate form, unrelated
to the contact form you asked about) outside the Turnstile gate, since no widget exists
there — correct on its own. But 1C's new emails apply to EVERY inquiry type, including
`package`. Before this batch, an ungated `package` submission cost one database row. Now it
costs one uncapped office email plus one guest acknowledgement email sent to whatever
address the submitter typed — **once `TURNSTILE_ENABLED=1` is actually set in production**,
this is the one inquiry type nothing stands in front of. It's bounded (the existing 5-per-
15-minutes-per-IP limiter, plus the 1-per-email-per-hour guest-ack cap means no single
victim address gets bombed), but it is a real outbound-mail-relay surface from your own
server that didn't exist in this shape before. Three ways to close it, your call:

1. Add a Turnstile widget to the package inquiry forms too (most consistent, more work).
2. Keep the office notification (so you still hear about every package inquiry) but skip
   the guest acknowledgement specifically for `type: 'package'` (closes the relay-to-a-
   third-party-address angle, smallest change).
3. Accept it as-is — rate-limited, not unbounded, and arguably no worse than any other
   public contact form on the internet.

**(b) A small copy inconsistency 1B's footer change introduced.** `SiteFooter.tsx` and
`coming-soon/index.html` now caption the Smart number (0908 469 6246) "Calls only" — but
`ContactSection.tsx`'s own "Call or text (Smart)" label, elsewhere on the same page, was
correctly left unchanged per your instruction ("phone/call numbers stay as they are"). Does
the Smart line actually take texts, or not? Whichever is true, one of those two strings
needs to change to match it — a one-line fix once you tell me which.

### 6. Unrelated bugs found

**None new.** The one real bug found during this batch (Task 1C's emails leaking into an
unrelated test's mail-capture assertion) was CAUSED by this batch's own change, not
unrelated to it — already fixed (see §1, commit `3f59bae`).

### 7. Minor items, logged for awareness, not fixed (low priority, your call whether to ever act on them)

- `settings.contact.whatsapp` (the admin-editable "WhatsApp number" field, Admin → Settings
  → Content) still holds the OLD number (0908 469 6246) — nothing reads it to build a link
  today (the real link-builder reads `altPhone.whatsapp` in code, not this setting), so
  there's no functional bug, but the admin screen now shows a stale/misleading value next to
  that label.
- The two new SMTP sends in `inquiries.create` have no explicit timeout configured (same
  nodemailer defaults every other notification already has) — this is the first time a
  _public, unauthenticated_ form pays that cost rather than an authenticated admin action. A
  hung mail relay would hold the guest's "Sending…" spinner longer than ideal. Not urgent.
- A handful of smaller code-hygiene notes (an `escapeHtml` helper duplicated rather than
  shared, the office mail not naming which specific package a `package`-type inquiry is
  about, one test file's Turnstile tests relying on ambient env rather than a pinned
  default) are recorded in the session's own working notes if you ever want the full list —
  none affect behavior today.

✅ CONTACT FIXES COMPLETE
