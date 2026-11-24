import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackEvent } from '@/lib/consent/scripts';

/**
 * Task 12 (SEO fixes, 2026-11-24) — `trackEvent` itself.
 *
 * `trackEvent` does NO consent checking of its own: `window.gtag`/
 * `window.fbq` are only ever installed post-consent by `injectGA4`/
 * `injectMetaPixel` (see `consent-scripts.test.ts`), so this file only tests
 * the thin wrapper's own two behaviours — no-op when neither is installed,
 * and forward the call verbatim when one is — never re-tests the consent
 * gate.
 */

afterEach(() => {
  delete (window as unknown as { gtag?: unknown }).gtag;
  delete (window as unknown as { fbq?: unknown }).fbq;
});

describe('trackEvent — thin GA4/Pixel wrapper, no consent check of its own', () => {
  it('no-ops when gtag was never installed (no consent / no id)', () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    expect(() => trackEvent('view_route', { routeId: 1 })).not.toThrow();
  });

  it('calls gtag("event", name, params) when gtag exists', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    trackEvent('view_route', { routeId: 1 });
    expect(gtag).toHaveBeenCalledWith('event', 'view_route', { routeId: 1 });
  });

  it('also calls fbq("trackCustom", name, params) when fbq exists', () => {
    const gtag = vi.fn();
    const fbq = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    (window as unknown as { fbq: unknown }).fbq = fbq;
    trackEvent('begin_booking', { productType: 'transfer_one_way' });
    expect(fbq).toHaveBeenCalledWith('trackCustom', 'begin_booking', {
      productType: 'transfer_one_way',
    });
  });

  it('does not call fbq when only gtag exists', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    trackEvent('begin_booking', { productType: 'transfer_one_way' });
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
  });

  it('defaults params to an empty object when none are given', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    trackEvent('view_route');
    expect(gtag).toHaveBeenCalledWith('event', 'view_route', {});
  });

  it('hold_created never carries personal data', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    trackEvent('hold_created', { ref: 'RG-7KQ4M9' });
    const params = gtag.mock.calls[0]?.[2];
    expect(params).not.toHaveProperty('email');
    expect(params).not.toHaveProperty('phone');
    expect(params).not.toHaveProperty('name');
  });
});
