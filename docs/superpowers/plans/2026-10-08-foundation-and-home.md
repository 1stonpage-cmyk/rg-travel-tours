# Foundation & Public Home Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the R&G Travel & Tours monorepo (client/server/shared) and ship the public layout + home page sections 1–13 on clearly-marked placeholder data, with no payments, auth, admin, or database logic.

**Architecture:** pnpm workspace with three packages. `/client` is Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui on port 5180 (`strictPort`), proxying `/trpc` and `/api` to `/server` on port 3100. `/server` is a bare Express + tRPC skeleton exposing only a `health` procedure — no schema, no migrations, no auth. `/shared` holds constants consumed by both. The home page renders from a single `placeholder-data.ts` module so tasks 2C/2D can delete it in one commit.

**Tech Stack:** pnpm workspaces, TypeScript 5, Vite 7, React 19, React Router 7, Tailwind CSS v4 (CSS-first `@theme`), shadcn/ui (Radix + CVA), Express 5, tRPC 11, Drizzle ORM (config only), Zod, Vitest + Testing Library + Supertest, ESLint 9 flat config, Prettier.

**Spec:** `docs/BUILD_SPEC.md` — sections 0, 2, 3, 4 (home sections 1–13), 13 (tasks 1A, 1E, 2A, 2B).

**Scope:** Spec tasks **1A**, **1E**, **2A**, **2B** only.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Ports (hard constraint — Kong PMS shares this machine)

- **NEVER use port 5173 or port 3000.** Both belong to Kong PMS.
- Client (Vite): **5180**, with `strictPort: true` so a conflict fails loudly instead of drifting to another port.
- Server (Express): **3100**.
- Vite proxies `/trpc` **and** `/api` → `http://localhost:3100`.
- Ports live in `.env` and `.env.example` as `CLIENT_PORT=5180` and `PORT=3100`.
- Local MySQL database name is **`rg_travel`** (separate from Kong's DB). Recorded in `.env.example` now; first used in task 1B.

### Brand

- Colours: **blue primary, gold accent**.
- **NO RED ANYWHERE** — including errors, badges, and destructive buttons. Warnings use amber/orange; errors use dark blue/grey (`#334155`). shadcn's `--destructive` token MUST be remapped away from red. Enforced by an automated guard test (Task 4).
- Mobile-first. Must work at **360px**.
- Accessibility: 44px minimum tap targets, visible focus states, alt text on every image, AA contrast.

### Data honesty (spec section 0)

- **DO NOT fake social proof.** Ratings, "booked X times", and guest counts must come from real data or admin-entered settings.
- For this scope all such values come from `PLACEHOLDER_SETTINGS` in one module, surfaced by a **dev-only amber banner** (`import.meta.env.DEV`) plus an optional production build guard (Task 6, Step 7 — skippable).

### Money & time conventions (recorded now, used from 1B on)

- Money: integers in **centavos** everywhere (DB, API, logic). Format only at display.
- Time: store **UTC**; display and compute business dates in **Asia/Manila**.
- Public booking refs: random, non-sequential (e.g. `RG-7KQ4M9`).

### Hard boundaries for this plan

- **DO NOT** touch payments, auth, admin, or database logic.
- **DO NOT** create a Drizzle schema, tables, or migrations (that is task 1B).
- **DO NOT** deploy (separate prompt).
- **DO NOT** add a library not listed in the Dependencies table below without asking.

### Skill usage required during execution

- Invoke **`ui-ux-pro-max`** before writing any UI (Tasks 5, 7, 8).
- Motion is deferred. `emilkowalski-motion` is **not installed in this environment** — see Open Items. Tasks 5/7/8 use only CSS transitions already available via Tailwind.

### Dependencies (approve before execution)

| Package                                                                                                                                      | Where         | In spec?                  | Why                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom`                                                                                                                         | client        | yes (§2)                  | Frontend                                                                                                  |
| `react-router-dom`                                                                                                                           | client        | yes (§2)                  | Routing                                                                                                   |
| `vite`, `@vitejs/plugin-react`                                                                                                               | client        | yes (§2)                  | Build                                                                                                     |
| `tailwindcss@4`, `@tailwindcss/vite`                                                                                                         | client        | yes (§2)                  | Styling                                                                                                   |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react`                                                       | client        | implied by shadcn/ui (§2) | shadcn/ui required peers                                                                                  |
| `@radix-ui/react-slot`, `-accordion`, `-select`, `-label`                                                                                    | client        | implied by shadcn/ui (§2) | Only the 4 primitives this page needs                                                                     |
| `@trpc/client`, `@trpc/server`                                                                                                               | client/server | yes (§2)                  | API                                                                                                       |
| `express`, `cors`                                                                                                                            | server        | yes (§2)                  | API                                                                                                       |
| `drizzle-orm`, `mysql2`, `drizzle-kit`                                                                                                       | server        | yes (§2)                  | ORM — **config only** this plan                                                                           |
| `zod`                                                                                                                                        | shared/server | yes (§2)                  | Validation                                                                                                |
| `dotenv`, `tsx`, `typescript`                                                                                                                | all           | implied                   | Runtime/tooling                                                                                           |
| `eslint`, `typescript-eslint`, `@eslint/js`, `globals`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `eslint-config-prettier` | root          | yes (§13 1A)              | ESLint                                                                                                    |
| `prettier`, `prettier-plugin-tailwindcss`                                                                                                    | root          | yes (§13 1A)              | Prettier                                                                                                  |
| **`vitest`**                                                                                                                                 | client/server | **not named**             | Test runner. Spec requires unit tests (1D, 3A, 3B); Vitest is the Vite-native choice. **Needs approval.** |
| **`@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`**                                            | client        | **not named**             | Component tests for the home page + no-red guard. **Needs approval.**                                     |
| **`supertest`, `@types/supertest`**                                                                                                          | server        | **not named**             | HTTP test for the health route. **Needs approval.**                                                       |

Deliberately **not** added: `@tanstack/react-query` / `@trpc/react-query` (vanilla tRPC client is enough here), `react-day-picker` + `date-fns` (hero uses a native `<input type="date">`; the real blocked-date picker is task 2D), `concurrently` (use `pnpm -r --parallel run dev`), `sonner` (no toasts needed).

---

## File Structure

```
/                              root workspace
  pnpm-workspace.yaml          packages: client, server, shared
  package.json                 scripts: dev, build, lint, format, test, typecheck
  tsconfig.base.json           shared compiler options
  eslint.config.js             ESLint 9 flat config for all packages
  .prettierrc.json             + prettier-plugin-tailwindcss
  .prettierignore
  .gitignore                   ignores .env, node_modules, dist, uploads
  .env.example                 committed template (ports, rg_travel, placeholders)
  .env                         local, gitignored
  .nvmrc                       pins Node 24
  CLAUDE.md                    standing conventions (task 1E)

/shared
  package.json                 name @rg/shared
  tsconfig.json
  src/index.ts                 barrel re-export
  src/constants.ts             DEPOSIT_PERCENT, HOLD_MINUTES, TIMEZONE, CURRENCY, BOOKING_REF_PREFIX

/server
  package.json                 name @rg/server
  tsconfig.json
  drizzle.config.ts            reads DATABASE_URL -> rg_travel. NO schema this plan.
  vitest.config.ts
  src/env.ts                   dotenv load + validate PORT, reject Kong ports
  src/trpc.ts                  initTRPC, router, publicProcedure
  src/routers/_app.ts          appRouter { health }
  src/app.ts                   Express app factory (exported for tests)
  src/index.ts                 listen on PORT 3100
  src/__tests__/health.test.ts supertest: GET /api/health, tRPC health

/client
  package.json                 name @rg/client
  tsconfig.json
  vite.config.ts               port 5180 strictPort, proxy /trpc + /api -> 3100
  vitest.config.ts             jsdom environment
  index.html
  components.json              shadcn/ui config
  public/favicon.svg
  public/placeholders/*.svg    generated blue/gold PLACEHOLDER tiles
  src/main.tsx                 React root + BrowserRouter
  src/App.tsx                  route table
  src/index.css                Tailwind v4 @theme brand tokens + shadcn semantic tokens
  src/vite-env.d.ts
  src/setupTests.ts            jest-dom matchers
  src/lib/utils.ts             cn()
  src/lib/trpc.ts              typed vanilla tRPC client
  src/lib/placeholder-data.ts  ALL placeholder tours/places/packages/reviews/FAQ/settings
  src/lib/site.ts              nav items, contact details, permits, payment methods
  src/components/ui/*.tsx      shadcn primitives: button, card, input, label, select,
                               accordion, badge
  src/components/layout/
    SiteHeader.tsx             logo, desktop nav, mobile disclosure nav, CTA
    SiteFooter.tsx             DOT/DTI/BIR permits, payment method chips, links
    FloatingWhatsApp.tsx       fixed bottom-right, 44px+, aria-label
    PublicLayout.tsx           header + <Outlet/> + footer + WhatsApp + dev badge
    PlaceholderBadge.tsx       dev-only amber "PLACEHOLDER DATA" banner
  src/components/home/
    HeroSection.tsx            §1 search (destination/date/guests) + trust line
    TrustBar.tsx               §2
    CatalogPreview.tsx         §3 tour cards + destination filter
    HowItWorks.tsx             §4
    WhyBookDirect.tsx          §5 six reasons
    MostVisited.tsx            §6 six places
    PackagesSection.tsx        §7 three packages, old vs new price, inquiry form
    ReviewsSection.tsx         §8
    PromoNewsletter.tsx        §9 promo band + newsletter, reveals RGTOURS10
    FaqSection.tsx             §10 seven Q&A accordion
    ContactSection.tsx         §11 channels + inquiry form
  src/components/common/
    SectionHeading.tsx         shared eyebrow/title/subtitle
    TourCard.tsx               reused by CatalogPreview (and later 2C)
    StarRating.tsx             accessible star display
  src/pages/public/HomePage.tsx        composes sections 1-11 in order
  src/pages/public/ToursStubPage.tsx   stub target for hero search; replaced in 2C
  src/__tests__/no-red.test.ts         guard: no red anywhere in source
  src/__tests__/layout.test.tsx        header/footer/WhatsApp/skip link
  src/__tests__/placeholder-data.test.ts  counts + centavos convention
  src/__tests__/home.test.tsx          all sections present, promo reveal
  scripts/generate-placeholders.mjs    writes public/placeholders/*.svg
  scripts/check-placeholders.mjs       optional prod build guard (Task 6 Step 7)
```

---

## Task 1: Workspace, tooling, and environment

Establishes the pnpm workspace, shared TypeScript config, lint/format, and the port + database constraints in env files. Nothing renders yet; the deliverable is a workspace that typechecks and lints clean.

**Files:**

- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.env.example`, `.env`, `.nvmrc`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`, `shared/src/constants.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: workspace package names `@rg/shared`, `@rg/server`, `@rg/client`. Root scripts `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`. `@rg/shared` exports `DEPOSIT_PERCENT: number`, `HOLD_MINUTES: number`, `TIMEZONE: string`, `CURRENCY: string`, `BOOKING_REF_PREFIX: string`.

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:

```yaml
packages:
  - client
  - server
  - shared
```

- [ ] **Step 2: Create the root package.json**

Note `--parallel` on `dev` so client and server boot together without a `concurrently` dependency.

```json
{
  "name": "rg-travel-tours",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.37.0",
    "eslint": "^9.37.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-react-hooks": "^6.1.1",
    "eslint-plugin-react-refresh": "^0.4.24",
    "globals": "^16.4.0",
    "prettier": "^3.6.2",
    "prettier-plugin-tailwindcss": "^0.6.14",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.46.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Create .gitignore**

```gitignore
node_modules/
dist/
build/
.env
.env.local
.env.*.local
uploads/
*.log
.DS_Store
coverage/
.vite/
*.tsbuildinfo
```

- [ ] **Step 5: Create .env.example**

Every value is a placeholder. Ports and DB name are the real constraints.

```dotenv
# ---------------------------------------------------------------------------
# R&G Travel & Tours - environment template. Copy to .env and fill in.
# PORTS: Kong PMS also runs on this machine. NEVER use 5173 or 3000.
# ---------------------------------------------------------------------------

NODE_ENV=development

# Server (Express + tRPC)
PORT=3100

# Client (Vite dev server) - strictPort is enabled, so this must be free
CLIENT_PORT=5180

# Public base URL of the site
PUBLIC_BASE_URL=http://localhost:5180

# ---------------------------------------------------------------------------
# Database - MySQL 8. Database name MUST be rg_travel (separate from Kong's DB).
# Schema and migrations land in task 1B; nothing connects yet.
# ---------------------------------------------------------------------------
DATABASE_URL=mysql://root:CHANGE_ME@localhost:3306/rg_travel
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=CHANGE_ME
DB_NAME=rg_travel

# ---------------------------------------------------------------------------
# Sessions (task 1C - unused for now)
# ---------------------------------------------------------------------------
SESSION_SECRET=CHANGE_ME_32_CHARS_MINIMUM

# ---------------------------------------------------------------------------
# PayMongo (task 3E - unused for now). NEVER expose these to the client.
# ---------------------------------------------------------------------------
PAYMONGO_SECRET_KEY=
PAYMONGO_PUBLIC_KEY=
PAYMONGO_WEBHOOK_SECRET=

# ---------------------------------------------------------------------------
# Email / SMTP (task 7E - unused for now)
# ---------------------------------------------------------------------------
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM="R&G Travel & Tours <noreply@randgtraveltours.com>"

# ---------------------------------------------------------------------------
# SMS - off by default (task 7E)
# ---------------------------------------------------------------------------
SMS_ENABLED=false
SMS_PROVIDER=
SMS_API_KEY=

# ---------------------------------------------------------------------------
# Uploads - resolved OUTSIDE the web root
# ---------------------------------------------------------------------------
UPLOADS_DIR=./uploads

# ---------------------------------------------------------------------------
# Public contact details - PLACEHOLDERS until the client supplies real ones (8D)
# ---------------------------------------------------------------------------
VITE_WHATSAPP_NUMBER=639000000000
VITE_CONTACT_PHONE=+63 900 000 0000
VITE_CONTACT_EMAIL=hello@randgtraveltours.com
VITE_FACEBOOK_URL=https://facebook.com/
```

- [ ] **Step 6: Create .env from the template**

```bash
cp .env.example .env
```

- [ ] **Step 7: Create .nvmrc**

```
24
```

- [ ] **Step 8: Create the shared package**

`shared/package.json`:

```json
{
  "name": "@rg/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "echo \"no tests in @rg/shared yet\"",
    "build": "echo \"@rg/shared is consumed as TypeScript source\""
  },
  "dependencies": { "zod": "^4.1.12" },
  "devDependencies": { "typescript": "^5.9.3" }
}
```

`shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

`shared/src/constants.ts`:

```ts
/**
 * Project-wide constants shared by client and server.
 *
 * Money is handled in integer CENTAVOS everywhere (DB, API, logic) and
 * formatted only at display time. Timestamps are stored in UTC; business
 * dates are computed and displayed in Asia/Manila.
 */

/** Deposit percentage offered at checkout. Overridable from `settings` later. */
export const DEPOSIT_PERCENT = 30;

/** Minutes a booking hold survives before the expiry cron releases capacity. */
export const HOLD_MINUTES = 15;

/** Business timezone for all date display and business-day calculations. */
export const TIMEZONE = 'Asia/Manila';

/** ISO currency code. Amounts are centavos of this currency. */
export const CURRENCY = 'PHP';

/** Prefix for public, non-sequential booking references, e.g. RG-7KQ4M9. */
export const BOOKING_REF_PREFIX = 'RG';
```

`shared/src/index.ts`:

```ts
export * from './constants';
```

- [ ] **Step 9: Create the ESLint flat config**

```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'demo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/*.mjs', '**/scripts/**'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
```

- [ ] **Step 10: Create Prettier config**

`.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "plugins": ["prettier-plugin-tailwindcss"],
  "tailwindStylesheet": "./client/src/index.css"
}
```

`.prettierignore`:

```
node_modules
dist
coverage
pnpm-lock.yaml
client/public/placeholders
demo
```

- [ ] **Step 11: Install and verify**

```bash
pnpm install
pnpm lint
pnpm typecheck
```

Expected: install succeeds; `lint` reports 0 errors; `typecheck` passes for `@rg/shared` (client/server not yet present — that is fine, they are added in Tasks 3–4).

- [ ] **Step 12: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json eslint.config.js .prettierrc.json .prettierignore .gitignore .env.example .nvmrc shared
git commit -m "chore: pnpm workspace, shared constants, lint/format, env template"
```

---

## Task 2: CLAUDE.md — standing conventions (spec task 1E)

Written before any UI so the conventions govern the rest of the work. Seeded from `docs/BUILD_SPEC.md` section 0 and extended with the port and placeholder rules from this session.

**Files:**

- Create: `CLAUDE.md`

**Interfaces:**

- Consumes: Task 1's script names and workspace layout.
- Produces: the standing convention document every later session reads first.

- [ ] **Step 1: Write CLAUDE.md with this exact content**

````markdown
# CLAUDE.md — R&G Travel & Tours

Standing conventions for every session on this repo. **Read this before implementing anything.**
Full requirements live in `docs/BUILD_SPEC.md` — that spec wins any disagreement with this file.

## Project

Online booking + operations system for R&G Travel & Tours, Cebu, Philippines.
Day tours and multi-day packages. Domain: randgtraveltours.com. 8-week build.

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
- **Motion:** subtle only (card hovers, tracker progress, check-in confirmation), and only
  after the layout exists.

## Workflow

- Use **Superpowers** (`writing-plans` + `subagent-driven-development`) per week of work.
  Write the plan, get approval, then execute.
- Use **ui-ux-pro-max** for all UI, layout, and design work.
- Use **emilkowalski-motion** for motion only, and only after layout exists.
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
- `PLACEHOLDER_SETTINGS` holds the trust-line values; permit numbers live in `lib/site.ts`
  and render as an explicit pending state rather than invented numbers.
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
````

- [ ] **Step 2: Verify formatting**

```bash
pnpm format CLAUDE.md
```

Expected: Prettier rewrites it cleanly with no errors.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md standing conventions"
```

**→ After this task, write `✅ DONE` for 1E.**

---

## Task 3: Server skeleton on port 3100 (spec task 1A, server half)

Express + tRPC with a single `health` procedure, plus a Drizzle **config file only**. No schema, no tables, no migrations, no auth. This exists so the Vite proxy has a live target and so 1A's type-safety wiring is proven end to end.

**Files:**

- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/drizzle.config.ts`, `server/src/env.ts`, `server/src/trpc.ts`, `server/src/routers/_app.ts`, `server/src/app.ts`, `server/src/index.ts`
- Test: `server/src/__tests__/health.test.ts`

**Interfaces:**

- Consumes: `@rg/shared` constants; `.env` `PORT` and `DATABASE_URL` from Task 1.
- Produces:
  - `createApp(): express.Express` from `server/src/app.ts`
  - `appRouter` and `export type AppRouter = typeof appRouter` from `server/src/routers/_app.ts` — the client imports this type in Task 4.
  - `health` tRPC query returning `{ ok: true; service: 'rg-travel-tours'; timezone: string }`
  - `GET /api/health` returning the same JSON.

- [ ] **Step 1: Create server/package.json**

```json
{
  "name": "@rg/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json --noEmit",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@rg/shared": "workspace:*",
    "@trpc/server": "^11.6.0",
    "cors": "^2.8.5",
    "dotenv": "^17.2.3",
    "drizzle-orm": "^0.44.6",
    "express": "^5.1.0",
    "mysql2": "^3.15.2",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "@types/cors": "^2.8.19",
    "@types/express": "^5.0.3",
    "@types/node": "^24.7.0",
    "@types/supertest": "^6.0.3",
    "drizzle-kit": "^0.31.6",
    "supertest": "^7.1.4",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create server/tsconfig.json and server/vitest.config.ts**

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["node"],
    "noEmit": true,
    "moduleResolution": "bundler"
  },
  "include": ["src", "drizzle.config.ts"]
}
```

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Create the env loader**

`server/src/env.ts` — fails fast and loudly if the port drifts onto a Kong PMS port.

```ts
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

config({ path: resolve(process.cwd(), '../.env') });

/** Ports owned by Kong PMS on this machine. Using them is a hard error. */
const FORBIDDEN_PORTS = [3000, 5173];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().optional(),
  UPLOADS_DIR: z.string().default('./uploads'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment:', z.treeifyError(parsed.error));
  throw new Error('Invalid environment configuration');
}

if (FORBIDDEN_PORTS.includes(parsed.data.PORT)) {
  throw new Error(
    `PORT ${parsed.data.PORT} belongs to Kong PMS. Use 3100 for this project (see CLAUDE.md).`,
  );
}

export const env = parsed.data;
```

- [ ] **Step 4: Create the tRPC base and app router**

`server/src/trpc.ts`:

```ts
import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const router = t.router;
export const publicProcedure = t.procedure;
```

`server/src/routers/_app.ts`:

```ts
import { TIMEZONE } from '@rg/shared';
import { publicProcedure, router } from '../trpc';

export const appRouter = router({
  /**
   * Liveness probe. Deliberately the only procedure for now — schema, auth, and
   * domain routers land in tasks 1B/1C onward.
   */
  health: publicProcedure.query(() => ({
    ok: true as const,
    service: 'rg-travel-tours' as const,
    timezone: TIMEZONE,
  })),
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Create the Express app factory**

`server/src/app.ts` — exported separately from `index.ts` so tests get an app without binding a port.

```ts
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cors from 'cors';
import express from 'express';
import { TIMEZONE } from '@rg/shared';
import { appRouter } from './routers/_app';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cors({ origin: true, credentials: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'rg-travel-tours', timezone: TIMEZONE });
  });

  app.use('/trpc', createExpressMiddleware({ router: appRouter }));

  return app;
}
```

`server/src/index.ts`:

```ts
import { createApp } from './app';
import { env } from './env';

createApp().listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});
```

- [ ] **Step 6: Create the Drizzle config (no schema yet)**

`server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle configuration only. The schema itself (spec section 10) and the first
 * migration are task 1B — `./src/db/schema.ts` does not exist yet, so
 * `db:generate` will correctly report that there is nothing to generate.
 *
 * The database MUST be named `rg_travel`, separate from Kong PMS's database.
 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://root@localhost:3306/rg_travel',
  },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 7: Write the failing test**

`server/src/__tests__/health.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

describe('server health', () => {
  const app = createApp();

  it('answers GET /api/health', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: 'rg-travel-tours',
      timezone: 'Asia/Manila',
    });
  });

  it('answers the tRPC health query', async () => {
    const res = await request(app).get('/trpc/health');

    expect(res.status).toBe(200);
    expect(res.body.result.data).toMatchObject({ ok: true, service: 'rg-travel-tours' });
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

```bash
pnpm --filter @rg/server test
```

Expected before install: FAIL — `Cannot find module '../app'` or missing dependencies.

- [ ] **Step 9: Install and run the test to verify it passes**

```bash
pnpm install
pnpm --filter @rg/server test
```

Expected: 2 tests PASS.

- [ ] **Step 10: Verify the server boots on 3100 and not on a Kong port**

```bash
pnpm --filter @rg/server dev
```

In a second shell:

```bash
curl -s http://localhost:3100/api/health
curl -s http://localhost:3100/trpc/health
```

Expected: `{"ok":true,"service":"rg-travel-tours","timezone":"Asia/Manila"}` and a tRPC-shaped
`{"result":{"data":{...}}}`. Then stop the dev server.

Also confirm the guard works — temporarily set `PORT=3000` in `.env`, run `pnpm --filter @rg/server dev`,
expect the thrown "belongs to Kong PMS" error, then restore `PORT=3100`.

- [ ] **Step 11: Typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both clean.

- [ ] **Step 12: Commit**

```bash
git add server pnpm-lock.yaml
git commit -m "feat(server): Express + tRPC skeleton on port 3100"
```

---

## Task 4: Client scaffold, brand tokens, and the no-red guard (spec task 1A, client half)

Vite + React + TypeScript on port 5180 with `strictPort`, Tailwind v4 brand tokens, shadcn/ui primitives, the proxy to 3100, a typed tRPC client, and an automated test that fails if red is ever introduced.

**Files:**

- Create: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/vitest.config.ts`, `client/index.html`, `client/components.json`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/index.css`, `client/src/vite-env.d.ts`, `client/src/setupTests.ts`, `client/src/lib/utils.ts`, `client/src/lib/trpc.ts`, `client/src/components/ui/*.tsx`
- Test: `client/src/__tests__/no-red.test.ts`

**Interfaces:**

- Consumes: `AppRouter` type from `server/src/routers/_app.ts` (Task 3); `@rg/shared` constants.
- Produces:
  - `cn(...inputs: ClassValue[]): string` from `client/src/lib/utils.ts`
  - `trpc` vanilla client from `client/src/lib/trpc.ts`
  - shadcn primitives: `Button`, `Card`/`CardContent` (+ header/title/description/footer), `Input`, `Label`, `Select` (+ `SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`), `Accordion` (+ `AccordionItem`/`AccordionTrigger`/`AccordionContent`), `Badge`
  - Tailwind theme tokens: `brand-blue-{50..950}`, `brand-gold-{50..900}`, `brand-ink`, `brand-warning`, `brand-error`, plus shadcn semantic tokens.

- [ ] **Step 1: Create client/package.json**

```json
{
  "name": "@rg/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 5180 --strictPort",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "placeholders": "node scripts/generate-placeholders.mjs"
  },
  "dependencies": {
    "@radix-ui/react-accordion": "^1.2.12",
    "@radix-ui/react-label": "^2.1.8",
    "@radix-ui/react-select": "^2.2.6",
    "@radix-ui/react-slot": "^1.2.3",
    "@rg/shared": "workspace:*",
    "@trpc/client": "^11.6.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.545.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^7.9.3",
    "tailwind-merge": "^3.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.14",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^24.7.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.0.4",
    "jsdom": "^27.0.0",
    "tailwindcss": "^4.1.14",
    "tw-animate-css": "^1.4.0",
    "typescript": "^5.9.3",
    "vite": "^7.1.9",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create the Vite config with the pinned port and proxy**

`client/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Env lives at the repo root, one level above /client.
  const env = loadEnv(mode, resolve(here, '..'), '');

  const clientPort = Number(env.CLIENT_PORT ?? 5180);
  const serverPort = Number(env.PORT ?? 3100);

  // Kong PMS owns 5173 and 3000 on this machine.
  for (const [label, port] of [
    ['CLIENT_PORT', clientPort],
    ['PORT', serverPort],
  ] as const) {
    if (port === 5173 || port === 3000) {
      throw new Error(`${label}=${port} belongs to Kong PMS. See CLAUDE.md for the port map.`);
    }
  }

  const apiTarget = `http://localhost:${serverPort}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(here, 'src'),
        '@rg/shared': resolve(here, '../shared/src'),
      },
    },
    server: {
      port: clientPort,
      strictPort: true,
      proxy: {
        '/trpc': { target: apiTarget, changeOrigin: true },
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { port: clientPort, strictPort: true },
  };
});
```

- [ ] **Step 3: Create the TypeScript and Vitest configs**

`client/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vite/client", "node", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@rg/shared": ["../shared/src/index.ts"]
    }
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`client/vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      '@rg/shared': resolve(here, '../shared/src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`client/src/setupTests.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

`client/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 4: Create index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>R&amp;G Travel &amp; Tours — Cebu Day Tours &amp; Packages</title>
    <meta
      name="description"
      content="Book Cebu day tours and multi-day packages direct with R&amp;G Travel &amp; Tours. Private vans, licensed drivers, pay a 30% deposit online."
    />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

(Per-route meta injection from the DB is task 2E; this static head is a placeholder baseline.)

- [ ] **Step 5: Create the brand token stylesheet**

`client/src/index.css` — the single source of truth for brand colour. **No red token is defined anywhere**, and shadcn's `--destructive` is deliberately mapped to dark blue/grey.

```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:is(.dark *));

/* ---------------------------------------------------------------------------
   R&G brand palette: blue primary, gold accent.
   HARD RULE: no red anywhere. Warnings use amber; errors use dark blue/grey.
   Enforced by client/src/__tests__/no-red.test.ts
   --------------------------------------------------------------------------- */
@theme {
  --color-brand-blue-50: #f0f6ff;
  --color-brand-blue-100: #dbeafe;
  --color-brand-blue-200: #bfdbfe;
  --color-brand-blue-300: #93c5fd;
  --color-brand-blue-400: #60a5fa;
  --color-brand-blue-500: #3b82f6;
  --color-brand-blue-600: #1d4ed8;
  --color-brand-blue-700: #1e40af;
  --color-brand-blue-800: #1e3a8a;
  --color-brand-blue-900: #172554;
  --color-brand-blue-950: #0f172e;

  --color-brand-gold-50: #fffbeb;
  --color-brand-gold-100: #fef3c7;
  --color-brand-gold-200: #fde68a;
  --color-brand-gold-300: #fcd34d;
  --color-brand-gold-400: #fbbf24;
  --color-brand-gold-500: #d4a017;
  --color-brand-gold-600: #b8860b;
  --color-brand-gold-700: #92610a;
  --color-brand-gold-800: #6b4708;
  --color-brand-gold-900: #4a3106;

  /* Deep navy body text */
  --color-brand-ink: #0f172e;
  /* Warnings: amber/orange, never red */
  --color-brand-warning: #b45309;
  /* Errors: dark blue/grey, never red */
  --color-brand-error: #334155;

  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  --radius-card: 1rem;
}

/* shadcn/ui semantic tokens, mapped onto the brand palette. */
:root {
  --radius: 0.75rem;

  --background: #ffffff;
  --foreground: #0f172e;

  --card: #ffffff;
  --card-foreground: #0f172e;

  --popover: #ffffff;
  --popover-foreground: #0f172e;

  --primary: #1d4ed8;
  --primary-foreground: #ffffff;

  --secondary: #f0f6ff;
  --secondary-foreground: #1e3a8a;

  --muted: #f1f5f9;
  --muted-foreground: #475569;

  --accent: #d4a017;
  --accent-foreground: #0f172e;

  /* NOT red. Dark blue/grey per the brand rule. */
  --destructive: #334155;
  --destructive-foreground: #ffffff;

  --border: #e2e8f0;
  --input: #cbd5e1;
  --ring: #1d4ed8;
}

.dark {
  --background: #0f172e;
  --foreground: #f1f5f9;

  --card: #172554;
  --card-foreground: #f1f5f9;

  --popover: #172554;
  --popover-foreground: #f1f5f9;

  --primary: #60a5fa;
  --primary-foreground: #0f172e;

  --secondary: #1e3a8a;
  --secondary-foreground: #f1f5f9;

  --muted: #1e293b;
  --muted-foreground: #94a3b8;

  --accent: #fbbf24;
  --accent-foreground: #0f172e;

  --destructive: #94a3b8;
  --destructive-foreground: #0f172e;

  --border: #1e293b;
  --input: #334155;
  --ring: #60a5fa;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }

  html {
    scroll-behavior: smooth;
    -webkit-text-size-adjust: 100%;
  }

  body {
    @apply bg-background text-foreground font-sans antialiased;
  }

  /* Accessibility: always-visible focus ring (spec section 3). */
  :focus-visible {
    @apply ring-ring ring-offset-background outline-none ring-2 ring-offset-2;
  }
}

@layer utilities {
  /* 44px minimum tap target (spec section 3). */
  .tap-target {
    @apply min-h-11 min-w-11;
  }
}
```

- [ ] **Step 6: Create cn() and the shadcn config**

`client/src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

`client/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 7: Add the shadcn primitives**

```bash
cd client
pnpm dlx shadcn@latest add button card input label select accordion badge --yes
cd ..
```

Then **audit every generated file** and replace any red with brand tokens:

- `badge.tsx` and `button.tsx` ship a `destructive` variant using `bg-destructive` — that token is
  already remapped to `#334155`, so keep the variant but confirm no literal `red`/`rose` class
  survives.
- If the CLI rewrites `src/index.css`, restore the `@theme` block from Step 5. The brand palette wins.

If `pnpm dlx shadcn` cannot run offline, hand-write the seven components from the shadcn/ui
docs using `cn()` and CVA — same public API as listed in **Interfaces**.

- [ ] **Step 8: Create the typed tRPC client**

`client/src/lib/trpc.ts`:

```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../../server/src/routers/_app';

/**
 * Vanilla tRPC client. Requests go to the Vite dev-server proxy at /trpc, which
 * forwards to the Express server on port 3100 (see vite.config.ts).
 */
export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
});
```

- [ ] **Step 9: Create the React entry point and route table**

`client/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`client/src/App.tsx` — placeholder routes until Task 5 adds `PublicLayout`:

```tsx
import { Route, Routes } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<p className="p-8">Home page lands in task 2B.</p>} />
    </Routes>
  );
}
```

- [ ] **Step 10: Write the failing no-red guard test**

`client/src/__tests__/no-red.test.ts` — the automated enforcement of the brand rule and of the spec's "No red anywhere" test-checklist item.

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scanRoots = [join(clientRoot, 'src'), join(clientRoot, 'index.html')];
const scanExtensions = new Set(['.ts', '.tsx', '.css', '.html', '.svg']);

/** This test file names the forbidden patterns, so it must exempt itself. */
const exempt = ['src/__tests__/no-red.test.ts'];

/**
 * Patterns that would introduce red. Covers Tailwind utility families, CSS
 * named colours, and the hue range of hex/rgb reds we would plausibly type.
 */
const forbidden: { label: string; re: RegExp }[] = [
  {
    label: 'tailwind red/rose utility',
    re: /\b(?:bg|text|border|ring|from|via|to|outline|decoration|shadow|fill|stroke|accent|caret|divide|placeholder)-(?:red|rose)-\d{2,3}\b/,
  },
  {
    label: 'css named red',
    re: /\b(?:crimson|firebrick|indianred|darkred|orangered|tomato|maroon)\b/i,
  },
  { label: 'bare css color: red', re: /(?:^|[\s:;("'])red(?:$|[\s;,)"'])/i },
  { label: 'hex red #f00 family', re: /#(?:f00|e00|d00|c00|b00)\b/i },
  {
    label: 'hex red #ff0000 family',
    re: /#(?:ff|ee|dd|cc|bb|aa)(?:0\d|1\d|2\d)(?:0\d|1\d|2\d)\b/i,
  },
  {
    label: 'rgb red',
    re: /rgba?\(\s*(?:1[89]\d|2[0-5]\d)\s*,\s*(?:[0-4]\d?)\s*,\s*(?:[0-4]\d?)\s*[,)]/i,
  },
];

function collectFiles(target: string): string[] {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return scanExtensions.has(extname(target)) ? [target] : [];

  return readdirSync(target).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    return collectFiles(join(target, entry));
  });
}

describe('brand rule: no red anywhere', () => {
  const files = scanRoots.flatMap(collectFiles);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no red colour values or utilities', () => {
    const offences: string[] = [];

    for (const file of files) {
      const rel = relative(clientRoot, file).replace(/\\/g, '/');
      if (exempt.includes(rel)) continue;

      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { label, re } of forbidden) {
          if (re.test(line)) {
            offences.push(`${rel}:${index + 1} [${label}] ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }

    expect(
      offences,
      `Red is forbidden brand-wide (see CLAUDE.md):\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 11: Run the test to verify it fails, then passes**

```bash
pnpm install
pnpm --filter @rg/client test
```

Expected: FAIL first if any shadcn-generated file still carries a literal red class. Fix each
offence by swapping to a brand token, then re-run.

Expected after fixes: both tests PASS.

- [ ] **Step 12: Verify the dev server, the pinned port, and the proxy**

```bash
pnpm dev
```

Then:

```bash
curl -s http://localhost:5180/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5180/
```

Expected: the health JSON proxied through 5180 (proving 5180 → 3100 works), and `200` for the page.
Confirm the terminal says `localhost:5180` and **never** 5173.

Also verify `strictPort`: with `pnpm dev` already running, start a second
`pnpm --filter @rg/client dev` and expect it to **fail** with a port-in-use error rather than
silently picking 5181.

- [ ] **Step 13: Build, typecheck, lint**

```bash
pnpm --filter @rg/client build
pnpm typecheck
pnpm lint
```

Expected: all clean.

- [ ] **Step 14: Commit**

```bash
git add client pnpm-lock.yaml
git commit -m "feat(client): Vite + React + Tailwind v4 + shadcn on port 5180"
```

**→ After this task, write `✅ DONE` for 1A.**

---

## Task 5: Public layout — header, footer, floating WhatsApp (spec task 2A)

Header with responsive nav, footer carrying DOT/DTI/BIR permit placeholders and payment-method chips, and a floating WhatsApp button on every public page.

**REQUIRED: invoke `ui-ux-pro-max` before writing these components.**

**Files:**

- Create: `client/src/lib/site.ts`, `client/src/components/layout/SiteHeader.tsx`, `SiteFooter.tsx`, `FloatingWhatsApp.tsx`, `PublicLayout.tsx`, `PlaceholderBadge.tsx`, `client/src/components/common/SectionHeading.tsx`, `client/src/pages/public/ToursStubPage.tsx`
- Modify: `client/src/App.tsx`
- Test: `client/src/__tests__/layout.test.tsx`

**Interfaces:**

- Consumes: shadcn `Button`; `cn()`.
- Produces:
  - `PublicLayout` — wraps `<Outlet/>` with header, footer, WhatsApp button, dev placeholder badge
  - `SITE` from `site.ts`: `{ name, tagline, nav: {label, href}[], contact: {phone, whatsapp, email, facebook, address, hours}, permits: {dot, dti, bir}, paymentMethods }`
  - `whatsappLink(message?: string): string`
  - `SectionHeading` — props `{ eyebrow?: string; title: string; subtitle?: string; align?: 'left' | 'center'; className?: string }`

- [ ] **Step 1: Write the failing layout test**

`client/src/__tests__/layout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PublicLayout from '@/components/layout/PublicLayout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <PublicLayout />
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  it('renders a banner, a contentinfo footer, and a main region', () => {
    renderLayout();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('shows DOT, DTI, and BIR permit lines in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(/DOT/);
    expect(footer).toHaveTextContent(/DTI/);
    expect(footer).toHaveTextContent(/BIR/);
  });

  it('lists accepted payment methods in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    for (const method of ['GCash', 'Maya', 'GrabPay', 'QR Ph']) {
      expect(footer).toHaveTextContent(method);
    }
  });

  it('renders a floating WhatsApp link with an accessible name', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: /whatsapp/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('wa.me'));
  });

  it('exposes a skip link to the main content', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /skip to (main )?content/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rg/client test layout
```

Expected: FAIL — `Cannot find module '@/components/layout/PublicLayout'`.

- [ ] **Step 3: Create the site configuration**

`client/src/lib/site.ts` — every contact value is a placeholder until task 8D, and permit numbers are **not invented**.

```ts
/**
 * Static site configuration. Contact numbers, addresses, and permit numbers are
 * PLACEHOLDERS until the client supplies real values (spec task 8D). Permit
 * numbers must never be invented — they render as an explicit pending state.
 */

const env = import.meta.env;

export const SITE = {
  name: 'R&G Travel & Tours',
  tagline: 'Cebu day tours and multi-day packages, booked direct.',
  nav: [
    { label: 'Tours', href: '/tours' },
    { label: 'Packages', href: '/#packages' },
    { label: 'Reviews', href: '/#reviews' },
    { label: 'FAQ', href: '/#faq' },
    { label: 'Contact', href: '/#contact' },
  ],
  contact: {
    phone: (env.VITE_CONTACT_PHONE as string) ?? '+63 900 000 0000',
    whatsapp: (env.VITE_WHATSAPP_NUMBER as string) ?? '639000000000',
    email: (env.VITE_CONTACT_EMAIL as string) ?? 'hello@randgtraveltours.com',
    facebook: (env.VITE_FACEBOOK_URL as string) ?? 'https://facebook.com/',
    address: 'Office address pending — Cebu, Philippines',
    hours: 'Mon–Sun, 7:00 AM – 9:00 PM (PHT)',
  },
  /**
   * Accreditation and registration numbers. Rendered as "pending" rather than
   * fabricated; real numbers arrive from Settings (spec section 9).
   */
  permits: {
    dot: { label: 'DOT Accreditation No.', value: null as string | null },
    dti: { label: 'DTI Registration No.', value: null as string | null },
    bir: { label: 'BIR TIN', value: null as string | null },
  },
  /** Text chips, not trademarked logo artwork. Real logos arrive in task 8D. */
  paymentMethods: ['GCash', 'Maya', 'GrabPay', 'QR Ph', 'Visa', 'Mastercard'],
} as const;

/** Builds a wa.me deep link with an optional prefilled message. */
export function whatsappLink(message?: string) {
  const base = `https://wa.me/${SITE.contact.whatsapp}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
```

- [ ] **Step 4: Create SectionHeading**

`client/src/components/common/SectionHeading.tsx`:

```tsx
import { cn } from '@/lib/utils';

type Props = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align?: 'left' | 'center';
  className?: string;
};

export default function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  className,
}: Props) {
  return (
    <div
      className={cn(
        'mx-auto max-w-2xl',
        align === 'center' ? 'text-center' : 'mx-0 text-left',
        className,
      )}
    >
      {eyebrow && (
        <p className="text-brand-gold-600 mb-2 text-sm font-semibold uppercase tracking-widest">
          {eyebrow}
        </p>
      )}
      <h2 className="text-brand-blue-900 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      {subtitle && <p className="text-muted-foreground mt-3 text-base">{subtitle}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Create SiteHeader**

Sticky, mobile-first. Mobile nav is a disclosure panel (no extra dependency). Every tap target is ≥44px.

```tsx
import { Menu, Phone, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SITE } from '@/lib/site';
import { cn } from '@/lib/utils';

export default function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="tap-target flex items-center gap-2 rounded-md"
          aria-label={`${SITE.name} — home`}
        >
          <span className="bg-brand-blue-600 flex size-9 items-center justify-center rounded-lg">
            <span className="text-brand-gold-300 text-sm font-bold">R&amp;G</span>
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-brand-blue-900 text-sm font-bold">Travel &amp; Tours</span>
            <span className="text-muted-foreground text-xs">Cebu, Philippines</span>
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {SITE.nav.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'hover:bg-brand-blue-50 hover:text-brand-blue-700',
                  isActive ? 'text-brand-blue-700' : 'text-brand-ink/80',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`}
            className="text-brand-blue-700 tap-target hidden items-center gap-2 rounded-md px-3 text-sm font-semibold lg:flex"
          >
            <Phone className="size-4" aria-hidden="true" />
            {SITE.contact.phone}
          </a>
          <Button asChild className="tap-target hidden sm:inline-flex">
            <Link to="/tours">Book a tour</Link>
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="tap-target md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t md:hidden">
          <ul className="mx-auto max-w-7xl px-4 py-2 sm:px-6">
            {SITE.nav.map((item) => (
              <li key={item.href}>
                <Link
                  to={item.href}
                  onClick={() => setOpen(false)}
                  className="text-brand-ink hover:bg-brand-blue-50 flex min-h-11 items-center rounded-md px-3 text-base font-medium"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li className="py-2">
              <Button asChild className="tap-target w-full">
                <Link to="/tours" onClick={() => setOpen(false)}>
                  Book a tour
                </Link>
              </Button>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
```

- [ ] **Step 6: Create SiteFooter**

Permits render as an explicit pending state rather than fabricated numbers. Payment methods are
text chips — no trademarked logo artwork, and none of the brand reds those logos contain.

```tsx
import { Clock, Facebook, Mail, MapPin, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SITE } from '@/lib/site';

const PERMITS = [SITE.permits.dot, SITE.permits.dti, SITE.permits.bir];

export default function SiteFooter() {
  return (
    <footer className="bg-brand-blue-950 text-brand-blue-100 mt-16">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-4 lg:px-8">
        <div className="lg:col-span-2">
          <p className="text-brand-gold-300 text-lg font-bold">{SITE.name}</p>
          <p className="text-brand-blue-200 mt-2 max-w-sm text-sm">{SITE.tagline}</p>

          <ul className="mt-6 space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <Phone className="size-4 shrink-0" aria-hidden="true" />
              <a href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`} className="hover:underline">
                {SITE.contact.phone}
              </a>
            </li>
            <li className="flex items-center gap-2">
              <Mail className="size-4 shrink-0" aria-hidden="true" />
              <a href={`mailto:${SITE.contact.email}`} className="hover:underline">
                {SITE.contact.email}
              </a>
            </li>
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{SITE.contact.address}</span>
            </li>
            <li className="flex items-center gap-2">
              <Clock className="size-4 shrink-0" aria-hidden="true" />
              <span>{SITE.contact.hours}</span>
            </li>
            <li className="flex items-center gap-2">
              <Facebook className="size-4 shrink-0" aria-hidden="true" />
              <a
                href={SITE.contact.facebook}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:underline"
              >
                Facebook
              </a>
            </li>
          </ul>
        </div>

        <nav aria-label="Footer">
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-wider">
            Explore
          </p>
          <ul className="mt-4 space-y-1 text-sm">
            {SITE.nav.map((item) => (
              <li key={item.href}>
                <Link to={item.href} className="flex min-h-11 items-center hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-wider">
            Accreditation
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            {PERMITS.map((permit) => (
              <div key={permit.label}>
                <dt className="text-brand-blue-300">{permit.label}</dt>
                <dd className="font-mono">
                  {permit.value ?? <span className="text-brand-gold-200">— pending —</span>}
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-brand-gold-300 mt-6 text-sm font-semibold uppercase tracking-wider">
            We accept
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {SITE.paymentMethods.map((method) => (
              <li
                key={method}
                className="border-brand-blue-800 bg-brand-blue-900 text-brand-blue-100 rounded-md border px-2.5 py-1 text-xs font-semibold"
              >
                {method}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-brand-blue-900 border-t">
        <div className="text-brand-blue-300 mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>
            © {new Date().getFullYear()} {SITE.name}. All rights reserved.
          </p>
          <p>Payments processed securely by PayMongo. Card details never touch our servers.</p>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 7: Create FloatingWhatsApp and PlaceholderBadge**

`client/src/components/layout/FloatingWhatsApp.tsx`:

```tsx
import { MessageCircle } from 'lucide-react';
import { SITE, whatsappLink } from '@/lib/site';

export default function FloatingWhatsApp() {
  return (
    <a
      href={whatsappLink(`Hi ${SITE.name}! I'd like to ask about a Cebu tour.`)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Chat with us on WhatsApp"
      className="bg-brand-blue-600 hover:bg-brand-blue-700 focus-visible:ring-brand-gold-400 fixed bottom-4 right-4 z-50 flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-full px-4 text-white shadow-lg transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
    >
      <MessageCircle className="size-6" aria-hidden="true" />
      <span className="hidden text-sm font-semibold sm:inline">WhatsApp</span>
    </a>
  );
}
```

`client/src/components/layout/PlaceholderBadge.tsx` — dev-only, amber (never red):

```tsx
/**
 * Dev-only marker that the page is rendering placeholder content, not real
 * business data (spec section 0: do not fake social proof). Stripped from
 * production builds by the import.meta.env.DEV guard.
 */
export default function PlaceholderBadge() {
  if (!import.meta.env.DEV) return null;

  return (
    <div
      role="status"
      className="border-brand-warning/30 bg-brand-gold-100 text-brand-warning border-b px-4 py-1.5 text-center text-xs font-semibold"
    >
      PLACEHOLDER DATA — ratings, guest counts, prices, permits and photos are not real (spec task
      8D)
    </div>
  );
}
```

- [ ] **Step 8: Create PublicLayout and the tours stub**

`client/src/components/layout/PublicLayout.tsx`:

```tsx
import { Outlet } from 'react-router-dom';
import FloatingWhatsApp from './FloatingWhatsApp';
import PlaceholderBadge from './PlaceholderBadge';
import SiteFooter from './SiteFooter';
import SiteHeader from './SiteHeader';

export default function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="bg-brand-blue-700 focus:ring-brand-gold-400 sr-only rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:ring-2"
      >
        Skip to main content
      </a>
      <PlaceholderBadge />
      <SiteHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
      <FloatingWhatsApp />
    </div>
  );
}
```

`client/src/pages/public/ToursStubPage.tsx` — replaced by the real catalog in task 2C:

```tsx
import { useSearchParams } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';

/** Placeholder target for the hero search. The real catalog is spec task 2C. */
export default function ToursStubPage() {
  const [params] = useSearchParams();

  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <SectionHeading
        eyebrow="Coming next"
        title="Tour catalog"
        subtitle="The full catalog with destination filters and live availability is task 2C."
      />
      <dl className="bg-brand-blue-50 mt-8 rounded-xl p-6 text-sm">
        <p className="text-brand-blue-900 mb-3 font-semibold">Search received:</p>
        {['destination', 'date', 'guests'].map((key) => (
          <div key={key} className="flex justify-between border-b border-white py-2 last:border-0">
            <dt className="text-muted-foreground capitalize">{key}</dt>
            <dd className="text-brand-blue-900 font-medium">{params.get(key) ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 9: Wire the routes**

`client/src/App.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom';
import PublicLayout from '@/components/layout/PublicLayout';
import ToursStubPage from '@/pages/public/ToursStubPage';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<p className="p-8">Home sections land in task 2B.</p>} />
        <Route path="tours" element={<ToursStubPage />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 10: Run the tests to verify they pass**

```bash
pnpm --filter @rg/client test
```

Expected: all `layout.test.tsx` tests PASS and `no-red.test.ts` still PASSES.

- [ ] **Step 11: Verify at 360px**

```bash
pnpm dev
```

In the browser at 360px wide: header fits with no horizontal scroll, the hamburger opens the nav,
every tap target is ≥44px, the WhatsApp button does not cover the footer links, and the skip link
appears on Tab.

- [ ] **Step 12: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @rg/client build
git add client
git commit -m "feat(client): public layout with header, footer, floating WhatsApp"
```

**→ After this task, write `✅ DONE` for 2A.**

---

## Task 6: Placeholder data and generated imagery

One module holding every placeholder value, plus generated brand-gradient SVG tiles. Isolating this makes tasks 2C/2D a single deletion.

**Files:**

- Create: `client/src/lib/placeholder-data.ts`, `client/scripts/generate-placeholders.mjs`, `client/public/favicon.svg`
- Create (generated): `client/public/placeholders/*.svg`
- Create (optional, Step 7): `client/scripts/check-placeholders.mjs`
- Test: `client/src/__tests__/placeholder-data.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces, from `placeholder-data.ts`:
  - `USING_PLACEHOLDER_DATA: true`
  - `PLACEHOLDER_SETTINGS: { ratingAverage: number; ratingCount: number; guestsServed: number; dotAccredited: boolean; promoCode: string; depositPercent: number }`
  - `DESTINATIONS: { id: number; name: string; slug: string }[]` (6)
  - `TOURS: { id: number; slug: string; title: string; destination: string; image: string; alt: string; fromPriceCentavos: number; durationHours: number; ratingAverage: number; ratingCount: number; bookedTotal: number; bookedThisWeek: number; freeCancellation: boolean }[]` (6)
  - `MOST_VISITED: { name: string; slug: string; image: string; alt: string; blurb: string }[]` (6)
  - `PACKAGES: { id: number; slug: string; title: string; days: number; oldPriceCentavos: number; newPriceCentavos: number; description: string; image: string; alt: string; highlights: string[] }[]` (3)
  - `REVIEWS: { id: number; name: string; tour: string; rating: number; body: string; dateLabel: string; verified: boolean }[]` (6)
  - `WHY_BOOK_DIRECT: { icon: string; title: string; body: string }[]` (6)
  - `HOW_IT_WORKS: { step: number; title: string; body: string }[]` (4)
  - `FAQS: { q: string; a: string }[]` (7)
  - `formatPeso(centavos: number): string`

- [ ] **Step 1: Write the failing test**

`client/src/__tests__/placeholder-data.test.ts` — locks the counts the spec requires (6 reasons, 6 places, 3 packages, 7 FAQs) and guards the centavos convention.

```ts
import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  FAQS,
  HOW_IT_WORKS,
  MOST_VISITED,
  PACKAGES,
  PLACEHOLDER_SETTINGS,
  REVIEWS,
  TOURS,
  USING_PLACEHOLDER_DATA,
  WHY_BOOK_DIRECT,
  formatPeso,
} from '@/lib/placeholder-data';

describe('placeholder data', () => {
  it('is explicitly flagged as placeholder', () => {
    expect(USING_PLACEHOLDER_DATA).toBe(true);
  });

  it('matches the counts the spec requires', () => {
    expect(DESTINATIONS).toHaveLength(6);
    expect(TOURS).toHaveLength(6);
    expect(MOST_VISITED).toHaveLength(6);
    expect(WHY_BOOK_DIRECT).toHaveLength(6);
    expect(PACKAGES).toHaveLength(3);
    expect(FAQS).toHaveLength(7);
    expect(HOW_IT_WORKS.length).toBeGreaterThanOrEqual(3);
    expect(REVIEWS.length).toBeGreaterThan(0);
  });

  it('stores every price as integer centavos', () => {
    for (const tour of TOURS) expect(Number.isInteger(tour.fromPriceCentavos)).toBe(true);
    for (const pkg of PACKAGES) {
      expect(Number.isInteger(pkg.oldPriceCentavos)).toBe(true);
      expect(Number.isInteger(pkg.newPriceCentavos)).toBe(true);
      expect(pkg.newPriceCentavos).toBeLessThan(pkg.oldPriceCentavos);
    }
  });

  it('formats centavos as whole pesos', () => {
    expect(formatPeso(150000)).toBe('₱1,500');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('keeps the deposit percent and promo code aligned with the spec', () => {
    expect(PLACEHOLDER_SETTINGS.depositPercent).toBe(30);
    expect(PLACEHOLDER_SETTINGS.promoCode).toBe('RGTOURS10');
  });

  it('gives every image an alt text', () => {
    for (const item of [...TOURS, ...MOST_VISITED, ...PACKAGES]) {
      expect(item.alt.length).toBeGreaterThan(5);
    }
  });

  it('includes at least one tour with zero weekly bookings to exercise the hide rule', () => {
    expect(TOURS.some((t) => t.bookedThisWeek === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rg/client test placeholder-data
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the placeholder data module**

`client/src/lib/placeholder-data.ts`. Destinations match the spec's list (Oslob, Mactan, Badian/Kawasan, Moalboal, Bohol, Cebu City).

```ts
/**
 * ============================================================================
 * PLACEHOLDER DATA — NOT REAL BUSINESS DATA
 * ============================================================================
 * Every value here is invented scaffolding so the public home page can be built
 * and reviewed before real content exists (spec task 8D).
 *
 * Spec section 0 forbids faking social proof. Accordingly:
 *   - a dev-only banner marks the page as placeholder-backed
 *     (components/layout/PlaceholderBadge.tsx)
 *   - ratings, guest counts and "booked X times" come from PLACEHOLDER_SETTINGS
 *     and must be replaced by real DB/settings values before launch
 *   - permit numbers are NOT invented here; see lib/site.ts, where they render
 *     as an explicit pending state
 *
 * Delete this entire file once tasks 2C/2D read from the API.
 * Money is integer CENTAVOS, per the project-wide convention.
 * ============================================================================
 */

export const USING_PLACEHOLDER_DATA = true;

const img = (slug: string) => `/placeholders/${slug}.svg`;

export const PLACEHOLDER_SETTINGS = {
  ratingAverage: 4.8,
  ratingCount: 212,
  guestsServed: 2400,
  dotAccredited: true,
  promoCode: 'RGTOURS10',
  depositPercent: 30,
} as const;

export const DESTINATIONS = [
  { id: 1, name: 'Oslob', slug: 'oslob' },
  { id: 2, name: 'Mactan', slug: 'mactan' },
  { id: 3, name: 'Badian / Kawasan', slug: 'badian-kawasan' },
  { id: 4, name: 'Moalboal', slug: 'moalboal' },
  { id: 5, name: 'Bohol', slug: 'bohol' },
  { id: 6, name: 'Cebu City', slug: 'cebu-city' },
];

export const TOURS = [
  {
    id: 1,
    slug: 'oslob-whale-shark-tumalog-falls',
    title: 'Oslob Whale Sharks + Tumalog Falls',
    destination: 'Oslob',
    image: img('oslob'),
    alt: 'Placeholder image for the Oslob whale shark and Tumalog Falls day tour',
    fromPriceCentavos: 189_000,
    durationHours: 14,
    ratingAverage: 4.9,
    ratingCount: 68,
    bookedTotal: 412,
    bookedThisWeek: 7,
    freeCancellation: true,
  },
  {
    id: 2,
    slug: 'kawasan-falls-canyoneering',
    title: 'Kawasan Falls Canyoneering',
    destination: 'Badian / Kawasan',
    image: img('badian-kawasan'),
    alt: 'Placeholder image for the Kawasan Falls canyoneering day tour',
    fromPriceCentavos: 215_000,
    durationHours: 13,
    ratingAverage: 4.8,
    ratingCount: 54,
    bookedTotal: 356,
    bookedThisWeek: 5,
    freeCancellation: true,
  },
  {
    id: 3,
    slug: 'moalboal-sardine-run-turtles',
    title: 'Moalboal Sardine Run & Sea Turtles',
    destination: 'Moalboal',
    image: img('moalboal'),
    alt: 'Placeholder image for the Moalboal sardine run and sea turtle snorkelling tour',
    fromPriceCentavos: 175_000,
    durationHours: 12,
    ratingAverage: 4.7,
    ratingCount: 41,
    bookedTotal: 288,
    // Deliberately 0 so the "booked X times this week" hide rule is exercised.
    bookedThisWeek: 0,
    freeCancellation: true,
  },
  {
    id: 4,
    slug: 'mactan-island-hopping',
    title: 'Mactan Island Hopping & Snorkelling',
    destination: 'Mactan',
    image: img('mactan'),
    alt: 'Placeholder image for the Mactan island hopping and snorkelling tour',
    fromPriceCentavos: 145_000,
    durationHours: 8,
    ratingAverage: 4.6,
    ratingCount: 37,
    bookedTotal: 231,
    bookedThisWeek: 4,
    freeCancellation: false,
  },
  {
    id: 5,
    slug: 'cebu-city-heritage-tour',
    title: 'Cebu City Heritage & Temple Tour',
    destination: 'Cebu City',
    image: img('cebu-city'),
    alt: 'Placeholder image for the Cebu City heritage and temple tour',
    fromPriceCentavos: 98_000,
    durationHours: 6,
    ratingAverage: 4.5,
    ratingCount: 29,
    bookedTotal: 174,
    bookedThisWeek: 3,
    freeCancellation: true,
  },
  {
    id: 6,
    slug: 'bohol-countryside-chocolate-hills',
    title: 'Bohol Countryside & Chocolate Hills',
    destination: 'Bohol',
    image: img('bohol'),
    alt: 'Placeholder image for the Bohol countryside and Chocolate Hills tour',
    fromPriceCentavos: 245_000,
    durationHours: 15,
    ratingAverage: 4.8,
    ratingCount: 33,
    bookedTotal: 142,
    bookedThisWeek: 2,
    freeCancellation: true,
  },
];

export const MOST_VISITED = [
  {
    name: 'Oslob',
    slug: 'oslob',
    image: img('oslob'),
    alt: 'Placeholder image for Oslob',
    blurb: 'Swim beside whale sharks at sunrise, then cool off under Tumalog Falls.',
  },
  {
    name: 'Kawasan Falls',
    slug: 'badian-kawasan',
    image: img('badian-kawasan'),
    alt: 'Placeholder image for Kawasan Falls in Badian',
    blurb: 'Three tiers of turquoise water and the island’s best canyoneering run.',
  },
  {
    name: 'Moalboal',
    slug: 'moalboal',
    image: img('moalboal'),
    alt: 'Placeholder image for Moalboal',
    blurb: 'Millions of sardines a few metres from the shoreline at Panagsama.',
  },
  {
    name: 'Mactan',
    slug: 'mactan',
    image: img('mactan'),
    alt: 'Placeholder image for Mactan',
    blurb: 'Island hopping, sandbars and reef snorkelling minutes from the airport.',
  },
  {
    name: 'Bohol',
    slug: 'bohol',
    image: img('bohol'),
    alt: 'Placeholder image for Bohol',
    blurb: 'Chocolate Hills, tarsiers and the Loboc River, all in one long day.',
  },
  {
    name: 'Cebu City',
    slug: 'cebu-city',
    image: img('cebu-city'),
    alt: 'Placeholder image for Cebu City',
    blurb: 'Magellan’s Cross, Taoist Temple and Tops Lookout with a local guide.',
  },
];

export const PACKAGES = [
  {
    id: 1,
    slug: 'cebu-highlights-3d2n',
    title: 'Cebu Highlights',
    days: 3,
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
    description:
      'City heritage, Oslob whale sharks and Kawasan canyoneering with hotel transfers included.',
    image: img('package-cebu-highlights'),
    alt: 'Placeholder image for the 3-day Cebu Highlights package',
    highlights: ['Private van throughout', 'Licensed guide', '2 nights accommodation'],
  },
  {
    id: 2,
    slug: 'cebu-bohol-5d4n',
    title: 'Cebu & Bohol Explorer',
    days: 5,
    oldPriceCentavos: 2_450_000,
    newPriceCentavos: 1_890_000,
    description:
      'South Cebu plus a Bohol countryside crossing — Chocolate Hills, tarsiers and the Loboc River.',
    image: img('package-cebu-bohol'),
    alt: 'Placeholder image for the 5-day Cebu and Bohol Explorer package',
    highlights: ['Ferry transfers', 'Island hopping day', '4 nights accommodation'],
  },
  {
    id: 3,
    slug: 'south-cebu-escape-4d3n',
    title: 'South Cebu Escape',
    days: 4,
    oldPriceCentavos: 1_680_000,
    newPriceCentavos: 1_340_000,
    description: 'Moalboal sardines, Badian canyoneering and Osmeña Peak sunrise at a slower pace.',
    image: img('package-south-cebu'),
    alt: 'Placeholder image for the 4-day South Cebu Escape package',
    highlights: ['Sunrise trek', 'Snorkel gear included', '3 nights accommodation'],
  },
];

export const REVIEWS = [
  {
    id: 1,
    name: 'Placeholder Guest A',
    tour: 'Oslob Whale Sharks + Tumalog Falls',
    rating: 5,
    body: 'Placeholder review copy. Real guest reviews are published only after admin approval (spec task 7A).',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 2,
    name: 'Placeholder Guest B',
    tour: 'Kawasan Falls Canyoneering',
    rating: 5,
    body: 'Placeholder review copy. This card demonstrates the verified-booking badge and star layout.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 3,
    name: 'Placeholder Guest C',
    tour: 'Moalboal Sardine Run',
    rating: 4,
    body: 'Placeholder review copy showing a four-star entry so the breakdown is not uniform.',
    dateLabel: 'Placeholder date',
    verified: false,
  },
  {
    id: 4,
    name: 'Placeholder Guest D',
    tour: 'Mactan Island Hopping',
    rating: 5,
    body: 'Placeholder review copy. Replace with published reviews from the reviews table.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 5,
    name: 'Placeholder Guest E',
    tour: 'Bohol Countryside',
    rating: 5,
    body: 'Placeholder review copy used to fill the grid on wide screens.',
    dateLabel: 'Placeholder date',
    verified: true,
  },
  {
    id: 6,
    name: 'Placeholder Guest F',
    tour: 'Cebu City Heritage Tour',
    rating: 4,
    body: 'Placeholder review copy. Sub-scores (guide, value, punctuality, safety) arrive in task 2D.',
    dateLabel: 'Placeholder date',
    verified: false,
  },
];

export const WHY_BOOK_DIRECT = [
  {
    icon: 'tag',
    title: 'No platform mark-up',
    body: 'Booking here skips agency commissions, so the price you see is the operator price.',
  },
  {
    icon: 'wallet',
    title: 'Pay 30% to reserve',
    body: 'Hold your date with a deposit and settle the balance on tour day.',
  },
  {
    icon: 'shield',
    title: 'Licensed vans and drivers',
    body: 'Every trip runs on an accredited van with a professional, insured driver.',
  },
  {
    icon: 'headset',
    title: 'Talk to a real person',
    body: 'Message us on WhatsApp or Viber and reach the team running your trip.',
  },
  {
    icon: 'calendar',
    title: 'Flexible changes',
    body: 'Free cancellation on most tours within the window shown on each tour page.',
  },
  {
    icon: 'map',
    title: 'Local itineraries',
    body: 'Routes built by Cebu-based guides, timed to miss the crowds.',
  },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: 'Pick a tour and date',
    body: 'Choose your destination, date and group size. Live availability, no waiting for a reply.',
  },
  {
    step: 2,
    title: 'Reserve with 30% deposit',
    body: 'Pay the deposit or the full amount by GCash, Maya, GrabPay, QR Ph or card.',
  },
  {
    step: 3,
    title: 'Get your driver details',
    body: 'We assign a van and driver, then send you their name, plate number and contact.',
  },
  {
    step: 4,
    title: 'Meet your guide',
    body: 'Your driver arrives at your pickup point. Settle any balance on the day.',
  },
];

export const FAQS = [
  {
    q: 'How much deposit do I need to pay?',
    a: `A ${PLACEHOLDER_SETTINGS.depositPercent}% deposit reserves your date. The balance is collected on tour day. You can also pay in full online.`,
  },
  {
    q: 'Which payment methods do you accept?',
    a: 'GCash, Maya, GrabPay, QR Ph and major cards through PayMongo. You can also transfer manually to our QR code and upload the receipt for verification.',
  },
  {
    q: 'Can I cancel or reschedule?',
    a: 'Most tours include free cancellation within the window shown on the tour page. Message us and we will move your date where availability allows.',
  },
  {
    q: 'Is hotel pickup included?',
    a: 'Yes. Pickup within Cebu City, Mandaue, Lapu-Lapu and Mactan is included. Outside those areas we will quote a small transfer fee.',
  },
  {
    q: 'What should I bring?',
    a: 'Swimwear, a towel, reef-safe sunscreen, a dry bag and a valid ID. Canyoneering tours provide helmets and life vests.',
  },
  {
    q: 'Do you run private or joiner tours?',
    a: 'All tours are private by default — your group gets its own van and driver. Group pricing drops as your party grows.',
  },
  {
    q: 'How do I reach you on tour day?',
    a: 'Your confirmation includes your driver’s mobile number and the office hotline. The WhatsApp button on this site reaches us any time.',
  },
];

const pesoFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Formats integer centavos as whole pesos, e.g. 150000 -> "₱1,500". */
export function formatPeso(centavos: number) {
  return pesoFormatter.format(Math.round(centavos / 100)).replace(/ /g, '');
}
```

- [ ] **Step 4: Write the placeholder image generator**

`client/scripts/generate-placeholders.mjs`:

```js
/**
 * Generates brand-gradient SVG placeholder tiles into public/placeholders/.
 * Blue -> gold, labelled PLACEHOLDER so they cannot be mistaken for real
 * photography. Replaced by the client's real photos in spec task 8D.
 *
 * Run: pnpm --filter @rg/client placeholders
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/placeholders');

const TILES = [
  { slug: 'oslob', label: 'OSLOB' },
  { slug: 'mactan', label: 'MACTAN' },
  { slug: 'badian-kawasan', label: 'BADIAN / KAWASAN' },
  { slug: 'moalboal', label: 'MOALBOAL' },
  { slug: 'bohol', label: 'BOHOL' },
  { slug: 'cebu-city', label: 'CEBU CITY' },
  { slug: 'package-cebu-highlights', label: 'CEBU HIGHLIGHTS' },
  { slug: 'package-cebu-bohol', label: 'CEBU & BOHOL' },
  { slug: 'package-south-cebu', label: 'SOUTH CEBU' },
  { slug: 'hero', label: 'HERO IMAGE', width: 1600, height: 900 },
];

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tile({ slug, label, width = 1200, height = 800 }) {
  const id = `g-${slug}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)} placeholder">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#172554"/>
      <stop offset="55%" stop-color="#1d4ed8"/>
      <stop offset="100%" stop-color="#d4a017"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#${id})"/>
  <g fill="#ffffff" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" text-anchor="middle">
    <text x="${width / 2}" y="${height / 2 - 10}" font-size="${Math.round(width / 16)}" font-weight="700" letter-spacing="2">${escapeXml(label)}</text>
    <text x="${width / 2}" y="${height / 2 + Math.round(width / 22)}" font-size="${Math.round(width / 34)}" font-weight="600" letter-spacing="6" opacity="0.85">PLACEHOLDER</text>
  </g>
</svg>
`;
}

mkdirSync(outDir, { recursive: true });

for (const spec of TILES) {
  writeFileSync(join(outDir, `${spec.slug}.svg`), tile(spec), 'utf8');
  console.log(`wrote placeholders/${spec.slug}.svg`);
}
```

- [ ] **Step 5: Generate the tiles and write the favicon**

```bash
pnpm --filter @rg/client placeholders
```

Then write `client/public/favicon.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#1d4ed8"/>
  <text x="32" y="41" text-anchor="middle" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#fcd34d">R&amp;G</text>
</svg>
```

Expected: 10 SVGs in `client/public/placeholders/` plus the favicon.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @rg/client test
```

Expected: `placeholder-data.test.ts` PASSES; `no-red.test.ts` still PASSES (the gradient is
blue→gold, no red).

- [ ] **Step 7 (OPTIONAL — skip if the user declined): production build guard**

Because the placeholder marker is dev-only, a production build would otherwise ship unmarked
invented ratings. This guard makes that a deliberate choice rather than an accident.

`client/scripts/check-placeholders.mjs`:

```js
/**
 * Fails a production build while the site still renders placeholder data.
 * Override intentionally with ALLOW_PLACEHOLDER_BUILD=1 (e.g. for a client demo).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/placeholder-data.ts');
const stillPlaceholder = /export const USING_PLACEHOLDER_DATA = true/.test(
  readFileSync(file, 'utf8'),
);

if (stillPlaceholder && !process.env.ALLOW_PLACEHOLDER_BUILD) {
  console.error(
    '\nBuild blocked: the site still renders PLACEHOLDER data (ratings, guest counts, prices).\n' +
      'Spec section 0 forbids presenting these as real. Load real content (task 8D), or set\n' +
      'ALLOW_PLACEHOLDER_BUILD=1 to build a demo deliberately.\n',
  );
  process.exit(1);
}
```

Then change the client `build` script to:

```json
"build": "node scripts/check-placeholders.mjs && tsc -b && vite build"
```

Verify both paths:

```bash
pnpm --filter @rg/client build                              # expect the guard to BLOCK
ALLOW_PLACEHOLDER_BUILD=1 pnpm --filter @rg/client build    # expect SUCCESS
```

- [ ] **Step 8: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add client
git commit -m "feat(client): placeholder data module and generated SVG imagery"
```

---

## Task 7: Home page sections 1–6 (spec task 2B, first half)

Hero with search and trust line, trust bar, catalog preview with destination filter, how booking works, why book direct, most visited places.

**REQUIRED: invoke `ui-ux-pro-max` before writing these components.**

**Files:**

- Create: `client/src/components/common/StarRating.tsx`, `client/src/components/common/TourCard.tsx`
- Create: `client/src/components/home/HeroSection.tsx`, `TrustBar.tsx`, `CatalogPreview.tsx`, `HowItWorks.tsx`, `WhyBookDirect.tsx`, `MostVisited.tsx`
- Create: `client/src/pages/public/HomePage.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**

- Consumes: `placeholder-data.ts` exports; shadcn `Button`, `Card`, `CardContent`, `Input`, `Label`, `Select`, `Badge`; `SectionHeading`.
- Produces:
  - `StarRating` — props `{ value: number; count?: number; size?: 'sm' | 'md'; className?: string }`
  - `TourCard` — props `{ tour: (typeof TOURS)[number] }`, reused by task 2C
  - `HomePage` default export with anchors `#tours`, `#how`, `#why`, `#places`

- [ ] **Step 1: Create StarRating**

Gold stars, accessible text alternative, never red.

```tsx
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  value: number;
  count?: number;
  size?: 'sm' | 'md';
  className?: string;
};

export default function StarRating({ value, count, size = 'sm', className }: Props) {
  const rounded = Math.round(value);
  const starSize = size === 'sm' ? 'size-4' : 'size-5';

  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <span className="flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className={cn(
              starSize,
              i <= rounded
                ? 'fill-brand-gold-400 text-brand-gold-400'
                : 'fill-brand-blue-100 text-brand-blue-200',
            )}
          />
        ))}
      </span>
      <span className="text-brand-ink text-sm font-semibold">{value.toFixed(1)}</span>
      {typeof count === 'number' && (
        <span className="text-muted-foreground text-sm">({count})</span>
      )}
      <span className="sr-only">
        {value.toFixed(1)} out of 5{typeof count === 'number' ? ` from ${count} reviews` : ''}.
        Placeholder value.
      </span>
    </span>
  );
}
```

- [ ] **Step 2: Create TourCard**

Shows photo, title, destination, rating + count, total booked, "booked X times this week" **hidden when 0** (spec section 4), "from ₱X", and the free-cancellation badge when enabled.

```tsx
import { Clock, MapPin, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import StarRating from '@/components/common/StarRating';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatPeso, type TOURS } from '@/lib/placeholder-data';

type Props = { tour: (typeof TOURS)[number] };

export default function TourCard({ tour }: Props) {
  return (
    <Card className="group overflow-hidden p-0 transition-shadow hover:shadow-lg">
      <div className="bg-brand-blue-100 relative aspect-[4/3] overflow-hidden">
        <img
          src={tour.image}
          alt={tour.alt}
          loading="lazy"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {tour.freeCancellation && (
          <Badge className="bg-brand-gold-500 text-brand-blue-950 absolute left-3 top-3 border-0">
            Free cancellation
          </Badge>
        )}
      </div>

      <CardContent className="space-y-3 p-4">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <MapPin className="size-3.5" aria-hidden="true" />
          {tour.destination}
          <span aria-hidden="true">·</span>
          <Clock className="size-3.5" aria-hidden="true" />
          {tour.durationHours}h
        </p>

        <h3 className="text-brand-blue-900 text-base font-semibold leading-snug">
          <Link to={`/tours/${tour.slug}`} className="hover:underline">
            {tour.title}
          </Link>
        </h3>

        <StarRating value={tour.ratingAverage} count={tour.ratingCount} />

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {tour.bookedTotal} trips run
          </span>
          {/* Spec: hide the weekly count entirely when it is 0. */}
          {tour.bookedThisWeek > 0 && (
            <span className="text-brand-gold-700 font-semibold">
              Booked {tour.bookedThisWeek}× this week
            </span>
          )}
        </div>

        <div className="flex items-end justify-between pt-1">
          <p className="text-sm">
            <span className="text-muted-foreground">from </span>
            <span className="text-brand-blue-900 text-lg font-bold">
              {formatPeso(tour.fromPriceCentavos)}
            </span>
            <span className="text-muted-foreground"> / person</span>
          </p>
          <Link
            to={`/tours/${tour.slug}`}
            className="text-brand-blue-700 hover:bg-brand-blue-50 inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold"
          >
            View tour
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Create HeroSection (spec home section 1)**

Search = destination + date + guests, submitting to `/tours?…`. Native `<input type="date">` keeps
the dependency count down; the real blocked-date picker is task 2D. `min` is today so past dates
cannot be chosen.

```tsx
import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DESTINATIONS, PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

const today = new Date().toISOString().slice(0, 10);

export default function HeroSection() {
  const navigate = useNavigate();
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState('');
  const [guests, setGuests] = useState('2');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (destination) params.set('destination', destination);
    if (date) params.set('date', date);
    if (guests) params.set('guests', guests);
    navigate(`/tours?${params.toString()}`);
  }

  return (
    <section className="relative isolate overflow-hidden">
      <img
        src="/placeholders/hero.svg"
        alt="Placeholder hero image for R&amp;G Travel &amp; Tours Cebu day tours"
        className="absolute inset-0 -z-10 size-full object-cover"
      />
      <div className="from-brand-blue-950/90 via-brand-blue-900/75 absolute inset-0 -z-10 bg-gradient-to-br to-transparent" />

      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-widest">
            Cebu, Philippines
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-5xl">
            Private Cebu day tours, booked direct with the people who run them.
          </h1>
          <p className="text-brand-blue-100 mt-4 text-base sm:text-lg">
            Whale sharks, canyoneering and island hopping in your own van with a licensed driver.
            Reserve with a {PLACEHOLDER_SETTINGS.depositPercent}% deposit.
          </p>

          {/* Trust line — placeholder settings values, marked by the dev banner. */}
          <ul className="text-brand-blue-100 mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <li className="flex items-center gap-1.5">
              <span className="text-brand-gold-300 font-bold">
                {PLACEHOLDER_SETTINGS.ratingAverage.toFixed(1)}★
              </span>
              <span>from {PLACEHOLDER_SETTINGS.ratingCount} guest reviews</span>
            </li>
            <li aria-hidden="true" className="text-brand-blue-400">
              |
            </li>
            <li>DOT accredited</li>
            <li aria-hidden="true" className="text-brand-blue-400">
              |
            </li>
            <li>{PLACEHOLDER_SETTINGS.guestsServed.toLocaleString('en-PH')}+ guests served</li>
          </ul>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-background/95 mt-10 grid gap-4 rounded-2xl p-4 shadow-xl backdrop-blur sm:p-6 lg:grid-cols-[1.4fr_1fr_0.8fr_auto]"
          aria-label="Search tours"
        >
          <div className="space-y-1.5">
            <Label htmlFor="hero-destination">Destination</Label>
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger id="hero-destination" className="tap-target w-full">
                <SelectValue placeholder="Anywhere in Cebu" />
              </SelectTrigger>
              <SelectContent>
                {DESTINATIONS.map((d) => (
                  <SelectItem key={d.slug} value={d.slug}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hero-date">Date</Label>
            <Input
              id="hero-date"
              type="date"
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="tap-target"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hero-guests">Guests</Label>
            <Input
              id="hero-guests"
              type="number"
              inputMode="numeric"
              min={1}
              max={12}
              value={guests}
              onChange={(e) => setGuests(e.target.value)}
              className="tap-target"
            />
          </div>

          <div className="flex items-end">
            <Button type="submit" size="lg" className="tap-target w-full lg:w-auto">
              <Search className="size-4" aria-hidden="true" />
              Search tours
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Create TrustBar (spec home section 2)**

```tsx
import { BadgeCheck, CreditCard, Headset, Users } from 'lucide-react';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

const ITEMS = [
  { icon: BadgeCheck, label: 'DOT accredited operator' },
  {
    icon: Users,
    label: `${PLACEHOLDER_SETTINGS.guestsServed.toLocaleString('en-PH')}+ guests served`,
  },
  { icon: CreditCard, label: `${PLACEHOLDER_SETTINGS.depositPercent}% deposit to reserve` },
  { icon: Headset, label: 'Local team on WhatsApp daily' },
];

export default function TrustBar() {
  return (
    <section aria-label="Why guests trust us" className="bg-brand-blue-50 border-y">
      <ul className="mx-auto grid max-w-7xl grid-cols-2 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-4 lg:px-8">
        {ITEMS.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="text-brand-blue-900 flex items-center gap-2.5 text-sm font-medium"
          >
            <Icon className="text-brand-gold-600 size-5 shrink-0" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Create CatalogPreview (spec home section 3)**

Destination filter driven by `DESTINATIONS` (DB-backed in task 2C, never hardcoded in markup).

```tsx
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';
import TourCard from '@/components/common/TourCard';
import { Button } from '@/components/ui/button';
import { DESTINATIONS, TOURS } from '@/lib/placeholder-data';
import { cn } from '@/lib/utils';

const ALL = 'all';

export default function CatalogPreview() {
  const [active, setActive] = useState<string>(ALL);

  const filtered = useMemo(
    () =>
      active === ALL
        ? TOURS
        : TOURS.filter((t) => t.destination === DESTINATIONS.find((d) => d.slug === active)?.name),
    [active],
  );

  const filters = [{ slug: ALL, name: 'All tours' }, ...DESTINATIONS];

  return (
    <section id="tours" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Day tours"
        title="Popular Cebu day tours"
        subtitle="Private van, licensed driver and a local guide on every trip. Prices drop as your group grows."
      />

      <div
        role="group"
        aria-label="Filter tours by destination"
        className="mt-8 flex gap-2 overflow-x-auto pb-2"
      >
        {filters.map((f) => (
          <button
            key={f.slug}
            type="button"
            aria-pressed={active === f.slug}
            onClick={() => setActive(f.slug)}
            className={cn(
              'min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
              active === f.slug
                ? 'bg-brand-blue-600 border-brand-blue-600 text-white'
                : 'border-brand-blue-200 text-brand-blue-800 hover:bg-brand-blue-50',
            )}
          >
            {f.name}
          </button>
        ))}
      </div>

      {filtered.length > 0 ? (
        <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((tour) => (
            <li key={tour.id}>
              <TourCard tour={tour} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground mt-8 text-center text-sm">
          No tours listed for this destination yet.
        </p>
      )}

      <div className="mt-10 text-center">
        <Button asChild size="lg" variant="outline" className="tap-target">
          <Link to="/tours">See all tours</Link>
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Create HowItWorks (spec home section 4)**

```tsx
import SectionHeading from '@/components/common/SectionHeading';
import { HOW_IT_WORKS } from '@/lib/placeholder-data';

export default function HowItWorks() {
  return (
    <section id="how" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How it works"
          title="Booking takes about two minutes"
          subtitle="No waiting for a quote. Reserve online and we take it from there."
        />
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((item) => (
            <li key={item.step} className="bg-background rounded-xl p-6 shadow-sm">
              <span className="bg-brand-blue-600 text-brand-gold-300 flex size-10 items-center justify-center rounded-full text-base font-bold">
                {item.step}
              </span>
              <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">{item.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{item.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Create WhyBookDirect (spec home section 5 — six reasons)**

```tsx
import { Calendar, Headset, Map, Shield, Tag, Wallet, type LucideIcon } from 'lucide-react';
import SectionHeading from '@/components/common/SectionHeading';
import { WHY_BOOK_DIRECT } from '@/lib/placeholder-data';

const ICONS: Record<string, LucideIcon> = {
  tag: Tag,
  wallet: Wallet,
  shield: Shield,
  headset: Headset,
  calendar: Calendar,
  map: Map,
};

export default function WhyBookDirect() {
  return (
    <section id="why" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Book direct"
        title="Six reasons to skip the booking platforms"
        subtitle="Editable from admin settings once the site is live."
      />
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {WHY_BOOK_DIRECT.map((reason) => {
          const Icon = ICONS[reason.icon] ?? Tag;
          return (
            <li key={reason.title} className="border-brand-blue-100 rounded-xl border p-6">
              <span className="bg-brand-gold-100 flex size-11 items-center justify-center rounded-lg">
                <Icon className="text-brand-gold-700 size-5" aria-hidden="true" />
              </span>
              <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">{reason.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{reason.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 8: Create MostVisited (spec home section 6 — six places)**

```tsx
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';
import { MOST_VISITED } from '@/lib/placeholder-data';

export default function MostVisited() {
  return (
    <section id="places" className="bg-brand-blue-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Where guests go"
          title="Most visited places"
          subtitle="The six destinations our vans run to most often."
          className="[&_p:last-child]:text-brand-blue-200 [&_h2]:text-white"
        />
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MOST_VISITED.map((place) => (
            <li key={place.slug}>
              <Link
                to={`/tours?destination=${place.slug}`}
                className="focus-visible:ring-brand-gold-400 group relative block overflow-hidden rounded-xl"
              >
                <img
                  src={place.image}
                  alt={place.alt}
                  loading="lazy"
                  className="aspect-[3/2] w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="from-brand-blue-950 absolute inset-0 bg-gradient-to-t via-transparent to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  <h3 className="flex items-center gap-1.5 text-lg font-bold text-white">
                    {place.name}
                    <ArrowRight
                      className="size-4 transition-transform group-hover:translate-x-1"
                      aria-hidden="true"
                    />
                  </h3>
                  <p className="text-brand-blue-100 mt-1 text-sm">{place.blurb}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 9: Create HomePage and wire the route**

`client/src/pages/public/HomePage.tsx`:

```tsx
import CatalogPreview from '@/components/home/CatalogPreview';
import HeroSection from '@/components/home/HeroSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import TrustBar from '@/components/home/TrustBar';
import WhyBookDirect from '@/components/home/WhyBookDirect';

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <TrustBar />
      <CatalogPreview />
      <HowItWorks />
      <WhyBookDirect />
      <MostVisited />
      {/* Sections 7-11 are added in Task 8. */}
    </>
  );
}
```

In `client/src/App.tsx`, replace the index element with `<HomePage />` and add the import:

```tsx
import HomePage from '@/pages/public/HomePage';
// ...
<Route index element={<HomePage />} />;
```

- [ ] **Step 10: Verify in the browser**

```bash
pnpm dev
```

At 360px and at 1280px: no horizontal scroll, the hero form stacks cleanly, the filter row scrolls
horizontally without clipping, the `bookedThisWeek: 0` tour (Moalboal) shows **no** weekly badge,
and every image has alt text.

- [ ] **Step 11: Test, lint, typecheck, commit**

```bash
pnpm --filter @rg/client test && pnpm lint && pnpm typecheck
git add client
git commit -m "feat(home): hero, trust bar, catalog, how it works, why direct, places"
```

---

## Task 8: Home page sections 7–11 (spec task 2B, second half)

Packages with old-vs-new pricing and an inquiry form, guest reviews, promo band + newsletter revealing `RGTOURS10`, FAQ accordion, and the contact section.

**REQUIRED: invoke `ui-ux-pro-max` before writing these components.**

**Files:**

- Create: `client/src/components/home/PackagesSection.tsx`, `ReviewsSection.tsx`, `PromoNewsletter.tsx`, `FaqSection.tsx`, `ContactSection.tsx`
- Modify: `client/src/pages/public/HomePage.tsx`
- Test: `client/src/__tests__/home.test.tsx`

**Interfaces:**

- Consumes: `PACKAGES`, `REVIEWS`, `FAQS`, `PLACEHOLDER_SETTINGS`, `formatPeso`; shadcn `Accordion`, `Button`, `Input`, `Label`; `SITE`, `whatsappLink`; `SectionHeading`, `StarRating`.
- Produces: `HomePage` with anchors `#packages`, `#reviews`, `#faq`, `#contact` matching `SITE.nav`.

**Forms in this task submit nothing to a server.** There is no inquiry/newsletter API until tasks
7C/7E, so each form validates in the browser and shows an explicit "not wired up yet" state. It must
never claim a message was sent.

- [ ] **Step 1: Write the failing home page test**

`client/src/__tests__/home.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';
import HomePage from '@/pages/public/HomePage';

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('home page', () => {
  it('renders exactly one h1, in the hero', () => {
    renderHome();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders a search form with destination, date, and guests', () => {
    renderHome();
    const form = screen.getByRole('form', { name: /search tours/i });
    expect(within(form).getByLabelText(/destination/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/guests/i)).toBeInTheDocument();
  });

  it('exposes every section anchor used by the nav', () => {
    const { container } = renderHome();
    for (const id of ['tours', 'how', 'why', 'places', 'packages', 'reviews', 'faq', 'contact']) {
      expect(container.querySelector(`#${id}`), `missing #${id}`).toBeTruthy();
    }
  });

  it('shows three packages, each with a struck-through old price', () => {
    const { container } = renderHome();
    const packages = container.querySelector('#packages');
    expect(packages).toBeTruthy();
    expect(packages!.querySelectorAll('s').length).toBe(3);
  });

  it('hides the weekly booking count when it is zero', () => {
    renderHome();
    expect(screen.queryByText(/booked 0/i)).not.toBeInTheDocument();
  });

  it('renders seven FAQ questions', () => {
    const { container } = renderHome();
    const faq = container.querySelector('#faq');
    expect(within(faq as HTMLElement).getAllByRole('button')).toHaveLength(7);
  });

  it('reveals the promo code only after newsletter signup', async () => {
    const user = userEvent.setup();
    renderHome();

    expect(screen.queryByText(PLACEHOLDER_SETTINGS.promoCode)).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    expect(await screen.findByText(PLACEHOLDER_SETTINGS.promoCode)).toBeInTheDocument();
  });

  it('offers phone, email, and WhatsApp in the contact section', () => {
    const { container } = renderHome();
    const contact = container.querySelector('#contact') as HTMLElement;
    expect(within(contact).getByRole('link', { name: /whatsapp/i })).toBeInTheDocument();
    expect(contact.querySelector('a[href^="tel:"]')).toBeTruthy();
    expect(contact.querySelector('a[href^="mailto:"]')).toBeTruthy();
  });

  it('never claims an inquiry was sent', async () => {
    const user = userEvent.setup();
    renderHome();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.type(within(form).getByLabelText(/message/i), 'Hello');
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const status = await within(form).findByRole('status');
    expect(status).toHaveTextContent(/nothing has been sent/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rg/client test home
```

Expected: FAIL on the missing `#packages`, `#reviews`, `#faq`, `#contact` sections.

- [ ] **Step 3: Create PackagesSection (spec home section 7)**

```tsx
import { Check } from 'lucide-react';
import { useState } from 'react';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PACKAGES, formatPeso } from '@/lib/placeholder-data';

export default function PackagesSection() {
  const [selected, setSelected] = useState<string>(PACKAGES[0]!.slug);
  const [submitted, setSubmitted] = useState(false);

  return (
    <section id="packages" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Multi-day"
        title="Packages"
        subtitle="Three to five days across Cebu and Bohol, with transfers and accommodation handled."
      />

      <ul className="mt-10 grid gap-6 lg:grid-cols-3">
        {PACKAGES.map((pkg) => (
          <li
            key={pkg.id}
            className="border-brand-blue-100 flex flex-col overflow-hidden rounded-xl border"
          >
            <img
              src={pkg.image}
              alt={pkg.alt}
              loading="lazy"
              className="aspect-[3/2] w-full object-cover"
            />
            <div className="flex flex-1 flex-col p-5">
              <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-wider">
                {pkg.days} days / {pkg.days - 1} nights
              </p>
              <h3 className="text-brand-blue-900 mt-1.5 text-lg font-bold">{pkg.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{pkg.description}</p>

              <ul className="mt-4 space-y-1.5 text-sm">
                {pkg.highlights.map((h) => (
                  <li key={h} className="text-brand-ink flex items-center gap-2">
                    <Check className="text-brand-gold-600 size-4 shrink-0" aria-hidden="true" />
                    {h}
                  </li>
                ))}
              </ul>

              <div className="mt-5 flex items-baseline gap-2">
                <s className="text-muted-foreground text-sm">{formatPeso(pkg.oldPriceCentavos)}</s>
                <span className="text-brand-blue-900 text-2xl font-bold">
                  {formatPeso(pkg.newPriceCentavos)}
                </span>
                <span className="text-muted-foreground text-xs">per group</span>
              </div>

              <Button
                className="tap-target mt-4 w-full"
                onClick={() => {
                  setSelected(pkg.slug);
                  document.getElementById('package-inquiry-name')?.focus();
                }}
              >
                Enquire about this package
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <form
        aria-label="Package inquiry"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
        className="bg-brand-blue-50 mt-10 grid gap-4 rounded-2xl p-6 sm:grid-cols-2"
      >
        <h3 className="text-brand-blue-900 text-lg font-semibold sm:col-span-2">
          Ask about a package
        </h3>

        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-name">Your name</Label>
          <Input id="package-inquiry-name" name="name" required className="tap-target" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-email">Email</Label>
          <Input
            id="package-inquiry-email"
            name="email"
            type="email"
            required
            className="tap-target"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-package">Package</Label>
          <select
            id="package-inquiry-package"
            name="package"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="border-input bg-background tap-target w-full rounded-md border px-3 text-sm"
          >
            {PACKAGES.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-dates">Preferred dates</Label>
          <Input id="package-inquiry-dates" name="dates" type="date" className="tap-target" />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" size="lg" className="tap-target w-full sm:w-auto">
            Send inquiry
          </Button>
          {submitted && (
            <p role="status" className="text-brand-warning mt-3 text-sm font-medium">
              Form validated. Inquiry delivery is not connected yet (spec task 7C) — nothing has
              been sent. Please message us on WhatsApp in the meantime.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Create ReviewsSection (spec home section 8)**

```tsx
import { BadgeCheck } from 'lucide-react';
import SectionHeading from '@/components/common/SectionHeading';
import StarRating from '@/components/common/StarRating';
import { PLACEHOLDER_SETTINGS, REVIEWS } from '@/lib/placeholder-data';

export default function ReviewsSection() {
  return (
    <section id="reviews" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Guest reviews"
          title="What guests say"
          subtitle={`${PLACEHOLDER_SETTINGS.ratingAverage.toFixed(1)} average from ${PLACEHOLDER_SETTINGS.ratingCount} reviews. Only admin-approved reviews are published.`}
        />

        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {REVIEWS.map((review) => (
            <li key={review.id} className="bg-background flex flex-col rounded-xl p-5 shadow-sm">
              <StarRating value={review.rating} />
              <blockquote className="text-brand-ink mt-3 flex-1 text-sm">{review.body}</blockquote>
              <footer className="mt-4 text-sm">
                <p className="text-brand-blue-900 flex flex-wrap items-center gap-1.5 font-semibold">
                  {review.name}
                  {review.verified && (
                    <span className="text-brand-gold-700 inline-flex items-center gap-1 text-xs font-medium">
                      <BadgeCheck className="size-3.5" aria-hidden="true" />
                      Verified booking
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground text-xs">
                  {review.tour} · {review.dateLabel}
                </p>
              </footer>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Create PromoNewsletter (spec home section 9)**

The code `RGTOURS10` is revealed **only after** signup, per the spec.

```tsx
import { Gift } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

export default function PromoNewsletter() {
  const [signedUp, setSignedUp] = useState(false);

  return (
    <section
      aria-labelledby="promo-heading"
      className="from-brand-blue-900 to-brand-blue-700 bg-gradient-to-r"
    >
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:items-center lg:px-8">
        <div>
          <p className="text-brand-gold-300 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
            <Gift className="size-4" aria-hidden="true" />
            Direct-booking perk
          </p>
          <h2 id="promo-heading" className="mt-3 text-2xl font-bold text-white sm:text-3xl">
            Get 10% off your first tour
          </h2>
          <p className="text-brand-blue-100 mt-3 text-sm sm:text-base">
            Join the list for Cebu trip tips and seasonal offers. We send a few emails a year and
            never share your address.
          </p>
        </div>

        <form
          aria-label="Newsletter signup"
          onSubmit={(e) => {
            e.preventDefault();
            setSignedUp(true);
          }}
          className="bg-background/95 rounded-2xl p-5 backdrop-blur"
        >
          <div className="space-y-1.5">
            <Label htmlFor="newsletter-email">Email address</Label>
            <Input
              id="newsletter-email"
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              className="tap-target"
            />
          </div>
          <Button type="submit" size="lg" className="tap-target mt-4 w-full">
            Sign up for 10% off
          </Button>

          {signedUp && (
            <div
              role="status"
              className="border-brand-gold-300 bg-brand-gold-50 mt-4 rounded-lg border p-4 text-center"
            >
              <p className="text-brand-blue-900 text-sm font-medium">Your promo code</p>
              <p className="text-brand-blue-900 mt-1 font-mono text-2xl font-bold tracking-wider">
                {PLACEHOLDER_SETTINGS.promoCode}
              </p>
              <p className="text-brand-warning mt-2 text-xs">
                Code shown locally only. Newsletter storage and coupon validation land in tasks 7C
                and 7B — your address has not been saved.
              </p>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Create FaqSection (spec home section 10 — seven questions)**

```tsx
import SectionHeading from '@/components/common/SectionHeading';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { FAQS } from '@/lib/placeholder-data';

export default function FaqSection() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />

      <Accordion type="single" collapsible className="mt-8 w-full">
        {FAQS.map((faq, i) => (
          <AccordionItem key={faq.q} value={`faq-${i}`}>
            <AccordionTrigger className="text-brand-blue-900 min-h-11 text-left text-base font-semibold">
              {faq.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground text-sm">{faq.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
```

- [ ] **Step 7: Create ContactSection (spec home section 11)**

```tsx
import { Clock, Facebook, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { useState } from 'react';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SITE, whatsappLink } from '@/lib/site';

export default function ContactSection() {
  const [submitted, setSubmitted] = useState(false);
  const telHref = `tel:${SITE.contact.phone.replace(/\s/g, '')}`;

  return (
    <section id="contact" className="bg-brand-blue-50 border-t">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Contact"
          title="Contact us"
          subtitle="Message us any day between 7:00 AM and 9:00 PM Philippine time."
        />

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <ul className="space-y-4">
            <li>
              <a
                href={telHref}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Phone / Viber</span>
                  <span className="text-muted-foreground">{SITE.contact.phone}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={whatsappLink()}
                target="_blank"
                rel="noreferrer noopener"
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <MessageCircle className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">WhatsApp</span>
                  <span className="text-muted-foreground">Chat with the team</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={`mailto:${SITE.contact.email}`}
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <Mail className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Email</span>
                  <span className="text-muted-foreground">{SITE.contact.email}</span>
                </span>
              </a>
            </li>
            <li>
              <a
                href={SITE.contact.facebook}
                target="_blank"
                rel="noreferrer noopener"
                className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-sm"
              >
                <Facebook className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="text-brand-blue-900 block font-semibold">Facebook</span>
                  <span className="text-muted-foreground">Message our page</span>
                </span>
              </a>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-sm">
              <MapPin className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Office</span>
                <span className="text-muted-foreground">{SITE.contact.address}</span>
              </span>
            </li>
            <li className="bg-background flex items-start gap-3 rounded-xl p-4 text-sm">
              <Clock className="text-brand-blue-600 mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <span>
                <span className="text-brand-blue-900 block font-semibold">Hours</span>
                <span className="text-muted-foreground">{SITE.contact.hours}</span>
              </span>
            </li>
          </ul>

          <form
            aria-label="Contact inquiry"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(true);
            }}
            className="bg-background space-y-4 rounded-2xl p-6"
          >
            <h3 className="text-brand-blue-900 text-lg font-semibold">Send us a message</h3>

            <div className="space-y-1.5">
              <Label htmlFor="contact-name">Your name</Label>
              <Input id="contact-name" name="name" required className="tap-target" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contact-email">Email</Label>
                <Input
                  id="contact-email"
                  name="email"
                  type="email"
                  required
                  className="tap-target"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-phone">Mobile</Label>
                <Input id="contact-phone" name="phone" type="tel" className="tap-target" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-message">Message</Label>
              <textarea
                id="contact-message"
                name="message"
                required
                rows={4}
                className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
              />
            </div>

            <Button type="submit" size="lg" className="tap-target w-full">
              Send message
            </Button>

            {submitted && (
              <p role="status" className="text-brand-warning text-sm font-medium">
                Form validated. Message delivery is not connected yet (spec task 7C) — nothing has
                been sent. Please use WhatsApp or phone for now.
              </p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Compose the full home page**

`client/src/pages/public/HomePage.tsx`:

```tsx
import CatalogPreview from '@/components/home/CatalogPreview';
import ContactSection from '@/components/home/ContactSection';
import FaqSection from '@/components/home/FaqSection';
import HeroSection from '@/components/home/HeroSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import PackagesSection from '@/components/home/PackagesSection';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import ReviewsSection from '@/components/home/ReviewsSection';
import TrustBar from '@/components/home/TrustBar';
import WhyBookDirect from '@/components/home/WhyBookDirect';

/**
 * Home sections in the order given by BUILD_SPEC.md section 4.
 * Sections 12 (footer) and 13 (floating WhatsApp) live in PublicLayout.
 */
export default function HomePage() {
  return (
    <>
      <HeroSection />
      <TrustBar />
      <CatalogPreview />
      <HowItWorks />
      <WhyBookDirect />
      <MostVisited />
      <PackagesSection />
      <ReviewsSection />
      <PromoNewsletter />
      <FaqSection />
      <ContactSection />
    </>
  );
}
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
pnpm --filter @rg/client test
```

Expected: all of `home.test.tsx`, `layout.test.tsx`, `placeholder-data.test.ts`, and
`no-red.test.ts` PASS.

- [ ] **Step 10: Lint, typecheck, build, commit**

```bash
pnpm lint && pnpm typecheck
ALLOW_PLACEHOLDER_BUILD=1 pnpm --filter @rg/client build
git add client
git commit -m "feat(home): packages, reviews, promo/newsletter, FAQ, contact"
```

**→ After this task, write `✅ DONE` for 2B.**

---

## Task 9: Verification pass

No new features. Verify the whole deliverable against the spec's checklists and fix only what fails.

**Files:**

- Modify: whatever the verification turns up
- Modify: `CLAUDE.md` if any path or script changed

- [ ] **Step 1: Run the full suite**

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Expected: zero errors; all tests pass. Record the actual counts — do not claim a pass without the output.

- [ ] **Step 2: Verify the port constraints**

```bash
pnpm dev
```

Confirm from the output: Vite on **5180**, Express on **3100**, and **no** mention of 5173 or 3000.
Then confirm the proxy and grep for stray ports:

```bash
curl -s http://localhost:5180/api/health
grep -rn "5173\|:3000" --include=*.ts --include=*.tsx --include=*.json --include=*.yaml . | grep -v node_modules
```

Expected: the health JSON; the only grep matches are the deliberate guard checks in
`server/src/env.ts` and `client/vite.config.ts`.

- [ ] **Step 3: Verify the spec's public test checklist (section 14)**

- [ ] Real stats only — every invented value traces to `placeholder-data.ts`, the dev banner is visible under `pnpm dev`, and permits render as "— pending —" rather than invented numbers
- [ ] No red anywhere — `pnpm --filter @rg/client test no-red` passes; also eyeball the running page
- [ ] Mobile layout works at 360px — no horizontal scroll on any section
- [ ] Meta tags render (static baseline only; per-route injection is task 2E)

- [ ] **Step 4: Accessibility pass (spec section 3)**

- [ ] Every `<img>` has non-empty `alt` — `grep -rn "<img" client/src | grep -v "alt="` returns nothing
- [ ] Tab through the page: skip link appears first, focus ring visible on every interactive element, mobile menu reachable and closes
- [ ] Interactive targets ≥44px (`tap-target`, `min-h-11`, or `size-11`+)
- [ ] Exactly one `<h1>`; headings descend without skipping a level
- [ ] Check AA contrast on gold-on-white and white-on-blue pairs; darken to `brand-gold-700` where text is small

- [ ] **Step 5: Confirm the hard boundaries were respected**

```bash
git diff --stat 8986753..HEAD
```

Confirm the diff contains **no** payment logic, **no** auth logic, **no** admin pages, **no**
Drizzle schema or migrations, and **no** deploy configuration.

- [ ] **Step 6: Amend CLAUDE.md if anything drifted**

If scripts, paths, or ports differ from what Task 2 documented, update `CLAUDE.md` to match
reality and commit.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: verification pass for 1A, 1E, 2A, 2B"
```

- [ ] **Step 8: Report**

- `✅ DONE` for each of 1A, 1E, 2A, 2B (written as each finished)
- `✅ HOME PAGE COMPLETE`
- Commits reported as `hash - short human label`
- Any unrelated bugs found, as name + one-line description, then wait for instructions

---

## Open Items (flagged, not blocking)

1. **`emilkowalski-motion` is not installed in this environment.** The available skills are
   `ui-ux-pro-max:*`, `superpowers:*`, `ponytail:*`, `apple-design`, and others — no motion skill
   among them. This plan therefore uses only Tailwind CSS transitions (card hover lift, accordion,
   chevron). Spec task 7G is the real motion pass; by then the skill needs installing, or an
   alternative agreeing.
2. **No approved HTML demo exists.** `demo/` holds only a README. The spec repeatedly says "match
   the approved demo"; with no demo, this plan builds from spec section 4 alone. If a demo appears
   later, sections may need reworking to match it.
3. **Spec open questions 1–6** (assignment deadline, QR strategy, PayPal, SMS, cancellation policy,
   backups) all land in Weeks 3–8 and are deliberately untouched here. No checkout UI is built, so
   no payment-method list is committed to beyond the footer's informational chips.
4. **Per-route meta tags** (`<title>`, description, OG, JSON-LD) are task 2E. `index.html` carries a
   static baseline only.
5. **Real content** — photos, prices, permit numbers, contact details, reviews — is task 8D.
6. **Local MySQL `rg_travel`** is recorded in `.env.example` and `CLAUDE.md` but nothing connects to
   it in this plan. Creating the database is part of task 1B.

---

## Self-Review

**Spec coverage for this scope:**

| Spec requirement                                      | Task             |
| ----------------------------------------------------- | ---------------- |
| 1A client/server/shared, pnpm workspace               | 1, 3, 4          |
| 1A Vite + React + TS + Tailwind + shadcn              | 4                |
| 1A tRPC, Drizzle (config only, per approval)          | 3                |
| 1A ESLint/Prettier                                    | 1                |
| 1A `.env.example`                                     | 1                |
| 1E CLAUDE.md with conventions                         | 2                |
| 2A header                                             | 5                |
| 2A footer with DOT/DTI/BIR + payment logos            | 5                |
| 2A floating WhatsApp                                  | 5                |
| 2A brand tokens blue/gold, no red                     | 4 (+ guard test) |
| 2B §1 hero search + trust line                        | 7                |
| 2B §2 trust bar                                       | 7                |
| 2B §3 catalog preview + destination filter            | 7                |
| 2B §4 how booking works                               | 7                |
| 2B §5 why book direct (6)                             | 7                |
| 2B §6 most visited places (6)                         | 7                |
| 2B §7 packages (3), old vs new price, inquiry         | 8                |
| 2B §8 guest reviews                                   | 8                |
| 2B §9 promo band + newsletter, RGTOURS10 after signup | 8                |
| 2B §10 FAQ (7)                                        | 8                |
| 2B §11 contact us                                     | 8                |
| 2B §12 footer                                         | 5                |
| 2B §13 floating WhatsApp                              | 5                |
| §3 mobile-first, 44px, focus, alt text, AA            | 5, 7, 8, 9       |
| §14 "no red", "real stats only", "360px"              | 4, 6, 9          |
| Ports 5180/3100, never 5173/3000; `rg_travel`         | 1, 2, 3, 4, 9    |

**Out of scope by instruction, confirmed absent:** payments, auth, admin, database schema,
migrations, deployment, catalog page (2C), tour detail (2D), meta injection (2E).

**Placeholder scan:** no TBD/TODO steps; every code step carries real code. The only intentional
stubs are `ToursStubPage` (replaced in 2C) and the Drizzle config's reference to a schema file that
task 1B creates — both called out explicitly where they appear.

**Type consistency:** `cn()`, `trpc`, `AppRouter`, `SITE`, `whatsappLink()`, `SectionHeading`,
`StarRating`, `TourCard`, `PublicLayout`, `PlaceholderBadge`, `formatPeso()`, and every
`placeholder-data.ts` export are defined once and used with the same names and shapes throughout.
`AppRouter` is exported in Task 3 and imported in Task 4. `PLACEHOLDER_SETTINGS.promoCode` is the
single source for `RGTOURS10` in both the component and its test.
