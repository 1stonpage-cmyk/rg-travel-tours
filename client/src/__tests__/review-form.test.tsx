/**
 * Week 4 plan, Task 10 — the post-tour review form (BUILD_SPEC §7).
 *
 * `server/src/__tests__/portal-review.test.ts` proves the server refuses
 * everything it should. This file proves the form a guest actually uses:
 * that the ratings are real radio groups with announceable names, that the
 * sub-scores are optional, that it sends only what a guest may set, and
 * that it never claims a review is published.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { portalTracker } from '@rg/shared';
import PortalBookingPage from '@/pages/portal/PortalBookingPage';
import ReviewForm from '@/components/portal/ReviewForm';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

function renderForm() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <ReviewForm />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

const COMPLETED = {
  ref: 'RG-7KQ4M9',
  status: 'completed' as const,
  leadName: 'Maria Santos',
  tourTitle: 'Oslob Whale Shark Watching',
  tourDate: '2026-06-10',
  pax: 2,
  totalCentavos: 500_000,
  paidCentavos: 500_000,
  balanceCentavos: 0,
  amountDueCentavos: 0,
  holdExpiresAt: null,
  tracker: portalTracker({ status: 'completed', paidCentavos: 500_000, hasReceipt: true }),
  receipt: null,
  uploadsRemaining: 5,
  driver: null,
  canReview: true,
};

describe('ReviewForm', () => {
  /**
   * Five radio groups, each announceable by its own legend. Not clickable
   * stars with `aria-label`s: a fieldset tells a screen-reader user what
   * the group is FOR, and arrow-keys through it for free.
   */
  it('renders the overall rating and the four optional sub-scores as radio groups', () => {
    renderForm();

    for (const legend of [
      'Overall rating',
      'Driver and guide',
      'Value for money',
      'On time',
      'Safety',
    ]) {
      expect(screen.getByRole('group', { name: new RegExp(legend, 'i') })).toBeInTheDocument();
    }
    // Five stars in each of the five groups.
    expect(screen.getAllByRole('radio')).toHaveLength(25);
    // The sub-scores say they are optional; the overall rating does not.
    expect(screen.getAllByText(/\(optional\)/i)).toHaveLength(4);
  });

  it('sends the rating, the body and only the sub-scores the guest chose', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'portal.submitReview': (input: unknown) => {
        sent.push(input);
        return { status: 'pending' };
      },
    });
    renderForm();

    const overall = screen.getByRole('group', { name: /overall rating/i });
    await userEvent.click(within(overall).getByRole('radio', { name: /5 stars/i }));
    const guide = screen.getByRole('group', { name: /driver and guide/i });
    await userEvent.click(within(guide).getByRole('radio', { name: /4 stars/i }));
    await userEvent.type(
      screen.getByLabelText(/your review/i),
      'Pedro was early and the van was spotless.',
    );
    await userEvent.click(screen.getByRole('button', { name: /send review/i }));

    expect(await screen.findByText(/with our team/i)).toBeInTheDocument();
    expect(sent).toEqual([
      {
        rating: 5,
        guide: 4,
        body: 'Pedro was early and the van was spotless.',
      },
    ]);
  });

  /**
   * **The form sends nothing the server owns.** No status, no bookingId,
   * no name — a review that could carry its own `status: 'published'`
   * would be a guest publishing straight to the site.
   */
  it('sends no status, booking, tour or name', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockTrpc({
      'portal.submitReview': (input: unknown) => {
        sent.push(input as Record<string, unknown>);
        return { status: 'pending' };
      },
    });
    renderForm();

    const overall = screen.getByRole('group', { name: /overall rating/i });
    await userEvent.click(within(overall).getByRole('radio', { name: /3 stars/i }));
    await userEvent.type(screen.getByLabelText(/your review/i), 'It was a decent day out.');
    await userEvent.click(screen.getByRole('button', { name: /send review/i }));

    await screen.findByText(/with our team/i);
    const keys = Object.keys(sent[0] ?? {});
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('bookingId');
    expect(keys).not.toContain('tourId');
    expect(keys).not.toContain('name');
    expect(keys).not.toContain('isSample');
  });

  it('asks for a rating before it will send anything', async () => {
    let calls = 0;
    mockTrpc({
      'portal.submitReview': () => {
        calls += 1;
        return { status: 'pending' };
      },
    });
    renderForm();

    await userEvent.type(screen.getByLabelText(/your review/i), 'A lovely day out, thank you.');
    await userEvent.click(screen.getByRole('button', { name: /send review/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a star rating/i);
    expect(calls, 'the form submitted with no rating').toBe(0);
  });

  /** The server's own sentence, in amber, never red. */
  it('shows the server refusal rather than a crash', async () => {
    mockTrpcError(
      'portal.submitReview',
      'CONFLICT',
      'You have already left a review for this booking. Message us to change it.',
    );
    renderForm();

    const overall = screen.getByRole('group', { name: /overall rating/i });
    await userEvent.click(within(overall).getByRole('radio', { name: /5 stars/i }));
    await userEvent.type(screen.getByLabelText(/your review/i), 'Second attempt at a review.');
    await userEvent.click(screen.getByRole('button', { name: /send review/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already left a review/i);
  });

  /**
   * It says the review is WAITING, never that it is live. A form that said
   * "your review is now on the site" would be lying about §7's approval
   * step, and the guest would go looking for it.
   */
  it('says the review is waiting to be checked, not that it is published', async () => {
    mockTrpc({ 'portal.submitReview': { status: 'pending' } });
    renderForm();

    const overall = screen.getByRole('group', { name: /overall rating/i });
    await userEvent.click(within(overall).getByRole('radio', { name: /5 stars/i }));
    await userEvent.type(screen.getByLabelText(/your review/i), 'Genuinely excellent, thank you.');
    await userEvent.click(screen.getByRole('button', { name: /send review/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/once it has been checked/i);
    expect(status).not.toHaveTextContent(/now live|published on/i);
  });
});

describe('the portal page and the review form', () => {
  function renderPage() {
    return render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/portal/booking']}>
          <Routes>
            <Route path="/portal/booking" element={<PortalBookingPage />} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );
  }

  it('offers the form when the server says canReview', async () => {
    mockTrpc({ 'portal.booking': COMPLETED });
    renderPage();
    expect(await screen.findByRole('heading', { name: /how was your tour/i })).toBeInTheDocument();
  });

  /** Mid-tour, or once a review exists: no form at all. */
  it('offers no form when the server says it cannot be reviewed', async () => {
    mockTrpc({ 'portal.booking': { ...COMPLETED, canReview: false } });
    renderPage();

    await screen.findByText(/your tour is complete/i);
    expect(screen.queryByRole('heading', { name: /how was your tour/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send review/i })).not.toBeInTheDocument();
  });
});
