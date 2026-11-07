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
import { TRANSFER_PRODUCT_TYPES } from './transfers';

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
 * Where a transfer's price came from (transfers-launch plan, Architecture §1 and
 * §3) — the catalog (`transfer_route_vehicle_prices`, the guest self-serve path)
 * or a staff-entered quote (Task T19's conversion of a custom request).
 *
 * It lives in the SNAPSHOT rather than as a `bookings` column, by the plan's own
 * wording: nothing about dispatch, payments, check-ins or reports ever needs to
 * know which path created a booking, so the fact belongs with the frozen record
 * of what the guest agreed to and nowhere else.
 */
export const TRANSFER_PRICE_SOURCES = ['catalog', 'staff_quote'] as const;
export type TransferPriceSource = (typeof TRANSFER_PRICE_SOURCES)[number];

/**
 * The frozen copy of a TRANSFER booking's price and refund rights — the same
 * contract {@link priceSnapshotSchema} holds for a tour, in the shape
 * Architecture §1 specifies, written once by `createTransferBooking()` (Task
 * T10) and never updated.
 *
 * **Why a separate schema instead of widening the tour's.** A transfer has no
 * price tier, no add-ons and no head count in its price (it is a flat
 * per-vehicle rate — see `services/transfers/pricing.ts`), and the tour schema
 * REQUIRES `tier` and `addons`. Widening it would mean making both optional,
 * which would stop it catching a tour writer that forgot either one — the very
 * thing it exists for.
 *
 * Two fields are load-bearing beyond pricing, exactly as on the tour:
 *
 *   - `freeCancelHours` — the ROUTE's `free_cancel_hours` as it stood when the
 *     guest booked, so a later catalog edit cannot rewrite their refund rights.
 *     Nullable, because a custom staff-quoted trip has no catalog route to read
 *     one from.
 *   - `depositPercent` — the deposit percent in force at booking time, so the
 *     balance owed on the day is computable from the booking alone.
 *
 * `priceCentavos` is the per-vehicle RATE the quote was built from — the
 * transfer's counterpart to the tour snapshot's `tier.pricePerPersonCentavos`,
 * not a duplicate of `subtotalCentavos`. They are equal today because nothing
 * multiplies a flat rate; keeping the rate named separately is what lets a later
 * reader tell "the van cost ₱3,500" from "the subtotal happened to be ₱3,500".
 */
export const transferPriceSnapshotSchema = z
  .object({
    /** Mirrors `bookings.product_type`. Never `'tour'` — that is the other shape. */
    productType: z.enum(TRANSFER_PRODUCT_TYPES),
    /**
     * **Legacy only (owner decision 2026-11-08).** Every snapshot written
     * before vehicle types became admin-managed carries the literal
     * `'van'`/`'suv'` string here. **No new write ever produces a value in
     * this field** — `buildTransferSnapshot()` writes `vehicleTypeId` /
     * `vehicleTypeName` below instead. Loosened from the old two-literal
     * enum to a bare optional string because nothing writes it anymore; a
     * schema still enforcing `'van' | 'suv'` on a dead field is pointless
     * weight. Confirmed by code search, 2026-11-08: nothing in the
     * codebase reads this field today — `dispatch/assign.ts` reads the
     * `bookings.vehicle_type_id` COLUMN, not the snapshot — so this is
     * read-compatibility for a value nothing currently consumes, kept so a
     * FUTURE reader (the display-label helper) can still resolve an old
     * booking correctly.
     */
    vehicleType: z.string().optional(),
    /** The vehicle type's id at booking time (owner decision 2026-11-08). Absent on a legacy snapshot. */
    vehicleTypeId: z.number().int().positive().optional(),
    /**
     * The vehicle type's NAME, frozen at booking time — same discipline as
     * every other frozen field here: an admin renaming or deactivating the
     * type later must not change what an old receipt says. Absent on a
     * legacy snapshot.
     */
    vehicleTypeName: z.string().optional(),
    /** Mirrors `bookings.route_id`. Null only for a custom, staff-quoted trip. */
    routeId: z.number().int().positive().nullable(),
    /**
     * Mirrors `booking_transfer_details.custom_route_description`. Exactly one of
     * this and `routeId` is set — the cross-table invariant
     * `createTransferBooking()` enforces, frozen here so the snapshot alone says
     * which trip was sold.
     */
    customRouteDescription: z.string().min(1).nullable(),
    priceSource: z.enum(TRANSFER_PRICE_SOURCES),
    /** The flat per-vehicle rate the quote was built from. */
    priceCentavos: z.number().int().nonnegative(),
    /** The coupon applied, or null — the SAME shape a tour snapshot freezes. */
    coupon: snapshotCouponSchema.nullable(),
    /** Whole percent, e.g. 30 for a 30% deposit. Never a float. */
    depositPercent: z.number().int().min(0).max(100),
    /** The ROUTE's `free_cancel_hours` at booking time. Refund logic reads THIS. */
    freeCancelHours: z.number().int().nonnegative().nullable(),
    /** The computed totals, mirroring the booking's own summary columns. */
    subtotalCentavos: z.number().int().nonnegative(),
    discountCentavos: z.number().int().nonnegative(),
    totalCentavos: z.number().int().nonnegative(),
  })
  .refine((s) => s.vehicleTypeId !== undefined || s.vehicleType !== undefined, {
    message: 'A transfer snapshot must carry either a legacy vehicleType or a vehicleTypeId.',
    path: ['vehicleTypeId'],
  });
export type TransferPriceSnapshot = z.infer<typeof transferPriceSnapshotSchema>;

/**
 * The single place every display surface asks "what vehicle type was this
 * booking" (owner decision 2026-11-08) — resolves either shape
 * {@link transferPriceSnapshotSchema} can hold. No surface hand-rolls this
 * fallback a second time, the same discipline `TRANSFER_BOOKING_LABEL`
 * already established for "what do we call a transfer booking with no tour."
 */
export function transferSnapshotVehicleTypeLabel(snapshot: TransferPriceSnapshot): string {
  if (snapshot.vehicleTypeName) return snapshot.vehicleTypeName;
  if (snapshot.vehicleType) {
    return snapshot.vehicleType.charAt(0).toUpperCase() + snapshot.vehicleType.slice(1);
  }
  return 'Vehicle';
}

/**
 * What `bookings.price_snapshot` can hold: a tour snapshot or a transfer one.
 *
 * **A plain `z.union`, not a `z.discriminatedUnion`, and that is deliberate.**
 * A discriminated union needs the discriminant literal on EVERY member, which
 * would mean adding a field to {@link priceSnapshotSchema} — and every tour
 * snapshot already stored in the database was written without it, so a required
 * discriminant would make every existing row fail to parse, while a defaulted
 * one would still appear in the inferred type and break every caller that
 * builds a tour snapshot by hand. The tour shape is therefore untouched, and the
 * two members are told apart STRUCTURALLY, by the transfer member's own
 * `productType` — the same discriminator `bookings.product_type` already is on
 * the row. The two are unambiguous: a tour snapshot has `tier`/`addons` and no
 * `productType`; a transfer snapshot has `productType`/`vehicleType` and no
 * `tier`.
 *
 * `depositPercent`, `freeCancelHours` and the three `*Centavos` totals are on
 * BOTH members on purpose: every one of them is read off a booking's snapshot
 * without caring which product it is (`record-payment.ts`, `manual-receipt.ts`,
 * `checkout.bookingStatus` and the two portal views all read
 * `.depositPercent`), and TypeScript allows reading a field common to every
 * member of a union with no narrowing at all. Anything tour-ONLY (`tier`,
 * `addons`) must narrow first — {@link isTransferPriceSnapshot} is the one way
 * to do it.
 */
export const bookingPriceSnapshotSchema = z.union([
  priceSnapshotSchema,
  transferPriceSnapshotSchema,
]);
export type BookingPriceSnapshot = z.infer<typeof bookingPriceSnapshotSchema>;

/**
 * Narrows a stored snapshot to the transfer shape.
 *
 * Keys on `productType`'s PRESENCE rather than its value: the tour member has no
 * such field at all, so `'productType' in snapshot` is the whole question, and
 * the schema guarantees the field can only ever be one of the two transfer
 * products when it is there.
 */
export function isTransferPriceSnapshot(
  snapshot: BookingPriceSnapshot,
): snapshot is TransferPriceSnapshot {
  return 'productType' in snapshot;
}

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
