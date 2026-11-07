/**
 * The guest-facing transfer HOLD input (transfers-launch plan, Task T11) — the
 * wire shape `checkout.createHoldTransfer` validates a request against.
 *
 * **Its own module for one measured reason.** It reuses `PAY_MODES`
 * (`./booking`), `civilDateSchema` and `leadSchema` (`./checkout`) rather than
 * declaring a second copy of any of them — and `./booking` imports
 * `./transfers`, so putting this schema in `./transfers` beside
 * `quoteTransferInput` made a cycle that broke the whole suite at import time:
 * `./booking` starts loading, reaches its `./transfers` import, `./transfers`
 * then imports `./checkout`, and `./checkout`'s own `./booking` import is
 * answered from the module ALREADY IN PROGRESS — so **`checkout.ts` is handed a
 * half-initialised `booking.ts`**, `PAY_MODES` is still `undefined`, and
 * `z.enum(undefined)` throws from inside `checkout.ts`. This file is imported
 * by nothing but `./index.ts`, so it can depend on all three safely.
 *
 * A plan-ordering note for whoever picks up **T12** ("shared Zod inputs for
 * quote/hold"): the hold input is DONE, here, and so is the `leadSchema`
 * extraction it needed. T12's remaining scope is whatever client-side work is
 * left — not this schema again (controller ruling, 2026-11-03).
 */
import { z } from 'zod';
import { PAY_MODES } from './booking';
import { civilDateSchema, leadSchema } from './checkout';
import { quoteTransferInput, TRANSFER_DIRECTIONS } from './transfers';

/**
 * A civil `HH:mm` clock label, Asia/Manila — **the exact pattern
 * `clockTimeToMinutes()` (`server/src/services/transfers/overlap.ts`) accepts**,
 * character for character: a label this schema accepts and that function
 * rejects would reach `assertBookableShape`'s `pickup_time_unreadable`
 * refusal, which is written to fail closed rather than to be friendly.
 *
 * **Named rather than inlined because the `superRefine` below has to ask the
 * same question a second time** (T11 review, Important finding): Zod 4 runs a
 * `superRefine` even when a field-level check has already failed, so the
 * cross-field comparison down there cannot assume `pickupTime` matched — it
 * tests it against this same constant first. Two copies of this pattern is how
 * the two answers come to disagree.
 *
 * No `/g` flag, deliberately: a global regex carries `lastIndex` between
 * `.test()` calls, and this one is tested from two places.
 */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * One clock field, with a guest-facing sentence instead of Zod's own. The
 * MESSAGE is a parameter because "pickup time" and "end time" are two
 * different boxes on one form, and task A4's rule is that every message names
 * its own field.
 */
const clockTimeField = (message: string) => z.string().regex(CLOCK_TIME_PATTERN, message);

/**
 * What the browser may send `checkout.createHoldTransfer` (Task T11) — the
 * transfer counterpart of `createHoldInput` (`./checkout.ts`), and the same
 * relationship to {@link quoteTransferInput} that one has to `quoteInput`: the
 * quote's three identifiers, extended with everything a journey needs.
 *
 * **Nothing here is money.** No price, no subtotal, no total, no deposit — the
 * server reads the catalog rate inside `createTransferBooking()`'s own
 * transaction, and `.strict()` makes a request carrying an amount a REFUSAL
 * rather than a silently dropped field (CLAUDE.md: "The server computes all
 * money").
 *
 * **Deliberately absent, and each absence is load-bearing:**
 *
 *  - **No `customRouteDescription`.** This wrapper is catalog-only
 *    (Architecture §3): a guest picks a published route, so `routeId` is
 *    required and the custom-description branch belongs to T19's staff
 *    conversion, which does not come through this input at all.
 *  - **No `quoteId`.** The tour's replay digest protects a price the client
 *    echoes back; `createTransferBooking()` re-derives the price itself from
 *    the catalog under its own lock, so there is nothing for a digest to
 *    protect (T9's own reasoning, see `quoteTransferResultSchema` in
 *    `./transfers.ts`).
 *  - **No vehicle, driver or capacity field.** Who drives and which van goes is
 *    dispatch's decision, taken later.
 *
 * **Every refusal below is a FRIENDLY restatement of a rule the server enforces
 * anyway**, never a rule of its own. `assertBookableShape()`
 * (`server/src/services/transfers/create-booking.ts`) is the backstop, and it
 * stays the authority: a guest meets each rule once here, in a sentence they can
 * act on, and once there, where it fails closed. The two must never disagree —
 * if a bound changes, it changes in both.
 */
export const createHoldTransferInput = quoteTransferInput
  .extend({
    /** The civil PICKUP date in Asia/Manila. Same schema a tour hold uses. */
    date: civilDateSchema,
    /**
     * Which way a reversible route is being travelled (owner decision
     * 2026-11-08) — a QUOTE names a product; a HOLD describes a journey,
     * which is why this lives here and not on `quoteTransferInput`. The
     * server refuses `'reverse'` against a route whose `reverseEnabled` is
     * off, inside `createTransferBooking()` (it needs the resolved route, so
     * it cannot be a Zod-level check here).
     */
    direction: z.enum(TRANSFER_DIRECTIONS),
    pickupTime: clockTimeField('Enter a pickup time as HH:mm, like 08:30.'),
    /**
     * Day-use only, and the conditional half of that is in the `superRefine`
     * below — required on a `transfer_day_use` request, refused on a
     * `transfer_one_way` one, mirroring `assertBookableShape`'s
     * `day_use_end_time_missing` / `day_use_end_time_on_one_way` reasons.
     */
    dayUseEndTime: clockTimeField('Enter an end time as HH:mm, like 17:00.').optional(),
    /**
     * Passengers. The upper bound mirrors `vanInputSchema.capacity`'s own
     * (`./dispatch.ts`, max 30) — the largest vehicle an admin can enter — so
     * this refuses only parties no vehicle in any fleet could seat.
     *
     * **It is NOT a capacity check and must not be mistaken for one.** Whether
     * a party FITS the vehicle they picked is dispatch's own soft seat-fit
     * check (pre-task 0C), made later against a specific van's `capacity` and
     * `luggage_capacity`; a transfer's price does not depend on `pax` at all
     * (see `quoteTransferInput`'s note).
     */
    pax: z
      .number()
      .int('Enter a whole number of passengers.')
      .min(1, 'Enter how many passengers are travelling.')
      .max(30, 'For a party that size, please contact us so we can arrange several vehicles.'),
    /** Bags. Bound mirrors `vanInputSchema.luggageCapacity`'s own (max 200). */
    luggageCount: z
      .number()
      .int('Enter a whole number of bags.')
      .min(0, 'Enter how many bags you are bringing (0 if none).')
      .max(200, 'Enter how many bags you are bringing (up to 200).'),
    /**
     * The pickup ADDRESS. Optional and bounded exactly as a tour's `pickup` is
     * — it rides on the same `bookings.pickup` column (Architecture §1).
     */
    pickup: z
      .string()
      .max(400, 'Enter a shorter pickup address (up to 400 characters).')
      .optional(),
    pickupMapUrl: z
      .url('Enter a valid map link for the pickup, or leave it blank.')
      .max(500, 'That map link is too long — please shorten it or leave it blank.')
      .optional(),
    /**
     * **Required**, unlike `pickup`: a tour names its own destination, a
     * transfer does not. A one-way trip to nowhere is not a bookable journey.
     */
    dropoffAddress: z
      .string()
      .min(1, 'Enter where you are going.')
      .max(400, 'Enter a shorter drop-off address (up to 400 characters).'),
    dropoffMapUrl: z
      .url('Enter a valid map link for the drop-off, or leave it blank.')
      .max(500, 'That map link is too long — please shorten it or leave it blank.')
      .optional(),
    /**
     * One-way only, refused on a day-use hire by the `superRefine` below —
     * `assertBookableShape`'s `flight_details_on_day_use` reason, said
     * politely. **Optional at this Zod layer even on a one-way trip** — a
     * route's places (and therefore whether either end is an airport) are
     * resolved server-side, inside `createTransferBooking()`, after the
     * catalog read; "flight fields are required when either end of the
     * route is an airport place" (owner decision 2026-11-08, decision 5) is
     * enforced there, not here, because it needs the resolved route.
     */
    flightNumber: z.string().max(20, 'Enter a shorter flight number.').optional(),
    airline: z.string().max(80, 'Enter a shorter airline name.').optional(),
    requests: z
      .string()
      .max(2000, 'Please shorten your notes (up to 2,000 characters).')
      .optional(),
    /** The SAME enum a tour hold uses — one vocabulary for how a guest pays. */
    payMode: z.enum(PAY_MODES),
    /** The SAME schema a tour hold uses, so the two forms cannot drift. */
    lead: leadSchema,
    /** RA 10173. Anything but `true` fails here, before the router runs. */
    consent: z.boolean().refine((v) => v === true, { message: 'Consent is required' }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.productType === 'transfer_day_use') {
      if (value.dayUseEndTime === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dayUseEndTime'],
          message: 'Tell us what time you need the vehicle until.',
        });
      } else if (
        /*
         * **`pickupTime` is re-tested here, and that gate is the fix for a real
         * bug** (T11 review, Important finding). The comparison below is a
         * plain string compare, which is only chronological while BOTH sides
         * are zero-padded 24-hour `HH:mm` — and Zod 4 runs a `superRefine`
         * even when a field-level check has already failed, so reaching this
         * line proves nothing about `pickupTime`. Measured: a day-use request
         * with `pickupTime: '8:00'` and `dayUseEndTime: '17:00'` produced TWO
         * messages, the correct one on `pickupTime` and a FALSE one on
         * `dayUseEndTime`, because `'17:00' <= '8:00'` is lexicographically
         * true when the hour is not padded. A nine-hour window reported as
         * ending before it starts is exactly the "one bad field marks another
         * field invalid" class BUG-120 exists for, and it would send a guest
         * "fixing" a field that was never wrong.
         *
         * A known-bad `pickupTime` therefore skips this comparison entirely —
         * its own field-level issue has already fired, and once the guest pads
         * the hour the pair is compared for real.
         */
        CLOCK_TIME_PATTERN.test(value.pickupTime) &&
        // STRICTLY after, mirroring `day_use_end_time_not_after_pickup`: a
        // window of `[x, x)` is empty, so the hire would occupy no vehicle at
        // all and be sold against nothing.
        value.dayUseEndTime <= value.pickupTime
      ) {
        /*
         * Lexicographic order IS chronological order on a padded `HH:mm` —
         * the same reasoning `bookableDateRange()` documents for its cutoff
         * compare, now with the padding actually guaranteed at this point.
         */
        ctx.addIssue({
          code: 'custom',
          path: ['dayUseEndTime'],
          message: 'The end time must be later than the pickup time.',
        });
      }
      for (const field of ['flightNumber', 'airline'] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'A day-use hire carries no flight — please leave the flight details blank.',
          });
        }
      }
      return;
    }

    if (value.dayUseEndTime !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dayUseEndTime'],
        message: 'A one-way transfer has no end time — please leave it blank.',
      });
    }
  });
export type CreateHoldTransferInput = z.infer<typeof createHoldTransferInput>;
