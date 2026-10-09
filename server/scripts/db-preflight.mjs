#!/usr/bin/env node
// Runs before every db:migrate / db:push / db:seed. Kong PMS shares this
// MySQL server, so a wrong DATABASE_URL is not a failed query — it is a
// migration running against someone else's production data.
//
// Plain JS on purpose (no tsx): this needs to fail fast before any
// TypeScript is loaded or any drizzle-kit command touches the database.
// Mirrors the name check in server/src/db/guard.ts — keep them in sync.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '../.env') });

const REQUIRED_DATABASE_NAME = 'rg_travel';

function databaseNameFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`\n[rg-travel-tours] Database check failed.\n  ${message}\n`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  fail('DATABASE_URL is not set. Refusing to run a migration with no target database.');
} else {
  const name = databaseNameFromUrl(databaseUrl);
  if (name !== REQUIRED_DATABASE_NAME) {
    fail(
      `Refusing to run against database ${name ? `"${name}"` : '(none)'}. ` +
        `This project may only touch "${REQUIRED_DATABASE_NAME}". ` +
        `Check DB_NAME in .env — Kong PMS shares this MySQL server.`,
    );
  } else {
    console.log(`[rg-travel-tours] Database check passed (${REQUIRED_DATABASE_NAME}).`);
  }
}
