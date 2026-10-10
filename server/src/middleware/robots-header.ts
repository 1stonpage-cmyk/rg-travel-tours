/**
 * `X-Robots-Tag` — the HTTP-header half of task 4.3's crawl directives.
 *
 * Two independent reasons a URL must not be indexed, and this middleware
 * enforces both:
 *
 *  1. **The path is not public.** `/admin`, `/driver` and `/portal` are
 *     operational surfaces. They are behind auth, but auth is not a crawl
 *     directive: a crawler that is handed a URL by a browser extension, a
 *     pasted link or a leaked email can still try it, and the login page it
 *     gets back is a perfectly indexable HTML document. The header is what
 *     keeps it out of the index.
 *  2. **The whole site is not ready.** While `settings.content_unverified`
 *     is true the database holds placeholder tours, placeholder prices and
 *     `is_sample` reviews; having that indexed is worse than not being
 *     indexed at all. The same goes for any non-production deploy.
 *
 * The header, not just the `<meta>` tag, because a header covers responses
 * that have no `<head>` to put a tag in — JSON, images, PDFs — and because
 * Google honours it on every response type. The meta tag is still emitted
 * too, by the existing `seo/render.ts` pipeline (see `resolvePage`).
 *
 * Fails CLOSED in every direction: a non-production `siteEnv`, an unreadable
 * `content_unverified` (which `readContentUnverified` already resolves to
 * "unverified") and a thrown flag read all end in `noindex, nofollow`. The
 * only way to get an indexable response is to be in production, with the
 * content flag explicitly cleared, on a public path.
 */
import type { RequestHandler } from 'express';
import { readContentUnverified } from '../content/settings';
import type { SiteEnv } from '../env';

/**
 * Path prefixes that are never indexable, in any environment.
 *
 * Matched on segment boundaries, so `/administrators` is NOT covered by
 * `/admin` — a prefix string match would quietly noindex a future public
 * page whose path happens to start with these letters.
 *
 * These are also the `Disallow:` lines in the production robots.txt (see
 * seo/sitemap.ts). Add the booking surfaces here as they land: `/checkout`
 * and the confirmation pages are a thin-content, personal-data noindex for
 * exactly the same reasons.
 */
export const NOINDEX_PATH_PREFIXES = ['/admin', '/driver', '/portal'] as const;

/**
 * The one header value this project emits. Spelled with the space, which is
 * the form Google's documentation uses for `X-Robots-Tag`; the `<meta>` tag
 * keeps its own unspaced `noindex,nofollow` (see seo/types.ts) so neither
 * value has to be reformatted for the other surface.
 */
export const NOINDEX_TAG = 'noindex, nofollow';

/** True when `pathname` is inside one of the non-public surfaces. */
export function isPrivatePath(pathname: string): boolean {
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  return NOINDEX_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The `X-Robots-Tag` value for one request, or null when the response may be
 * indexed — `index, follow` is every crawler's default and a header saying so
 * is noise that can only go wrong.
 *
 * Pure, so both halves of the policy are testable without a database, an
 * Express app or an environment variable.
 */
export function robotsTagValue(
  pathname: string,
  siteEnv: SiteEnv,
  contentUnverified: boolean,
): string | null {
  if (siteEnv !== 'production' || contentUnverified) return NOINDEX_TAG;
  return isPrivatePath(pathname) ? NOINDEX_TAG : null;
}

/**
 * The middleware. `readFlag` is injectable so tests can drive both states
 * without writing to the database, and so a future caller could swap the
 * source; production passes nothing and gets the cached settings read.
 */
export function robotsHeader(
  siteEnv: SiteEnv,
  readFlag: () => Promise<boolean> = readContentUnverified,
): RequestHandler {
  return async (req, res, next) => {
    let contentUnverified = true; // fail closed if the read itself throws
    try {
      contentUnverified = await readFlag();
    } catch {
      // `readContentUnverified` already resolves failures to `true`; this
      // only covers an injected reader that rejects. Nothing is logged here
      // because nothing is known here — the reader owns its own reporting,
      // and a message built from an unknown error could echo connection
      // details into the log.
    }

    const value = robotsTagValue(req.path, siteEnv, contentUnverified);
    if (value) res.setHeader('X-Robots-Tag', value);

    next();
  };
}
