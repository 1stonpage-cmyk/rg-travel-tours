import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import SectionHeading from '@/components/common/SectionHeading';
import { MOST_VISITED } from '@/lib/placeholder-data';

export default function MostVisited() {
  return (
    <section id="places" className="bg-brand-blue-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Where guests go"
          title="Most visited places"
          subtitle="The six destinations our vans run to most often."
          className="[&_p:first-child]:text-brand-gold-300 [&_p:last-child]:text-brand-blue-200 [&_h2]:text-white"
        />
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MOST_VISITED.map((place) => (
            <li key={place.slug}>
              <Link
                to={`/tours?destination=${place.slug}`}
                className="focus-visible:ring-brand-gold-400 group relative block overflow-hidden rounded-xl"
              >
                <img
                  src={place.image}
                  alt={place.alt}
                  loading="lazy"
                  className="aspect-[3/2] w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="from-brand-blue-950 absolute inset-0 bg-gradient-to-t via-transparent to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  <h3 className="flex items-center gap-1.5 text-lg font-bold text-white">
                    {place.name}
                    <ArrowRight
                      className="size-4 transition-transform group-hover:translate-x-1"
                      aria-hidden="true"
                    />
                  </h3>
                  <p className="text-brand-blue-100 mt-1 text-base sm:text-sm">{place.blurb}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
