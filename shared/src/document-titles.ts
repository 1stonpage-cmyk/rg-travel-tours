/**
 * The page names the SERVER injects and the BROWSER re-asserts, in one place.
 *
 * ## Why this module exists
 *
 * CLAUDE.md's SEO rule is "two surfaces, one implementation — never build
 * meta in a surface". Until now there were two surfaces (`server/src/html.ts`
 * in production, the `rg-seo-dev` middleware in dev) and both read
 * `seo/resolvers.ts`, so the rule held on its own.
 *
 * The SPA is now a third reader. Nothing set `document.title` client-side, so
 * the title stayed whatever was injected for the path the SPA was first
 * loaded at: a driver who signed in at `/driver/login` and walked to an
 * itinerary kept one title all shift, and a guest who clicked from
 * `/privacy` to `/terms` kept reading "Privacy Notice". The fix is a
 * client-side write — but a client-side MAP of title strings would be
 * exactly the drifting third copy the rule forbids. So the words live here,
 * in `@rg/shared`, and `seo/resolvers.ts` and the React layouts both read
 * them.
 *
 * ## What is NOT here, and why
 *
 * Only the titles no database row owns. `/` (from `settings.site_seo`),
 * `/tours/:slug` and `/packages/:slug` (from each row's `seo_title`, with a
 * composed fallback) are resolved from the database by the server and the
 * browser has no access to those values — the client passes `null` for them
 * and leaves the injected title standing, which is exactly today's
 * behaviour. Descriptions, canonicals, Open Graph and JSON-LD stay entirely
 * in the resolver: none of them is a thing a browser tab shows.
 *
 * Every value here is the bare page name. The brand suffix is appended by
 * each reader (`| ${BRAND}` server-side, `| ${SITE.name}` in the client) so
 * the join is not written twice either.
 */

/**
 * What each app surface calls itself, keyed by the path prefixes the
 * `X-Robots-Tag` middleware treats as private.
 *
 * Titles name a place, not a status ("Driver portal", not "Please sign in"):
 * the tab is what a driver looks at for a whole shift, and the page behind
 * it changes from sign-in to itinerary. The brand, not the licensed
 * operator — a tab title is customer-facing copy.
 *
 * `seo/resolvers.ts` keeps its own `Record` typed against
 * `NOINDEX_PATH_PREFIXES`, so a surface added there without an entry here is
 * still a compile error rather than a crash on a driver's phone.
 */
export const APP_SURFACE_TITLES = {
  '/driver': 'Driver portal',
  '/admin': 'Staff console',
  '/portal': 'My booking',
  /*
   * BUG-116: `/checkout/:tourSlug` and `/booking/:ref` are real public SPA
   * routes with no entry in the route table, so they fell through to
   * `notFoundMeta` and were served HTTP 404, "Page not found", for their
   * entire visit. Added to `NOINDEX_PATH_PREFIXES`
   * (`server/src/middleware/robots-header.ts`) alongside the three above —
   * these two are genuinely public (no auth), unlike the other three, but
   * noindexed for the same thin-content / personal-data reason
   * (`/checkout` holds a lead guest's name, email and phone; `/booking`
   * looks a stay up by reference). "My booking" is already `/portal`'s
   * title, hence "Booking status" rather than a second "My booking".
   */
  '/checkout': 'Checkout',
  '/booking': 'Booking status',
} as const;

/**
 * The public routes whose title is a fixed navigational or legal name rather
 * than a database row: the catalog index and the four legal pages.
 *
 * Keyed by the exact pathname, which is what `useLocation()` hands the
 * client and what `absoluteUrl()` is given server-side.
 */
export const STATIC_PUBLIC_TITLES = {
  '/tours': 'Cebu Day Tours',
  '/privacy': 'Privacy Notice',
  '/terms': 'Terms of Service',
  '/refund-policy': 'Cancellation & Refund Policy',
  '/cookies': 'Cookie Policy',
} as const;

export type StaticPublicPath = keyof typeof STATIC_PUBLIC_TITLES;
