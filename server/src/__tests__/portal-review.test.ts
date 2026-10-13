/**
 * Week 4 plan, Task 10 — `portal.submitReview` (BUILD_SPEC §7).
 *
 * **The assertion that matters is the last one in the first block: a review
 * a guest just wrote does NOT appear in the public `reviews.published`
 * list.** §7 routes every guest review through `pending` → admin approval,
 * and a guest who could publish straight to the site would be the fake
 * social proof CLAUDE.md forbids, arrived at from the inside. Everything
 * else here is the fence around that.
 */
import { afterAll, afterEach, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import { auditLog, bookings, destinations, reviews, tours, users } from '../db/schema';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { customerContext, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const TOTAL = 500_000;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

let seq = 0;

const GOOD = {
  rating: 5,
  body: 'Pedro was early, the van was spotless and the whale sharks turned up on cue.',
  guide: 5,
  value: 4,
  punctuality: 5,
  safety: 5,
};

async function makeBooking(status: 'completed' | 'confirmed' | 'in_progress' = 'completed') {
  const db = getDb();
  seq += 1;
  const slug = `__review__${seq}_${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [dest] = await db.insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await db
    .insert(tours)
    .values({ slug, title: `Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);

  const ref = generateBookingRef();
  const [booking] = await db.insert(bookings).values({
    ref,
    tourId: tour.insertId,
    tourDate: new Date('2026-06-10T00:00:00Z'),
    pax: 2,
    leadName: 'Maria Santos',
    leadEmail: `review_${slug}@example.test`,
    leadPhone: '09170000000',
    status,
    payMode: 'full',
    priceSnapshot: {
      tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: TOTAL / 2 },
      addons: [],
      coupon: null,
      depositPercent: 30,
      freeCancelHours: 48,
      subtotalCentavos: TOTAL,
      discountCentavos: 0,
      totalCentavos: TOTAL,
    },
    subtotalCentavos: TOTAL,
    totalCentavos: TOTAL,
    amountPaidCentavos: TOTAL,
  });
  created.bookingIds.push(booking.insertId);
  return { bookingId: booking.insertId, ref, tourId: tour.insertId };
}

async function makeStaff() {
  const unique = `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Review Staff ${unique}`,
      email: `review_staff_${unique}@example.test`,
      passwordHash: '__review_fixture_not_a_hash__',
      role: 'owner',
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

const callerFor = (bookingId: number) =>
  appRouter.createCaller(customerContext(bookingId) as never);

async function reviewsFor(bookingId: number) {
  return getDb()
    .select({
      id: reviews.id,
      tourId: reviews.tourId,
      bookingId: reviews.bookingId,
      name: reviews.name,
      rating: reviews.rating,
      guide: reviews.guide,
      value: reviews.value,
      punctuality: reviews.punctuality,
      safety: reviews.safety,
      body: reviews.body,
      status: reviews.status,
      isSample: reviews.isSample,
    })
    .from(reviews)
    .where(eq(reviews.bookingId, bookingId));
}

afterEach(async () => {
  // Reviews are this suite's own rows and are removed between tests so the
  // "one per booking" check starts from a known state.
  if (created.bookingIds.length > 0) {
    await getDb().delete(reviews).where(inArray(reviews.bookingId, created.bookingIds));
  }
});

afterAll(async () => {
  const pool = getPool();
  if (created.bookingIds.length > 0) {
    await getDb().delete(reviews).where(inArray(reviews.bookingId, created.bookingIds));
  }
  await getDb()
    .delete(auditLog)
    .where(sql`${auditLog.action} = 'review.submitted'`);
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
    await getDb().delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await getDb().delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

describeWithDb('portal.submitReview — what it writes', () => {
  it('writes ONE pending review, verified by its booking, never a sample', async () => {
    const mine = await makeBooking();

    await expect(callerFor(mine.bookingId).portal.submitReview(GOOD)).resolves.toEqual({
      status: 'pending',
    });

    const rows = await reviewsFor(mine.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tourId: mine.tourId,
      bookingId: mine.bookingId,
      // The booking's own name, not one the browser could send.
      name: 'Maria Santos',
      rating: 5,
      guide: 5,
      value: 4,
      punctuality: 5,
      safety: 5,
      body: GOOD.body,
      // §7: pending, then an admin.
      status: 'pending',
      isSample: false,
    });
  });

  /**
   * **The one that matters.** A guest's review must not reach the public
   * list until an admin moves it. Asserted through the real public query,
   * not by reading the column.
   */
  it('does NOT appear in the public reviews list until an admin publishes it', async () => {
    const mine = await makeBooking();
    await callerFor(mine.bookingId).portal.submitReview(GOOD);

    const publicApi = appRouter.createCaller(testContext() as never);
    const before = await publicApi.reviews.published({});
    expect(
      before.items.some((item) => item.body === GOOD.body),
      'a guest published straight to the site',
    ).toBe(false);

    // An admin publishes it — the only thing that may.
    await getDb()
      .update(reviews)
      .set({ status: 'published' })
      .where(eq(reviews.bookingId, mine.bookingId));

    const after = await publicApi.reviews.published({});
    expect(
      after.items.some((item) => item.body === GOOD.body),
      'an approved review still did not appear',
    ).toBe(true);
  });

  it('audits the submission as pending, by the guest', async () => {
    const mine = await makeBooking();
    await callerFor(mine.bookingId).portal.submitReview(GOOD);

    const [row] = await getDb()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        data: auditLog.data,
      })
      .from(auditLog)
      .where(eq(auditLog.action, 'review.submitted'))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);

    expect(row!.actorType).toBe('customer');
    expect(row!.actorId).toBeNull();
    expect(JSON.stringify(row!.data)).toContain(mine.ref);
    expect(JSON.stringify(row!.data)).toContain('pending');
  });

  it('accepts a review with no sub-scores at all', async () => {
    const mine = await makeBooking();
    await expect(
      callerFor(mine.bookingId).portal.submitReview({
        rating: 4,
        body: 'Good trip, we would book again with this team.',
      }),
    ).resolves.toEqual({ status: 'pending' });

    const rows = await reviewsFor(mine.bookingId);
    expect(rows[0]).toMatchObject({ guide: null, value: null, punctuality: null, safety: null });
  });
});

describeWithDb('portal.submitReview — who may, and when', () => {
  it('REFUSES a caller with no session', async () => {
    const api = appRouter.createCaller(testContext() as never);
    await expect(api.portal.submitReview(GOOD)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REFUSES a staff session', async () => {
    const api = appRouter.createCaller(staffContext(await makeStaff(), 'owner') as never);
    await expect(api.portal.submitReview(GOOD)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /** §7: after `completed`. Not before, however paid the booking is. */
  it('REFUSES a booking that is not completed, writing nothing', async () => {
    for (const status of ['confirmed', 'in_progress'] as const) {
      const booking = await makeBooking(status);
      await expect(
        callerFor(booking.bookingId).portal.submitReview(GOOD),
        `a ${status} booking was allowed to review`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await reviewsFor(booking.bookingId)).toHaveLength(0);
    }
  });

  /** One per booking, refused rather than silently merged. */
  it('REFUSES a second review for the same booking', async () => {
    const mine = await makeBooking();
    await callerFor(mine.bookingId).portal.submitReview(GOOD);

    await expect(
      callerFor(mine.bookingId).portal.submitReview({ ...GOOD, rating: 1, body: GOOD.body }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await reviewsFor(mine.bookingId);
    expect(rows, 'a second review was written').toHaveLength(1);
    expect(rows[0]!.rating, 'the first review was overwritten').toBe(5);
  });

  /** And the page stops offering the form once there is one. */
  it('stops offering a review once one exists', async () => {
    const mine = await makeBooking();
    expect((await callerFor(mine.bookingId).portal.booking()).canReview).toBe(true);

    await callerFor(mine.bookingId).portal.submitReview(GOOD);

    expect(
      (await callerFor(mine.bookingId).portal.booking()).canReview,
      'the page would invite a second review the server refuses',
    ).toBe(false);
  });
});

describeWithDb('portal.submitReview — the input boundary', () => {
  it('REFUSES a rating outside one to five', async () => {
    const mine = await makeBooking();
    for (const rating of [0, 6, -1, 2.5]) {
      await expect(
        callerFor(mine.bookingId).portal.submitReview({ ...GOOD, rating }),
        `a rating of ${rating} was accepted`,
      ).rejects.toThrow();
    }
    expect(await reviewsFor(mine.bookingId)).toHaveLength(0);
  });

  it('REFUSES a sub-score outside one to five', async () => {
    const mine = await makeBooking();
    for (const field of ['guide', 'value', 'punctuality', 'safety'] as const) {
      await expect(
        callerFor(mine.bookingId).portal.submitReview({ ...GOOD, [field]: 9 }),
        `${field} 9 was accepted`,
      ).rejects.toThrow();
      await expect(
        callerFor(mine.bookingId).portal.submitReview({ ...GOOD, [field]: 0 }),
        `${field} 0 was accepted`,
      ).rejects.toThrow();
    }
    expect(await reviewsFor(mine.bookingId)).toHaveLength(0);
  });

  it('REFUSES a body that is empty or far too long', async () => {
    const mine = await makeBooking();
    for (const body of ['', '   ', 'short', 'x'.repeat(2001)]) {
      await expect(
        callerFor(mine.bookingId).portal.submitReview({ ...GOOD, body }),
        `a ${body.length}-character body was accepted`,
      ).rejects.toThrow();
    }
    expect(await reviewsFor(mine.bookingId)).toHaveLength(0);
  });

  /**
   * **The fields a guest may not set.** `status` would publish straight to
   * the site, `bookingId` would be an IDOR, `name` would let one guest
   * sign another's review, `isSample` would dodge the production content
   * guard. The schema is `.strict()`, so every one of them is refused at
   * the door rather than ignored.
   */
  it('REFUSES any field the server owns', async () => {
    const mine = await makeBooking();
    const theirs = await makeBooking();
    const forbidden = [
      { status: 'published' },
      { bookingId: theirs.bookingId },
      { tourId: theirs.tourId },
      { name: 'Somebody Else' },
      { isSample: true },
      { reply: 'thanks!' },
    ];
    for (const extra of forbidden) {
      await expect(
        callerFor(mine.bookingId).portal.submitReview({ ...GOOD, ...extra } as never),
        `${Object.keys(extra)[0]} was accepted from the browser`,
      ).rejects.toThrow();
    }
    expect(await reviewsFor(mine.bookingId)).toHaveLength(0);
    expect(await reviewsFor(theirs.bookingId)).toHaveLength(0);
  });

  it('trims the body it stores', async () => {
    const mine = await makeBooking();
    await callerFor(mine.bookingId).portal.submitReview({
      rating: 5,
      body: '   A genuinely lovely day out with the family.   ',
    });
    expect((await reviewsFor(mine.bookingId))[0]!.body).toBe(
      'A genuinely lovely day out with the family.',
    );
  });
});
