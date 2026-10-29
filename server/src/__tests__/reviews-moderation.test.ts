/**
 * Week 7 plan, Task 10 — `admin.reviews.*` and `reviews.forTour`: the
 * moderation queue, the publish/hide decision, the operator's reply, and the
 * public reviews block they feed (BUILD_SPEC §4 "Reviews", §9 "Reviews
 * moderation").
 *
 * **The load-bearing assertions are the two that connect moderation to the
 * public site**: a pending review is invisible to `reviews.forTour` until an
 * admin publishes it, and hiding a published one takes it back off. Everything
 * else here is the fence around that — the role gate (§9 gives reviews to
 * owner and dispatcher, never finance), one audit row per decision, and
 * refusals that write nothing.
 *
 * Role refusals are asserted on `code`, never on the message — the pattern
 * `admin-coupons.test.ts` and `admin-drivers.test.ts` already follow, because
 * `requireRole()` throws messages that name neither UNAUTHORIZED nor FORBIDDEN
 * and a regex on prose can pass against broken code.
 *
 * **Teardown.** `reviews` is not in the leak detector's `LEAK_TABLES`, and that
 * is exactly why every row here is tracked by id: a stray PUBLISHED review
 * changes `displayAggregate()` — and therefore a tour card's star rating — for
 * every other suite in the run. Removal is in FK order: votes, audit rows,
 * reviews, bookings, tours, destinations, users.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { REVIEW_REPLY_MAX } from '@rg/shared';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookings,
  destinations,
  reviewHelpfulVotes,
  reviews,
  tours,
  users,
} from '../db/schema';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/** An id no review in this database ever has. Swept from `audit_log` too. */
const NOT_FOUND_SENTINEL_ID = 2_000_000_100;

const TOTAL = 400_000;

const created = {
  reviewIds: [] as number[],
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}_${Math.floor(Math.random() * 1e9)}_${Date.now()}`;
};

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
/** The suite-wide tour. Tests that count reviews make their own instead. */
let tourId = 0;
let tourSlug = '';

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const publicApi = () => appRouter.createCaller(testContext() as never);

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Review mod ${role} ${suffix}`,
      email: `revmod_${role}_${suffix}@example.test`,
      passwordHash: '__revmod_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

/** This file's own tour, so the seeded catalog's six are left alone. */
async function makeTour() {
  const slug = `__revmod__${unique()}`;
  const [dest] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(dest.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({ slug, title: `Review Mod Tour ${slug}`, destinationId: dest.insertId });
  created.tourIds.push(tour.insertId);
  return { id: tour.insertId, slug };
}

/** A completed booking — what makes a review "verified". */
async function makeCompletedBooking() {
  const ref = generateBookingRef();
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref,
      tourId,
      tourDate: new Date('2026-06-10T00:00:00Z'),
      pax: 2,
      leadName: 'Maria Santos',
      leadEmail: `revmod_${unique()}@example.test`,
      leadPhone: '09170000000',
      status: 'completed',
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
  created.bookingIds.push(row.insertId);
  return { id: row.insertId, ref };
}

/**
 * A review row written straight to the table.
 *
 * Direct rather than through `portal.submitReview`, because this suite is
 * about what moderation does to a review that is already there — and because
 * a review with NO booking (an admin-entered one) is a shape the portal
 * cannot produce at all.
 */
async function makeReview(
  opts: {
    tourId?: number | null;
    status?: 'pending' | 'published' | 'hidden';
    bookingId?: number | null;
    rating?: number;
    body?: string;
    isSample?: boolean;
  } = {},
) {
  const [row] = await getDb()
    .insert(reviews)
    .values({
      tourId: opts.tourId === undefined ? tourId : opts.tourId,
      bookingId: opts.bookingId ?? null,
      name: 'Maria Santos',
      rating: opts.rating ?? 5,
      guide: 5,
      value: 4,
      punctuality: 5,
      safety: 5,
      body: opts.body ?? `Moderation fixture review ${unique()}.`,
      status: opts.status ?? 'pending',
      isSample: opts.isSample ?? false,
    });
  created.reviewIds.push(row.insertId);
  return row.insertId;
}

async function reviewRow(id: number) {
  const [row] = await getDb().select().from(reviews).where(eq(reviews.id, id));
  return row;
}

async function auditRowsFor(reviewId: number) {
  return getDb()
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      data: auditLog.data,
    })
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'reviews'), eq(auditLog.entityId, reviewId)))
    .orderBy(asc(auditLog.id));
}

beforeAll(async () => {
  ownerId = await makeStaff('owner');
  dispatcherId = await makeStaff('dispatcher');
  financeId = await makeStaff('finance');
  const tour = await makeTour();
  tourId = tour.id;
  tourSlug = tour.slug;
}, 60_000);

afterAll(async () => {
  const db = getDb();
  const pool = getPool();

  const auditEntityIds = [...created.reviewIds, NOT_FOUND_SENTINEL_ID];
  await db
    .delete(auditLog)
    .where(and(eq(auditLog.entity, 'reviews'), inArray(auditLog.entityId, auditEntityIds)));
  if (created.reviewIds.length > 0) {
    await db
      .delete(reviewHelpfulVotes)
      .where(inArray(reviewHelpfulVotes.reviewId, created.reviewIds));
    await db.delete(reviews).where(inArray(reviews.id, created.reviewIds));
  }

  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'customer',
      id,
    ]);
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.entity, 'bookings'), eq(auditLog.entityId, id)));
    // Raw parameterised SQL, not `db.delete(bookings)` — `schema-conventions
    // .test.ts` scans the server tree for the Drizzle form of a bookings
    // hard-delete and exempts only the raw form in a test file.
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  if (created.tourIds.length > 0) {
    await db.delete(tours).where(inArray(tours.id, created.tourIds));
  }
  if (created.destIds.length > 0) {
    await db.delete(destinations).where(inArray(destinations.id, created.destIds));
  }
  for (const id of created.userIds) {
    await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
      'user',
      id,
    ]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  }
});

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

describeWithDb('admin.reviews.queue', () => {
  it('lists a pending review with its tour, its booking ref and the verified flag', async () => {
    const booking = await makeCompletedBooking();
    const id = await makeReview({ bookingId: booking.id, body: 'Queue fixture with a booking.' });

    const queue = await ownerApi().admin.reviews.queue();
    const mine = queue.find((row) => row.id === id);
    expect(mine, 'the pending review must be in the queue').toBeDefined();
    expect(mine).toMatchObject({
      status: 'pending',
      name: 'Maria Santos',
      rating: 5,
      guide: 5,
      value: 4,
      punctuality: 5,
      safety: 5,
      body: 'Queue fixture with a booking.',
      reply: null,
      repliedAt: null,
      isSample: false,
      verified: true,
      tourId,
      bookingRef: booking.ref,
    });
    expect(Number.isNaN(Date.parse(mine!.createdAt))).toBe(false);
  });

  /**
   * The badge is `booking_id IS NOT NULL` and nothing else — so an
   * admin-entered review, which has no booking, is NOT verified. The rule in
   * both directions, and the reason a seeded sample never wears the badge.
   */
  it('reports verified: false, and a null ref, for a review with no booking behind it', async () => {
    const id = await makeReview({ bookingId: null });
    const mine = (await ownerApi().admin.reviews.queue()).find((row) => row.id === id);
    expect(mine).toMatchObject({ verified: false, bookingRef: null });
  });

  /**
   * The PENDING one is created first on purpose. `created_at` is a MySQL
   * `DATETIME` with second precision, so two fixtures made in the same second
   * share an instant and the tiebreak is `id DESC` — which means the fallback
   * newest-first ordering alone would put the LATER, published review on top.
   * Only the pending-first clause can satisfy this assertion.
   *
   * (Written the other way round first, where it passed with that clause
   * deleted — a test that cannot fail is a bug, so the order was swapped.)
   */
  it('puts pending reviews ahead of decided ones', async () => {
    const pending = await makeReview({ status: 'pending' });
    const published = await makeReview({ status: 'published' });

    const ids = (await ownerApi().admin.reviews.queue()).map((row) => row.id);
    expect(ids.indexOf(pending)).toBeLessThan(ids.indexOf(published));
    // And the fixture order really is what it claims to be.
    expect(published).toBeGreaterThan(pending);
  });

  it('shows decided reviews too, which is the only place a hidden one is visible', async () => {
    const hidden = await makeReview({ status: 'hidden' });
    expect((await ownerApi().admin.reviews.queue()).some((row) => row.id === hidden)).toBe(true);
  });

  it('lists the seeded samples, and none of them is verified', async () => {
    const samples = (await ownerApi().admin.reviews.queue()).filter((row) => row.isSample);
    expect(
      samples.length,
      'the seed publishes sample reviews, so some must be listed',
    ).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.verified, 'a seeded sample has no booking and must never be verified').toBe(
        false,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * setStatus — and what the public site then sees
 * ------------------------------------------------------------------ */

describeWithDb('admin.reviews.setStatus', () => {
  /** THE one that matters: moderation is the only path onto the public site. */
  it('publishes a pending review, and the public query returns it only then', async () => {
    const body = `Only an admin may publish this. ${unique()}`;
    const booking = await makeCompletedBooking();
    const id = await makeReview({ bookingId: booking.id, body });

    const before = await publicApi().reviews.forTour({ tourSlug });
    expect(
      before.items.some((item) => item.body === body),
      'a pending review reached the public block',
    ).toBe(false);

    await expect(ownerApi().admin.reviews.setStatus({ id, status: 'published' })).resolves.toEqual({
      ok: true,
    });

    const after = await publicApi().reviews.forTour({ tourSlug });
    const mine = after.items.find((item) => item.body === body);
    expect(mine, 'a published review still did not appear').toBeDefined();
    expect(mine).toMatchObject({ verified: true, helpfulCount: 0 });
    // The booking id is what makes it verified, and must never be on the wire.
    expect(Object.keys(mine!)).not.toContain('bookingId');

    // And it reaches the site-wide list as well, not only the tour block.
    const published = await publicApi().reviews.published({ tourId, limit: 50 });
    expect(published.items.some((item) => item.body === body)).toBe(true);
  });

  it('hides a published review, taking it back off the public block', async () => {
    const body = `Hidden again. ${unique()}`;
    const id = await makeReview({ status: 'published', body });
    expect(
      (await publicApi().reviews.forTour({ tourSlug })).items.some((i) => i.body === body),
    ).toBe(true);

    await ownerApi().admin.reviews.setStatus({ id, status: 'hidden' });

    expect(
      (await publicApi().reviews.forTour({ tourSlug })).items.some((i) => i.body === body),
    ).toBe(false);
    expect(await reviewRow(id)).toMatchObject({ status: 'hidden' });
  });

  it('is reversible — a hidden review can be published again', async () => {
    const id = await makeReview({ status: 'hidden' });
    await ownerApi().admin.reviews.setStatus({ id, status: 'published' });
    expect(await reviewRow(id)).toMatchObject({ status: 'published' });
  });

  /** A dispatcher moderates reviews too — §9's row is owner AND dispatcher. */
  it('lets a DISPATCHER publish, because §9 gives them this row', async () => {
    const id = await makeReview();
    const api = appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
    await expect(api.admin.reviews.setStatus({ id, status: 'published' })).resolves.toEqual({
      ok: true,
    });
  });

  it('REFUSES pending as a destination, at the Zod boundary', async () => {
    const id = await makeReview({ status: 'published' });
    await expect(
      ownerApi().admin.reviews.setStatus({ id, status: 'pending' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await reviewRow(id)).toMatchObject({ status: 'published' });
  });

  it('answers NOT_FOUND for a review that does not exist, and writes nothing', async () => {
    await expect(
      ownerApi().admin.reviews.setStatus({ id: NOT_FOUND_SENTINEL_ID, status: 'published' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await auditRowsFor(NOT_FOUND_SENTINEL_ID)).toEqual([]);
  });

  it('does NOT touch is_sample, the reply, or the review body', async () => {
    const id = await makeReview({ isSample: true, body: 'A seeded sample.' });
    await ownerApi().admin.reviews.setStatus({ id, status: 'published' });
    expect(await reviewRow(id)).toMatchObject({
      isSample: true,
      reply: null,
      body: 'A seeded sample.',
    });
  });

  it('audits each decision once, naming the actor and both statuses', async () => {
    const id = await makeReview();
    await ownerApi().admin.reviews.setStatus({ id, status: 'published' });
    await ownerApi().admin.reviews.setStatus({ id, status: 'hidden' });

    const rows = await auditRowsFor(id);
    expect(rows.map((row) => row.action)).toEqual(['review.published', 'review.hidden']);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'user', actorId: ownerId });
    }
    expect(rows[0]!.data).toMatchObject({ from: 'pending', to: 'published' });
    expect(rows[1]!.data).toMatchObject({ from: 'published', to: 'hidden' });
  });
});

/* ------------------------------------------------------------------ *
 * reply
 * ------------------------------------------------------------------ */

describeWithDb('admin.reviews.reply', () => {
  const REPLY = 'Thank you! We are glad Pedro looked after you.';

  it('stores the reply with the instant it was written, and the public block shows it', async () => {
    const body = `Replied to. ${unique()}`;
    const id = await makeReview({ status: 'published', body });

    await expect(ownerApi().admin.reviews.reply({ id, reply: REPLY })).resolves.toEqual({
      ok: true,
    });

    const row = await reviewRow(id);
    expect(row!.reply).toBe(REPLY);
    expect(row!.repliedAt).toBeInstanceOf(Date);

    const mine = (await publicApi().reviews.forTour({ tourSlug })).items.find(
      (item) => item.body === body,
    );
    expect(mine!.reply).toBe(REPLY);
    expect(Number.isNaN(Date.parse(mine!.repliedAt!))).toBe(false);
  });

  it('replaces an existing reply rather than appending, and says so in the audit row', async () => {
    const id = await makeReview({ status: 'published' });
    await ownerApi().admin.reviews.reply({ id, reply: 'First attempt, with a typo.' });
    const first = await reviewRow(id);

    await ownerApi().admin.reviews.reply({ id, reply: 'Corrected reply.' });
    const second = await reviewRow(id);

    expect(second!.reply).toBe('Corrected reply.');
    expect(second!.repliedAt!.getTime()).toBeGreaterThanOrEqual(first!.repliedAt!.getTime());

    const rows = await auditRowsFor(id);
    expect(rows.map((row) => row.action)).toEqual(['review.replied', 'review.replied']);
    expect(rows[0]!.data).toMatchObject({ replaced: false });
    expect(rows[1]!.data).toMatchObject({ replaced: true });
  });

  /** The reply is public copy, but it is still not what the log is for. */
  it('keeps the reply TEXT out of the audit row', async () => {
    const id = await makeReview({ status: 'published' });
    await ownerApi().admin.reviews.reply({ id, reply: REPLY });
    const [row] = await auditRowsFor(id);
    expect(JSON.stringify(row!.data)).not.toContain('Pedro');
  });

  it('trims the reply, and REFUSES an empty or over-long one', async () => {
    const id = await makeReview({ status: 'published' });
    await ownerApi().admin.reviews.reply({ id, reply: '   Salamat po!   ' });
    expect((await reviewRow(id))!.reply).toBe('Salamat po!');

    for (const reply of ['', '   ', 'x'.repeat(REVIEW_REPLY_MAX + 1)]) {
      await expect(
        ownerApi().admin.reviews.reply({ id, reply }),
        `a ${reply.length}-character reply was accepted`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await reviewRow(id))!.reply).toBe('Salamat po!');
  });

  it('does NOT publish the review it replies to', async () => {
    const id = await makeReview({ status: 'pending' });
    await ownerApi().admin.reviews.reply({ id, reply: 'Noted, thank you.' });
    expect(await reviewRow(id)).toMatchObject({ status: 'pending' });
  });

  it('answers NOT_FOUND for a review that does not exist', async () => {
    await expect(
      ownerApi().admin.reviews.reply({ id: NOT_FOUND_SENTINEL_ID, reply: 'Hello?' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await auditRowsFor(NOT_FOUND_SENTINEL_ID)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The role gate — §9's `reviewsModeration` row is owner + dispatcher
 * ------------------------------------------------------------------ */

describeWithDb('admin.reviews — who may moderate', () => {
  it('REFUSES a FINANCE user on every moderation procedure, and writes nothing', async () => {
    const id = await makeReview();
    const api = appRouter.createCaller(staffContext(financeId, 'finance') as never);

    const refusals = await Promise.all([
      api.admin.reviews.queue().catch((e: unknown) => e),
      api.admin.reviews.setStatus({ id, status: 'published' }).catch((e: unknown) => e),
      api.admin.reviews
        .reply({ id, reply: 'Finance should not reach this.' })
        .catch((e: unknown) => e),
    ]);

    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    }
    // Hiding a button is not access control: nothing moved.
    expect(await reviewRow(id)).toMatchObject({ status: 'pending', reply: null });
    expect(await auditRowsFor(id)).toEqual([]);
  });

  it('REFUSES an anonymous caller with UNAUTHORIZED', async () => {
    await expect(publicApi().admin.reviews.queue()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

/* ------------------------------------------------------------------ *
 * The assumption the verified badge rests on
 * ------------------------------------------------------------------ */

describeWithDb('a verified review cannot become unverified', () => {
  /**
   * `verified` is `booking_id IS NOT NULL`, which is only safe because
   * `completed` is TERMINAL: `cancelBooking`'s allow-list excludes it ("a trip
   * that ran cannot be un-run"), so the booking behind a verified review can
   * never walk backwards into `cancelled`.
   *
   * That allow-list is private to `services/payments/cancel-refund.ts`, so
   * this pins the property through the mutation rather than the constant. If
   * `completed` were ever made cancellable this goes red — and the badge is
   * what has to change then, not this test.
   */
  it('refuses to cancel the completed booking a verified review came from', async () => {
    const booking = await makeCompletedBooking();
    await makeReview({ bookingId: booking.id, status: 'published' });

    await expect(
      ownerApi().admin.refunds.cancelBooking({
        bookingId: booking.id,
        reason: 'Proving a completed trip cannot be un-run.',
      }),
      'a completed booking was cancellable, so `verified` can now go stale',
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const [row] = await getDb()
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    expect(row!.status).toBe('completed');
  });
});

/* ------------------------------------------------------------------ *
 * reviews.forTour — the breakdown, the filter and the sort
 * ------------------------------------------------------------------ */

describeWithDb('reviews.forTour', () => {
  it('answers NOT_FOUND for a slug no tour has', async () => {
    await expect(
      publicApi().reviews.forTour({ tourSlug: `__no_such_tour__${unique()}` }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('builds the 5-to-1 breakdown from published reviews only', async () => {
    const tour = await makeTour();
    await makeReview({ tourId: tour.id, status: 'published', rating: 5 });
    await makeReview({ tourId: tour.id, status: 'published', rating: 5 });
    await makeReview({ tourId: tour.id, status: 'published', rating: 3 });
    // Neither of these may count toward anything a guest sees.
    await makeReview({ tourId: tour.id, status: 'pending', rating: 1 });
    await makeReview({ tourId: tour.id, status: 'hidden', rating: 1 });

    const result = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    expect(result.tourId).toBe(tour.id);
    expect(result.breakdown).toEqual([
      { stars: 5, count: 2 },
      { stars: 4, count: 0 },
      { stars: 3, count: 1 },
      { stars: 2, count: 0 },
      { stars: 1, count: 0 },
    ]);
    expect(result.total).toBe(3);
    expect(result.matching).toBe(3);
    expect(result.items).toHaveLength(3);
    // (5 + 5 + 3) / 3, at the seeded threshold of three reviews.
    expect(result.rating).toEqual({ average: 13 / 3, count: 3 });
    // Every fixture rates all four sub-scores the same way.
    expect(result.subscores).toEqual({ guide: 5, value: 4, punctuality: 5, safety: 5 });
  });

  it('withholds the aggregate below settings.trust.minReviewsForRating, and never shows a zero', async () => {
    const tour = await makeTour();

    // No reviews at all: null, not { average: 0, count: 0 }.
    const empty = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    expect(empty.rating).toBeNull();
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    expect(empty.subscores).toEqual({
      guide: null,
      value: null,
      punctuality: null,
      safety: null,
    });

    await makeReview({ tourId: tour.id, status: 'published', rating: 5 });
    await makeReview({ tourId: tour.id, status: 'published', rating: 5 });

    // Two is below the seeded threshold of three — but the count is still
    // reported, so the block can say "2 reviews" without claiming a score.
    const two = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    expect(two.rating).toBeNull();
    expect(two.total).toBe(2);
  });

  it('narrows the list by star, leaving the breakdown and total alone', async () => {
    const tour = await makeTour();
    await makeReview({ tourId: tour.id, status: 'published', rating: 5 });
    await makeReview({ tourId: tour.id, status: 'published', rating: 3 });
    await makeReview({ tourId: tour.id, status: 'published', rating: 3 });

    const filtered = await publicApi().reviews.forTour({ tourSlug: tour.slug, starFilter: 3 });
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((item) => item.rating === 3)).toBe(true);
    expect(filtered.matching).toBe(2);
    // The headline numbers are over EVERY published review, filter or not.
    expect(filtered.total).toBe(3);
    expect(filtered.breakdown.find((row) => row.stars === 5)).toEqual({ stars: 5, count: 1 });
  });

  it('sorts newest first by default and highest first on request', async () => {
    const tour = await makeTour();
    const low = await makeReview({ tourId: tour.id, status: 'published', rating: 2 });
    const high = await makeReview({ tourId: tour.id, status: 'published', rating: 5 });

    const newest = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    // Two fixtures can share an instant, so `id DESC` is the tiebreak.
    expect(newest.items[0]!.id).toBe(high);

    const highest = await publicApi().reviews.forTour({ tourSlug: tour.slug, sort: 'highest' });
    expect(highest.items.map((item) => item.rating)).toEqual([5, 2]);
    expect(highest.items.at(-1)!.id).toBe(low);
  });

  it('bounds the page, and REFUSES a limit outside the allowed range', async () => {
    const tour = await makeTour();
    for (let i = 0; i < 3; i += 1) {
      await makeReview({ tourId: tour.id, status: 'published' });
    }

    const page = await publicApi().reviews.forTour({ tourSlug: tour.slug, limit: 2 });
    expect(page.items).toHaveLength(2);
    // The counts are over everything, not over the page.
    expect(page.total).toBe(3);
    expect(page.matching).toBe(3);

    for (const limit of [0, 101, 2.5]) {
      await expect(
        publicApi().reviews.forTour({ tourSlug: tour.slug, limit }),
        `a limit of ${limit} was accepted`,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('REFUSES an unknown input field, so nothing can smuggle a filter', async () => {
    await expect(
      publicApi().reviews.forTour({ tourSlug, status: 'pending' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /**
   * An inactive tour is not publicly visible, and neither are the reviews of
   * it — the same soft-delete rule `tours.bySlug` follows (I1).
   */
  it('answers NOT_FOUND once the tour is soft-deleted', async () => {
    const tour = await makeTour();
    await makeReview({ tourId: tour.id, status: 'published' });
    await expect(publicApi().reviews.forTour({ tourSlug: tour.slug })).resolves.toMatchObject({
      total: 1,
    });

    await getDb().update(tours).set({ isActive: false }).where(eq(tours.id, tour.id));
    await expect(publicApi().reviews.forTour({ tourSlug: tour.slug })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('leaves a review with no tour out of every tour block', async () => {
    const tour = await makeTour();
    await makeReview({ tourId: null, status: 'published' });

    const result = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('issues a constant number of queries, not one per review (no N+1)', async () => {
    const tour = await makeTour();
    for (let i = 0; i < 6; i += 1) {
      await makeReview({ tourId: tour.id, status: 'published' });
    }

    const pool = getPool();
    const originalQuery = pool.query.bind(pool);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      calls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };
    try {
      const result = await publicApi().reviews.forTour({ tourSlug: tour.slug });
      expect(result.items).toHaveLength(6);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = originalQuery;
    }
    // The slug lookup, the items, the breakdown, the sub-scores and the trust
    // settings row — fixed, whatever the review count.
    expect(calls).toBe(5);
  });

  /**
   * D1: the visible stars include samples — that is what a placeholder site
   * is for, and `content_unverified` is what keeps it out of search. The
   * structured-data aggregate still sees nothing real.
   */
  it('counts samples in the display breakdown and keeps them out of realAggregate', async () => {
    const tour = await makeTour();
    for (let i = 0; i < 3; i += 1) {
      await makeReview({ tourId: tour.id, status: 'published', rating: 5, isSample: true });
    }

    const block = await publicApi().reviews.forTour({ tourSlug: tour.slug });
    expect(block.total).toBe(3);
    expect(block.rating).toEqual({ average: 5, count: 3 });

    const published = await publicApi().reviews.published({ tourId: tour.id });
    expect(published.realAggregate).toBeNull();
  });
});
