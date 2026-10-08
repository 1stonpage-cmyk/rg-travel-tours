import { Check } from 'lucide-react';
import { useState } from 'react';
import SectionHeading from '@/components/common/SectionHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PACKAGES, formatPeso } from '@/lib/placeholder-data';

export default function PackagesSection() {
  const [selected, setSelected] = useState<string>(PACKAGES[0]!.slug);
  const [submitted, setSubmitted] = useState(false);

  return (
    <section id="packages" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Multi-day"
        title="Packages"
        subtitle="Three to five days across Cebu and Bohol, with transfers and accommodation handled."
      />

      <ul className="mt-10 grid gap-6 lg:grid-cols-3">
        {PACKAGES.map((pkg) => (
          <li
            key={pkg.id}
            className="border-brand-blue-100 group press flex flex-col overflow-hidden rounded-xl border hover:-translate-y-1 hover:shadow-lg"
          >
            <div className="overflow-hidden">
              <img
                src={pkg.image}
                alt={pkg.alt}
                loading="lazy"
                className="aspect-[3/2] w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
              />
            </div>
            <div className="flex flex-1 flex-col p-5">
              <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-wider">
                {pkg.days} days / {pkg.days - 1} nights
              </p>
              <h3 className="text-brand-blue-900 mt-1.5 text-lg font-bold">{pkg.title}</h3>
              <p className="text-muted-foreground mt-2 text-base sm:text-sm">{pkg.description}</p>

              <ul className="mt-4 space-y-1.5 text-base sm:text-sm">
                {pkg.highlights.map((h) => (
                  <li key={h} className="text-brand-ink flex items-center gap-2">
                    <Check className="text-brand-gold-600 size-4 shrink-0" aria-hidden="true" />
                    {h}
                  </li>
                ))}
              </ul>

              <div className="mt-5 flex items-baseline gap-2">
                <s className="text-muted-foreground text-sm">{formatPeso(pkg.oldPriceCentavos)}</s>
                <span className="text-brand-blue-900 text-2xl font-bold">
                  {formatPeso(pkg.newPriceCentavos)}
                </span>
                <span className="text-muted-foreground text-xs">per group</span>
              </div>

              <Button
                className="tap-target mt-4 w-full"
                onClick={() => {
                  setSelected(pkg.slug);
                  document.getElementById('package-inquiry-name')?.focus();
                }}
              >
                Enquire about this package
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <form
        aria-label="Package inquiry"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
        className="bg-brand-blue-50 mt-10 grid gap-4 rounded-2xl p-6 sm:grid-cols-2"
      >
        <h3 className="text-brand-blue-900 text-lg font-semibold sm:col-span-2">
          Ask about a package
        </h3>

        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-name">Your name</Label>
          <Input id="package-inquiry-name" name="name" required className="tap-target" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-email">Email</Label>
          <Input
            id="package-inquiry-email"
            name="email"
            type="email"
            required
            className="tap-target"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-package">Package</Label>
          <select
            id="package-inquiry-package"
            name="package"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="border-input bg-background tap-target w-full rounded-md border px-3 text-base md:text-sm"
          >
            {PACKAGES.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="package-inquiry-dates">Preferred dates</Label>
          <Input id="package-inquiry-dates" name="dates" type="date" className="tap-target" />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" size="lg" className="tap-target w-full sm:w-auto">
            Send inquiry
          </Button>
          {submitted && (
            <p role="status" className="text-brand-warning mt-3 text-sm font-medium">
              Form validated. Inquiry delivery is not connected yet (spec task 7C) — nothing has
              been sent. Please message us on WhatsApp in the meantime.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
