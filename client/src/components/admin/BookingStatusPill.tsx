/**
 * A booking's status as a pill. The words are the information; the tint only
 * groups them (waiting on us / on track / done / closed), so nothing depends
 * on colour alone. No red: a closed booking is slate, a waiting one is amber.
 */
const LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  pending_verification: 'Checking receipt',
  confirmed: 'Confirmed',
  assigned: 'Driver assigned',
  in_progress: 'On tour',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

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

export default function BookingStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
        TONES[status] ?? 'text-brand-error bg-slate-100'
      }`}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
