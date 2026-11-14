/**
 * Task 7 (1D): "Popular transfers" home section. Server-decided membership
 * and server-computed price — this component renders what it is given and
 * must not recompute any figure (CLAUDE.md: the server computes all money).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PopularTransfers from '@/components/home/PopularTransfers';
import { friendlyDuration } from '@/lib/duration-words';
import { TrpcProviders } from '@/lib/trpc';
import { TRANSFER_HOME_CARDS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

function renderSection() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <PopularTransfers />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PopularTransfers', () => {
  it('renders nothing when the featured list is empty', async () => {
    mockTrpc({ 'transferRoutes.featured': [] });
    const { container } = renderSection();

    // Finding I3 (final review): the section must be absent on the VERY
    // FIRST render too, while the query is still `isPending` — not only
    // once it later settles to an empty array. The old guard
    // (`query.data && query.data.length === 0`) only caught the settled
    // case, so every default-state page load flashed the heading plus
    // three skeleton cards before this component disappeared. Checked
    // synchronously, before any `await`, so a regression back to the old
    // guard fails this line immediately rather than only via the `waitFor`
    // below (which a stale "it starts out `isPending`" expectation could
    // otherwise rationalize as correct).
    expect(container.querySelector('#popular-transfers')).toBeNull();

    // Then confirm the section still never mounts once the query settles.
    await waitFor(() => expect(container.querySelector('#popular-transfers')).toBeNull());
    expect(screen.queryByText(/popular transfers/i)).not.toBeInTheDocument();
  });

  it('renders a card per featured route with badge, duration, description, vehicle chips and price', async () => {
    mockTrpc({ 'transferRoutes.featured': TRANSFER_HOME_CARDS_FIXTURE });
    renderSection();

    // Finding I3 (final review): with the fixed guard this component
    // renders nothing at all until `transferRoutes.featured` resolves, so
    // the heading itself only appears once real data has replaced the
    // (now-dead) loading skeleton — `findByRole` already awaits that.
    const heading = await screen.findByRole('heading', {
      name: /private van transfers across cebu/i,
    });
    const container = heading.closest('section') as HTMLElement;
    // Wait for real card content (the badge, present only once real data
    // has mounted) before counting cards.
    await within(container).findByText('Most booked');

    const cards = within(container).getAllByRole('listitem');
    expect(cards).toHaveLength(TRANSFER_HOME_CARDS_FIXTURE.length);

    // Card 1: has a badge, a short description, two vehicle chips, and the
    // server-given van price — rendered VERBATIM, never recomputed.
    const first = cards[0] as HTMLElement;
    expect(within(first).getByText('Most booked')).toBeInTheDocument();
    expect(
      within(first).getByText(/airport pickup straight to the whale sharks/i),
    ).toBeInTheDocument();
    expect(within(first).getByText('Van')).toBeInTheDocument();
    expect(within(first).getByText('SUV')).toBeInTheDocument();
    expect(within(first).getByText(/₱2,500/)).toBeInTheDocument();
    expect(within(first).getByText(/per van/i)).toBeInTheDocument();

    // Finding I1 (final review): the duration badge renders
    // `friendlyDuration()`'s own string ALONE — no literal "About " prefix
    // duplicating the "about" the helper already prepends. Exact string
    // match (not a substring regex): a regex like `/about 3 hr/i` would
    // still match the broken doubled text "About about 3 hr", which is
    // exactly the bug this assertion exists to catch. The explicit
    // negative below pins that the doubled form specifically is gone.
    expect(
      within(first).getByText(
        friendlyDuration(TRANSFER_HOME_CARDS_FIXTURE[0]!.estimatedDurationMinutes),
      ),
    ).toBeInTheDocument();
    expect(within(first).queryByText(/about about/i)).not.toBeInTheDocument();

    // Card 2: no badge, no short description, one vehicle chip, and the
    // server's own fallback price (SUV, since no van is offered on it).
    const second = cards[1] as HTMLElement;
    expect(within(second).queryByText('Most booked')).not.toBeInTheDocument();
    expect(within(second).getByText('SUV')).toBeInTheDocument();
    expect(within(second).queryByText('Van')).not.toBeInTheDocument();
    expect(within(second).getByText(/₱3,200/)).toBeInTheDocument();
    // Finding I2 (final review): card 2's cheapest offer falls back to SUV
    // (no van is offered on this route), so the price tail must say "per
    // suv" — never the hardcoded "per van" the old code always rendered,
    // which would have misrepresented this exact card.
    expect(within(second).getByText(/per suv/i)).toBeInTheDocument();
    expect(within(second).queryByText(/per van/i)).not.toBeInTheDocument();
  });

  it('the Book button links to /transfer with productType, routeId and direction preselected', async () => {
    mockTrpc({ 'transferRoutes.featured': TRANSFER_HOME_CARDS_FIXTURE });
    renderSection();

    const links = await screen.findAllByRole('link', { name: /book this transfer/i });
    expect(links).toHaveLength(TRANSFER_HOME_CARDS_FIXTURE.length);
    expect(links[0]).toHaveAttribute(
      'href',
      `/transfer?productType=transfer_one_way&routeId=${TRANSFER_HOME_CARDS_FIXTURE[0]!.id}&direction=forward`,
    );
    expect(links[1]).toHaveAttribute(
      'href',
      `/transfer?productType=transfer_one_way&routeId=${TRANSFER_HOME_CARDS_FIXTURE[1]!.id}&direction=forward`,
    );
  });

  /**
   * Task 7 Step 6's confirmed URL shape (see ContactSection.tsx's own note
   * and this task's report): the query string must sit BEFORE the `#contact`
   * hash, or neither the preselect nor the scroll-to-contact behaviour
   * fires. Pinned here so a future edit cannot silently revert the link to
   * the broken `/#contact?type=...` form.
   */
  it('links "request a custom trip" to /?type=transfer_custom#contact, not /#contact?type=...', async () => {
    mockTrpc({ 'transferRoutes.featured': TRANSFER_HOME_CARDS_FIXTURE });
    renderSection();

    const link = await screen.findByRole('link', { name: /request a custom trip/i });
    expect(link).toHaveAttribute('href', '/?type=transfer_custom#contact');
  });

  /**
   * Task 1B: a route whose `toPlace` has no linked destination photo (or
   * whose linked destination has no `imagePath`) used to render a bare
   * `null` here, leaving only the plain `bg-brand-blue-50` fill showing — a
   * blank box. It must now show a brand-gradient fallback tile naming the
   * destination and its place-type icon, and never attempt a real `<img>`.
   */
  it('shows a brand-gradient fallback tile, not a blank box, when a card has no imagePath', async () => {
    mockTrpc({ 'transferRoutes.featured': TRANSFER_HOME_CARDS_FIXTURE });
    renderSection();

    const heading = await screen.findByRole('heading', {
      name: /private van transfers across cebu/i,
    });
    const container = heading.closest('section') as HTMLElement;
    await within(container).findByText('Most booked');

    const cards = within(container).getAllByRole('listitem');
    // Card 2 (Moalboal) is the fixture entry with `imagePath: null`.
    const second = cards[1] as HTMLElement;

    expect(within(second).getByText('Moalboal')).toBeInTheDocument();
    // Moalboal's `toPlace.placeType` is 'destination' -> the MapPin icon.
    expect(second.querySelector('svg.lucide-map-pin')).not.toBeNull();
    expect(second.querySelector('img')).toBeNull();
  });

  it('renders "Price unavailable" rather than ₱0 when a card has no sellable vehicle at all', async () => {
    mockTrpc({
      'transferRoutes.featured': [
        { ...TRANSFER_HOME_CARDS_FIXTURE[0]!, offeredVehicles: [], cheapestOneWay: null },
      ],
    });
    renderSection();

    expect(await screen.findByText(/price unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/₱0/)).not.toBeInTheDocument();
  });
});
