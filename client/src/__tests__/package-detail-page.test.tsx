/**
 * Week 7 plan, Task 3: the public package detail page (`/packages/:slug`).
 *
 * Three things this page exists to keep straight:
 *  - old vs new price are both SERVER values, rendered through `formatPeso`
 *    only — nothing here recomputes or discounts a price itself.
 *  - the data field is `highlights`, not "inclusions" — rendered under
 *    "What's included".
 *  - the inquiry form on this page is `PackageInquiryForm`, which carries
 *    no package `<select>` — the package is already fixed by the slug in
 *    the URL, unlike the home page's inline form.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatPeso } from '@rg/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PackageDetailPage from '@/pages/public/PackageDetailPage';
import { TrpcProviders } from '@/lib/trpc';
import type { PackageDetail } from '../../../server/src/routers/public/packages';
import { PACKAGES_FIXTURE } from './helpers/fixtures';
import { mockTrpc, mockTrpcError } from './helpers/mock-trpc';

const BASE_PACKAGE_FIXTURE = PACKAGES_FIXTURE[0]!;
const PACKAGE_DETAIL_FIXTURE: PackageDetail = {
  ...BASE_PACKAGE_FIXTURE,
  // Task 4 (1D): the server's own `packageTitle()` formula output for this
  // fixture row — no `seoTitle` override, so this is the generated fallback.
  // Computed, not hand-typed, so a price change to the fixture cannot drift
  // silently out of sync with the string below.
  pageTitle: `${BASE_PACKAGE_FIXTURE.title} — ${BASE_PACKAGE_FIXTURE.days}-day Cebu package from ${formatPeso(BASE_PACKAGE_FIXTURE.newPriceCentavos)} | TravelSugbo`,
};

function detail(overrides: Partial<PackageDetail> = {}): PackageDetail {
  return { ...PACKAGE_DETAIL_FIXTURE, ...overrides };
}

function renderDetail(entry = `/packages/${PACKAGE_DETAIL_FIXTURE.slug}`) {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/packages/:slug" element={<PackageDetailPage />} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PackageDetailPage — content', () => {
  it("shows the title, days/nights, both server prices via formatPeso, the description and 'What's included'", async () => {
    mockTrpc({ 'packages.bySlug': () => detail() });
    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 days / 2 nights')).toBeInTheDocument();
    expect(
      screen.getByText(formatPeso(PACKAGE_DETAIL_FIXTURE.newPriceCentavos)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(formatPeso(PACKAGE_DETAIL_FIXTURE.oldPriceCentavos!)),
    ).toBeInTheDocument();
    expect(screen.getByText(PACKAGE_DETAIL_FIXTURE.description!)).toBeInTheDocument();

    const includedHeading = screen.getByRole('heading', { name: "What's included" });
    expect(includedHeading).toBeInTheDocument();
    for (const item of PACKAGE_DETAIL_FIXTURE.highlights as string[]) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });

  it('strikes through the old price only when oldPriceCentavos is non-null', async () => {
    mockTrpc({ 'packages.bySlug': () => detail({ oldPriceCentavos: null }) });
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title });
    expect(document.querySelector('s')).not.toBeInTheDocument();
  });
});

describe('PackageDetailPage — inquiry form', () => {
  it('has no package <select> (the package is already fixed by the URL)', async () => {
    mockTrpc({ 'packages.bySlug': () => detail() });
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it("submits the inquiry with this package's id, name, email and consent", async () => {
    let submitted: Record<string, unknown> | undefined;
    mockTrpc({
      'packages.bySlug': () => detail(),
      'inquiries.create': (input: unknown) => {
        submitted = input as Record<string, unknown>;
        return { ok: true };
      },
    });
    const user = userEvent.setup();
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title });
    await user.type(screen.getByLabelText('Your name'), 'Juan Dela Cruz');
    await user.type(screen.getByLabelText('Email'), 'juan@example.com');
    await user.click(screen.getByLabelText(/agree to be contacted/i));
    await user.click(screen.getByRole('button', { name: /send inquiry/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/inquiry sent/i);
    expect(submitted).toMatchObject({
      type: 'package',
      packageId: PACKAGE_DETAIL_FIXTURE.id,
      name: 'Juan Dela Cruz',
      email: 'juan@example.com',
      consent: true,
    });
  });

  it('refuses to submit without the RA 10173 consent checkbox', async () => {
    let calls = 0;
    mockTrpc({
      'packages.bySlug': () => detail(),
      'inquiries.create': () => {
        calls += 1;
        return { ok: true };
      },
    });
    const user = userEvent.setup();
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title });
    await user.type(screen.getByLabelText('Your name'), 'Juan Dela Cruz');
    await user.type(screen.getByLabelText('Email'), 'juan@example.com');
    await user.click(screen.getByRole('button', { name: /send inquiry/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/agree to be contacted/i);
    expect(calls).toBe(0);
  });
});

/**
 * Task 4 (1D): a client-side navigation into this page used to leave the
 * PREVIOUS page's title showing, because nothing here called any title
 * hook at all. `pageTitle` is the server's own `packageTitle()` formula
 * output (asserted directly against the real formula in
 * public-queries.test.ts); this only pins that the page actually sets
 * `document.title` to it.
 */
describe('PackageDetailPage — document title (Task 4, 1D)', () => {
  it('sets document.title to the server-computed pageTitle once the query resolves', async () => {
    document.title = 'Some other page | TravelSugbo';
    mockTrpc({ 'packages.bySlug': () => detail() });
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: PACKAGE_DETAIL_FIXTURE.title });
    expect(document.title).toBe(PACKAGE_DETAIL_FIXTURE.pageTitle);
  });

  it('leaves the previous title alone while the query is still pending', () => {
    document.title = 'Some other page | TravelSugbo';
    mockTrpc({ 'packages.bySlug': () => new Promise(() => {}) });
    renderDetail();

    expect(document.title).toBe('Some other page | TravelSugbo');
  });
});

describe('PackageDetailPage — unknown slug', () => {
  it('shows a 404-ish error state for a slug that does not resolve, mirroring TourDetailPage', async () => {
    mockTrpcError('packages.bySlug', 'NOT_FOUND', 'NOT_FOUND: no package found for slug "nope"');
    renderDetail('/packages/nope');

    // The query's default `retry: 1` (query-client.ts) means a real
    // rejection resolves after a backoff delay — same reason other error-
    // state tests in this suite (content-blocks.test.tsx, hero-trust.test.tsx)
    // extend the default findByRole timeout rather than disabling retry,
    // which would diverge from how `TourDetailPage`'s own `tours.bySlug`
    // query is configured.
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(/this package could not load/i);
  });
});
