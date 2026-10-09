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
      oldPriceCentavos: row.oldPrice,
      newPriceCentavos: row.newPrice,
      description: row.description,
      image: row.imagePath ? { path: row.imagePath, alt: row.imageAlt ?? '' } : null,
      highlights: row.highlights,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImage: row.ogImage,
    }));
  }),
});
