import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

config({ path: resolve(process.cwd(), '../.env'), quiet: true });

/** Ports owned by Kong PMS on this machine. Using them is a hard error. */
const FORBIDDEN_PORTS = [3000, 5173];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // development | preview | production. Controls robots.txt and X-Robots-Tag (task 5D).
  SITE_ENV: z.enum(['development', 'preview', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1),
  // Dedicated database for `pnpm test` (task 1.4b) — never rg_travel. Only
  // required when tests actually run; optional here so booting the server
  // or seeding the app database doesn't need it configured.
  TEST_DATABASE_URL: z.string().optional(),
  UPLOADS_DIR: z.string().default('./uploads'),
  /*
   * Email (Week 4, Task 4; owner Q2 2026-10-13 — nodemailer over SMTP).
   * ALL OPTIONAL, for the same reason the PayMongo keys are: the app must
   * boot and take bookings with no mail server configured, which is how it
   * runs during content work. `notify()` logs and returns instead of
   * throwing, so a missing host can never block a booking (§11).
   *
   * `SMTP_PASSWORD` keeps the name `.env.example` has carried since task
   * 7E rather than the `SMTP_PASS` of the owner's note — renaming it would
   * silently break an already-configured `.env` for no gain.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  /*
   * The first owner account, read by the seed (Week 4, Task 5). Both
   * optional so `pnpm test` can seed `rg_travel_test` without
   * production-shaped config; `upsertOwner()` in `db/seed.ts` refuses if
   * one is set without the other, or if the password is under 12
   * characters. NEVER defaulted, never logged.
   */
  OWNER_EMAIL: z.string().optional(),
  OWNER_PASSWORD: z.string().optional(),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5180'),
  /*
   * The origin allowed to make state-changing requests (Week 4, Task 5;
   * owner instruction 2026-10-14). Production is `https://travelsugbo.com`;
   * outside production the Vite dev server on 5180 is allowed as well, which
   * is why the default is harmless and the production value must be set.
   * See `middleware/origin-check.ts`.
   */
  APP_ORIGIN: z.string().default('http://localhost:5180'),
  // PayMongo (plan Task 16). BOTH OPTIONAL, deliberately: the app must still
  // boot without payment credentials — that is how it runs today and how it
  // runs during content work — so a missing key is not a startup failure.
  // `createCheckout()` throws `PaymongoNotConfiguredError` instead, which
  // makes a misconfigured deploy fail loudly at the first payment rather
  // than silently at boot; and `verifyWebhook()` answers false with no
  // webhook secret, so an unverifiable webhook can never mark a booking
  // paid. Never logged, never sent to the client, never stored.
  PAYMONGO_SECRET_KEY: z.string().optional(),
  PAYMONGO_WEBHOOK_SECRET: z.string().optional(),
});

/**
 * Deploy environment, as `robots.txt` and `X-Robots-Tag` see it (task 4.3).
 * Exported as a type so `seo/sitemap.ts` and `middleware/robots-header.ts`
 * can name it without importing the parsed `env` value (and its
 * import-time process.env read) just for a union of three strings.
 */
export type SiteEnv = z.infer<typeof schema>['SITE_ENV'];

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment:', z.treeifyError(parsed.error));
  throw new Error('Invalid environment configuration');
}

if (FORBIDDEN_PORTS.includes(parsed.data.PORT)) {
  throw new Error(
    `PORT ${parsed.data.PORT} belongs to Kong PMS. Use 3100 for this project (see CLAUDE.md).`,
  );
}

export const env = parsed.data;
