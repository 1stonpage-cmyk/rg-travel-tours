import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import QueryBoundary, { EmptyState } from '@/components/common/QueryBoundary';
import { ReviewCardSkeleton, TourCardSkeleton } from '@/components/common/Skeleton';
import ReviewsSection from '@/components/home/ReviewsSection';
import TourCard from '@/components/common/TourCard';
import { TOURS_FIXTURE } from './helpers/fixtures';

const base = { data: undefined, isPending: false, isError: false } as const;

describe('QueryBoundary', () => {
  it('shows the skeleton while pending', () => {
    render(
      <QueryBoundary
        query={{ ...base, isPending: true }}
        skeleton={<p>skeleton</p>}
        errorTitle="Nope"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('skeleton')).toBeInTheDocument();
  });

  it('shows a friendly error, not a stack trace, and offers a retry', () => {
    render(
      <QueryBoundary
        query={{ ...base, isError: true, refetch: () => {} }}
        skeleton={<p>s</p>}
        errorTitle="Tours could not load"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('Tours could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(/mock failure/i)).not.toBeInTheDocument();
  });

  // The brief's own worked example: the API lets a caller hand the query's
  // *real* error object through. Proves the raw Error truly never reaches
  // the DOM, not just that this suite never happens to pass one in.
  it('never renders the raw Error message or stack, even when the query carries a real Error', () => {
    const error = new Error('ER_ACCESS_DENIED for user guest@example.com at 10.0.0.4');
    render(
      <QueryBoundary
        query={{ ...base, isError: true, error, refetch: () => {} }}
        skeleton={<p>s</p>}
        errorTitle="Tours could not load"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.queryByText(/guest@example\.com/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ER_ACCESS_DENIED/i)).not.toBeInTheDocument();
    expect(screen.queryByText(error.stack ?? '__never__')).not.toBeInTheDocument();
  });

  // Ruling: stale content beats an error box on a marketing page. Under
  // TanStack v5, a background refetch failure after a successful load keeps
  // the last-good `data` while flipping `isError` true — this must render
  // the real content, not discard it for a generic error.
  it('renders children with stale data instead of the error state when a background refetch fails', () => {
    render(
      <QueryBoundary
        query={{ ...base, data: [1, 2, 3], isError: true, refetch: () => {} }}
        skeleton={<p>s</p>}
        errorTitle="Tours could not load"
      >
        {(d) => <p>got {d.length}</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('got 3')).toBeInTheDocument();
    expect(screen.queryByText('Tours could not load')).not.toBeInTheDocument();
  });

  it('calls query.refetch() when the retry button is pressed', async () => {
    const refetch = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryBoundary
        query={{ ...base, isError: true, refetch }}
        skeleton={<p>s</p>}
        errorTitle="Tours could not load"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('retry is a 44px tap target', () => {
    render(
      <QueryBoundary
        query={{ ...base, isError: true, refetch: () => {} }}
        skeleton={<p>s</p>}
        errorTitle="Nope"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByRole('button', { name: /try again/i })).toHaveClass('tap-target');
  });

  it('shows the empty slot for an empty array', () => {
    render(
      <QueryBoundary
        query={{ ...base, data: [] }}
        skeleton={<p>s</p>}
        empty={<p>nothing yet</p>}
        errorTitle="Nope"
      >
        {() => <p>data</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
  });

  it('does not show the empty slot for a non-empty array', () => {
    render(
      <QueryBoundary
        query={{ ...base, data: [1, 2] }}
        skeleton={<p>s</p>}
        empty={<p>nothing yet</p>}
        errorTitle="Nope"
      >
        {(d) => <p>got {d.length}</p>}
      </QueryBoundary>,
    );
    expect(screen.queryByText('nothing yet')).not.toBeInTheDocument();
    expect(screen.getByText('got 2')).toBeInTheDocument();
  });

  it('honours a custom isEmpty predicate instead of the array default', () => {
    render(
      <QueryBoundary
        query={{ ...base, data: { items: [] as number[] } }}
        skeleton={<p>s</p>}
        empty={<p>nothing yet</p>}
        errorTitle="Nope"
        isEmpty={(d) => d.items.length === 0}
      >
        {(d) => <p>got {d.items.length}</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
  });

  it('renders children with the data', () => {
    render(
      <QueryBoundary query={{ ...base, data: [1] }} skeleton={<p>s</p>} errorTitle="Nope">
        {(d) => <p>got {d.length}</p>}
      </QueryBoundary>,
    );
    expect(screen.getByText('got 1')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('renders a title and body', () => {
    render(<EmptyState title="No tours yet" body="Check back soon." />);
    expect(screen.getByText('No tours yet')).toBeInTheDocument();
    expect(screen.getByText('Check back soon.')).toBeInTheDocument();
  });
});

describe('TourCardSkeleton — no layout shift', () => {
  // Both renders anchored against the real, current TourCard — not a
  // hardcoded belief about its shape — so a future change to TourCard's
  // rows is exactly what would make these fail.
  function renderBoth() {
    const { container: skeletonContainer } = render(<TourCardSkeleton />);
    const { container: realContainer } = render(
      <MemoryRouter>
        <TourCard tour={TOURS_FIXTURE[0]!} />
      </MemoryRouter>,
    );
    return { skeletonContainer, realContainer };
  }

  it('mirrors the real TourCard image aspect ratio', () => {
    const { skeletonContainer, realContainer } = renderBoth();

    const skeletonImage = skeletonContainer.querySelector('.aspect-\\[4\\/3\\]');
    const realImage = realContainer.querySelector('.aspect-\\[4\\/3\\]');

    expect(skeletonImage, 'skeleton is missing the aspect-[4/3] image box').toBeTruthy();
    expect(realImage, 'TourCard is missing the aspect-[4/3] image box').toBeTruthy();
  });

  it('renders the same number of content rows inside CardContent as the real TourCard', () => {
    const { skeletonContainer, realContainer } = renderBoth();

    // `data-slot="card-content"` comes from the shared CardContent
    // primitive both the skeleton and TourCard render through, so this is
    // the real card's own row count, not a number this test invented.
    const skeletonContent = skeletonContainer.querySelector('[data-slot="card-content"]');
    const realContent = realContainer.querySelector('[data-slot="card-content"]');

    expect(skeletonContent, 'skeleton is missing its CardContent').toBeTruthy();
    expect(realContent, 'TourCard is missing its CardContent').toBeTruthy();
    expect(skeletonContent!.children.length).toBe(realContent!.children.length);
  });

  it('reserves the same 44px tap-target rows as the real TourCard (title link + "View tour" link)', () => {
    const { skeletonContainer, realContainer } = renderBoth();

    const skeletonTapRows = skeletonContainer.querySelectorAll('.min-h-11').length;
    const realTapRows = realContainer.querySelectorAll('.min-h-11').length;

    // Guards against the comparison below passing vacuously if both sides
    // were accidentally zero.
    expect(realTapRows, 'TourCard has no min-h-11 rows — fixture or markup changed').toBe(2);
    expect(
      skeletonTapRows,
      'skeleton min-h-11 row count does not match TourCard — a tap-target row would visibly jump height when the real card replaces the skeleton',
    ).toBe(realTapRows);
  });
});

describe('ReviewCardSkeleton — no layout shift', () => {
  it('mirrors the real review card container classes exactly, anchored to ReviewsSection', () => {
    const { container: skeletonContainer } = render(<ReviewCardSkeleton />);
    const { container: realContainer } = render(<ReviewsSection />);

    const skeletonCard = skeletonContainer.querySelector('[data-testid="review-card-skeleton"]');
    const realCard = realContainer.querySelector('li');

    expect(skeletonCard, 'ReviewCardSkeleton is missing its root').toBeTruthy();
    expect(realCard, 'ReviewsSection is missing a review <li>').toBeTruthy();

    const skeletonClasses = skeletonCard!.className.split(/\s+/).filter(Boolean).sort();
    const realClasses = realCard!.className.split(/\s+/).filter(Boolean).sort();

    expect(skeletonClasses).toEqual(realClasses);
  });
});

// "The global blanket rule should already clamp [shimmer] — verify that
// rather than assuming it." This reads the actual stylesheet rather than
// trusting jsdom (which does not compute real CSS animation timing) so a
// narrowed selector or a dropped !important is caught here, not assumed.
describe('shimmer respects prefers-reduced-motion', () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
  const css = readFileSync(cssPath, 'utf8');

  it('uses the Tailwind animate-pulse utility, not a bespoke animation name', () => {
    const { container } = render(<TourCardSkeleton />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('clamps animation-duration/delay/iteration-count for every element, unconditionally, under prefers-reduced-motion', () => {
    const match = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/,
    );
    expect(match, 'expected a universal (*) reduced-motion clamp in index.css').toBeTruthy();
    const body = match![1];
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});
