import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { TIMEZONE } from '@rg/shared';
import { createProcedureRateLimit } from './middleware/rate-limit';
import { appRouter } from './routers/_app';

/**
 * Deliberately NOT imported from ./env — env.ts parses process.env (and
 * .env) at import time, which health.test.ts relies on being avoidable so
 * it can construct an app with no environment configured. Callers that do
 * have env available (see src/index.ts) pass env.PUBLIC_BASE_URL in.
 */
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5180';

export function createApp(allowedOrigin: string = DEFAULT_ALLOWED_ORIGIN) {
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

  return app;
}
