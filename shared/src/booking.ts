/**
 * Booking vocabulary, shared by client and server.
 *
 * Money is integer CENTAVOS everywhere (CLAUDE.md): every amount in this
 * module is an `int` named `*Centavos`, and there is no float anywhere near
 * a price. Percentages that are not money — the deposit percent — are whole
 * integers, and a coupon's percentage is basis points (see ./coupon).
 *
 * Nothing here computes a price. `depositCentavos()` in ./money owns the
 * deposit arithmetic, and the server owns every total: the browser never
 * sends one.
 */
import { z } from 'zod';
import { couponDiscountSchema } from './coupon';

/**
 * BUILD_SPEC §5 "Booking statuses", in the spec's own order.
 *
 * The order is part of the contract, not decoration: it is the lifecycle
 * order a tracker renders in, and the five capacity-holding statuses are the
 * first five precisely because capacity is held until a booking leaves the
 * live part of that lifecycle.
 *
 * `cancelled` and `expired` are separate terminal states — "an admin
 * cancelled this" and "the 15-minute hold ran out" are different events, and
 * refunds only ever attach to the first. Refunds themselves are tracked on
 * `payments`, never as a booking status.
 */
export const BOOKING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

/**
 * The statuses BUILD_SPEC §5's table marks **"Holds capacity: Yes"**, and
 * nothing else.
 *
 * Derived from that table and nowhere else. The §5 capacity check counts
 * bookings in these statuses against `groups_per_day`, and against van and
 * driver availability.
 *
 * **The two directions of error are not symmetrical.** Adding a status here
 * oversells nothing but refuses valid bookings — annoying, visible, and
 * reported within the hour. REMOVING one oversells the fleet: the system
 * cheerfully sells a trip it cannot run, and that is discovered by a family
 * standing on a kerb in Cebu at 6am with no van. Hence the explicit test
 * (`server/src/__tests__/schema-bookings.test.ts`), which pins the set in
 * both directions rather than only checking membership.
 *
 * `satisfies readonly BookingStatus[]` is deliberate: a typo'd status here
 * would otherwise be a perfectly valid string that silently matches no
 * booking row, i.e. a capacity check that quietly stops counting a whole
 * status. This way it fails `pnpm typecheck`.
 */
export const CAPACITY_HOLDING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
] as const satisfies readonly BookingStatus[];
export type CapacityHoldingStatus = (typeof CAPACITY_HOLDING_STATUSES)[number];

/**
 * The words every surface uses for a booking status, in §5's order.
 *
 * `Record<BookingStatus, string>` so the compiler refuses a build where a
 * ninth status has no words — the same guard `INQUIRY_STATUS_LABELS` uses.
 *
 * **Why shared.** Four byte-identical copies of this map had grown up
 * independently (`DeparturesBoard`, `AdminBookingsPage`, `AdminCalendarPage`
 * and `BookingStatusPill`), two of them carrying comments arguing opposite
 * sides of whether a dictionary this short is worth sharing. Settled by
 * doing it: the words a guest and a dispatcher read for the same status must
 * not be able to drift, and the typed `Record` only guards the copy it is
 * written on.
 *
 * The TONE maps stay where they are. `DeparturesBoard` and
 * `BookingStatusPill` group these statuses differently on purpose (a
 * departures row highlights `in_progress`; a pill tints by "waiting on us /
 * on track / closed"), so those are two deliberate designs rather than two
 * copies of one.
 */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending_payment: 'Awaiting payment',
  pending_verification: 'Checking receipt',
  confirmed: 'Confirmed',
  assigned: 'Driver assigned',
  in_progress: 'On tour',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/** §6: the guest pays the whole price now, or the deposit now and the balance on tour day. */
export const PAY_MODES = ['full', 'deposit'] as const;
export type PayMode = (typeof PAY_MODES)[number];
export const payModeSchema = z.enum(PAY_MODES);

/**
 * Trims surrounding whitespace, then uppercases.
 *
 * BUG-108: a guest who typed or pasted a ref out of an email may bring
 * whitespace with it, or type it lower- or mixed-case — `rg-7kq4m9`,
 * `Rg-7KQ4m9`. Refs are *generated* uppercase-only
 * (`generateBookingRef()` / `REF_ALPHABET`, `server/src/services/booking-ref.ts`),
 * and `bookings.ref`'s column collation happens to compare case-insensitively,
 * but neither fact was ever asserted in code — three procedures validated the
 * shape three different ways before this, one of them (`bookingLookupInput`)
 * not checking case at all. Folding this into {@link bookingRefSchema} below,
 * ahead of the shape check, makes every input that accepts a ref agree on
 * what counts as one, by construction rather than by accident.
 */
export function normalizeBookingRef(ref: string): string {
  return ref.trim().toUpperCase();
}

/**
 * `RG-` plus six unambiguous characters: `RG-7KQ4M9`.
 *
 * The character class omits `0/O`, `1/I/L` and `U` so a ref survives being
 * read aloud over a bad phone line. It must stay in lockstep with
 * `REF_ALPHABET` in `server/src/services/booking-ref.ts` (plan Task 9) —
 * widen one without the other and the generator mints refs this schema
 * rejects.
 *
 * Refs are random and non-sequential because §7 logs a guest into the portal
 * with ref + email: a guessable ref is half a credential.
 *
 * **Case-insensitive on lookup, normalised to uppercase on the server**
 * (BUG-108, owner decision 2026-10-23, Q10): `.transform()` runs
 * {@link normalizeBookingRef} BEFORE `.pipe()`'s shape check, so a lowercase
 * or mixed-case ref, or one with surrounding whitespace, is normalised first
 * and then validated — not loosened. A string that is still the wrong length
 * or charset after normalising is refused exactly as before. Refs are still
 * *generated* uppercase; nothing about `generateBookingRef()` changes.
 *
 * The refusal **shows the shape** (task A4). "Not a valid booking reference"
 * told a guest staring at their confirmation email nothing about what they
 * should be looking for; `RG-7KQ4M9` does. The pattern and the normalising
 * are unchanged — only the sentence.
 */
export const bookingRefSchema = z
  .string()
  .transform(normalizeBookingRef)
  .pipe(
    z
      .string()
      .regex(
        /^RG-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/,
        'Enter a valid booking reference, like RG-7KQ4M9.',
      ),
  );

/** One add-on line as frozen into a booking's price snapshot. */
const snapshotAddonSchema = z.object({
  addonId: z.number().int().positive(),
  /** The add-on's name AT BOOKING TIME. It may be renamed later. */
  name: z.string().min(1),
  priceCentavos: z.number().int().nonnegative(),
  /** True when the price multiplies by `pax`; false when it is per booking. */
  perPerson: z.boolean(),
  qty: z.number().int().positive(),
});

/** The coupon as frozen into a booking's price snapshot, or `null` for none. */
const snapshotCouponSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  /** Reuses the live discount union, so the frozen shape cannot drift from it. */
  discount: couponDiscountSchema,
});

/**
 * The frozen copy of everything a booking's price **and its refund rights**
 * depend on (BUILD_SPEC §5; owner decision 2026-10-11, Q5). Stored in
 * `bookings.price_snapshot`, written once at booking time, never updated.
 *
 * **Refund and cancellation logic reads this, never the live tour.** That is
 * the entire point. An admin who edits a tour's price, or shortens its
 * cancellation window from 48 hours to 12, must not retroactively change
 * what a guest who already booked agreed to. §5 guarantees that for the
 * price; freezing `freeCancelHours` extends the same guarantee to the
 * refund.
 *
 * So two fields here are load-bearing beyond pricing:
 *
 *   - `freeCancelHours` — the tour's `free_cancel_hours` as it stood when
 *     the guest booked. Without it, cancellation has to ask the live tour,
 *     and a tour edit silently rewrites a guest's rights.
 *   - `depositPercent` — the deposit percent in force at booking time, so
 *     the balance owed on tour day is computable from the booking alone
 *     even after the setting changes.
 *
 * The `*_centavos` columns on `bookings` are a queryable SUMMARY of the
 * totals in here, not a second source of truth.
 *
 * Nothing writes this yet (plan Task 8 creates the column only). It is a
 * schema rather than a doc comment so that a later writer cannot quietly
 * drop a field: an object missing `freeCancelHours` or `depositPercent`
 * fails to parse and fails to typecheck.
 */
export const priceSnapshotSchema = z.object({
  /** The price tier actually used, and its per-person price at booking time. */
  tier: z.object({
    tierId: z.number().int().positive(),
    minPax: z.number().int().positive(),
    maxPax: z.number().int().positive(),
    pricePerPersonCentavos: z.number().int().nonnegative(),
  }),
  /** Every add-on taken, each with its own price and per-person flag. */
  addons: z.array(snapshotAddonSchema),
  /** The coupon applied, or null. */
  coupon: snapshotCouponSchema.nullable(),
  /** Whole percent, e.g. 30 for a 30% deposit. Never a float. */
  depositPercent: z.number().int().min(0).max(100),
  /** The tour's `free_cancel_hours` at booking time. Refund logic reads THIS. */
  freeCancelHours: z.number().int().nonnegative().nullable(),
  /** The computed totals, mirroring the booking's own summary columns. */
  subtotalCentavos: z.number().int().nonnegative(),
  discountCentavos: z.number().int().nonnegative(),
  totalCentavos: z.number().int().nonnegative(),
});
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;

/**
 * The longest office note `admin.bookings.addNote` accepts, in characters.
 *
 * `booking_notes.note` is `text` (65,535 BYTES), so the column would take far
 * more; this is the product limit, and it sits well inside the column even
 * for a note of four-byte characters (2,000 x 4 = 8,000 bytes). A note is an
 * instruction or a record of a conversation, not a document — and everything
 * stored here is shown whole on the booking screen.
 */
export const BOOKING_NOTE_MAX_LENGTH = 2000;

/**
 * Input to `admin.bookings.addNote` (owner decision 2026-10-16, D6).
 *
 * **`visibleToDriver` is REQUIRED, and has no default.** The caller states the
 * decision on every note rather than inheriting one: a default of `true`
 * would put an unflagged note in a van, and a default of `false` would let a
 * forgotten field read as a considered choice. The database column defaults
 * to `false` for rows written by anything that does not go through here; this
 * is the stricter rule for the one thing that does.
 *
 * `note` is trimmed before the length check, so a note of spaces is refused
 * and stored text carries no leading or trailing blanks.
 */
export const addBookingNoteInputSchema = z
  .object({
    bookingId: z.number().int().positive(),
    note: z
      .string()
      .trim()
      .min(1, 'Write the note first.')
      .max(BOOKING_NOTE_MAX_LENGTH, `Keep a note under ${BOOKING_NOTE_MAX_LENGTH} characters.`),
    visibleToDriver: z.boolean(),
  })
  .strict();
export type AddBookingNoteInput = z.infer<typeof addBookingNoteInputSchema>;
