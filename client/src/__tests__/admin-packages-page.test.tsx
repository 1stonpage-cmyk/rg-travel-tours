/**
 * The packages, enquiries and newsletter screen (Week 7 plan, Task 13 — 7C;
 * BUILD_SPEC §9 "Packages, inquiries" and "Users, settings").
 *
 * The server is the guard — `admin.packages.*` / `admin.inquiries.*` are
 * `adminProcedure('packagesInquiries')` and `admin.newsletter.export` is
 * `adminProcedure('usersSettings')`. What is pinned here is what the SCREEN
 * promises: every package including the retired ones with the money in pesos,
 * enquiries newest first with the package they are about and a status control,
 * the newsletter export drawn for an owner and **not drawn for a dispatcher**,
 * and a denied state rather than a blank page for a refused role.
 *
 * The export button's absence for a dispatcher is cosmetic and is tested AS
 * cosmetic — the server refusal is `admin-packages.test.ts`'s job. A test that
 * only checked the button would be checking the weaker half.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InquiryAdminRow, PackageAdminRow } from '@rg/shared';
import AdminPackagesPage from '@/pages/admin/AdminPackagesPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

/** Every object URL this test created, and the anchor that was clicked. */
const downloads: Array<{ blob: Blob }> = [];
let clickedAnchors: Array<{ download: string }> = [];

/*
 * jsdom implements neither object-URL method, and a download is the one thing
 * this screen does that is not a render. Only the two STATICS are replaced —
 * never the `URL` global itself, which the tRPC mock's own `new URL(...)`
 * depends on — and both are put back afterwards. (Stubbing the global was
 * tried first and broke every later test in the file, exactly as
 * `admin-reports-page.test.tsx` already warns.)
 */
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  downloads.length = 0;
  clickedAnchors = [];
  URL.createObjectURL = (blob: Blob) => {
    downloads.push({ blob });
    return `blob:mock-${downloads.length}`;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickedAnchors.push({ download: this.download });
  });
});

afterEach(() => {
  resetTrpcMock();
  vi.restoreAllMocks();
});

afterAll(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

function pkg(overrides: Partial<PackageAdminRow> = {}): PackageAdminRow {
  return {
    id: 1,
    slug: 'cebu-highlights-3d2n',
    title: 'Cebu Highlights',
    days: 3,
    oldPriceCentavos: 1_250_000,
    newPriceCentavos: 980_000,
    description: 'Three days around the city and the south.',
    imagePath: '/placeholders/package-cebu.svg',
    imageAlt: 'A van parked beside Magellan’s Cross',
    highlights: ['Taoist Temple', 'Sirao Garden'],
    sortOrder: 0,
    seoTitle: null,
    seoDescription: null,
    ogImage: null,
    isActive: true,
    inquiryCount: 2,
    ...overrides,
  };
}

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
    createdAt: '2026-06-15T02:00:00.000Z',
    ...overrides,
  };
}

const ACTIVE = pkg({ id: 1 });
const RETIRED = pkg({
  id: 2,
  slug: 'bantayan-weekend',
  title: 'Bantayan Weekend',
  isActive: false,
  oldPriceCentavos: null,
  newPriceCentavos: 1_450_000,
  inquiryCount: 0,
});

const NEW_INQUIRY = inquiry({ id: 10, name: 'Maria Santos', status: 'new' });
const GENERAL_INQUIRY = inquiry({
  id: 11,
  type: 'contact',
  status: 'closed',
  packageId: null,
  packageTitle: null,
  name: 'John Dela Cruz',
  phone: null,
  message: 'Do you run airport transfers?',
});

/** `admin.inquiries.list`'s paginated result shape — mirrors `admin.bookings.list`. */
function inquiryPage(
  items: InquiryAdminRow[],
  overrides: Partial<{ total: number; limit: number; offset: number }> = {},
) {
  return { items, total: items.length, limit: 25, offset: 0, ...overrides };
}

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.packages.list': [ACTIVE, RETIRED],
    'admin.inquiries.list': inquiryPage([NEW_INQUIRY, GENERAL_INQUIRY]),
    ...extra,
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminPackagesPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

function rowFor(text: string): HTMLElement {
  return screen.getByText(text).closest('li') as HTMLElement;
}

describe('AdminPackagesPage — the package list', () => {
  it('lists active and retired packages, with the money in pesos', async () => {
    renderPage();
    await screen.findByText('Cebu Highlights');

    const active = rowFor('Cebu Highlights');
    expect(within(active).getByText('Active')).toBeInTheDocument();
    expect(within(active).getByText(/₱9,800/)).toBeInTheDocument();
    expect(within(active).getByText(/₱12,500/)).toBeInTheDocument();

    const retired = rowFor('Bantayan Weekend');
    expect(within(retired).getByText('Inactive')).toBeInTheDocument();
    // No "was" price on a package sold at one price.
    expect(within(retired).queryByText(/was ₱/i)).toBeNull();
  });

  it('says how many people have asked about each package', async () => {
    renderPage();
    await screen.findByText('Cebu Highlights');
    expect(within(rowFor('Cebu Highlights')).getByText(/2 enquiries/i)).toBeInTheDocument();
    expect(within(rowFor('Bantayan Weekend')).getByText(/no enquiries/i)).toBeInTheDocument();
  });

  it('deactivates behind a two-step confirm, never a delete', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.packages.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Cebu Highlights');
    const row = rowFor('Cebu Highlights');

    // The word "delete" appears nowhere on the screen.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();

    await user.click(within(row).getByRole('button', { name: /deactivate cebu highlights/i }));
    expect(calls, 'the first click must only ask').toHaveLength(0);

    await user.click(within(row).getByRole('button', { name: /yes, deactivate/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 1, isActive: false }]));
  });

  it('reactivates a retired package in one click', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.packages.setActive': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Bantayan Weekend');

    await user.click(
      within(rowFor('Bantayan Weekend')).getByRole('button', { name: /reactivate/i }),
    );
    await waitFor(() => expect(calls).toEqual([{ id: 2, isActive: true }]));
  });

  it('posts integer centavos from a price typed in pesos', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.packages.create': (input: unknown) => {
        calls.push(input);
        return { id: 99 };
      },
    });
    await screen.findByText('Cebu Highlights');

    await user.click(screen.getByRole('button', { name: /add a package/i }));
    await user.type(screen.getByLabelText(/^slug/i), 'malapascua-3d2n');
    await user.type(screen.getByLabelText(/^title/i), 'Malapascua Thresher Sharks');
    await user.clear(screen.getByLabelText(/^days/i));
    await user.type(screen.getByLabelText(/^days/i), '3');
    await user.type(screen.getByLabelText(/price now/i), '12500.50');
    await user.click(screen.getByRole('button', { name: /^add package$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      slug: 'malapascua-3d2n',
      title: 'Malapascua Thresher Sharks',
      days: 3,
      // ₱12,500.50 as integer centavos, never a float.
      newPriceCentavos: 1_250_050,
      oldPriceCentavos: null,
    });
  });

  it('refuses a "was" price that is not higher, without calling the server', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.packages.create': (input: unknown) => {
        calls.push(input);
        return { id: 99 };
      },
    });
    await screen.findByText('Cebu Highlights');

    await user.click(screen.getByRole('button', { name: /add a package/i }));
    await user.type(screen.getByLabelText(/^slug/i), 'malapascua-3d2n');
    await user.type(screen.getByLabelText(/^title/i), 'Malapascua Thresher Sharks');
    await user.type(screen.getByLabelText(/price now/i), '12500');
    /*
     * `EntityForm` puts every OPTIONAL field behind its "More details"
     * disclosure, and `window.matchMedia` does not exist in jsdom, so the
     * disclosure starts collapsed here exactly as it does on a phone. The
     * "was" price is optional, so it has to be opened first.
     */
    await user.click(screen.getByRole('button', { name: /more details/i }));
    await user.type(await screen.findByLabelText(/was price/i), '9000');
    await user.click(screen.getByRole('button', { name: /^add package$/i }));

    // By role, not by text: the field's own HINT also says "has to be higher",
    // and the assertion that matters is that a refusal was RAISED beside the
    // input rather than that the words appear somewhere on the page.
    expect(await screen.findByRole('alert')).toHaveTextContent(/has to be higher/i);
    expect(calls).toHaveLength(0);
  });
});

describe('AdminPackagesPage — the enquiries', () => {
  /**
   * Every enquiry in the list draws the same three "Mark …" buttons, so the
   * accessible name has to say WHICH enquiry — otherwise a screen-reader user
   * tabbing the list hears "Mark closed" over and over with nothing to tell
   * them apart. Asserted globally (`screen`, not `within(row)`) on purpose:
   * scoping to the row would pass even if the label named nobody.
   */
  it('names the guest in each status button, so the labels are not all identical', async () => {
    renderPage();
    await screen.findByText('Maria Santos');

    expect(screen.getByRole('button', { name: /mark closed .*maria santos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark new .*john dela cruz/i })).toBeInTheDocument();
  });

  it('shows each enquiry with the package it is about, or that there is none', async () => {
    renderPage();
    await screen.findByText('Maria Santos');

    const about = rowFor('Maria Santos');
    expect(within(about).getByText(/Cebu Highlights/)).toBeInTheDocument();
    expect(within(about).getByText('maria@example.test')).toBeInTheDocument();
    expect(within(about).getByText(/collect us from the pier/i)).toBeInTheDocument();

    const general = rowFor('John Dela Cruz');
    expect(within(general).getByText(/general enquiry/i)).toBeInTheDocument();
  });

  it('counts the enquiries still waiting for an answer', async () => {
    renderPage();
    await screen.findByText('Maria Santos');
    expect(screen.getByText(/1 enquiry on this page waiting/i)).toBeInTheDocument();
  });

  /**
   * **The server paginates, the browser does not re-filter.** Mirrors
   * `admin-bookings.test.tsx`'s own pager test: assert on what was SENT
   * (`offset`), not on a client-side slice, since the mock cannot
   * re-slice a dataset the way the real server does.
   */
  it('pages forwards, and disables Previous on the first page', async () => {
    const sent: Array<Record<string, unknown>> = [];
    renderPage({
      'admin.inquiries.list': (input: unknown) => {
        sent.push(input as Record<string, unknown>);
        return inquiryPage([NEW_INQUIRY, GENERAL_INQUIRY], { total: 60 });
      },
    });
    await screen.findByText('Maria Santos');

    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(sent.at(-1)).toMatchObject({ offset: 25, limit: 25 });
  });

  it('changes an enquiry status and says which one it set', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.inquiries.setStatus': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('Maria Santos');
    const row = rowFor('Maria Santos');

    await user.click(within(row).getByRole('button', { name: /mark replied/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 10, status: 'replied' }]));
  });

  it('can put a closed enquiry back to new', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.inquiries.setStatus': (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    await screen.findByText('John Dela Cruz');

    await user.click(within(rowFor('John Dela Cruz')).getByRole('button', { name: /mark new/i }));
    await waitFor(() => expect(calls).toEqual([{ id: 11, status: 'new' }]));
  });

  it('shows the server refusal rather than a crash when a status change fails', async () => {
    renderPage();
    await screen.findByText('Maria Santos');
    mockTrpcError('admin.inquiries.setStatus', 'NOT_FOUND', 'No enquiry with that id.');

    const row = rowFor('Maria Santos');
    await user.click(within(row).getByRole('button', { name: /mark read/i }));

    expect(await within(row).findByText('No enquiry with that id.')).toBeInTheDocument();
  });
});

describe('AdminPackagesPage — the newsletter export', () => {
  it('downloads the file the server built, and says how many addresses it held', async () => {
    renderPage({
      'admin.newsletter.export': {
        filename: 'travelsugbo-newsletter-2026-10-27.csv',
        csv: 'Email\nmaria@example.test\njuan@example.test',
        count: 2,
      },
    });
    await screen.findByText('Cebu Highlights');

    await user.click(screen.getByRole('button', { name: /export the newsletter list/i }));

    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0]!.download).toBe('travelsugbo-newsletter-2026-10-27.csv');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.blob.type).toBe('text/csv;charset=utf-8');
    expect(await screen.findByText(/2 addresses/i)).toBeInTheDocument();
  });

  /**
   * Cosmetic only — the server refuses a dispatcher with FORBIDDEN, which is
   * `admin-packages.test.ts`'s assertion. This one is here so a dispatcher is
   * not shown a button that can only be refused.
   */
  it('is not drawn for a dispatcher, who still gets the packages and enquiries', async () => {
    renderPage({ 'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false } });
    await screen.findByText('Cebu Highlights');

    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export the newsletter list/i })).toBeNull();
  });

  it('shows the refusal rather than a crash when the export itself fails', async () => {
    renderPage();
    await screen.findByText('Cebu Highlights');
    mockTrpcError('admin.newsletter.export', 'FORBIDDEN', 'Not permitted for this account.');

    await user.click(screen.getByRole('button', { name: /export the newsletter list/i }));
    expect(await screen.findByText(/could not build that file/i)).toBeInTheDocument();
  });
});

describe('AdminPackagesPage — denied state', () => {
  it('shows the denied state, not a blank screen, when the role is finance', async () => {
    renderPage({ 'staffAuth.me': { userId: 3, role: 'finance', mustChangePassword: false } });
    expect(
      await screen.findByText(/only the owner and dispatcher can manage packages/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Cebu Highlights')).toBeNull();
  });

  it('shows the denied state when the package list itself is refused with FORBIDDEN', async () => {
    mockTrpcError('admin.packages.list', 'FORBIDDEN', 'Not permitted for this account.');
    mockTrpc({
      'staffAuth.me': { userId: 1, role: 'dispatcher', mustChangePassword: false },
      'admin.inquiries.list': inquiryPage([]),
    });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <AdminPackagesPage />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(
      await screen.findByText(/only the owner and dispatcher can manage packages/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Not permitted for this account.')).toBeNull();
  });
});
