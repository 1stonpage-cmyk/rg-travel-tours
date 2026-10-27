/**
 * Week 7 plan, Task 10 — the §12 rate limit on review SUBMISSION.
 *
 * **What this file is not.** `portal.submitReview` itself was built in Week 4
 * and is proven in `portal-review.test.ts`: it writes `status = 'pending'`
 * only, never `is_sample`, takes the guest's name from the booking rather than
 * the browser, refuses a booking that is not `completed`, refuses a second
 * review, and is invisible to `reviews.published` until an admin publishes it.
 * None of that is re-tested here.
 *
 * What was MISSING, and is what this file holds, is the limiter. §12 lists
 * "review submissions" among the endpoints that must be rate-limited, and
 * nothing was mounted for it — a portal session could have posted a review a
 * second, forever, and every one of them would have landed in a human
 * moderation queue.
 *
 * Every request below is anonymous, so each one is a 401 from
 * `customerProcedure` that still costs budget and writes nothing: the limiter
 * runs in `app.ts`, above the tRPC mount, and counts attempts rather than
 * successes. That is what makes the test cheap AND makes it prove the mount —
 * a limiter tested against a hand-built middleware stack proves nothing about
 * whether `createApp` mounts it.
 */
import { expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { REVIEW_SUBMIT_MAX, REVIEW_SUBMIT_PROCEDURES } from '../middleware/rate-limit';
import { describeWithDb } from './helpers/db';

const BROWSER_ORIGIN = 'http://localhost:5180';

/** A well-formed review body, so nothing is refused for the wrong reason. */
const GOOD = {
  rating: 5,
  body: 'Pedro was early, the van was spotless and the whale sharks turned up on cue.',
};

function submit(app: Parameters<typeof request>[0], path: string) {
  return request(app).post(path).set('Origin', BROWSER_ORIGIN).send(GOOD);
}

describeWithDb('the review-submission rate limit', () => {
  const procedure = REVIEW_SUBMIT_PROCEDURES[0];

  it('answers 429 once the per-IP budget is spent', async () => {
    const app = createApp();
    for (let i = 0; i < REVIEW_SUBMIT_MAX; i += 1) {
      const res = await submit(app, `/trpc/${procedure}`);
      expect(res.status, `attempt ${i + 1} should have reached the procedure`).toBe(401);
    }
    expect((await submit(app, `/trpc/${procedure}`)).status).toBe(429);
  });

  /**
   * BUG-111's lesson: the limiter counts procedure CALLS, not HTTP requests.
   * A batch naming the submission `REVIEW_SUBMIT_MAX` times spends the whole
   * budget in one request — if it did not, the cap would be the cap times the
   * batch size.
   */
  it('counts a batched submission once per CALL, not once per request', async () => {
    const app = createApp();
    const batch = Array.from({ length: REVIEW_SUBMIT_MAX }, () => procedure).join(',');
    await request(app)
      .post(`/trpc/${batch}?batch=1`)
      .set('Origin', BROWSER_ORIGIN)
      .send(Object.fromEntries(Array.from({ length: REVIEW_SUBMIT_MAX }, (_, i) => [i, GOOD])));

    expect(
      (await submit(app, `/trpc/${procedure}`)).status,
      'one batch of the whole budget left room for another submission — the limiter is counting requests',
    ).toBe(429);
  });

  it('leaves the portal login alone — it has its own, shared budget', async () => {
    const app = createApp();
    // Five submissions exhaust THIS limiter. The login's five failed attempts
    // are a separate budget (`BOOKING_LOOKUP_PROCEDURES`), so the sixth
    // submission is refused while a login still answers for itself.
    for (let i = 0; i < REVIEW_SUBMIT_MAX + 1; i += 1) {
      await submit(app, `/trpc/${procedure}`);
    }
    const login = await request(app)
      .post('/trpc/portal.login')
      .set('Origin', BROWSER_ORIGIN)
      .send({ ref: 'RG-ZZZZZZ', email: 'nobody@example.test' });
    expect(login.status, 'the submission limiter swallowed the login budget too').toBe(401);
  });
});
