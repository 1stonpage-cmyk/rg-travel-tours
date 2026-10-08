import { BadgeCheck, CreditCard, Headset, Users } from 'lucide-react';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

const ITEMS = [
  { icon: BadgeCheck, label: 'DOT accredited operator' },
  {
    icon: Users,
    label: `${PLACEHOLDER_SETTINGS.guestsServed.toLocaleString('en-PH')}+ guests served`,
  },
  { icon: CreditCard, label: `${PLACEHOLDER_SETTINGS.depositPercent}% deposit to reserve` },
  { icon: Headset, label: 'Local team on WhatsApp daily' },
];

export default function TrustBar() {
  return (
    <section aria-label="Why guests trust us" className="bg-brand-blue-50 border-y">
      <ul className="mx-auto grid max-w-7xl grid-cols-2 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-4 lg:px-8">
        {ITEMS.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="text-brand-blue-900 flex items-center gap-2.5 text-sm font-medium"
          >
            <Icon className="text-brand-gold-600 size-5 shrink-0" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}
