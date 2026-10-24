/**
 * The settings screens (Week 7 plan, Task 9). `admin.settings.*` is
 * `adminProcedure('usersSettings')` server-side — owner only; what is pinned
 * here is what the SCREEN itself promises.
 *
 * Three groups of claims, and they are different kinds of claim:
 *
 *  1. **The spec covers the table.** Every key in `@rg/shared`'s
 *     `SETTING_KEYS` appears in exactly one group and has a block. A key added
 *     to the shared list with no screen is invisible rather than broken, which
 *     is why this is a test and not a comment.
 *  2. **The conversion sends the stored TYPE.** `settings.value` is a JSON
 *     column, so `"30"` and `30` are genuinely different stored values and
 *     only one of them passes the block's schema. `fromFormRow` is driven
 *     directly for that, because the proof is about the payload rather than
 *     about any rendering.
 *  3. **The screen behaves.** The five groups are drawn, a block saves what
 *     was typed as the type the server wants, a refusal shows the SERVER's own
 *     sentence rather than a generic one, clearing `content_unverified` takes
 *     two deliberate taps, and a non-owner gets a denied state rather than a
 *     blank page.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '@rg/shared';
import AdminSettingsPage from '@/pages/admin/AdminSettingsPage';
import {
  BLOCKS,
  BLOCKS_BY_KEY,
  GROUPS,
  fromFormRow,
  toFormRow,
  type FieldSpec,
} from '@/components/admin/settings-blocks';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const user = userEvent.setup();

afterEach(() => {
  resetTrpcMock();
});

/** A full, valid set of seventeen raw blocks — the shape `admin.settings.all` returns. */
const STORED: Record<string, unknown> = {
  content_unverified: true,
  site_seo: { title: 'TravelSugbo', description: 'Cebu day tours', ogImage: null },
  trust: {
    ratingAverage: null,
    ratingCount: null,
    guestsServed: 1200,
    dotAccredited: false,
    depositPercent: 30,
    minReviewsForRating: 3,
  },
  hero: {
    eyebrow: 'Cebu, Philippines',
    headline: 'Book your Cebu tour',
    subtitle: 'Day tours and packages',
    ctaLabel: 'Book now',
    imagePath: '/placeholders/hero.svg',
    imageAlt: 'Cebu coastline',
  },
  announcement: {
    message: 'Limited slots',
    href: null,
    style: 'info',
    startsAt: null,
    endsAt: null,
    isActive: true,
  },
  promo: {
    code: 'EARLYBIRD',
    discountLabel: '10% off',
    headline: 'Book early',
    body: 'Save on your next trip',
    startsAt: null,
    endsAt: null,
    isActive: false,
  },
  business_hours: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    opensAt: '07:00',
    closesAt: '20:00',
    isClosed: false,
  })),
  payment_methods: [{ key: 'gcash', label: 'GCash', enabled: true, sortOrder: 1 }],
  permits: { dot: null, dti: null, bir: null },
  how_it_works: [{ step: 1, title: 'Pick a tour', body: 'Choose a date' }],
  why_book_direct: [{ icon: 'shield', title: 'Direct', body: 'No middleman' }],
  faqs: [{ q: 'How do I pay?', a: '{{paymentMethods}}' }],
  contact: {
    address: 'Cebu City',
    tagline: 'Your Cebu guides',
    hoursNote: 'Daily',
    email: 'hello@example.test',
    phoneDisplay: '0917 000 0000',
    phoneTel: '639170000000',
    whatsapp: '639170000000',
    altPhoneDisplay: '',
    altPhoneTel: '',
    facebook: 'travelsugbo',
    motto: 'Explore Cebu',
    otherServices: { before: 'We also offer', link: 'transfers', after: 'on request.' },
  },
  booking: { minLeadDays: 1, nextDayCutoffTime: '17:00', maxAdvanceDays: 180 },
  payment_qr: {
    imagePath: null,
    accountName: null,
    accountNumber: null,
    instructions: null,
    isConfigured: false,
  },
  legal_privacy: { markdown: '# Privacy', updatedAt: '2026-01-01T00:00:00.000Z' },
  legal_terms: { markdown: '# Terms', updatedAt: '2026-01-01T00:00:00.000Z' },
};

function renderPage() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminSettingsPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

/** Opens one block's disclosure by its summary text and returns the `<details>`. */
async function openBlock(title: string | RegExp): Promise<HTMLElement> {
  const summary = await screen.findByText(title);
  await user.click(summary);
  const details = summary.closest('details');
  if (!details) throw new Error('the summary is not inside a <details>');
  return details as HTMLElement;
}

/* ------------------------------------------------------------------ The spec */

describe('the settings block spec', () => {
  it('gives every shared settings key exactly one group and one block', () => {
    const grouped = GROUPS.flatMap((group) => group.keys);
    expect([...grouped].sort()).toEqual([...SETTING_KEYS].sort());
    // Exactly one, not "at least one": a key in two groups would draw two
    // editors for one row and whichever saved last would win silently.
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const key of SETTING_KEYS) {
      expect(BLOCKS_BY_KEY.get(key), `${key} has no block spec`).toBeDefined();
    }
    expect(BLOCKS).toHaveLength(SETTING_KEYS.length);
  });

  it('gives every drawn field a label, and every select some options', () => {
    for (const block of BLOCKS) {
      for (const field of block.fields) {
        if (field.kind === 'stamp' || field.kind === 'rowIndex') continue;
        expect(field.label.length, `${block.key}.${field.name} has no label`).toBeGreaterThan(0);
        if (field.kind === 'select') {
          expect((field.options ?? []).length, `${block.key}.${field.name}`).toBeGreaterThan(1);
        }
      }
    }
  });
});

/* ------------------------------------------------- The conversion, directly */

describe('fromFormRow', () => {
  const fields: readonly FieldSpec[] = [
    { name: 'depositPercent', label: 'Deposit', kind: 'number' },
    { name: 'ratingAverage', label: 'Rating', kind: 'number', nullable: true },
    {
      name: 'dotAccredited',
      label: 'DOT',
      kind: 'select',
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
  ];

  /**
   * The `select` above is a hand-written yes/no pair rather than the shared
   * `YES_NO` constant, on purpose: `fromFormRow` recognises a boolean by
   * comparing `options` to that exact array BY REFERENCE, so this proves the
   * recogniser is not matching any two-option select by shape — a copy of the
   * pair stays a string, which is what keeps `announcement.style` (also two
   * options) from being turned into a boolean.
   */
  it('keeps a look-alike yes/no select a STRING, since only the shared pair is a boolean', () => {
    const { record } = fromFormRow(
      { depositPercent: '30', ratingAverage: '', dotAccredited: 'true' },
      fields,
      0,
      new Date(),
    );
    expect(record.dotAccredited).toBe('true');
  });

  it('sends a number as a number and an empty optional field as null', () => {
    const { record, errors } = fromFormRow(
      { depositPercent: '30', ratingAverage: '', dotAccredited: 'false' },
      fields,
      0,
      new Date(),
    );
    expect(errors).toEqual({});
    expect(record.depositPercent).toBe(30);
    expect(record.ratingAverage).toBeNull();
  });

  it('refuses a non-number inline rather than sending it', () => {
    const { errors } = fromFormRow(
      { depositPercent: 'thirty', ratingAverage: '', dotAccredited: 'false' },
      fields,
      0,
      new Date(),
    );
    expect(errors.depositPercent).toMatch(/number/i);
  });

  it('stamps a stamp field with the instant it was given, and a rowIndex with its position', () => {
    const now = new Date('2026-05-04T03:02:01.000Z');
    const { record } = fromFormRow(
      {},
      [
        { name: 'updatedAt', label: 'Updated', kind: 'stamp' },
        { name: 'weekday', label: 'Weekday', kind: 'rowIndex' },
      ],
      4,
      now,
    );
    expect(record.updatedAt).toBe('2026-05-04T03:02:01.000Z');
    expect(record.weekday).toBe(4);
  });

  it('round-trips the real contact block, nested field and all', () => {
    const block = BLOCKS_BY_KEY.get('contact')!;
    const row = toFormRow(STORED.contact, block.fields);
    const { record, errors } = fromFormRow(row, block.fields, 0, new Date());
    expect(errors).toEqual({});
    expect(record).toEqual(STORED.contact);
  });

  /**
   * The seven business-hours rows keep their weekday from their POSITION, so
   * reordering is impossible and nobody can type weekday 9.
   */
  it('round-trips business_hours with the weekday taken from the row position', () => {
    const block = BLOCKS_BY_KEY.get('business_hours')!;
    const rows = (STORED.business_hours as unknown[]).map((entry) =>
      toFormRow(entry, block.fields),
    );
    const value = rows.map(
      (row, index) => fromFormRow(row, block.fields, index, new Date()).record,
    );
    expect(value).toEqual(STORED.business_hours);
  });
});

/* ------------------------------------------------------------------ The screen */

describe('AdminSettingsPage', () => {
  function mockOwner(extra: Record<string, unknown> = {}) {
    mockTrpc({
      'staffAuth.me': { userId: 1, role: 'owner' },
      'admin.settings.all': STORED,
      ...extra,
    });
  }

  it('draws the five groups and a disclosure for every block', async () => {
    mockOwner();
    renderPage();

    for (const group of GROUPS) {
      expect(await screen.findByRole('heading', { name: group.title, level: 2 })).toBeVisible();
    }
    for (const block of BLOCKS) {
      expect(await screen.findByText(block.title)).toBeInTheDocument();
    }
  });

  it('sends what was typed as the TYPE the server stores, not as strings', async () => {
    const posted: unknown[] = [];
    mockOwner({
      'admin.settings.write': (input: unknown) => {
        posted.push(input);
        return { ok: true };
      },
    });
    renderPage();

    const details = await openBlock('Bookable date window');
    const furthest = within(details).getByLabelText('Furthest ahead, in days');
    await user.clear(furthest);
    await user.type(furthest, '120');
    await user.click(within(details).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      key: 'booking',
      // Integers and a clock string — never "120".
      value: { minLeadDays: 1, nextDayCutoffTime: '17:00', maxAdvanceDays: 120 },
    });
    expect(await within(details).findByRole('status')).toHaveTextContent('Saved.');
  });

  /**
   * The server's refusal for `booking` names the field and says why no date
   * would be bookable. The screen must show THAT sentence: a generic "could
   * not save" would leave an owner guessing which of three fields was wrong.
   */
  it('shows the SERVER’s own sentence when a block is refused', async () => {
    const message =
      'settings.booking was not saved — maxAdvanceDays must not be below minLeadDays: no date would be bookable';
    mockOwner();
    // A real BAD_REQUEST / 400, through the helper — the screen only passes a
    // server sentence through for a refusal under 500, so a 500 standing in
    // for a 400 here would prove the opposite of what this test claims.
    mockTrpcError('admin.settings.write', 'BAD_REQUEST', message);
    renderPage();

    const details = await openBlock('Bookable date window');
    await user.click(within(details).getByRole('button', { name: 'Save' }));

    const alert = await within(details).findByRole('alert');
    expect(alert).toHaveTextContent('no date would be bookable');
  });

  /**
   * Clearing `content_unverified` publishes the whole site to every search
   * index. One tap must not do it.
   */
  it('takes two deliberate taps to publish the site to search engines', async () => {
    const posted: unknown[] = [];
    mockOwner({
      'admin.settings.write': (input: unknown) => {
        posted.push(input);
        return { ok: true };
      },
    });
    renderPage();

    const details = await openBlock(/content verification/i);
    await user.click(within(details).getByRole('button', { name: /mark the content verified/i }));
    // Still nothing sent — that tap only asked for confirmation.
    expect(posted).toHaveLength(0);
    expect(
      within(details).getByRole('group', { name: /confirm publishing the site/i }),
    ).toBeVisible();

    await user.click(
      within(details).getByRole('button', { name: /yes, publish the site to search engines/i }),
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ key: 'content_unverified', value: false });
  });

  it('adds and removes a row on a repeating block, and sends the whole list', async () => {
    const posted: unknown[] = [];
    mockOwner({
      'admin.settings.write': (input: unknown) => {
        posted.push(input);
        return { ok: true };
      },
    });
    renderPage();

    const details = await openBlock('Frequently asked questions');
    await user.click(within(details).getByRole('button', { name: /add an entry/i }));
    await user.type(
      within(details).getByLabelText(/^Question$/, { selector: '#faqs-1-q' }),
      'Why?',
    );
    await user.type(
      within(details).getByLabelText(/^Answer$/, { selector: '#faqs-1-a' }),
      'Because.',
    );
    await user.click(within(details).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      key: 'faqs',
      value: [
        { q: 'How do I pay?', a: '{{paymentMethods}}' },
        { q: 'Why?', a: 'Because.' },
      ],
    });
  });

  /**
   * CLAUDE.md: 44px minimum tap targets, and most of this console is used on a
   * phone. Every control inside an opened block carries `.tap-target`
   * (`min-h-11 min-w-11`) — asserted over whatever the block renders rather
   * than over a list of names, so a field type added later is covered too.
   */
  it('gives every control in an opened block a 44px tap target', async () => {
    mockOwner();
    renderPage();

    const details = await openBlock('Transfer QR and account');
    const controls = [
      ...within(details).getAllByRole('textbox'),
      ...within(details).getAllByRole('combobox'),
      ...within(details).getAllByRole('button'),
    ];
    expect(controls.length).toBeGreaterThan(4);
    for (const control of controls) {
      expect(control.className, `${control.id || control.textContent} is under 44px`).toMatch(
        /tap-target/,
      );
    }
  });

  /** `business_hours` is exactly seven days — the screen offers no way to change that. */
  it('offers no Add or Remove on the fixed-length business hours', async () => {
    mockOwner();
    renderPage();

    const details = await openBlock('Business hours');
    expect(within(details).queryByRole('button', { name: /add an entry/i })).toBeNull();
    expect(within(details).queryByRole('button', { name: /^remove/i })).toBeNull();
    // And every weekday is named, so a row cannot be misread for another.
    expect(within(details).getByRole('heading', { name: 'Sunday', level: 4 })).toBeVisible();
    expect(within(details).getByRole('heading', { name: 'Saturday', level: 4 })).toBeVisible();
  });

  /** The markdown blocks get a plain textarea and say so. No preview, no library. */
  it('edits the legal documents in a plain textarea, noting that they render as Markdown', async () => {
    mockOwner();
    renderPage();

    const details = await openBlock('Privacy notice');
    const area = within(details).getByLabelText(/privacy notice \(markdown\)/i);
    expect(area.tagName).toBe('TEXTAREA');
    expect(details.textContent).toMatch(/rendered as Markdown/i);
    expect(area).toHaveValue('# Privacy');
  });

  it('gives a dispatcher a denied state rather than seventeen forms', async () => {
    mockTrpc({
      'staffAuth.me': { userId: 2, role: 'dispatcher', mustChangePassword: false },
      'admin.settings.all': STORED,
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the owner can change the settings.',
    );
    expect(screen.queryByText('Business hours')).toBeNull();
  });
});
