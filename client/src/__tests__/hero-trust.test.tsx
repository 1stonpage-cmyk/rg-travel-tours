import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import HeroSection from '@/components/home/HeroSection';
import TrustBar from '@/components/home/TrustBar';
import { TrpcProviders } from '@/lib/trpc';
import type { Destination } from '../../../server/src/routers/public/destinations';
import { DESTINATIONS_FIXTURE, SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderHero() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <HeroSection />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function renderTrustBar() {
  return render(
    <TrpcProviders>
      <TrustBar />
    </TrpcProviders>,
  );
}

/** The hidden native `<select>` Radix always renders (mirrors every SelectItem as an <option>, aria-hidden, regardless of open state) — lets us assert on the options without opening the popover, which needs pointer-capture APIs jsdom doesn't implement. */
function nativeOptionTexts(container: HTMLElement): string[] {
  const native = container.querySelector('select[aria-hidden="true"]');
  if (!native) return [];
  return Array.from(native.querySelectorAll('option')).map((o) => o.textContent ?? '');
}

describe('HeroSection — settings-driven', () => {
  it('renders the headline, subtitle and eyebrow from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE, 'destinations.list': DESTINATIONS_FIXTURE });
    renderHero();

    expect(
      await screen.findByRole('heading', { level: 1, name: SETTINGS_FIXTURE.hero.headline }),
    ).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_FIXTURE.hero.eyebrow)).toBeInTheDocument();
    expect(screen.getByText(SETTINGS_FIXTURE.hero.subtitle)).toBeInTheDocument();
  });

  it('fills the destination select from the API, not a constant', async () => {
    const apiOnlyDestinations: Destination[] = [
      { ...DESTINATIONS_FIXTURE[0]!, name: 'Zzyzx Cove (API-only)' },
      { ...DESTINATIONS_FIXTURE[1]!, name: 'Wherewhichever Point (API-only)' },
    ];
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE, 'destinations.list': apiOnlyDestinations });
    const { container } = renderHero();

    // Wait for the destinations query to resolve before inspecting options.
    await screen.findByRole('heading', { level: 1 });
    const options = nativeOptionTexts(container);
    expect(options).toContain('Zzyzx Cove (API-only)');
    expect(options).toContain('Wherewhichever Point (API-only)');
    // The old hardcoded placeholder list never had either name.
    expect(options).not.toContain('Oslob');
  });

  it('omits the review-count clause when ratingCount is null, but keeps the rating figure', async () => {
    expect(SETTINGS_FIXTURE.trust.ratingCount).toBeNull();
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE, 'destinations.list': DESTINATIONS_FIXTURE });
    const { container } = renderHero();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('4.9★')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/from\s+\d+\s+guest reviews/i);
    expect(container.textContent).not.toMatch(/from\s+guest reviews/i);
    expect(container.textContent).not.toMatch(/\bnull\b/i);
  });

  it('omits the whole rating item when ratingAverage is null', async () => {
    const settings = {
      ...SETTINGS_FIXTURE,
      trust: { ...SETTINGS_FIXTURE.trust, ratingAverage: null },
    };
    mockTrpc({ 'settings.get': settings, 'destinations.list': DESTINATIONS_FIXTURE });
    const { container } = renderHero();

    await screen.findByRole('heading', { level: 1 });
    expect(container.textContent).not.toMatch(/★/);
    expect(container.textContent).not.toMatch(/\bnull\b/i);
    // The other trust-line items must still render.
    expect(screen.getByText(/guests served/i)).toBeInTheDocument();
  });

  it('omits the guests-served item when guestsServed is null', async () => {
    const settings = {
      ...SETTINGS_FIXTURE,
      trust: { ...SETTINGS_FIXTURE.trust, guestsServed: null },
    };
    mockTrpc({ 'settings.get': settings, 'destinations.list': DESTINATIONS_FIXTURE });
    const { container } = renderHero();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/guests served/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bnull\b/i);
    // The other trust-line items must still render.
    expect(screen.getByText('4.9★')).toBeInTheDocument();
    expect(screen.getByText(/dot accredited/i)).toBeInTheDocument();
  });

  it('keeps the hero readable while settings are still loading: photo and search form render immediately', () => {
    mockTrpc({
      'settings.get': () => new Promise(() => {}),
      'destinations.list': DESTINATIONS_FIXTURE,
    });
    renderHero();

    // The photo renders unconditionally — no query dependency.
    const img = screen.getByAltText(/fort san pedro/i);
    expect(img).toHaveAttribute('fetchPriority', 'high');
    expect(img).toHaveAttribute('src', '/hero/hero-cebu-1920.jpg');

    // The search form renders unconditionally, fully interactive.
    const form = screen.getByRole('form', { name: /search tours/i });
    expect(within(form).getByLabelText(/destination/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/guests/i)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /search tours/i })).toBeInTheDocument();

    // The copy, which DOES depend on the query, has not rendered yet — no
    // blocking skeleton for the whole section, but no fabricated text either.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

describe('TrustBar — settings-driven', () => {
  it('renders all four trust items from settings', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderTrustBar();

    expect(await screen.findByText(/dot accredited/i)).toBeInTheDocument();
    expect(screen.getByText(/15,000\+ guests served/)).toBeInTheDocument();
    expect(screen.getByText(/30% deposit to reserve/)).toBeInTheDocument();
    expect(screen.getByText(/whatsapp/i)).toBeInTheDocument();
  });

  it('omits the guests-served item when guestsServed is null', async () => {
    const settings = {
      ...SETTINGS_FIXTURE,
      trust: { ...SETTINGS_FIXTURE.trust, guestsServed: null },
    };
    mockTrpc({ 'settings.get': settings });
    renderTrustBar();

    expect(await screen.findByText(/dot accredited/i)).toBeInTheDocument();
    expect(screen.queryByText(/guests served/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bnull\b/i);
  });
});
