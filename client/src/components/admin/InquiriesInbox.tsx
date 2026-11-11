/**
 * The inquiries inbox, extracted (Demo Polish Round 2, Task 1 / owner's "1A",
 * 2026-11-11) from `AdminPackagesPage.tsx`'s own "Enquiries" section so a
 * second screen — `AdminTripRequestsPage.tsx` — can render the identical
 * inbox at its own URL, with its own `AdminPageHeader`.
 *
 * ## Same gate, same data, two doors
 *
 * `admin.inquiries.list` / `.setStatus` are `adminProcedure('packagesInquiries')`
 * — owner and dispatcher, never finance (`server/src/middleware/require-role.ts`).
 * This component does not add, remove or alter that gate: it is still the
 * caller's job (each PAGE's own role check) to keep a refused role from ever
 * mounting this component with a working query — see `AdminPackagesPage.tsx`'s
 * and `AdminTripRequestsPage.tsx`'s own two-layer `DeniedState` pattern.
 *
 * The "Quote & convert" control inside each row stays gated on
 * `roleMay(role, TRANSFER_QUOTING_ROLES)` (owner+finance, `transferQuoting`)
 * exactly as it was inline — this extraction touches that gate not at all.
 *
 * `CARD`/`ALERT`/`NOTICE`/`INQUIRY_BADGE_CLASS`/`describeError` are redeclared
 * here rather than imported from `AdminPackagesPage.tsx`: that page now
 * imports THIS component, so importing back from it would be circular. The
 * string values are identical to the page's own (and to `ConvertInquiryForm.tsx`'s
 * own `ALERT`), by design — not a shared constant, a repeated literal.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  INQUIRY_STATUS_LABELS,
  INQUIRY_STATUSES,
  type AdminRole,
  type InquiryAdminRow,
  type InquiryStatus,
  type VehicleTypeAdminRow,
} from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ConvertInquiryForm from '@/components/admin/ConvertInquiryForm';
import { utcIsoToManilaLabel } from '@/lib/manila-datetime';
import { firstValidationMessage } from '@/lib/field-errors';
import { roleMay, TRANSFER_QUOTING_ROLES } from '@/lib/roles';
import { trpc } from '@/lib/trpc';

const CARD = 'border-brand-blue-100 rounded-[14px] border bg-white';
const NOTICE =
  'border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 rounded-xl border p-3 text-sm font-medium';
const ALERT =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';

/** Same page size `AdminBookingsPage.tsx` uses for its own Prev/Next pager. */
const INQUIRY_PAGE_SIZE = 25;

/** Amber for "needs attention", neutral for a decided enquiry. Never red. */
const INQUIRY_BADGE_CLASS: Record<InquiryStatus, string> = {
  new: 'border-0 bg-brand-gold-100 text-brand-gold-800',
  read: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  replied: 'border-0 bg-brand-blue-50 text-brand-blue-800',
  closed: 'border-0 bg-slate-100 text-brand-ink',
};

/** The server's own sentence for any refusal under 500; a calm fallback otherwise. */
function describeError(error: unknown, fallback: string): string {
  const validation = firstValidationMessage(error);
  if (validation !== null) return validation;
  if (
    error instanceof TRPCClientError &&
    typeof error.data?.httpStatus === 'number' &&
    error.data.httpStatus < 500
  ) {
    return error.message;
  }
  return fallback;
}

/* -------------------------------------------------------------- One enquiry */

function InquiryRow({
  row,
  role,
  vehicleTypes,
}: {
  row: InquiryAdminRow;
  role: AdminRole | undefined;
  vehicleTypes: readonly VehicleTypeAdminRow[];
}) {
  const utils = trpc.useUtils();
  const [rowBanner, setRowBanner] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertedNotice, setConvertedNotice] = useState<string | null>(null);

  const setStatus = trpc.admin.inquiries.setStatus.useMutation({
    onSuccess: () => {
      setRowBanner(null);
      void utils.admin.inquiries.list.invalidate();
    },
    onError: (error) =>
      setRowBanner(describeError(error, 'Could not change this enquiry. Nothing was changed.')),
  });

  /*
   * §9 "Quote & convert custom trips" — owner and finance (`transferQuoting`).
   * Cosmetic only, same as every other role check on this screen: the server
   * refuses `admin.transferQuotes.convert` from anyone else regardless of
   * whether this control is drawn. A request already converted, or one that
   * is not a custom-trip request at all, offers nothing to convert.
   */
  const showConvertSection =
    roleMay(role, TRANSFER_QUOTING_ROLES) &&
    row.type === 'transfer_custom' &&
    row.convertedBookingId === null;

  return (
    <li className={`${CARD} space-y-3 p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={INQUIRY_BADGE_CLASS[row.status]}>
            {INQUIRY_STATUS_LABELS[row.status]}
          </Badge>
          <p className="text-brand-ink text-sm font-semibold">{row.name}</p>
        </div>
        <p className="text-muted-foreground text-xs">{utcIsoToManilaLabel(row.createdAt)}</p>
      </div>

      <p className="text-brand-error text-xs">
        {row.type === 'transfer_custom'
          ? 'Custom trip request'
          : row.packageTitle === null
            ? 'General enquiry'
            : `About ${row.packageTitle}`}
      </p>

      {row.type === 'transfer_custom' ? (
        <dl className="text-brand-ink grid gap-1 text-sm sm:grid-cols-2">
          {row.requestedDate === null ? null : (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Travel date:</dt>
              <dd>{row.requestedDate}</dd>
            </div>
          )}
          {row.pax === null ? null : (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Pax:</dt>
              <dd>{row.pax}</dd>
            </div>
          )}
          {row.routeDescription === null ? null : (
            <div className="flex min-w-0 gap-1.5 sm:col-span-2">
              <dt className="text-muted-foreground shrink-0">Route:</dt>
              {/*
               * `min-w-0` + `break-words`: a guest can paste a route with no
               * spaces (a URL, a run-on), and a flex child's default
               * `min-width: auto` would otherwise let it push the card
               * sideways at 360px — the same hazard the email link above
               * guards with `break-all` (CLAUDE.md: the page body must
               * never scroll horizontally).
               */}
              <dd className="min-w-0 break-words">{row.routeDescription}</dd>
            </div>
          )}
          {row.convertedBookingRef === null ? null : (
            <div className="flex gap-1.5 sm:col-span-2">
              <dt className="text-muted-foreground">Converted to booking:</dt>
              <dd className="font-semibold">{row.convertedBookingRef}</dd>
            </div>
          )}
        </dl>
      ) : null}

      <div className="text-sm">
        <p className="text-brand-ink">
          {/*
           * `break-all`, not `truncate`: an address a guest typed is the one
           * thing the office has to be able to read and copy, and at 360px an
           * unbroken 50-character email would push the card sideways
           * (CLAUDE.md: the page body must never scroll horizontally).
           */}
          <a
            href={`mailto:${row.email}`}
            className="text-brand-blue-700 hover:text-brand-blue-900 break-all underline underline-offset-4 transition-colors"
          >
            {row.email}
          </a>
        </p>
        {row.phone === null ? null : <p className="text-brand-ink">{row.phone}</p>}
      </div>

      <p className="text-brand-ink whitespace-pre-line text-sm leading-relaxed">{row.message}</p>

      {rowBanner ? (
        <p role="alert" className={ALERT}>
          {rowBanner}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * The visible word is short ("Mark read") and the `aria-label` names
         * the guest: every enquiry in the list draws the same three buttons, so
         * the label is the only thing that tells a screen-reader user which
         * enquiry they are about to close.
         */}
        {INQUIRY_STATUSES.filter((status) => status !== row.status).map((status) => (
          <Button
            key={status}
            type="button"
            variant="row"
            disabled={setStatus.isPending}
            aria-label={`Mark ${INQUIRY_STATUS_LABELS[status].toLowerCase()} — enquiry from ${row.name}`}
            onClick={() => setStatus.mutate({ id: row.id, status })}
          >
            {`Mark ${INQUIRY_STATUS_LABELS[status].toLowerCase()}`}
          </Button>
        ))}
      </div>

      {convertedNotice ? (
        <p role="status" className={NOTICE}>
          {convertedNotice}
        </p>
      ) : null}

      {showConvertSection ? (
        vehicleTypes.length === 0 ? (
          /*
           * `admin.vehicleTypes.list` came back empty — either this session
           * cannot even query it (finance, today: see
           * `InquiriesInbox`'s own note on `isOwner`-gating that query),
           * or an owner session genuinely has no active vehicle type yet.
           * Either way, a select with no options is a dead end dressed as a
           * refusal nobody can read; naming it beats letting the form reach
           * that state silently.
           */
          <p className="text-brand-error text-sm">
            No vehicle type is available to quote this trip yet.
          </p>
        ) : converting ? (
          <div className="border-brand-blue-100 border-t pt-3">
            <ConvertInquiryForm
              inquiry={row}
              vehicleTypes={vehicleTypes}
              onClose={() => setConverting(false)}
              onConverted={(ref) => {
                setConverting(false);
                setConvertedNotice(`Converted to booking: ${ref}`);
              }}
            />
          </div>
        ) : (
          <Button type="button" variant="primary-pill" onClick={() => setConverting(true)}>
            Quote &amp; convert to booking
          </Button>
        )
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ The inbox */

export default function InquiriesInbox({ role }: { role: AdminRole | undefined }) {
  const isOwner = role === 'owner';
  const [inquiryOffset, setInquiryOffset] = useState(0);
  const inquiryList = trpc.admin.inquiries.list.useQuery(
    { limit: INQUIRY_PAGE_SIZE, offset: inquiryOffset },
    { retry: false },
  );
  /*
   * `admin.vehicleTypes.list` is `adminProcedure('toursPricing')` — OWNER
   * ONLY, a narrower gate than `transferQuoting`'s owner-or-finance (see
   * `lib/roles.ts`'s `TRANSFER_QUOTING_ROLES` note). Gated on `isOwner`, not
   * `canConvert`: a finance session would otherwise fire a query the server
   * refuses with FORBIDDEN, land on an empty list, and silently default
   * `vehicleTypeId` to `''` — a Zod "greater than 0" message on a select with
   * no options to pick, rather than a sentence anyone can act on. The
   * `vehicleTypes.length === 0` branch on each row's convert control is the
   * explicit version of that same gap for an owner session too (no active
   * vehicle type exists yet).
   */
  const vehicleTypesQuery = trpc.admin.vehicleTypes.list.useQuery(undefined, {
    retry: false,
    enabled: isOwner,
  });
  const vehicleTypes = vehicleTypesQuery.data ?? [];
  const inquiries = inquiryList.data?.items ?? [];
  /**
   * Scoped to the page on screen, not the whole queue — `admin.inquiries.list`
   * is paginated (7N), so a count across every enquiry would need its own
   * query this component does not add. The wording below says "on this page"
   * so it never asserts a global "nothing waiting" the next page could
   * contradict.
   */
  const waiting = inquiries.filter((row) => row.status === 'new').length;

  return (
    <>
      {inquiryList.isPending ? (
        <p className="text-brand-error flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading enquiries…
        </p>
      ) : inquiryList.isError ? (
        <p role="alert" className={ALERT}>
          We could not load the enquiries. Sign in again, or try once more in a moment.
        </p>
      ) : inquiries.length === 0 ? (
        <p className={`${CARD} text-brand-error p-5 text-sm`}>No enquiries yet.</p>
      ) : (
        <>
          <p role="status" className={NOTICE}>
            {waiting === 0
              ? 'Nothing on this page waiting for an answer.'
              : `${waiting} ${waiting === 1 ? 'enquiry' : 'enquiries'} on this page waiting for an answer.`}
          </p>
          <ul className="space-y-3">
            {inquiries.map((row) => (
              <InquiryRow key={row.id} row={row} role={role} vehicleTypes={vehicleTypes} />
            ))}
          </ul>

          {inquiryList.data ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-brand-error text-sm" role="status">
                Showing {inquiryList.data.offset + 1}–
                {inquiryList.data.offset + inquiryList.data.items.length} of{' '}
                {inquiryList.data.total}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary-pill"
                  disabled={inquiryOffset === 0}
                  onClick={() => setInquiryOffset(Math.max(inquiryOffset - INQUIRY_PAGE_SIZE, 0))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="secondary-pill"
                  disabled={
                    inquiryList.data.offset + inquiryList.data.items.length >=
                    inquiryList.data.total
                  }
                  onClick={() => setInquiryOffset(inquiryOffset + INQUIRY_PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
