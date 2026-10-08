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

Package manager is **pnpm**. Do not introduce npm or yarn lockfiles.

## Layout

```
/client   React + TS + Vite + Tailwind v4 + shadcn/ui
  src/pages/public | portal | driver | admin
  src/components | src/lib
/server   Express + tRPC
  src/routers | services | jobs | webhooks | db
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
- **Mobile-first.** Must work at 360px; most guests book on a phone.
- **Accessibility:** 44px minimum tap targets, visible focus states, alt text on every
  image, AA contrast.
- **Gold contrast:** `brand-gold-600` (`#b8860b`) fails AA (4.5:1) for normal-size text on
  white and on `brand-blue-50` — measured 3.25:1 and 3.00:1. Small gold text (eyebrows,
  labels, captions) must use `brand-gold-700` or darker. `brand-gold-600` remains fine for
  non-text uses (icons, badges, large decorative elements).
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

## Placeholder data (current state)

The public site renders from `client/src/lib/placeholder-data.ts` while real content is
pending (spec task 8D). Rules:

- Everything placeholder lives in that one module so it can be deleted in one commit.
- `PLACEHOLDER_SETTINGS` holds the trust-line values. The rating (4.9) and guests-served
  (15,000+) figures are **client-supplied, not invented** — they carry a
  `TODO: client to verify` marker in code and are rendered without a "(placeholder)" suffix.
- Permit numbers (DOT/DTI/BIR) live in `lib/site.ts` and render as an explicit pending
  state. **Never invent an accreditation number.**
- A dev-only amber banner (`import.meta.env.DEV`) marks the page as placeholder-backed.
- Placeholder imagery is generated into `client/public/placeholders/` by
  `client/scripts/generate-placeholders.mjs` — brand-gradient SVGs labelled PLACEHOLDER.
- Replace placeholders with real settings/DB values; never present them as real stats.

## Security

- HTTPS only; HSTS; secure, httpOnly, sameSite=lax cookies.
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
