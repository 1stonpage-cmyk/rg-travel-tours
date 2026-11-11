import { packagesBySlugInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import { readShowTours } from '../../content/settings';
import { getDb } from '../../db/client';
import { packages } from '../../db/schema';
import { packageTitle } from '../../seo/resolvers';
import { publicProcedure, router } from '../../trpc';

export interface PackageListItem {
  id: number;
  slug: string;
  title: string;
  days: number;
  /** Integer centavos, nullable — no "was" price when there is no discount. */
  oldPriceCentavos: number | null;
  /** Integer centavos. */
  newPriceCentavos: number;
  description: string | null;
  image: { path: string; alt: string } | null;
  highlights: unknown;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
}

/**
 * `bySlug`'s own response shape — one field wider than a `list` row (Task 4,
 * 1D). `pageTitle` is the exact title the server injects into `<title>` for
 * this page on a cold load (`packageTitle()`, `server/src/seo/resolvers.ts`),
 * published so a client-side navigation can re-assert the SAME string rather
 * than re-deriving it. Not added to `PackageListItem` itself: `list` has no
 * use for a per-page browser-tab title, and widening it there would make
 * every list row carry a field only the detail page reads.
 */
export interface PackageDetail extends PackageListItem {
  pageTitle: string;
}

export const packagesRouter = router({
  list: publicProcedure.query(async (): Promise<PackageListItem[]> => {
    // The `show_tours` gate (owner decision 2026-11-10, Decision 2) —
    // packages now follow the exact same rule as tours.list (T15/BUG-122):
    // an empty catalog, not an error, checked before any package query.
    if (!(await readShowTours())) return [];
    const db = getDb();
    const rows = await db
      .select()
      .from(packages)
      .where(eq(packages.isActive, true))
      .orderBy(asc(packages.sortOrder), asc(packages.id));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      days: row.days,
      oldPriceCentavos: row.oldPriceCentavos,
      newPriceCentavos: row.newPriceCentavos,
      description: row.description,
      image: row.imagePath ? { path: row.imagePath, alt: row.imageAlt ?? '' } : null,
      highlights: row.highlights,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImage: row.ogImage,
    }));
  }),

  /**
   * One package by slug, for `/packages/:slug` (Week 7 plan, Task 3). Same
   * shape as one row of `list` — the `packages` table has no child tables
   * (no tiers, no images table, no itinerary), so there is nothing to join.
   * Mirrors `tours.bySlug`'s I1 pattern: fetch by slug first, then refuse a
   * soft-deleted row with the same NOT_FOUND shape as an unknown slug.
   */
  bySlug: publicProcedure
    .input(packagesBySlugInput)
    .query(async ({ input }): Promise<PackageDetail> => {
      // The `show_tours` gate (Decision 2). The SAME message, byte for
      // byte, the inactive-row branch below throws — a hidden package and a
      // slug naming nothing must be indistinguishable (BUG-122's rule,
      // applied here for the first time).
      if (!(await readShowTours())) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `NOT_FOUND: no package found for slug "${input.slug}"`,
        });
      }
      const db = getDb();
      const [row] = await db.select().from(packages).where(eq(packages.slug, input.slug));

      if (!row || !row.isActive) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `NOT_FOUND: no package found for slug "${input.slug}"`,
        });
      }

      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        days: row.days,
        oldPriceCentavos: row.oldPriceCentavos,
        newPriceCentavos: row.newPriceCentavos,
        description: row.description,
        image: row.imagePath ? { path: row.imagePath, alt: row.imageAlt ?? '' } : null,
        highlights: row.highlights,
        seoTitle: row.seoTitle,
        seoDescription: row.seoDescription,
        ogImage: row.ogImage,
        pageTitle: packageTitle(row),
      };
    }),
});
