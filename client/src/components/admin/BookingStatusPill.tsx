/**
 * A booking's status as a pill. The words are the information; the tint only
 * groups them (waiting on us / on track / done / closed), so nothing depends
 * on colour alone. No red: a closed booking is slate, a waiting one is amber.
 */
import { BOOKING_STATUS_LABELS, type BookingStatus } from '@rg/shared';

/**
 * The tint, and only the tint, lives here. The WORDS are
 * `BOOKING_STATUS_LABELS` (`@rg/shared`), shared with the three admin
 * screens; this grouping is this component's own design.
 */
const TONES: Record<string, string> = {
  pending_payment: 'bg-brand-gold-100 text-brand-gold-800',
  pending_verification: 'bg-brand-gold-100 text-brand-gold-800',
  confirmed: 'bg-brand-blue-100 text-brand-blue-900',
  assigned: 'bg-brand-blue-100 text-brand-blue-900',
  in_progress: 'bg-brand-blue-700 text-white',
  completed: 'bg-brand-blue-50 text-brand-blue-900',
  cancelled: 'bg-slate-100 text-brand-error',
  expired: 'bg-slate-100 text-brand-error',
};

export default function BookingStatusPill({ status }: { status: BookingStatus }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
        TONES[status] ?? 'text-brand-error bg-slate-100'
      }`}
    >
      {BOOKING_STATUS_LABELS[status]}
    </span>
  );
}
