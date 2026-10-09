import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

config({ path: resolve(process.cwd(), '../.env'), quiet: true });

/** Ports owned by Kong PMS on this machine. Using them is a hard error. */
const FORBIDDEN_PORTS = [3000, 5173];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // development | preview | production. Controls robots.txt and X-Robots-Tag (task 5D).
  SITE_ENV: z.enum(['development', 'preview', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1),
  // Dedicated database for `pnpm test` (task 1.4b) — never rg_travel. Only
  // required when tests actually run; optional here so booting the server
  // or seeding the app database doesn't need it configured.
  TEST_DATABASE_URL: z.string().optional(),
  UPLOADS_DIR: z.string().default('./uploads'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5180'),
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
