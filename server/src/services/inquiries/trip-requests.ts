/**
 * The admin dashboard's trip-request mini-queue (Task 1B, Direction B —
 * owner decision 2026-11-10). A new, narrow read: `transfer_custom`
 * inquiries with `status = 'new'`, count plus the newest few.
 *
 * **Not a second copy of `admin.inquiries.list`'s query.** That procedure
 * (`routers/admin/packages.ts`) deliberately returns every status, every
 * type, paginated — the full queue. This is the opposite shape: ONE status,
 * ONE type, a handful of rows, no pagination — a dashboard summary, not a
 * list screen. Two different questions a page asks the same table.
 */
import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm/sql';
import type { TripRequestSummary } from '@rg/shared';
import { getDb } from '../../db/client';
import { inquiries } from '../../db/schema';

/** Mirrors `services/dispatch/alerts.ts`'s own `MAX_EXAMPLES`: a dashboard card shows a short list, not the whole table. */
const MAX_ITEMS = 5;

export async function pendingTripRequests(): Promise<TripRequestSummary> {
  const db = getDb();

  const where = and(eq(inquiries.type, 'transfer_custom'), eq(inquiries.status, 'new'));

  const [counted] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(inquiries)
    .where(where);

  const rows = await db
    .select({
      id: inquiries.id,
      name: inquiries.name,
      pax: inquiries.pax,
      routeDescription: inquiries.routeDescription,
      requestedDate: inquiries.requestedDate,
    })
    .from(inquiries)
    .where(where)
    // Newest first, same ordering `admin.inquiries.list` uses — an office
    // opening this card wants to see what just came in.
    .orderBy(desc(inquiries.createdAt), desc(inquiries.id))
    .limit(MAX_ITEMS);

  return {
    count: Number(counted?.total ?? 0),
    items: rows,
  };
}
