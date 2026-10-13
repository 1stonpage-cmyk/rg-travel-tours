import { describe, expect, it } from 'vitest';
import {
  bookableDateRange,
  bookingCutoffInstant,
  isDateBookable,
  manilaInstant,
  manilaCivilDate,
  manilaParts,
  manilaTimeHHMM,
  type BookingWindowSettings,
} from './time';

describe('manilaParts', () => {
  it('reads Manila midnight correctly from the equivalent UTC instant', () => {
    // 2026-10-01T16:00:00Z is exactly midnight in Asia/Manila (UTC+8) on
    // 2 Oct 2026 — the same instant task-1.5's schedule tests pin as the
    // start of a promo/announcement window.
    const parts = manilaParts(new Date('2026-10-01T16:00:00.000Z'));
    expect(parts).toEqual({
      year: 2026,
      month: 10,
      day: 2,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 5, // Friday
    });
  });

  it('converts a UTC instant to the correct Manila clock time and weekday', () => {
    // 2026-10-09T02:00:00Z + 8h = 2026-10-09T10:00 Manila, a Friday.
    const parts = manilaParts(new Date('2026-10-09T02:00:00.000Z'));
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(0);
    expect(parts.weekday).toBe(5); // Friday
  });

  it('rolls the Manila calendar day forward across a UTC date boundary', () => {
    // 2026-10-08T22:00:00Z + 8h = 2026-10-09T06:00 Manila — a different
    // calendar day in Manila than in UTC.
    const parts = manilaParts(new Date('2026-10-08T22:00:00.000Z'));
    expect(parts.day).toBe(9);
    expect(parts.hour).toBe(6);
  });

  it('never reports hour 24 for Manila midnight', () => {
    const parts = manilaParts(new Date('2026-10-01T16:00:00.000Z'));
    expect(parts.hour).toBe(0);
  });
});

describe('manilaTimeHHMM', () => {
  it('zero-pads hour and minute', () => {
    expect(manilaTimeHHMM(new Date('2026-10-09T02:00:00.000Z'))).toBe('10:00');
    expect(manilaTimeHHMM(new Date('2026-10-01T16:00:00.000Z'))).toBe('00:00');
  });
});

// ---------------------------------------------------------------------------
// The booking date window (owner decision 2026-10-13 — proposed by developer,
// not yet confirmed with R&G). Pure: `now` is always a parameter, so every
// case below is an exact instant rather than whenever the suite happens to
// run.
// ---------------------------------------------------------------------------

/** The seeded defaults, so these tests read as the rule the owner stated. */
const WINDOW: BookingWindowSettings = {
  minLeadDays: 1,
  nextDayCutoffTime: '18:00',
  maxAdvanceDays: 180,
};

/** 2026-06-10, 09:00 Manila (01:00 UTC) — a plain morning, well before the cutoff. */
const MORNING = new Date('2026-06-10T01:00:00.000Z');
/** The same Manila day at 17:59 — the last minute tomorrow is still bookable. */
const JUST_BEFORE_CUTOFF = new Date('2026-06-10T09:59:00.000Z');
/** The same Manila day at exactly 18:00 — the cutoff itself. */
const AT_CUTOFF = new Date('2026-06-10T10:00:00.000Z');

describe('manilaCivilDate', () => {
  it('reads the Manila calendar day, not the UTC one', () => {
    // 16:00 UTC is already the NEXT day in Manila.
    expect(manilaCivilDate(new Date('2026-06-10T15:59:59.000Z'))).toBe('2026-06-10');
    expect(manilaCivilDate(new Date('2026-06-10T16:00:00.000Z'))).toBe('2026-06-11');
  });

  it('zero-pads month and day', () => {
    expect(manilaCivilDate(new Date('2026-01-02T01:00:00.000Z'))).toBe('2026-01-02');
  });
});

describe('bookableDateRange', () => {
  it('makes tomorrow the earliest bookable date, before the cutoff', () => {
    expect(bookableDateRange(WINDOW, MORNING).earliest).toBe('2026-06-11');
    expect(bookableDateRange(WINDOW, JUST_BEFORE_CUTOFF).earliest).toBe('2026-06-11');
  });

  /**
   * At OR after the cutoff, tomorrow goes too — the owner's rule is "after
   * 18:00 Manila, tomorrow is also not bookable". 18:00 itself counts as
   * after: a cutoff a guest can still beat by booking at exactly 18:00:00 is
   * not a cutoff.
   */
  it('pushes the earliest date out one more day at and after the cutoff', () => {
    expect(bookableDateRange(WINDOW, AT_CUTOFF).earliest).toBe('2026-06-12');
    expect(bookableDateRange(WINDOW, new Date('2026-06-10T10:01:00.000Z')).earliest).toBe(
      '2026-06-12',
    );
    // ...and right up to Manila midnight, which is still the same Manila day.
    expect(bookableDateRange(WINDOW, new Date('2026-06-10T15:59:59.000Z')).earliest).toBe(
      '2026-06-12',
    );
  });

  it('ends the window maxAdvanceDays out, counted from the Manila today', () => {
    expect(bookableDateRange(WINDOW, MORNING).latest).toBe('2026-12-07');
  });

  /**
   * The 16:00 UTC boundary (= 00:00 Manila) the owner asked for, in both
   * directions across one second. It is the case a hand-rolled `+8h` offset
   * or a UTC-based "today" gets wrong, and it moves the whole window by a
   * day AND flips the cutoff.
   */
  it('turns the whole window over at 16:00 UTC, which is Manila midnight', () => {
    // 15:59:59Z — still 2026-06-10 in Manila, at 23:59, so past the cutoff.
    const before = bookableDateRange(WINDOW, new Date('2026-06-10T15:59:59.000Z'));
    expect(before).toEqual({ earliest: '2026-06-12', latest: '2026-12-07' });

    // 16:00:00Z — now 2026-06-11 in Manila, at 00:00, which is before the
    // cutoff again, so the earliest date is the 12th either way — but the
    // END of the window has moved a day.
    const after = bookableDateRange(WINDOW, new Date('2026-06-10T16:00:00.000Z'));
    expect(after).toEqual({ earliest: '2026-06-12', latest: '2026-12-08' });
  });

  it('crosses month and year ends without arithmetic drift', () => {
    // 2026-12-31 09:00 Manila, 1 day lead -> 2027-01-01.
    const newYear = bookableDateRange(
      { minLeadDays: 1, nextDayCutoffTime: '18:00', maxAdvanceDays: 31 },
      new Date('2026-12-31T01:00:00.000Z'),
    );
    expect(newYear).toEqual({ earliest: '2027-01-01', latest: '2027-01-31' });

    // A leap day is a real day: 2028-02-28 + 1 = 2028-02-29.
    const leap = bookableDateRange(
      { minLeadDays: 1, nextDayCutoffTime: '18:00', maxAdvanceDays: 2 },
      new Date('2028-02-28T01:00:00.000Z'),
    );
    expect(leap).toEqual({ earliest: '2028-02-29', latest: '2028-03-01' });
  });

  it('allows same-day booking when minLeadDays is 0, which the cutoff still moves', () => {
    const sameDay = { minLeadDays: 0, nextDayCutoffTime: '18:00', maxAdvanceDays: 180 };
    expect(bookableDateRange(sameDay, MORNING).earliest).toBe('2026-06-10');
    expect(bookableDateRange(sameDay, AT_CUTOFF).earliest).toBe('2026-06-11');
  });
});

describe('isDateBookable', () => {
  it('refuses today and accepts tomorrow (minLeadDays = 1)', () => {
    const range = bookableDateRange(WINDOW, MORNING);
    expect(isDateBookable('2026-06-10', range), 'today was bookable').toBe(false);
    expect(isDateBookable('2026-06-11', range), 'tomorrow was refused').toBe(true);
  });

  it('refuses tomorrow at and after the cutoff', () => {
    expect(isDateBookable('2026-06-11', bookableDateRange(WINDOW, JUST_BEFORE_CUTOFF))).toBe(true);
    expect(isDateBookable('2026-06-11', bookableDateRange(WINDOW, AT_CUTOFF))).toBe(false);
    // The day after tomorrow is unaffected by the cutoff.
    expect(isDateBookable('2026-06-12', bookableDateRange(WINDOW, AT_CUTOFF))).toBe(true);
  });

  /** Day 180 is inside the window; day 181 is the first one outside it. */
  it('accepts day 180 and refuses day 181', () => {
    const range = bookableDateRange(WINDOW, MORNING);
    expect(isDateBookable('2026-12-07', range), 'day 180 was refused').toBe(true);
    expect(isDateBookable('2026-12-08', range), 'day 181 was accepted').toBe(false);
  });

  it('refuses a date long past, which is before the earliest either way', () => {
    expect(isDateBookable('2020-01-01', bookableDateRange(WINDOW, MORNING))).toBe(false);
  });

  /**
   * Fails CLOSED on a window that cannot contain anything (`maxAdvanceDays`
   * below the lead): nothing is bookable, rather than everything.
   */
  it('refuses every date when the window is empty', () => {
    const impossible = bookableDateRange(
      { minLeadDays: 5, nextDayCutoffTime: '18:00', maxAdvanceDays: 1 },
      MORNING,
    );
    for (const date of ['2026-06-10', '2026-06-11', '2026-06-15', '2026-06-16']) {
      expect(isDateBookable(date, impossible), `${date} was bookable`).toBe(false);
    }
  });
});

describe('manilaInstant', () => {
  /**
   * The inverse of `manilaParts`, so the two must agree exactly. Asserted
   * as a round trip rather than against a hand-computed UTC string: a
   * hand-computed expectation encodes the +8 offset this module refuses to
   * assume, and would have to be rewritten if the zone ever changed.
   */
  it('round-trips with manilaParts', () => {
    const instant = manilaInstant('2026-06-10', '18:00');
    const parts = manilaParts(instant);
    expect([parts.year, parts.month, parts.day]).toEqual([2026, 6, 10]);
    expect([parts.hour, parts.minute]).toEqual([18, 0]);
  });

  /** And it really is 10:00 UTC, which is the fact `bookableDateRange`'s own fixtures rest on. */
  it('agrees with the UTC instant this suite already uses for 18:00 Manila', () => {
    expect(manilaInstant('2026-06-10', '18:00').toISOString()).toBe('2026-06-10T10:00:00.000Z');
    expect(manilaInstant('2026-06-10', '00:00').toISOString()).toBe('2026-06-09T16:00:00.000Z');
  });
});

describe('bookingCutoffInstant', () => {
  /**
   * The clock-time twin of `bookableDateRange`, and the two must agree
   * about where the line is: a tour on 2026-06-11 stops being bookable at
   * 18:00 Manila on 2026-06-10, which is exactly the instant
   * `AT_CUTOFF` names and the instant at which `isDateBookable` flips for
   * that date.
   */
  it('is the cutoff time on the day minLeadDays before the tour', () => {
    expect(bookingCutoffInstant('2026-06-11', WINDOW).getTime()).toBe(AT_CUTOFF.getTime());
  });

  /**
   * **It agrees with the civil window at the boundary instant itself**, not
   * merely nearby. One minute earlier the date is bookable; at the cutoff
   * it is not; and `bookingCutoffInstant` is that exact instant.
   */
  it('lands on the instant the civil window closes', () => {
    const cutoff = bookingCutoffInstant('2026-06-11', WINDOW);
    const aMinuteBefore = new Date(cutoff.getTime() - 60_000);
    expect(isDateBookable('2026-06-11', bookableDateRange(WINDOW, aMinuteBefore))).toBe(true);
    expect(isDateBookable('2026-06-11', bookableDateRange(WINDOW, cutoff))).toBe(false);
  });

  it('honours a different lead time and a different cutoff clock', () => {
    const sameDay = { minLeadDays: 0, nextDayCutoffTime: '06:30' };
    // minLeadDays 0: the cutoff is on the tour day itself.
    expect(bookingCutoffInstant('2026-06-11', sameDay).toISOString()).toBe(
      '2026-06-10T22:30:00.000Z',
    );
    const threeDays = { minLeadDays: 3, nextDayCutoffTime: '18:00' };
    expect(bookingCutoffInstant('2026-06-11', threeDays).toISOString()).toBe(
      '2026-06-08T10:00:00.000Z',
    );
  });

  /** Across a month and a year boundary, where naive date arithmetic breaks. */
  it('crosses month and year boundaries', () => {
    expect(bookingCutoffInstant('2026-01-01', WINDOW).toISOString()).toBe(
      '2025-12-31T10:00:00.000Z',
    );
    expect(bookingCutoffInstant('2026-03-01', WINDOW).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
  });
});
