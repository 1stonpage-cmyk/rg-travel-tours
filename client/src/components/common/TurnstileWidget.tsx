import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

let scriptLoadPromise: Promise<void> | null = null;

/** Loads the Turnstile script at most once per page load, however many widgets mount. */
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Don't cache a rejected promise forever — a future mount attempt
        // (e.g. after the caller bumps `key` to retry) should load the
        // script again rather than replay this same rejection for the life
        // of the page.
        scriptLoadPromise = null;
        reject(new Error('Turnstile script failed to load'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

/**
 * Cloudflare Turnstile, managed mode (owner decision 2026-11-10/11, Task
 * 10). Renders NOTHING when `VITE_TURNSTILE_SITE_KEY` is not configured —
 * local dev, or Turnstile switched off — so `onVerify` is simply never
 * called, and every gated server procedure treats a missing token exactly
 * like "the feature is off" (`verifyTurnstile()`).
 *
 * A Turnstile token is single-use. Give this component a fresh `key` prop
 * after a failed submit to get a new one — see each wiring site in Tasks
 * 11–13 for the exact pattern (a `turnstileResetKey` state bumped in the
 * mutation's `onError`).
 *
 * This component's own `onError` prop (Cloudflare's `error-callback` /
 * `expired-callback`, and a failed script load) must only clear the stale
 * token, NEVER bump `turnstileResetKey` itself (HANDOVER-19 final-review
 * fix wave — a prior version of this wiring did, and a persistent render-
 * time error — e.g. a site-key/domain mismatch — re-fired on every remount,
 * looping unbounded with no human in the loop). Bumping the reset key stays
 * the mutation's `onError`'s job: that one only fires on an actual submit,
 * which is bounded by how many times a guest clicks Submit.
 */
export default function TurnstileWidget({
  onVerify,
  onError,
}: {
  onVerify: (token: string) => void;
  onError?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return;
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          callback: onVerify,
          'error-callback': onError,
          'expired-callback': onError,
        });
      })
      .catch(() => onError?.());
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
    // Mount once per `key` the caller gives this component — see the
    // component's own doc comment on why that is the reset mechanism.
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} className="my-2" />;
}
