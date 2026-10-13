/**
 * Week 4 plan, Task 9 — the portal's two pure decisions.
 *
 * The tracker is driven from a table over **all eight** `BOOKING_STATUSES`
 * rather than three hand-picked ones (the plan asks for exactly this): a
 * five-step tracker has five booleans per status, and the statuses nobody
 * thinks about — `cancelled` carrying money, `expired` carrying a rejected
 * receipt — are where a hand-picked test is silent and a guest sees
 * nonsense.
 */
import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES, type BookingStatus } from './booking';
import {
  PORTAL_POLL_MS,
  TRACKER_STEPS,
  isDriverVisible,
  portalPollMs,
  portalTracker,
} from './portal';

/** `done` flags in §7's order, as a compact string: `#` done, `.` not. */
function pattern(facts: Parameters<typeof portalTracker>[0]): string {
  return portalTracker(facts)
    .map((state) => (state.done ? '#' : '.'))
    .join('');
}

describe('portalTracker', () => {
  it('names §7s five steps, in §7s order', () => {
    expect([...TRACKER_STEPS]).toEqual([
      'Booked',
      'Payment sent',
      'Verified by admin',
      'Driver assigned',
      'Tour day',
    ]);
    expect(
      portalTracker({ status: 'pending_payment', paidCentavos: 0, hasReceipt: false }),
    ).toEqual(TRACKER_STEPS.map((step) => ({ step, done: step === 'Booked' })));
  });

  /**
   * The whole table, every status, unpaid and with no receipt. "Booked" is
   * always done — the booking exists — and nothing else is.
   */
  it('lights only "Booked" for every status while nothing has been paid or sent', () => {
    const seen = Object.fromEntries(
      BOOKING_STATUSES.map((status) => [
        status,
        pattern({ status, paidCentavos: 0, hasReceipt: false }),
      ]),
    );
    expect(seen).toEqual({
      pending_payment: '#....',
      pending_verification: '#....',
      // Money is what "verified" means, so a confirmed booking with a zero
      // balance paid is not a state this system produces — and if it ever
      // appears, the tracker says what is true rather than what is implied.
      confirmed: '#....',
      assigned: '#..#.',
      in_progress: '#..##',
      completed: '#..##',
      cancelled: '#....',
      expired: '#....',
    });
  });

  /** A receipt uploaded lights "Payment sent" and nothing beyond it. */
  it('lights "Payment sent" from a receipt alone, never "Verified"', () => {
    expect(pattern({ status: 'pending_verification', paidCentavos: 0, hasReceipt: true })).toBe(
      '##...',
    );
    // Rejected, re-uploading: still "sent", still not verified.
    expect(pattern({ status: 'pending_payment', paidCentavos: 0, hasReceipt: true })).toBe('##...');
  });

  /** Money lights both "sent" and "verified", receipt or no receipt. */
  it('lights "Verified by admin" from money, with or without a receipt', () => {
    expect(pattern({ status: 'confirmed', paidCentavos: 135_000, hasReceipt: false })).toBe(
      '###..',
    );
    expect(pattern({ status: 'confirmed', paidCentavos: 135_000, hasReceipt: true })).toBe('###..');
  });

  it('lights every step through the tour day', () => {
    expect(pattern({ status: 'assigned', paidCentavos: 135_000, hasReceipt: true })).toBe('####.');
    expect(pattern({ status: 'in_progress', paidCentavos: 135_000, hasReceipt: true })).toBe(
      '#####',
    );
    expect(pattern({ status: 'completed', paidCentavos: 450_000, hasReceipt: true })).toBe('#####');
  });

  /**
   * A cancelled booking that was paid before it was cancelled. The money
   * really did arrive, so those two steps stay lit — the page says
   * "cancelled" in words, and a tracker that reset itself would make a
   * refund conversation harder, not easier.
   */
  it('keeps what actually happened lit on a cancelled or expired booking', () => {
    expect(pattern({ status: 'cancelled', paidCentavos: 135_000, hasReceipt: true })).toBe('###..');
    expect(pattern({ status: 'expired', paidCentavos: 0, hasReceipt: true })).toBe('##...');
  });

  it('never returns fewer or more than five steps, for any status', () => {
    for (const status of BOOKING_STATUSES) {
      expect(portalTracker({ status, paidCentavos: 0, hasReceipt: false })).toHaveLength(5);
      expect(portalTracker({ status, paidCentavos: 1, hasReceipt: true })).toHaveLength(5);
    }
  });
});

describe('isDriverVisible', () => {
  const TOUR_DATE = '2026-11-20';
  /** 2026-11-20, 09:00 Manila. */
  const ON_TOUR_DAY = new Date('2026-11-20T01:00:00.000Z');
  /** 2026-11-20, 23:50 Manila — still the tour day. */
  const LATE_ON_TOUR_DAY = new Date('2026-11-20T15:50:00.000Z');
  /** 2026-11-21, 00:10 Manila — the day after. */
  const JUST_AFTER = new Date('2026-11-20T16:10:00.000Z');

  it('is false until the booking is assigned', () => {
    const before: BookingStatus[] = [
      'pending_payment',
      'pending_verification',
      'confirmed',
      'cancelled',
      'expired',
    ];
    for (const status of before) {
      expect(isDriverVisible(status, TOUR_DATE, ON_TOUR_DAY), `${status} showed a driver`).toBe(
        false,
      );
    }
  });

  it('is true from assignment through the tour day', () => {
    for (const status of ['assigned', 'in_progress', 'completed'] as const) {
      expect(isDriverVisible(status, TOUR_DATE, ON_TOUR_DAY)).toBe(true);
      expect(isDriverVisible(status, TOUR_DATE, LATE_ON_TOUR_DAY)).toBe(true);
    }
  });

  /** A driver assigned a week early is still reachable. */
  it('is true before the tour day too, once assigned', () => {
    expect(isDriverVisible('assigned', TOUR_DATE, new Date('2026-11-13T01:00:00.000Z'))).toBe(true);
  });

  /**
   * **The boundary itself, in Manila.** 23:50 on the tour day is visible
   * and 00:10 the next morning is not — and the instant between them is
   * Manila midnight, not UTC midnight. A UTC comparison would keep the
   * driver's number up for another eight hours.
   */
  it('is false once the Manila tour day has ended', () => {
    for (const status of ['assigned', 'in_progress', 'completed'] as const) {
      expect(
        isDriverVisible(status, TOUR_DATE, JUST_AFTER),
        `${status} still showed a driver the day after the tour`,
      ).toBe(false);
    }
    // And long afterwards, which is the data-protection case: a booking
    // page must not keep serving a driver's mobile number for years.
    expect(isDriverVisible('completed', TOUR_DATE, new Date('2027-06-01T01:00:00.000Z'))).toBe(
      false,
    );
  });
});

describe('portalPollMs', () => {
  /**
   * §7 says twenty seconds, and says it only for `pending_verification`.
   * Driven over ALL eight statuses rather than the one that polls: the
   * failure that costs something is the opposite one — a page left polling
   * a `completed` booking every twenty seconds forever, on a guest's mobile
   * data.
   */
  it('polls every 20s while pending_verification, and never otherwise', () => {
    expect(PORTAL_POLL_MS).toBe(20_000);
    const answers = Object.fromEntries(
      BOOKING_STATUSES.map((status) => [status, portalPollMs(status)]),
    );
    expect(answers).toEqual({
      pending_payment: false,
      pending_verification: 20_000,
      confirmed: false,
      assigned: false,
      in_progress: false,
      completed: false,
      cancelled: false,
      expired: false,
    });
  });
});
