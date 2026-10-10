/**
 * Production HTML serving: the built SPA shell with per-route meta injected
 * into its `<head>` before it leaves the server.
 *
 * In development this job belongs to the `rg-seo-dev` middleware in
 * client/vite.config.ts, which calls the SAME `resolvePage` + `injectMeta`
 * (plan decision D6) — this file exists only because `vite build` output has
 * to be served by something in production.
 *
 * The shell is read ONCE, when the handler is created at boot. A missing
 * build is therefore a loud startup failure rather than a 500 on the first
 * visitor, and no request pays a filesystem read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from 'express';
import { resolvePage } from './seo/resolvers';
import { injectMeta } from './seo/render';

/** `client/dist` — where `pnpm build` puts the SPA. */
export const CLIENT_DIST_DIR = fileURLToPath(new URL('../../client/dist', import.meta.url));

/**
 * Builds the catch-all handler that answers every non-asset GET with the
 * meta-injected shell and the status the resolver asked for (200, or 404 for
 * an unknown path or slug — task 5B).
 *
 * Fails SOFT, deliberately: if the database is unreachable the visitor gets
 * the un-injected shell and a working client-side site, not an error page.
 * SEO degrades; the business does not stop taking bookings. The log line
 * names only the error's `code` — never the message, which can echo back
 * connection details, and never DATABASE_URL (CLAUDE.md security rules, same
 * reasoning as db/guard.ts).
 */
export function createHtmlHandler(distDir: string = CLIENT_DIST_DIR): RequestHandler {
  const template = readFileSync(join(distDir, 'index.html'), 'utf8');

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    try {
      const meta = await resolvePage(req.path);
      res.status(meta.status).type('html').send(injectMeta(template, meta));
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown error';
      console.error(`[seo] meta injection failed (${code}); serving the unmodified shell.`);
      res.status(200).type('html').send(template);
    }
  };
}
