import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cors from 'cors';
import express from 'express';
import { TIMEZONE } from '@rg/shared';
import { appRouter } from './routers/_app';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cors({ origin: true, credentials: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'rg-travel-tours', timezone: TIMEZONE });
  });

  app.use('/trpc', createExpressMiddleware({ router: appRouter }));

  return app;
}
