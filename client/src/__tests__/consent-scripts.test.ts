import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canLoadAnalytics,
  canLoadMarketing,
  injectGA4,
  injectMetaPixel,
  removeGA4,
  removeMetaPixel,
  scriptsAllowedInThisEnv,
} from '@/lib/consent/scripts';

const GRANTED = { analytics: true, marketing: true };
const DENIED = { analytics: false, marketing: false };
const VALID_GA_ID = 'G-ABC1234567';
const VALID_PIXEL_ID = '1234567890123456';

afterEach(() => {
  document.getElementById('ts-ga4-script')?.remove();
  document.getElementById('ts-meta-pixel-script')?.remove();
  document.cookie.split(';').forEach((pair) => {
    const name = pair.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  });
  vi.unstubAllEnvs();
});

describe('scriptsAllowedInThisEnv — the dev/test gate (05-cookie-consent-spec.md point 7)', () => {
  it('is false in this (unstubbed) test environment', () => {
    expect(scriptsAllowedInThisEnv()).toBe(false);
  });

  it('reads vi.stubEnv live, not a value frozen at import time', () => {
    vi.stubEnv('PROD', true);
    expect(scriptsAllowedInThisEnv()).toBe(true);
  });
});

describe('canLoadAnalytics — pure decision, owner decision 2026-10-27 #3', () => {
  it('is false with no consent even when the id is valid and the env allows it', () => {
    expect(canLoadAnalytics(DENIED, VALID_GA_ID, true)).toBe(false);
  });

  it('is false with consent but an empty id — "empty ID = never loads"', () => {
    expect(canLoadAnalytics(GRANTED, '', true)).toBe(false);
  });

  it('is false with consent but a malformed id', () => {
    expect(canLoadAnalytics(GRANTED, 'not-a-ga-id', true)).toBe(false);
  });

  it('is false with consent and a valid id when the env does not allow it (dev/test)', () => {
    expect(canLoadAnalytics(GRANTED, VALID_GA_ID, false)).toBe(false);
  });

  it('is true only when every condition holds at once', () => {
    expect(canLoadAnalytics(GRANTED, VALID_GA_ID, true)).toBe(true);
  });

  it('defaults envAllows to the real (unstubbed, false) environment when not passed', () => {
    expect(canLoadAnalytics(GRANTED, VALID_GA_ID)).toBe(false);
  });
});

describe('canLoadMarketing — same shape as canLoadAnalytics, for the Pixel id', () => {
  it('is false with no consent', () => {
    expect(canLoadMarketing(DENIED, VALID_PIXEL_ID, true)).toBe(false);
  });

  it('is false with an empty id', () => {
    expect(canLoadMarketing(GRANTED, '', true)).toBe(false);
  });

  it('is false with a non-numeric id', () => {
    expect(canLoadMarketing(GRANTED, 'abc123', true)).toBe(false);
  });

  it('is true only when every condition holds at once', () => {
    expect(canLoadMarketing(GRANTED, VALID_PIXEL_ID, true)).toBe(true);
  });
});

describe('injectGA4 / removeGA4 — DOM effects', () => {
  it('does nothing for a malformed id', () => {
    injectGA4('not-a-ga-id', GRANTED);
    expect(document.getElementById('ts-ga4-script')).toBeNull();
  });

  it('adds exactly one gtag.js script tag with the measurement id in its src', () => {
    injectGA4(VALID_GA_ID, GRANTED);
    const script = document.getElementById('ts-ga4-script') as HTMLScriptElement | null;
    expect(script).toBeInTheDocument();
    expect(script!.src).toContain('googletagmanager.com/gtag/js');
    expect(script!.src).toContain(encodeURIComponent(VALID_GA_ID));
  });

  it('is idempotent — calling it twice adds only one script tag', () => {
    injectGA4(VALID_GA_ID, GRANTED);
    injectGA4(VALID_GA_ID, GRANTED);
    expect(document.querySelectorAll('#ts-ga4-script')).toHaveLength(1);
  });

  it('pushes Consent Mode v2 default-denied then update-to-granted onto the dataLayer', () => {
    injectGA4(VALID_GA_ID, GRANTED);
    const calls = (window.dataLayer ?? []) as unknown[][];
    const defaultCall = calls.find((args) => args[0] === 'consent' && args[1] === 'default');
    const updateCall = calls.find((args) => args[0] === 'consent' && args[1] === 'update');
    expect(defaultCall?.[2]).toMatchObject({ analytics_storage: 'denied' });
    expect(updateCall?.[2]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('removeGA4 removes the script tag and deletes _ga*-named cookies, leaving others alone', () => {
    injectGA4(VALID_GA_ID, GRANTED);
    document.cookie = '_ga=GA1.1.123; path=/';
    document.cookie = '_ga_ABCDE12345=GS1.1.456; path=/';
    document.cookie = 'unrelated_cookie=keep-me; path=/';

    removeGA4();

    expect(document.getElementById('ts-ga4-script')).toBeNull();
    expect(document.cookie).not.toContain('_ga=');
    expect(document.cookie).not.toContain('_ga_ABCDE12345=');
    expect(document.cookie).toContain('unrelated_cookie=keep-me');
  });
});

describe('injectMetaPixel / removeMetaPixel — DOM effects', () => {
  beforeEach(() => {
    delete (window as { fbq?: unknown }).fbq;
    delete (window as { _fbq?: unknown })._fbq;
  });

  it('does nothing for a non-numeric id', () => {
    injectMetaPixel('not-a-pixel-id');
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
  });

  it('adds exactly one fbevents.js script tag and calls fbq init + PageView', () => {
    injectMetaPixel(VALID_PIXEL_ID);
    const script = document.getElementById('ts-meta-pixel-script') as HTMLScriptElement | null;
    expect(script).toBeInTheDocument();
    expect(script!.src).toContain('connect.facebook.net');
    expect(window.fbq).toBeTypeOf('function');
  });

  it('is idempotent — calling it twice adds only one script tag', () => {
    injectMetaPixel(VALID_PIXEL_ID);
    injectMetaPixel(VALID_PIXEL_ID);
    expect(document.querySelectorAll('#ts-meta-pixel-script')).toHaveLength(1);
  });

  it('removeMetaPixel removes the script tag and deletes _fbp/_fbc cookies, leaving others alone', () => {
    injectMetaPixel(VALID_PIXEL_ID);
    document.cookie = '_fbp=fb.1.123; path=/';
    document.cookie = '_fbc=fb.1.456; path=/';
    document.cookie = 'unrelated_cookie=keep-me; path=/';

    removeMetaPixel();

    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
    expect(document.cookie).not.toContain('_fbp=');
    expect(document.cookie).not.toContain('_fbc=');
    expect(document.cookie).toContain('unrelated_cookie=keep-me');
  });
});
