import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CookieConsentBanner from '@/components/common/CookieConsentBanner';
import CookieCustomizePanel from '@/components/common/CookieCustomizePanel';
import SiteFooter from '@/components/layout/SiteFooter';
import { ConsentProvider } from '@/lib/consent/ConsentContext';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/types';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const VALID_GA_ID = 'G-ABC1234567';
const VALID_PIXEL_ID = '1234567890123456';

function renderConsentUI() {
  return render(
    <MemoryRouter>
      <ConsentProvider>
        <CookieConsentBanner />
        <CookieCustomizePanel />
      </ConsentProvider>
    </MemoryRouter>,
  );
}

function renderWithFooter() {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <ConsentProvider>
          <SiteFooter />
          <CookieConsentBanner />
          <CookieCustomizePanel />
        </ConsentProvider>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', VALID_GA_ID);
  vi.stubEnv('VITE_META_PIXEL_ID', VALID_PIXEL_ID);
});

afterEach(() => {
  localStorage.clear();
  document.getElementById('ts-ga4-script')?.remove();
  document.getElementById('ts-meta-pixel-script')?.remove();
  vi.unstubAllEnvs();
});

describe('CookieConsentBanner — first visit (05-cookie-consent-spec.md)', () => {
  it('shows on first visit, before any consent exists, and nothing loads yet', () => {
    renderConsentUI();

    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeInTheDocument();
    expect(document.getElementById('ts-ga4-script')).toBeNull();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
  });

  it('shows three equal-weight buttons — same variant, so none reads as "the" recommended action', () => {
    renderConsentUI();
    const banner = screen.getByRole('region', { name: 'Cookie consent' });

    const reject = within(banner).getByRole('button', { name: 'Reject all' });
    const customize = within(banner).getByRole('button', { name: 'Customize' });
    const accept = within(banner).getByRole('button', { name: 'Accept all' });

    expect(reject.className).toBe(customize.className);
    expect(customize.className).toBe(accept.className);
  });

  it('links to the Cookie Policy page', () => {
    renderConsentUI();
    const banner = screen.getByRole('region', { name: 'Cookie consent' });
    expect(within(banner).getByRole('link', { name: 'Cookie Policy' })).toHaveAttribute(
      'href',
      '/cookies',
    );
  });
});

describe('Reject all', () => {
  it('loads nothing, closes the banner, and stores a denied, dated, versioned choice', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Reject all' }));

    expect(screen.queryByRole('region', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(document.getElementById('ts-ga4-script')).toBeNull();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();

    const stored = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY)!);
    expect(stored).toMatchObject({ v: 1, analytics: false, marketing: false });
    expect(new Date(stored.at).toString()).not.toBe('Invalid Date');
  });
});

describe('Accept all', () => {
  it('loads both GA4 and the Pixel, and closes the banner', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Accept all' }));

    expect(screen.queryByRole('region', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(document.getElementById('ts-ga4-script')).toBeInTheDocument();
    expect(document.getElementById('ts-meta-pixel-script')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY)!);
    expect(stored).toMatchObject({ v: 1, analytics: true, marketing: true });
  });

  it('loads nothing at all when the env id is empty, even on full accept', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    vi.stubEnv('VITE_META_PIXEL_ID', '');
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Accept all' }));

    expect(document.getElementById('ts-ga4-script')).toBeNull();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
  });
});

describe('Customize panel', () => {
  it('opens with no box pre-ticked beyond the locked Essential switch', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Customize' }));

    const panel = screen.getByRole('dialog', { name: 'Cookie settings' });
    expect(within(panel).getByRole('switch', { name: 'Essential' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(panel).getByRole('switch', { name: 'Essential' })).toBeDisabled();
    expect(within(panel).getByRole('switch', { name: 'Analytics' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(within(panel).getByRole('switch', { name: 'Marketing' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('moves focus into the panel on open', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Customize' }));

    const panel = screen.getByRole('dialog', { name: 'Cookie settings' });
    expect(panel).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes on Escape, without saving a choice', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('dialog', { name: 'Cookie settings' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Cookie settings' })).not.toBeInTheDocument();
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    // Closing Customize without choosing returns to the banner — the visit is still unset.
    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeInTheDocument();
  });

  it('accepting analytics only loads GA and not the Pixel', async () => {
    const user = userEvent.setup();
    renderConsentUI();

    await user.click(screen.getByRole('button', { name: 'Customize' }));
    const panel = screen.getByRole('dialog', { name: 'Cookie settings' });
    await user.click(within(panel).getByRole('switch', { name: 'Analytics' }));
    await user.click(within(panel).getByRole('button', { name: 'Save choices' }));

    expect(document.getElementById('ts-ga4-script')).toBeInTheDocument();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();

    const stored = JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY)!);
    expect(stored).toMatchObject({ analytics: true, marketing: false });
  });
});

describe('Stored choice on reload', () => {
  it('a current-version stored choice is respected: no banner, and the saved categories load', () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 1, analytics: true, marketing: false, at: new Date().toISOString() }),
    );

    renderConsentUI();

    expect(screen.queryByRole('region', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(document.getElementById('ts-ga4-script')).toBeInTheDocument();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
  });

  it('a lower-version stored choice re-asks (a category set change, spec point 5)', () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 0, analytics: true, marketing: true, at: new Date().toISOString() }),
    );

    renderConsentUI();

    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeInTheDocument();
    // Re-asked means nothing loads until the visitor answers again, even though
    // the stale record said both categories were on.
    expect(document.getElementById('ts-ga4-script')).toBeNull();
    expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
  });

  it('a choice older than 12 months re-asks', () => {
    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        analytics: true,
        marketing: true,
        at: thirteenMonthsAgo.toISOString(),
      }),
    );

    renderConsentUI();

    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeInTheDocument();
  });
});

describe('Footer "Cookie settings" (task 2C)', () => {
  it('reopens the Customize panel even after a choice was already made', async () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 1, analytics: false, marketing: false, at: new Date().toISOString() }),
    );
    const user = userEvent.setup();
    renderWithFooter();

    expect(screen.queryByRole('region', { name: 'Cookie consent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Cookie settings' })).not.toBeInTheDocument();

    const legalNav = screen.getByRole('navigation', { name: 'Legal' });
    await user.click(within(legalNav).getByRole('button', { name: 'Cookie settings' }));

    expect(screen.getByRole('dialog', { name: 'Cookie settings' })).toBeInTheDocument();
  });

  it('pre-fills the panel with the currently stored choice, not defaults', async () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 1, analytics: true, marketing: false, at: new Date().toISOString() }),
    );
    const user = userEvent.setup();
    renderWithFooter();

    const legalNav = screen.getByRole('navigation', { name: 'Legal' });
    await user.click(within(legalNav).getByRole('button', { name: 'Cookie settings' }));

    const panel = screen.getByRole('dialog', { name: 'Cookie settings' });
    expect(within(panel).getByRole('switch', { name: 'Analytics' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(panel).getByRole('switch', { name: 'Marketing' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
