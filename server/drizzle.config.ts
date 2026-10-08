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
