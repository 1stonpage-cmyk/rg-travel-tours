/**
 * `admin.reviews.*` — the moderation queue, the publish/hide decision and the
 * operator's reply (Week 7 plan, Task 10; BUILD_SPEC §4 "Reviews", §9 "Reviews
 * moderation").
 *
 * Every procedure is `adminProcedure('reviewsModeration')` — §9's row, which
 * is **owner and dispatcher, never finance**. A finance user is refused by the
 * gate rather than by a resolver finding nothing to do.
 *
 * **This router is the ONLY path onto the public site.** A guest's submission
 * lands `pending` (`portal.submitReview`) and nothing else writes
 * `reviews.status`, so "a guest cannot publish straight to the site" is true
 * because this file is the only writer, not because a resolver remembers to
 * check. The public reads all filter on `status = 'published'`.
 *
 * **Three columns are deliberately unreachable from here:**
 *
 *  - `is_sample` — owned by the seed. A moderator publishing a sample is a
 *    real act (the placeholder site is published samples), but *flagging* a
 *    real review as a sample would hide it from `realAggregate` while leaving
 *    it on the page, and un-flagging a seeded one would feed fabricated
 *    content to structured data. `check-placeholders.mjs` is what gates a
 *    production build on them; this screen does not relabel them.
 *  - `rating` and `body` — a moderator decides whether a guest's words are
 *    shown, never what they say. An editable review body would make every
 *    published review unfalsifiable.
 *  - `booking_id` / `tour_id` — what the review is OF. Re-pointing a five-star
 *    review at another tour is the fake social proof CLAUDE.md forbids,
 *    arrived at from the inside.
 *
 * One transaction per mutation with the audit write inside it — an audit row
 * that survives a rollback claims a decision nobody made.
 */
import { TRPCError } from '@trpc/server';
import { reviewReplyInput, reviewStatusInput, type ReviewModerationRow } from '@rg/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { bookings, reviews, tours } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** The one message for an id that is not a review. */
const NOT_FOUND_MESSAGE = 'No review with that id.';

/**
 * `audit_log.entity` for a review row — the spelling `portal.submitReview`
 * already uses (`review.submitted`), so one entity name covers a review's
 * whole life from submission to reply.
 */
const AUDIT_ENTITY = 'reviews';

export const adminReviewsRouter = router({
  /**
   * Every review, **pending first**.
   *
   * Pending first because that is the queue — a moderator opens this screen to
   * find what is waiting. Decided reviews stay listed below, which is the only
   * place a HIDDEN review is visible at all (the public reads cannot see one)
   * and therefore the only place one can be published again.
   *
   * No input and no status filter: the table is small (a tour's whole review
   * history is a few dozen rows), the screen wants all three states at once to
   * show counts, and a filter the client could pass would be one more thing
   * for a reviewer to check against the role gate. The client narrows what it
   * renders.
   *
   * `bookingRef` rather than the guest's contact details (RA 10173): a
   * moderator deciding whether a review is genuine needs to be able to find
   * the booking, and the ref is enough to look it up on the screen that is
   * allowed to show the rest.
   */
  queue: adminProcedure('reviewsModeration').query(async (): Promise<ReviewModerationRow[]> => {
    const rows = await getDb()
      .select({
        id: reviews.id,
        status: reviews.status,
        name: reviews.name,
        rating: reviews.rating,
        guide: reviews.guide,
        value: reviews.value,
        punctuality: reviews.punctuality,
        safety: reviews.safety,
        body: reviews.body,
        reply: reviews.reply,
        repliedAt: reviews.repliedAt,
        createdAt: reviews.createdAt,
        isSample: reviews.isSample,
        tourId: reviews.tourId,
        tourTitle: tours.title,
        /*
         * Read so `verified` can be DERIVED. Two LEFT JOINs because both
         * columns are nullable: a review of the operator as a whole has no
         * tour, and an admin-entered one has no booking.
         */
        bookingId: reviews.bookingId,
        bookingRef: bookings.ref,
      })
      .from(reviews)
      .leftJoin(tours, eq(reviews.tourId, tours.id))
      .leftJoin(bookings, eq(reviews.bookingId, bookings.id))
      // Raw `sql` for the queue order: pending above everything, then newest
      // first. `id` after `created_at` because two rows can share an instant
      // and a queue needs a total order.
      .orderBy(desc(sql`${reviews.status} = 'pending'`), desc(reviews.createdAt), desc(reviews.id));

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      name: row.name,
      rating: row.rating,
      guide: row.guide,
      value: row.value,
      punctuality: row.punctuality,
      safety: row.safety,
      body: row.body,
      reply: row.reply,
      // UTC instants out as UTC instants: the SCREEN converts to Manila.
      repliedAt: row.repliedAt === null ? null : row.repliedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      isSample: row.isSample,
      // The same derivation the public row uses, from the same column.
      verified: row.bookingId !== null,
      tourId: row.tourId,
      tourTitle: row.tourTitle,
      bookingRef: row.bookingRef,
    }));
  }),

  /**
   * Publishes or hides one review — **the only writer of `reviews.status`
   * besides the submission that creates a `pending` row**.
   *
   * Both directions, and both reversible: a review hidden by mistake is
   * published again, and a review published by mistake comes straight back
   * off. `pending` is not an option (`reviewStatusInput` refuses it): it is
   * where a submission lands, not a decision — and "put it back in the queue
   * as though nobody had looked" is not a thing a moderator needs.
   *
   * Two dotted audit actions rather than one `review.status_set` with a flag
   * in the payload — "who published this" is the question asked, and it should
   * not need a payload to answer. The payload still carries both statuses,
   * because knowing a review was hidden is less useful than knowing it was
   * hidden after being published.
   */
  setStatus: adminProcedure('reviewsModeration')
    .input(reviewStatusInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({ status: reviews.status })
          .from(reviews)
          .where(eq(reviews.id, input.id))
          // The row lock: two moderators clicking at once must not both write
          // and must not both audit a decision.
          .for('update')
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
        }

        await tx.update(reviews).set({ status: input.status }).where(eq(reviews.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: input.status === 'published' ? 'review.published' : 'review.hidden',
          entity: AUDIT_ENTITY,
          entityId: input.id,
          data: { from: row.status, to: input.status },
        });
      });
      return { ok: true as const };
    }),

  /**
   * The operator's public reply to a review (§4: "business replies").
   *
   * `replied_at` is stamped from a `now` read ONCE at the request boundary,
   * like every other instant in this codebase, and re-stamped on an edit: the
   * column answers "when was this reply written", and a correction is a new
   * reply.
   *
   * It is a REPLACEMENT, never an append, and the schema has one `reply`
   * column — so a reply is a single sentence from the business, not a thread.
   * There is deliberately no way to clear one back to null: nothing has asked
   * for it, and a reply that needs retracting can be rewritten.
   *
   * **It does not publish the review it replies to.** The two acts are
   * separate on purpose: an operator may want to answer a complaint that is
   * never going on the site, and a reply that silently published a pending
   * review would be a decision made by the wrong button.
   *
   * The audit row names the actor, the review and whether a previous reply was
   * replaced — **never the reply text**. The text is on the review row (and,
   * once published, on the public page); the log is the record of who acted,
   * not a second copy of the copy.
   */
  reply: adminProcedure('reviewsModeration')
    .input(reviewReplyInput)
    .mutation(async ({ input, ctx }) => {
      const now = new Date();
      await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({ reply: reviews.reply })
          .from(reviews)
          .where(eq(reviews.id, input.id))
          .for('update')
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
        }

        await tx
          .update(reviews)
          .set({ reply: input.reply, repliedAt: now })
          .where(eq(reviews.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.adminSession.subjectId,
          action: 'review.replied',
          entity: AUDIT_ENTITY,
          entityId: input.id,
          data: { replaced: row.reply !== null, replyLength: input.reply.length },
        });
      });
      return { ok: true as const };
    }),
});
