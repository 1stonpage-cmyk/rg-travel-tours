import { packagesBySlugInput } from '@rg/shared';
import { TRPCError } from '@trpc/server';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { packages } from '../../db/schema';
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

export const packagesRouter = router({
  list: publicProcedure.query(async (): Promise<PackageListItem[]> => {
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
    .query(async ({ input }): Promise<PackageListItem> => {
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
      };
    }),
});
