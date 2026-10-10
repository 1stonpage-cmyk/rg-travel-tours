import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import FaqSection from '@/components/home/FaqSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import WhyBookDirect from '@/components/home/WhyBookDirect';
import { TrpcProviders } from '@/lib/trpc';
import type { Destination } from '../../../server/src/routers/public/destinations';
import { DESTINATIONS_FIXTURE, SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderWithTrpc(node: ReactNode) {
  return render(
    <TrpcProviders>
      <MemoryRouter>{node}</MemoryRouter>
    </TrpcProviders>,
  );
}

describe('HowItWorks', () => {
  it('renders how-it-works steps in order from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<HowItWorks />);

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(
      SETTINGS_FIXTURE.howItWorks.map((step) => step.title),
    );
    // The body copy for each step renders too, not just the title.
    for (const step of SETTINGS_FIXTURE.howItWorks) {
      expect(screen.getByText(step.body)).toBeInTheDocument();
    }
  });
});

describe('WhyBookDirect', () => {
  it('renders why-book-direct reasons with their mapped icons', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<WhyBookDirect />);

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(
      SETTINGS_FIXTURE.whyBookDirect.map((reason) => reason.title),
    );

    // Each reason's own icon key renders as the matching lucide icon class
    // (e.g. icon: 'wallet' -> svg.lucide-wallet) — proves the map is keyed
    // by icon, not rendering the same icon for every item.
    for (const reason of SETTINGS_FIXTURE.whyBookDirect) {
      const heading = screen.getByRole('heading', { level: 3, name: reason.title });
      const card = heading.closest('li') as HTMLElement;
      expect(card.querySelector(`svg.lucide-${reason.icon}`)).toBeTruthy();
    }
  });

  it('falls back to a neutral icon for an unknown icon key', async () => {
    const settingsWithUnknownIcon = {
      ...SETTINGS_FIXTURE,
      whyBookDirect: [
        { icon: 'parachute', title: 'Unmapped reason', body: 'Exercises the fallback path.' },
        ...SETTINGS_FIXTURE.whyBookDirect.slice(1),
      ],
    };
    mockTrpc({ 'settings.get': settingsWithUnknownIcon });
    renderWithTrpc(<WhyBookDirect />);

    // The section must not crash or blank out: every title still renders...
    const heading = await screen.findByRole('heading', { level: 3, name: 'Unmapped reason' });
    expect(heading).toBeInTheDocument();
    // ...and the unmapped item falls back to the neutral "tag" icon rather
    // than rendering nothing.
    const card = heading.closest('li') as HTMLElement;
    expect(card.querySelector('svg.lucide-tag')).toBeTruthy();

    // The rest of the (valid) section is unaffected.
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: SETTINGS_FIXTURE.whyBookDirect[1]!.title,
      }),
    ).toBeInTheDocument();
  });
});

describe('MostVisited', () => {
  it('renders most-visited places from the destinations API', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    renderWithTrpc(<MostVisited />);

    for (const destination of DESTINATIONS_FIXTURE) {
      const label = destination.displayName ?? destination.name;
      expect(
        await screen.findByRole('heading', { level: 3, name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });

  it('shows only featured destinations in most-visited', async () => {
    const mixed: Destination[] = [
      ...DESTINATIONS_FIXTURE,
      {
        id: 99,
        name: 'Not Featured',
        slug: 'not-featured',
        displayName: null,
        blurb: 'Should never appear in Most Visited.',
        image: { path: '/placeholders/not-featured.svg', alt: 'Not featured' },
        sortOrder: 6,
        featuredSortOrder: null,
        isFeatured: false,
      },
    ];
    mockTrpc({ 'destinations.list': mixed });
    renderWithTrpc(<MostVisited />);

    await screen.findByRole('heading', { level: 3, name: /Oslob/ });
    expect(screen.queryByText('Not Featured')).not.toBeInTheDocument();
  });

  /**
   * The API's own contract: "Null omits the destination from Most Visited"
   * (server/src/routers/public/destinations.ts). `featured_sort_order` is
   * nullable with nothing tying it to `is_featured`, so a half-configured
   * destination — flagged featured, no order given — must fail closed
   * (omitted) rather than being sorted to the FRONT, which is what the
   * previous `?? 0` fallback did.
   */
  it('omits a featured destination that has no featuredSortOrder', async () => {
    const halfConfigured: Destination[] = [
      {
        id: 98,
        name: 'Half Configured',
        slug: 'half-configured',
        displayName: null,
        blurb: 'Featured but never given a featured sort order.',
        image: { path: '/placeholders/half-configured.svg', alt: 'Half configured' },
        sortOrder: 7,
        featuredSortOrder: null,
        isFeatured: true,
      },
      ...DESTINATIONS_FIXTURE,
    ];
    mockTrpc({ 'destinations.list': halfConfigured });
    renderWithTrpc(<MostVisited />);

    // The properly configured destinations still render…
    await screen.findByRole('heading', { level: 3, name: /Oslob/ });
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(DESTINATIONS_FIXTURE.length);
    // …and the half-configured one appears nowhere, least of all first.
    expect(screen.queryByText('Half Configured')).not.toBeInTheDocument();
  });

  // Pins the exact order: featuredSortOrder (oslob, badian-kawasan,
  // moalboal, mactan, bohol, cebu-city), NOT sortOrder (oslob, mactan,
  // badian-kawasan, moalboal, bohol, cebu-city) — the two orders differ on
  // DESTINATIONS_FIXTURE by construction, so sorting by the wrong column
  // actually fails this.
  it('orders places by featuredSortOrder, not sortOrder', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    renderWithTrpc(<MostVisited />);

    const headings = await screen.findAllByRole('heading', { level: 3 });
    const labels = headings.map((h) => h.textContent?.replace(/\s*$/, '').trim());
    expect(labels).toEqual(['Oslob', 'Kawasan Falls', 'Moalboal', 'Mactan', 'Bohol', 'Cebu City']);
  });

  // Pins the label fallback: only badian-kawasan has a non-null
  // displayName ("Kawasan Falls"); every other destination must render its
  // plain `name`, actually exercising the `displayName ?? name` fallback
  // rather than assuming it.
  it('labels badian-kawasan with its displayName and every other destination with its name', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    renderWithTrpc(<MostVisited />);

    expect(
      await screen.findByRole('heading', { level: 3, name: /Kawasan Falls/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: /^Badian/ })).not.toBeInTheDocument();

    for (const destination of DESTINATIONS_FIXTURE.filter((d) => d.slug !== 'badian-kawasan')) {
      expect(
        await screen.findByRole('heading', { level: 3, name: new RegExp(destination.name) }),
      ).toBeInTheDocument();
    }
  });

  it('gives every destination image real alt text', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE });
    renderWithTrpc(<MostVisited />);

    const images = await screen.findAllByRole('img');
    expect(images.length).toBe(DESTINATIONS_FIXTURE.length);
    for (const img of images) {
      expect(img.getAttribute('alt')?.length ?? 0).toBeGreaterThan(5);
    }
  });
});

describe('FaqSection', () => {
  it('renders FAQ questions and answers from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<FaqSection />);

    for (const faq of SETTINGS_FIXTURE.faqs) {
      expect(await screen.findByRole('button', { name: faq.q })).toBeInTheDocument();
    }

    // Expand the first question and check its answer renders.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: SETTINGS_FIXTURE.faqs[0]!.q }));
    expect(await screen.findByText(SETTINGS_FIXTURE.faqs[0]!.a)).toBeInTheDocument();
  });

  it('keeps the FAQ accordion keyboard operable', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    const user = userEvent.setup();
    renderWithTrpc(<FaqSection />);

    const first = await screen.findByRole('button', { name: SETTINGS_FIXTURE.faqs[0]!.q });
    first.focus();
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-expanded', 'false');

    // Enter toggles the focused trigger open, and its answer becomes visible.
    await user.keyboard('{Enter}');
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(SETTINGS_FIXTURE.faqs[0]!.a)).toBeInTheDocument();

    // ArrowDown moves focus to the next trigger (Radix's built-in roving
    // tabindex), proving this is still a real, keyboard-navigable Accordion
    // and not a div-soup replacement.
    await user.keyboard('{ArrowDown}');
    const second = screen.getByRole('button', { name: SETTINGS_FIXTURE.faqs[1]!.q });
    expect(document.activeElement).toBe(second);

    // Space also toggles.
    await user.keyboard('{ }');
    expect(second).toHaveAttribute('aria-expanded', 'true');
  });
});
