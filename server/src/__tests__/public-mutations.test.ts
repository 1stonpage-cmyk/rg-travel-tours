import { afterEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';
import { getDb } from '../db/client';
import { inquiries, newsletterSubscribers } from '../db/schema';
import { env } from '../env';

const caller = appRouter.createCaller(testContext());
const MARK = 'vitest+';

describeWithDb('public mutations', () => {
  afterEach(async () => {
    const db = getDb();
    await db.delete(inquiries).where(like(inquiries.email, `${MARK}%`));
    await db.delete(newsletterSubscribers).where(like(newsletterSubscribers.email, `${MARK}%`));
  });

  it('rejects a malformed email', async () => {
    await expect(
      caller.inquiries.create({
        type: 'contact',
        name: 'A',
        email: 'not-an-email',
        message: 'hello there',
        consent: true,
      }),
    ).rejects.toThrow();
  });

  it('rejects a missing consent checkbox (RA 10173) and stores nothing', async () => {
    const email = `${MARK}a@example.com`;
    await expect(
      caller.inquiries.create({
        type: 'contact',
        name: 'A',
        email,
        message: 'hello there',
        consent: false,
      }),
    ).rejects.toThrow();
    // "Rejects validation" is necessary but not sufficient for RA 10173 —
    // the actual legal requirement is that a non-consenting submission is
    // never stored (round 1 review, cheap fix #2).
    const rows = await getDb().select().from(inquiries).where(eq(inquiries.email, email));
    expect(rows).toHaveLength(0);
  });

  it('rejects an empty message and an over-long one', async () => {
    const base = {
      type: 'contact' as const,
      name: 'A',
      email: `${MARK}a@example.com`,
      consent: true,
    };
    await expect(caller.inquiries.create({ ...base, message: '' })).rejects.toThrow();
    await expect(caller.inquiries.create({ ...base, message: 'x'.repeat(5001) })).rejects.toThrow();
  });

  it('stores a valid inquiry as new', async () => {
    await caller.inquiries.create({
      type: 'contact',
      name: 'Vitest',
      email: `${MARK}ok@example.com`,
      message: 'A valid enquiry.',
      consent: true,
    });
    const rows = await getDb()
      .select()
      .from(inquiries)
      .where(eq(inquiries.email, `${MARK}ok@example.com`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('new');
  });

  it('stores a custom trip request with its transfer-specific fields (T17)', async () => {
    const email = `${MARK}transfer@example.com`;
    await caller.inquiries.create({
      type: 'transfer_custom',
      requestedDate: '2027-01-15',
      pax: 4,
      routeDescription: 'Mactan airport to Oslob',
      name: 'Vitest',
      email,
      message: 'Can you fit a stop in Carcar?',
      consent: true,
    });
    const rows = await getDb().select().from(inquiries).where(eq(inquiries.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('transfer_custom');
    expect(rows[0]?.requestedDate).toBe('2027-01-15');
    expect(rows[0]?.pax).toBe(4);
    expect(rows[0]?.routeDescription).toBe('Mactan airport to Oslob');
    expect(rows[0]?.convertedBookingId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Turnstile (Task 13) — scoped to `type === 'transfer_custom'` ONLY. The
  // second test below is the one that proves the scope: a plain `'contact'`
  // submission with the SAME missing token must still succeed.
  // -------------------------------------------------------------------------

  it('refuses a transfer_custom inquiry when Turnstile is enabled and the token is missing, storing nothing', async () => {
    const email = `${MARK}turnstile-custom@example.com`;
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    try {
      await expect(
        caller.inquiries.create({
          type: 'transfer_custom',
          name: 'Vitest',
          email,
          message: 'Can you take us to Oslob?',
          consent: true,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Please complete the verification and try again.',
      });
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
    const rows = await getDb().select().from(inquiries).where(eq(inquiries.email, email));
    expect(rows, 'a Turnstile refusal must leave no inquiry row').toHaveLength(0);
  });

  it('still accepts a contact inquiry with the SAME missing Turnstile token — the gate is scoped to transfer_custom only', async () => {
    const email = `${MARK}turnstile-contact@example.com`;
    const original = env.TURNSTILE_ENABLED;
    (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = '1';
    try {
      await caller.inquiries.create({
        type: 'contact',
        name: 'Vitest',
        email,
        message: 'Just a general question, no transfer involved.',
        consent: true,
      });
    } finally {
      (env as { TURNSTILE_ENABLED?: string }).TURNSTILE_ENABLED = original;
    }
    const rows = await getDb().select().from(inquiries).where(eq(inquiries.email, email));
    expect(rows, 'a contact inquiry must not be gated by Turnstile').toHaveLength(1);
  });

  it('treats a duplicate newsletter signup as success, not an error', async () => {
    const email = `${MARK}dupe@example.com`;
    const first = await caller.newsletter.subscribe({ email });
    const second = await caller.newsletter.subscribe({ email });
    expect(first.alreadySubscribed).toBe(false);
    expect(second.alreadySubscribed).toBe(true);
    const rows = await getDb()
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(rows).toHaveLength(1);
  });
});
