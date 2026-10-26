import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useConsent } from '@/lib/consent/useConsent';

/**
 * 05-cookie-consent-spec.md, points 1–3. All three buttons share one variant/size so none reads
 * as the "recommended" action — "equal visual weight" is the spec's own phrase, and a filled
 * Accept vs outlined Reject/Customize is exactly the dark pattern that phrase rules out.
 *
 * Positioned above `FloatingWhatsApp`'s own mobile bottom bar rather than stacking on it:
 * `FloatingWhatsApp` reads `bannerOpen`/`panelOpen` from this same context and hides itself while
 * either is showing (see FloatingWhatsApp.tsx), so there is never a second fixed-bottom element
 * for this one to collide with — which is what keeps it clear of the checkout page's own buttons
 * at 360px (task 2D), rather than a hand-tuned pixel offset that would drift out of sync.
 */
export default function CookieConsentBanner() {
  const { bannerOpen, acceptAll, rejectAll, openCustomize } = useConsent();

  if (!bannerOpen) return null;

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="bg-background fixed inset-x-0 bottom-0 z-[60] border-t p-4 shadow-[0_-4px_12px_-4px_rgba(15,23,46,0.18)] sm:p-5"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="text-brand-ink text-sm">
          We use essential cookies to run TravelSugbo. With your OK, we&rsquo;d also use analytics
          and marketing cookies to improve the site and our ads.{' '}
          <Link to="/cookies" className="text-brand-blue-700 underline underline-offset-2">
            Cookie Policy
          </Link>
        </p>
        <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0">
          <Button type="button" variant="outline" className="tap-target" onClick={rejectAll}>
            Reject all
          </Button>
          <Button type="button" variant="outline" className="tap-target" onClick={openCustomize}>
            Customize
          </Button>
          <Button type="button" variant="outline" className="tap-target" onClick={acceptAll}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );
}
