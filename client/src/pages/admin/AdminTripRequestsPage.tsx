/**
 * Trip requests — a standalone inbox for the inquiries `admin.inquiries.*`
 * already serves (Demo Polish Round 2, Task 1 / owner's "1A", 2026-11-11).
 *
 * `admin.inquiries.list` / `.setStatus` are `adminProcedure('packagesInquiries')`
 * — owner and dispatcher, never finance (`server/src/middleware/require-role.ts`).
 * This page adds no new server procedure and no new `ROLE_MATRIX` area: it is
 * a second URL onto the same `<InquiriesInbox>` component `AdminPackagesPage.tsx`
 * also renders, for staff who want the inbox without the packages CRUD
 * screen around it.
 *
 * All three `inquiries.type` values — `transfer_custom` (custom trip
 * requests), `contact` (general messages) and `package` (package enquiries)
 * — render here exactly as they do on the Packages page: `InquiriesInbox`
 * does not filter by type.
 *
 * Two-layer role denial, the same shape `AdminPackagesPage.tsx` uses: the
 * role this session already knows (`staffAuth.me`), and a second check — a
 * probe `admin.inquiries.list` call this page makes itself — for a session
 * that LOOKS allowed here but whose `packagesInquiries` grant the server
 * has since revoked.
 */
import { Link } from 'react-router-dom';
import { TRPCClientError } from '@trpc/client';
import type { AdminRole } from '@rg/shared';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import InquiriesInbox from '@/components/admin/InquiriesInbox';
import { trpc } from '@/lib/trpc';

const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';

/** Is this refusal a role problem (401/403), as opposed to a network or server fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner and dispatcher only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Trip requests</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner and dispatcher can see trip requests.
      </p>
      <Link
        to="/admin"
        className="tap-target text-brand-blue-700 hover:text-brand-blue-900 inline-flex items-center text-sm font-semibold underline underline-offset-4 transition-colors"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}

function TripRequestsAdmin({ role }: { role: AdminRole | undefined }) {
  /*
   * The second denial layer: the ROLE check in `AdminTripRequestsPage` only
   * catches a session this client already knows is refused. A session that
   * LOOKS allowed to this page but whose `packagesInquiries` grant the
   * server has since revoked only surfaces once `admin.inquiries.list`
   * itself comes back refused.
   *
   * `{ limit: 25, offset: 0 }` deliberately matches `InquiriesInbox`'s own
   * first-page query exactly (its `INQUIRY_PAGE_SIZE` and its initial
   * `inquiryOffset` of 0) — React Query's cache treats an identical
   * procedure + input as the SAME query, so this probe and the inbox's own
   * query share one network request and one result rather than firing two.
   */
  const probe = trpc.admin.inquiries.list.useQuery({ limit: 25, offset: 0 }, { retry: false });

  if (probe.isError && isRoleRefusal(probe.error)) {
    return <DeniedState />;
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        eyebrow="Operations"
        title="Trip requests"
        description="Custom trip requests, general messages, and package enquiries guests send in — all in one inbox."
      />
      <InquiriesInbox role={role} />
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.inquiries`
 * call from anyone but owner and dispatcher. This just stops a finance user
 * who types the address from being shown a screen that can only be refused.
 * The second denial layer — a refused `admin.inquiries.list` this role check
 * did not catch — lives inside `TripRequestsAdmin`, beside the probe query
 * it guards.
 */
export default function AdminTripRequestsPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && me.data.role !== 'owner' && me.data.role !== 'dispatcher') {
    return <DeniedState />;
  }

  return <TripRequestsAdmin role={me.data?.role} />;
}
