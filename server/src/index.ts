import { createApp } from './app';
import { env } from './env';

createApp(env.PUBLIC_BASE_URL).listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});
