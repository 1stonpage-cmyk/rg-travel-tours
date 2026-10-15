/**
 * §8's itinerary check-ins — **a checklist, not a form** (Week 6 plan,
 * Task 10).
 *
 * One large button per stop, in itinerary order, each showing its check-in
 * TIME once tapped. The time is the acknowledgement, which is why there is
 * no toast: a driver watching the row change is already told.
 *
 * ## Nothing here is optimistic
 *
 * A tap shows pending and then the SERVER's answer — the row only turns
 * into a time when `driver.trip` has been refetched and says so. A stop
 * that appears checked-in and later is not is worse than a half-second
 * wait, because by then the driver has driven away. There is deliberately
 * no local "checked" state to hold a tap in.
 *
 * ## The undo control is labelled for what it will actually do
 *
 * (Ruling 2026-10-15, from Task 6's review.) An undo reverses **one
 * event**, and a trip closed by a last-stop check-in took two — so one tap
 * reopens the trip and a second un-checks the stop. That cannot be
 * collapsed: completion is not a function of the checkpoints (a
 * hand-completed trip closes with stops still unchecked, so there is
 * nothing to re-derive), and re-deriving it would silently un-tap the trip
 * start of every early Complete. So the LABEL carries the difference:
 *
 *  - booking `completed` → **"Reopen trip"**;
 *  - booking `in_progress` → **"Undo last check-in"**, naming the stop.
 *
 * The control is also VISUALLY SEPARATED from the check-in buttons, in its
 * own section below them, and appears only against the most recent
 * un-undone check-in — the only one the server will accept. Adjacency
 * between "Arrived" and "Undo" is how a bump in the road rewrites a trip
 * record.
 *
 * ## The refusal copy is exhaustive, and it lives next door
 *
 * All four mutations answer a VERDICT rather than throwing for the six
 * ordinary refusals, and `CHECK_IN_REFUSAL_COPY` (`trip-copy.ts`) is a
 * `Record<CheckInRefusal, string>` — so a seventh refusal fails the build
 * on the copy that does not exist rather than falling through to a generic
 * sentence in a van.
 *
 * ## Progress is text
 *
 * `3 of 7 stops`, never a bar alone (CLAUDE.md's colour-alone prohibition
 * and the design doc both). `total` counts the trip-start pseudo-stop, so a
 * three-stop tour reads `0 of 4` before departure — deliberate, and NOT
 * adjusted here: it is what makes the dispatcher's bar move when the van
 * leaves. One line of copy says so rather than leaving a driver to wonder.
 */
import { useState } from 'react';
import { Check, Flag, Loader2, MapPin, Undo2 } from 'lucide-react';
import {
  TRIP_START_STOP_NAME,
  manilaTimeHHMM,
  type BookingStatus,
  type CheckInResult,
  type CheckInUndoResult,
  type TripProgress,
  type TripProgressStop,
} from '@rg/shared';
import { CHECK_IN_REFUSAL_COPY } from '@/components/driver/trip-copy';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

/** Anything that never reached the server, or came back unrecognisable. */
const NOT_SAVED = 'That did not save. Check your signal and tap again.';

/** A check-in is DONE only when it happened and was not retracted. */
function isDone(stop: TripProgressStop): boolean {
  return stop.checkedAt !== null && !stop.undone;
}

/** `'2026-10-16T01:45:00.000Z'` -> `'09:45'`, Manila, display only. */
function atTime(iso: string): string {
  return manilaTimeHHMM(new Date(iso));
}

export interface StopListProps {
  bookingId: number;
  status: BookingStatus;
  progress: TripProgress;
  /** Called after any successful mutation, so the caller refetches. */
  onChanged: () => void;
}

export default function StopList({ bookingId, status, progress, onChanged }: StopListProps) {
  /** One notice for the whole checklist — the last answer the server gave. */
  const [notice, setNotice] = useState<string | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [reason, setReason] = useState('');

  /**
   * All four mutations answer a VERDICT (`{ ok: false, reason }`) rather
   * than throwing for the ordinary refusals, so success and refusal are
   * handled in the same place. `onChanged()` runs only on a real success:
   * a refusal leaves the screen exactly as it was, which is what keeps
   * "nothing is optimistic" true for the failure path too.
   */
  function settle(result: CheckInResult | CheckInUndoResult) {
    if (result.ok) {
      setNotice(null);
      setUndoOpen(false);
      setReason('');
      onChanged();
      return;
    }
    setNotice(CHECK_IN_REFUSAL_COPY[result.reason]);
  }

  const onFailure = () => setNotice(NOT_SAVED);

  const start = trpc.driver.startTrip.useMutation({ onSuccess: settle, onError: onFailure });
  const checkIn = trpc.driver.checkIn.useMutation({ onSuccess: settle, onError: onFailure });
  const complete = trpc.driver.completeTrip.useMutation({ onSuccess: settle, onError: onFailure });
  const undo = trpc.driver.undoCheckIn.useMutation({ onSuccess: settle, onError: onFailure });

  const busy = start.isPending || checkIn.isPending || complete.isPending || undo.isPending;

  /**
   * The most recent un-undone check-in — the ONLY one the server accepts an
   * undo for, so the only one this screen offers it against. Last in array
   * order, because `stops` arrives in itinerary order with trip start
   * first.
   */
  const lastDone = [...progress.stops].reverse().find(isDone) ?? null;

  /*
   * Ruling: the control says what it will actually do. A `completed`
   * booking's next undo reopens the trip; an `in_progress` one's retracts
   * the stop it names.
   */
  const undoLabel =
    status === 'completed'
      ? 'Reopen trip'
      : lastDone
        ? `Undo last check-in — ${lastDone.name}`
        : null;

  return (
    <section aria-labelledby="itinerary-heading" className="space-y-3">
      <div>
        <h2 id="itinerary-heading" className="text-brand-blue-900 text-xl font-bold">
          Itinerary
        </h2>
        {/* Progress in words. Never a bar on its own. */}
        <p className="text-brand-blue-900 mt-1 text-lg font-semibold">
          {progress.done} of {progress.total} stops
        </p>
        <p className="text-brand-blue-900 text-sm">Leaving for the pickup counts as the first.</p>
      </div>

      {notice ? (
        <p
          role="alert"
          className="border-brand-error text-brand-error bg-background rounded-lg border-l-4 p-3 text-base font-medium"
        >
          {notice}
        </p>
      ) : null}

      <ol className="space-y-2">
        {progress.stops.map((stop) => {
          const key = stop.stopId === null ? 'trip-start' : `stop-${stop.stopId}`;
          const isStart = stop.stopId === null;
          const done = isDone(stop);
          const pendingThis = isStart
            ? start.isPending
            : checkIn.isPending && checkIn.variables?.stopId === stop.stopId;

          if (done) {
            return (
              <li
                key={key}
                className="border-brand-blue-200 bg-background flex items-center gap-3 rounded-xl border p-4"
              >
                <Check className="text-brand-blue-700 size-6 shrink-0" aria-hidden="true" />
                <span className="text-brand-blue-900 flex-1 text-base font-semibold">
                  {stop.name}
                </span>
                {/*
                 * The TIME is the acknowledgement — larger than the label,
                 * because it is the thing a driver looks for.
                 */}
                <span className="text-brand-blue-900 text-lg font-bold tabular-nums">
                  {atTime(stop.checkedAt!)}
                </span>
              </li>
            );
          }

          return (
            <li key={key}>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setNotice(null);
                  if (isStart) start.mutate({ bookingId });
                  else checkIn.mutate({ bookingId, stopId: stop.stopId! });
                }}
                className="tap-target border-brand-blue-300 text-brand-blue-900 h-16 w-full justify-start gap-3 rounded-xl border-2 px-4 text-left text-base font-semibold"
              >
                {pendingThis ? (
                  <Loader2 className="size-6 shrink-0 animate-spin" aria-hidden="true" />
                ) : isStart ? (
                  <Flag className="size-6 shrink-0" aria-hidden="true" />
                ) : (
                  <MapPin className="size-6 shrink-0" aria-hidden="true" />
                )}
                <span className="whitespace-normal">
                  {pendingThis
                    ? 'Saving…'
                    : isStart
                      ? TRIP_START_STOP_NAME
                      : `Arrived at ${stop.name}`}
                </span>
              </Button>
              {/*
               * §8 keeps a retracted check-in rather than deleting it, and
               * a driver who retracted a tap needs to see that something
               * happened here. It counts as NOT done, so the button above
               * is live again.
               */}
              {stop.checkedAt !== null && stop.undone ? (
                <p className="text-brand-blue-900 mt-1 pl-1 text-sm">
                  Checked in at {atTime(stop.checkedAt)}, then retracted.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {status === 'in_progress' ? (
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setNotice(null);
            complete.mutate({ bookingId });
          }}
          className="tap-target h-14 w-full text-base font-semibold"
        >
          {complete.isPending ? (
            <>
              <Loader2 className="mr-2 size-5 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Complete trip'
          )}
        </Button>
      ) : null}

      {/*
       * The undo, in its OWN section with a rule above it and space around
       * it — never beside an "Arrived" button. Its own heading says what
       * the section is for, so the control below it never has to be the
       * explanation.
       */}
      {undoLabel ? (
        <div className="border-brand-blue-200 mt-8 border-t pt-5">
          <h3 className="text-brand-blue-900 text-base font-bold">Tapped the wrong thing?</h3>
          {undoOpen ? (
            <div className="mt-3 space-y-3">
              <Label htmlFor="undo-reason" className="text-brand-blue-900 text-base">
                Why? The office will see this.
              </Label>
              {/* A plain `<textarea>`, as `AssignPanel` uses — none is vendored. */}
              <textarea
                id="undo-reason"
                value={reason}
                disabled={undo.isPending}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="border-input bg-background focus-visible:ring-ring tap-target text-brand-blue-900 w-full rounded-md border-2 px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2"
              />
              <Button
                type="button"
                variant="outline"
                disabled={reason.trim().length === 0 || undo.isPending}
                onClick={() => {
                  setNotice(null);
                  undo.mutate({ bookingId, reason: reason.trim() });
                }}
                className="tap-target border-brand-blue-300 text-brand-blue-900 h-14 w-full border-2 text-base font-semibold"
              >
                {undo.isPending ? (
                  <>
                    <Loader2 className="mr-2 size-5 animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  `Confirm — ${undoLabel}`
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={undo.isPending}
                onClick={() => {
                  setUndoOpen(false);
                  setReason('');
                }}
                className="tap-target text-brand-blue-900 h-14 w-full text-base font-semibold"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setUndoOpen(true)}
              className="tap-target text-brand-blue-900 mt-2 h-14 w-full justify-start gap-3 text-left text-base font-semibold"
            >
              <Undo2 className="size-5 shrink-0" aria-hidden="true" />
              <span className="whitespace-normal">{undoLabel}</span>
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
