import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { TIMEZONE } from '@rg/shared';
import type { SiteEnv } from './env';
import { createHtmlHandler } from './html';
import { createProcedureRateLimit } from './middleware/rate-limit';
import { robotsHeader } from './middleware/robots-header';
import { appRouter } from './routers/_app';
import { robotsTxtHandler, sitemapXmlHandler } from './seo/sitemap';

/**
 * Deliberately NOT imported from ./env — env.ts parses process.env (and
 * .env) at import time, which health.test.ts relies on being avoidable so
 * it can construct an app with no environment configured. Callers that do
 * have env available (see src/index.ts) pass env.PUBLIC_BASE_URL in.
 */
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5180';

/**
 * @param allowedOrigin  CORS origin for the browser client.
 * @param clientDistDir  Pass `client/dist` (see html.ts's CLIENT_DIST_DIR) to
 *   serve the built SPA with SEO meta injected — production only. Omit it and
 *   the app is API-only, which is what every test and the dev server want:
 *   in development Vite serves the HTML and injects the same meta itself
 *   (D6), and there is no `dist` to read.
 * @param siteEnv  Deploy environment for the crawl directives (task 4.3).
 *   Defaults to `'development'`, which is the FAIL-CLOSED value: robots.txt
 *   disallows everything and every response carries `X-Robots-Tag: noindex`.
 *   Only `'production'` can produce an indexable response, and only then with
 *   `settings.content_unverified` cleared. Passed in rather than read from
 *   ./env for the reason given above DEFAULT_ALLOWED_ORIGIN; src/index.ts
 *   supplies `env.SITE_ENV`.
 */
export function createApp(
  allowedOrigin: string = DEFAULT_ALLOWED_ORIGIN,
  clientDistDir?: string,
  siteEnv: SiteEnv = 'development',
) {
  const app = express();

  app.use(express.json());
  // Pinned to the known client origin, not `origin: true` (which reflects
  // any requesting origin). Reflecting + credentials:true lets any website
  // make credentialed cross-origin requests; harmless with no cookies today,
  // but task 1C adds session cookies and this would defeat the sameSite +
  // origin-check CSRF story in CLAUDE.md. credentials stays true for that.
  app.use(cors({ origin: allowedOrigin, credentials: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'rg-travel-tours', timezone: TIMEZONE });
  });

  // Task 1.7 round 1: a generous, unscoped backstop on every /trpc request,
  // mounted ahead of the procedure-scoped limiter below. Enumerating the
  // exact path shapes tRPC's own procedure resolution can take already
  // missed one real case (see middleware/rate-limit.ts) — this backstop
  // means the failure mode for the next shape nobody anticipated is
  // "limited generously," never "unlimited."
  app.use(
    '/trpc',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // The only write endpoints the public site has. Mounted before the tRPC
  // middleware so a limited request never reaches a procedure. See
  // middleware/rate-limit.ts for how the path-matching mirrors tRPC's own
  // procedure-path derivation rather than a hand-rolled guess at it.
  app.use(
    '/trpc',
    createProcedureRateLimit(['inquiries.create', 'newsletter.subscribe'], {
      windowMs: 15 * 60_000,
      max: 5,
    }),
  );

  app.use('/trpc', createExpressMiddleware({ router: appRouter }));

  // -------------------------------------------------------------------------
  // Crawl directives (task 4.3). Mounted here, above the catch-all block
  // below, because `app.get('*splat', ...)` would otherwise answer
  // /robots.txt and /sitemap.xml with the HTML shell.
  //
  // The header middleware sits above both routes and above the static +
  // shell block, so every page response and every asset response under them
  // carries it. /api/health and /trpc are mounted ABOVE it deliberately:
  // they are not indexable page routes, and making a JSON API request wait
  // on a settings read to be told it is not a web page buys nothing.
  // -------------------------------------------------------------------------
  app.use(robotsHeader(siteEnv));
  app.get('/robots.txt', robotsTxtHandler(siteEnv));
  app.get('/sitemap.xml', sitemapXmlHandler());

  // -------------------------------------------------------------------------
  // Static client + SEO-injected HTML shell (task 4.1). MOUNTED LAST, AND IT
  // MUST STAY LAST.
  //
  // Everything above owns a specific prefix (`/api/health`, `/trpc`). The
  // handler below is a CATCH-ALL: `app.get('*splat', ...)` answers every
  // remaining GET path, so anything mounted after it is dead code it has
  // already swallowed.
  //
  // (Task 4.3's /robots.txt and /sitemap.xml are mounted above, as that
  // instruction required. Anything else that answers a path must go there
  // too, not here.)
  //
  // express.static comes first inside the block so real files (/assets/*,
  // /favicon.svg, /placeholders/*) are served as files; only paths with no
  // file behind them fall through to the SPA shell. `index: false` stops
  // static from answering `/` with an un-injected index.html.
  // -------------------------------------------------------------------------
  if (clientDistDir) {
    const serveHtml = createHtmlHandler(clientDistDir);
    app.use(express.static(clientDistDir, { index: false }));
    app.get('*splat', serveHtml); // Express 5 wildcard syntax
  }

  return app;
}
