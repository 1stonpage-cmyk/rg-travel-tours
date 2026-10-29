/**
 * The money reports screen (Week 7 plan, Task 12 — 7D). `admin.reports.*` is
 * `adminProcedure('reports')` server-side — owner and finance only; what is
 * pinned here is what the SCREEN promises:
 *
 *  - the default window is **this Manila month**, first day to last, and it is
 *    the window the three queries are actually SENT (read off the request, not
 *    off the rendered text — a default computed in the browser and then not
 *    used is exactly the bug a render assertion would miss);
 *  - an empty window reads **₱0 and 0**, never an em dash. "Nothing came in"
 *    is a fact; a dash reads as "we don't know", which about someone's own
 *    money is worse;
 *  - the five figures are the server's, formatted and not re-derived — net
 *    received is rendered as sent even when it disagrees with the other two
 *    cards, because the server is the one that computes money;
 *  - a CSV button turns the returned string into a `Blob` download, with the
 *    server's filename;
 *  - a dispatcher gets the denied state from either layer — the role this
 *    session knows, and a `FORBIDDEN` query.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminReportsPage from '@/pages/admin/AdminReportsPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

/** Every object URL this test created, and the blob behind it. */
const downloads: Array<{ blob: Blob; type: string }> = [];
let clickedAnchors: Array<{ href: string; download: string }> = [];

/**
 * A blob's text, whichever API jsdom happens to provide.
 *
 * `Blob.prototype.text()` is missing in this jsdom build — calling it inside
 * the `createObjectURL` stub threw, the page's own `catch` swallowed it, and
 * the test failed looking like a broken download rather than a broken test.
 * `FileReader` is the one jsdom has always had.
 */
async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return await blob.text();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(blob);
  });
}

/*
 * jsdom implements neither object-URL method, and a download is the one thing
 * this screen does that is not a render. Only the two STATICS are replaced —
 * never the `URL` global itself, which the tRPC mock's own `new URL(...)`
 * depends on — and both are put back afterwards.
 */
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads.length = 0;
  clickedAnchors = [];
  URL.createObjectURL = (blob: Blob) => {
    downloads.push({ blob, type: blob.type });
    return `blob:mock-${downloads.length}`;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickedAnchors.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  resetTrpcMock();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  vi.restoreAllMocks();
});

const SUMMARY = {
  from: '2026-10-01',
  to: '2026-10-31',
  receivedCentavos: 370_000,
  refundedCentavos: 40_000,
  netReceivedCentavos: 330_000,
  stillToCollectCentavos: 680_000,
  bookingCount: 5,
};

const EMPTY_SUMMARY = {
  from: '2026-10-01',
  to: '2026-10-31',
  receivedCentavos: 0,
  refundedCentavos: 0,
  netReceivedCentavos: 0,
  stillToCollectCentavos: 0,
  bookingCount: 0,
};

const BY_TOUR = [
  {
    tourId: 1,
    tourTitle: 'Kawasan Falls, Badian Day Tour',
    receivedCentavos: 300_000,
    refundedCentavos: 40_000,
    netReceivedCentavos: 260_000,
    stillToCollectCentavos: 200_000,
    bookingCount: 2,
  },
  {
    tourId: 2,
    tourTitle: 'Sirao Flower Farm Half Day',
    receivedCentavos: 70_000,
    refundedCentavos: 0,
    netReceivedCentavos: 70_000,
    stillToCollectCentavos: 480_000,
    bookingCount: 3,
  },
];

const OUTSTANDING = [
  {
    bookingId: 11,
    ref: 'RG-7KQ4M9',
    tourTitle: 'Kawasan Falls, Badian Day Tour',
    tourDate: '2026-10-05',
    status: 'confirmed' as const,
    leadName: 'Maria Santos',
    totalCentavos: 300_000,
    paidCentavos: 100_000,
    outstandingCentavos: 200_000,
  },
  {
    bookingId: 12,
    ref: 'RG-OVER01',
    tourTitle: 'Sirao Flower Farm Half Day',
    tourDate: '2026-10-09',
    status: 'confirmed' as const,
    leadName: 'Jun Dela Cruz',
    totalCentavos: 100_000,
    paidCentavos: 120_000,
    outstandingCentavos: -20_000,
  },
];

/** Every window the mock was ASKED for, per procedure. */
const asked: Record<string, unknown[]> = {};

/**
 * The mocks, WITHOUT rendering — `mockTrpcError` registers its own handler, so
 * a refusal has to be layered on after these defaults and before the render.
 */
function setupMocks(extra: Record<string, unknown> = {}) {
  for (const key of Object.keys(asked)) delete asked[key];
  const record = (name: string, value: unknown) => (input: unknown) => {
    (asked[name] ??= []).push(input);
    return value;
  };
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'finance', mustChangePassword: false },
    'admin.reports.summary': record('summary', SUMMARY),
    'admin.reports.byTour': record('byTour', BY_TOUR),
    'admin.reports.outstanding': record('outstanding', OUTSTANDING),
    'admin.reports.csv': record('csv', {
      filename: 'travelsugbo-by-tour-2026-10-01-to-2026-10-31.csv',
      csv: 'Tour,Bookings\r\n"Kawasan Falls, Badian Day Tour",2',
    }),
    ...extra,
  });
}

function renderOnly() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminReportsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function renderPage(extra: Record<string, unknown> = {}) {
  setupMocks(extra);
  return renderOnly();
}

describe('the default window', () => {
  it('asks the server for this whole Manila month', async () => {
    renderPage();
    await screen.findByText('₱3,700');

    const now = new Date();
    const manilaToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [year, month] = manilaToday.split('-').map(Number) as [number, number];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const expected = {
      from: `${year}-${pad(month)}-01`,
      to: `${year}-${pad(month)}-${pad(lastDay)}`,
    };

    // All three queries, so a window that only reached one of them fails here.
    expect(asked.summary?.[0]).toEqual(expected);
    expect(asked.byTour?.[0]).toEqual(expected);
    expect(asked.outstanding?.[0]).toEqual(expected);
  });

  it('sends a window an admin typed instead of filtering in the browser', async () => {
    renderPage();
    await screen.findByText('₱3,700');

    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-09-01');
    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2026-09-30');
    await user.click(screen.getByRole('button', { name: 'Show these dates' }));

    await waitFor(() => {
      expect(asked.summary?.at(-1)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    });
    expect(asked.outstanding?.at(-1)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('refuses an inverted window in the form rather than asking the server', async () => {
    renderPage();
    await screen.findByText('₱3,700');
    const asksBefore = asked.summary?.length ?? 0;

    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-12-31');
    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2026-12-01');

    expect(await screen.findByText(/start on or before the end/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show these dates' })).toBeDisabled();
    expect(asked.summary?.length ?? 0).toBe(asksBefore);
  });
});

describe('the figures', () => {
  /**
   * One headline card, by its label. The per-tour table repeats some of the
   * same amounts, so a bare `getByText('₱400')` is ambiguous — the figure has
   * to be read out of the card that claims it.
   */
  function card(label: string): HTMLElement {
    const cards = screen.getByTestId('figure-cards');
    return within(cards).getByText(label).closest('div') as HTMLElement;
  }

  it('renders the five figures the server sent, formatted', async () => {
    renderPage();
    await screen.findByText('₱3,700');
    expect(within(card('Money received')).getByText('₱3,700')).toBeTruthy();
    expect(within(card('Refunds')).getByText('₱400')).toBeTruthy();
    expect(within(card('Net received')).getByText('₱3,300')).toBeTruthy();
    expect(within(card('Still to collect')).getByText('₱6,800')).toBeTruthy();
    // The booking count is a count, not money.
    expect(within(card('Bookings')).getByText('5')).toBeTruthy();
  });

  it('shows a zero as ₱0 and 0, never as a dash', async () => {
    renderPage({
      'admin.reports.summary': EMPTY_SUMMARY,
      'admin.reports.byTour': [],
      'admin.reports.outstanding': [],
    });
    expect(await screen.findAllByText('₱0')).toHaveLength(4);
    expect(within(card('Bookings')).getByText('0')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.getByText(/No money moved and no trips ran/i)).toBeTruthy();
    expect(screen.getByText(/paid in full/i)).toBeTruthy();
  });

  it('says which date each figure counts by, so nobody subtracts one from another', async () => {
    renderPage();
    await screen.findByText('₱3,700');
    expect(screen.getAllByText('By the date the money moved')).toHaveLength(2);
    expect(screen.getAllByText('By tour date')).toHaveLength(2);
  });
});

describe('the tables', () => {
  it('lists each tour with its own figures', async () => {
    renderPage();
    const wrapper = await screen.findByTestId('by-tour-wrapper');
    const row = within(wrapper).getByText('Kawasan Falls, Badian Day Tour').closest('tr');
    expect(within(row as HTMLElement).getByText('₱2,600')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('₱2,000')).toBeTruthy();
  });

  it('shows an overpaid booking as a negative balance rather than hiding it', async () => {
    renderPage();
    const wrapper = await screen.findByTestId('outstanding-wrapper');
    const row = within(wrapper).getByText('RG-OVER01').closest('tr') as HTMLElement;
    expect(within(row).getByText('Jun Dela Cruz')).toBeTruthy();
    expect(within(row).getByText('-₱200')).toBeTruthy();
  });

  it('links a balance to its booking', async () => {
    renderPage();
    const wrapper = await screen.findByTestId('outstanding-wrapper');
    expect(within(wrapper).getByRole('link', { name: 'RG-7KQ4M9' })).toHaveAttribute(
      'href',
      '/admin/bookings/RG-7KQ4M9',
    );
  });

  // Wide tables scroll inside their own container; the page body must not.
  it('keeps both tables inside their own horizontal scroll container', async () => {
    renderPage();
    expect((await screen.findByTestId('by-tour-wrapper')).className).toContain('overflow-x-auto');
    expect(screen.getByTestId('outstanding-wrapper').className).toContain('overflow-x-auto');
  });
});

describe('the CSV download', () => {
  it('turns the returned string into a Blob download with the server’s filename', async () => {
    renderPage();
    await screen.findByText('₱3,700');

    await user.click(screen.getByRole('button', { name: /revenue by tour \(CSV\)/i }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(asked.csv?.[0]).toMatchObject({ report: 'byTour' });
    expect(downloads[0]!.type).toContain('text/csv');
    /*
     * The file carries the server's text verbatim — the browser builds no CSV
     * of its own. A reader strips the leading BOM, exactly as a spreadsheet
     * does, so the BOM itself is asserted on the blob's SIZE: three bytes of
     * `EF BB BF` ahead of the text, which is what makes Excel read a guest's
     * ñ as a ñ rather than mojibake.
     */
    const expectedCsv = 'Tour,Bookings\r\n"Kawasan Falls, Badian Day Tour",2';
    await expect(blobText(downloads[0]!.blob)).resolves.toBe(expectedCsv);
    expect(downloads[0]!.blob.size).toBe(new TextEncoder().encode(expectedCsv).length + 3);
    expect(clickedAnchors).toEqual([
      {
        href: 'blob:mock-1',
        download: 'travelsugbo-by-tour-2026-10-01-to-2026-10-31.csv',
      },
    ]);
  });

  it('says so and downloads nothing when the export is refused', async () => {
    setupMocks();
    mockTrpcError('admin.reports.csv', 'INTERNAL_SERVER_ERROR', 'nope');
    renderOnly();
    await screen.findByText('₱3,700');

    await user.click(screen.getByRole('button', { name: /the summary \(CSV\)/i }));

    expect(await screen.findByText(/Could not build that file/i)).toBeTruthy();
    expect(downloads).toHaveLength(0);
    expect(clickedAnchors).toHaveLength(0);
  });

  it('offers one button per report', async () => {
    renderPage();
    await screen.findByText('₱3,700');
    expect(screen.getAllByRole('button', { name: /\(CSV\)/i })).toHaveLength(3);
  });
});

describe('the role gate', () => {
  it('shows a denied state to a dispatcher, not a blank screen', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    expect(await screen.findByText(/Only the owner and finance can see/i)).toBeTruthy();
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  it('shows the same denied state when the query itself is refused', async () => {
    setupMocks();
    mockTrpcError('admin.reports.summary', 'FORBIDDEN', 'Not permitted for this account.');
    renderOnly();
    expect(await screen.findByText(/Only the owner and finance can see/i)).toBeTruthy();
  });

  /**
   * 7N (Task 12): 401 means an expired or missing session, not a wrong
   * role — an owner or finance user whose session simply timed out must
   * not be told "only the owner and finance can see the money reports",
   * a sentence about the role they already have. It falls through to the
   * screen's own generic "sign in again" message instead.
   */
  it('does NOT show the wrong-role denied state for an expired session (401)', async () => {
    setupMocks();
    mockTrpcError('admin.reports.summary', 'UNAUTHORIZED', 'Admin sign-in required.');
    renderOnly();

    expect(await screen.findByText(/sign in again/i)).toBeTruthy();
    expect(screen.queryByText(/Only the owner and finance can see/i)).toBeNull();
  });

  it('admits the owner', async () => {
    renderPage({ 'staffAuth.me': { userId: 3, role: 'owner', mustChangePassword: false } });
    expect(await screen.findByText('₱3,700')).toBeTruthy();
  });
});
