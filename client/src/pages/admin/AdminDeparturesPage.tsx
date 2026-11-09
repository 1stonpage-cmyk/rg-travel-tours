/**
 * The departures board on a screen of its own: today's trips, stop by stop.
 *
 * Nothing new is fetched. `DeparturesBoard` owns its query
 * (`admin.departures.today`, `adminProcedure('dashboard')`, so owner,
 * dispatcher and finance) and its fifteen-second poll; the dashboard shows the
 * very same component. The nav draws this link for those three roles, and the
 * server answers whoever asks regardless of what is drawn.
 */
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import DeparturesBoard from '@/components/admin/DeparturesBoard';

export default function AdminDeparturesPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* No `action`: this page is read-only (the board below has no CTA of its own). */}
      <AdminPageHeader
        eyebrow="Dispatch"
        title="Departures board"
        description="Every trip leaving today, with the van, the driver and how far along each one is."
      />
      <DeparturesBoard />
    </div>
  );
}
