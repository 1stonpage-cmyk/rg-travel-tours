import { render, screen, within } from '@testing-library/react';
import { formatPeso } from '@rg/shared';
import { describe, expect, it } from 'vitest';
import PackagesSection from '@/components/home/PackagesSection';
import ReviewsSection from '@/components/home/ReviewsSection';
import { TrpcProviders } from '@/lib/trpc';
import type { PackageListItem } from '../../../server/src/routers/public/packages';
import type { ReviewsPublishedResult } from '../../../server/src/routers/public/reviews';
import { PACKAGES_FIXTURE, REVIEWS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';

function renderPackages() {
  return render(
    <TrpcProviders>
      <PackagesSection />
    </TrpcProviders>,
  );
}

function renderReviews() {
  return render(
    <TrpcProviders>
      <ReviewsSection />
    </TrpcProviders>,
  );
}

describe('PackagesSection — live data', () => {
  it('renders every active package, with old and new prices formatted via formatPeso', async () => {
    mockTrpc({ 'packages.list': PACKAGES_FIXTURE });
    renderPackages();

    for (const pkg of PACKAGES_FIXTURE) {
      const heading = await screen.findByRole('heading', { level: 3, name: pkg.title });
      const card = heading.closest('li') as HTMLElement;
      expect(within(card).getByText(formatPeso(pkg.newPriceCentavos))).toBeInTheDocument();
      if (pkg.oldPriceCentavos != null) {
        expect(within(card).getByText(formatPeso(pkg.oldPriceCentavos))).toBeInTheDocument();
      }
    }
  });

  // Provable: every fixture package happens to have a non-null
  // oldPriceCentavos, so this asserts against a package deliberately
  // missing one, not against the fixture's own (always-discounted) shape.
  it('strikes through the old price only when oldPriceCentavos is non-null', async () => {
    const noDiscount: PackageListItem = {
      ...PACKAGES_FIXTURE[0]!,
      id: 99,
      slug: 'no-discount-package',
      title: 'No Discount Package',
      oldPriceCentavos: null,
    };
    mockTrpc({ 'packages.list': [...PACKAGES_FIXTURE, noDiscount] });
    renderPackages();

    const heading = await screen.findByRole('heading', { level: 3, name: 'No Discount Package' });
    const card = heading.closest('li') as HTMLElement;
    expect(card.querySelector('s')).not.toBeInTheDocument();

    // The discounted fixtures still get their strikethrough.
    const discountedHeading = await screen.findByRole('heading', {
      level: 3,
      name: PACKAGES_FIXTURE[0]!.title,
    });
    const discountedCard = discountedHeading.closest('li') as HTMLElement;
    expect(discountedCard.querySelector('s')).toBeInTheDocument();
  });

  it('shows skeletons while packages.list is pending, then the real grid once it resolves', async () => {
    let resolvePackages!: (packages: PackageListItem[]) => void;
    const deferred = new Promise<PackageListItem[]>((resolve) => {
      resolvePackages = resolve;
    });
    mockTrpc({ 'packages.list': () => deferred });

    renderPackages();

    expect(screen.getAllByRole('status', { name: /loading package/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();

    resolvePackages(PACKAGES_FIXTURE);

    expect(
      await screen.findByRole('heading', { level: 3, name: PACKAGES_FIXTURE[0]!.title }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('status', { name: /loading package/i })).toHaveLength(0);
  });

  it('shows a friendly error when packages fail to load, never the raw error text', async () => {
    mockTrpcError('packages.list');
    renderPackages();

    expect(
      await screen.findByText(/packages could not load/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/mock failure/i)).not.toBeInTheDocument();
  });
});

describe('ReviewsSection — live data', () => {
  it('renders every published review, including the seeded is_sample ones', async () => {
    mockTrpc({ 'reviews.published': REVIEWS_FIXTURE });
    const { container } = renderReviews();

    const list = await screen.findByText(REVIEWS_FIXTURE.items[0]!.name);
    expect(list).toBeInTheDocument();

    const reviewsSection = container.querySelector('#reviews') as HTMLElement;
    for (const review of REVIEWS_FIXTURE.items) {
      // Every fixture review has isSample: true — if sample reviews were
      // being filtered out, none of these would ever appear.
      expect(review.isSample).toBe(true);
      expect(within(reviewsSection).getByText(review.name)).toBeInTheDocument();
      expect(within(reviewsSection).getByText(review.body)).toBeInTheDocument();
    }
    expect(within(reviewsSection).getAllByRole('listitem')).toHaveLength(
      REVIEWS_FIXTURE.items.length,
    );
  });

  it('shows an empty state when no reviews are published', async () => {
    const empty: ReviewsPublishedResult = {
      items: [],
      displayAggregate: null,
      realAggregate: null,
    };
    mockTrpc({ 'reviews.published': empty });
    renderReviews();

    expect(await screen.findByText(/no reviews yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('never renders a review body containing HTML as markup — it stays visible text', async () => {
    const malicious: ReviewsPublishedResult = {
      items: [
        {
          ...REVIEWS_FIXTURE.items[0]!,
          id: 999,
          body: '<img src=x onerror=alert(1)>',
        },
      ],
      displayAggregate: { average: 5, count: 1 },
      realAggregate: null,
    };
    mockTrpc({ 'reviews.published': malicious });
    const { container } = renderReviews();

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    // No actual <img> element was injected into the DOM from the body text.
    expect(container.querySelector('blockquote img')).not.toBeInTheDocument();
  });

  it('shows skeletons while reviews.published is pending, then the real grid once it resolves', async () => {
    let resolveReviews!: (result: ReviewsPublishedResult) => void;
    const deferred = new Promise<ReviewsPublishedResult>((resolve) => {
      resolveReviews = resolve;
    });
    mockTrpc({ 'reviews.published': () => deferred });

    renderReviews();

    expect(screen.getAllByRole('status', { name: /loading review/i }).length).toBeGreaterThan(0);
    // The skeleton rows are themselves <li> elements, so "no listitem role"
    // isn't a usable pending-state assertion here — assert on real review
    // content being absent instead.
    expect(screen.queryByText(REVIEWS_FIXTURE.items[0]!.name)).not.toBeInTheDocument();

    resolveReviews(REVIEWS_FIXTURE);

    expect(await screen.findByText(REVIEWS_FIXTURE.items[0]!.name)).toBeInTheDocument();
    expect(screen.queryAllByRole('status', { name: /loading review/i })).toHaveLength(0);
  });

  it('shows a friendly error when reviews fail to load, never the raw error text', async () => {
    mockTrpcError('reviews.published');
    renderReviews();

    expect(
      await screen.findByText(/reviews could not load/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/mock failure/i)).not.toBeInTheDocument();
  });
});
