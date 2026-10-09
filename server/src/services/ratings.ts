/**
 * Rating aggregates over the `reviews` table.
 *
 * `displayAggregate` includes every published review, samples included
 * (D1) — it drives the visible star ratings guests see. `realAggregate`
 * excludes samples (`is_sample = 1`) and drives JSON-LD `AggregateRating`
 * only: structured data must never claim a rating backed by seeded sample
 * content.
 *
 * Both return `null` — never `{ average: 0, count: 0 }` — when there are
 * no matching rows, so the caller can omit the rating entirely rather than
 * render (or publish to search engines) a false zero-star score.
 *
 * Each query groups by `tour_id` (required under this server's
 * `ONLY_FULL_GROUP_BY` sql_mode, since `tour_id` is selected alongside the
 * aggregates) and, when a `tourId` is given, is also filtered to it so the
 * single-tour case only ever reads that tour's rows. When `tourId` is
 * omitted the per-tour groups are merged in JS into one overall aggregate
 * across every published review, regardless of which tour (or none) it
 * belongs to — still exactly one round trip.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { reviews } from '../db/schema';

export interface Aggregate {
  average: number;
  count: number;
}

interface GroupRow {
  tourId: number | null;
  average: string | number;
  count: string | number;
}

async function queryGroups(onlyReal: boolean, tourId: number | undefined): Promise<GroupRow[]> {
  const db = getDb();
  const conditions: SQL[] = [eq(reviews.status, 'published')];
  if (onlyReal) conditions.push(eq(reviews.isSample, false));
  if (tourId !== undefined) conditions.push(eq(reviews.tourId, tourId));

  return db
    .select({
      tourId: reviews.tourId,
      average: sql<string>`avg(${reviews.rating})`,
      count: sql<string>`count(*)`,
    })
    .from(reviews)
    .where(and(...conditions))
    .groupBy(reviews.tourId);
}

function mergeGroups(rows: GroupRow[]): Aggregate | null {
  let totalCount = 0;
  let weightedRatingSum = 0;

  for (const row of rows) {
    const count = Number(row.count);
    if (count <= 0) continue;
    totalCount += count;
    weightedRatingSum += Number(row.average) * count;
  }

  if (totalCount === 0) return null;
  return { average: weightedRatingSum / totalCount, count: totalCount };
}

/** All published reviews, samples included. Drives the visible star ratings. */
export async function displayAggregate(tourId?: number): Promise<Aggregate | null> {
  return mergeGroups(await queryGroups(false, tourId));
}

/** Published reviews with `is_sample = 0`. Drives JSON-LD `AggregateRating` only. */
export async function realAggregate(tourId?: number): Promise<Aggregate | null> {
  return mergeGroups(await queryGroups(true, tourId));
}

/**
 * Every tour's aggregate in one round trip, keyed by `tour_id` — the batch
 * form `tours.list` must use instead of calling `displayAggregate(id)` once
 * per tour (an N+1 the catalog would otherwise hit on every page load).
 * `queryGroups(onlyReal, undefined)` already does exactly this query (no
 * tourId filter, grouped by tour_id); this just turns its rows into a map
 * and drops the review-less rows a plain Map.get() already treats as
 * "absent" — never a `{average: 0, count: 0}` entry, which would render as
 * a false zero-star rating.
 */
export async function aggregatesByTour(onlyReal = false): Promise<Map<number, Aggregate>> {
  const rows = await queryGroups(onlyReal, undefined);
  const map = new Map<number, Aggregate>();
  for (const row of rows) {
    if (row.tourId === null) continue; // reviews with no tour (none exist today, but not this fn's job to assume)
    const count = Number(row.count);
    if (count <= 0) continue;
    map.set(row.tourId, { average: Number(row.average), count });
  }
  return map;
}
