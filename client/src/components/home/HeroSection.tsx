import { HERO_IMAGE_PRELOAD, TRANSFER_PRODUCT_TYPES, type TransferProductType } from '@rg/shared';
import { Car, Search } from 'lucide-react';
import { Fragment, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import CountUpStat from '@/components/common/CountUpStat';
import QueryBoundary from '@/components/common/QueryBoundary';
import { Skeleton } from '@/components/common/Skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHeroParallax } from '@/lib/use-hero-parallax';
import { trpc } from '@/lib/trpc';

/**
 * Stand-in for the eyebrow/headline/subtitle/trust-line block below, sized
 * to roughly the same box so there is minimal shift once settings resolve.
 * This is the ONLY part of the hero gated on a query — see the component
 * comment for why the photo, overlays and search form are not.
 */
function HeroCopySkeleton() {
  return (
    <div role="status" aria-label="Loading hero content">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-3 h-9 w-full sm:h-12" />
      <Skeleton className="mt-2 h-9 w-2/3 sm:h-12" />
      <Skeleton className="mt-4 h-5 w-full" />
      <Skeleton className="mt-1.5 h-5 w-5/6" />
      <Skeleton className="mt-6 h-5 w-60" />
    </div>
  );
}

/**
 * Transfers lead the hero (owner decision 8, Task T14) — the same two labels
 * `TransferTypePicker` uses on the booking page itself, kept here as a small,
 * local copy rather than imported: that component is a card-and-radio picker
 * built for a full booking step, not a fit for this form's compact one-row
 * grid, and this task may not touch its internals (see HeroSection's own
 * note below).
 */
const TRANSFER_TYPE_LABELS: Record<TransferProductType, string> = {
  transfer_one_way: 'Airport transfer',
  transfer_day_use: 'Day use',
};

/**
 * The hero is above the fold — the first thing every guest sees, often over
 * a slow Philippine mobile connection. So unlike every other settings-driven
 * section, it must NOT gate its photo, overlays or search form behind a
 * query-pending check: those render unconditionally, every time, with no
 * dependency on `settingsQuery`/`destinationsQuery` having resolved. Only
 * the copy (eyebrow, headline, subtitle, trust line) — which has no
 * reasonable placeholder text that wouldn't itself be fabricated copy — is
 * allowed to show a skeleton while `settings.get` loads.
 *
 * **The date field's `min`/`max` come from `settingsQuery.data.bookingWindow`
 * (Task 8b) — never the browser clock.** This used to be
 * `new Date().toISOString().slice(0, 10)`, computed client-side: wrong twice
 * over, since it read the BROWSER's clock (a guest in London with a skewed
 * clock would see a different earliest date than one in Cebu) rather than
 * Asia/Manila, and it had no cutoff or ceiling at all, so the picker could
 * offer a date `createHold` would refuse outright (today, past the 18:00
 * Manila cutoff on tomorrow, or past the 180-day ceiling).
 * `SettingsPayload.bookingWindow` (`server/src/content/settings.ts`) is
 * already resolved server-side against the Manila clock into two plain
 * civil dates — this reads them and does no date arithmetic of its own.
 * Before `settingsQuery` resolves, `min`/`max` are simply omitted (not
 * computed from anything) rather than reintroducing a client clock as a
 * fallback.
 *
 * **Transfers lead (Task T14, owner decision 8).** A second, PRIMARY form
 * sits above this one: a product-type `Select`, a route `Select` fed by
 * `trpc.transferRoutes.list.useQuery()`, a pickup-date `Input` and a
 * passengers `Input`, built from the same plain `Select`/`Input` primitives
 * as the fields below rather than the T13 card-and-radio pickers
 * (`TransferTypePicker`/`RoutePicker`), which are full-width booking-step
 * UI and not a fit for this compact one-row grid — and this task may not
 * touch their internals either way. It is a teaser only: on submit it hands
 * off to `/transfer` via a query string, never calling `quoteTransfer` or
 * any pricing procedure itself. The tour search below is UNCHANGED —
 * same `aria-label="Search tours"` (which `FloatingWhatsApp.tsx` also
 * selects by, to know when to hide behind this card), same field ids and
 * labels, same `hero.ctaLabel` copy — only its surrounding treatment is
 * quieter, so it stays demoted rather than hidden or unmounted.
 */
export default function HeroSection() {
  const navigate = useNavigate();
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState('');
  const [guests, setGuests] = useState('2');

  const [transferProductType, setTransferProductType] =
    useState<TransferProductType>('transfer_one_way');
  const [transferRouteId, setTransferRouteId] = useState('');
  const [transferDate, setTransferDate] = useState('');
  const [transferPax, setTransferPax] = useState('2');

  const settingsQuery = trpc.settings.get.useQuery();
  const destinationsQuery = trpc.destinations.list.useQuery();
  const transferRoutesQuery = trpc.transferRoutes.list.useQuery();

  const heroImageRef = useRef<HTMLImageElement>(null);
  useHeroParallax(heroImageRef);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (destination) params.set('destination', destination);
    if (date) params.set('date', date);
    if (guests) params.set('guests', guests);
    navigate(`/tours?${params.toString()}`);
  }

  function handleTransferSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    params.set('productType', transferProductType);
    if (transferRouteId) params.set('routeId', transferRouteId);
    if (transferDate) params.set('date', transferDate);
    if (transferPax) params.set('pax', transferPax);
    navigate(`/transfer?${params.toString()}`);
  }

  return (
    <section className="relative isolate overflow-hidden">
      {/* Real photo (assets-source/), not a placeholder.

          This photo is the mobile LCP element, and it only exists inside this
          bundle — so the server's SEO injector emits a matching
          <link rel="preload" as="image"> that lets the browser start fetching
          it at HTML-parse time instead of waiting for the bundle to download,
          parse and run (task 4.4).

          That preload is emitted for `/` ALONE, by the home resolver in
          server/src/seo/resolvers.ts (task 4.4b) — it used to sit in the static
          client/index.html, which is the shared SPA shell, so /tours, /privacy
          and /terms were preloading a hero they never render.

          There is no <picture>/<source> here any more (BUG-103): the WebP
          source was bigger than the JPEG at both widths, so it cost bytes
          instead of saving them. The <img> below and the preload both read
          HERO_IMAGE_PRELOAD, so their candidate lists cannot drift — a
          mismatch would make the browser preload one candidate and the <img>
          fetch another, i.e. two hero downloads instead of one faster one.
          `width`/`height` stay inline: they are what reserves the box before
          the stylesheet lands. */}
      <img
        ref={heroImageRef}
        src="/hero/hero-cebu-1920.jpg"
        srcSet={HERO_IMAGE_PRELOAD.srcset}
        sizes={HERO_IMAGE_PRELOAD.sizes}
        width={1920}
        height={1080}
        alt="The stone gateway of Fort San Pedro in Cebu City, framed by palm trees under a clear blue sky."
        fetchPriority="high"
        decoding="async"
        className="absolute inset-0 -z-10 size-full object-cover"
      />
      {/* Two blue washes over the photo: a vertical darkener that holds white text
          at AA over the bright sky, plus the diagonal brand tint. Blues only. */}
      <div className="from-brand-blue-950/80 via-brand-blue-950/60 to-brand-blue-900/90 absolute inset-0 -z-10 bg-gradient-to-b" />
      <div className="from-brand-blue-900/60 via-brand-blue-800/20 to-brand-blue-950/40 absolute inset-0 -z-10 bg-gradient-to-br" />

      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <QueryBoundary
            query={settingsQuery}
            skeleton={<HeroCopySkeleton />}
            errorTitle="Content could not load"
          >
            {({ trust, hero, permits }) => {
              // ratingCount is nullable: no client-supplied review count
              // exists yet, so the "from N guest reviews" clause only
              // renders once a real count is supplied (no fabricated social
              // proof). ratingAverage/guestsServed are independently
              // nullable — each item is omitted entirely, not rendered as
              // "0" or "—", when its value is null.
              const trustItems: ReactNode[] = [];
              if (trust.ratingAverage !== null) {
                trustItems.push(
                  <li key="rating" className="flex items-center gap-1.5">
                    <span className="text-brand-gold-300 font-bold">
                      {trust.ratingAverage.toFixed(1)}★
                    </span>
                    {trust.ratingCount !== null && (
                      <span>from {trust.ratingCount} guest reviews</span>
                    )}
                  </li>,
                );
              }
              // Decision 4 (2026-11-10): never claim DOT accreditation
              // without a real permit number — `trust.dotAccredited` alone
              // is an admin toggle, not proof; `permits.dot` is the actual
              // number, "— pending —" (null) until one exists.
              if (trust.dotAccredited && permits.dot !== null) {
                trustItems.push(<li key="dot">DOT accredited</li>);
              }
              if (trust.guestsServed !== null) {
                trustItems.push(
                  // Count-up for this trust stat only (spec 2.9E) — never
                  // for a price. See CountUpStat.tsx / use-count-up.ts.
                  <li key="guests">
                    <CountUpStat value={trust.guestsServed} /> guests served
                  </li>,
                );
              }

              return (
                <>
                  <p className="motion-rise text-brand-gold-300 text-sm font-semibold uppercase tracking-widest">
                    {hero.eyebrow}
                  </p>
                  <h1 className="motion-rise mt-3 text-3xl font-bold tracking-tight text-white [animation-delay:80ms] sm:text-5xl">
                    {hero.headline}
                  </h1>
                  <p className="text-brand-blue-100 motion-rise mt-4 text-base [animation-delay:160ms] sm:text-lg">
                    {hero.subtitle}
                  </p>

                  {trustItems.length > 0 && (
                    <ul className="text-brand-blue-100 motion-rise mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm [animation-delay:240ms]">
                      {trustItems.map((item, i) => (
                        <Fragment key={i}>
                          {i > 0 && (
                            <li aria-hidden="true" className="text-brand-blue-400">
                              |
                            </li>
                          )}
                          {item}
                        </Fragment>
                      ))}
                    </ul>
                  )}
                </>
              );
            }}
          </QueryBoundary>
        </div>

        <div className="motion-rise mt-10 [animation-delay:320ms]">
          {/*
           * PRIMARY — the transfer mini-flow (Task T14, owner decision 8).
           * A teaser only: it hands off to `/transfer` via a query string
           * and never prices anything itself (see the component comment).
           */}
          <form
            onSubmit={handleTransferSubmit}
            className="bg-background grid gap-4 rounded-2xl p-4 shadow-xl sm:p-6 lg:grid-cols-[1fr_1.3fr_0.9fr_0.7fr_auto]"
            aria-label="Find a transfer"
          >
            <div className="space-y-1.5">
              <Label htmlFor="hero-transfer-type">Transfer type</Label>
              <Select
                value={transferProductType}
                onValueChange={(value) => setTransferProductType(value as TransferProductType)}
              >
                <SelectTrigger id="hero-transfer-type" className="tap-target w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSFER_PRODUCT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TRANSFER_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hero-transfer-route">Route</Label>
              {/* Same loading/empty handling as the destination Select
                  below, by hand rather than QueryBoundary, for the same
                  reason — a Radix listbox must never render a "Try again"
                  button. */}
              <Select value={transferRouteId} onValueChange={setTransferRouteId}>
                <SelectTrigger id="hero-transfer-route" className="tap-target w-full">
                  <SelectValue placeholder="Choose a route" />
                </SelectTrigger>
                <SelectContent>
                  {transferRoutesQuery.isPending && (
                    <SelectItem value="__loading" disabled>
                      Loading routes…
                    </SelectItem>
                  )}
                  {transferRoutesQuery.data?.map((route) => (
                    <SelectItem key={route.id} value={String(route.id)}>
                      {route.fromPlace.name} → {route.toPlace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hero-transfer-date">Pickup date</Label>
              <Input
                id="hero-transfer-date"
                type="date"
                min={settingsQuery.data?.bookingWindow.earliest}
                max={settingsQuery.data?.bookingWindow.latest}
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className="tap-target"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hero-transfer-pax">Passengers</Label>
              <Input
                id="hero-transfer-pax"
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                value={transferPax}
                onChange={(e) => setTransferPax(e.target.value)}
                className="tap-target"
              />
            </div>

            <div className="flex items-end">
              <Button type="submit" size="lg" className="tap-target w-full lg:w-auto">
                <Car className="size-4" aria-hidden="true" />
                Find my transfer
              </Button>
            </div>
          </form>

          {/*
           * SECONDARY — the tour search, demoted (a lighter `shadow-sm` and
           * an outline, not solid, submit button) but otherwise byte-for-byte
           * the form that already existed: same aria-label, ids, labels and
           * `hero.ctaLabel` copy, mounted and visible at every viewport.
           *
           * **`bg-background/95` + `backdrop-blur` are the ORIGINAL card's
           * own values, deliberately unchanged (T14 review fix, Important
           * 4).** A first pass of this demotion lowered them to `/80` with no
           * blur — a real contrast regression this guard test cannot see
           * (`contrast.test.ts` only resolves `bg-brand-*`/`text-brand-*`
           * pairs in one class string; it has no notion of a translucent
           * card composited over the hero's separate photo+gradient layers,
           * which is exactly what the blur existed to make reliable). The
           * demotion itself — position, shadow weight, button variant —
           * stays; only the background/blur treatment was restored.
           *
           * A tabbed toggle was ruled out deliberately — it would unmount or
           * `hidden` this form on first render, which breaks both the
           * existing test suite (`getByRole('form', {name: /search
           * tours/i})` et al.) and `FloatingWhatsApp.tsx`'s own
           * `form[aria-label="Search tours"]` selector.
           *
           * **`show_tours` gate (transfers-launch plan, Task T16).** This
           * whole block is now conditional on `showTours` — while tours are
           * hidden there is no catalog for this form to search, and
           * `FloatingWhatsApp.tsx` already degrades gracefully when its
           * `form[aria-label="Search tours"]` selector finds nothing (see
           * its own code comment).
           *
           * The check is `!== false`, not `?? false` (the "hidden until
           * proven true" default `CatalogPreview`/`MostVisited`/the nav use
           * elsewhere in this task): THIS form carries the explicit
           * "renders unconditionally, every time, with no dependency on
           * settingsQuery having resolved" contract from the component
           * comment above, and `?? false` would break that the instant
           * `settingsQuery` is pending or errors — reintroducing exactly
           * the query-pending gate that comment forbids. `!== false` keeps
           * the old behaviour (shown) for "not resolved yet" and "errored"
           * alike, and hides only once the server has actually said so.
           */}
          {settingsQuery.data?.showTours !== false && (
            <>
              <p className="text-brand-blue-100 mt-5 text-sm">
                Looking for a guided day tour instead?
              </p>
              <form
                onSubmit={handleSubmit}
                className="bg-background/95 mt-2 grid gap-3 rounded-xl p-3 shadow-sm backdrop-blur sm:p-4 lg:grid-cols-[1.4fr_1fr_0.8fr_auto]"
                aria-label="Search tours"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="hero-destination">Destination</Label>
                  <Select value={destination} onValueChange={setDestination}>
                    <SelectTrigger id="hero-destination" className="tap-target w-full">
                      <SelectValue placeholder="Anywhere in Cebu" />
                    </SelectTrigger>
                    {/* Handled by hand, not QueryBoundary: a <SelectContent> is a
                  Radix listbox (role="listbox"), and QueryBoundary's error
                  state renders a <button> ("Try again") — a control that
                  must never appear inside a listbox. On failure this
                  degrades to an empty dropdown rather than an error card:
                  the form stays usable and a destination-less search is a
                  valid search. The trigger itself is never gated — it's
                  outside this block entirely. */}
                    <SelectContent>
                      {destinationsQuery.isPending && (
                        <SelectItem value="__loading" disabled>
                          Loading destinations…
                        </SelectItem>
                      )}
                      {destinationsQuery.data?.map((d) => (
                        <SelectItem key={d.slug} value={d.slug}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="hero-date">Date</Label>
                  <Input
                    id="hero-date"
                    type="date"
                    min={settingsQuery.data?.bookingWindow.earliest}
                    max={settingsQuery.data?.bookingWindow.latest}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="tap-target"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="hero-guests">Guests</Label>
                  <Input
                    id="hero-guests"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={12}
                    value={guests}
                    onChange={(e) => setGuests(e.target.value)}
                    className="tap-target"
                  />
                </div>

                <div className="flex items-end">
                  <Button
                    type="submit"
                    variant="outline"
                    className="tap-target bg-background w-full lg:w-auto"
                  >
                    <Search className="size-4" aria-hidden="true" />
                    {settingsQuery.data?.hero.ctaLabel ?? 'Search tours'}
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
