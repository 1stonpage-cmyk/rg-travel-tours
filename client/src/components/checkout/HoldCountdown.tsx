import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  /**
   * The server's `hold_expires_at`, echoed back by `checkout.createHold`.
   * Typed `Date` by that router (no change allowed there), but — like every
   * other date this server returns — arrives over the wire as an ISO
   * string, because `server/src/trpc.ts` configures no superjson
   * transformer (see `__tests__/helpers/fixtures.ts`'s own note on this
   * exact trap). `new Date(x)` below accepts either shape, so this prop
   * does too rather than mistyping what actually arrives.
   */
  expiresAt: string | Date;
};

const WARNING_THRESHOLD_MS = 2 * 60_000;

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Mirrors `AnnouncementBar.tsx`'s own `STYLE_CLASSES` map — the only two tones this UI ever uses, and no red in either (CLAUDE.md). */
const TONE_CLASSES = {
  calm: 'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900',
  warning: 'bg-brand-gold-100 text-brand-gold-800 border-brand-warning/30',
} as const;

/**
 * Display-only countdown toward `expiresAt` (Task 8, week 3 checkout plan).
 *
 * **It never expires the booking client-side.** The server's
 * `hold_expires_at` is the one truth, and only the cron sweep (plan Task 11)
 * acts on it. At zero this does not claim the hold lapsed — the sweep may
 * not have run yet, or the guest may already have paid — it just stops
 * counting down and says so neutrally. No mutation is reachable from this
 * component at all: it reads a prop and renders text, nothing else.
 *
 * The visible mm:ss digits are `aria-hidden` and re-render every second;
 * the one `role="status"` sentence underneath is NOT re-announced every
 * tick — it only changes text (and so only announces) at the single
 * transition into the final two minutes, which is the guidance against
 * turning a countdown into a competing live region that re-reads a bare
 * number every second.
 */
export default function HoldCountdown({ expiresAt }: Props) {
  const target = new Date(expiresAt).getTime();
  const [remainingMs, setRemainingMs] = useState(() => target - Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setRemainingMs(target - Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  const expired = remainingMs <= 0;
  const warning = !expired && remainingMs <= WARNING_THRESHOLD_MS;

  return (
    <div
      role="timer"
      aria-label="Hold countdown"
      className={cn('rounded-xl border p-4', warning ? TONE_CLASSES.warning : TONE_CLASSES.calm)}
    >
      {expired ? (
        <p className="text-sm font-medium">
          This hold's timer has run out. Your booking may still be fine — refresh this page or check
          your email, and contact us if you are unsure.
        </p>
      ) : (
        <>
          <p className="text-xs font-medium uppercase tracking-wide opacity-80">
            Your spot is held for
          </p>
          <p aria-hidden="true" className="text-2xl font-bold tabular-nums">
            {formatRemaining(remainingMs)}
          </p>
          <p role="status" className="sr-only">
            {warning
              ? 'Your hold is ending soon — finish payment to keep your spot.'
              : 'Your spot is held for about 15 minutes.'}
          </p>
        </>
      )}
    </div>
  );
}
