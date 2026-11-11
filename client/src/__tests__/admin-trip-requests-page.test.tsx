/**
 * The standalone trip-requests inbox (Demo Polish Round 2, Task 1 / owner's
 * "1A", 2026-11-11) — a second URL onto the same `admin.inquiries.*` data
 * `admin-packages-page.test.tsx` already covers on `/admin/packages`.
 *
 * What is pinned here is specific to THIS page: owner and dispatcher see
 * the inbox, finance sees the denied state (both the known-role layer and
 * the refused-query layer), and all three `inquiries.type` values render
 * without any client-side filtering — `InquiriesInbox` itself is already
 * covered by the Packages page's own tests for its row behaviour (status
 * changes, pager, quote & convert), so this file does not re-prove those.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InquiryAdminRow } from '@rg/shared';
import AdminTripRequestsPage from '@/pages/admin/AdminTripRequestsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

/*
 * Radix's `Select` needs three DOM APIs jsdom does not implement — see
 * `admin-packages-page.test.tsx`'s own note, the first file in this
 * project to open one. `InquiriesInbox`'s convert control uses the same
 * `ConvertInquiryForm`, so an owner-role test here would hit the same gap
 * if it opened that form; this file does not open it, but the shim is
 * cheap and avoids a surprise the day a test here does.
 */
beforeAll(() => {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
});

afterEach(() => {
  resetTrpcMock();
});

function inquiry(overrides: Partial<InquiryAdminRow> = {}): InquiryAdminRow {
  return {
    id: 10,
    type: 'package',
    status: 'new',
    packageId: 1,
    packageTitle: 'Cebu Highlights',
    name: 'Maria Santos',
    email: 'maria@example.test',
    phone: '09170000000',
    message: 'Can you collect us from the pier?',
    requestedDate: null,
    pax: null,
    routeDescription: null,
    convertedBookingId: null,
    convertedBookingRef: null,
    createdAt: '2026-06-15T02:00:00.000Z',
    ...overrides,
  };
}

const PACKAGE_INQUIRY = inquiry({ id: 10, type: 'package', name: 'Maria Santos' });
const GENERAL_INQUIRY = inquiry({
  id: 11,
  type: 'contact',
  packageId: null,
  packageTitle: null,
  name: 'John Dela Cruz',
  phone: null,
  message: 'Do you run airport transfers?',
});
const TRANSFER_CUSTOM_INQUIRY = inquiry({
  id: 12,
  type: 'transfer_custom',
  packageId: null,
  packageTitle: null,
  name: 'Pedro Cruz',
  message: 'Can we add a stop on the way?',
  requestedDate: '2027-02-20',
  pax: 6,
  routeDescription: 'Cebu city to Moalboal',
});

/** `admin.inquiries.list`'s paginated result shape. */
function inquiryPage(
  items: InquiryAdminRow[],
  overrides: Partial<{ total: number; limit: number; offset: number }> = {},
) {
  return { items, total: items.length, limit: 25, offset: 0, ...overrides };
}

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.inquiries.list': inquiryPage([
      PACKAGE_INQUIRY,
      GENERAL_INQUIRY,
      TRANSFER_CUSTOM_INQUIRY,
    ]),
    'admin.vehicleTypes.list': [],
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminTripRequestsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('AdminTripRequestsPage — who sees the inbox', () => {
  it('shows the inbox to an owner', async () => {
    renderPage();
    expect(await screen.findByText('Trip requests')).toBeInTheDocument();
    expect(await screen.findByText('Maria Santos')).toBeInTheDocument();
  });

  it('shows the inbox to a dispatcher', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(await screen.findByText('Maria Santos')).toBeInTheDocument();
  });

  it('shows the denied state, not the inbox, for finance — the known-role layer', async () => {
    renderPage({ 'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner and dispatcher can see trip requests/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Maria Santos')).toBeNull();
  });

  /**
   * The second denial layer: a session this client's `staffAuth.me` still
   * reports as `dispatcher` (a stale cache, or a role changed mid-visit),
   * but whose `admin.inquiries.list` call the SERVER now refuses with
   * FORBIDDEN. Mirrors `admin-packages-page.test.tsx`'s own
   * "shows the denied state when the package list itself is refused"
   * test, against this page's own probe query instead of `packages.list`.
   */
  it('shows the denied state when admin.inquiries.list itself is refused with FORBIDDEN', async () => {
    mockTrpcError('admin.inquiries.list', 'FORBIDDEN', 'Not permitted for this account.');
    mockTrpc({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminTripRequestsPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(
      await screen.findByText(/only the owner and dispatcher can see trip requests/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not permitted for this account.')).toBeNull();
  });
});

describe('AdminTripRequestsPage — the inbox is not filtered by type', () => {
  it('renders a custom trip request, a general message, and a package enquiry together', async () => {
    renderPage();
    await screen.findByText('Maria Santos');

    const packageRow = screen.getByText('Maria Santos').closest('li') as HTMLElement;
    const generalRow = screen.getByText('John Dela Cruz').closest('li') as HTMLElement;
    const customRow = screen.getByText('Pedro Cruz').closest('li') as HTMLElement;

    expect(within(packageRow).getByText(/About Cebu Highlights/)).toBeInTheDocument();
    expect(within(generalRow).getByText(/general enquiry/i)).toBeInTheDocument();
    expect(within(customRow).getByText(/custom trip request/i)).toBeInTheDocument();
  });
});
