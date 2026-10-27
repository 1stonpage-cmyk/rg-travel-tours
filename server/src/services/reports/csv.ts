/**
 * The CSV renderer for the money reports (Week 7 plan, Task 12 — 7D;
 * BUILD_SPEC §9 "Reports: CSV export for each").
 *
 * Separate from `money.ts` on purpose: that module answers "what counts as
 * money", this one answers "what does the file look like". The split is what
 * lets the escaping be tested as escaping — `admin-reports.test.ts` exercises
 * `csvField` directly with a comma, a quote and a newline, not only through a
 * report that happens to contain one (the plan: "escape with a tested helper;
 * never build CSV with string concatenation in the procedure").
 *
 * ## This is the ONE place that divides by 100
 *
 * Every tRPC payload in this project carries integer centavos and the browser
 * formats them (CLAUDE.md § Conventions). A CSV is the exception, because it is
 * not a payload — it is a file a person opens in a spreadsheet, and
 * `150000` in a column headed "Received" would be read as ₱150,000.
 *
 * `pesosFromCentavos` is deliberately NOT `formatPeso` from `@rg/shared`.
 * `formatPeso` is a DISPLAY formatter: it emits a `₱` glyph, groups thousands
 * with commas and rounds to whole pesos. All three are wrong in a cell — the
 * glyph and the separator make the value text rather than a number in Excel
 * and Sheets, the separator then has to be escaped as a comma inside a CSV,
 * and the rounding loses centavos from a figure finance is reconciling. So a
 * cell gets a bare `1500.00`: two decimals, no glyph, no grouping, and
 * negative numbers keep their sign (an overpaid booking is a real row).
 *
 * ## RFC 4180, and nothing cleverer
 *
 * CRLF line endings and a header row, per the RFC; a field is quoted only when
 * it contains a comma, a double quote, CR or LF, and an inner quote is doubled.
 * **Known limitation, deliberately not addressed here:** a cell whose text
 * begins `=`, `+`, `@` or `-` is interpreted as a FORMULA by Excel and Sheets,
 * and `leadName` in the outstanding report is guest-entered text. Neutralising
 * that means mangling the value (a leading apostrophe or tab) and would have to
 * skip the numeric columns, where a leading `-` is a legitimate overpayment —
 * so it is a decision for the owner rather than something to smuggle in under a
 * reporting task. Flagged in this task's report; see `docs/BUGS_LOG.md` if it
 * has since been logged.
 */
import type {
  DateRangeInput,
  OutstandingRow,
  ReportName,
  ReportSummary,
  TourRevenueRow,
} from '@rg/shared';

/** CRLF, per RFC 4180 — and what Excel on Windows expects. */
const EOL = '\r\n';

/** The characters that force a field to be quoted. */
const MUST_QUOTE = /[",\r\n]/;

/**
 * One CSV field, quoted only if it has to be.
 *
 * Exported and tested on its own. An escaping function that is only ever
 * exercised through a report is tested by whatever that report's fixtures
 * happen to contain, which is how a quote-in-a-tour-title ships broken.
 */
export function csvField(value: string): string {
  if (!MUST_QUOTE.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Integer centavos as a bare peso amount with two decimals: `1500.00`.
 *
 * Integer arithmetic on both halves — no float division touches money
 * (CLAUDE.md). The sign is taken off first so `-1` renders `-0.01` rather than
 * `0.-1`, which is what `%` on a negative number would otherwise produce.
 */
export function pesosFromCentavos(centavos: number): string {
  const sign = centavos < 0 ? '-' : '';
  const absolute = Math.abs(centavos);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** A header row and its data rows, escaped field by field. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (fields: readonly string[]) => fields.map(csvField).join(',');
  return [line(header), ...rows.map(line)].join(EOL);
}

/* ------------------------------------------------------------ The three files */

/**
 * The headline figures as label/amount pairs.
 *
 * Two columns rather than one wide row, because a summary is read down the
 * page and because "Bookings" is a COUNT in a file whose other column is
 * pesos — stated as a plain integer, not dressed up with two decimals it has
 * no business having.
 */
export function summaryCsv(summary: ReportSummary): string {
  return toCsv(
    ['Figure', 'Amount (PHP)'],
    [
      ['Money received', pesosFromCentavos(summary.receivedCentavos)],
      ['Refunds', pesosFromCentavos(summary.refundedCentavos)],
      ['Net received', pesosFromCentavos(summary.netReceivedCentavos)],
      ['Still to collect', pesosFromCentavos(summary.stillToCollectCentavos)],
      ['Bookings', String(summary.bookingCount)],
    ],
  );
}

export function byTourCsv(rows: readonly TourRevenueRow[]): string {
  return toCsv(
    [
      'Tour',
      'Bookings',
      'Received (PHP)',
      'Refunds (PHP)',
      'Net received (PHP)',
      'Still to collect (PHP)',
    ],
    rows.map((row) => [
      row.tourTitle,
      String(row.bookingCount),
      pesosFromCentavos(row.receivedCentavos),
      pesosFromCentavos(row.refundedCentavos),
      pesosFromCentavos(row.netReceivedCentavos),
      pesosFromCentavos(row.stillToCollectCentavos),
    ]),
  );
}

export function outstandingCsv(rows: readonly OutstandingRow[]): string {
  return toCsv(
    [
      'Booking',
      'Tour date',
      'Tour',
      'Guest',
      'Status',
      'Total (PHP)',
      'Paid (PHP)',
      'Outstanding (PHP)',
    ],
    rows.map((row) => [
      row.ref,
      row.tourDate,
      row.tourTitle,
      row.leadName,
      row.status,
      pesosFromCentavos(row.totalCentavos),
      pesosFromCentavos(row.paidCentavos),
      pesosFromCentavos(row.outstandingCentavos),
    ]),
  );
}

/** The filename each report downloads as. Kebab-case, no spaces, no glyphs. */
const FILE_STEM: Record<ReportName, string> = {
  summary: 'summary',
  byTour: 'by-tour',
  outstanding: 'outstanding',
};

/**
 * `travelsugbo-by-tour-2026-03-01-to-2026-03-31.csv`.
 *
 * Built from the report name and the two already-validated civil dates, so
 * every character is from a closed set — there is no path separator, quote or
 * space a caller could get into a `Content-Disposition` header or a filesystem
 * through this value, even though today the browser is the only thing that
 * ever sees it.
 */
export function csvFilename(report: ReportName, range: DateRangeInput): string {
  return `travelsugbo-${FILE_STEM[report]}-${range.from}-to-${range.to}.csv`;
}
