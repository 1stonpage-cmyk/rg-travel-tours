import { createApp } from './app';
import { env } from './env';

createApp().listen(env.PORT, () => {
  console.log(`[rg-travel-tours] server listening on http://localhost:${env.PORT}`);
});
