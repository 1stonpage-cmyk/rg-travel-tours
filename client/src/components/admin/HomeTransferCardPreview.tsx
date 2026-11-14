/**
 * A presentational-only live preview of how a transfer route's "Popular
 * transfers" home-page card will look (owner decision 2026-11-13, Task 1D).
 *
 * **No tRPC call of its own.** Every prop is read from the admin form's
 * OWN unsaved local state (`AdminTransferRoutesPage.tsx`'s `TransferRouteForm`)
 * — this is a preview of what has been typed, not of what is stored, so a
 * badge or description the admin is still editing shows up here before the
 * Save button is ever pressed.
 *
 * The price is deliberately NOT previewed: it is computed on the public
 * page from data this form does not carry (the genuine minimum across every
 * offered vehicle type) — Task 7's public router, not this admin screen. Saying so
 * in the surrounding section's own copy (`AdminTransferRoutesPage.tsx`) is
 * what keeps this placeholder from reading as a bug.
 *
 * The photo tile is ALWAYS the brand-gradient fallback (Task 1B), never a
 * real `<img>` — unlike the live card, which shows a real photo whenever
 * `toPlace.destinationId` resolves to a destination with an `imagePath`.
 * This preview genuinely has no destination photo to fetch (this form
 * carries no destination row, only a `toPlaceId`), so there is nothing to
 * preview beyond the fallback that the chosen toPlace's own icon and name
 * would show. A blue-only gradient, never blue-to-gold — the gold-contrast
 * risk this project has already measured (CLAUDE.md) — with white text,
 * which is unambiguously safe.
 */
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { friendlyDuration } from '@/lib/duration-words';
import type { TransferPlaceType } from '@rg/shared';

export default function HomeTransferCardPreview({
  fromName,
  toName,
  fromPlaceType,
  toPlaceType,
  durationMinutes,
  badge,
  shortDescription,
}: {
  fromName: string;
  toName: string;
  fromPlaceType: TransferPlaceType;
  toPlaceType: TransferPlaceType;
  durationMinutes: number;
  badge: string | null;
  shortDescription: string | null;
}) {
  const Icon = PLACE_TYPE_ICON[fromPlaceType];
  const ToIcon = PLACE_TYPE_ICON[toPlaceType];
  return (
    <div className="border-brand-blue-100 relative max-w-xs overflow-hidden rounded-xl border bg-white">
      <div className="relative h-24 overflow-hidden">
        <div className="from-brand-blue-700 to-brand-blue-950 flex size-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br text-white">
          <ToIcon className="size-6" aria-hidden="true" />
          <span className="px-2 text-center text-xs font-semibold">{toName}</span>
        </div>
        {badge ? (
          <span className="absolute left-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
            {badge}
          </span>
        ) : null}
        {durationMinutes > 0 ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            {friendlyDuration(durationMinutes)}
          </span>
        ) : null}
      </div>
      <div className="p-3">
        <p className="text-brand-ink flex items-center gap-1 text-sm font-semibold">
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          {fromName} → {toName}
        </p>
        {shortDescription ? (
          <p className="text-brand-error mt-1 text-xs">{shortDescription}</p>
        ) : null}
        <p className="text-brand-error mt-2 text-xs">One-way from ₱X per vehicle</p>
      </div>
    </div>
  );
}
