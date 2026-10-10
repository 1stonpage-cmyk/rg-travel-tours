import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The two server exports this middleware calls. Duck-typed on purpose: a
 * `typeof import('../server/src/seo/...')` here would pull the whole server
 * source tree (drizzle, mysql2, dotenv) into the CLIENT's tsc program, where
 * none of those packages resolve. The real contract is typed and tested on
 * the server side — see server/src/seo/types.ts.
 */
interface SeoMeta {
  status: number;
}
type ResolvePage = (pathname: string) => Promise<SeoMeta>;
type InjectMeta = (html: string, meta: SeoMeta) => string;

/** Assets, /robots.txt, /sitemap.xml — anything with a file extension is not an SPA route. */
const HAS_FILE_EXTENSION = /\.[^./]+$/;

/**
 * Dev-only SEO middleware: makes `pnpm dev` serve the same injected `<head>`
 * production serves (plan decision D6), so a wrong title is visible locally
 * instead of only after a deploy.
 *
 * `apply: 'serve'` keeps it out of `vite build` entirely, and the server
 * modules are loaded lazily, on the first HTML request — nothing opens a
 * MySQL pool at config load or during a build.
 *
 * Loaded through `server.ssrLoadModule` rather than a plain dynamic
 * `import()`: Vite's config loader bundles a relative dynamic import into the
 * config and HOISTS that module's own bare imports to the config's top level,
 * where `drizzle-orm`/`mysql2`/`dotenv` do not resolve (they are the server
 * package's dependencies, not the client's) — verified, it fails with
 * ERR_MODULE_NOT_FOUND before the dev server even starts. `ssrLoadModule`
 * resolves and transforms those files in place, from the server package's own
 * directory, and re-runs them when they change. (If a future Vite drops it,
 * the replacement is `server.environments.ssr.runner.import()`.)
 *
 * Registered with a direct `.use()`, which Vite installs BEFORE its internal
 * middlewares — it has to be, because Vite's own index.html middleware would
 * otherwise have already answered. That puts it ahead of the proxy too, hence
 * the extension check below: `/robots.txt` and `/sitemap.xml` are navigated to
 * with `Accept: text/html` like any page, and must reach the proxy (and so
 * task 4.3's Express routes), not the SPA shell.
 */
function seoDevMiddleware(): Plugin {
  return {
    name: 'rg-seo-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.headers.accept?.includes('text/html')) return next();

        const url = new URL(req.url, 'http://localhost');
        if (HAS_FILE_EXTENSION.test(url.pathname)) return next();

        void (async () => {
          try {
            const [resolvers, render] = await Promise.all([
              server.ssrLoadModule(resolve(here, '../server/src/seo/resolvers.ts')),
              server.ssrLoadModule(resolve(here, '../server/src/seo/render.ts')),
            ]);
            const resolvePage = resolvers.resolvePage as ResolvePage;
            const injectMeta = render.injectMeta as InjectMeta;

            const meta = await resolvePage(url.pathname);
            const template = await server.transformIndexHtml(
              req.url!,
              readFileSync(resolve(here, 'index.html'), 'utf8'),
            );

            res.statusCode = meta.status;
            res.setHeader('content-type', 'text/html');
            res.end(injectMeta(template, meta));
          } catch (error) {
            // Never let an SEO failure take down the dev server — but never
            // let it fail silently either, or the site runs for days with no
            // meta and nothing says so. Most likely cause: MySQL is down.
            server.config.logger.warn(
              `[rg-seo-dev] meta injection skipped for ${url.pathname}: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            );
            next();
          }
        })();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Env lives at the repo root, one level above /client.
  const env = loadEnv(mode, resolve(here, '..'), '');

  const clientPort = Number(env.CLIENT_PORT ?? 5180);
  const serverPort = Number(env.PORT ?? 3100);

  // Kong PMS owns 5173 and 3000 on this machine.
  for (const [label, port] of [
    ['CLIENT_PORT', clientPort],
    ['PORT', serverPort],
  ] as const) {
    if (port === 5173 || port === 3000) {
      throw new Error(`${label}=${port} belongs to Kong PMS. See CLAUDE.md for the port map.`);
    }
  }

  const apiTarget = `http://localhost:${serverPort}`;

  return {
    plugins: [react(), tailwindcss(), seoDevMiddleware()],
    resolve: {
      alias: {
        '@': resolve(here, 'src'),
        '@rg/shared': resolve(here, '../shared/src'),
      },
    },
    envDir: resolve(here, '..'),
    server: {
      port: clientPort,
      strictPort: true,
      proxy: {
        '/trpc': { target: apiTarget, changeOrigin: true },
        '/api': { target: apiTarget, changeOrigin: true },
        // Task 4.3 serves these from Express; proxied here so dev and
        // production answer the same URLs. The SEO middleware above skips
        // them (they have file extensions) so they reach this proxy.
        '/robots.txt': { target: apiTarget, changeOrigin: true },
        '/sitemap.xml': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { port: clientPort, strictPort: true },
  };
});
