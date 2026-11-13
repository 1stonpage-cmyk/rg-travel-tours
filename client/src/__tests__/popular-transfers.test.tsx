/**
 * Task 7 (1D): "Popular transfers" home section. Server-decided membership
 * and server-computed price — this component renders what it is given and
 * must not recompute any figure (CLAUDE.md: the server computes all money).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PopularTransfers from '@/components/home/PopularTransfers';
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

    // Waits for the query to actually settle (it starts out `isPending`,
    // which renders the skeleton, not null), then asserts the section never
    // mounts at all — not merely that it is visually hidden.
    await waitFor(() => expect(container.querySelector('#popular-transfers')).toBeNull());
    expect(screen.queryByText(/popular transfers/i)).not.toBeInTheDocument();
  });

  it('renders a card per featured route with badge, duration, description, vehicle chips and price', async () => {
    mockTrpc({ 'transferRoutes.featured': TRANSFER_HOME_CARDS_FIXTURE });
    renderSection();

    const heading = await screen.findByRole('heading', {
      name: /private van transfers across cebu/i,
    });
    const container = heading.closest('section') as HTMLElement;
    // The heading above renders unconditionally, before the query settles
    // — wait for real card content (the badge, present only once real data
    // has replaced the loading skeleton) before counting cards.
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

    // Card 2: no badge, no short description, one vehicle chip, and the
    // server's own fallback price (SUV, since no van is offered on it).
    const second = cards[1] as HTMLElement;
    expect(within(second).queryByText('Most booked')).not.toBeInTheDocument();
    expect(within(second).getByText('SUV')).toBeInTheDocument();
    expect(within(second).queryByText('Van')).not.toBeInTheDocument();
    expect(within(second).getByText(/₱3,200/)).toBeInTheDocument();
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
