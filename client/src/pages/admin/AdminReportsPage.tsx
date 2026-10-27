/**
 * The money reports screen — a date range, five figures, revenue per tour,
 * outstanding balances, and a CSV of each (Week 7 plan, Task 12 — 7D;
 * BUILD_SPEC §9 "Reports", client half).
 *
 * `admin.reports.*` is `adminProcedure('reports')` server-side — §9's row is
 * owner and FINANCE, never a dispatcher — so this screen shows a plain denied
 * state rather than a blank page from either of the two places a dispatcher
 * could reach it: the role this session already knows (`staffAuth.me`), and a
 * refused `admin.reports.summary` call (a stale session, or a role changed
 * mid-visit). It does not re-check the role for ENFORCEMENT; the server
 * refuses every call regardless (CLAUDE.md: hiding a button is not access
 * control).
 *
 * ## The browser formats money and computes nothing
 *
 * Every figure arrives as integer centavos and goes through `formatPeso`
 * (CLAUDE.md § Conventions). Nothing here adds, subtracts or nets anything:
 * `netReceivedCentavos` is computed on the server from the two sums, and a
 * screen that re-derived it from the other two cards would be a second answer
 * to "what came in this month" living in a browser.
 *
 * **A zero is shown as `₱0`, never as a dash.** "Nothing came in" is a fact an
 * owner needs to be able to read off this page; an em dash reads as "we don't
 * know", which is a different and much worse thing to tell someone about their
 * own money.
 *
 * ## Two buckets, said in words
 *
 * The money cards are bucketed by the date the payment or refund landed; the
 * bookings and the balance are bucketed by the TOUR date (owner decision
 * 2026-10-23, Q7). The two are not expected to reconcile inside one window, so
 * each card says which date it counts by rather than leaving someone to
 * discover it by arithmetic.
 *
 * ## The CSV download is a `Blob`, with no route and no library
 *
 * `admin.reports.csv` is an ordinary tRPC query returning
 * `{ filename, csv }`; the button fetches it, wraps the string in a `Blob`,
 * and clicks a temporary `<a download>` at an object URL. A dedicated Express
 * route would need its own copy of the role gate, and that second copy is the
 * one that gets forgotten.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  dateRangeInput,
  formatPeso,
  manilaCivilDate,
  type OutstandingRow,
  type ReportName,
  type ReportSummary,
  type TourRevenueRow,
} from '@rg/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';
const OUTLINE_BUTTON =
  'tap-target border-brand-blue-200 text-brand-blue-700 hover:bg-brand-blue-50 hover:text-brand-blue-800 rounded-[10px] font-semibold transition-colors';
const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';

/** §9's `reports` row, mirrored for the cosmetic half of the gate. */
const MAY_READ_REPORTS = ['owner', 'finance'];

/** Is this refusal a role problem (401/403), rather than a network fault? */
function isRoleRefusal(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data?.httpStatus === 403 || error.data?.httpStatus === 401)
  );
}

/* --------------------------------------------------------------- The window */

/** Days in a Manila calendar month. `Date.UTC(y, m, 0)` is the last of month `m`. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The current Manila month, first day to last.
 *
 * The WHOLE month rather than "the 1st to today": the two halves of this
 * report bucket by different dates, and the still-to-collect figure is about
 * trips that have not happened yet — a window that stopped at today would hide
 * the balances due on the rest of the month, which is the half of this screen
 * someone acts on.
 */
function currentManilaMonth(now: Date): { from: string; to: string } {
  const today = manilaCivilDate(now);
  const [year, month] = today.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
  };
}

/* ------------------------------------------------------------- The download */

/**
 * A UTF-8 byte-order mark.
 *
 * Excel on Windows guesses a CSV's encoding and gets it wrong without this, so
 * a guest named Niño arrives in finance's spreadsheet as mojibake. Built from
 * its code point rather than typed, because the literal character is invisible
 * in a diff and `no-irregular-whitespace` rightly refuses it in source.
 */
const BOM = String.fromCharCode(0xfeff);

/**
 * Hands the browser a file built from a string it already has.
 *
 * `document.createElement` + `click()` + `revokeObjectURL`, which is the
 * dependency-free way to do this and the one the plan asks for. The anchor is
 * never attached to the document: a detached `<a download>` click still starts
 * the download in every browser this admin runs in, and attaching one would
 * flash a stray link into the layout.
 */
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const REPORT_LABEL: Record<ReportName, string> = {
  summary: 'Download the summary (CSV)',
  byTour: 'Download revenue by tour (CSV)',
  outstanding: 'Download outstanding balances (CSV)',
};

function CsvButton({ report, range }: { report: ReportName; range: { from: string; to: string } }) {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      /*
       * `retry: false`, like every query on this screen: the three refusals
       * this can get — a revoked role, an inverted range, a server fault —
       * are none of them fixed by asking again a second later, and an admin
       * who clicked a button is standing there waiting for the file.
       */
      const file = await utils.admin.reports.csv.fetch({ ...range, report }, { retry: false });
      downloadCsv(file.filename, file.csv);
    } catch {
      setError('Could not build that file. Try again in a moment.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={OUTLINE_BUTTON}
        disabled={pending}
        onClick={() => void run()}
      >
        {pending ? (
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-2 size-4" aria-hidden="true" />
        )}
        {REPORT_LABEL[report]}
      </Button>
      {error ? (
        <p role="alert" className="text-brand-gold-800 text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- The cards */

/**
 * One headline figure.
 *
 * `bucket` is the sentence that stops this screen being misread: two of these
 * five count by the date money moved and three by the tour date, and a row of
 * five identical-looking cards invites someone to subtract one from another.
 */
function FigureCard({ label, value, bucket }: { label: string; value: string; bucket: string }) {
  return (
    <div className={`${CARD} p-4`}>
      <p className="text-brand-error text-xs font-semibold uppercase tracking-[0.06em]">{label}</p>
      <p className="text-brand-ink mt-1 text-2xl font-bold">{value}</p>
      <p className="text-brand-error mt-1 text-xs">{bucket}</p>
    </div>
  );
}

const BY_PAYMENT_DATE = 'By the date the money moved';
const BY_TOUR_DATE = 'By tour date';

function FigureCards({ summary }: { summary: ReportSummary }) {
  return (
    <div
      data-testid="figure-cards"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5"
    >
      <FigureCard
        label="Money received"
        value={formatPeso(summary.receivedCentavos)}
        bucket={BY_PAYMENT_DATE}
      />
      <FigureCard
        label="Refunds"
        value={formatPeso(summary.refundedCentavos)}
        bucket={BY_PAYMENT_DATE}
      />
      <FigureCard
        label="Net received"
        value={formatPeso(summary.netReceivedCentavos)}
        bucket="Received less refunds"
      />
      <FigureCard
        label="Still to collect"
        value={formatPeso(summary.stillToCollectCentavos)}
        bucket={BY_TOUR_DATE}
      />
      <FigureCard label="Bookings" value={String(summary.bookingCount)} bucket={BY_TOUR_DATE} />
    </div>
  );
}

/* ---------------------------------------------------------------- The tables */

function ByTourTable({ rows }: { rows: readonly TourRevenueRow[] }) {
  if (rows.length === 0) {
    return (
      <p className={`${CARD} text-brand-error p-5 text-sm`}>
        No money moved and no trips ran in these dates.
      </p>
    );
  }
  return (
    <div data-testid="by-tour-wrapper" className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-left text-sm">
        <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Tour
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Bookings
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Received
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Refunds
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Net
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Still to collect
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tourId} className="border-brand-blue-100 border-b last:border-0">
              <th scope="row" className="text-brand-ink px-4 py-3 text-left font-semibold">
                {row.tourTitle}
              </th>
              <td className="text-brand-ink px-4 py-3">{row.bookingCount}</td>
              <td className="text-brand-ink px-4 py-3">{formatPeso(row.receivedCentavos)}</td>
              <td className="text-brand-ink px-4 py-3">{formatPeso(row.refundedCentavos)}</td>
              <td className="text-brand-ink px-4 py-3 font-semibold">
                {formatPeso(row.netReceivedCentavos)}
              </td>
              <td className="text-brand-ink px-4 py-3">{formatPeso(row.stillToCollectCentavos)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutstandingTable({ rows }: { rows: readonly OutstandingRow[] }) {
  if (rows.length === 0) {
    return (
      <p className={`${CARD} text-brand-error p-5 text-sm`}>
        Every booking on these tour dates is paid in full.
      </p>
    );
  }
  return (
    <div data-testid="outstanding-wrapper" className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-left text-sm">
        <caption className="text-brand-error px-4 pb-2 pt-3 text-left text-xs">
          {rows.length} {rows.length === 1 ? 'booking' : 'bookings'} whose total and payments do not
          agree, earliest tour date first. A negative figure means the guest has overpaid.
        </caption>
        <thead className="bg-brand-blue-50 text-brand-error border-brand-blue-100 border-b text-xs uppercase tracking-[0.06em]">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Booking
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Tour date
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Tour
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Guest
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Total
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Paid
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Outstanding
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.bookingId} className="border-brand-blue-100 border-b last:border-0">
              <th scope="row" className="px-4 py-3 text-left font-semibold">
                <Link
                  to={`/admin/bookings/${row.ref}`}
                  className="text-brand-blue-700 hover:text-brand-blue-900 underline underline-offset-4 transition-colors"
                >
                  {row.ref}
                </Link>
              </th>
              <td className="text-brand-ink px-4 py-3">{row.tourDate}</td>
              <td className="text-brand-ink px-4 py-3">{row.tourTitle}</td>
              <td className="text-brand-ink px-4 py-3">{row.leadName}</td>
              <td className="text-brand-ink px-4 py-3">{formatPeso(row.totalCentavos)}</td>
              <td className="text-brand-ink px-4 py-3">{formatPeso(row.paidCentavos)}</td>
              <td className="text-brand-ink px-4 py-3 font-semibold">
                {formatPeso(row.outstandingCentavos)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ Denied state */

/** The same denied markup the other role-gated admin screens render. */
function DeniedState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Owner and finance only
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Reports</h1>
      </header>
      <p role="alert" className={NOTICE}>
        Only the owner and finance can see the money reports.
      </p>
      <Link
        to="/admin"
        className="tap-target text-brand-blue-700 hover:text-brand-blue-900 inline-flex items-center text-sm font-semibold underline underline-offset-4 transition-colors"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ The page */

function ReportsAdmin() {
  // Read once, at mount: the default window is "this Manila month", and a
  // range that re-derived itself on every render would move under a date the
  // someone had already typed.
  const [range, setRange] = useState(() => currentManilaMonth(new Date()));
  const [draft, setDraft] = useState(range);

  const invalid = useMemo(() => !dateRangeInput.safeParse(draft).success, [draft]);

  const summary = trpc.admin.reports.summary.useQuery(range, { retry: false });
  const byTour = trpc.admin.reports.byTour.useQuery(range, { retry: false });
  const outstanding = trpc.admin.reports.outstanding.useQuery(range, { retry: false });

  // The second denial layer: a session this client believes may read reports
  // but whose grant the server has since revoked only surfaces here.
  if (summary.isError && isRoleRefusal(summary.error)) {
    return <DeniedState />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Finance
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">Reports</h1>
        <p className="text-brand-error text-sm">
          Money received and refunded counts by the date it moved. Bookings and the balance still to
          collect count by the tour date. Both are Asia/Manila days, so the two halves of a window
          are not meant to add up to each other.
        </p>
      </header>

      <Card className={CARD}>
        <CardHeader>
          <CardTitle className="text-brand-ink text-lg font-bold">Dates</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!invalid) setRange(draft);
            }}
          >
            <div className="min-w-0 flex-[1_1_160px] space-y-1">
              <Label htmlFor="report-from">From</Label>
              <Input
                id="report-from"
                type="date"
                className={`${FIELD} w-full`}
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </div>
            <div className="min-w-0 flex-[1_1_160px] space-y-1">
              <Label htmlFor="report-to">To</Label>
              <Input
                id="report-to"
                type="date"
                className={`${FIELD} w-full`}
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </div>
            <Button
              type="submit"
              disabled={invalid}
              className={`${OUTLINE_BUTTON} w-full sm:w-auto`}
            >
              Show these dates
            </Button>
          </form>
          {invalid ? (
            <p role="alert" className={`${ALERT} mt-3`}>
              Enter two dates, with the start on or before the end.
            </p>
          ) : (
            <p className="text-brand-error mt-3 text-xs">
              Showing {range.from} to {range.to}, Asia/Manila. Both days are included.
            </p>
          )}
        </CardContent>
      </Card>

      {summary.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading the figures…
        </p>
      ) : summary.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the figures. Sign in again, or try once more in a moment.
        </p>
      ) : (
        <FigureCards summary={summary.data} />
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-brand-ink text-lg font-bold">Revenue by tour</h2>
        {byTour.isPending ? (
          <p className="text-brand-error flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading tours…
          </p>
        ) : byTour.isError ? (
          <p role="alert" className={ALERT}>
            We could not load the per-tour figures. Try again in a moment.
          </p>
        ) : (
          <ByTourTable rows={byTour.data} />
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-brand-ink text-lg font-bold">Outstanding balances</h2>
        {outstanding.isPending ? (
          <p className="text-brand-error flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading balances…
          </p>
        ) : outstanding.isError ? (
          <p role="alert" className={ALERT}>
            We could not load the outstanding balances. Try again in a moment.
          </p>
        ) : (
          <OutstandingTable rows={outstanding.data} />
        )}
      </div>

      <Card className={CARD}>
        <CardHeader>
          <CardTitle className="text-brand-ink text-lg font-bold">Spreadsheet exports</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-brand-error text-sm">
            Each file covers the dates above, with amounts in pesos.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <CsvButton report="summary" range={range} />
            <CsvButton report="byTour" range={range} />
            <CsvButton report="outstanding" range={range} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A convenience, not the control: the server refuses every `admin.reports`
 * call from anyone but the owner and finance. This stops a dispatcher who types
 * the address from being shown four loading spinners that can only be refused.
 */
export default function AdminReportsPage() {
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });

  if (me.data && !MAY_READ_REPORTS.includes(me.data.role)) {
    return <DeniedState />;
  }

  return <ReportsAdmin />;
}
