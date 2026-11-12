/**
 * The packages and enquiries screen (Week 7 plan, Task 13 — 7C; BUILD_SPEC
 * §9 "Packages, inquiries").
 *
 * **The newsletter export's tests moved to `admin-coupons-page.test.tsx`**
 * (sign-up coupons plan, Task 1C, decision 5) along with the card itself —
 * see that file's own "the newsletter export" describe block. Nothing about
 * `admin.newsletter.export` changed server-side; only which page's client
 * renders the button.
 *
 * The server is the guard — `admin.packages.*` / `admin.inquiries.*` are
 * `adminProcedure('packagesInquiries')`. What is pinned here is what the
 * SCREEN promises: every package including the retired ones with the money
 * in pesos, enquiries newest first with the package they are about and a
 * status control, and a denied state rather than a blank page for a refused
 * role.
 *
 * The "quote & convert" control (Task T20; `admin.transferQuotes.convert` is
 * `adminProcedure('transferQuoting')`, owner and finance) is tested
 * cosmetically: drawn for an owner on an unconverted custom-trip request,
 * absent for a dispatcher who can see the same request read-only.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InquiryAdminRow, PackageAdminRow, VehicleTypeAdminRow } from '@rg/shared';
import AdminPackagesPage from '@/pages/admin/AdminPackagesPage';
import { TrpcProviders } from '@/lib/trpc';
import {
  mockTrpc,
  mockTrpcError,
  mockTrpcValidationError,
  resetTrpcMock,
} from './helpers/mock-trpc';

const user = userEvent.setup();

/*
 * Radix's `Select` needs three DOM APIs jsdom does not implement (see
 * `assign-panel.test.tsx`'s own note, the first file in this project to open
 * one) — without them the listbox never opens and every `getByRole('option')`
 * fails looking like a component bug rather than a jsdom gap. Shims, not
 * stubs of behaviour under test: pointer capture and scrolling are things a
 * real browser does that `ConvertInquiryForm`'s productType/vehicle-type
 * selects never ask about.
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
    requestedDate: null,
    pax: null,
    routeDescription: null,
    convertedBookingId: null,
    convertedBookingRef: null,
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
const TRANSFER_CUSTOM_INQUIRY = inquiry({
  id: 12,
  type: 'transfer_custom',
  status: 'new',
  packageId: null,
  packageTitle: null,
  name: 'Pedro Cruz',
  message: 'Can we add a stop on the way?',
  requestedDate: '2027-02-20',
  pax: 6,
  routeDescription: 'Cebu city to Moalboal',
});

/** `admin.inquiries.list`'s paginated result shape — mirrors `admin.bookings.list`. */
function inquiryPage(
  items: InquiryAdminRow[],
  overrides: Partial<{ total: number; limit: number; offset: number }> = {},
) {
  return { items, total: items.length, limit: 25, offset: 0, ...overrides };
}

function vehicleType(overrides: Partial<VehicleTypeAdminRow> = {}): VehicleTypeAdminRow {
  return {
    id: 1,
    name: 'Mini Van',
    slug: 'mini-van',
    defaultSeats: 10,
    defaultLuggage: 10,
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

const MINI_VAN = vehicleType();

function renderPage(extra: Record<string, unknown> = {}) {
  mockTrpc({
    'staffAuth.me': { userId: 1, role: 'owner', mustChangePassword: false },
    'admin.packages.list': [ACTIVE, RETIRED],
    'admin.inquiries.list': inquiryPage([NEW_INQUIRY, GENERAL_INQUIRY]),
    'admin.vehicleTypes.list': [MINI_VAN],
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

  it('shows a custom trip request with its travel date, pax and route (T17)', async () => {
    renderPage({
      'admin.inquiries.list': inquiryPage([NEW_INQUIRY, GENERAL_INQUIRY, TRANSFER_CUSTOM_INQUIRY]),
    });
    await screen.findByText('Pedro Cruz');

    const row = rowFor('Pedro Cruz');
    expect(within(row).getByText(/custom trip request/i)).toBeInTheDocument();
    expect(within(row).getByText('2027-02-20')).toBeInTheDocument();
    expect(within(row).getByText('6')).toBeInTheDocument();
    expect(within(row).getByText('Cebu city to Moalboal')).toBeInTheDocument();
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

describe('AdminPackagesPage — quote & convert to booking (T20)', () => {
  const CONVERTED_INQUIRY = inquiry({
    id: 13,
    type: 'transfer_custom',
    status: 'closed',
    packageId: null,
    packageTitle: null,
    name: 'Ana Reyes',
    requestedDate: '2027-04-01',
    pax: 2,
    routeDescription: 'Cebu city to Oslob',
    convertedBookingId: 99,
    convertedBookingRef: 'TR-99',
  });

  /**
   * Fills every field the review step needs for a one-way quote.
   *
   * `date` is cleared first: `TRANSFER_CUSTOM_INQUIRY.requestedDate` already
   * pre-fills the pickup-date box (T20's own "staff confirm the date" intent
   * for a `requestedDate` the guest gave), so typing onto it without clearing
   * would append onto `2027-02-20` rather than replace it.
   */
  async function fillOneWayFields(row: HTMLElement) {
    await user.clear(within(row).getByLabelText(/^pickup date$/i));
    await user.type(within(row).getByLabelText(/^pickup date$/i), '2027-03-01');
    await user.type(within(row).getByLabelText(/^pickup time$/i), '08:30');
    await user.type(within(row).getByLabelText(/trip duration/i), '90');
    await user.type(within(row).getByLabelText(/drop-off address/i), 'Moalboal White Beach');
    await user.type(within(row).getByLabelText(/quoted price/i), '2500.00');
  }

  it('offers the control only for an unconverted custom-trip request, for an owner', async () => {
    renderPage({
      'admin.inquiries.list': inquiryPage([
        NEW_INQUIRY,
        TRANSFER_CUSTOM_INQUIRY,
        CONVERTED_INQUIRY,
      ]),
    });
    await screen.findByText('Pedro Cruz');
    // `admin.vehicleTypes.list` resolves after the inquiry list does; the
    // control only draws (rather than the "no vehicle type" notice) once it
    // has.
    await within(rowFor('Pedro Cruz')).findByRole('button', { name: /quote.*convert/i });

    expect(
      within(rowFor('Maria Santos')).queryByRole('button', { name: /quote.*convert/i }),
    ).toBeNull();
    expect(
      within(rowFor('Ana Reyes')).queryByRole('button', { name: /quote.*convert/i }),
    ).toBeNull();
    // The already-converted request still shows its booking ref.
    expect(within(rowFor('Ana Reyes')).getByText('TR-99')).toBeInTheDocument();
  });

  it('is cosmetically absent for a dispatcher, who still sees the request read-only', async () => {
    renderPage({
      'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false },
      'admin.inquiries.list': inquiryPage([NEW_INQUIRY, TRANSFER_CUSTOM_INQUIRY]),
    });
    await screen.findByText('Pedro Cruz');

    expect(within(rowFor('Pedro Cruz')).getByText(/custom trip request/i)).toBeInTheDocument();
    expect(
      within(rowFor('Pedro Cruz')).queryByRole('button', { name: /quote.*convert/i }),
    ).toBeNull();
  });

  /*
   * Named, not a dead end: with no active vehicle type to offer, the convert
   * control would otherwise default `vehicleTypeId` to `''` and surface a
   * bare Zod "greater than 0" message on a select with no options — the gap
   * the advisor flagged. Covers both the owner-genuinely-has-none case and
   * (via the same empty list) the day `admin.vehicleTypes.list`'s own
   * owner-only gate is the thing standing between a finance session and this
   * control.
   */
  it('names the gap rather than offering a dead-end control when no vehicle type is active', async () => {
    renderPage({
      'admin.inquiries.list': inquiryPage([TRANSFER_CUSTOM_INQUIRY]),
      'admin.vehicleTypes.list': [],
    });
    await screen.findByText('Pedro Cruz');
    const row = rowFor('Pedro Cruz');

    expect(await within(row).findByText(/no vehicle type is available/i)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /quote.*convert/i })).toBeNull();
  });

  it('pre-fills the guest-given phone and pax, converts, and shows the booking ref', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.inquiries.list': inquiryPage([TRANSFER_CUSTOM_INQUIRY]),
      'admin.transferQuotes.convert': (input: unknown) => {
        calls.push(input);
        return { ref: 'TR-1001', bookingId: 1001, holdExpiresAt: new Date().toISOString() };
      },
    });
    await screen.findByText('Pedro Cruz');
    const row = rowFor('Pedro Cruz');

    await user.click(await within(row).findByRole('button', { name: /quote.*convert/i }));
    expect(within(row).getByLabelText(/^passengers$/i)).toHaveValue(6);
    expect(within(row).getByLabelText(/phone we can call/i)).toHaveValue('09170000000');

    await fillOneWayFields(row);
    await user.click(within(row).getByRole('button', { name: /review & convert/i }));

    // The confirm step states the price in figures and in words.
    expect(within(row).getByText(/₱2,500/)).toBeInTheDocument();
    expect(within(row).getByText(/two thousand five hundred pesos/i)).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: /confirm — convert to a booking/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      inquiryId: 12,
      vehicleTypeId: 1,
      productType: 'transfer_one_way',
      date: '2027-03-01',
      pickupTime: '08:30',
      customRouteDurationMinutes: 90,
      pax: 6,
      luggageCount: 0,
      dropoffAddress: 'Moalboal White Beach',
      // `phPhoneSchema` normalises the guest's locally-typed number — same
      // normalisation `createHoldInput.lead.phone` applies (T19's own note).
      leadPhone: '+639170000000',
      priceCentavos: 250_000,
    });
    expect(await within(row).findByText(/converted to booking: TR-1001/i)).toBeInTheDocument();
  });

  it('blocks on a badly-typed price, inline, without calling the server', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.inquiries.list': inquiryPage([TRANSFER_CUSTOM_INQUIRY]),
      'admin.transferQuotes.convert': (input: unknown) => {
        calls.push(input);
        return { ref: 'TR-1001', bookingId: 1001, holdExpiresAt: new Date().toISOString() };
      },
    });
    await screen.findByText('Pedro Cruz');
    const row = rowFor('Pedro Cruz');

    await user.click(await within(row).findByRole('button', { name: /quote.*convert/i }));
    await fillOneWayFields(row);
    await user.clear(within(row).getByLabelText(/quoted price/i));
    await user.type(within(row).getByLabelText(/quoted price/i), '12.345');
    await user.click(within(row).getByRole('button', { name: /review & convert/i }));

    expect(await within(row).findByRole('alert')).toHaveTextContent(/enter a quoted price/i);
    expect(calls).toHaveLength(0);
  });

  it('places a server-side priceCentavos refusal on the price box, not only the banner', async () => {
    renderPage({ 'admin.inquiries.list': inquiryPage([TRANSFER_CUSTOM_INQUIRY]) });
    await screen.findByText('Pedro Cruz');
    const row = rowFor('Pedro Cruz');

    await user.click(await within(row).findByRole('button', { name: /quote.*convert/i }));
    await fillOneWayFields(row);
    await user.click(within(row).getByRole('button', { name: /review & convert/i }));
    expect(within(row).getByText(/₱2,500/)).toBeInTheDocument();

    // `transferQuoteConvertInput`'s own `MAX_CENTAVOS` cap (T19 follow-up),
    // keyed `priceCentavos` — this form's only box of that name is `priceInput`.
    mockTrpcValidationError('admin.transferQuotes.convert', {
      fieldErrors: { priceCentavos: ['That price is too large — please double-check it.'] },
    });
    await user.click(within(row).getByRole('button', { name: /confirm — convert to a booking/i }));

    const priceField = await within(row).findByLabelText(/quoted price/i);
    expect(priceField).toHaveAttribute('aria-invalid', 'true');
    expect(within(row).getByRole('alert')).toHaveTextContent(/too large/i);
  });

  it('switching to day-use drops the one-way-only fields from what is sent, not just hides them', async () => {
    const calls: unknown[] = [];
    renderPage({
      'admin.inquiries.list': inquiryPage([TRANSFER_CUSTOM_INQUIRY]),
      'admin.transferQuotes.convert': (input: unknown) => {
        calls.push(input);
        return { ref: 'TR-1002', bookingId: 1002, holdExpiresAt: new Date().toISOString() };
      },
    });
    await screen.findByText('Pedro Cruz');
    const row = rowFor('Pedro Cruz');

    await user.click(await within(row).findByRole('button', { name: /quote.*convert/i }));
    // Type a one-way-only value, then switch away from it.
    await user.type(within(row).getByLabelText(/trip duration/i), '90');

    await user.click(within(row).getByRole('combobox', { name: /trip type/i }));
    await user.click(await screen.findByRole('option', { name: /day-use hire/i }));

    expect(within(row).queryByLabelText(/trip duration/i)).toBeNull();
    await user.type(within(row).getByLabelText(/vehicle needed until/i), '18:00');
    await user.clear(within(row).getByLabelText(/^pickup date$/i));
    await user.type(within(row).getByLabelText(/^pickup date$/i), '2027-03-01');
    await user.type(within(row).getByLabelText(/^pickup time$/i), '08:30');
    await user.type(within(row).getByLabelText(/drop-off address/i), 'Oslob Whale Sharks');
    await user.type(within(row).getByLabelText(/quoted price/i), '3000.00');

    await user.click(within(row).getByRole('button', { name: /review & convert/i }));
    await user.click(within(row).getByRole('button', { name: /confirm — convert to a booking/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const sent = calls[0] as Record<string, unknown>;
    expect(sent.productType).toBe('transfer_day_use');
    expect(sent.dayUseEndTime).toBe('18:00');
    expect(sent).not.toHaveProperty('customRouteDurationMinutes');
  });
});

/**
 * The newsletter export button no longer renders on this page at all (moved
 * to `AdminCouponsPage.tsx`'s "Sign-up coupons" section — see this file's
 * own header comment), for any role — not only hidden from a dispatcher.
 */
it('never renders the newsletter export button here any more, for any role', async () => {
  renderPage();
  await screen.findByText('Cebu Highlights');
  expect(screen.queryByRole('button', { name: /export the newsletter list/i })).toBeNull();
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
