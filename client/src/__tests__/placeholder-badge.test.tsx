import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PlaceholderBadge from '@/components/layout/PlaceholderBadge';
import PublicLayout from '@/components/layout/PublicLayout';
import { trpc, TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/**
 * A positive signal that `settings.get` has actually RESOLVED, mounted as a
 * sibling of the component under test. It reads the same query key, so
 * TanStack Query hands both components the one cache entry — when this
 * marker is in the DOM, the data has arrived.
 *
 * Needed because asserting absence alone cannot distinguish "hidden because
 * the flag is false" from "not rendered yet". The earlier version of the
 * false-flag test below used `waitFor(() => expect(...).not.toBeInTheDocument())`,
 * which passes on `waitFor`'s FIRST synchronous invocation — while the query
 * is still pending and the badge is legitimately absent — and returns
 * immediately, so it never observed the resolved state at all.
 */
function SettingsResolved() {
  const { data } = trpc.settings.get.useQuery();
  return data ? <p>settings resolved</p> : null;
}

/**
 * PlaceholderBadge now reads settings.contentUnverified (task 3.7) instead
 * of the deleted USING_PLACEHOLDER_DATA constant, and no longer falls back
 * to import.meta.env.DEV — the database flag is the single source of truth.
 */
function renderBadge() {
  return render(
    <TrpcProviders>
      <PlaceholderBadge />
      <SettingsResolved />
    </TrpcProviders>,
  );
}

describe('PlaceholderBadge', () => {
  it('shows the banner while settings.contentUnverified is true', async () => {
    mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, contentUnverified: true } });
    renderBadge();
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('hides the banner once settings.contentUnverified is false', async () => {
    mockTrpc({ 'settings.get': { ...SETTINGS_FIXTURE, contentUnverified: false } });
    renderBadge();

    // Wait for the query to RESOLVE first (see SettingsResolved above), then
    // assert absence — so this proves the banner stays hidden with the flag
    // false, not merely that it had not rendered yet.
    expect(await screen.findByText('settings resolved')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('hides the banner while settings are still loading', () => {
    // A handler that never resolves keeps the query in isPending forever —
    // the assertion below is synchronous, so it catches exactly the instant
    // a flashing banner would appear.
    mockTrpc({ 'settings.get': () => new Promise(() => {}) });
    renderBadge();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the banner out of the way of the announcement bar — both sit in normal flow above the header, badge first', async () => {
    mockTrpc({
      'settings.get': {
        ...SETTINGS_FIXTURE,
        contentUnverified: true,
        announcement: {
          message: 'Holiday schedule in effect this week',
          href: null,
          style: 'info',
        },
      },
    });

    const { container } = render(
      <TrpcProviders>
        <MemoryRouter>
          <PublicLayout />
        </MemoryRouter>
      </TrpcProviders>,
    );

    const badge = await screen.findByText(/PLACEHOLDER DATA/i);
    const announcement = await screen.findByText('Holiday schedule in effect this week');
    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();

    // Neither bar is removed from normal document flow (no fixed/sticky
    // positioning) — only the header itself is sticky.
    expect(badge.closest('[class]')?.className ?? '').not.toMatch(/\b(fixed|sticky)\b/);
    expect(announcement.closest('[role="status"]')?.className ?? '').not.toMatch(
      /\b(fixed|sticky)\b/,
    );

    // DOM order: badge, then announcement bar, then header.
    const badgePrecedesAnnouncement = Boolean(
      badge.compareDocumentPosition(announcement) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const announcementPrecedesHeader = Boolean(
      announcement.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(badgePrecedesAnnouncement).toBe(true);
    expect(announcementPrecedesHeader).toBe(true);
  });
});
