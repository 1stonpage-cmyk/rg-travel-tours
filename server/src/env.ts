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
