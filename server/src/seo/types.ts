/**
 * The contract between "what should this URL say about itself" (seo/resolvers.ts)
 * and "how does that reach the browser" (seo/render.ts, html.ts, and the dev-only
 * middleware in client/vite.config.ts).
 *
 * Deliberately a plain data shape with no HTML in it: every surface that injects
 * meta — the production Express handler and the Vite dev middleware — renders the
 * SAME `PageMeta` through the SAME `injectMeta()`, which is what makes dev and
 * production behave identically (plan decision D6). A resolver that returned
 * markup instead would let the two drift.
 */

/**
 * A responsive image this route should start fetching at HTML-parse time,
 * rendered as `<link rel="preload" as="image">` by `injectMeta`.
 *
 * Per-route on purpose (task 4.4b): the shared SPA shell is one file, so a
 * preload hard-coded into `client/index.html` is served on `/tours`,
 * `/privacy` and `/terms` too, where the hero never renders — wasted bytes on
 * a mobile connection and Chrome's "preloaded but not used" warning.
 */
export type ImagePreload = {
  /** `type` — the MIME type of every candidate, so an unsupporting browser skips it. */
  type: string;
  /** `imagesrcset` — the candidate list. Must match the `<source srcSet>` that consumes it. */
  srcset: string;
  /** `imagesizes` — must match that same `<source sizes>`. */
  sizes: string;
};

/** Everything the `<head>` of one URL needs, resolved from the database. */
export type PageMeta = {
  /** `<title>` and `og:title`. Already the final, display-ready string — never a template. */
  title: string;
  /** `<meta name="description">`, `og:description`, `twitter:description`. */
  description: string;
  /** Absolute URL (`PUBLIC_BASE_URL` + normalised path). Also used for `og:url`. */
  canonical: string;
  /** Absolute image URL, or null when nothing in the fallback chain exists. Never a relative path. */
  ogImage: string | null;
  ogType: 'website' | 'article';
  /**
   * Schema.org nodes for this page, one per `<script type="application/ld+json">`.
   * Empty until task 4.2 fills it; `injectMeta` emits nothing for an empty array.
   */
  jsonLd: unknown[];
  /**
   * The LCP image to preload on this route, or null for a route that renders
   * none. Only `/` sets it today — it is the only route with a hero.
   */
  preload: ImagePreload | null;
  /** The HTTP status the shell must be served with — 404 for an unknown path or slug. */
  status: 200 | 404;
  /**
   * `<meta name="robots">`. Only `noindex,nofollow` is emitted as a tag;
   * `index,follow` is the crawler default and needs no markup.
   */
  robots: 'index,follow' | 'noindex,nofollow';
};

/**
 * Resolves one route pattern to its `PageMeta`.
 *
 * Takes only the path params (`{ slug }` for `/tours/:slug`, `{}` for a static
 * route) — never the raw pathname, so a resolver cannot accidentally echo an
 * attacker-chosen URL into a canonical tag. Each resolver builds its own
 * canonical from its own pattern.
 */
export type Resolver = (params: Record<string, string>) => Promise<PageMeta>;
