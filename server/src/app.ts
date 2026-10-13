import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { TIMEZONE } from '@rg/shared';
import { createContext } from './context';
import type { SiteEnv } from './env';
import { createHtmlHandler } from './html';
import { createReceiptRouter } from './routers/receipts';
import { errorHandler } from './middleware/error-handler';
import { rejectMalformedUrl } from './middleware/malformed-url';
import {
  createBookingLookupLimiter,
  createCheckoutHoldLimiter,
  createProcedureRateLimit,
} from './middleware/rate-limit';
import { robotsHeader } from './middleware/robots-header';
import { appRouter } from './routers/_app';
import { createWebhookRouter } from './routers/webhooks';
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

  // Pinned to the known client origin, not `origin: true` (which reflects
  // any requesting origin). Reflecting + credentials:true lets any website
  // make credentialed cross-origin requests; harmless with no cookies today,
  // but task 1C adds session cookies and this would defeat the sameSite +
  // origin-check CSRF story in CLAUDE.md. credentials stays true for that.
  app.use(cors({ origin: allowedOrigin, credentials: true }));

  // Task 4.3b: a path with an undecodable percent-escape (`/trpc/%zz`) gets a
  // short 400 here and goes no further. MOUNTED FIRST of the request handlers
  // — above the limiters, tRPC, the robots header and the SPA block — because
  // every one of those percent-decodes the path and each one leaked something
  // different when it threw (a 500 with a tRPC stack trace, or finalhandler's
  // error page with a stack in it). Below `cors` so the 400 still carries the
  // CORS headers a browser needs to be able to read it. See
  // middleware/malformed-url.ts for why the query string is NOT checked and
  // why skipping the rate limiters is safe here.
  app.use(rejectMalformedUrl());

  // -------------------------------------------------------------------------
  // Gateway webhooks (plan Task 15). MOUNTED HERE, AND THE POSITION IS THE
  // SECURITY PROPERTY — it is sandwiched deliberately:
  //
  //  * ABOVE `express.json()`, which is why that parser moved below this
  //    line. `verifyWebhook` has to hash the EXACT bytes the gateway signed,
  //    and a JSON parser that has already consumed the stream leaves only a
  //    re-serialised object, whose key order and spacing are not what was
  //    signed. Every signature check would then be unverifiable — and a
  //    webhook route that cannot verify a signature is a public endpoint for
  //    marking bookings paid. The route brings its own `express.raw()`.
  //
  //  * BELOW `rejectMalformedUrl()` (task 4.3b), because Express
  //    percent-decodes `:provider` to populate `req.params` and
  //    `/api/webhooks/%zz` would otherwise throw inside the router and leak
  //    finalhandler's error page.
  //
  //  * ABOVE the `app.get('*splat')` catch-all further down, like
  //    /robots.txt and /sitemap.xml. (It is a POST route, so the GET
  //    catch-all would not actually swallow it today — but the ordering rule
  //    in that block's comment is absolute and this route is not the place
  //    to start relying on an exception to it.)
  //
  // Deliberately NOT rate-limited: a gateway retries a delivery until it
  // gets a 2xx, and a limiter here would turn a burst of legitimate retries
  // into lost payment confirmations. The idempotency index (Task 6) is what
  // makes repeated deliveries harmless.
  // -------------------------------------------------------------------------
  app.use('/api/webhooks', createWebhookRouter());

  app.use(express.json());

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

  // Week 3 checkout plan, Task 6, Ruling 5: 5 hold creations per IP per 15
  // minutes on checkout.createHold. See middleware/rate-limit.ts for why
  // this is distinct from the per-guest hold cap in services/create-hold.ts.
  app.use('/trpc', createCheckoutHoldLimiter());

  // Week 3 checkout plan, Task 10, §7: 5 FAILED booking-lookup attempts per
  // IP per 15 minutes on checkout.bookingLookup. See
  // middleware/rate-limit.ts for why this one counts failures only.
  app.use('/trpc', createBookingLookupLimiter());

  /*
   * Cookies, then the context factory that reads them (Week 4, Task 1).
   *
   * Mounted here rather than globally at the top: nothing above this line
   * needs a cookie, and a parser that runs on every static asset request is
   * work for no one. It MUST come before the tRPC middleware, which is what
   * reads `req.cookies` to resolve the session.
   *
   * Until this existed `ctx` was `{}`, so `ctx.session` was always
   * undefined and every `adminProcedure` refused everything — closed, but
   * also never exercised. See `context.ts`.
   */
  /*
   * Receipts (Week 4, Task 3). Mounted with its own cookie parser because
   * it reads the session itself — it answers bytes, not JSON, so it is an
   * Express route rather than a tRPC procedure. Every refusal is the same
   * 404; see the route's own note on why.
   */
  app.use('/api/receipts', cookieParser(), createReceiptRouter());

  app.use('/trpc', cookieParser());
  app.use('/trpc', createExpressMiddleware({ router: appRouter, createContext }));

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
  // Static client + SEO-injected HTML shell (task 4.1). MOUNTED LAST OF THE
  // ROUTES, AND IT MUST STAY LAST OF THEM — only the error handler below it.
  //
  // Everything above owns a specific prefix (`/api/health`, `/trpc`). The
  // handler below is a CATCH-ALL: `app.get('*splat', ...)` answers every
  // remaining GET path, so anything mounted after it is dead code it has
  // already swallowed. The error handler after it is the one exception, and
  // not an exception at all: Express treats a four-argument middleware as an
  // error handler and reaches it only when something threw, so the catch-all
  // has nothing to swallow from it.
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

  // -------------------------------------------------------------------------
  // Plan Task 20 — the app-level error handler. BELOW EVERYTHING, INCLUDING
  // THE SPA CATCH-ALL, AND IT MUST STAY THERE.
  //
  // Express only treats a four-argument middleware as an error handler, and
  // only hands it errors thrown by middleware mounted ABOVE it. Mounted any
  // higher, every route below it keeps leaking finalhandler's HTML error
  // page — which, outside `NODE_ENV=production`, contains the stack trace
  // and absolute filesystem paths. Measured on this app before the mount:
  // `POST /trpc/health` with the body `{bad` answered with
  // `<pre>SyntaxError: ...<br> at parse (C:\dev\rg-travel-tours\
  // node_modules\...\body-parser\lib\types\json.js:91:21)`.
  //
  // It is the third of three doors onto the same leak, and the only one
  // left: `rejectMalformedUrl()` at the top of this function closes the
  // undecodable-URL door (task 4.3b), and tRPC's `errorFormatter` closes the
  // procedure door (BUG-102). This one closes every remaining plain-Express
  // throw.
  //
  // Mounted in EVERY environment, not only production — `pnpm dev:lan`
  // serves the dev app to the LAN, so "it only leaks in development" is not
  // a boundary.
  //
  // It shadows nothing: a route that answers for itself (the 400 above, the
  // webhook route's 404/400/503, /robots.txt) never throws, so this is never
  // reached for it. See __tests__/error-handler.test.ts.
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return app;
}
