/**
 * Week 4 plan, Task 4: the notification layer.
 *
 * §11: "Emails are plain, branded HTML templates. **Failures are logged and
 * never block the booking flow.**" That second sentence is the one with
 * teeth, and it is the test to write first: a guest must never lose a
 * booking because an SMTP server was unreachable, and an admin must never
 * find a payment unverified because a notification threw.
 *
 * Owner decision 2026-10-13 (Week 3 Q2): `nodemailer` over SMTP, Brevo's
 * relay as the intended provider, every value in `.env`, **and a mock
 * transport in tests that never sends real email.** No test here touches a
 * network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFY_EVENTS,
  notify,
  renderTemplate,
  resetTransportForTests,
  setTransportForTests,
  type NotifyEvent,
} from '../services/notify';

interface SentMail {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text: string;
}

const sent: SentMail[] = [];

/** A payload for every event, so the loops below cover all of them. */
const SAMPLE: Record<NotifyEvent, Parameters<typeof notify>[1]> = {
  booking_confirmed: {
    to: 'guest@example.test',
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Sharks',
    tourDate: '2026-11-20',
    totalCentavos: 567800,
    paidCentavos: 567800,
  },
  receipt_received: {
    to: 'guest@example.test',
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Sharks',
    tourDate: '2026-11-20',
    totalCentavos: 567800,
    paidCentavos: 0,
  },
  payment_rejected: {
    to: 'guest@example.test',
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Sharks',
    tourDate: '2026-11-20',
    totalCentavos: 567800,
    paidCentavos: 0,
    reason: 'The screenshot does not show the reference number.',
  },
  admin_receipt_to_verify: {
    to: 'admin@example.test',
    ref: 'RG-7KQ4M9',
    tourTitle: 'Oslob Whale Sharks',
    tourDate: '2026-11-20',
    totalCentavos: 567800,
    paidCentavos: 0,
  },
};

beforeEach(() => {
  sent.length = 0;
  setTransportForTests({
    sendMail: async (message) => {
      sent.push(message as unknown as SentMail);
      return { messageId: 'mock' };
    },
  });
});

afterEach(() => {
  resetTransportForTests();
  vi.restoreAllMocks();
});

describe('notify', () => {
  it('sends to the address it was given, with the ref in the subject', async () => {
    await notify('booking_confirmed', SAMPLE.booking_confirmed);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('guest@example.test');
    expect(sent[0]!.subject).toContain('RG-7KQ4M9');
  });

  /**
   * **The §11 guarantee.** Every event, not just one: a layer that swallows
   * failures for three templates and throws on the fourth is worse than one
   * that always throws, because the one that always throws gets noticed.
   */
  it('NEVER throws when the transport fails — for any event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTransportForTests({
      sendMail: async () => {
        throw new Error('smtp unreachable');
      },
    });

    for (const event of NOTIFY_EVENTS) {
      await expect(notify(event, SAMPLE[event]), `${event} threw`).resolves.toBeUndefined();
    }
    expect(error).toHaveBeenCalledTimes(NOTIFY_EVENTS.length);
  });

  /**
   * Unconfigured is not an error either. The app boots and takes bookings
   * without SMTP credentials — that is how it runs today and during content
   * work — so a missing host logs and returns, exactly as
   * `PaymongoNotConfiguredError` keeps a missing gateway key from being a
   * startup failure.
   */
  it('does not throw, or send, when no transport is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetTransportForTests();

    await expect(notify('booking_confirmed', SAMPLE.booking_confirmed)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * A failure log names the event and the ref so it can be chased, and
   * NOTHING else. Not the rendered body, not the recipient's details, and
   * above all not an SMTP credential — a log line is read by anyone with
   * server access and is often shipped to a third-party aggregator.
   */
  it('logs the event and the ref on failure, and never the body or a secret', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setTransportForTests({
      sendMail: async () => {
        throw new Error('535 authentication failed for user brevo-smtp-key-abc123');
      },
    });

    await notify('booking_confirmed', SAMPLE.booking_confirmed);

    const line = error.mock.calls.flat().map(String).join(' ');
    expect(line).toContain('booking_confirmed');
    expect(line).toContain('RG-7KQ4M9');
    // The rendered HTML must not be in the log.
    expect(line).not.toContain('<html');
    expect(line).not.toContain('<table');
    // Nor the credential the transport error happened to quote.
    expect(line, 'an SMTP error message was logged verbatim, secrets and all').not.toContain(
      'brevo-smtp-key-abc123',
    );
  });
});

describe('renderTemplate', () => {
  it('renders every event with a subject, an HTML body and a text body', () => {
    for (const event of NOTIFY_EVENTS) {
      const mail = renderTemplate(event, SAMPLE[event]);
      expect(mail.subject.length, `${event} has no subject`).toBeGreaterThan(0);
      expect(mail.html.length, `${event} has no html`).toBeGreaterThan(0);
      // A text part is not optional: a mail client without HTML gets this,
      // and its absence is a spam signal on a new sending domain.
      expect(mail.text.length, `${event} has no text part`).toBeGreaterThan(0);
    }
  });

  it('puts the booking ref in every subject — it is how a guest finds the booking', () => {
    for (const event of NOTIFY_EVENTS) {
      expect(renderTemplate(event, SAMPLE[event]).subject).toContain('RG-7KQ4M9');
    }
  });

  /**
   * The brand rule, in email too. `no-red.test.ts` guards the client; an
   * email template is just as visible and is not covered by it, so the check
   * lives here.
   */
  it('uses NO red anywhere, in any template', () => {
    for (const event of NOTIFY_EVENTS) {
      const { html } = renderTemplate(event, SAMPLE[event]);
      expect(html, `${event} contains a red`).not.toMatch(
        /#(ff0000|f00|dc2626|ef4444|e11d48|b91c1c)\b/i,
      );
      expect(html, `${event} names red`).not.toMatch(/\b(red|crimson|firebrick)\b/i);
    }
  });

  /**
   * Money is formatted by `formatPeso()` from @rg/shared and never by
   * string arithmetic here — the same rule the client follows. 567800
   * centavos is ₱5,678.00, and a template that printed "567800" or did its
   * own division would fail this.
   */
  it('formats money as pesos, never as raw centavos', () => {
    const { html, text } = renderTemplate('booking_confirmed', SAMPLE.booking_confirmed);
    expect(html).toContain('5,678');
    expect(text).toContain('5,678');
    expect(html).not.toContain('567800');
  });

  it('shows the rejection reason, because that is the whole point of that email', () => {
    const { html, text } = renderTemplate('payment_rejected', SAMPLE.payment_rejected);
    expect(html).toContain('does not show the reference number');
    expect(text).toContain('does not show the reference number');
  });

  /**
   * An admin notice is an internal message: it names the booking so a
   * verifier can find it, and does NOT carry the guest's contact details,
   * which no admin needs in an inbox to click through to the queue.
   */
  /**
   * The admin notice carries NO email address at all, which is stronger
   * than "not the guest's" and is the version that can fail.
   *
   * The first attempt asserted the guest's address was absent and was
   * vacuous: `NotifyPayload` has no guest-email field, so the admin notice
   * never has one in scope — interpolating `payload.to` puts the ADMIN's
   * address in, which that assertion happily allowed. Caught by the
   * mutation that did exactly that and stayed green.
   *
   * Asserting "no address-shaped string anywhere" catches both, and catches
   * the next person who adds a contact line to be helpful.
   */
  it('puts no email address of any kind in the admin notice', () => {
    const { html } = renderTemplate('admin_receipt_to_verify', SAMPLE.admin_receipt_to_verify);
    expect(html).toContain('RG-7KQ4M9');
    expect(html, 'an email address reached the admin notice body').not.toMatch(
      /[\w.+-]+@[\w-]+\.[\w.]+/,
    );
  });

  it('escapes anything a guest typed, so a reason cannot inject markup', () => {
    const { html } = renderTemplate('payment_rejected', {
      ...SAMPLE.payment_rejected,
      reason: '<script>alert(1)</script> & "quoted"',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
