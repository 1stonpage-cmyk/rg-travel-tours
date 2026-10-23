import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ToursPage from '@/pages/public/ToursPage';
import { TrpcProviders } from '@/lib/trpc';
import type { TourListItem } from '../../../server/src/routers/public/tours';
import { TOURS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/** "oslob-whale-sharks" -> "Oslob whale sharks" — just enough to make each
 * mock tour's title distinct from (and matchable against) its own slug. */
function titleFromSlug(slug: string): string {
  const [first, ...rest] = slug.split('-');
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(' ');
}

let nextTourId = 1000;

/** Builds a tour from the first fixture tour, deriving a distinct title and
 * id from `slug` so two different `tour({ slug })` calls in one test never
 * collide (title, id) the way reusing TOURS_FIXTURE[0] verbatim would. */
function tour(overrides: Partial<TourListItem> = {}): TourListItem {
  const base = TOURS_FIXTURE[0]!;
  const slug = overrides.slug ?? base.slug;
  return { ...base, id: nextTourId++, title: titleFromSlug(slug), slug, ...overrides };
}

function renderToursPage(path = '/tours') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[path]}>
        <ToursPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('ToursPage', () => {
  it('lists every tour the server returns, as cards', async () => {
    mockTrpc({
      'tours.list': () => [tour({ slug: 'oslob-whale-sharks' }), tour({ slug: 'kawasan-falls' })],
    });
    renderToursPage();
    expect(await screen.findByRole('link', { name: /Oslob/i })).toHaveAttribute(
      'href',
      '/tours/oslob-whale-sharks',
    );
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('filters by the destination in the query string, and says which filter is on', async () => {
    mockTrpc({
      'tours.list': (input: unknown) =>
        (input as { destination?: string } | undefined)?.destination === 'oslob'
          ? // Title deliberately does NOT repeat "Oslob" — the destination
            // meta line (`tour.destination.name`) is the ONLY place that
            // word appears, so `findByText` below stays a singular match.
            [tour({ slug: 'oslob-whale-sharks', title: 'Whale Shark Encounter' })]
          : [],
    });
    renderToursPage('/tours?destination=oslob');
    expect(await screen.findByText(/Oslob/)).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('carries the hero search through to the picker instead of dropping it', async () => {
    mockTrpc({ 'tours.list': () => [tour({ slug: 'oslob-whale-sharks' })] });
    renderToursPage('/tours?destination=oslob&date=2026-11-02&guests=4');
    const link = await screen.findByRole('link', { name: /View tour/i });
    expect(link).toHaveAttribute('href', '/tours/oslob-whale-sharks?date=2026-11-02&pax=4');
  });

  it('says so plainly when no tour matches, and offers a way back', async () => {
    mockTrpc({ 'tours.list': () => [] });
    renderToursPage('/tours?destination=nowhere');
    expect(await screen.findByText(/No tours match/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all tours/i })).toHaveAttribute('href', '/tours');
  });
});
