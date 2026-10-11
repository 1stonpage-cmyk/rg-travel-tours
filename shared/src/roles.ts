/**
 * Admin roles, shared by client and server.
 *
 * Money is handled in integer CENTAVOS everywhere; this module handles
 * nothing but the role vocabulary.
 */
import { z } from 'zod';

/**
 * The three admin roles in BUILD_SPEC §9's permission matrix, and nothing
 * else. There is deliberately no "admin" or "superuser": `owner` is the
 * all-areas role, and adding a fourth silently grants it nothing until the
 * matrix in require-role.ts is updated too.
 */
export const ADMIN_ROLES = ['owner', 'dispatcher', 'finance'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const adminRoleSchema = z.enum(ADMIN_ROLES);
