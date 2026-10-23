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
 * ## Two tables are replaced wholesale; two CANNOT be, and the reason is a
 * foreign key (review fix, 2026-10-24)
 *
 * None of the four child tables has a column a human would recognise a row by:
 * two tiers can share a price, two images can share a sort order, and an
 * itinerary can legitimately repeat a stop name. So the obvious shape — and the
 * shape this function shipped with — is to replace each set wholesale, the same
 * way the seed does.
 *
 * **For half of them that is a permanent 500.** Two rows elsewhere in the
 * schema reference these tables, both `ON DELETE RESTRICT` (verified against
 * the live schema, `DELETE_RULE: NO ACTION`):
 *
 * ```
 * booking_addons.addon_id  -> tour_addons.id
 *   booking_addons_addon_id_tour_addons_id_fk
 * trip_checkpoints.stop_id -> tour_itinerary_stops.id
 *   trip_checkpoints_stop_id_tour_itinerary_stops_id_fk
 * ```
 *
 * So the first time a guest buys an add-on or a driver checks in at a stop,
 * `DELETE FROM tour_addons WHERE tour_id = ?` fails with
 * `ER_ROW_IS_REFERENCED_2` (errno 1451) and **every later save of that tour is
 * an unexplained `INTERNAL_SERVER_ERROR`** — reproduced on both tables before
 * this fix. The test suite could not see it because the test database ships no
 * stops and no bookings, and every test here built a brand-new tour with no
 * history.
 *
 * What each table does now:
 *
 *  - **`tour_price_tiers`, `tour_images`** — unchanged. Nothing references
 *    them (confirmed: no referencing FK exists), so delete-then-reinsert is
 *    still correct and still the simplest thing that works.
 *  - **`tour_addons`** — matched by `id`, never deleted. An id in the input
 *    that belongs to this tour is UPDATEd; anything else is INSERTed; a row the
 *    input no longer mentions is **deactivated** (`is_active = false`), which is
 *    `CLAUDE.md`'s soft-delete rule applied to exactly the case it exists for.
 *    The public detail route already filters on that column, so a deactivated
 *    add-on stops being sellable the moment it is dropped, and
 *    `booking_addons.addon_id` still resolves for every guest who bought one.
 *    Posting it back with `isActive: true` revives it.
 *  - **`tour_itinerary_stops`** — matched by `id` the same way. A stop the
 *    input no longer mentions is deleted **only if no `trip_checkpoints` row
 *    points at it**; if one does, the WHOLE mutation is refused with
 *    `CONFLICT`. There is no `is_active` column to soft-delete into (and this
 *    task takes no migration), and silently keeping a stop the owner asked to
 *    remove would be worse than saying so: the driver's screen would keep
 *    listing it and the departures board would keep counting it.
 *
 * **A child row's id now survives a save for stops and add-ons** — that is the
 * point of matching by id — and still does not for tiers and images.
 *
 * ## The refusals, both before any write
 *
 * ### The overlap refusal
 *
 * Checked FIRST, before any statement runs, so "nothing is written" is true of
 * the database and not merely of the transaction's final state. `checkout
 * .quote` picks "the tier where `min_pax <= pax <= max_pax`"; two tiers that
 * both match a party size make that price non-deterministic — whichever row
 * MySQL happened to return first becomes what a guest pays.
 *
 * ### The checked-in-stop refusal
 *
 * Also before any write, which is why this function now has a READ PHASE that
 * runs ahead of every statement that changes anything: working out which stops
 * the save drops needs the tour's current stops, and asking whether any of them
 * has a checkpoint needs a second read. Doing that after the tier replacement
 * had already run would roll back correctly but would make "nothing is written"
 * a claim about transactions rather than about this function — the same
 * standard the overlap check is held to.
 */
import { TRPCError } from '@trpc/server';
import type {
  TourAddonInput,
  TourCreateInput,
  TourItineraryStopInput,
  TourPriceTierInput,
  TourUpdateInput,
} from '@rg/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../db/client';
import {
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
  tripCheckpoints,
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

/** Names the stop a trip has already reached, so the owner knows which row to keep. */
export function checkedInStopMessage(name: string): string {
  return `Cannot remove "${name}" — a trip has already checked in there.`;
}

/**
 * How a save of one history-bearing child table resolves against what is
 * already stored: which rows to update, which to add, which the input dropped.
 *
 * Pure, and the same for `tour_addons` and `tour_itinerary_stops` — only what
 * "dropped" MEANS differs between them (deactivate vs. delete-or-refuse), and
 * that is the caller's decision, not this function's.
 */
export interface ChildUpsertPlan<T> {
  /** Rows to UPDATE in place, keyed by an id that really belongs to this tour. */
  updates: { id: number; row: T }[];
  /** Rows to INSERT: no id, or an id this tour does not own. */
  inserts: T[];
  /** Stored ids the input no longer mentions. */
  dropped: number[];
}

/**
 * Matches an incoming child set against the stored ids for one tour.
 *
 * Two deliberate decisions:
 *
 *  - **An id this tour does not own becomes an INSERT, not an error and never
 *    an UPDATE.** A caller cannot reach another tour's add-on by guessing its
 *    id; the worst they achieve is adding a row to their own tour. (The write
 *    below is scoped by `tour_id` as well, so this is belt and braces.)
 *  - **A repeated id is consumed once** and any later copy becomes an INSERT.
 *    Zod cannot police cross-row uniqueness, and two UPDATEs to one row would
 *    silently lose the first one's values.
 */
export function planChildUpsert<T extends { id?: number }>(
  storedIds: readonly number[],
  incoming: readonly T[],
): ChildUpsertPlan<T> {
  const available = new Set(storedIds);
  const plan: ChildUpsertPlan<T> = { updates: [], inserts: [], dropped: [] };

  for (const row of incoming) {
    if (row.id !== undefined && available.has(row.id)) {
      available.delete(row.id);
      plan.updates.push({ id: row.id, row });
    } else {
      plan.inserts.push(row);
    }
  }
  // Whatever was never claimed by an incoming row.
  plan.dropped = [...available];
  return plan;
}

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

/** What a save did to the two tables that hold history, for the audit row. */
export interface UpsertTourResult {
  id: number;
  /** Add-ons the input dropped, so they were deactivated rather than deleted. */
  addonsDeactivated: number;
  /** Stops the input dropped, which no trip had reached, so they were deleted. */
  stopsRemoved: number;
}

/**
 * Creates or updates a tour and all of its child content, using the
 * transaction it is given.
 *
 * `'id' in input` is the discriminator: `tourUpdateInput` is `tourCreateInput`
 * plus the id, so an update is a create that already knows which row it is.
 *
 * Two phases, and the split is load-bearing: **every refusal is raised in the
 * read phase**, so a refused save has written nothing at all rather than
 * relying on the caller's rollback to undo it.
 */
export async function upsertTourContent(
  tx: Transaction,
  input: TourCreateInput | TourUpdateInput,
): Promise<UpsertTourResult> {
  /* ================= READ PHASE — no statement here changes anything ======= */

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
   * can say nothing useful about.
   */
  const [destination] = await tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(eq(destinations.id, input.destinationId))
    .limit(1);
  if (!destination) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: UNKNOWN_DESTINATION_MESSAGE });
  }

  /*
   * On a CREATE there is nothing stored yet, so both plans are "insert
   * everything" and neither read is worth issuing. `existingTourId` is also
   * what the stop-history check keys on, and it is read BEFORE the tour write
   * so the refusal can come first.
   */
  const existingTourId = 'id' in input ? input.id : null;

  const storedStops =
    existingTourId === null
      ? []
      : await tx
          .select({ id: tourItineraryStops.id, name: tourItineraryStops.name })
          .from(tourItineraryStops)
          .where(eq(tourItineraryStops.tourId, existingTourId))
          .orderBy(asc(tourItineraryStops.sortOrder), asc(tourItineraryStops.id));

  const storedAddons =
    existingTourId === null
      ? []
      : await tx
          .select({ id: tourAddons.id })
          .from(tourAddons)
          .where(eq(tourAddons.tourId, existingTourId));

  const stopPlan = planChildUpsert(
    storedStops.map((row) => row.id),
    input.itinerary as readonly TourItineraryStopInput[],
  );
  const addonPlan = planChildUpsert(
    storedAddons.map((row) => row.id),
    input.addons as readonly TourAddonInput[],
  );

  /*
   * **The checked-in-stop refusal.** `trip_checkpoints.stop_id` references
   * these rows `ON DELETE RESTRICT`, so deleting one a driver has reached is
   * `ER_ROW_IS_REFERENCED_2` — a 500 with nothing a screen can say. Refused by
   * name instead, and refused for the WHOLE save: a partially applied edit that
   * silently kept a stop the owner asked to remove would leave the driver's
   * itinerary and the departures board disagreeing with the admin screen.
   *
   * Every checkpoint counts, `undone` ones included: the FK does not care, and
   * `CLAUDE.md`'s "an undo MARKS, never deletes" means an undone row is still
   * the record of a tap that happened.
   *
   * The stops are ordered by `sort_order` in the read above, so the stop named
   * in the message is the same one on every run.
   */
  if (stopPlan.dropped.length > 0) {
    const blocked = await tx
      .select({ stopId: tripCheckpoints.stopId })
      .from(tripCheckpoints)
      .where(inArray(tripCheckpoints.stopId, stopPlan.dropped));
    if (blocked.length > 0) {
      const blockedIds = new Set(blocked.map((row) => row.stopId));
      const named = storedStops.find((row) => blockedIds.has(row.id));
      throw new TRPCError({
        code: 'CONFLICT',
        message: checkedInStopMessage(named?.name ?? 'that stop'),
      });
    }
  }

  /* ================= WRITE PHASE — nothing below may refuse ================ */

  const values = tourValues(input);
  let tourId: number;

  if (existingTourId !== null) {
    const [result] = await tx.update(tours).set(values).where(eq(tours.id, existingTourId));
    if (result.affectedRows === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: UNKNOWN_TOUR_MESSAGE });
    }
    tourId = existingTourId;
  } else {
    const [result] = await tx.insert(tours).values(values);
    tourId = result.insertId;
  }

  /*
   * Tiers and images: replaced WHOLESALE, unchanged. Nothing in the schema
   * references either table, so there is no RESTRICT to trip over and no
   * history to preserve — a price tier is the price, not a record of one.
   */
  await tx.delete(tourPriceTiers).where(eq(tourPriceTiers.tourId, tourId));
  if (input.priceTiers.length > 0) {
    await tx.insert(tourPriceTiers).values(input.priceTiers.map((tier) => ({ ...tier, tourId })));
  }

  await tx.delete(tourImages).where(eq(tourImages.tourId, tourId));
  if (input.images.length > 0) {
    await tx.insert(tourImages).values(input.images.map((image) => ({ ...image, tourId })));
  }

  /*
   * Itinerary stops: matched by id. `id` is stripped from the written columns —
   * it is the MATCH key, never a value to write — and every write is scoped by
   * `tour_id` as well as the row id, so an id belonging to another tour cannot
   * be reached through this tour's save.
   */
  for (const { id, row } of stopPlan.updates) {
    await tx
      .update(tourItineraryStops)
      .set({ sortOrder: row.sortOrder, name: row.name, description: row.description })
      .where(and(eq(tourItineraryStops.id, id), eq(tourItineraryStops.tourId, tourId)));
  }
  if (stopPlan.inserts.length > 0) {
    await tx.insert(tourItineraryStops).values(
      stopPlan.inserts.map((row) => ({
        tourId,
        sortOrder: row.sortOrder,
        name: row.name,
        description: row.description,
      })),
    );
  }
  // Safe by the refusal above: none of these has a checkpoint pointing at it.
  if (stopPlan.dropped.length > 0) {
    await tx
      .delete(tourItineraryStops)
      .where(
        and(
          eq(tourItineraryStops.tourId, tourId),
          inArray(tourItineraryStops.id, stopPlan.dropped),
        ),
      );
  }

  /*
   * Add-ons: matched by id, and a dropped one is DEACTIVATED, never deleted —
   * `booking_addons.addon_id` points at it for every guest who bought one, and
   * the public detail route already filters on `is_active`, so deactivating is
   * what "no longer sold" means here.
   */
  for (const { id, row } of addonPlan.updates) {
    await tx
      .update(tourAddons)
      .set({
        name: row.name,
        priceCentavos: row.priceCentavos,
        perPerson: row.perPerson,
        // Posting a deactivated add-on back with `isActive: true` revives it.
        isActive: row.isActive,
      })
      .where(and(eq(tourAddons.id, id), eq(tourAddons.tourId, tourId)));
  }
  if (addonPlan.inserts.length > 0) {
    await tx.insert(tourAddons).values(
      addonPlan.inserts.map((row) => ({
        tourId,
        name: row.name,
        priceCentavos: row.priceCentavos,
        perPerson: row.perPerson,
        isActive: row.isActive,
      })),
    );
  }
  if (addonPlan.dropped.length > 0) {
    await tx
      .update(tourAddons)
      .set({ isActive: false })
      .where(and(eq(tourAddons.tourId, tourId), inArray(tourAddons.id, addonPlan.dropped)));
  }

  return {
    id: tourId,
    addonsDeactivated: addonPlan.dropped.length,
    stopsRemoved: stopPlan.dropped.length,
  };
}
