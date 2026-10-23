/**
 * `upsertTourContent` — the ONE writer of a tour and four of its child tables
 * (Week 7 plan, Task 6; BUILD_SPEC §9 "Tours & pricing").
 *
 * The four are `tour_price_tiers`, `tour_images`, `tour_itinerary_stops` and
 * `tour_addons`. **`tour_blocked_dates` is deliberately not one of them**: a
 * blocked date is a calendar act rather than a content edit, nothing writes
 * that table yet, and sweeping it into a wholesale content replacement would
 * mean a save of a tour's prose silently un-blocked a holiday.
 *
 * ## Why this is a service and not resolver bodies
 *
 * `admin.tours.create` and `admin.tours.update` differ by one thing: whether a
 * `tours` row has to be inserted or updated. Everything after that — the
 * overlap refusal, and the delete-then-reinsert of tiers, images, itinerary
 * stops and add-ons — is identical, and two copies of a delete-then-reinsert
 * of a MONEY table is how one of them quietly stops matching the other.
 *
 * ## It takes a transaction; it never opens one
 *
 * **BUG-045 is exactly this code's shape in the seed.** `upsertTour` in
 * `db/seed.ts` deletes a tour's price tiers and then inserts the replacements
 * with no transaction at all, so a failure between the two leaves a tour with
 * no prices — live on the public site, unquotable at checkout. The fix here is
 * structural rather than careful: this function's first parameter is the
 * caller's `Transaction`, there is no `getDb()` call anywhere in this file, and
 * the router opens exactly one transaction per mutation. A rollback therefore
 * takes the parent row and every child row with it, which is what
 * `admin-tours.test.ts`'s "writes the tour and every child row inside the
 * CALLER transaction" proves by rolling one back on purpose.
 *
 * ## Wholesale replacement, and why the children have no natural key
 *
 * None of the five child tables has a column a human would recognise a row by:
 * two tiers can share a price, two images can share a sort order, and an
 * itinerary can legitimately repeat a stop name. So a save replaces the set
 * rather than diffing it — the same shape the seed uses, minus the bug. The
 * consequence to know is that **a child row's id does not survive a save**;
 * `detail` returns ids so the editing screen can key and edit rows, not so
 * anything can store one.
 *
 * ## The overlap refusal
 *
 * Checked FIRST, before any statement runs, so "nothing is written" is true of
 * the database and not merely of the transaction's final state. `checkout
 * .quote` picks "the tier where `min_pax <= pax <= max_pax`"; two tiers that
 * both match a party size make that price non-deterministic — whichever row
 * MySQL happened to return first becomes what a guest pays.
 */
import { TRPCError } from '@trpc/server';
import type { TourCreateInput, TourPriceTierInput, TourUpdateInput } from '@rg/shared';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../../db/client';
import {
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
} from '../../db/schema';

/**
 * The refusal's wording, exported so the test and any future screen assert the
 * same string rather than two drifting copies of it. The offending pair of
 * ranges is appended to it — an owner editing five tiers needs to be told WHICH
 * two collide, not only that two do.
 */
export const TIER_OVERLAP_MESSAGE =
  'Two price tiers cover the same party size. Every tier needs its own range, ' +
  'or a booking for that many guests has two prices.';

/** The refusal for a `destination_id` no row answers to. */
export const UNKNOWN_DESTINATION_MESSAGE = 'No destination with that id.';

/** The refusal for an `id` no tour answers to. */
export const UNKNOWN_TOUR_MESSAGE = 'No tour with that id.';

/**
 * The first pair of tiers whose `[minPax, maxPax]` ranges intersect, or null.
 *
 * Two closed ranges overlap when `a.minPax <= b.maxPax && b.minPax <= a.maxPax`
 * — so `[1,3]` and `[4,6]` do NOT overlap (a normal three-tier price card must
 * stay savable) while `[1,4]` and `[4,8]` do, and so does `[3,6]` inside
 * `[1,12]`. Every pair is compared rather than only neighbours, because the
 * input arrives in whatever order the screen's rows are in.
 *
 * Exported for its own sake: a pure function over the set is testable without
 * a database, and the TRPCError it feeds is raised by the caller below.
 */
export function findOverlappingTiers(
  tiers: readonly TourPriceTierInput[],
): [TourPriceTierInput, TourPriceTierInput] | null {
  for (let i = 0; i < tiers.length; i += 1) {
    for (let j = i + 1; j < tiers.length; j += 1) {
      const a = tiers[i]!;
      const b = tiers[j]!;
      if (a.minPax <= b.maxPax && b.minPax <= a.maxPax) return [a, b];
    }
  }
  return null;
}

/** The columns `tours` takes from either input, in one place for both paths. */
function tourValues(input: TourCreateInput) {
  return {
    slug: input.slug,
    title: input.title,
    destinationId: input.destinationId,
    summary: input.summary,
    about: input.about,
    inclusions: input.inclusions,
    exclusions: input.exclusions,
    durationHours: input.durationHours,
    groupsPerDay: input.groupsPerDay,
    maxGuests: input.maxGuests,
    freeCancelHours: input.freeCancelHours,
    isFeatured: input.isFeatured,
    sortOrder: input.sortOrder,
    badge: input.badge,
    alertNote: input.alertNote,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    ogImage: input.ogImage,
    /*
     * `isActive` and `historicalTripsCount` are absent on purpose, not
     * forgotten: neither is on the input (see `shared/src/tours-admin.ts`), so
     * `setActive` stays the only writer of the soft-delete flag and a trips
     * counter is never typed in by hand.
     */
  };
}

/**
 * Creates or replaces a tour and all of its child content, using the
 * transaction it is given.
 *
 * `'id' in input` is the discriminator: `tourUpdateInput` is `tourCreateInput`
 * plus the id, so an update is a create that already knows which row it is.
 *
 * Returns the tour's id and nothing else — a `created` flag would be dead
 * weight, since each caller already knows which mutation it is.
 */
export async function upsertTourContent(
  tx: Transaction,
  input: TourCreateInput | TourUpdateInput,
): Promise<{ id: number }> {
  /*
   * Before ANY write. A refusal raised after the children were deleted would
   * roll back correctly but would make the "nothing is written" claim a
   * statement about transactions rather than about this function.
   */
  const overlap = findOverlappingTiers(input.priceTiers);
  if (overlap) {
    const [a, b] = overlap;
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        `${TIER_OVERLAP_MESSAGE} ` +
        `(${a.minPax}–${a.maxPax} and ${b.minPax}–${b.maxPax} both apply.)`,
    });
  }

  /*
   * `tours.destination_id` is a real foreign key, so an unknown id would
   * otherwise surface as a driver error — an INTERNAL_SERVER_ERROR the screen
   * can say nothing useful about. Read inside the transaction, like every
   * other check here.
   */
  const [destination] = await tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(eq(destinations.id, input.destinationId))
    .limit(1);
  if (!destination) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_DESTINATION_MESSAGE });
  }

  const values = tourValues(input);
  let tourId: number;

  if ('id' in input) {
    const [result] = await tx.update(tours).set(values).where(eq(tours.id, input.id));
    if (result.affectedRows === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TOUR_MESSAGE });
    }
    tourId = input.id;
  } else {
    const [result] = await tx.insert(tours).values(values);
    tourId = result.insertId;
  }

  // Wholesale replacement, one table at a time. A create deletes nothing
  // (there is nothing to delete) but runs the same path, so there is one code
  // path to be right rather than two.
  await tx.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, tourId));
  if (input.priceTiers.length > 0) {
    await tx.insert(tourPriceTiers).values(input.priceTiers.map((tier) => ({ ...tier, tourId })));
  }

  await tx.delete(tourImages).where(eq(tourImages.tourId, tourId));
  if (input.images.length > 0) {
    await tx.insert(tourImages).values(input.images.map((image) => ({ ...image, tourId })));
  }

  await tx.delete(tourItineraryStops).where(eq(tourItineraryStops.tourId, tourId));
  if (input.itinerary.length > 0) {
    await tx
      .insert(tourItineraryStops)
      .values(input.itinerary.map((stop) => ({ ...stop, tourId })));
  }

  await tx.delete(tourAddons).where(eq(tourAddons.tourId, tourId));
  if (input.addons.length > 0) {
    await tx.insert(tourAddons).values(input.addons.map((addon) => ({ ...addon, tourId })));
  }

  return { id: tourId };
}
