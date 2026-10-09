import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { destinations } from '../../db/schema';
import { publicProcedure, router } from '../../trpc';

export interface Destination {
  id: number;
  name: string;
  slug: string;
  /** Most Visited label override. Null means "use `name`" — true for every destination but badian-kawasan. */
  displayName: string | null;
  blurb: string | null;
  image: { path: string; alt: string } | null;
  /** Drives the destination chip row order. */
  sortOrder: number;
  /** Drives the Most Visited section order — independent of `sortOrder`. Null omits the destination from Most Visited. */
  featuredSortOrder: number | null;
  isFeatured: boolean;
}

export const destinationsRouter = router({
  list: publicProcedure.query(async (): Promise<Destination[]> => {
    const db = getDb();
    const rows = await db
      .select()
      .from(destinations)
      .where(eq(destinations.isActive, true))
      .orderBy(asc(destinations.sortOrder), asc(destinations.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      displayName: row.displayName,
      blurb: row.blurb,
      image: row.imagePath ? { path: row.imagePath, alt: row.imageAlt ?? '' } : null,
      sortOrder: row.sortOrder,
      featuredSortOrder: row.featuredSortOrder,
      isFeatured: row.isFeatured,
    }));
  }),
});
