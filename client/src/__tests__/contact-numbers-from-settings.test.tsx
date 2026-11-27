/**
 * BUG (owner spec, 2026-11-28, Task 1A): Admin → Settings → Contact details
 * carries `phoneDisplay`/`phoneTel`/`whatsapp`/`viber`/`altPhoneDisplay`/
 * `altPhoneTel`, but no public component read them — every WhatsApp/Viber/
 * call link used a hardcoded object in `client/src/lib/site.ts` instead, so
 * an admin's edit had no effect on the live site. This file pins the fix:
 * every public surface now reads `settings.contact` through the public
 * `settings.get` payload, and `@/lib/site` carries no phone/WhatsApp/Viber
 * number of its own at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import FloatingWhatsApp from '@/components/layout/FloatingWhatsApp';
import SiteFooter from '@/components/layout/SiteFooter';
import { ConsentProvider } from '@/lib/consent/ConsentContext';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/types';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderWithTrpc(node: ReactNode) {
  return render(
    <TrpcProviders>
      <ConsentProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ConsentProvider>
    </TrpcProviders>,
  );
}

function decideConsent() {
  localStorage.setItem(
    CONSENT_STORAGE_KEY,
    JSON.stringify({ v: 1, analytics: false, marketing: false, at: new Date().toISOString() }),
  );
}

describe('WhatsApp links use whatever settings.contact.whatsapp currently says', () => {
  it('FloatingWhatsApp builds its wa.me href from a changed whatsapp number', async () => {
    decideConsent();
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        contact: { ...SETTINGS_FIXTURE.contact, whatsapp: '639998887777' },
      },
    });
    renderWithTrpc(<FloatingWhatsApp />);

    const links = await screen.findAllByRole('link', { name: 'Chat with us on WhatsApp' });
    expect(links.length).toBeGreaterThan(0);
    // The link is on screen before `settings.get` resolves too (with no
    // number yet) — wait for the real href, not just the element's presence.
    await waitFor(() => {
      for (const link of links) {
        expect(link).toHaveAttribute('href', expect.stringContaining('wa.me/639998887777'));
      }
    });
    localStorage.removeItem(CONSENT_STORAGE_KEY);
  });

  it('the footer WhatsApp chip uses the same changed number', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        contact: { ...SETTINGS_FIXTURE.contact, whatsapp: '639998887777' },
      },
    });
    renderWithTrpc(<SiteFooter />);

    const link = await screen.findByRole('link', { name: 'Chat on WhatsApp' });
    await waitFor(() =>
      expect(link).toHaveAttribute('href', expect.stringContaining('wa.me/639998887777')),
    );
  });
});

/**
 * "Empty means use the WhatsApp number" (owner spec, 2026-11-28, Task 1A) is
 * applied server-side, in `resolveContact()` — pinned directly against that
 * function in `server/src/__tests__/settings.test.ts`. What a client
 * component receives on the wire is always an ALREADY-RESOLVED `contact.viber`
 * (never an empty string), so these tests mock that resolved value and pin
 * only the client's half of the contract: it builds the Viber deep link from
 * whatever `contact.viber` says, verbatim.
 */
describe('the Viber deep link uses whatever settings.contact.viber currently says', () => {
  it('uses contact.viber when it equals contact.whatsapp (the "no Viber number of its own" case)', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        contact: { ...SETTINGS_FIXTURE.contact, whatsapp: '639998887777', viber: '639998887777' },
      },
    });
    renderWithTrpc(<SiteFooter />);

    const link = await screen.findByRole('link', { name: 'Chat on Viber' });
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        `viber://chat?number=${encodeURIComponent('+639998887777')}`,
      ),
    );
  });

  it('uses its own number when contact.viber differs from contact.whatsapp', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        contact: {
          ...SETTINGS_FIXTURE.contact,
          whatsapp: '639998887777',
          viber: '+639112223333',
        },
      },
    });
    renderWithTrpc(<SiteFooter />);

    const link = await screen.findByRole('link', { name: 'Chat on Viber' });
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        `viber://chat?number=${encodeURIComponent('+639112223333')}`,
      ),
    );
    // Proves this isn't just always reading whatsapp — the WhatsApp chip
    // still carries the OTHER number.
    const whatsappLink = await screen.findByRole('link', { name: 'Chat on WhatsApp' });
    await waitFor(() =>
      expect(whatsappLink).toHaveAttribute('href', expect.stringContaining('wa.me/639998887777')),
    );
  });
});

/**
 * No file under `client/src` (excluding the test suite itself, which
 * legitimately carries these as fixture/expectation literals) may still
 * carry the numbers this bug's admin/live mismatch was built from. A grep
 * test rather than a rendering one, because the bug was a component reading
 * the WRONG source entirely — a render-only test can't see a dead literal
 * that happens to no longer be wired to anything.
 */
describe('no hardcoded contact numbers remain in client source (outside tests)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const clientSrc = resolve(here, '..');
  const STALE_NUMBERS = ['0908 469 6246', '0927 737 8431', '639084696246', '639277378431'];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('contains none of the old hardcoded numbers', () => {
    const offenders: string[] = [];
    for (const file of walk(clientSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const stale of STALE_NUMBERS) {
        if (text.includes(stale)) {
          offenders.push(`${relative(clientSrc, file).replace(/\\/g, '/')}: ${stale}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
