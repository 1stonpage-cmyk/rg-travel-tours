import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

/**
 * Drizzle configuration only. The schema itself (spec section 10) and the first
 * migration are task 1B — `./src/db/schema.ts` does not exist yet, so
 * `db:generate` currently exits 1 with "No schema files found" (drizzle-kit
 * treats an empty schema glob as an error, not a silent no-op). Expected
 * until task 1.2 adds the schema file.
 *
 * The database MUST be named `rg_travel`, separate from Kong PMS's database.
 *
 * drizzle-kit is invoked with cwd=server/, where there is no .env — the repo's
 * only .env lives at the repo root. Load it explicitly (same path env.ts
 * uses) or every drizzle-kit command sees no DATABASE_URL at all.
 */
config({ path: resolve(process.cwd(), '../.env'), quiet: true });

// No fallback connection string here — ever. A missing DATABASE_URL must
// stop the command, not silently connect as root (CLAUDE.md: never root).
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Refusing to fall back to a root connection — see CLAUDE.md.',
  );
}

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
