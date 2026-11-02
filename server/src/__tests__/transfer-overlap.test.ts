/**
 * The PURE half of transfer capacity (transfers-launch plan, Architecture §2;
 * Task T7): `peakOverlap`, `overlaps`, `computeTransferWindow` and
 * `clockTimeToMinutes`.
 *
 * No database, no `describeWithDb`, no fixtures — the whole point of putting
 * this math in `services/transfers/overlap.ts` is that the interval-scheduling
 * result can be driven with plain arrays. The DB-aware pool math, the locks and
 * the races are `transfer-capacity.test.ts`.
 *
 * Two properties here are load-bearing for the whole feature and are tested
 * from both sides rather than asserted once:
 *
 *  1. **A back-to-back pair is ONE resource, not two.** It is what makes
 *     "several jobs a day on one van" true, and the half-open interval plus the
 *     end-before-start tie rule is the only thing that delivers it.
 *  2. **A custom one-way transfer THROWS rather than guessing a duration.** It
 *     is the plan's one genuine, unresolved data-modelling gap (nothing stores
 *     a duration for a staff-quoted route), and a guess would be a window wrong
 *     by an unknown amount in an unknown direction.
 */
import { describe, expect, it } from 'vitest';
import {
  clockTimeToMinutes,
  computeTransferWindow,
  MINUTES_PER_DAY,
  overlaps,
  peakOverlap,
  type TimeWindow,
} from '../services/transfers/overlap';

/** `"HH:mm"`-ish shorthand so the cases read as times rather than integers. */
const at = (hours: number, minutes = 0) => hours * 60 + minutes;
const window = (startHour: number, endHour: number): TimeWindow => ({
  startMinutes: at(startHour),
  endMinutes: at(endHour),
});

describe('peakOverlap', () => {
  it('is zero for no windows at all', () => {
    expect(peakOverlap([])).toBe(0);
  });

  it('is one for a single window, and for a day of non-overlapping ones', () => {
    expect(peakOverlap([window(6, 9)])).toBe(1);
    expect(peakOverlap([window(6, 9), window(10, 12), window(14, 18)])).toBe(1);
  });

  /**
   * **The tie rule, from the side that matters.** One job ends exactly when the
   * next begins — with the buffer already inside `endMinutes`, that is a
   * realistic turnaround, and it must need ONE vehicle. An implementation that
   * processed the start first would say 2 and halve the fleet's usable
   * capacity.
   */
  it('counts a back-to-back pair as ONE, not two', () => {
    expect(peakOverlap([window(6, 9), window(9, 12)])).toBe(1);
    expect(peakOverlap([window(6, 9), window(9, 12), window(12, 15)])).toBe(1);
  });

  it('counts a one-minute overlap as TWO', () => {
    expect(
      peakOverlap([
        { startMinutes: at(6), endMinutes: at(9) },
        { startMinutes: at(9) - 1, endMinutes: at(12) },
      ]),
    ).toBe(2);
  });

  it('counts nested and staggered windows by what is simultaneously active', () => {
    // 08-18 spans both of the others; at 10:00 all three are running.
    expect(peakOverlap([window(8, 18), window(9, 11), window(10, 12)])).toBe(3);
    // The same three, but the inner two no longer overlap each other.
    expect(peakOverlap([window(8, 18), window(9, 11), window(11, 13)])).toBe(2);
  });

  it('does not depend on the order the windows arrive in', () => {
    const windows = [window(14, 18), window(6, 9), window(8, 10), window(9, 12)];
    expect(peakOverlap(windows)).toBe(2);
    expect(peakOverlap([...windows].reverse())).toBe(2);
  });

  it('reports the peak, not the total — a busy morning does not add up all day', () => {
    expect(peakOverlap([window(6, 7), window(7, 8), window(8, 9), window(9, 10)])).toBe(1);
  });

  /**
   * An empty half-open interval occupies nothing, so it contributes nothing.
   * Documented rather than desired: `computeTransferWindow` refuses to build
   * one (a day-use must end after it starts), which is what keeps this from
   * being a way to book a vehicle that consumes no capacity.
   */
  it('treats a zero-length window as occupying nothing', () => {
    expect(peakOverlap([{ startMinutes: at(9), endMinutes: at(9) }])).toBe(0);
    expect(peakOverlap([window(8, 10), { startMinutes: at(9), endMinutes: at(9) }])).toBe(1);
  });
});

describe('overlaps', () => {
  it('is false for a back-to-back pair, in both directions', () => {
    expect(overlaps(window(6, 9), window(9, 12))).toBe(false);
    expect(overlaps(window(9, 12), window(6, 9))).toBe(false);
  });

  it('is true for any shared minute, however small, in both directions', () => {
    const a = window(6, 9);
    const b = { startMinutes: at(9) - 1, endMinutes: at(12) };
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });

  it('is true when one window contains the other', () => {
    expect(overlaps(window(6, 20), window(9, 11))).toBe(true);
    expect(overlaps(window(9, 11), window(6, 20))).toBe(true);
  });
});

describe('computeTransferWindow', () => {
  it('ends a one-way transfer at pickup + duration + buffer', () => {
    expect(
      computeTransferWindow({
        productType: 'transfer_one_way',
        pickupTimeMinutes: at(8),
        dayUseEndTimeMinutes: null,
        routeDurationMinutes: 150,
        bufferMinutes: 60,
      }),
    ).toEqual({ ok: true, window: { startMinutes: at(8), endMinutes: at(11, 30) } });
  });

  it('ends a day-use transfer at its end time + buffer, ignoring any route duration', () => {
    expect(
      computeTransferWindow({
        productType: 'transfer_day_use',
        pickupTimeMinutes: at(7),
        dayUseEndTimeMinutes: at(17),
        // A day-use booking has a route, and its duration is NOT the window.
        routeDurationMinutes: 150,
        bufferMinutes: 60,
      }),
    ).toEqual({ ok: true, window: { startMinutes: at(7), endMinutes: at(18) } });
  });

  it('accepts a zero buffer (the setting allows 0) without changing the end', () => {
    expect(
      computeTransferWindow({
        productType: 'transfer_one_way',
        pickupTimeMinutes: at(8),
        dayUseEndTimeMinutes: null,
        routeDurationMinutes: 90,
        bufferMinutes: 0,
      }),
    ).toEqual({ ok: true, window: { startMinutes: at(8), endMinutes: at(9, 30) } });
  });

  /**
   * The boundary, both sides of it. An end of exactly 1440 is midnight, and the
   * interval is half-open, so `[x, 1440)` is the rest of this day and none of
   * the next — allowed. One minute more genuinely spills over and is refused.
   */
  it('allows a window ending at exactly midnight and refuses one minute past it', () => {
    const base = {
      productType: 'transfer_one_way' as const,
      pickupTimeMinutes: at(22),
      dayUseEndTimeMinutes: null,
      bufferMinutes: 60,
    };
    expect(computeTransferWindow({ ...base, routeDurationMinutes: 60 })).toEqual({
      ok: true,
      window: { startMinutes: at(22), endMinutes: MINUTES_PER_DAY },
    });
    expect(computeTransferWindow({ ...base, routeDurationMinutes: 61 })).toEqual({
      ok: false,
      reason: 'crosses_midnight',
    });
  });

  it('refuses a day-use window whose buffer pushes it past midnight', () => {
    expect(
      computeTransferWindow({
        productType: 'transfer_day_use',
        pickupTimeMinutes: at(7),
        dayUseEndTimeMinutes: at(23, 30),
        routeDurationMinutes: null,
        bufferMinutes: 60,
      }),
    ).toEqual({ ok: false, reason: 'crosses_midnight' });
  });

  it('refuses rather than wrapping — the refusal is never a window at all', () => {
    const result = computeTransferWindow({
      productType: 'transfer_one_way',
      pickupTimeMinutes: at(23),
      dayUseEndTimeMinutes: null,
      routeDurationMinutes: 180,
      bufferMinutes: 60,
    });
    expect(result.ok).toBe(false);
    expect('window' in result).toBe(false);
  });

  /**
   * **The plan's unresolved gap, pinned.** A custom, staff-quoted one-way
   * transfer (`bookings.route_id IS NULL`) has no duration stored anywhere, so
   * there is no window to compute. This must be a loud throw and never a
   * guessed default: a guessed duration is a window wrong by an unknown amount
   * that would either oversell a vehicle still out on the road or refuse a
   * booking that fitted, with nothing anywhere to trace it back to.
   *
   * Nothing can reach this today — a custom-route booking needs Task T19's
   * staff-conversion flow, which is not built. T19 must supply a real duration.
   */
  it('THROWS for a custom one-way transfer with no stored duration', () => {
    expect(() =>
      computeTransferWindow({
        productType: 'transfer_one_way',
        pickupTimeMinutes: at(8),
        dayUseEndTimeMinutes: null,
        routeDurationMinutes: null,
        bufferMinutes: 60,
      }),
    ).toThrow(/needs a route duration/);
  });

  it('THROWS for a day-use transfer with no end time', () => {
    expect(() =>
      computeTransferWindow({
        productType: 'transfer_day_use',
        pickupTimeMinutes: at(8),
        dayUseEndTimeMinutes: null,
        routeDurationMinutes: 150,
        bufferMinutes: 60,
      }),
    ).toThrow(/dayUseEndTimeMinutes/);
  });

  /**
   * A day-use that ends when (or before) it starts would be an EMPTY window —
   * it would consume no vehicle at all (see `peakOverlap`'s zero-length case),
   * which is a way to book a van that holds nothing. Refused here as a
   * malformed argument; T9's Zod input owes the guest-facing refusal.
   */
  it('THROWS for a day-use transfer that ends at or before its pickup', () => {
    const base = {
      productType: 'transfer_day_use' as const,
      pickupTimeMinutes: at(9),
      routeDurationMinutes: null,
      bufferMinutes: 60,
    };
    expect(() => computeTransferWindow({ ...base, dayUseEndTimeMinutes: at(9) })).toThrow(
      /must end after it starts/,
    );
    expect(() => computeTransferWindow({ ...base, dayUseEndTimeMinutes: at(8) })).toThrow(
      /must end after it starts/,
    );
  });

  it('THROWS for times and buffers that are not minutes of a day', () => {
    const oneWay = {
      productType: 'transfer_one_way' as const,
      dayUseEndTimeMinutes: null,
      routeDurationMinutes: 60,
      bufferMinutes: 60,
    };
    expect(() => computeTransferWindow({ ...oneWay, pickupTimeMinutes: -1 })).toThrow(RangeError);
    expect(() => computeTransferWindow({ ...oneWay, pickupTimeMinutes: MINUTES_PER_DAY })).toThrow(
      RangeError,
    );
    expect(() => computeTransferWindow({ ...oneWay, pickupTimeMinutes: 8.5 })).toThrow(RangeError);
    expect(() =>
      computeTransferWindow({ ...oneWay, pickupTimeMinutes: at(8), bufferMinutes: -30 }),
    ).toThrow(RangeError);
    expect(() =>
      computeTransferWindow({ ...oneWay, pickupTimeMinutes: at(8), routeDurationMinutes: 0 }),
    ).toThrow(RangeError);
  });
});

describe('clockTimeToMinutes', () => {
  it('reads a stored civil label', () => {
    expect(clockTimeToMinutes('00:00')).toBe(0);
    expect(clockTimeToMinutes('08:30')).toBe(at(8, 30));
    expect(clockTimeToMinutes('23:59')).toBe(MINUTES_PER_DAY - 1);
  });

  /** `null`, never a throw and never a 0 — a 0 would read as midnight. */
  it('returns null for anything that is not one', () => {
    for (const bad of ['', '8:30', '24:00', '23:60', '0830', '8am', 'noon', '08:30:00']) {
      expect(clockTimeToMinutes(bad), bad).toBeNull();
    }
  });
});
