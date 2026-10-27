/**
 * The public reviews block on a tour detail page (Week 7 plan, Task 11;
 * BUILD_SPEC §4 "Reviews"). `server/src/__tests__/reviews-moderation.test.ts`
 * and the public reviews router prove the SERVER's contract — this file
 * proves the SCREEN: the breakdown renders real counts regardless of the
 * active filter, a star filter re-queries and narrows the list, "most
 * helpful" reorders it, the verified badge appears only on verified rows,
 * and a helpful vote is optimistic, never double-counted, and disables its
 * own control.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { TourReviewItem, TourReviewsResult } from '@rg/shared';
import ReviewsBlock from '@/components/tour/ReviewsBlock';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

const BREAKDOWN = [
  { stars: 5, count: 3 },
  { stars: 4, count: 2 },
  { stars: 3, count: 1 },
  { stars: 2, count: 0 },
  { stars: 1, count: 0 },
];

const SUBSCORES = { guide: 4.5, value: 4.1, punctuality: 4.8, safety: 5 };

function item(overrides: Partial<TourReviewItem>): TourReviewItem {
  return {
    id: 1,
    name: 'Maria Santos',
    rating: 5,
    guide: null,
    value: null,
    punctuality: null,
    safety: null,
    body: 'Pedro was early and the van was spotless.',
    verified: true,
    reply: null,
    repliedAt: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    helpfulCount: 2,
    ...overrides,
  };
}

const ALL_ITEMS: TourReviewItem[] = [
  item({ id: 1, name: 'Maria Santos', rating: 5, verified: true, helpfulCount: 2 }),
  item({
    id: 2,
    name: 'John Dela Cruz',
    rating: 4,
    verified: false,
    body: 'Good trip, a little rushed at the falls.',
    helpfulCount: 9,
  }),
  item({
    id: 3,
    name: 'Ana Reyes',
    rating: 4,
    verified: true,
    body: 'Lovely sunrise swim, friendly guide.',
    helpfulCount: 1,
    reply: 'Thank you for the kind words, Ana!',
    repliedAt: '2026-06-20T00:00:00.000Z',
  }),
];

function baseResult(overrides: Partial<TourReviewsResult> = {}): TourReviewsResult {
  return {
    tourId: 6,
    rating: { average: 4.3, count: 6 },
    breakdown: BREAKDOWN,
    subscores: SUBSCORES,
    total: 6,
    matching: 6,
    items: ALL_ITEMS,
    ...overrides,
  };
}

/**
 * The real server's contract: `breakdown`, `subscores`, `total` and `rating`
 * never change with `starFilter` — only `items` and `matching` do. This mock
 * mirrors that so a test of the filter narrowing the list cannot pass by
 * accident from a mock that rewrites the summary too.
 */
function forTourHandler(byFilterAndSort: {
  default: TourReviewsResult;
  byStarFilter?: Record<number, TourReviewItem[]>;
  bySort?: Record<string, TourReviewItem[]>;
}) {
  return (input: unknown) => {
    const { starFilter, sort } = input as { starFilter?: number; sort?: string };
    if (starFilter !== undefined && byFilterAndSort.byStarFilter?.[starFilter]) {
      const items = byFilterAndSort.byStarFilter[starFilter]!;
      return { ...byFilterAndSort.default, items, matching: items.length };
    }
    if (sort && byFilterAndSort.bySort?.[sort]) {
      return { ...byFilterAndSort.default, items: byFilterAndSort.bySort[sort]! };
    }
    return byFilterAndSort.default;
  };
}

function renderBlock(handler: unknown) {
  mockTrpc({ 'reviews.forTour': handler });
  return render(
    <TrpcProviders>
      <ReviewsBlock tourSlug="oslob-whale-sharks" />
    </TrpcProviders>,
  );
}

describe('ReviewsBlock — breakdown', () => {
  it('renders five rows, 5★ down to 1★, with the real counts', async () => {
    renderBlock(() => baseResult());

    const breakdown = await screen.findByRole('list', { name: /rating breakdown/i });
    const rows = within(breakdown).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('5★');
    expect(rows[0]).toHaveTextContent('3');
    expect(rows[1]).toHaveTextContent('4★');
    expect(rows[1]).toHaveTextContent('2');
    expect(rows[4]).toHaveTextContent('1★');
    expect(rows[4]).toHaveTextContent('0');
  });

  it('shows the four sub-scores with a real number beside the stars', async () => {
    renderBlock(() => baseResult());
    await screen.findByText('Maria Santos');

    const subscores = screen.getByTestId('tour-subscores');
    expect(within(subscores).getByText('Driver and guide')).toBeInTheDocument();
    expect(within(subscores).getByText('Value for money')).toBeInTheDocument();
    expect(within(subscores).getByText('On time')).toBeInTheDocument();
    expect(within(subscores).getByText('Safety')).toBeInTheDocument();
    // StarRating prints the number itself — not stars alone (BUG-063).
    expect(within(subscores).getByText('4.5')).toBeInTheDocument();
    expect(within(subscores).getByText('5.0')).toBeInTheDocument();
  });
});

describe('ReviewsBlock — star filter', () => {
  it('re-queries with the chosen star and narrows the list to what the server sends back', async () => {
    const calls: unknown[] = [];
    renderBlock((input: unknown) => {
      calls.push(input);
      return forTourHandler({
        default: baseResult(),
        byStarFilter: { 4: [ALL_ITEMS[1]!, ALL_ITEMS[2]!] },
      })(input);
    });
    await screen.findByText('Maria Santos');

    await user.click(screen.getByRole('button', { name: /^4★ \(2\)$/ }));

    await waitFor(() => expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument());
    expect(screen.getByText('John Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
    expect(calls.some((c) => (c as { starFilter?: number }).starFilter === 4)).toBe(true);

    // The breakdown itself is untouched by the filter — still every star row.
    const breakdown = screen.getByRole('list', { name: /rating breakdown/i });
    expect(within(breakdown).getAllByRole('listitem')).toHaveLength(5);
  });

  it('clears the filter back to "All" and shows the whole list again', async () => {
    renderBlock(
      forTourHandler({
        default: baseResult(),
        byStarFilter: { 4: [ALL_ITEMS[1]!, ALL_ITEMS[2]!] },
      }),
    );
    await screen.findByText('Maria Santos');

    await user.click(screen.getByRole('button', { name: /^4★ \(2\)$/ }));
    await waitFor(() => expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^All \(6\)$/ }));
    expect(await screen.findByText('Maria Santos')).toBeInTheDocument();
  });
});

describe('ReviewsBlock — sort', () => {
  it('reorders the list when "Most helpful" is chosen', async () => {
    renderBlock(
      forTourHandler({
        default: baseResult(),
        bySort: { helpful: [ALL_ITEMS[1]!, ALL_ITEMS[2]!, ALL_ITEMS[0]!] },
      }),
    );
    await screen.findByText('Maria Santos');

    function orderedNames(): string[] {
      const list = screen.getByRole('list', { name: 'Reviews' });
      return within(list)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('p.font-semibold')?.textContent ?? '');
    }

    // Newest (the default): Maria is first.
    expect(orderedNames()[0]).toBe('Maria Santos');

    await user.selectOptions(screen.getByLabelText(/sort by/i), 'helpful');

    await waitFor(() => expect(orderedNames()[0]).toBe('John Dela Cruz'));
  });
});

describe('ReviewsBlock — verified badge', () => {
  it('shows "Verified booking" only on rows that are actually verified', async () => {
    renderBlock(() => baseResult());
    await screen.findByText('Maria Santos');

    const mariaCard = screen.getByText('Maria Santos').closest('li') as HTMLElement;
    const johnCard = screen.getByText('John Dela Cruz').closest('li') as HTMLElement;
    const anaCard = screen.getByText('Ana Reyes').closest('li') as HTMLElement;

    expect(within(mariaCard).getByText('Verified booking')).toBeInTheDocument();
    expect(within(johnCard).queryByText('Verified booking')).not.toBeInTheDocument();
    expect(within(anaCard).getByText('Verified booking')).toBeInTheDocument();
  });

  it('shows the business reply under the review it answers', async () => {
    renderBlock(() => baseResult());
    await screen.findByText('Maria Santos');

    const anaCard = screen.getByText('Ana Reyes').closest('li') as HTMLElement;
    expect(within(anaCard).getByText(/thank you for the kind words/i)).toBeInTheDocument();
    expect(within(anaCard).getByText(/response from/i)).toBeInTheDocument();
  });
});

describe('ReviewsBlock — helpful votes', () => {
  it('bumps the count once on a counted vote, then disables the control so a second click cannot double-count', async () => {
    let calls = 0;
    mockTrpc({
      'reviews.forTour': () => baseResult(),
      'reviews.voteHelpful': () => {
        calls += 1;
        return { ok: true, counted: true };
      },
    });
    render(
      <TrpcProviders>
        <ReviewsBlock tourSlug="oslob-whale-sharks" />
      </TrpcProviders>,
    );
    await screen.findByText('Maria Santos');

    const mariaCard = screen.getByText('Maria Santos').closest('li') as HTMLElement;
    const button = within(mariaCard).getByRole('button', { name: /helpful \(2\)/i });

    await user.click(button);
    const votedButton = await within(mariaCard).findByRole('button', {
      name: /marked helpful \(3\)/i,
    });
    expect(votedButton).toBeDisabled();

    // A second click on a disabled button is a no-op — the real assertion
    // that voting twice changes nothing and the control stays disabled.
    await user.click(votedButton);
    expect(within(mariaCard).getByRole('button', { name: /marked helpful \(3\)/i })).toBeDisabled();
    expect(calls).toBe(1);
  });

  it('still disables the control when the server says this browser already voted (counted: false)', async () => {
    mockTrpc({
      'reviews.forTour': () => baseResult(),
      'reviews.voteHelpful': () => ({ ok: true, counted: false }),
    });
    render(
      <TrpcProviders>
        <ReviewsBlock tourSlug="oslob-whale-sharks" />
      </TrpcProviders>,
    );
    await screen.findByText('Maria Santos');

    const mariaCard = screen.getByText('Maria Santos').closest('li') as HTMLElement;
    await user.click(within(mariaCard).getByRole('button', { name: /helpful \(2\)/i }));

    // Not counted, so the number does NOT change — but the click still
    // registers as "already voted" for this browser, and the shrug is
    // not an error banner.
    const votedButton = await within(mariaCard).findByRole('button', {
      name: /marked helpful \(2\)/i,
    });
    expect(votedButton).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReviewsBlock — no reviews', () => {
  it('says there are no reviews yet rather than showing an empty breakdown', async () => {
    renderBlock(() => ({
      tourId: 6,
      rating: null,
      breakdown: [
        { stars: 5, count: 0 },
        { stars: 4, count: 0 },
        { stars: 3, count: 0 },
        { stars: 2, count: 0 },
        { stars: 1, count: 0 },
      ],
      subscores: { guide: null, value: null, punctuality: null, safety: null },
      total: 0,
      matching: 0,
      items: [],
    }));

    expect(await screen.findByText(/no reviews yet/i)).toBeInTheDocument();
  });
});
