/**
 * Week 5, Task 12: the assignment panel (BUILD_SPEC §9 "Calendar" — "assign
 * van/driver per trip", plus "Assign van + driver" under Bookings detail).
 *
 * ONE component with TWO mount points — the calendar's day list and the
 * booking detail page — because §9 asks for the same action on both and two
 * copies would drift. Everything that differs between them arrives as a
 * prop; nothing is derived from the URL or guessed from context.
 *
 * ## What this panel is NOT
 *
 * It is not the enforcement. `admin.dispatch.assign` re-checks every
 * exclusion inside a locked transaction (Task 10), and the dropdowns here
 * are a convenience rendered from an answer that was true when the day was
 * selected. A dispatcher who sits on this screen for ten minutes can still
 * be refused, and that refusal is the system working — which is why every
 * one of the six refusal reasons has copy below rather than a generic
 * "something went wrong".
 *
 * ## The role gate
 *
 * `admin.calendar.month` is `bookingsView`, so FINANCE can open the
 * calendar — but `dayOptions` and `dispatch.assign` are `assignVanDriver`.
 * Rendering this for finance would trip a `FORBIDDEN` the moment they
 * selected a day, for a thing they never asked to do. So the panel renders
 * nothing for finance and **does not issue the `dayOptions` query at all**.
 *
 * **Hiding it is not the access control.** `CLAUDE.md` says so in as many
 * words, and the server procedures remain the enforcement — Task 8's role
 * test proves finance is refused there. This gate only avoids showing
 * someone an error for an action that was never offered to them.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import type { AssignRefusal, BookingStatus } from '@rg/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc';

/**
 * Copy for every refusal, typed `Record<AssignRefusal, string>` so the
 * COMPILER refuses a build where a reason has no words (controller ruling,
 * 2026-10-15). `AssignRefusal` lives in `@rg/shared` for exactly this; add a
 * seventh reason server-side and this object stops compiling until someone
 * decides what a dispatcher should read.
 *
 * `van_unavailable` and `driver_unavailable` both arrive as `CONFLICT` and
 * both mean "re-check the day" — but a driver on leave is NOT a race, and
 * telling a dispatcher "someone just took them" when the driver booked the
 * day off sends them hunting for a colleague who did nothing. So the driver
 * line covers both truthfully instead of guessing which happened.
 */
const REFUSAL_COPY: Record<AssignRefusal, string> = {
  booking_not_found: 'That trip is no longer there. Reload the day.',
  booking_not_assignable: "This trip's status cannot take a van and driver yet.",
  van_unavailable: 'Someone just took that van. The list below has been refreshed.',
  driver_unavailable: 'That driver is not available on this date — newly assigned, or on leave.',
  van_too_small: 'That van is too small for this group.',
  reason_required: 'A trip already under way needs a reason before it can be re-assigned.',
};

/** The `note` values `admin.dispatch.suggest` can answer with. */
const SUGGEST_NOTE_COPY: Record<string, string> = {
  ok: '',
  no_van_fits: 'No van free on this date is big enough for this group.',
  no_driver_free: 'No driver is free on this date.',
  nothing_free: 'No van and no driver are free on this date.',
};

function isRefusal(value: string): value is AssignRefusal {
  return Object.prototype.hasOwnProperty.call(REFUSAL_COPY, value);
}

/**
 * Turns a thrown tRPC error into something a dispatcher can act on.
 *
 * The server sets `message` to the refusal reason, so a known reason maps to
 * its copy. Two cases deliberately fall through to their own words rather
 * than being forced into the six: a `CONFLICT` with no recognised reason is
 * Task 10's deadlock give-up ("this date is busy"), and anything else is
 * genuinely unexpected.
 */
function refusalMessage(error: unknown): string {
  if (error instanceof TRPCClientError) {
    const reason = typeof error.message === 'string' ? error.message.trim() : '';
    if (isRefusal(reason)) return REFUSAL_COPY[reason];
    if (reason.length > 0 && reason.length < 200) return reason;
  }
  return 'That assignment could not be saved. Please try again.';
}

export interface AssignPanelProps {
  bookingId: number;
  pax: number;
  /**
   * REQUIRED, never derived inside this component: it decides whether the
   * unpaid label shows (owner Q2) and whether the reason field exists and
   * is required (owner Q3). A panel that guessed would guess wrong on the
   * detail page.
   */
  status: BookingStatus;
  currentVanId: number | null;
  currentDriverId: number | null;
  /** Called after a successful assignment so the caller can refetch. */
  onAssigned: () => void;
  /** Outer spacing, so each mount point sets its own. */
  className?: string;
}

export default function AssignPanel({
  bookingId,
  pax,
  status,
  currentVanId,
  currentDriverId,
  onAssigned,
  className = 'mt-3',
}: AssignPanelProps) {
  const me = trpc.staffAuth.me.useQuery();
  const canAssign = me.data?.role === 'owner' || me.data?.role === 'dispatcher';

  const [vanId, setVanId] = useState<string>(currentVanId === null ? '' : String(currentVanId));
  const [driverId, setDriverId] = useState<string>(
    currentDriverId === null ? '' : String(currentDriverId),
  );
  const [reason, setReason] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  // Only `in_progress` demands a reason (owner Q3). The field is ABSENT
  // otherwise rather than present-and-optional: an optional box beside a van
  // swap invites a blank one.
  const reasonRequired = status === 'in_progress';
  const awaitingPayment = status === 'pending_verification';

  const options = trpc.admin.calendar.dayOptions.useQuery(
    { bookingId },
    // The gate is here as well as in the render: finance must not ISSUE this
    // query, or they meet a FORBIDDEN for an action never offered to them.
    { enabled: canAssign, retry: false },
  );

  /*
   * `suggest` is a tRPC QUERY, not a mutation — deliberately, because it
   * writes nothing (Task 11). So it is fetched on demand through the
   * utils helper rather than with `useMutation`, and `suggesting` is local
   * state instead of a mutation's `isPending`. Making it a mutation
   * client-side to get a nicer hook would misdescribe it.
   */
  const utils = trpc.useUtils();
  const [suggesting, setSuggesting] = useState(false);
  const assign = trpc.admin.dispatch.assign.useMutation();

  // A changed booking resets the panel: the same component instance is
  // reused as a dispatcher clicks down a day's trips.
  useEffect(() => {
    setVanId(currentVanId === null ? '' : String(currentVanId));
    setDriverId(currentDriverId === null ? '' : String(currentDriverId));
    setReason('');
    setBanner(null);
    setConfirmation(null);
    setSuggestNote(null);
  }, [bookingId, currentVanId, currentDriverId]);

  if (!canAssign) return null;

  const vans = options.data?.vans ?? [];
  const drivers = options.data?.drivers ?? [];
  const ready = vanId !== '' && driverId !== '' && (!reasonRequired || reason.trim().length >= 3);

  async function runSuggest() {
    setBanner(null);
    setConfirmation(null);
    setSuggesting(true);
    try {
      const result = await utils.admin.dispatch.suggest.fetch({ bookingId });
      if (result.van) setVanId(String(result.van.id));
      if (result.driver) setDriverId(String(result.driver.id));
      setSuggestNote(SUGGEST_NOTE_COPY[result.note] ?? null);
    } catch (error) {
      setBanner(refusalMessage(error));
    } finally {
      setSuggesting(false);
    }
  }

  function runAssign() {
    setBanner(null);
    setConfirmation(null);
    setSuggestNote(null);
    const chosenVan = vans.find((v) => String(v.id) === vanId);
    const chosenDriver = drivers.find((d) => String(d.id) === driverId);
    assign.mutate(
      {
        bookingId,
        vanId: Number(vanId),
        driverId: Number(driverId),
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: () => {
          setConfirmation(
            `Assigned ${chosenVan?.plate ?? 'the van'} and ${chosenDriver?.name ?? 'the driver'}.`,
          );
          setReason('');
          onAssigned();
        },
        onError: (error) => setBanner(refusalMessage(error)),
      },
    );
  }

  return (
    <section
      data-testid="assign-panel"
      aria-label="Assign a van and driver"
      className={`border-brand-blue-100 rounded-[14px] border bg-white p-5 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-brand-ink text-lg font-bold">Assign van and driver</h3>
        {awaitingPayment ? (
          // Owner Q2: pre-assigning an unverified receipt is allowed, and the
          // label is TEXT so a dispatcher scanning tomorrow's board can see
          // which staffed trips can still fall through on money.
          <Badge data-testid="unpaid-label" className="border-0 bg-amber-100 text-amber-900">
            Unpaid — receipt not yet checked
          </Badge>
        ) : null}
      </div>

      {/* The options query's failure is handled BY HAND, outside any
          listbox: `QueryBoundary` renders a "Try again" <button>, and a
          button must never appear inside a Radix listbox — the lesson
          `HeroSection.tsx` already carries in a comment. */}
      {options.isError ? (
        <p role="alert" className="text-brand-error mt-2 text-sm">
          The van and driver lists could not load. Reload the day to try again.
        </p>
      ) : null}

      <div className="mt-3 grid gap-3">
        <div className="border-brand-blue-200 bg-brand-blue-50 space-y-1.5 rounded-[10px] border p-3">
          <Label htmlFor={`assign-van-${bookingId}`}>Van</Label>
          <Select value={vanId} onValueChange={setVanId}>
            <SelectTrigger id={`assign-van-${bookingId}`} className="tap-target w-full">
              <SelectValue placeholder={options.isPending ? 'Loading…' : 'Choose a van'} />
            </SelectTrigger>
            <SelectContent>
              {vans.map((van) => (
                <SelectItem key={van.id} value={String(van.id)}>
                  {van.plate} · {van.capacity} seats
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border-brand-blue-200 bg-brand-blue-50 space-y-1.5 rounded-[10px] border p-3">
          <Label htmlFor={`assign-driver-${bookingId}`}>Driver</Label>
          <Select value={driverId} onValueChange={setDriverId}>
            <SelectTrigger id={`assign-driver-${bookingId}`} className="tap-target w-full">
              <SelectValue placeholder={options.isPending ? 'Loading…' : 'Choose a driver'} />
            </SelectTrigger>
            <SelectContent>
              {drivers.map((driver) => (
                <SelectItem key={driver.id} value={String(driver.id)}>
                  {driver.name} · {driver.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Explains the ABSENCES rather than counting them. `dayOptions`
          returns only what is free and no total, so a count would be
          invented — and the rule is more useful than a number anyway: it
          tells a dispatcher why the van they expected is missing. */}
      <p className="text-brand-error mt-2 text-xs">
        Only vans and drivers free on this date are listed, for {pax} guests. In-repair, parked,
        too-small and already-assigned vans are hidden, as are drivers on leave or already out.
      </p>

      {reasonRequired ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`assign-reason-${bookingId}`}>
            Reason for changing a trip under way <span aria-hidden="true">·</span>{' '}
            <span className="text-brand-gold-800 font-semibold">Required</span>
          </Label>
          <textarea
            id={`assign-reason-${bookingId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="border-input bg-background focus-visible:ring-ring tap-target w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
            placeholder="e.g. ABC 123 broke down at Carcar"
          />
          <p className="text-brand-error text-xs">
            This trip has already started, so the change is recorded with your name and this reason.
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="tap-target border-brand-blue-200 text-brand-blue-700 flex-1 rounded-[10px] font-semibold"
          disabled={suggesting || options.isPending}
          onClick={() => void runSuggest()}
        >
          {suggesting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          Suggest
        </Button>
        <Button
          type="button"
          className="tap-target flex-1 rounded-[10px] font-semibold"
          disabled={!ready || assign.isPending || options.isError}
          onClick={runAssign}
        >
          {assign.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          Assign
        </Button>
      </div>

      {banner !== null ? (
        <p role="alert" className="text-brand-error mt-2 text-sm">
          {banner}
        </p>
      ) : null}
      {suggestNote !== null && suggestNote !== '' ? (
        <p role="status" className="text-brand-ink mt-2 text-sm">
          {suggestNote}
        </p>
      ) : null}
      {confirmation !== null ? (
        <p role="status" className="text-brand-ink mt-2 text-sm">
          {confirmation}
          {awaitingPayment ? ' This trip is still unpaid until the receipt is checked.' : ''}
        </p>
      ) : null}
    </section>
  );
}
