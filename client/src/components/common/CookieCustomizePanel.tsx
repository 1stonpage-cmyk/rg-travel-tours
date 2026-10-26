import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConsent } from '@/lib/consent/useConsent';
import { cn } from '@/lib/utils';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Excludes disabled controls — the locked Essential toggle is a `<button disabled>`, and
 * focusing a disabled element is a silent no-op in every browser (and jsdom). */
function focusableItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled'),
  );
}

function Toggle({
  id,
  label,
  description,
  checked,
  locked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  locked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <div className="border-border flex items-start justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-brand-ink text-sm font-semibold">{label}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={locked}
        onClick={() => onChange?.(!checked)}
        className={cn(
          'tap-target relative inline-flex w-14 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60',
          checked ? 'bg-brand-blue-600 border-brand-blue-600' : 'bg-muted border-border',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-6 translate-x-1 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-7',
          )}
        />
      </button>
    </div>
  );
}

/**
 * 05-cookie-consent-spec.md point 4 (the three toggles + Save) and point 10 (focus moves in on
 * open, Esc closes, 44px targets, AA contrast). No shadcn `Dialog`/Radix primitive exists in this
 * repo yet, and this task's DO NOT list rules out adding one — so this is a hand-rolled Tab/
 * Shift+Tab trap, matching how the rest of this codebase's custom interactive pieces (PinPad,
 * the admin drawer) are already built without a dependency.
 */
export default function CookieCustomizePanel() {
  const { panelOpen, closeCustomize, saveCustom, consent } = useConsent();
  const [analytics, setAnalytics] = useState(consent.analytics);
  const [marketing, setMarketing] = useState(consent.marketing);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  // Re-sync the draft toggles to the current stored consent every time the panel opens, so
  // reopening from the footer's "Cookie settings" after an earlier choice shows that choice
  // rather than whatever was left mid-edit from a previous, cancelled open.
  useEffect(() => {
    if (panelOpen) {
      setAnalytics(consent.analytics);
      setMarketing(consent.marketing);
    }
  }, [panelOpen, consent]);

  useEffect(() => {
    if (!panelOpen) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) focusableItems(panel)[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCustomize();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = focusableItems(panel);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      lastFocused.current?.focus();
    };
  }, [panelOpen, closeCustomize]);

  if (!panelOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cookie-customize-heading"
        className="bg-background max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl p-5 shadow-xl sm:rounded-2xl"
      >
        <h2 id="cookie-customize-heading" className="text-brand-blue-900 text-lg font-bold">
          Cookie settings
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose which cookies TravelSugbo can use. Essential cookies keep the site working and
          can&rsquo;t be switched off.
        </p>

        <div className="mt-4 space-y-3">
          <Toggle
            id="consent-essential"
            label="Essential"
            description="Keeps your session and booking secure. Always on."
            checked
            locked
          />
          <Toggle
            id="consent-analytics"
            label="Analytics"
            description="Google Analytics — helps us see how the site is used."
            checked={analytics}
            onChange={setAnalytics}
          />
          <Toggle
            id="consent-marketing"
            label="Marketing"
            description="Meta Pixel — measures our Facebook/Instagram ads."
            checked={marketing}
            onChange={setMarketing}
          />
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="tap-target" onClick={closeCustomize}>
            Cancel
          </Button>
          <Button
            type="button"
            className="tap-target"
            onClick={() => saveCustom({ analytics, marketing })}
          >
            Save choices
          </Button>
        </div>
      </div>
    </div>
  );
}
