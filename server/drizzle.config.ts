import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle configuration only. The schema itself (spec section 10) and the first
 * migration are task 1B — `./src/db/schema.ts` does not exist yet, so
 * `db:generate` will correctly report that there is nothing to generate.
 *
 * The database MUST be named `rg_travel`, separate from Kong PMS's database.
 */
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
