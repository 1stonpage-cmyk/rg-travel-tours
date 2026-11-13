/**
 * The ONLY path shape this helper accepts: a same-origin, relative path
 * starting with `/admin` — never a protocol, never `//host/...` (the
 * classic protocol-relative open-redirect), and never a path outside the
 * admin tree. CLAUDE.md: "same-origin relative paths only — no open
 * redirect."
 */
const SAFE_ADMIN_REDIRECT = /^\/admin(?:\/[^\s]*)?$/;

/** The sanitized `?redirect=` value, or `null` when it is missing or unsafe. */
export function sanitizeAdminRedirect(raw: string | null): string | null {
  if (!raw) return null;
  // `/admin/../checkout` matches the regex below (`..` is just more
  // non-whitespace characters to it) and the browser's own path resolution
  // would walk it outside `/admin` — a "path outside /admin" shape same as
  // the ones the regex exists to refuse, so it is refused here explicitly
  // rather than trusted to the router.
  if (raw.includes('..')) return null;
  if (!SAFE_ADMIN_REDIRECT.test(raw)) return null;
  return raw;
}
