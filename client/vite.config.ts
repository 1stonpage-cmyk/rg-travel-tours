import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

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
    plugins: [react(), tailwindcss()],
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
      },
    },
    preview: { port: clientPort, strictPort: true },
  };
});
