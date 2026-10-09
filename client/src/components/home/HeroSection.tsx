import { Search } from 'lucide-react';
import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { trpc } from '@/lib/trpc';

const today = new Date().toISOString().slice(0, 10);

/**
 * Stand-in for the eyebrow/headline/subtitle/trust-line block below, sized
 * to roughly the same box so there is minimal shift once settings resolve.
 * This is the ONLY part of the hero gated on a query — see the component
 * comment for why the photo, overlays and search form are not.
 */
function HeroCopySkeleton() {
  return (
    <div aria-hidden="true">
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
 * The hero is above the fold — the first thing every guest sees, often over
 * a slow Philippine mobile connection. So unlike every other settings-driven
 * section, it must NOT gate its photo, overlays or search form behind a
 * query-pending check: those render unconditionally, every time, with no
 * dependency on `settingsQuery`/`destinationsQuery` having resolved. Only
 * the copy (eyebrow, headline, subtitle, trust line) — which has no
 * reasonable placeholder text that wouldn't itself be fabricated copy — is
 * allowed to show a skeleton while `settings.get` loads.
 */
export default function HeroSection() {
  const navigate = useNavigate();
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState('');
  const [guests, setGuests] = useState('2');

  const settingsQuery = trpc.settings.get.useQuery();
  const destinationsQuery = trpc.destinations.list.useQuery();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (destination) params.set('destination', destination);
    if (date) params.set('date', date);
    if (guests) params.set('guests', guests);
    navigate(`/tours?${params.toString()}`);
  }

  return (
    <section className="relative isolate overflow-hidden">
      {/* Real photo (assets-source/), not a placeholder. `display: contents` on the
          <picture> keeps the absolutely-positioned <img> behaving exactly as the
          single <img> it replaced — no extra box, no layout shift. */}
      <picture className="contents">
        <source
          type="image/webp"
          srcSet="/hero/hero-cebu-800.webp 800w, /hero/hero-cebu-1920.webp 1920w"
          sizes="100vw"
        />
        <img
          src="/hero/hero-cebu-1920.jpg"
          srcSet="/hero/hero-cebu-800.jpg 800w, /hero/hero-cebu-1920.jpg 1920w"
          sizes="100vw"
          width={1920}
          height={1080}
          alt="The stone gateway of Fort San Pedro in Cebu City, framed by palm trees under a clear blue sky."
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 -z-10 size-full object-cover"
        />
      </picture>
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
            {({ trust, hero }) => {
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
              if (trust.dotAccredited) {
                trustItems.push(<li key="dot">DOT accredited</li>);
              }
              if (trust.guestsServed !== null) {
                trustItems.push(
                  <li key="guests">{trust.guestsServed.toLocaleString('en-PH')}+ guests served</li>,
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

        <form
          onSubmit={handleSubmit}
          className="bg-background/95 motion-rise mt-10 grid gap-4 rounded-2xl p-4 shadow-xl backdrop-blur [animation-delay:320ms] sm:p-6 lg:grid-cols-[1.4fr_1fr_0.8fr_auto]"
          aria-label="Search tours"
        >
          <div className="space-y-1.5">
            <Label htmlFor="hero-destination">Destination</Label>
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger id="hero-destination" className="tap-target w-full">
                <SelectValue placeholder="Anywhere in Cebu" />
              </SelectTrigger>
              <SelectContent>
                <QueryBoundary
                  query={destinationsQuery}
                  skeleton={
                    <SelectItem value="__loading" disabled>
                      Loading destinations…
                    </SelectItem>
                  }
                  errorTitle="Destinations could not load"
                >
                  {(destinations) => (
                    <>
                      {destinations.map((d) => (
                        <SelectItem key={d.slug} value={d.slug}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </>
                  )}
                </QueryBoundary>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hero-date">Date</Label>
            <Input
              id="hero-date"
              type="date"
              min={today}
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
            <Button type="submit" size="lg" className="tap-target w-full lg:w-auto">
              <Search className="size-4" aria-hidden="true" />
              {settingsQuery.data?.hero.ctaLabel ?? 'Search tours'}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
