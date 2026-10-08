import { useSearchParams } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';

/** Placeholder target for the hero search. The real catalog is spec task 2C. */
export default function ToursStubPage() {
  const [params] = useSearchParams();

  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <SectionHeading
        eyebrow="Coming next"
        title="Tour catalog"
        subtitle="The full catalog with destination filters and live availability is task 2C."
      />
      <dl className="bg-brand-blue-50 mt-8 rounded-xl p-6 text-sm">
        <p className="text-brand-blue-900 mb-3 font-semibold">Search received:</p>
        {['destination', 'date', 'guests'].map((key) => (
          <div key={key} className="flex justify-between border-b border-white py-2 last:border-0">
            <dt className="text-muted-foreground capitalize">{key}</dt>
            <dd className="text-brand-blue-900 font-medium">{params.get(key) ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
