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
      .catch(() => {
        /*
         * Deliberately NOT `onError?.()` here. Every caller's `onError` now
         * bumps `turnstileResetKey` (HANDOVER-19 fix wave, I1), which
         * remounts this component via `key` — and a remount re-enters this
         * same effect, which calls `loadTurnstileScript()` again. With the
         * cache-retry fix just above (M1: a failed load no longer sticks
         * forever), that second call tries the network again immediately,
         * fails again (an ad blocker or a regional block doesn't clear
         * itself in milliseconds), and loops — appending a fresh `<script>`
         * to `<head>` on every turn, unbounded, with no user action in
         * between. Swallowing it here leaves the widget simply unrendered:
         * `onVerify` never fires, `turnstileToken` stays `undefined`, and
         * the guest's own next submit — whose mutation `onError` already
         * bumps the reset key — is what retries the load, bounded by how
         * many times a human clicks Submit rather than by a tight loop.
         * Cloudflare's own `error-callback`/`expired-callback` above still
         * reach `onError` unchanged: those fire from an already-rendered
         * widget on a genuine verification failure, not a script-load
         * failure, so they don't re-enter `loadTurnstileScript()` in a loop.
         */
      });
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
