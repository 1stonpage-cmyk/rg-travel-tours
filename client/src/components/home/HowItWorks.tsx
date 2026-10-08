import SectionHeading from '@/components/common/SectionHeading';
import { HOW_IT_WORKS } from '@/lib/placeholder-data';

export default function HowItWorks() {
  return (
    <section id="how" className="bg-brand-blue-50 border-y">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How it works"
          title="Booking takes about two minutes"
          subtitle="No waiting for a quote. Reserve online and we take it from there."
        />
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((item) => (
            <li key={item.step} className="bg-background rounded-xl p-6 shadow-sm">
              <span className="bg-brand-blue-600 text-brand-gold-300 flex size-10 items-center justify-center rounded-full text-base font-bold">
                {item.step}
              </span>
              <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">{item.title}</h3>
              <p className="text-muted-foreground mt-2 text-base sm:text-sm">{item.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
