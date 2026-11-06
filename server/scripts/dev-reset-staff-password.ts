/**
 * The fourth door: a LOCAL-ONLY interactive password reset for a staff
 * account (Task 1A; `docs/BUILD_SPEC.md` §12, "Staff password management",
 * owner decision 2026-11-06).
 *
 * The other three doors are in the app — `staffAuth.changePassword`, the
 * owner's `admin.staffUsers.resetPassword`, and forgot-password — and all
 * three need somebody who can already sign in, or a mail server. A developer
 * who has locked themselves out of the local admin has neither, and the habit
 * that fills the gap today is putting a plaintext password back into `.env`
 * and re-seeding. That is precisely the habit the owner's decision exists to
 * kill, so this script is the replacement.
 *
 * Run it as `pnpm --filter @rg/server dev:reset-password`.
 *
 * ## What it will not do
 *
 *  - **It never runs against production** (`NODE_ENV=production` refuses) and
 *    never against anything but the dev app database `rg_travel` — including
 *    `rg_travel_test`, which is the test suite's and not a developer's login.
 *    Both checks happen BEFORE the first prompt and before any read.
 *  - **It never creates an account.** An email with no row is a plain "no such
 *    user" and a non-zero exit; a CLI that quietly created staff accounts
 *    would be a backdoor around `admin.staffUsers.create` and its role gate.
 *  - **The password has exactly one input channel: the hidden prompt.** Not
 *    `argv`, not an environment variable, not a file — not even "just for CI",
 *    because every one of those leaves the password in a shell history, a
 *    process list, or a repository. With no TTY there is no way to read it
 *    without echoing it, so the script refuses instead.
 *  - **Nothing it prints contains the password, the hash, `DATABASE_URL`, or
 *    the database user or password.** The guard messages come from
 *    `db/guard.ts`, which already names only the offending database and the
 *    host:port.
 *
 * ## The login throttle is NOT cleared, because it cannot be
 *
 * Staff login throttling is an in-process `Map` (`byEmail` in
 * `services/staff-auth.ts`), deliberately not a table — see that module's own
 * header for why. There are no lockout or failed-attempt columns on `users`
 * at all. This script is a separate process from the dev server, so it cannot
 * reach that Map either; it prints a line saying how the counter clears
 * instead. **Do not "fix" this by adding a column or a migration** — that
 * would move a deliberate in-memory design into the schema for the sake of a
 * dev convenience.
 */
import { createInterface, type Interface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  APP_DATABASE_NAME,
  assertDatabaseName,
  assertConnectedDatabase,
  databaseNameFromUrl,
} from '../src/db/guard';

/**
 * Everything the "may this run at all?" decision depends on. Kept as plain
 * data so the decision is a pure function a test can call without a terminal,
 * a process or a database — see `src/__tests__/dev-reset-password-guard.test.ts`.
 */
export interface RunEnvironment {
  nodeEnv: string | undefined;
  /** As `databaseNameFromUrl()` reads it: `null` when unparseable. */
  databaseName: string | null;
}

/**
 * Why this script may not run, or `null` when it may. **The only `null` is an
 * explicit pass** — every other path returns a reason, so an unreadable
 * `DATABASE_URL` refuses rather than falling through.
 *
 * The database half is `assertDatabaseName(…, 'app')` itself rather than a
 * second copy of the name rule: the one place that knows which database this
 * project may touch stays the one place, and its message is already written
 * to name the offending database and nothing secret.
 */
export function refuseReason(environment: RunEnvironment): string | null {
  if (environment.nodeEnv === 'production') {
    return (
      'Refusing to run with NODE_ENV=production. This script is a local ' +
      'development tool; on a server use the owner\'s "Reset password" screen.'
    );
  }

  try {
    assertDatabaseName(environment.databaseName, 'app');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return null;
}

/** Non-zero exit with a one-line reason and nothing else. */
function refuse(reason: string): never {
  console.error(`[dev:reset-password] ${reason}`);
  process.exit(1);
}

/**
 * One readline interface for the whole run, with its output writer wrapped so
 * a password can be typed without appearing on screen.
 *
 * `_writeToOutput` is readline's own internal echo hook; suppressing it is
 * the standard no-dependency way to mute a prompt (CLAUDE.md forbids adding
 * `inquirer`/`prompts`/`read` for this). The alternative, `setRawMode`, means
 * re-implementing backspace and Ctrl-C by hand.
 */
function openPrompt(): {
  ask: (q: string) => Promise<string>;
  askHidden: (q: string) => Promise<string>;
  close: () => void;
} {
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const echo = rl as unknown as { _writeToOutput: (chunk: string) => void };
  const write = echo._writeToOutput.bind(rl);
  let muted = false;
  echo._writeToOutput = (chunk: string) => {
    if (!muted) write(chunk);
  };

  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });

  return {
    ask,
    askHidden: async (question: string) => {
      // Written straight to stdout, so the label shows even while the
      // interface's own echo is muted.
      process.stdout.write(question);
      muted = true;
      try {
        return await ask('');
      } finally {
        muted = false;
        // The Enter keystroke's newline was swallowed with everything else.
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  // Imported here, not at the top level, for the same reason `db/guard.ts`
  // imports them lazily: `env.ts` throws at import time when DATABASE_URL is
  // missing, and merely importing this file to call `refuseReason()` in a
  // test must not abort the process.
  const { env } = await import('../src/env');

  const reason = refuseReason({
    nodeEnv: process.env.NODE_ENV,
    databaseName: databaseNameFromUrl(env.DATABASE_URL),
  });
  if (reason) refuse(reason);

  if (!process.stdin.isTTY) {
    refuse(
      'No TTY, so the password cannot be typed without being echoed. ' +
        'Run this in an interactive terminal; there is deliberately no way to ' +
        'pass the password as an argument, a variable or a file.',
    );
  }

  // The URL claimed `rg_travel`; this proves the live connection actually
  // resolved there (a stale alias, a wrong host/port).
  await assertConnectedDatabase('app');

  const [{ getDb }, { users }, { hashPassword }, { revokeSessionsForSubject }, { writeAudit }] =
    await Promise.all([
      import('../src/db/client'),
      import('../src/db/schema'),
      import('../src/services/password'),
      import('../src/services/sessions'),
      import('../src/services/audit'),
    ]);
  const [{ STAFF_LOGIN_WINDOW_MS }, { eq, sql }, { staffEmailSchema, staffPasswordSchema }] =
    await Promise.all([
      import('../src/services/staff-auth'),
      import('drizzle-orm'),
      import('@rg/shared'),
    ]);

  const prompt = openPrompt();
  try {
    console.log(`Resetting a staff password on "${APP_DATABASE_NAME}" (local development).`);

    // An email is not a secret, so this prompt is visible.
    const typedEmail = await prompt.ask('Staff email: ');
    const parsedEmail = staffEmailSchema.safeParse(typedEmail);
    if (!parsedEmail.success) {
      refuse(parsedEmail.error.issues[0]?.message ?? 'Enter a valid email address.');
    }
    const email = parsedEmail.data;

    // Case-insensitively, exactly as `verifyStaffPassword` looks it up — an
    // email this script could not find but the login screen could would be
    // worse than useless.
    const [user] = await getDb()
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${email}`)
      .limit(1);

    if (!user) {
      refuse(
        `No staff account exists for that email on "${APP_DATABASE_NAME}". ` +
          'This script never creates one — add the account in the admin Staff screen.',
      );
    }

    const first = await prompt.askHidden('New password (not shown): ');
    const second = await prompt.askHidden('Confirm new password (not shown): ');
    if (first !== second) {
      refuse('The two passwords do not match. Nothing was changed.');
    }

    // The app's own rule, from the shared schema the admin screens use — not
    // a second copy of the length limits.
    const parsedPassword = staffPasswordSchema.safeParse(first);
    if (!parsedPassword.success) {
      refuse(parsedPassword.error.issues[0]?.message ?? 'That password is not acceptable.');
    }

    const passwordHash = await hashPassword(parsedPassword.data);

    const sessionsRevoked = await getDb().transaction(async (tx) => {
      // Re-read under the row lock: between the lookup above and here the
      // account could have been removed, and an UPDATE matching nothing
      // would otherwise be reported as a successful reset.
      const [locked] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      if (!locked) throw new Error('That staff account no longer exists. Nothing was changed.');

      await tx
        .update(users)
        // `false`, unlike `admin.staffUsers.resetPassword`'s `true`: there the
        // owner types a temporary password FOR SOMEONE ELSE, so the holder must
        // replace it. Here the developer just chose their own password at this
        // prompt, and making them change it again at the next login would be
        // pure friction.
        .set({ passwordHash, mustChangePassword: false })
        .where(eq(users.id, locked.id));

      // The old password may be compromised — that is the usual reason to be
      // standing here — so sessions minted under it must not outlive it.
      // Same transaction as the write that justifies it.
      const revoked = await revokeSessionsForSubject(tx, 'user', locked.id);

      await writeAudit(tx, {
        // There is no authenticated actor at a CLI. Same shape
        // `auth.login_failed` uses for an unauthenticated event.
        actorType: 'system',
        actorId: null,
        action: 'staff.password_reset_cli',
        entity: 'users',
        entityId: locked.id,
        // Never the password, never the hash, never a masked version of either.
        data: { sessionsRevoked: revoked },
      });

      return revoked;
    });

    console.log(
      `Password updated for ${user.email} (user #${user.id}). ` +
        `Sessions ended: ${sessionsRevoked}.`,
    );
    console.log(
      `If the login screen is still refusing you, you are throttled: that counter lives in the ` +
        `dev server's memory, not the database, so it clears after ` +
        `${STAFF_LOGIN_WINDOW_MS / 60_000} minutes or when you restart the dev server.`,
    );
  } finally {
    prompt.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const closeDbQuietly = async () => {
    const { closeDb } = await import('../src/db/client');
    await closeDb();
  };

  main()
    .then(closeDbQuietly)
    .catch(async (error: unknown) => {
      // `.message` only: a raw error object can echo connection details.
      console.error(
        `[dev:reset-password] ${error instanceof Error ? error.message : String(error)}`,
      );
      await closeDbQuietly();
      process.exit(1);
    });
}
