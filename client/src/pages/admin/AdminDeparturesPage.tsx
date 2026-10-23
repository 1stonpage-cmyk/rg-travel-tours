/**
 * The departures board on a screen of its own: today's trips, stop by stop.
 *
 * Nothing new is fetched. `DeparturesBoard` owns its query
 * (`admin.departures.today`, `adminProcedure('dashboard')`, so owner,
 * dispatcher and finance) and its fifteen-second poll; the dashboard shows the
 * very same component. The nav draws this link for those three roles, and the
 * server answers whoever asks regardless of what is drawn.
 */
import DeparturesBoard from '@/components/admin/DeparturesBoard';

export default function AdminDeparturesPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Dispatch
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Departures board</h1>
        <p className="text-brand-error text-sm">
          Every trip leaving today, with the van, the driver and how far along each one is.
        </p>
      </header>
      <DeparturesBoard />
    </div>
  );
}
