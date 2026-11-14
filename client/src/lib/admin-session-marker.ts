/**
 * Whether this browser has ever confirmed a valid admin session — the
 * client-side-only signal that lets AdminLayout's redirect distinguish "a
 * session existed and then expired" from "never signed in at all" (owner QA,
 * 2026-11-14). The server cannot make this distinction itself: both cases
 * surface as the identical UNAUTHORIZED error.
 */
const ADMIN_HAD_SESSION_KEY = 'ts-admin-had-session';

/** Call once `staffAuth.me` has resolved successfully. */
export function recordAdminSessionConfirmed(): void {
  try {
    localStorage.setItem(ADMIN_HAD_SESSION_KEY, '1');
  } catch {
    // Private browsing / storage disabled — degrade to "never had a session",
    // which is the safer default (never show "expired" to someone who can't
    // prove they were ever signed in).
  }
}

/** True only if `recordAdminSessionConfirmed()` has run in this browser before. */
export function hadAdminSessionBefore(): boolean {
  try {
    return localStorage.getItem(ADMIN_HAD_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}
