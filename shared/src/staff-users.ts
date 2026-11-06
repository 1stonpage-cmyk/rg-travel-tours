/**
 * Staff accounts — the shapes the owner's Staff screen and the password
 * screens send (owner decisions 2026-10-23).
 *
 * Every object is `.strict()`: a request carrying an unexpected `isActive`,
 * `mustChangePassword` or `passwordHash` is refused at the input stage rather
 * than quietly ignored, because an input that "drops" a field it was handed
 * looks like it might honour it. The password is never trimmed — it is
 * exactly what was typed.
 */
import { z } from 'zod';
import { adminRoleSchema } from './roles';

/** Same floor as the `.env` owner seed. */
export const STAFF_PASSWORD_MIN_LENGTH = 12;
/** Matches `staffAuth.login`'s ceiling, so a password that can be set can be typed in. */
export const STAFF_PASSWORD_MAX_LENGTH = 200;

/** The one message for a duplicate email, so the screen and the server agree. */
export const STAFF_EMAIL_TAKEN_MESSAGE = 'That email is already used.';

/** The `message` of the refusal an admin procedure gives while a password change is owed. */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';

export const staffEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(200));

export const staffNameSchema = z.string().trim().min(1, 'Enter a name.').max(160);

export const staffPasswordSchema = z
  .string()
  .min(STAFF_PASSWORD_MIN_LENGTH, `Use at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`)
  .max(STAFF_PASSWORD_MAX_LENGTH);

const staffIdSchema = z.number().int().positive();

export const createStaffUserInputSchema = z
  .object({
    email: staffEmailSchema,
    name: staffNameSchema,
    role: adminRoleSchema,
    tempPassword: staffPasswordSchema,
  })
  .strict();
export type CreateStaffUserInput = z.infer<typeof createStaffUserInputSchema>;

export const updateStaffUserInputSchema = z
  .object({ id: staffIdSchema, name: staffNameSchema, role: adminRoleSchema })
  .strict();
export type UpdateStaffUserInput = z.infer<typeof updateStaffUserInputSchema>;

export const setStaffUserActiveInputSchema = z
  .object({ id: staffIdSchema, isActive: z.boolean() })
  .strict();
export type SetStaffUserActiveInput = z.infer<typeof setStaffUserActiveInputSchema>;

export const resetStaffPasswordInputSchema = z
  .object({ id: staffIdSchema, tempPassword: staffPasswordSchema })
  .strict();
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordInputSchema>;

/**
 * `staffAuth.changePassword`. The confirmation field is the screen's job —
 * the server has one new password and no use for a second copy of it.
 */
export const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().min(1).max(STAFF_PASSWORD_MAX_LENGTH),
    newPassword: staffPasswordSchema,
  })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

/* ------------------------------------------------------------------ *
 * Forgot password — §12's third door (owner decision 2026-11-06, 1C).
 * ------------------------------------------------------------------ */

/**
 * The ONE sentence `staffAuth.requestPasswordReset` answers with, for every
 * outcome there is: the account exists, it does not exist, it is
 * deactivated, the throttle refused the request, SMTP is not configured, the
 * send failed. One constant rather than a string typed on both sides,
 * because the whole security property of that procedure is that the response
 * is byte-identical — and two copies of a sentence are two sentences waiting
 * to diverge.
 *
 * It is phrased as a conditional on purpose ("If that email belongs to…"):
 * a staff member who typed their address correctly reads it as "it is
 * coming", and someone probing for staff addresses learns nothing from it.
 */
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'If that email belongs to a staff account, a reset link is on its way. ' +
  'It expires in 30 minutes.';

/**
 * The ONE refusal `staffAuth.resetPassword` gives for an unknown token, an
 * expired one, one already spent, and one belonging to a deactivated
 * account — the same single-refusal rule the login follows, for the same
 * reason: four distinguishable answers make the endpoint an oracle for which
 * links and which accounts are live.
 */
export const PASSWORD_RESET_REFUSED_MESSAGE =
  'That reset link is not valid any more. Ask for a new one.';

/**
 * `.strict()`, like `loginInput`: a request carrying anything else — a
 * `userId`, a `role`, a `token` — is refused at the input stage rather than
 * ignored. `staffEmailSchema` trims and lowercases, so the throttle key and
 * the account lookup agree with every other staff surface.
 */
export const requestPasswordResetInputSchema = z.object({ email: staffEmailSchema }).strict();
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetInputSchema>;

/**
 * The token is a `base64url` encoding of 32 random bytes — 43 characters —
 * so the bounds are generous rather than exact: a length rule here would be
 * a second place that has to agree with `randomBytes(32)`, and it would
 * refuse a link issued by an older deploy. The real check is that the
 * SHA-256 of whatever arrives matches a live row.
 *
 * `newPassword` is `staffPasswordSchema`, the same rule the owner's reset
 * and the voluntary change both use. Not restated here.
 */
export const resetPasswordInputSchema = z
  .object({
    token: z.string().min(1, 'This reset link is incomplete.').max(400),
    newPassword: staffPasswordSchema,
  })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
