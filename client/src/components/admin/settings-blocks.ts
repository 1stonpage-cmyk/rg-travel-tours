/**
 * What each of the seventeen `settings` blocks looks like on the admin screen,
 * and how its fields convert to and from the stored JSON (Week 7 plan, Task 9).
 *
 * Separate from `AdminSettingsPage.tsx` for two reasons: the page then holds
 * only components, and the conversion in here — the part where `"30"` must
 * become `30` and an empty optional field must become `null` — is plain
 * functions a test can drive without rendering anything.
 *
 * **This file describes the SHAPE of a block, never its validity.** The one
 * validator is `SETTING_SCHEMAS[key]` on the server, called by
 * `writeSettingBlock()`; a second opinion here about what a block may contain
 * is how the two drift, and a block written past its own schema is a block
 * `readSettings()` throws on — which takes the public site down with it
 * (BUG-023). So the field list says "this is a number" in order to send a
 * number rather than a string, and says nothing about what numbers are
 * allowed.
 *
 * Every key in `@rg/shared`'s `SETTING_KEYS` appears in exactly one group, and
 * `client/src/__tests__/admin-settings-page.test.tsx` fails if one does not: a
 * key added to the shared list with no group would be a setting the owner has
 * no screen for, which is invisible rather than broken.
 */
import type { SettingKey } from '@rg/shared';
import { manilaLocalToUtcIso, utcIsoToManilaLocal } from '@/lib/manila-datetime';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'time'
  /** A UTC ISO instant, typed and shown as Asia/Manila wall clock. */
  | 'manilaDatetime'
  /** Not drawn: stamped with the current instant on every save. */
  | 'stamp'
  /** Not drawn: the row's position, for a fixed-length list. */
  | 'rowIndex'
  /**
   * Not drawn, and not editable here at all — the value passes through on
   * Save exactly as loaded. `payment_qr.imagePath` is the one case: it is
   * set by its own upload widget (`PaymentQrImage` in
   * `AdminSettingsPage.tsx`), never typed, so the generic grid must neither
   * show it nor let a stale form value overwrite a newer upload.
   */
  | 'hidden';

export interface FieldSpec {
  /** Dotted path inside the block, or inside one row of an array block. */
  name: string;
  label: string;
  kind: FieldKind;
  /** An empty field means `null` rather than `''`. */
  nullable?: boolean;
  options?: readonly { value: string; label: string }[];
  hint?: string;
  rows?: number;
}

export interface BlockSpec {
  key: SettingKey;
  title: string;
  blurb: string;
  /** `flag` is `content_unverified` alone: a bare boolean, not a record. */
  shape: 'object' | 'array' | 'flag';
  fields: readonly FieldSpec[];
  /** array only: what one row is called — "Question 2", "Monday". */
  rowName?: (index: number) => string;
  /** array only: the list has a fixed length (`business_hours` is exactly 7). */
  fixedLength?: boolean;
}

export interface GroupSpec {
  id: string;
  title: string;
  blurb: string;
  keys: readonly SettingKey[];
}

/**
 * The yes/no option pair, and the marker that a `select` is a BOOLEAN.
 *
 * `fromFormRow` compares a field's `options` against this exact array by
 * reference to decide whether to send `true` / `false` or the string the
 * option carries. That is what keeps one list of two options from needing a
 * second "this is really a boolean" flag beside it on fourteen fields.
 */
export const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const;

/** Weekday 0 = Sunday, matching `business_hours[].weekday`. */
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** `startsAt` / `endsAt` / `isActive`, shared by `announcement` and `promo`. */
const SCHEDULE_FIELDS: readonly FieldSpec[] = [
  {
    name: 'startsAt',
    label: 'Starts',
    kind: 'manilaDatetime',
    nullable: true,
    hint: 'Asia/Manila. Blank means no start limit.',
  },
  {
    name: 'endsAt',
    label: 'Ends',
    kind: 'manilaDatetime',
    nullable: true,
    hint: 'Asia/Manila. Blank means no end limit.',
  },
  { name: 'isActive', label: 'Switched on', kind: 'select', options: YES_NO },
];

export const BLOCKS: readonly BlockSpec[] = [
  {
    key: 'content_unverified',
    title: 'Content verification and search indexing',
    blurb:
      'While this is on, the whole site is kept out of every search index and a production build is blocked. Clearing it is what publishes the site.',
    shape: 'flag',
    fields: [],
  },
  {
    key: 'site_seo',
    title: 'Site title and description',
    blurb: 'The default page title and description, used wherever a page has none of its own.',
    shape: 'object',
    fields: [
      { name: 'title', label: 'Site title', kind: 'text' },
      { name: 'description', label: 'Site description', kind: 'textarea', rows: 3 },
      {
        name: 'ogImage',
        label: 'Share image path',
        kind: 'text',
        nullable: true,
        hint: 'The image shown when a link is shared. Blank for none.',
      },
    ],
  },
  {
    key: 'hero',
    title: 'Home page hero',
    blurb: 'The first thing a guest sees, and its image.',
    shape: 'object',
    fields: [
      { name: 'eyebrow', label: 'Eyebrow', kind: 'text' },
      { name: 'headline', label: 'Headline', kind: 'text' },
      { name: 'subtitle', label: 'Subtitle', kind: 'textarea', rows: 2 },
      { name: 'ctaLabel', label: 'Button label', kind: 'text' },
      { name: 'imagePath', label: 'Image path', kind: 'text' },
      {
        name: 'imageAlt',
        label: 'Image alt text',
        kind: 'text',
        hint: 'Describe the photo for a guest using a screen reader.',
      },
    ],
  },
  {
    key: 'announcement',
    title: 'Announcement bar',
    blurb: 'The strip across the top of the site. Info or warning only — this site uses no red.',
    shape: 'object',
    fields: [
      { name: 'message', label: 'Message', kind: 'textarea', rows: 2 },
      { name: 'href', label: 'Link', kind: 'text', nullable: true, hint: 'Blank for no link.' },
      {
        name: 'style',
        label: 'Style',
        kind: 'select',
        options: [
          { value: 'info', label: 'Info (blue)' },
          { value: 'warning', label: 'Warning (amber)' },
        ],
      },
      ...SCHEDULE_FIELDS,
    ],
  },
  {
    key: 'promo',
    title: 'Promotion panel',
    blurb: 'The promotion shown on the home page. The code itself is set up under Coupons.',
    shape: 'object',
    fields: [
      { name: 'code', label: 'Code shown', kind: 'text' },
      { name: 'discountLabel', label: 'Discount label', kind: 'text' },
      { name: 'headline', label: 'Headline', kind: 'text' },
      { name: 'body', label: 'Body', kind: 'textarea', rows: 3 },
      ...SCHEDULE_FIELDS,
    ],
  },
  {
    key: 'how_it_works',
    title: 'How it works',
    blurb: 'The numbered steps on the home page.',
    shape: 'array',
    rowName: (index) => `Step ${index + 1}`,
    fields: [
      { name: 'step', label: 'Step number', kind: 'number' },
      { name: 'title', label: 'Title', kind: 'text' },
      { name: 'body', label: 'Body', kind: 'textarea', rows: 2 },
    ],
  },
  {
    key: 'why_book_direct',
    title: 'Why book direct',
    blurb: 'The reasons panel on the home page.',
    shape: 'array',
    rowName: (index) => `Reason ${index + 1}`,
    fields: [
      { name: 'icon', label: 'Icon name', kind: 'text' },
      { name: 'title', label: 'Title', kind: 'text' },
      { name: 'body', label: 'Body', kind: 'textarea', rows: 2 },
    ],
  },
  {
    key: 'faqs',
    title: 'Frequently asked questions',
    blurb:
      'Shown on the home page and published as structured data for search engines. The payment answer may contain {{paymentMethods}}, which is replaced with the methods switched on below.',
    shape: 'array',
    rowName: (index) => `Question ${index + 1}`,
    fields: [
      { name: 'q', label: 'Question', kind: 'text' },
      { name: 'a', label: 'Answer', kind: 'textarea', rows: 3 },
    ],
  },
  {
    key: 'business_hours',
    title: 'Business hours',
    blurb:
      'Asia/Manila, 24-hour, as HH:MM — 07:00, not 7am. Exactly seven days, so days are not added or removed here.',
    shape: 'array',
    fixedLength: true,
    rowName: (index) => WEEKDAYS[index] ?? `Day ${index}`,
    fields: [
      { name: 'weekday', label: 'Weekday', kind: 'rowIndex' },
      { name: 'opensAt', label: 'Opens', kind: 'time', nullable: true },
      { name: 'closesAt', label: 'Closes', kind: 'time', nullable: true },
      { name: 'isClosed', label: 'Closed all day', kind: 'select', options: YES_NO },
    ],
  },
  {
    key: 'contact',
    title: 'Contact details',
    blurb: 'Shown in the footer, on the contact page and in the chat deep links.',
    shape: 'object',
    fields: [
      { name: 'address', label: 'Address', kind: 'textarea', rows: 2 },
      { name: 'tagline', label: 'Tagline', kind: 'text' },
      { name: 'hoursNote', label: 'Hours note', kind: 'text' },
      { name: 'email', label: 'Email', kind: 'text' },
      { name: 'phoneDisplay', label: 'Phone (as shown)', kind: 'text' },
      {
        name: 'phoneTel',
        label: 'Phone (for dialling)',
        kind: 'text',
        hint: 'Digits with the country code — this is what a tap dials.',
      },
      { name: 'whatsapp', label: 'WhatsApp number', kind: 'text' },
      { name: 'altPhoneDisplay', label: 'Second phone (as shown)', kind: 'text' },
      { name: 'altPhoneTel', label: 'Second phone (for dialling)', kind: 'text' },
      { name: 'facebook', label: 'Facebook page', kind: 'text' },
      { name: 'motto', label: 'Motto', kind: 'text' },
      { name: 'otherServices.before', label: 'Other services — text before', kind: 'text' },
      { name: 'otherServices.link', label: 'Other services — link text', kind: 'text' },
      { name: 'otherServices.after', label: 'Other services — text after', kind: 'text' },
    ],
  },
  {
    key: 'booking',
    title: 'Bookable date window',
    blurb:
      'How soon and how far ahead a guest may book. The server refuses a window with no bookable date in it.',
    shape: 'object',
    fields: [
      {
        name: 'minLeadDays',
        label: 'Earliest, in days from today',
        kind: 'number',
        hint: '0 means today is bookable; 1 means tomorrow is the earliest.',
      },
      {
        name: 'nextDayCutoffTime',
        label: 'Same-day cutoff',
        kind: 'time',
        hint: 'Asia/Manila. At or after it, the earliest bookable date moves out one more day.',
      },
      {
        name: 'maxAdvanceDays',
        label: 'Furthest ahead, in days',
        kind: 'number',
        hint: 'Must not be below the earliest, or no date would be bookable at all.',
      },
    ],
  },
  {
    key: 'permits',
    title: 'Accreditation numbers',
    blurb:
      'DOT, DTI and BIR registrations held by R&G Travel & Tours. Leave a field blank until the real number is in hand — the site then says "pending". Never invent one.',
    shape: 'object',
    fields: [
      { name: 'dot', label: 'DOT accreditation', kind: 'text', nullable: true },
      { name: 'dti', label: 'DTI registration', kind: 'text', nullable: true },
      { name: 'bir', label: 'BIR registration', kind: 'text', nullable: true },
    ],
  },
  {
    key: 'payment_methods',
    title: 'Payment methods offered',
    blurb: 'Only the switched-on methods reach the website, in the order below.',
    shape: 'array',
    rowName: (index) => `Method ${index + 1}`,
    fields: [
      { name: 'key', label: 'Key', kind: 'text', hint: 'The internal name, e.g. gcash.' },
      { name: 'label', label: 'Label shown to guests', kind: 'text' },
      { name: 'enabled', label: 'Offered', kind: 'select', options: YES_NO },
      { name: 'sortOrder', label: 'Order', kind: 'number' },
    ],
  },
  {
    key: 'payment_qr',
    title: 'Transfer QR and account',
    blurb:
      'Where a manual transfer is sent. "Offer manual transfer" is refused unless the image path, account name and account number are all filled in — a payment instruction that is wrong by a digit sends a guest’s money to a stranger.',
    shape: 'object',
    fields: [
      // Set by the "Upload new QR" widget above this form, never typed —
      // see the `hidden` kind's own note.
      { name: 'imagePath', label: 'QR image path', kind: 'hidden', nullable: true },
      { name: 'accountName', label: 'Account name', kind: 'text', nullable: true },
      { name: 'accountNumber', label: 'Account number', kind: 'text', nullable: true },
      { name: 'instructions', label: 'Instructions', kind: 'textarea', nullable: true, rows: 3 },
      {
        name: 'isConfigured',
        label: 'Offer manual transfer at checkout',
        kind: 'select',
        options: YES_NO,
      },
    ],
  },
  {
    key: 'trust',
    title: 'Deposit and trust figures',
    blurb:
      'The deposit percentage taken at checkout, and the trust figures shown on the site. A rating typed here is never the rating a search engine sees — that comes only from real reviews.',
    shape: 'object',
    fields: [
      {
        name: 'depositPercent',
        label: 'Deposit percentage',
        kind: 'number',
        hint: 'A whole percent of the total, taken at checkout. The server computes the amount.',
      },
      {
        name: 'minReviewsForRating',
        label: 'Reviews needed before a rating is shown',
        kind: 'number',
        hint: 'Below this, a tour shows a "New" badge instead of stars.',
      },
      {
        name: 'dotAccredited',
        label: 'Show the DOT-accredited badge',
        kind: 'select',
        options: YES_NO,
      },
      { name: 'ratingAverage', label: 'Rating average shown', kind: 'number', nullable: true },
      { name: 'ratingCount', label: 'Rating count shown', kind: 'number', nullable: true },
      { name: 'guestsServed', label: 'Guests served', kind: 'number', nullable: true },
    ],
  },
  {
    key: 'legal_privacy',
    title: 'Privacy notice',
    blurb:
      'Written as Markdown, and rendered as Markdown on the privacy page — there is no preview here. The "last updated" date is stamped automatically when this is saved.',
    shape: 'object',
    fields: [
      { name: 'markdown', label: 'Privacy notice (Markdown)', kind: 'textarea', rows: 16 },
      { name: 'updatedAt', label: 'Updated at', kind: 'stamp' },
    ],
  },
  {
    key: 'legal_terms',
    title: 'Terms and conditions',
    blurb:
      'Written as Markdown, and rendered as Markdown on the terms page — there is no preview here. The "last updated" date is stamped automatically when this is saved.',
    shape: 'object',
    fields: [
      { name: 'markdown', label: 'Terms and conditions (Markdown)', kind: 'textarea', rows: 16 },
      { name: 'updatedAt', label: 'Updated at', kind: 'stamp' },
    ],
  },
];

/**
 * The five groups, and where `trust` sits.
 *
 * `trust` is under Payments rather than Home content because `depositPercent`
 * is the field in it that decides money — how much of a total is taken at
 * checkout — and that is what makes this whole screen owner only. Its rating
 * and guest figures are display policy and ride along with it.
 */
export const GROUPS: readonly GroupSpec[] = [
  {
    id: 'site-seo',
    title: 'Site & SEO',
    blurb: 'What search engines are told, and whether they are told anything at all.',
    keys: ['content_unverified', 'site_seo'],
  },
  {
    id: 'home-content',
    title: 'Home content',
    blurb: 'The words and images on the public pages.',
    keys: ['hero', 'announcement', 'promo', 'how_it_works', 'why_book_direct', 'faqs'],
  },
  {
    id: 'business',
    title: 'Business',
    blurb: 'Opening hours, contact details, the bookable date window and the permits.',
    keys: ['business_hours', 'contact', 'booking', 'permits'],
  },
  {
    id: 'payments',
    title: 'Payments',
    blurb: 'How a guest pays, where a transfer goes, and the deposit taken at checkout.',
    keys: ['payment_methods', 'payment_qr', 'trust'],
  },
  {
    id: 'legal',
    title: 'Legal',
    blurb: 'The privacy notice and the terms, both written as Markdown.',
    keys: ['legal_privacy', 'legal_terms'],
  },
];

/** Every block by its key — built once, at module scope. */
export const BLOCKS_BY_KEY: ReadonlyMap<SettingKey, BlockSpec> = new Map(
  BLOCKS.map((block) => [block.key, block]),
);

/* ------------------------------------------------------- Value <-> form text */

/** Reads a dotted path out of a stored block. `undefined` if any step is missing. */
export function readPath(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Writes a dotted path into a plain object, creating the objects on the way. */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (next === null || typeof next !== 'object') node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments.at(-1) as string] = value;
}

/** One stored record to the strings its inputs display. */
export function toFormRow(record: unknown, fields: readonly FieldSpec[]): Record<string, string> {
  const row: Record<string, string> = {};
  for (const field of fields) {
    const raw = readPath(record, field.name);
    if (field.kind === 'manilaDatetime') {
      row[field.name] = typeof raw === 'string' ? utcIsoToManilaLocal(raw) : '';
      continue;
    }
    row[field.name] = raw === null || raw === undefined ? '' : String(raw);
  }
  return row;
}

/** Which fields are actually drawn — `stamp`, `rowIndex` and `hidden` are not. */
export function visibleFields(fields: readonly FieldSpec[]): readonly FieldSpec[] {
  return fields.filter(
    (field) => field.kind !== 'stamp' && field.kind !== 'rowIndex' && field.kind !== 'hidden',
  );
}

/** A blank row for an array block: every field empty, every yes/no at No. */
export function blankRow(fields: readonly FieldSpec[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field.name, field.options === YES_NO ? 'false' : '']),
  );
}

/**
 * The strings an owner typed, back to the record the server stores — plus any
 * field this screen itself could not read.
 *
 * `null` for an empty nullable field, a real `number` for a numeric one, a
 * real boolean for a yes/no: never a string standing in for one of those.
 * `settings.value` is a JSON column, so `"30"` and `30` are genuinely
 * different stored values and only one of them passes the block's schema.
 *
 * The errors it returns are only the ones the SERVER cannot express — "that is
 * not a number", "that is not a date and time". Everything about what a
 * setting may legally contain is decided by `SETTING_SCHEMAS[key]` and comes
 * back as a refusal; see this file's header.
 */
export function fromFormRow(
  row: Record<string, string>,
  fields: readonly FieldSpec[],
  rowIndex: number,
  now: Date,
): { record: Record<string, unknown>; errors: Record<string, string> } {
  const record: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const field of fields) {
    if (field.kind === 'stamp') {
      writePath(record, field.name, now.toISOString());
      continue;
    }
    if (field.kind === 'rowIndex') {
      writePath(record, field.name, rowIndex);
      continue;
    }

    const typed = (row[field.name] ?? '').trim();

    // A two-option select whose options ARE `YES_NO` is a boolean column.
    if (field.options === YES_NO) {
      writePath(record, field.name, typed === 'true');
      continue;
    }

    if (field.kind === 'number') {
      if (typed === '') {
        if (field.nullable) writePath(record, field.name, null);
        else errors[field.name] = 'Enter a number.';
        continue;
      }
      const parsed = Number(typed);
      if (!Number.isFinite(parsed)) {
        errors[field.name] = 'Enter a number, e.g. 30.';
        continue;
      }
      writePath(record, field.name, parsed);
      continue;
    }

    if (field.kind === 'manilaDatetime') {
      if (typed === '') {
        writePath(record, field.name, field.nullable ? null : '');
        continue;
      }
      const iso = manilaLocalToUtcIso(typed);
      if (iso === null) {
        errors[field.name] = 'Enter a date and time, or leave it blank.';
        continue;
      }
      writePath(record, field.name, iso);
      continue;
    }

    // text, textarea, time, and any select that is not a boolean: the string
    // as typed, or null when it is empty and the block allows null there.
    writePath(record, field.name, typed === '' && field.nullable ? null : typed);
  }

  return { record, errors };
}
