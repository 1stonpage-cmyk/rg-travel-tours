# rg-travel-tours

Online booking & operations system for **TravelSugbo** (Cebu, Philippines), the public trading
brand of the licensed operator **R&G Travel & Tours**. Day tours and multi-day packages.

- Conventions that bind every session: [`CLAUDE.md`](CLAUDE.md)
- Full requirements: [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) — it wins any disagreement
- Launch-day steps and gates: [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md)

## Stack

React 19 + TypeScript + Vite 7 + Tailwind v4 + shadcn/ui · Express 5 + tRPC v11 ·
Drizzle + MySQL 8 · Zod v4 shared between the two. pnpm workspace: `client`, `server`,
`shared`.

## Ports

Kong PMS also runs on the dev machine, so **5173 and 3000 are never used**.

| Process                  | Port                          |
| ------------------------ | ----------------------------- |
| Client (Vite dev server) | **5180** (`strictPort: true`) |
| Server (Express + tRPC)  | **3100**                      |

Vite proxies `/trpc`, `/api`, `/robots.txt` and `/sitemap.xml` to the server.

## Getting started

```bash
pnpm install
cp .env.example .env        # then fill in DATABASE_URL and TEST_DATABASE_URL
```

Two databases, deliberately separate: the app uses **`rg_travel`**, `pnpm test` uses
**`rg_travel_test`**. `server/src/db/guard.ts` refuses to run tests against anything but the
test database, and refuses to touch Kong's.

```bash
pnpm --filter @rg/server db:migrate    # apply migrations to rg_travel (preflight asserts the name)
pnpm --filter @rg/server db:seed       # load the development content from src/db/seed-data.ts
pnpm dev                               # client on 5180, server on 3100, in parallel
```

The `db:*` scripts live in the **server** workspace, so they need the `--filter` — a bare
`pnpm db:seed` from the repo root fails with `Command "db:seed" not found`. There is also
`db:generate` (write a migration from the schema) and `db:push`.

After changing `server/src/db/schema.ts`, run `db:generate`, read the generated SQL, then
`db:migrate` — and remember to apply the same migration to the server database.

## Verifying

All five, from the repo root, in this order:

```bash
pnpm lint
pnpm typecheck
pnpm test                                 # also runs check:coming-soon and check:contact
pnpm format:check
ALLOW_PLACEHOLDER_BUILD=1 pnpm build
```

`pnpm build` is **blocked** without that flag while the database still holds published
`is_sample` reviews or `settings.content_unverified = true` — see
`client/scripts/check-placeholders.mjs` and the launch checklist. The flag is the deliberate
override for local builds and client demos, never for a launch build.

## SEO in development

Per-route `<title>`, meta, canonical, Open Graph and JSON-LD are injected server-side in both
dev and production by the same two modules (`server/src/seo/resolvers.ts` and
`seo/render.ts`). In dev a Vite middleware does the injecting, and it only acts on requests
that ask for HTML:

```bash
curl -s -H "Accept: text/html" http://localhost:5180/ | grep -E '<title>|canonical|preload'
```

A bare `curl` sends `Accept: */*`, falls through to the static shell and shows you no injected
meta at all.
