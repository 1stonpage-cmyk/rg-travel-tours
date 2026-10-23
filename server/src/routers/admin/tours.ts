/**
 * `admin.tours.*` — the tour catalog's editing surface: the tour, its price
 * tiers, images, itinerary stops and add-ons (Week 7 plan, Task 6;
 * BUILD_SPEC §9 "Tours & pricing").
 *
 * Every procedure is `adminProcedure('toursPricing')` — §9's "Tours, pricing"
 * row, which is **owner only**. A dispatcher and a finance user are both
 * refused by the gate, not by a resolver finding nothing to do: these
 * mutations set the per-person price a guest is charged, which is the narrowest
 * permission in the matrix for a reason.
 *
 * There is deliberately **no delete mutation**. A tour is retired through
 * `setActive(false)` (CLAUDE.md, "Soft deletes"), which hides it from the
 * public catalog and from `tours.bySlug` and keeps every price, image and
 * review attached to it. A tour that was hard-deleted would take its bookings'
 * `tour_id` with it.
 *
 * `services/tours/upsert.ts` owns the four child tables and both refusals (the
 * price-tier overlap, and removing a stop a trip has already checked in at);
 * this file owns the transaction, the audit row and the reads. One transaction
 * per mutation, opened here, with the audit write inside it — an audit row that
 * survives a rollback claims a price change that never happened.
 *
 * **`detail` returns DEACTIVATED add-ons** (there is no `is_active` filter on
 * that read, unlike the public `tours.bySlug`). That is deliberate and it is
 * what makes the soft delete reversible: dropping an add-on from a save
 * deactivates it rather than deleting it, because a guest may already have
 * bought one, so the editing screen has to be able to see it and post it back
 * with `isActive: true` to revive it.
 */
import { TRPCError } from '@trpc/server';
import {
  tourActiveInput,
  tourCreateInput,
  tourIdInput,
  tourUpdateInput,
  type TourAdminDetail,
  type TourAdminListItem,
} from '@rg/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import {
  destinations,
  tourAddons,
  tourImages,
  tourItineraryStops,
  tourPriceTiers,
  tours,
} from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { upsertTourContent, type UpsertTourResult } from '../../services/tours/upsert';
import { adminProcedure, router } from '../../trpc';

/** The one message for a slug another tour already holds. */
const DUPLICATE_SLUG_MESSAGE = 'A tour with that slug already exists.';

/**
 * `tours.inclusions` / `.exclusions` are `json` columns, so Drizzle types them
 * `unknown` — the rows predate this editing surface and a hand-written INSERT
 * could have put anything in them. Anything that is not an array of strings
 * reads back as null rather than being forced into the detail payload's type:
 * the editing screen then shows an empty list, and the next save replaces the
 * malformed value with a well-formed one.
 */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

/**
 * The audit payload for a save: identifiers, the money, and what the save did
 * to the two child tables that hold history.
 *
 * The price tiers are included in full and the tour's prose (`about`, the SEO
 * fields, the summary) is not. A price edit nobody can trace is the one change
 * this log exists for, and three to five tier rows is small; a dump of the
 * whole tour would bury them.
 *
 * `addonsDeactivated` and `stopsRemoved` come from the save's own result rather
 * than from the input, because the input cannot say them: dropping an add-on
 * deactivates a row the input no longer mentions, and dropping a stop deletes
 * one. "Three add-ons were retired by this save" is exactly the kind of fact a
 * log is read for months later.
 */
function auditDataFor(
  input: {
    slug: string;
    priceTiers: readonly { minPax: number; maxPax: number; pricePerPersonCentavos: number }[];
    images: readonly unknown[];
    itinerary: readonly unknown[];
    addons: readonly { name: string; priceCentavos: number }[];
  },
  result: UpsertTourResult,
) {
  return {
    slug: input.slug,
    priceTiers: input.priceTiers.map((tier) => ({
      minPax: tier.minPax,
      maxPax: tier.maxPax,
      pricePerPersonCentavos: tier.pricePerPersonCentavos,
    })),
    addons: input.addons.map((addon) => ({
      name: addon.name,
      priceCentavos: addon.priceCentavos,
    })),
    imageCount: input.images.length,
    stopCount: input.itinerary.length,
    addonsDeactivated: result.addonsDeactivated,
    stopsRemoved: result.stopsRemoved,
  };
}

/** Turns a duplicate-slug driver error into the refusal a screen can show. */
function rethrowAsSlugConflict(error: unknown): never {
  if (isDuplicateKeyError(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_SLUG_MESSAGE });
  }
  throw error;
}

export const adminToursRouter = router({
  /**
   * Every tour, **inactive ones included** — the admin list is the only place
   * a retired tour is visible, and therefore the only place it can be switched
   * back on.
   *
   * Two queries, not one per tour: the tours joined to their destination with
   * `MIN(price_per_person_centavos)` and a tier count aggregated per tour. A
   * `LEFT JOIN` so a tour with no tiers is still listed, with
   * `fromPriceCentavos: null` and `priceTierCount: 0` — which is exactly the
   * state the list exists to make visible.
   */
  list: adminProcedure('toursPricing').query(async (): Promise<TourAdminListItem[]> => {
    const rows = await getDb()
      .select({
        id: tours.id,
        slug: tours.slug,
        title: tours.title,
        destinationId: destinations.id,
        destinationName: destinations.name,
        isActive: tours.isActive,
        isFeatured: tours.isFeatured,
        sortOrder: tours.sortOrder,
        badge: tours.badge,
        durationHours: tours.durationHours,
        groupsPerDay: tours.groupsPerDay,
        maxGuests: tours.maxGuests,
        fromPriceCentavos: sql<string | null>`min(${tourPriceTiers.pricePerPersonCentavos})`,
        priceTierCount: sql<string>`count(${tourPriceTiers.id})`,
      })
      .from(tours)
      .innerJoin(destinations, eq(tours.destinationId, destinations.id))
      .leftJoin(tourPriceTiers, eq(tourPriceTiers.tourId, tours.id))
      // Every selected non-aggregate column is grouped (ONLY_FULL_GROUP_BY).
      .groupBy(
        tours.id,
        tours.slug,
        tours.title,
        tours.isActive,
        tours.isFeatured,
        tours.sortOrder,
        tours.badge,
        tours.durationHours,
        tours.groupsPerDay,
        tours.maxGuests,
        destinations.id,
        destinations.name,
      )
      .orderBy(asc(tours.sortOrder), asc(tours.id));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      destination: { id: row.destinationId, name: row.destinationName },
      isActive: row.isActive,
      isFeatured: row.isFeatured,
      sortOrder: row.sortOrder,
      badge: row.badge,
      durationHours: row.durationHours,
      groupsPerDay: row.groupsPerDay,
      maxGuests: row.maxGuests,
      /*
       * No cast on `badge` above, deliberately: Drizzle types the column as
       * the MySQL enum's union, and assigning it to `TourAdminListItem.badge`
       * typechecks only while `TOUR_BADGES` in `@rg/shared` still matches that
       * enum. A badge added to the database alone stops compiling here.
       */
      // MySQL returns MIN()/COUNT() as strings through mysql2.
      fromPriceCentavos: row.fromPriceCentavos === null ? null : Number(row.fromPriceCentavos),
      priceTierCount: Number(row.priceTierCount),
    }));
  }),

  /**
   * One tour with every child row, each carrying its id so the editing screen
   * can key and edit rows. The ids are not stable across a save — children are
   * replaced wholesale (see `services/tours/upsert.ts`) — so nothing should
   * store one.
   *
   * Unlike the public `tours.bySlug`, this answers for an INACTIVE tour and an
   * inactive destination: the screen that can switch a tour back on must be
   * able to open it.
   */
  detail: adminProcedure('toursPricing')
    .input(tourIdInput)
    .query(async ({ input }): Promise<TourAdminDetail> => {
      const db = getDb();
      const [row] = await db.select().from(tours).where(eq(tours.id, input.id)).limit(1);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No tour with that id.' });
      }

      const [priceTiers, images, itinerary, addons] = await Promise.all([
        db
          .select({
            id: tourPriceTiers.id,
            minPax: tourPriceTiers.minPax,
            maxPax: tourPriceTiers.maxPax,
            pricePerPersonCentavos: tourPriceTiers.pricePerPersonCentavos,
          })
          .from(tourPriceTiers)
          .where(eq(tourPriceTiers.tourId, row.id))
          // The order `checkout.quote` reads them in.
          .orderBy(asc(tourPriceTiers.minPax)),
        db
          .select({
            id: tourImages.id,
            path: tourImages.path,
            alt: tourImages.alt,
            width: tourImages.width,
            height: tourImages.height,
            sortOrder: tourImages.sortOrder,
          })
          .from(tourImages)
          .where(eq(tourImages.tourId, row.id))
          // Same tie-break as the public reads: `id` makes the order total.
          .orderBy(asc(tourImages.sortOrder), asc(tourImages.id)),
        db
          .select({
            id: tourItineraryStops.id,
            sortOrder: tourItineraryStops.sortOrder,
            name: tourItineraryStops.name,
            description: tourItineraryStops.description,
          })
          .from(tourItineraryStops)
          .where(eq(tourItineraryStops.tourId, row.id))
          .orderBy(asc(tourItineraryStops.sortOrder), asc(tourItineraryStops.id)),
        db
          .select({
            id: tourAddons.id,
            name: tourAddons.name,
            priceCentavos: tourAddons.priceCentavos,
            perPerson: tourAddons.perPerson,
            isActive: tourAddons.isActive,
          })
          .from(tourAddons)
          .where(eq(tourAddons.tourId, row.id))
          .orderBy(asc(tourAddons.id)),
      ]);

      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        destinationId: row.destinationId,
        summary: row.summary,
        about: row.about,
        inclusions: asStringArray(row.inclusions),
        exclusions: asStringArray(row.exclusions),
        durationHours: row.durationHours,
        groupsPerDay: row.groupsPerDay,
        maxGuests: row.maxGuests,
        freeCancelHours: row.freeCancelHours,
        isFeatured: row.isFeatured,
        sortOrder: row.sortOrder,
        badge: row.badge,
        alertNote: row.alertNote,
        seoTitle: row.seoTitle,
        seoDescription: row.seoDescription,
        ogImage: row.ogImage,
        isActive: row.isActive,
        priceTiers,
        images,
        itinerary,
        addons,
      };
    }),

  create: adminProcedure('toursPricing')
    .input(tourCreateInput)
    .mutation(async ({ input, ctx }) => {
      try {
        const id = await getDb().transaction(async (tx) => {
          const result = await upsertTourContent(tx, input);
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'tour.created',
            entity: 'tour',
            entityId: result.id,
            data: auditDataFor(input, result),
          });
          return result.id;
        });
        return { id };
      } catch (error) {
        rethrowAsSlugConflict(error);
      }
    }),

  update: adminProcedure('toursPricing')
    .input(tourUpdateInput)
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb().transaction(async (tx) => {
          const result = await upsertTourContent(tx, input);
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'tour.updated',
            entity: 'tour',
            entityId: input.id,
            data: auditDataFor(input, result),
          });
        });
        return { ok: true as const };
      } catch (error) {
        rethrowAsSlugConflict(error);
      }
    }),

  /**
   * The soft delete, and the only writer of `tours.is_active`.
   *
   * Deactivating hides the tour from `tours.list` and makes `tours.bySlug`
   * answer `NOT_FOUND`, and changes nothing else: its prices, images, reviews
   * and bookings all stay exactly where they are. Reactivating puts it back.
   *
   * Two dotted audit actions rather than one `tour.active_set` with a flag in
   * the payload — "who retired this tour" is the question an owner asks, and
   * it should not need a payload to answer. The same shape
   * `admin.drivers.setActive` uses.
   *
   * It deliberately does NOT touch bookings already taken on this tour: a
   * retired tour still has trips to run, and the departures board still has to
   * show them.
   */
  setActive: adminProcedure('toursPricing')
    .input(tourActiveInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [result] = await tx
          .update(tours)
          .set({ isActive: input.isActive })
          .where(eq(tours.id, input.id));
        if (result.affectedRows === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No tour with that id.' });
        }
        const [row] = await tx
          .select({ slug: tours.slug })
          .from(tours)
          .where(eq(tours.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: input.isActive ? 'tour.reactivated' : 'tour.deactivated',
          entity: 'tour',
          entityId: input.id,
          data: { slug: row?.slug ?? null, isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),
});
