/**
 * Week 5, Task 13: `admin.dashboard.alerts` (BUILD_SPEC §9 "Dashboard").
 *
 * §9 gives the Dashboard to all three roles — owner, dispatcher and finance
 * — and `ROLE_MATRIX.dashboard` is already exactly that trio, so no role
 * work was needed and none was invented.
 *
 * **The procedure takes no input.** It passes its own `new Date()` into the
 * alert functions, which each take an explicit `now` so the owner's Manila
 * boundary tests can sit on the boundary (controller Ruling 2). A client
 * must never be able to supply the time: an operator — or anyone with their
 * session — could otherwise move the 48-hour window and make the
 * unstaffed-trip count say whatever they wanted.
 */
import { getDb } from '../../db/client';
import { dashboardAlerts } from '../../services/dispatch/alerts';
import { adminProcedure, router } from '../../trpc';

export const adminDashboardRouter = router({
  alerts: adminProcedure('dashboard').query(async () => {
    const now = new Date();
    return await getDb().transaction((tx) => dashboardAlerts(tx, now));
  }),
});
