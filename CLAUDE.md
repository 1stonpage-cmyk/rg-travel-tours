# CLAUDE.md — R&G Travel & Tours

Standing conventions for every session on this repo. **Read this before implementing anything.**
Full requirements live in `docs/BUILD_SPEC.md` — that spec wins any disagreement with this file.

## Project

Online booking + operations system for **TravelSugbo**, Cebu, Philippines.
Day tours and multi-day packages. Domain: TravelSugbo.com. 8-week build.

**Brand vs legal entity — keep these separate.** The public trading brand is
**TravelSugbo**; the licensed operator is **R&G Travel & Tours**, which holds the
DOT/DTI/BIR registrations, the PayMongo merchant account and the payment QR.
In code these are `SITE.name` and `SITE.legalOperator` (`client/src/lib/site.ts`).
Customer-facing copy uses the brand. Anything regulatory, legal or financial —
the copyright notice, the accreditation block, the "Operated by" credit, payment
receipts — names the operator. Do not collapse them into one value.

Five surfaces: public website, checkout, customer portal, driver portal, admin/dispatch.

## Ports — hard constraint

**Kong PMS also runs on this machine. NEVER use port 5173 or port 3000.**

| Process                  | Port                          |
| ------------------------ | ----------------------------- |
| Client (Vite dev server) | **5180** (`strictPort: true`) |
| Server (Express + tRPC)  | **3100**                      |

- Vite proxies `/trpc` and `/api` to `http://localhost:3100`.
- Ports come from `.env` (`CLIENT_PORT=5180`, `PORT=3100`) and are mirrored in `.env.example`.
- Local MySQL database name is **`rg_travel`** — separate from Kong's database.

## Commands

| Command                             | Does                                            |
| ----------------------------------- | ----------------------------------------------- |
| `pnpm install`                      | Install all workspace packages                  |
| `pnpm dev`                          | Run client (5180) and server (3100) in parallel |
| `pnpm build`                        | Build every package                             |
| `pnpm test`                         | Run all tests                                   |
| `pnpm typecheck`                    | `tsc --noEmit` across packages                  |
| `pnpm lint` / `pnpm lint:fix`       | ESLint                                          |
| `pnpm format` / `pnpm format:check` | Prettier                                        |

Database commands live in the **server** workspace, so they need the filter — a bare
`pnpm db:seed` from the repo root fails with `Command "db:seed" not found` (BUG-101):

| Command                                | Does                                             |
| -------------------------------------- | ------------------------------------------------ |
| `pnpm --filter @rg/server db:generate` | Write a migration from `src/db/schema.ts`        |
| `pnpm --filter @rg/server db:migrate`  | Apply migrations to `rg_travel` (name preflight) |
| `pnpm --filter @rg/server db:seed`     | Load development content from `src/db/seed-data` |

Package manager is **pnpm**. Do not introduce npm or yarn lockfiles.
`.gitattributes` pins the whole tree to LF (`* text=auto eol=lf`) — without it a fresh clone
on Windows fails `pnpm format:check` on every text file (BUG-099). Do not relax it.

## Layout

```
/client   React + TS + Vite + Tailwind v4 + shadcn/ui
  src/pages/public | portal | driver | admin
  src/components | src/lib
/server   Express + tRPC
  src/routers | services | db | seo | content | middleware   (built)
  src/jobs | webhooks                                        (Week 3+, not yet created)
/shared   Zod schemas, types, constants
/uploads  OUTSIDE the web root; receipts served via an authenticated route
/docs     BUILD_SPEC.md and superpowers plans
```

## Stack

React + TypeScript + Vite + Tailwind v4 + shadcn/ui + React Router · Express + tRPC ·
Drizzle + MySQL 8 · Zod (shared) · session cookies with bcrypt/argon2 · PayMongo ·
SMTP email · optional SMS behind a provider interface · `node-cron` · PM2 · nginx + Let's Encrypt.

Tailwind is **v4**: brand tokens live in an `@theme` block in `client/src/index.css`.
There is no `tailwind.config.js`.

## Conventions

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display.
- **Time:** store **UTC**; display and compute business dates in **Asia/Manila**.
- **IDs:** auto-increment internally. Public booking refs are random and non-sequential (`RG-7KQ4M9`).
- **Soft deletes:** use `is_active` / status fields for tours, vans, drivers, users.
  **Never hard-delete bookings or payments.**
- **Audit:** every payment, refund, status change, and assignment writes to `audit_log`.
- **Validation:** Zod on every input, schemas shared from `/shared`.

## Brand & design

- **Blue primary, gold accent. NO RED ANYWHERE** — including errors, badges, and
  destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`).
  shadcn's `--destructive` token is remapped away from red.
  A guard test (`client/src/__tests__/no-red.test.ts`) fails the build if red reappears.
- **Contrast guard:** `client/src/__tests__/contrast.test.ts` reads every class string that
  sets both a `bg-brand-*` and a `text-brand-*` utility, resolves both against the `@theme`
  block in `index.css`, and requires AA (4.5:1). It reads the real source, not a fixture list,
  so a pairing added later is checked without anyone updating anything (BUG-080).
- **Mobile-first.** Must work at 360px; most guests book on a phone.
- **Accessibility:** 44px minimum tap targets, visible focus states, alt text on every
  image, AA contrast.
- **Gold contrast:** `brand-gold-600` (`#b8860b`) fails AA (4.5:1) for normal-size text on
  white and on `brand-blue-50` — measured 3.25:1 and 3.00:1. Small gold text (eyebrows,
  labels, captions) must use `brand-gold-700` or darker. `brand-gold-600` remains fine for
  non-text uses (icons, badges, large decorative elements).
- **Brand-colour exception (WhatsApp / Viber):** `#25D366` (WhatsApp), `#128C7E` (WhatsApp
  hover/pressed) and `#7360F2` (Viber) are a documented exception to the blue/gold palette —
  official third-party chat-app colours, used only for WhatsApp/Viber deep-link controls.
  Red remains forbidden everywhere else. **No white text on any of the three** — each carries
  only the official white glyph (exempt under WCAG 1.4.11 as a logotype); every pill built
  from one of these colours is icon-only with an `aria-label`, and any visible wording
  ("Chat on WhatsApp", "Viber") sits **outside** the pill, on the page background, in brand
  ink. `#128C7E` is the WhatsApp pill's hover/pressed state only and never gets white text
  either. White-on-`#25D366` measures 1.98:1 (fails AA at any size); `#128C7E` and `#7360F2`
  measure 4.14:1 and 4.48:1, both just under the 4.5:1 bar — hence one uniform rule instead
  of per-colour sizing exceptions.
- **Motion:** subtle only (card hovers, tracker progress, check-in confirmation), and only
  after the layout exists.

## Workflow

- Use **Superpowers** (`writing-plans` + `subagent-driven-development`) per week of work.
  Write the plan, get approval, then execute.
- Use **ui-ux-pro-max** for all UI, layout, and design work.
- Motion: Use **emilkowalski-motion** for motion/animation only, after layout exists. Subtle only; respect `prefers-reduced-motion`.
- **Verify before pushing — all five, in this order:**
  `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` ·
  `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.
  `pnpm test` also runs the standalone guards (`check:coming-soon`, `check:contact`).
  Never report work as done on an unrun command.
- **Every new test must be proven able to fail.** Break the code it covers, confirm the
  test goes red, then restore. A test that cannot fail is a bug — log it in
  `docs/BUGS_LOG.md`. **Security controls and destructive operations must fail closed,
  with a test for the failure path.**
- Keep formatting changes in their own commit. A `pnpm format` sweep mixed into a
  feature commit buries the real diff.
- Write **✅ DONE** immediately after each numbered task (1A, 1B, …) actually finishes.
- Write **✅ WEEK X COMPLETE** when every task in a week is done and verified.
- Report commits as `hash - short human label` (e.g. `55f1bba - Checkout deposit math`).
- After any schema change, remind the user to apply the migration on the server database.
- Build **additively**. Once a feature works, extend it — do not rewrite it.
- Prefer simple solutions. No over-engineering, no duplicate data.

## DO NOT

- **DO NOT** trust prices, totals, deposits, or discounts sent from the browser.
  The server computes all money.
- **DO NOT** mark a booking paid from the client side or from a redirect URL.
  Only a verified PayMongo webhook or an admin approval does that.
- **DO NOT** store card numbers, CVV, or e-wallet credentials anywhere. PayMongo handles them.
- **DO NOT** expose receipt uploads, driver data, or customer details through public URLs.
- **DO NOT** let one role reach another role's endpoints. Hiding a button is not access control.
- **DO NOT** change auth, payment, or database schema logic outside the task you were given.
- **DO NOT** deploy to production from the spec. Deployment is a separate, dedicated prompt.
- **DO NOT** add libraries, services, or features not listed in the spec without asking.
- **DO NOT** use red anywhere in the UI.
- **DO NOT** fake social proof. Ratings, "booked X times", and guest counts must come from
  real data or admin-entered settings.
- **DO NOT** use ports 5173 or 3000.

## Content (current state)

The public site is fully database-backed (task 3.7 deleted the last hardcoded module).
Every page reads tours, destinations, packages, reviews, FAQs and settings from the
`rg_travel` MySQL database via tRPC, seeded for local development by
`pnpm --filter @rg/server db:seed` from `server/src/db/seed-data.ts`.

- `settings.content_unverified` (exposed to the client as `contentUnverified`) drives the
  on-site amber banner (`PlaceholderBadge.tsx`), gates production builds, **and keeps the
  whole site out of every search index**. An admin clears it once real content replaces the
  seed; clearing it is the act that publishes the site to search engines.
- Permit numbers (DOT/DTI/BIR) remain `null` in the seed and render as an explicit
  "— pending —" state (`lib/site.ts`). **Never invent an accreditation number.**
- Seeded reviews are flagged `is_sample` in the database. Published samples block a
  production build, and never contribute to a rating a crawler can see.
- **The production build guard** is `client/scripts/check-placeholders.mjs`. It asks the
  database (through a small server-side probe, so the client package grows no mysql2) and
  exits non-zero while a published `is_sample` review exists or `content_unverified` is set.
  `ALLOW_PLACEHOLDER_BUILD=1` is the deliberate override for local builds and client demos —
  never for a launch build. It fails closed: an unreachable database blocks the build.
- **Content tokens:** admin-editable content may embed `{{tokenName}}` placeholders, which the
  rendering component substitutes with live data — currently only `{{paymentMethods}}` in the
  payment FAQ answer, replaced with the enabled payment methods. Tokens are allowed **only** in
  settings-stored copy, never in component source, and an answer with no token renders verbatim.
  Adding a **second** token requires extracting a shared substitution helper first, rather than
  repeating the per-component match.
- Placeholder imagery still lives in `client/public/placeholders/`, generated by
  `client/scripts/generate-placeholders.mjs` — brand-gradient SVGs labelled PLACEHOLDER.

## SEO & indexing (current state)

- **Per-route head content is injected server-side**, from the database, for `/`, `/tours`,
  `/privacy`, `/terms`, `/tours/:slug` and `/packages/:slug`: title, description, canonical,
  Open Graph, Twitter, JSON-LD, and the home page's hero preload.
- **Two surfaces, one implementation.** `server/src/seo/resolvers.ts` (`resolvePage`) decides,
  `server/src/seo/render.ts` (`injectMeta`) renders; production serves it from
  `server/src/html.ts` and dev from the `rg-seo-dev` middleware in `client/vite.config.ts`.
  Never build meta in a surface — if a title is wrong it is wrong in the resolver, for both.
  `injectMeta` is the single escaping boundary; resolvers return plain text, never markup.
- The dev middleware only acts on requests sending `Accept: text/html`. A bare `curl` sends
  `*/*`, falls through to the static shell and shows no injected meta — verify with
  `curl -H "Accept: text/html"` or you will be misled.
- **JSON-LD ships on every public route**: `TravelAgency` everywhere, `FAQPage` on `/`,
  `TouristTrip` on the two detail routes.
- **`aggregateRating` comes only from real reviews** (`status='published' AND is_sample=0`,
  via `realAggregate()`) and the key is **omitted entirely** when there are none — never a
  zero, never `settings.trust.ratingAverage`. With the current seed, no rating is emitted
  anywhere.
- `/sitemap.xml` and `/robots.txt` are generated from the database per request. A sitemap must
  never list a URL that says `noindex`, and `lastmod` is read from `updated_at`, never
  invented.
- **Two independent noindex gates, both fail closed.** While `settings.content_unverified` is
  true, `robots.txt` says `Disallow: /` and every route is served `noindex,nofollow`. And
  `SITE_ENV` must be `production` in the deployed `.env` or `robots.txt` fails closed the same
  way — it defaults to `development`. `/admin`, `/driver` and `/portal` additionally get an
  `X-Robots-Tag`.
- `client/index.html` is the **shared** SPA shell. Anything route-specific belongs in the
  injector, not in it — a hero preload there is served on `/privacy` too (task 4.4b). Its
  `viewport-fit=cover` meta must stay: without it the mobile bottom bar's safe-area padding is
  inert (BUG-079).

## Security

- HTTPS only; HSTS; secure, httpOnly, sameSite=lax cookies.
- Malformed request URLs (e.g. `/trpc/%zz`) return a plain 400, never a 500 with a stack
  trace (`server/src/middleware/malformed-url.ts`).
- CSRF protection on state-changing requests (sameSite + origin check).
- Rate limits on logins, coupon checks, review submissions, inquiry forms, helpful votes.
- Uploads: validate MIME + extension + size, rename to random IDs, store outside the web
  root, serve via an authenticated route.
- PayMongo secret key and webhook secret only in `.env`, never in client code.
- Role middleware on every admin procedure, plus a test per role per area.
- Data Privacy Act (RA 10173): consent checkbox at checkout, privacy notice page,
  admin-only access to personal data.

## Unrelated bugs

Found a bug outside the current task? Do not stop and do not fix it. Finish the task,
then list it (name + one-line description) and wait for instructions.
Exception: flag immediately if it blocks the current task.

## When in doubt — stop and ask

Stop and ask before changing anything if a task touches payments, refunds, auth, roles, or
the schema in a way the spec does not describe; if the spec is ambiguous; if a fix would
change a feature that already works; or if you would need a new dependency or service.
