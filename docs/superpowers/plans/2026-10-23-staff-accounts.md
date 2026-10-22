# Staff accounts

Today the only staff account is the owner, seeded from `OWNER_EMAIL` / `OWNER_PASSWORD`.
This feature lets the owner create and manage staff logins (owner / finance / dispatcher)
from the admin.

## Owner decisions (2026-10-23)

1. Staff log in with **email + password**. `/admin/login` and `staffAuth.login` stay.
2. **Only the owner** can list, create, edit, deactivate, reactivate or reset staff accounts.
   A new owner-only area is added to `ROLE_MATRIX`. That is the only role change; no existing
   role is widened, and finance / dispatcher get no staff-management access, not even read.
3. The owner types a **temporary password** on create and on reset. The staff member must
   change it at their next login before they can use anything else.
4. The `.env` `OWNER_EMAIL` / `OWNER_PASSWORD` seed stays, but only creates the first owner
   when no owner exists. It never overwrites an existing account's password or role.
5. Drivers are not part of this. They keep their PIN login and the Drivers screen.

## Constraints

- Password hashing stays scrypt via `node:crypto`; reuse `hashPassword` / `verifyPassword`.
- No hard deletes: `is_active`. No new npm libraries. No red.
- No payment, refund, booking or money logic is touched. Not pushed, not deployed.
- Only `rg_travel` and `rg_travel_test` databases are touched.

## Safety rules (enforced on the server)

- Email trimmed, lowercased, unique; duplicate gives "That email is already used"
  (`isDuplicateKeyError`).
- Password minimum 12 characters; a new password must differ from the current one.
- The owner cannot deactivate themselves or change their own role.
- There is always at least one **active** owner; any deactivate / role change that would leave
  zero is refused.
- Deactivate and password reset delete all of that user's sessions in the same transaction.
- Login for an inactive user gives the same generic error as a wrong password.
- While `must_change_password` is true, every admin procedure refuses (code
  `PASSWORD_CHANGE_REQUIRED`) except `staffAuth.me`, `.logout`, `.changePassword`. Enforced in
  the shared `adminProcedure` middleware, and in the two Express routes that read the session
  themselves (receipts, payment QR).
- `changePassword` needs the current password, is rate-limited like login, clears the flag,
  keeps the current session and kills the user's other sessions.
- Create / role change / deactivate / reactivate / reset / change-password each write an
  `audit_log` row (actor, target user id, action). Passwords never go in the audit row.

## Tasks

| Task | What                                                                      |
| ---- | ------------------------------------------------------------------------- |
| 1A   | Read-only investigation of the existing auth design                       |
| 1B   | Migration `users.must_change_password`; seed creates the first owner only |
| 1C   | `staffUsers` router, `staffAccounts` area, shared Zod schemas             |
| 1D   | `staffAuth.changePassword`, the must-change gate, `me.mustChangePassword` |
| 1E   | Admin Staff screen (owner only)                                           |
| 1F   | "Set a new password" screen, redirects, menu link                         |
| 1G   | Tests, each proven able to fail                                           |
| 1H   | The five checks, browser walkthrough, one independent review              |

## Findings from 1A

- `users` already has `updated_at` and `last_login_at`; only `must_change_password` is missing.
- `ROLE_MATRIX` already has an owner-only `usersSettings` (BUILD_SPEC §9 "Users, settings").
  The new area is separate (`staffAccounts`) so that row's meaning is not changed.
- `role-isolation.test.ts` compares the matrix with the §9 table; it needs to allow the one
  owner-decided area that has no §9 row.
- The seed's `upsertOwner` currently overwrites an existing account by email; 1B replaces that.
