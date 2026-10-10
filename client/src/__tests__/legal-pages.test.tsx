import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import SiteFooter from '@/components/layout/SiteFooter';
import PrivacyPage from '@/pages/public/PrivacyPage';
import TermsPage from '@/pages/public/TermsPage';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderWithTrpc(node: ReactNode) {
  return render(
    <TrpcProviders>
      <MemoryRouter>{node}</MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PrivacyPage', () => {
  it('renders the privacy markdown from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<PrivacyPage />);

    // The fixture's markdown body, demoted to h2 (see legal-pages.test.tsx
    // "sets a single h1 per page" below for the h1-ownership assertion).
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Privacy Notice' }),
    ).toBeInTheDocument();
  });

  it('shows the TODO legal-review notice while the text is placeholder, in the amber warning style', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<PrivacyPage />);

    const notice = await screen.findByText(/TODO: client legal review/);
    const blockquote = notice.closest('blockquote');
    expect(blockquote).toBeInTheDocument();
    // BUG-080: text-brand-warning on bg-brand-gold-100 measures 4.51:1 — AA
    // pass with no headroom. text-brand-gold-800 on the same background
    // measures 7.45:1, so that pairing is required here, not the other one.
    expect(blockquote).toHaveClass('bg-brand-gold-100');
    expect(blockquote).toHaveClass('text-brand-gold-800');
    expect(blockquote).not.toHaveClass('text-brand-warning');
  });

  it('shows the last-updated date', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<PrivacyPage />);

    // 2026-10-09T00:00:00.000Z is 2026-10-09 08:00 in Asia/Manila (UTC+8) —
    // still October 9 there, so the displayed date must not shift to the 8th.
    expect(await screen.findByText(/Last updated October 9, 2026/)).toBeInTheDocument();
  });

  it('sets a single h1 per page — the page title, not anything from the markdown', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<PrivacyPage />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Privacy Notice' }),
    ).toBeInTheDocument();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Privacy Policy');
  });
});

describe('TermsPage', () => {
  it('renders the terms markdown from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<TermsPage />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Terms of Service' }),
    ).toBeInTheDocument();
  });

  it('shows the last-updated date', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<TermsPage />);

    expect(await screen.findByText(/Last updated October 9, 2026/)).toBeInTheDocument();
  });

  it('sets a single h1 per page', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<TermsPage />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Terms of Service' }),
    ).toBeInTheDocument();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Terms of Service');
  });
});

describe('SiteFooter — legal links', () => {
  it('links to both the privacy and terms pages from the footer, beside the copyright', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<SiteFooter />);

    const legalNav = screen.getByRole('navigation', { name: 'Legal' });
    const privacyLink = within(legalNav).getByRole('link', { name: 'Privacy Policy' });
    const termsLink = within(legalNav).getByRole('link', { name: 'Terms of Service' });
    expect(privacyLink).toHaveAttribute('href', '/privacy');
    expect(termsLink).toHaveAttribute('href', '/terms');

    // The existing WhatsApp/Viber chat pills must survive this change untouched.
    expect(await screen.findByRole('link', { name: 'Chat on WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /chat on viber/i })).toBeInTheDocument();
  });
});
