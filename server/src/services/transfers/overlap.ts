/**
 * Transfer time-window math — PURE. No database, no clock, no settings read,
 * no timezone conversion (transfers-launch plan, Architecture §2).
 *
 * Everything here works in **minutes since midnight of one civil day in
 * Asia/Manila**, because overlap is a same-day, same-timezone comparison and
 * converting to instants would only add a way to shift a day. A transfer's
 * `pickup_time` and `day_use_end_time` are stored as `"HH:mm"` civil labels for
 * the same reason a tour date is stored as `YYYY-MM-DD`.
 *
 * ## Half-open intervals, and why the tie rule is the feature
 *
 * A window is `[startMinutes, endMinutes)` — the end instant is NOT occupied.
 * So a job ending at 11:00 and the next starting at 11:00 are **not** two
 * simultaneous jobs, and one vehicle can run both. That is the "several jobs a
 * day" the owner asked for, and the buffer (added into `endMinutes` by
 * `computeTransferWindow` below) is what makes back-to-back realistic rather
 * than merely arithmetically legal.
 *
 * ## What throws and what refuses
 *
 * `computeTransferWindow` REFUSES (returns `{ ok: false }`) exactly one thing:
 * a window that would run past midnight. That is a guest-facing refusal —
 * "choose an earlier pickup time" — and the capacity date key is a single
 * civil date, so a two-date window is not modelled at launch (plan §2, "Known,
 * accepted limitation").
 *
 * It THROWS on a malformed argument, following `services/capacity.ts`'s own
 * documented discipline (`assertCivilDate`, `assertPax`): a programmer error
 * has to be loud, because the alternative is a silently wrong window, and a
 * silently wrong window either oversells a vehicle or hides one. Nothing a
 * guest can type reaches a throw — the Zod input schemas (T9/T11) are the
 * boundary that keeps it unreachable, and T9 owes `pickupTime < dayUseEndTime`
 * in particular (see `TransferWindowInput.dayUseEndTimeMinutes`).
 */

/** 24 hours in minutes. A civil day's windows live in `[0, 1440]`. */
export const MINUTES_PER_DAY = 1440;

export interface TimeWindow {
  /** Minutes since midnight, civil day. Half-open: `[startMinutes, endMinutes)`. */
  startMinutes: number;
  endMinutes: number;
}

/**
 * The minimum number of same-type resources needed to serve every window with
 * none overlapping on one resource equals the maximum number simultaneously
 * active at any instant (the standard interval-scheduling result — plan
 * Architecture §2). Sweep-line: O(n log n).
 *
 * **Ties: an END is processed BEFORE a START at the same instant**, which is
 * what makes a back-to-back pair count as 1 rather than 2. The sort key below
 * is `(at, delta)` and `-1 < +1`, so that ordering is the sort, not a special
 * case afterwards.
 *
 * A zero-length window (`start === end`, possible only with a zero buffer and a
 * day-use ending at its own pickup time) is an EMPTY half-open interval and
 * therefore contributes nothing: its `-1` is processed before its `+1`. That is
 * arithmetically right and operationally wrong, which is why
 * `computeTransferWindow` refuses to build one — see its day-use branch.
 */
export function peakOverlap(windows: readonly TimeWindow[]): number {
  const events: Array<{ at: number; delta: number }> = [];
  for (const window of windows) {
    events.push({ at: window.startMinutes, delta: 1 });
    events.push({ at: window.endMinutes, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    if (active > peak) peak = active;
  }
  return peak;
}

/** Plain two-window overlap test, same half-open convention. */
export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/** The only refusal `computeTransferWindow` can return. */
export const TRANSFER_WINDOW_ERRORS = ['crosses_midnight'] as const;
export type TransferWindowError = (typeof TRANSFER_WINDOW_ERRORS)[number];

export interface TransferWindowInput {
  productType: 'transfer_one_way' | 'transfer_day_use';
  /** Minutes since midnight. */
  pickupTimeMinutes: number;
  /**
   * Day-use only, and REQUIRED there. Must be strictly after
   * `pickupTimeMinutes`: a day-use hire that ends when it starts would occupy
   * an empty interval and consume no vehicle at all (see `peakOverlap`), so
   * this function refuses to compute one rather than quietly producing a
   * window that oversells the fleet. T9's Zod input owes the guest-facing half
   * of that check; this is the backstop.
   */
  dayUseEndTimeMinutes: number | null;
  /**
   * One-way only. `transfer_routes.estimated_duration_minutes` for a catalog
   * route — and `null` for a CUSTOM, staff-quoted one-way transfer, which
   * nothing in the schema stores a duration for. See the throw below.
   */
  routeDurationMinutes: number | null;
  bufferMinutes: number;
}

export type TransferWindowResult =
  { ok: true; window: TimeWindow } | { ok: false; reason: 'crosses_midnight' };

function assertMinuteOfDay(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) {
    throw new RangeError(`Expected ${name} in [0, ${MINUTES_PER_DAY}), got ${value}`);
  }
}

/**
 * The window a transfer occupies on its civil date:
 *
 *   one-way : `[pickup, pickup + route duration + buffer)`
 *   day use : `[pickup, day-use end + buffer)`
 *
 * **The custom one-way transfer throws, deliberately, and it is a real gap.**
 * A staff-quoted transfer with no catalog route (`bookings.route_id IS NULL`)
 * has no stored duration anywhere in the schema — T5 added none, and
 * Architecture §2's formula assumes `route.estimated_duration_minutes` is
 * always there. Nothing can create that booking yet (it needs Task T19's
 * staff-conversion flow), so this throw is unreachable today. It is a throw
 * rather than a guessed duration because a guess is a window that is wrong by
 * an unknown amount, in an unknown direction, with nothing to flag it: it
 * would either oversell a vehicle that is still out, or refuse a booking that
 * would have fitted, and neither would ever be traced back to here. T19 must
 * either carry an explicit staff-entered duration (a new column, out of T7's
 * declared scope) or compute a window some other way; it must not soften this
 * into a default.
 */
export function computeTransferWindow(input: TransferWindowInput): TransferWindowResult {
  const { productType, pickupTimeMinutes, bufferMinutes } = input;

  assertMinuteOfDay(pickupTimeMinutes, 'pickupTimeMinutes');
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0) {
    throw new RangeError(`Expected a whole, non-negative bufferMinutes, got ${bufferMinutes}`);
  }

  let endBeforeBuffer: number;

  if (productType === 'transfer_one_way') {
    const duration = input.routeDurationMinutes;
    if (duration === null) {
      throw new Error(
        'A one-way transfer window needs a route duration, and this one has none — ' +
          'a custom, staff-quoted route stores no duration (see computeTransferWindow). ' +
          'Task T19 must supply an explicit duration rather than defaulting one.',
      );
    }
    if (!Number.isInteger(duration) || duration <= 0) {
      throw new RangeError(`Expected a whole, positive routeDurationMinutes, got ${duration}`);
    }
    endBeforeBuffer = pickupTimeMinutes + duration;
  } else {
    const end = input.dayUseEndTimeMinutes;
    if (end === null) {
      throw new Error(
        'A day-use transfer window needs a dayUseEndTimeMinutes, and this one is null',
      );
    }
    assertMinuteOfDay(end, 'dayUseEndTimeMinutes');
    if (end <= pickupTimeMinutes) {
      throw new RangeError(
        `A day-use transfer must end after it starts: pickup ${pickupTimeMinutes}, end ${end}`,
      );
    }
    endBeforeBuffer = end;
  }

  const endMinutes = endBeforeBuffer + bufferMinutes;
  /*
   * `>`, not `>=`: an end of exactly 1440 is midnight itself, and the interval
   * is half-open, so `[x, 1440)` occupies the whole rest of the day and no part
   * of the next one. Only genuinely spilling PAST midnight is refused.
   */
  if (endMinutes > MINUTES_PER_DAY) return { ok: false, reason: 'crosses_midnight' };

  return { ok: true, window: { startMinutes: pickupTimeMinutes, endMinutes } };
}

/**
 * `"HH:mm"` (the stored civil label) to minutes since midnight, or `null` when
 * the string is not one.
 *
 * Returns `null` rather than throwing because its only caller reads values that
 * are already in the database: a malformed stored label is a data problem to be
 * handled conservatively at that call site (see `windowForBookedTransfer` in
 * `./capacity.ts`), not a reason to 500 a guest's quote. A NEW candidate's
 * times arrive as numbers through the Zod boundary and never pass through here.
 */
export function clockTimeToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
