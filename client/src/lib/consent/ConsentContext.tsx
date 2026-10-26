import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConsentContext, type ConsentContextValue } from './context';
import { readStoredConsent, writeStoredConsent } from './storage';
import type { ConsentCategories } from './types';
import {
  canLoadAnalytics,
  canLoadMarketing,
  getGaMeasurementId,
  getMetaPixelId,
  injectGA4,
  injectMetaPixel,
  removeGA4,
  removeMetaPixel,
} from './scripts';

const DEFAULT_CONSENT: ConsentCategories = { analytics: false, marketing: false };

/**
 * Mounted once, inside `PublicLayout` only (task 2D) — `/admin`, `/driver` and `/portal` never
 * render it, so "never load analytics/pixels" there is structural, not a runtime path check.
 *
 * No SSR/hydration here (the server injects meta tags into a static shell; the app itself is pure
 * CSR — see `server/src/html.ts`), so the stored choice can be read directly in the `useState`
 * initializers below with no first-paint flash.
 */
export function ConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<ConsentCategories>(() => {
    const stored = readStoredConsent();
    return stored ? { analytics: stored.analytics, marketing: stored.marketing } : DEFAULT_CONSENT;
  });
  const [status, setStatus] = useState<'unset' | 'set'>(() =>
    readStoredConsent() ? 'set' : 'unset',
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const bannerOpen = status === 'unset' && !panelOpen;

  function commit(categories: ConsentCategories) {
    writeStoredConsent(categories);
    setConsent(categories);
    setStatus('set');
    setPanelOpen(false);
  }

  const acceptAll = () => commit({ analytics: true, marketing: true });
  const rejectAll = () => commit({ analytics: false, marketing: false });
  const saveCustom = (categories: ConsentCategories) => commit(categories);
  const openCustomize = () => setPanelOpen(true);
  const closeCustomize = () => setPanelOpen(false);
  const reopen = () => setPanelOpen(true);

  /**
   * Reactive to `consent` alone — env IDs and the dev/test gate don't change at runtime, so they
   * don't need to be effect dependencies. Injectors are id-guarded (idempotent); removers are
   * safe to call even when nothing was ever injected. Default consent is both categories false,
   * so this naturally loads nothing until an explicit accept — no separate "still unset" check
   * needed.
   */
  useEffect(() => {
    const gaId = getGaMeasurementId();
    const pixelId = getMetaPixelId();
    if (canLoadAnalytics(consent, gaId)) {
      injectGA4(gaId, consent);
    } else {
      removeGA4();
    }
    if (canLoadMarketing(consent, pixelId)) {
      injectMetaPixel(pixelId);
    } else {
      removeMetaPixel();
    }
  }, [consent]);

  const value = useMemo<ConsentContextValue>(
    () => ({
      consent,
      status,
      bannerOpen,
      panelOpen,
      acceptAll,
      rejectAll,
      saveCustom,
      openCustomize,
      closeCustomize,
      reopen,
    }),
    [consent, status, bannerOpen, panelOpen],
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}
