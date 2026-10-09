import { afterEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { describeWithDb } from './helpers/db';
import { appRouter } from '../routers/_app';
import { getDb } from '../db/client';
import { inquiries, newsletterSubscribers } from '../db/schema';

const caller = appRouter.createCaller({});
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
