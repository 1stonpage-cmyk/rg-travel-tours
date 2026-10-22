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
