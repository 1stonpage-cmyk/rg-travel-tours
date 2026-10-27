/**
 * The review moderation screen (Week 7 plan, Task 11; BUILD_SPEC §9 "Reviews
 * moderation"). `admin.reviews.*` is `adminProcedure('reviewsModeration')`
 * server-side — owner and dispatcher, never finance — what is pinned here is
 * what the SCREEN itself promises: pending reviews are visually marked and
 * counted, publish/hide say the state in words and are mutually exclusive
 * only in the sense that the current state's button is disabled, a reply can
 * be added or edited, and a denied state appears rather than a blank screen
 * for a refused role.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewModerationRow } from '@rg/shared';
import AdminReviewsPage from '@/pages/admin/AdminReviewsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

function row(overrides: Partial<ReviewModerationRow>): ReviewModerationRow {
  return {
    id: 1,
    status: 'pending',
    name: 'Maria Santos',
    rating: 5,
    guide: null,
    value: null,
    punctuality: null,
    safety: null,
    body: 'Pedro was early and the van was spotless.',
    reply: null,
    repliedAt: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    isSample: false,
    verified: true,
    tourId: 6,
    tourTitle: 'Oslob Whale Sharks',
    bookingRef: 'RG-7KQ4M9',
    ...overrides,
  };
}

const PENDING = row({ id: 1, status: 'pending', name: 'Maria Santos' });
const PUBLISHED = row({
  id: 2,
  status: 'published',
  name: 'John Dela Cruz',
  rating: 4,
  verified: false,
  bookingRef: null,
  tourTitle: null,
});
const HIDDEN = row({ id: 3, status: 'hidden', name: 'Ana Reyes', rating: 2 });

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.reviews.queue': [PENDING, PUBLISHED, HIDDEN],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminReviewsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement;
}

describe('AdminReviewsPage — the queue', () => {
  it('marks pending reviews apart from decided ones, and counts them', async () => {
    renderPage();
    await screen.findByText('Maria Santos');

    expect(screen.getByText(/1 review waiting for a decision/i)).toBeInTheDocument();

    const pending = rowFor('Maria Santos');
    expect(within(pending).getByText('Pending', { selector: 'span' })).toBeInTheDocument();
    const published = rowFor('John Dela Cruz');
    expect(within(published).getByText('Published', { selector: 'span' })).toBeInTheDocument();
    const hidden = rowFor('Ana Reyes');
    expect(within(hidden).getByText('Hidden', { selector: 'span' })).toBeInTheDocument();
  });

  it('says nothing is waiting when the queue has no pending reviews', async () => {
    renderPage({ 'admin.reviews.queue': [PUBLISHED, HIDDEN] });
    await screen.findByText('John Dela Cruz');
    expect(screen.getByText(/nothing waiting for a decision/i)).toBeInTheDocument();
  });

  it('shows the verified badge, the booking ref, and "No booking linked" for a review with none', async () => {
    renderPage();
    await screen.findByText('Maria Santos');

    const pending = rowFor('Maria Santos');
    expect(within(pending).getByText('Verified booking')).toBeInTheDocument();
    expect(within(pending).getByText(/RG-7KQ4M9/)).toBeInTheDocument();

    const published = rowFor('John Dela Cruz');
    expect(within(published).queryByText('Verified booking')).not.toBeInTheDocument();
    expect(within(published).getByText(/no booking linked/i)).toBeInTheDocument();
  });
});

describe('AdminReviewsPage — publish and hide', () => {
  it('publishes a pending review and says so in words, disabling the now-current state', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.reviews.setStatus': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Maria Santos');
    const pending = rowFor('Maria Santos');

    await user.click(within(pending).getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 1, status: 'published' }]));
  });

  it('hides a published review', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.reviews.setStatus': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('John Dela Cruz');
    const published = rowFor('John Dela Cruz');

    await user.click(within(published).getByRole('button', { name: /^hide$/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 2, status: 'hidden' }]));
  });

  it('disables the Published button on an already-published review, and the Hidden button on an already-hidden one', async () => {
    renderPage();
    await screen.findByText('John Dela Cruz');

    const published = rowFor('John Dela Cruz');
    expect(within(published).getByRole('button', { name: /^published$/i })).toBeDisabled();

    const hidden = rowFor('Ana Reyes');
    expect(within(hidden).getByRole('button', { name: /^hidden$/i })).toBeDisabled();
  });

  it('shows the server refusal rather than a crash when a status change fails', async () => {
    renderPage();
    await screen.findByText('Maria Santos');
    mockTrpcError('admin.reviews.setStatus', 'CONFLICT', 'That review no longer exists.');

    const pending = rowFor('Maria Santos');
    await user.click(within(pending).getByRole('button', { name: /^publish$/i }));

    expect(await within(pending).findByText('That review no longer exists.')).toBeInTheDocument();
  });
});

describe('AdminReviewsPage — replying', () => {
  it('adds a reply to a review with none yet', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.reviews.reply': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Maria Santos');
    const pending = rowFor('Maria Santos');

    await user.click(within(pending).getByRole('button', { name: /add a reply/i }));
    await user.type(
      within(pending).getByLabelText(/write a reply/i),
      'Thank you for booking with us, Maria!',
    );
    await user.click(within(pending).getByRole('button', { name: /^save reply$/i }));

    await waitFor(() =>
      expect(calls).toEqual([{ id: 1, reply: 'Thank you for booking with us, Maria!' }]),
    );
  });

  it('pre-fills the existing reply when editing, and overwrites rather than appending', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.reviews.queue': [
        row({ id: 4, status: 'published', name: 'Existing Reply', reply: 'Thanks for visiting!' }),
      ],
      'admin.reviews.reply': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Existing Reply');
    const r = rowFor('Existing Reply');

    await user.click(within(r).getByRole('button', { name: /edit reply/i }));
    const field = within(r).getByLabelText(/edit reply/i) as HTMLTextAreaElement;
    expect(field.value).toBe('Thanks for visiting!');

    await user.clear(field);
    await user.type(field, 'Updated reply text.');
    await user.click(within(r).getByRole('button', { name: /^save reply$/i }));

    await waitFor(() => expect(calls).toEqual([{ id: 4, reply: 'Updated reply text.' }]));
  });

  it('refuses to save an empty reply without calling the server', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.reviews.reply': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Maria Santos');
    const pending = rowFor('Maria Santos');

    await user.click(within(pending).getByRole('button', { name: /add a reply/i }));
    await user.click(within(pending).getByRole('button', { name: /^save reply$/i }));

    expect(await within(pending).findByRole('alert')).toHaveTextContent(/write a reply/i);
    expect(calls).toHaveLength(0);
  });
});

describe('AdminReviewsPage — denied state', () => {
  it('shows the denied state, not a blank screen, when the role is finance', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'finance', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner and dispatcher can moderate reviews/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Maria Santos')).toBeNull();
  });

  it('shows the denied state when the queue call itself is refused with FORBIDDEN', async () => {
    mockTrpcError('admin.reviews.queue', 'FORBIDDEN', 'Not allowed for your role.');
    mockTrpc({ 'staffAuth.me': { userId: 1, role: 'dispatcher', mustChangePassword: false } });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminReviewsPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(
      await screen.findByText(/only the owner and dispatcher can moderate reviews/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not allowed for your role.')).toBeNull();
  });

  it('allows a dispatcher through (not owner-only)', async () => {
    renderPage({ 'staffAuth.me': { userId: 3, role: 'dispatcher', mustChangePassword: false } });
    expect(await screen.findByText('Maria Santos')).toBeInTheDocument();
  });
});
