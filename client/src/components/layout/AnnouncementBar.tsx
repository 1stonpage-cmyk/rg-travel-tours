import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/**
 * Site-wide announcement bar, settings-driven (spec task 6A / 3.1).
 *
 * The server already resolves the Manila date window (`resolveAnnouncement`,
 * server/src/content/settings.ts): `settings.announcement` is either
 * `{ message, href, style }` or `null`. The `startsAt`/`endsAt`/`isActive`
 * schedule fields never reach the browser. That is deliberate and this
 * component must not add any date logic of its own — a client-side check
 * would show a Manila-scheduled announcement at the wrong instant for any
 * guest whose device clock is in another timezone. If this renders at all,
 * it should render.
 */

/** There is no third style, and never will be — see settings-schema.ts's `announcementSchema`. No red anywhere in the UI (CLAUDE.md). */
const STYLE_CLASSES: Record<'info' | 'warning', string> = {
  info: 'bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200',
  warning: 'bg-brand-gold-100 text-brand-gold-800 border-brand-warning/30',
};

const DISMISS_KEY_PREFIX = 'ts-announcement-dismissed-';

/**
 * Small, deterministic (not cryptographic) string hash — only needs to be
 * stable for the same message and differ for a different one. Dismissal is
 * keyed by this hash, not by a constant, so a *new* announcement reappears
 * even for a guest who already dismissed a previous one; keying by a
 * constant would silently suppress every future announcement for them.
 */
function hashMessage(message: string): string {
  let hash = 0;
  for (let i = 0; i < message.length; i += 1) {
    hash = (hash * 31 + message.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Both reads and writes are wrapped in try/catch: sessionStorage throws
 * outright in some privacy modes, and an unhandled throw here would take
 * down the whole layout (AnnouncementBar sits above <SiteHeader/> in
 * PublicLayout). Same defensive shape as FloatingWhatsApp's
 * pulseAlreadyShown()/markPulseShown() — degrade to "not dismissed" (the
 * bar still shows) rather than letting the error escape.
 */
function isDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function markDismissed(key: string) {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Privacy mode or storage disabled: degrade silently. Worst case the
    // bar reappears next load — a minor cosmetic miss, not a broken page.
  }
}

export default function AnnouncementBar() {
  const { data } = trpc.settings.get.useQuery();
  const announcement = data?.announcement ?? null;
  const storageKey = announcement ? DISMISS_KEY_PREFIX + hashMessage(announcement.message) : '';

  // Hooks run unconditionally, in the same order, every render — the `if
  // (!announcement) return null` below happens only after both are called.
  const [dismissed, setDismissed] = useState(() => (storageKey ? isDismissed(storageKey) : true));
  useEffect(() => {
    if (storageKey) setDismissed(isDismissed(storageKey));
  }, [storageKey]);

  if (!announcement || dismissed) return null;

  const handleDismiss = () => {
    markDismissed(storageKey);
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className={cn('border-b px-4 py-2 text-sm', STYLE_CLASSES[announcement.style])}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <p className="flex-1 font-medium">
          {announcement.href ? (
            <a href={announcement.href} className="underline underline-offset-2 hover:no-underline">
              {announcement.message}
            </a>
          ) : (
            announcement.message
          )}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="tap-target shrink-0 hover:bg-black/5"
          aria-label="Dismiss announcement"
          onClick={handleDismiss}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
