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
 * Run it as `pnpm --filter @rg/server dev:reset-password`, with
 * `ALLOW_DEV_PASSWORD_RESET=1` in your local `.env`.
 *
 * ## What it will not do
 *
 *  - **It never runs against production.** FOUR independent checks, all of
 *    them BEFORE the first prompt and before any read: `NODE_ENV` is not
 *    `production`, `SITE_ENV` is not `production`, `ALLOW_DEV_PASSWORD_RESET`
 *    is exactly `'1'`, and the database is `rg_travel` — not
 *    `rg_travel_test`, which is the test suite's and not a developer's login.
 *    `refuseReason()` documents what each one is actually for; the short
 *    version is that the two obvious ones (`NODE_ENV`, the database name) are
 *    the two that a real production shell would walk straight past.
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
  /** `process.env.NODE_ENV` — unset on a VPS shell, hence not load-bearing alone. */
  nodeEnv: string | undefined;
  /** `env.SITE_ENV`, which genuinely lives in the deployed `.env`. */
  siteEnv: string | undefined;
  /** `env.ALLOW_DEV_PASSWORD_RESET`; only the exact string `'1'` permits a run. */
  allowDevPasswordReset: string | undefined;
  /** As `databaseNameFromUrl()` reads it: `null` when unparseable. */
  databaseName: string | null;
}

/**
 * Why this script may not run, or `null` when it may. **The only `null` is an
 * explicit pass** — every other path returns a reason, so an unreadable
 * `DATABASE_URL` or a missing opt-in refuses rather than falling through.
 *
 * FOUR independent checks, each with its own message naming which one failed,
 * following `seedDemo()`'s pattern for the same problem (see CLAUDE.md on
 * `ALLOW_DEMO_SEED`). They are not interchangeable, and the two obvious ones
 * are the two weakest:
 *
 *  - **The database name does not protect production**, because production's
 *    own database is also named `rg_travel` (`APP_DATABASE_NAME`). It only
 *    catches a genuinely FOREIGN database — Kong PMS's, or a `DATABASE_URL`
 *    typo.
 *  - **`NODE_ENV` does not protect production either.** `docs/LAUNCH_CHECKLIST.md`
 *    sets `NODE_ENV=production` in the **PM2 environment**, and `.env.example`
 *    deliberately keeps `NODE_ENV` out of `.env`, so on an interactive SSH
 *    shell on the VPS — exactly where someone would run this — it is unset.
 *  - **`SITE_ENV` does**, because the checklist requires it in the deployed
 *    `.env` itself (LAUNCH_CHECKLIST.md's "SITE_ENV=production is set in the
 *    deployed .env"), which `env.ts`'s dotenv load reads in any shell. It
 *    defaults to `development`, so it fails closed locally rather than
 *    needing to be set on every dev box.
 *  - **`ALLOW_DEV_PASSWORD_RESET=1` is the deliberate opt-in**, the barrier
 *    that holds even if a server's `.env` is somehow missing `SITE_ENV`.
 *
 * Do not drop one as redundant: each covers a case the others do not.
 *
 * The database check is `assertDatabaseName(…, 'app')` itself rather than a
 * second copy of the name rule: the one place that knows which database this
 * project may touch stays the one place, and its message is already written
 * to name the offending database and nothing secret.
 */
export function refuseReason(environment: RunEnvironment): string | null {
  if (environment.nodeEnv === 'production') {
    return (
      'Refusing to run with NODE_ENV=production. This script is a local ' +
      'development tool; on a server use the owner\'s "Reset password" screen ' +
      'or the self-service "Forgot password" link.'
    );
  }

  if (environment.siteEnv === 'production') {
    return (
      'Refusing to run with SITE_ENV=production. This script is a local ' +
      'development tool; on a server use the owner\'s "Reset password" screen ' +
      'or the self-service "Forgot password" link.'
    );
  }

  if (environment.allowDevPasswordReset !== '1') {
    return (
      'Refusing to run without ALLOW_DEV_PASSWORD_RESET=1. Set it in your ' +
      'LOCAL .env only — never on a server — and run this again.'
    );
  }

  try {
    assertDatabaseName(environment.databaseName, 'app');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return null;
}

/**
 * Stops the run with a one-line reason.
 *
 * It THROWS rather than calling `process.exit()`, which is what the first
 * version did: `process.exit()` from inside the `try` skipped the `finally`
 * that closes the readline interface and the handler that closes the database
 * pool, and can truncate output already queued to a redirected stderr. The
 * top-level handler prints exactly the same single line and exits 1.
 */
function refuse(reason: string): never {
  throw new Error(reason);
}

export interface Prompt {
  /** A visible prompt: the answer is echoed as it is typed. */
  ask: (question: string) => Promise<string>;
  /** A hidden prompt: the label shows, the typed value never does. */
  askHidden: (question: string) => Promise<string>;
  close: () => void;
}

/**
 * One readline interface for the whole run, with its line writer wrapped so a
 * password can be typed without appearing on screen.
 *
 * `_writeToOutput` is readline's own internal echo hook, and replacing it is
 * the no-dependency way to mute a prompt (CLAUDE.md forbids adding
 * `inquirer`/`prompts`/`read` for this). The alternative, driving
 * `setRawMode` directly, means re-implementing backspace and Ctrl-C by hand.
 *
 * **The muted writer re-emits the LABEL, it does not write nothing.** Writing
 * nothing was the first version's bug: readline sends its line-refresh
 * escapes (`ESC[1G` to column 1, `ESC[0J` erase-to-end) **straight to
 * `output`**, bypassing this hook, and only the line TEXT comes through it.
 * So a hook that returned early erased the label it had just printed and drew
 * nothing back, and the developer typed a password into a blank line. Emitting
 * `question` on every refresh keeps the label on screen while the typed value
 * still never renders.
 *
 * `_writeToOutput` is a private readline API and the bug above is proof it is
 * not a stable contract: if a future Node moves the line text off this hook,
 * muting fails OPEN — the password would echo. That is why
 * `dev-reset-password-prompt.test.ts` drives this function over a
 * `PassThrough` and asserts on the real captured bytes, rather than trusting
 * it. `input`/`output` are parameters for exactly that reason.
 */
export function openPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompt {
  const rl: Interface = createInterface({ input, output, terminal: true });

  const echo = rl as unknown as { _writeToOutput: (chunk: string) => void };
  const write = echo._writeToOutput.bind(rl);
  /** The label to draw in place of the line while a password is being typed. */
  let maskWith: string | null = null;
  echo._writeToOutput = (chunk: string) => {
    if (maskWith === null) {
      write(chunk);
      return;
    }
    /*
     * Two kinds of chunk arrive while masked, and they need opposite answers
     * — measured in a real console, where emitting the label for both
     * reprinted it once per keystroke across the whole terminal:
     *
     *  - a FULL LINE draw (`prompt + line`), from `_refreshLine()` — the
     *    initial prompt, a backspace, an arrow key, a wrap. The erase escapes
     *    that precede it bypass this hook, so the label must be redrawn here
     *    or it is wiped off the screen.
     *  - a SINGLE CHARACTER, from `_insertString()`'s fast path when the
     *    cursor is at the end of the line. Nothing is erased first, so the
     *    right answer is to write nothing at all.
     */
    write(chunk.startsWith(maskWith) ? maskWith : '');
  };

  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });

  return {
    ask,
    askHidden: async (question: string) => {
      maskWith = question;
      try {
        return await ask(question);
      } finally {
        maskWith = null;
        // The Enter keystroke's own newline went through the muted hook with
        // everything else, so the next line starts here.
        output.write('\n');
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
    siteEnv: env.SITE_ENV,
    allowDevPasswordReset: env.ALLOW_DEV_PASSWORD_RESET,
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
      .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${email}`)
      .limit(1);

    if (!user) {
      refuse(
        `No staff account exists for that email on "${APP_DATABASE_NAME}". ` +
          'This script never creates one — add the account in the admin Staff screen.',
      );
    }

    // Who was found, before a password is typed for them — the email was
    // matched case-insensitively, so this is also the confirmation that the
    // row is the intended one.
    console.log(
      `Found: ${user.name} <${user.email}> (user #${user.id})${user.isActive ? '' : ' — DEACTIVATED'}`,
    );
    if (!user.isActive) {
      // `verifyStaffPassword` checks `is_active` AFTER the hash and refuses
      // regardless of the password, so a new password alone changes nothing
      // for this account. Saying so here, before the prompts, is the
      // difference between a confusing "updated" and a useful one.
      console.warn(
        'WARNING: this account is deactivated, so the sign-in screen will refuse it ' +
          'whatever its password is. Reactivate it on the admin Staff screen as well, ' +
          'or press Ctrl-C now.',
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
    if (!user.isActive) {
      console.warn(
        'Reminder: the account is still deactivated, so this password cannot sign in yet.',
      );
    }
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
