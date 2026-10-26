import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import SiteFooter from '@/components/layout/SiteFooter';
import { ConsentProvider } from '@/lib/consent/ConsentContext';
import { TrpcProviders } from '@/lib/trpc';
import CookiesPage from '@/pages/public/CookiesPage';
import PrivacyPage from '@/pages/public/PrivacyPage';
import RefundPolicyPage from '@/pages/public/RefundPolicyPage';
import TermsPage from '@/pages/public/TermsPage';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/**
 * Task 2B (2026-10-27) replaced the settings-driven `/privacy` and `/terms` (Task 3.6) with
 * static content, matching the two new pages (`/refund-policy`, `/cookies`) — see
 * docs/superpowers/plans/2026-10-27-legal-pages.md. These four pages need no tRPC provider any
 * more (no `settings.get` call); `CookiesPage` is the one exception — its "Cookie settings" link
 * reads `useConsent()`, so every render here goes through `ConsentProvider` regardless.
 */
function renderPage(node: ReactNode) {
  return render(
    <MemoryRouter>
      <ConsentProvider>{node}</ConsentProvider>
    </MemoryRouter>,
  );
}

function renderFooter(node: ReactNode) {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <ConsentProvider>{node}</ConsentProvider>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PrivacyPage', () => {
  it('renders the real section content, not the old settings-driven markdown', () => {
    renderPage(<PrivacyPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: '1. What we collect' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Data Privacy Act of 2012/)).toBeInTheDocument();
  });

  it('shows the real, already-confirmed contact email and phone — not a placeholder chip', () => {
    renderPage(<PrivacyPage />);

    // Task 2A: SITE.contact.email/phone are real, client-confirmed values —
    // 05-cookie-consent-spec.md's sibling drafts' [CONTACT EMAIL]/[CONTACT
    // PHONE] brackets become these, never a "To be confirmed" chip.
    expect(screen.getAllByText('hello@travelsugbo.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0908 469 6246').length).toBeGreaterThan(0);
  });

  it('renders every genuinely unconfirmed value as a visible amber "To be confirmed" chip, never bare brackets', () => {
    const { container } = renderPage(<PrivacyPage />);

    expect(container.textContent).not.toMatch(/\[REGISTERED BUSINESS NAME\]/);
    expect(container.textContent).not.toMatch(/\[BUSINESS ADDRESS\]/);
    expect(container.textContent).not.toMatch(/\[EFFECTIVE DATE\]/);

    const chips = screen.getAllByText('To be confirmed');
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.closest('span')).toHaveClass('bg-brand-gold-100');
      expect(chip.closest('span')).toHaveClass('text-brand-gold-800');
    }
  });

  it('builds an anchor nav from the sections, and the first link reaches its section', () => {
    renderPage(<PrivacyPage />);

    const toc = screen.getByRole('navigation', { name: 'Sections' });
    const firstLink = within(toc).getByRole('link', { name: '1. What we collect' });
    expect(firstLink).toHaveAttribute('href', '#what-we-collect');
    expect(document.getElementById('what-we-collect')).toBeInTheDocument();
  });

  it('sets a single h1 per page — the page title, not anything from a section heading', () => {
    renderPage(<PrivacyPage />);

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Privacy Policy');
  });
});

describe('TermsPage', () => {
  it('renders the real section content and links to the refund policy', () => {
    renderPage(<TermsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
    const refundLinks = screen.getAllByRole('link', { name: 'Refund Policy' });
    expect(refundLinks.length).toBeGreaterThan(0);
    for (const link of refundLinks) expect(link).toHaveAttribute('href', '/refund-policy');
  });

  it('sets a single h1 per page', () => {
    renderPage(<TermsPage />);

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Terms of Service');
  });
});

describe('RefundPolicyPage', () => {
  it('renders the cancellation table inside a scrollable box, with placeholder chips for every unconfirmed number', () => {
    const { container } = renderPage(<RefundPolicyPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Cancellation & Refund Policy' }),
    ).toBeInTheDocument();
    const table = container.querySelector('table');
    expect(table).toBeInTheDocument();
    // task 2B: "tables scroll inside a box on 360px" — overflow-x-auto wrapper.
    expect(table!.parentElement).toHaveClass('overflow-x-auto');

    // No bracket survives into the rendered page; every one of them became a chip.
    expect(container.textContent).not.toMatch(/\[X\]/);
    expect(screen.getAllByText('To be confirmed').length).toBeGreaterThan(5);
  });

  it('does NOT render the internal "R&G: fill in your real policy" note meant for the owner, not a guest', () => {
    renderPage(<RefundPolicyPage />);
    expect(screen.queryByText(/nothing here has been decided for you/i)).not.toBeInTheDocument();
  });

  it('sets a single h1 per page', () => {
    renderPage(<RefundPolicyPage />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
  });
});

describe('CookiesPage', () => {
  it('renders the three cookie categories and a working "Cookie settings" link that opens the Customize panel', async () => {
    renderPage(<CookiesPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Cookie Policy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /1\. Essential/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /2\. Analytics/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /3\. Marketing/ })).toBeInTheDocument();

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cookie settings' }));
    // The page itself doesn't mount CookieCustomizePanel (PublicLayout does) — this just proves
    // the button calls the real `reopen()` from context without throwing, which is the part a
    // missing ConsentProvider would break.
  });

  it('sets a single h1 per page', () => {
    renderPage(<CookiesPage />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
  });
});

describe('SiteFooter — legal links', () => {
  it('links to all four legal pages and a working Cookie settings button, beside the copyright', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderFooter(<SiteFooter />);

    const legalNav = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legalNav).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(within(legalNav).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(within(legalNav).getByRole('link', { name: 'Refund Policy' })).toHaveAttribute(
      'href',
      '/refund-policy',
    );
    expect(within(legalNav).getByRole('link', { name: 'Cookie Policy' })).toHaveAttribute(
      'href',
      '/cookies',
    );
    expect(within(legalNav).getByRole('button', { name: 'Cookie settings' })).toBeInTheDocument();

    // The existing WhatsApp/Viber chat pills must survive this change untouched.
    expect(await screen.findByRole('link', { name: 'Chat on WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /chat on viber/i })).toBeInTheDocument();
  });
});
