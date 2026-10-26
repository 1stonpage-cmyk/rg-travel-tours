import type { ConsentCategories } from './types';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue?: unknown[];
      loaded?: boolean;
      version?: string;
    };
    _fbq?: unknown;
  }
}

/**
 * The single belt-and-suspenders gate for "dev/test: never load" (05-cookie-consent-spec.md,
 * point 7) — independent of the "empty ID never loads" rule, which already covers local dev
 * honestly (nobody commits a real ID), in case a real ID is ever present in a local `.env` by
 * mistake. `import.meta.env.PROD` is only true for a `vite build` production bundle; `pnpm dev`
 * and `pnpm test` are both false.
 *
 * A function, not a module-level constant: `import.meta.env.PROD` must be read fresh on every
 * call so `vi.stubEnv('PROD', 'true')` inside a test can flip it — a `const` captured once at
 * module-load time would freeze whatever value was true when this file was first imported,
 * before any test had a chance to stub it.
 */
export function scriptsAllowedInThisEnv(): boolean {
  return import.meta.env.PROD === true;
}

const GA_ID_PATTERN = /^G-[A-Z0-9]+$/i;
const PIXEL_ID_PATTERN = /^\d+$/;

export function getGaMeasurementId(): string {
  return (import.meta.env.VITE_GA_MEASUREMENT_ID ?? '').trim();
}

export function getMetaPixelId(): string {
  return (import.meta.env.VITE_META_PIXEL_ID ?? '').trim();
}

/**
 * Pure decision — no DOM access, so this is the part every "loads only when X" test exercises
 * directly rather than through script injection. An empty OR malformed id is "never loads", same
 * as the spec's "if an ID is empty" (owner decision 2026-10-27, #3) — a malformed id could never
 * have come from a real account, so treating it the same way is not a stricter rule, just the
 * same one applied honestly.
 */
export function canLoadAnalytics(
  consent: ConsentCategories,
  measurementId: string,
  envAllows: boolean = scriptsAllowedInThisEnv(),
): boolean {
  return envAllows && consent.analytics && GA_ID_PATTERN.test(measurementId);
}

export function canLoadMarketing(
  consent: ConsentCategories,
  pixelId: string,
  envAllows: boolean = scriptsAllowedInThisEnv(),
): boolean {
  return envAllows && consent.marketing && PIXEL_ID_PATTERN.test(pixelId);
}

const GA_SCRIPT_ID = 'ts-ga4-script';
const PIXEL_SCRIPT_ID = 'ts-meta-pixel-script';

function ensureGtagStub(): void {
  window.dataLayer = window.dataLayer ?? [];
  if (!window.gtag) {
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer!.push(args);
    };
  }
}

/**
 * Google Consent Mode v2 (spec point 6): default denied, then updated to what the visitor
 * actually accepted, both pushed before `config` runs. Idempotent against repeated calls — the
 * `<script id=...>` guard below stops a second `gtag/js` tag, but `consent`/`config` calls are
 * cheap and safe to repeat if consent changes while already granted (e.g. Customize re-saved).
 */
export function injectGA4(measurementId: string, consent: ConsentCategories): void {
  if (!GA_ID_PATTERN.test(measurementId)) return;
  ensureGtagStub();
  window.gtag!('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  window.gtag!('consent', 'update', {
    analytics_storage: consent.analytics ? 'granted' : 'denied',
    ad_storage: consent.marketing ? 'granted' : 'denied',
    ad_user_data: consent.marketing ? 'granted' : 'denied',
    ad_personalization: consent.marketing ? 'granted' : 'denied',
  });
  if (!document.getElementById(GA_SCRIPT_ID)) {
    const script = document.createElement('script');
    script.id = GA_SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);
  }
  window.gtag!('js', new Date());
  window.gtag!('config', measurementId);
}

export function removeGA4(): void {
  document.getElementById(GA_SCRIPT_ID)?.remove();
  deleteCookiesMatching(/^_ga(_[A-Za-z0-9]+)?$/);
}

type FbqStub = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  loaded: boolean;
  version: string;
};

function ensureFbqStub(): void {
  if (window.fbq) return;
  const stub = function fbq(this: FbqStub, ...args: unknown[]) {
    if (stub.callMethod) stub.callMethod(...args);
    else stub.queue.push(args);
  } as FbqStub;
  stub.queue = [];
  stub.loaded = true;
  stub.version = '2.0';
  window.fbq = stub;
  window._fbq = window._fbq ?? stub;
}

/**
 * No string-interpolated `<script>` body — the stub is built from real JS statements and the
 * Pixel id (already validated numeric-only by `canLoadMarketing`) is passed as a function
 * argument, never concatenated into script text or markup.
 */
export function injectMetaPixel(pixelId: string): void {
  if (!PIXEL_ID_PATTERN.test(pixelId)) return;
  ensureFbqStub();
  if (!document.getElementById(PIXEL_SCRIPT_ID)) {
    const script = document.createElement('script');
    script.id = PIXEL_SCRIPT_ID;
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }
  window.fbq!('init', pixelId);
  window.fbq!('track', 'PageView');
}

export function removeMetaPixel(): void {
  document.getElementById(PIXEL_SCRIPT_ID)?.remove();
  deleteCookiesMatching(/^_fb[pc]$/);
}

/** Best-effort — a cookie set `HttpOnly` or on a different path can't be cleared from here. */
function deleteCookiesMatching(pattern: RegExp): void {
  try {
    const names = document.cookie
      .split(';')
      .map((pair) => pair.split('=')[0]?.trim())
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      if (pattern.test(name)) {
        document.cookie = `${name}=; Max-Age=0; path=/`;
      }
    }
  } catch {
    // document.cookie can throw in some sandboxed contexts.
  }
}
