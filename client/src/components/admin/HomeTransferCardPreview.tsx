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
 * The price and photo are deliberately NOT previewed: both are computed on
 * the public page from data this form does not carry (the lowest van price
 * across vehicle types, and the destination's own photo) — Task 7's public
 * router, not this admin screen. Saying so in the surrounding section's own
 * copy (`AdminTransferRoutesPage.tsx`) is what keeps this placeholder from
 * reading as a bug.
 */
import { PLACE_TYPE_ICON } from '@/lib/place-types';
import { friendlyDuration } from '@/lib/duration-words';
import type { TransferPlaceType } from '@rg/shared';

export default function HomeTransferCardPreview({
  fromName,
  toName,
  fromPlaceType,
  durationMinutes,
  badge,
  shortDescription,
}: {
  fromName: string;
  toName: string;
  fromPlaceType: TransferPlaceType;
  durationMinutes: number;
  badge: string | null;
  shortDescription: string | null;
}) {
  const Icon = PLACE_TYPE_ICON[fromPlaceType];
  return (
    <div className="border-brand-blue-100 relative max-w-xs overflow-hidden rounded-xl border bg-white">
      <div className="bg-brand-blue-50 text-brand-blue-900 relative flex h-24 items-center justify-center text-xs">
        Photo
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
