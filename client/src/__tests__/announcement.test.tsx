import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import PublicLayout from '@/components/layout/PublicLayout';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

// jsdom's sessionStorage is shared across every test in this file (vitest
// isolates per file, not per test) — without clearing it, one test's
// dismissal of ANNOUNCEMENT_INFO would silently poison every later test
// that reuses the same message/hash.
afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    // Nothing to clean up if storage itself is unavailable.
  }
});

const ANNOUNCEMENT_INFO = {
  message: 'Holiday schedule in effect this week',
  href: '/tours',
  style: 'info' as const,
};

const ANNOUNCEMENT_WARNING = {
  message: 'Limited slots remain this weekend',
  href: null,
  style: 'warning' as const,
};

function settingsWith(announcement: typeof ANNOUNCEMENT_INFO | typeof ANNOUNCEMENT_WARNING | null) {
  return { ...SETTINGS_FIXTURE, announcement };
}

function renderBar(
  announcement: typeof ANNOUNCEMENT_INFO | typeof ANNOUNCEMENT_WARNING | null = ANNOUNCEMENT_INFO,
) {
  mockTrpc({ 'settings.get': settingsWith(announcement) });
  return render(
    <TrpcProviders>
      <AnnouncementBar />
    </TrpcProviders>,
  );
}

describe('AnnouncementBar', () => {
  it('renders nothing when settings.announcement is null', async () => {
    renderBar(null);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('renders the message above the header', async () => {
    mockTrpc({ 'settings.get': settingsWith(ANNOUNCEMENT_INFO) });
    const { container } = render(
      <TrpcProviders>
        <MemoryRouter>
          <PublicLayout />
        </MemoryRouter>
      </TrpcProviders>,
    );

    const bar = await screen.findByText(ANNOUNCEMENT_INFO.message);
    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();

    // DOM order: the bar's node must precede the header's node. Node.compareDocumentPosition
    // reports DOCUMENT_POSITION_FOLLOWING (4) on `header` when `bar` comes first.
    const barPrecedesHeader = Boolean(
      bar.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(barPrecedesHeader).toBe(true);
  });

  it('dismisses for the session and stays dismissed on remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBar(ANNOUNCEMENT_INFO);

    await screen.findByText(ANNOUNCEMENT_INFO.message);
    await user.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    unmount();

    // Remount: a fresh component instance, same session, same message.
    render(
      <TrpcProviders>
        <AnnouncementBar />
      </TrpcProviders>,
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    // sessionStorage actually holds the key — not just incidentally still
    // hidden because the query hasn't resolved yet.
    const stored = Object.keys(sessionStorage).some(
      (key) => key.startsWith('ts-announcement-dismissed-') && sessionStorage.getItem(key) === '1',
    );
    expect(stored).toBe(true);
  });

  it('a new announcement (different message) reappears even though the previous one was dismissed', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBar(ANNOUNCEMENT_INFO);
    await screen.findByText(ANNOUNCEMENT_INFO.message);
    await user.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
    unmount();

    renderBar(ANNOUNCEMENT_WARNING);
    expect(await screen.findByText(ANNOUNCEMENT_WARNING.message)).toBeInTheDocument();
  });

  it('uses amber (brand-warning on brand-gold-100) for the warning style, never a forbidden hue', async () => {
    renderBar(ANNOUNCEMENT_WARNING);
    const status = await screen.findByRole('status');
    expect(status.className).toMatch(/bg-brand-gold-100/);
    expect(status.className).toMatch(/text-brand-warning/);
    expect(status.className).not.toMatch(/red|rose/i);
  });

  it('uses the info style (blue) when style is "info"', async () => {
    renderBar(ANNOUNCEMENT_INFO);
    const status = await screen.findByRole('status');
    expect(status.className).toMatch(/bg-brand-blue-50/);
    expect(status.className).toMatch(/text-brand-blue-900/);
  });

  it('renders a link only when href is set', async () => {
    renderBar(ANNOUNCEMENT_INFO);
    const status = await screen.findByRole('status');
    expect(within(status).getByRole('link', { name: ANNOUNCEMENT_INFO.message })).toHaveAttribute(
      'href',
      '/tours',
    );
  });

  it('renders plain text, no link, when href is null', async () => {
    renderBar(ANNOUNCEMENT_WARNING);
    const status = await screen.findByRole('status');
    expect(within(status).queryByRole('link')).not.toBeInTheDocument();
    expect(status).toHaveTextContent(ANNOUNCEMENT_WARNING.message);
  });

  it('exposes the dismiss control as a 44px tap target with an accessible name', async () => {
    renderBar(ANNOUNCEMENT_INFO);
    const button = await screen.findByRole('button', { name: 'Dismiss announcement' });
    expect(button.className).toMatch(/\btap-target\b/);
  });

  it('survives sessionStorage throwing on both read and write — the bar still renders and dismiss still works', async () => {
    const user = userEvent.setup();
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked by privacy mode');
    };
    Storage.prototype.setItem = () => {
      throw new Error('blocked by privacy mode');
    };

    try {
      renderBar(ANNOUNCEMENT_INFO);
      expect(await screen.findByText(ANNOUNCEMENT_INFO.message)).toBeInTheDocument();

      // Dismissing must not throw out of the click handler even though the
      // write it attempts fails.
      await user.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });
});
