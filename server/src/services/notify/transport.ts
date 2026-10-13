/**
 * The SMTP transport (Week 4 plan, Task 4).
 *
 * Owner decision 2026-10-13 (Week 3 Q2): `nodemailer` over SMTP, Brevo's
 * relay as the intended provider, **every value in `.env`** so the provider
 * swaps without a code change, and **no other email library**.
 *
 * ## Lazy, like the database pool
 *
 * Importing this module must never open a socket. `getTransport()` builds
 * one on first use, so a process that never sends an email never connects —
 * and `db/client.ts` follows the same rule for the same reason: an import
 * with a side effect makes every test that touches the module graph depend
 * on a network.
 *
 * ## Unconfigured is a normal state, not an error
 *
 * The app boots and takes bookings with no SMTP credentials at all — that
 * is how it runs during content work, and how it runs right now. So a
 * missing `SMTP_HOST` returns `null` rather than throwing, exactly as a
 * missing PayMongo key produces `PaymongoNotConfiguredError` at the point
 * of use instead of failing startup. §11's "failures never block the
 * booking flow" starts here.
 */
import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../env';

/** The one method this layer uses. Narrowed so a test mock is three lines. */
export interface MailTransport {
  sendMail(message: {
    from?: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

let cached: MailTransport | null | undefined;
let override: MailTransport | undefined;

/**
 * Replaces the transport for a test. Every test uses this: §11's own rule
 * is that a failure must not block a booking, and the only honest way to
 * test that is to make sending fail on purpose — which means never touching
 * a real server.
 */
export function setTransportForTests(transport: MailTransport): void {
  override = transport;
}

/** Drops the override AND the cache, so the next call re-reads the env. */
export function resetTransportForTests(): void {
  override = undefined;
  cached = undefined;
}

/** The transport, or `null` when SMTP is not configured. */
export function getTransport(): MailTransport | null {
  if (override) return override;
  if (cached !== undefined) return cached;

  if (!env.SMTP_HOST) {
    cached = null;
    return cached;
  }

  cached = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Brevo's relay is 587.
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
  }) as unknown as Transporter as MailTransport;

  return cached;
}

/** The envelope sender. §0: anything financial or regulatory names the operator. */
export function mailFrom(): string {
  return env.MAIL_FROM ?? 'TravelSugbo <noreply@travelsugbo.com>';
}
