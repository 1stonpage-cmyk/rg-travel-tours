import { getSettingsPayload } from '../../content/settings';
import { publicProcedure, router } from '../../trpc';

export const settingsRouter = router({
  /** The resolved `SettingsPayload` — see content/settings.ts for why this, not the raw `SettingsBlocks`, is what the browser gets. */
  get: publicProcedure.query(() => getSettingsPayload()),
});
