import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/types';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/**
 * 05-cookie-consent-spec.md point 9: "Never load analytics/pixels on /admin, /driver or /portal
 * pages." Proven structurally here, not by a runtime path check: `ConsentProvider` is mounted
 * only inside `PublicLayout` (client/src/components/layout/PublicLayout.tsx), and `/admin`,
 * `/driver` and `/portal` all render OUTSIDE it (App.tsx). Full consent is pre-stored and a valid
 * env id is stubbed for every case below — the comparative proof is that the SAME setup that
 * loads GA4 on a public page loads nothing at all on the three gated ones.
 */
const VALID_GA_ID = 'G-ABC1234567';
const VALID_PIXEL_ID = '1234567890123456';

function renderAppAt(path: string) {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

beforeEach(() => {
  localStorage.setItem(
    CONSENT_STORAGE_KEY,
    JSON.stringify({ v: 1, analytics: true, marketing: true, at: new Date().toISOString() }),
  );
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

describe('Consent route gating', () => {
  it('loads GA4 and the Pixel on a public page with full stored consent (the comparison case)', async () => {
    renderAppAt('/privacy');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' }),
    ).toBeInTheDocument();
    expect(document.getElementById('ts-ga4-script')).toBeInTheDocument();
    expect(document.getElementById('ts-meta-pixel-script')).toBeInTheDocument();
  });

  it.each([
    ['/admin/login', 'Staff sign-in'],
    ['/driver/login', 'Driver sign-in'],
    ['/portal/login', 'Your booking'],
  ])(
    'never loads anything on %s, with the identical consent that loads it on a public page',
    async (path, heading) => {
      renderAppAt(path);

      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      expect(document.getElementById('ts-ga4-script')).toBeNull();
      expect(document.getElementById('ts-meta-pixel-script')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Cookie consent' })).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Cookie settings' })).not.toBeInTheDocument();
    },
  );
});
