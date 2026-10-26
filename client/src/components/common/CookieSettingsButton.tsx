import { useConsent } from '@/lib/consent/useConsent';

/** The inline "Cookie settings" reference the Cookie Policy page's own copy makes to itself. */
export default function CookieSettingsButton() {
  const { reopen } = useConsent();
  return (
    <button
      type="button"
      onClick={reopen}
      className="tap-target text-brand-blue-700 font-semibold underline underline-offset-2 hover:no-underline"
    >
      Cookie settings
    </button>
  );
}
