/**
 * Week 5, Task 13: `admin.dashboard.alerts` (BUILD_SPEC §9 "Dashboard").
 * Task 1B (Direction B, owner decision 2026-11-10) adds `tripRequests` and
 * `money` beside it — two more read-only dashboard queries, each with its
 * own gate, because they answer different questions for different roles.
 *
 * §9 gives the Dashboard PAGE to all three roles — owner, dispatcher and
 * finance — and `ROLE_MATRIX.dashboard` is already exactly that trio. The
 * two new procedures are narrower: `tripRequests` carries guest names
 * (`packagesInquiries` — owner + dispatcher, same as `admin.inquiries.list`)
 * and `money` carries payment figures (`reports` — owner + finance, same
 * pair `admin.reports.*` uses). **Two separate procedures, not one combined
 * summary** — a single procedure can only carry one gate, which would
 * either hide trip requests from a dispatcher or hide money from someone
 * who should see it depending on which gate "won".
 *
 * **Every procedure here takes no input.** `alerts` and `money` pass their
 * own `new Date()` into functions that each take an explicit `now` so the
 * owner's Manila boundary tests can sit on the boundary (controller Ruling
 * 2). A client must never be able to supply the time: an operator — or
 * anyone with their session — could otherwise move a time-scoped figure to
 * say whatever they wanted.
 */
import { getDb } from '../../db/client';
import { pendingTripRequests } from '../../services/inquiries/trip-requests';
import { dashboardMoneySummary } from '../../services/reports/money';
import { dashboardAlerts } from '../../services/dispatch/alerts';
import { adminProcedure, router } from '../../trpc';

export const adminDashboardRouter = router({
  alerts: adminProcedure('dashboard').query(async () => {
    const now = new Date();
    return await getDb().transaction((tx) => dashboardAlerts(tx, now));
  }),

  /**
   * The trip-request mini-queue. `packagesInquiries` — never `reports`:
   * this is guest-identifying data (names), not money, and finance must
   * never see it, same as `admin.inquiries.list`.
   */
  tripRequests: adminProcedure('packagesInquiries').query(() => pendingTripRequests()),

  /**
   * The money block. `reports` — never `packagesInquiries`: this is
   * payment figures, and a dispatcher must see none of it, same as
   * `admin.reports.*`.
   */
  money: adminProcedure('reports').query(() => dashboardMoneySummary(new Date())),
});
