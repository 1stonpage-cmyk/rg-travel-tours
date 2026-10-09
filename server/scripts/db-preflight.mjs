#!/usr/bin/env node
// Runs before every db:migrate / db:push / db:seed — all three only ever
// target the app database. Kong PMS shares this MySQL server, so a wrong
// DATABASE_URL is not a failed query — it is a migration running against
// someone else's production data.
//
// Plain JS on purpose (no tsx): this needs to fail fast before any
// TypeScript is loaded or any drizzle-kit command touches the database.
// Mirrors the context-aware check in server/src/db/guard.ts (task 1.4b) —
// keep them in sync. This script only ever runs for the 'app' context
// (there is no db-preflight equivalent for tests: the test suite's own
// global setup — server/src/__tests__/global-setup.ts — asserts the 'test'
// context before it migrates or seeds rg_travel_test).
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '../.env') });

const APP_DATABASE_NAME = 'rg_travel';

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

/** Mirrors guard.ts's assertDatabaseName(name, 'app') — called explicitly
 *  with the 'app' context since that is the only context this script is
 *  ever used for. */
function assertAppDatabaseName(name) {
  if (name === APP_DATABASE_NAME) return;
  fail(
    `Refusing to run against database ${name ? `"${name}"` : '(none)'} in "app" context. ` +
      `This project may only touch "${APP_DATABASE_NAME}" here. ` +
      `Check DB_NAME in .env — Kong PMS shares this MySQL server.`,
  );
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  fail('DATABASE_URL is not set. Refusing to run a migration with no target database.');
} else {
  assertAppDatabaseName(databaseNameFromUrl(databaseUrl));
  console.log(`[rg-travel-tours] Database check passed (${APP_DATABASE_NAME}).`);
}
