/**
 * `inquiries.create` — office notification + guest acknowledgement
 * (owner decision 2026-11-11, Task 1C). Before this task the mutation sent
 * no mail at all; it only inserted a row.
 *
 * A separate file from `public-mutations.test.ts` rather than an extension
 * of it: that file covers validation/consent/Turnstile shape, none of which
 * this task touches, and this file is specifically about the two new
 * sender calls — keeping them apart means a reviewer can see the whole
 * email behaviour in one place.
 *
 * Follows `receipt-upload.test.ts`'s own pattern for asserting "this went
 * to the business inbox, not the guest's" — the office recipient is read
 * from `settings.contact.email` AT TEST TIME via `readSettingBlock`, never
 * hardcoded, so a later change to the seeded address does not make this
 * suite lie.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';
import { getDb } from '../db/client';
import { inquiries } from '../db/schema';
import { env } from '../env';
import { readSettingBlock } from '../content/settings';
import {
  resetInquiryAckThrottleForTests,
  resetTransportForTests,
  setTransportForTests,
} from '../services/notify';

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const caller = appRouter.createCaller(testContext());
const MARK = 'vitest+inquiry-notify+';

const sent: SentMail[] = [];

beforeEach(() => {
  sent.length = 0;
  resetInquiryAckThrottleForTests();
  setTransportForTests({
    sendMail: async (message) => {
      sent.push(message as unknown as SentMail);
      return { messageId: 'mock' };
    },
  });
});

afterEach(async () => {
  resetTransportForTests();
  resetInquiryAckThrottleForTests();
  await getDb()
    .delete(inquiries)
    .where(like(inquiries.email, `${MARK}%`));
});

async function officeEmail(): Promise<string> {
  const contact = await readSettingBlock('contact');
  return contact.email;
}

describeWithDb(
  'inquiries.create — office + guest-ack email (owner decision 2026-11-11, 1C)',
  () => {
    it('sends an office mail on EVERY contact inquiry, subject "New message from <name>"', async () => {
      const office = await officeEmail();
      const email = `${MARK}contact@example.com`;

      await caller.inquiries.create({
        type: 'contact',
        name: 'Juana Dela Cruz',
        email,
        phone: '09171234567',
        message: 'Do you run a Bohol day tour?',
        consent: true,
      });

      const officeMails = sent.filter((m) => m.to === office);
      expect(officeMails).toHaveLength(1);
      expect(officeMails[0]!.subject).toBe('New message from Juana Dela Cruz');
      for (const mail of [officeMails[0]!.text, officeMails[0]!.html]) {
        expect(mail).toContain('Juana Dela Cruz');
        expect(mail).toContain(email);
        expect(mail).toContain('09171234567');
        expect(mail).toContain('contact');
        expect(mail).toContain('Do you run a Bohol day tour?');
        expect(mail).toContain(`${env.PUBLIC_BASE_URL}/admin/packages`);
      }
    });

    it('sends an office mail on a transfer_custom inquiry, subject "New trip request from <name>", with the transfer-only fields present', async () => {
      const office = await officeEmail();
      const email = `${MARK}transfer@example.com`;

      await caller.inquiries.create({
        type: 'transfer_custom',
        requestedDate: '2027-02-10',
        pax: 6,
        routeDescription: 'Mactan airport to Oslob',
        name: 'Pedro Santos',
        email,
        message: 'Need a van for 6 pax.',
        consent: true,
      });

      const officeMails = sent.filter((m) => m.to === office);
      expect(officeMails).toHaveLength(1);
      expect(officeMails[0]!.subject).toBe('New trip request from Pedro Santos');
      for (const mail of [officeMails[0]!.text, officeMails[0]!.html]) {
        expect(mail).toContain('2027-02-10');
        expect(mail).toContain('6');
        expect(mail).toContain('Mactan airport to Oslob');
      }
    });

    it('omits the transfer_custom-only rows entirely from a contact submission — no "Trip date: null"-shaped row', async () => {
      const office = await officeEmail();
      const email = `${MARK}no-optionals@example.com`;

      await caller.inquiries.create({
        type: 'contact',
        name: 'Ana Reyes',
        email,
        message: 'Just a question, no transfer fields at all.',
        consent: true,
      });

      const officeMails = sent.filter((m) => m.to === office);
      expect(officeMails).toHaveLength(1);
      for (const mail of [officeMails[0]!.text, officeMails[0]!.html]) {
        expect(mail).not.toMatch(/trip date/i);
        expect(mail).not.toMatch(/pax/i);
        expect(mail).not.toMatch(/route/i);
        expect(mail).not.toMatch(/null/i);
      }
    });

    it('sends the guest acknowledgement with the exact owner-specified sentence and the first name only', async () => {
      const email = `${MARK}ack@example.com`;

      await caller.inquiries.create({
        type: 'contact',
        name: 'Maria Clara Santos',
        email,
        message: 'Hello there.',
        consent: true,
      });

      const ackMails = sent.filter((m) => m.to === email);
      expect(ackMails).toHaveLength(1);
      const expected =
        'Thanks, Maria — we got your message and will reply within business hours ' +
        '(Mon–Sun, 7:00 AM–9:00 PM PHT).';
      expect(ackMails[0]!.text).toContain(expected);
      expect(ackMails[0]!.html).toContain(expected);
    });

    /**
     * Anti-spam-relay. A guest could put a distinctive payload (text a spammer
     * wants echoed, or a URL pointing at a third party) into `message` hoping
     * this system's own outbound mail relays it back to the `email` address —
     * which could itself be a victim's, not the submitter's own. The
     * acknowledgement must carry NOTHING from the guest except their first
     * name.
     */
    it('never echoes the guest message text or a URL they typed, in either the acknowledgement html or text', async () => {
      const email = `${MARK}anti-relay@example.com`;
      const distinctive = 'ZZZ-DISTINCTIVE-PAYLOAD-99887';
      const url = 'http://evil-payload.example.test/track';

      await caller.inquiries.create({
        type: 'contact',
        name: 'Carlos',
        email,
        phone: '09170000000',
        message: `${distinctive} please visit ${url} right away`,
        consent: true,
      });

      const ackMails = sent.filter((m) => m.to === email);
      expect(ackMails).toHaveLength(1);
      for (const mail of [ackMails[0]!.text, ackMails[0]!.html]) {
        expect(mail).not.toContain(distinctive);
        expect(mail).not.toContain(url);
        expect(mail).not.toMatch(/https?:\/\//);
        expect(mail).not.toContain('09170000000');
      }
    });

    it('caps the guest acknowledgement at one per email per hour — the row and the office mail are unaffected', async () => {
      const office = await officeEmail();
      const email = `${MARK}cap@example.com`;

      await caller.inquiries.create({
        type: 'contact',
        name: 'Rico First',
        email,
        message: 'First message.',
        consent: true,
      });
      await caller.inquiries.create({
        type: 'contact',
        name: 'Rico Second',
        email,
        message: 'Second message, same hour.',
        consent: true,
      });

      // Both rows were written — the cap never touches the insert.
      const rows = await getDb().select().from(inquiries).where(eq(inquiries.email, email));
      expect(rows).toHaveLength(2);

      // Both office mails were sent — the cap never touches the office path.
      expect(sent.filter((m) => m.to === office)).toHaveLength(2);

      // Only ONE acknowledgement reached the guest.
      expect(sent.filter((m) => m.to === email)).toHaveLength(1);
    });
  },
);
