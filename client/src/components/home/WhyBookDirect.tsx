import { Calendar, Headset, Map, Shield, Tag, Wallet, type LucideIcon } from 'lucide-react';
import SectionHeading from '@/components/common/SectionHeading';
import { WHY_BOOK_DIRECT } from '@/lib/placeholder-data';

const ICONS: Record<string, LucideIcon> = {
  tag: Tag,
  wallet: Wallet,
  shield: Shield,
  headset: Headset,
  calendar: Calendar,
  map: Map,
};

export default function WhyBookDirect() {
  return (
    <section id="why" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <SectionHeading
        eyebrow="Book direct"
        title="Six reasons to skip the booking platforms"
        subtitle="Editable from admin settings once the site is live."
      />
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {WHY_BOOK_DIRECT.map((reason) => {
          const Icon = ICONS[reason.icon] ?? Tag;
          return (
            <li key={reason.title} className="border-brand-blue-100 rounded-xl border p-6">
              <span className="bg-brand-gold-100 flex size-11 items-center justify-center rounded-lg">
                <Icon className="text-brand-gold-700 size-5" aria-hidden="true" />
              </span>
              <h3 className="text-brand-blue-900 mt-4 text-base font-semibold">{reason.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{reason.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
