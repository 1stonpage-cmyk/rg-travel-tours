/**
 * Behavioral parity across the three independent `HH:mm` clock-time regexes
 * in this codebase (transfers-launch plan, Task T12).
 *
 * The three copies are NOT byte-identical:
 *
 *  1. `shared/src/transfers-checkout.ts`, `CLOCK_TIME_PATTERN` (module-private):
 *     `/^([01]\d|2[0-3]):([0-5]\d)$/`
 *  2. `server/src/services/transfers/overlap.ts`, inside the exported
 *     `clockTimeToMinutes()`: `/^([01]\d|2[0-3]):([0-5]\d)$/`
 *  3. `server/src/content/settings-schema.ts`, `clockTime` (module-private):
 *     `/^([01]\d|2[0-3]):[0-5]\d$/` — no capturing group around the minutes.
 *
 * Pattern 3's missing group makes it NOT byte-identical to the other two, but
 * it accepts and rejects exactly the same strings — a `.source`-string
 * equality assertion would fail on day one for no real reason, so this file
 * drives all three through their own real PUBLIC surface instead and checks
 * that every surface agrees with the same shared sample table. If a future
 * edit changes one pattern's accept/reject behaviour without changing the
 * other two, this test goes red.
 *
 * Deliberately NOT exporting either private `const`, and NOT consolidating
 * the three into one shared constant (T12 brief, controller ruling): pattern
 * 3 also backs `businessHourEntrySchema`'s nullable `opensAt`/`closesAt`
 * fields, so pulling it from `@rg/shared` would be a settings-validation
 * behaviour change for zero gain, reaching code this task has no reason to
 * touch. This test is the whole deliverable for the drift risk.
 */
import { describe, expect, it } from 'vitest';
import { createHoldTransferInput } from '@rg/shared';
import { clockTimeToMinutes } from '../services/transfers/overlap';
import { SETTING_SCHEMAS } from '../content/settings-schema';

/**
 * One shared table, driven through all three surfaces. Covers: correctly
 * zero-padded edges of the day (`'00:00'`, `'23:59'`), an ordinary mid-day
 * value, a non-zero-padded hour, an out-of-range hour, an out-of-range
 * minute, and a string that is not the `HH:mm` shape at all.
 */
const CLOCK_TIME_SAMPLES = [
  ['08:30', true],
  ['00:00', true],
  ['23:59', true],
  ['8:00', false], // not zero-padded
  ['24:00', false], // hour out of range
  ['12:60', false], // minute out of range
  ['7am', false], // not the HH:mm shape
] as Array<[string, boolean]>;

/**
 * A minimal, otherwise-valid `transfer_one_way` hold payload — every field
 * but `pickupTime` filled with a value that passes on its own, so a failure
 * on any OTHER field would be a bug in this fixture, not a finding about the
 * clock pattern. `dropoffAddress` is required on a one-way transfer;
 * `dayUseEndTime`/`flightNumber`/`airline` are left unset, all valid states
 * for `transfer_one_way`.
 */
function oneWayPayload(pickupTime: string) {
  return {
    routeId: 1,
    vehicleType: 'van' as const,
    productType: 'transfer_one_way' as const,
    date: '2027-06-15',
    pickupTime,
    pax: 2,
    luggageCount: 1,
    dropoffAddress: 'Mactan-Cebu International Airport',
    payMode: 'full' as const,
    lead: {
      name: 'Juan Dela Cruz',
      email: 'juan@example.com',
      phone: '09171234567',
    },
    consent: true,
  };
}

describe('clock-time regex parity across the three independent copies', () => {
  it.each(CLOCK_TIME_SAMPLES)(
    'createHoldTransferInput.pickupTime: %s -> accept=%s',
    (value, shouldAccept) => {
      const result = createHoldTransferInput.safeParse(oneWayPayload(value));
      expect(result.success).toBe(shouldAccept);
      if (!result.success) {
        // A rejection must come from pickupTime itself, not some other field
        // failing instead — which would prove nothing about this pattern.
        const paths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(paths).toContain('pickupTime');
      }
    },
  );

  it.each(CLOCK_TIME_SAMPLES)('clockTimeToMinutes(%s) -> accept=%s', (value, shouldAccept) => {
    const minutes = clockTimeToMinutes(value);
    if (shouldAccept) {
      expect(minutes).not.toBeNull();
      expect(typeof minutes).toBe('number');
    } else {
      expect(minutes).toBeNull();
    }
  });

  it.each(CLOCK_TIME_SAMPLES)(
    'SETTING_SCHEMAS.booking.nextDayCutoffTime: %s -> accept=%s',
    (value, shouldAccept) => {
      const result = SETTING_SCHEMAS.booking.safeParse({
        minLeadDays: 0,
        maxAdvanceDays: 30,
        nextDayCutoffTime: value,
      });
      expect(result.success).toBe(shouldAccept);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(paths).toContain('nextDayCutoffTime');
      }
    },
  );
});
