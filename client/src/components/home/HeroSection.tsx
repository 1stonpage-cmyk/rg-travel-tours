import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { DESTINATIONS, PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

const today = new Date().toISOString().slice(0, 10);

export default function HeroSection() {
  const navigate = useNavigate();
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState('');
  const [guests, setGuests] = useState('2');

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
          <p className="text-brand-gold-300 text-sm font-semibold uppercase tracking-widest">
            Cebu, Philippines
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-5xl">
            Private Cebu day tours, booked direct with the people who run them.
          </h1>
          <p className="text-brand-blue-100 mt-4 text-base sm:text-lg">
            Whale sharks, canyoneering and island hopping in your own van with a licensed driver.
            Reserve with a {PLACEHOLDER_SETTINGS.depositPercent}% deposit.
          </p>

          {/* Trust line — placeholder settings values, marked by the dev banner.
              ratingCount is deliberately nullable: no client-supplied review count
              exists yet, so the "from N guest reviews" clause only renders once a
              real count is supplied (spec section 0 forbids fabricating it). */}
          <ul className="text-brand-blue-100 mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <li className="flex items-center gap-1.5">
              <span className="text-brand-gold-300 font-bold">
                {PLACEHOLDER_SETTINGS.ratingAverage.toFixed(1)}★
              </span>
              {PLACEHOLDER_SETTINGS.ratingCount !== null && (
                <span>from {PLACEHOLDER_SETTINGS.ratingCount} guest reviews</span>
              )}
            </li>
            <li aria-hidden="true" className="text-brand-blue-400">
              |
            </li>
            <li>DOT accredited</li>
            <li aria-hidden="true" className="text-brand-blue-400">
              |
            </li>
            <li>{PLACEHOLDER_SETTINGS.guestsServed.toLocaleString('en-PH')}+ guests served</li>
          </ul>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-background/95 mt-10 grid gap-4 rounded-2xl p-4 shadow-xl backdrop-blur sm:p-6 lg:grid-cols-[1.4fr_1fr_0.8fr_auto]"
          aria-label="Search tours"
        >
          <div className="space-y-1.5">
            <Label htmlFor="hero-destination">Destination</Label>
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger id="hero-destination" className="tap-target w-full">
                <SelectValue placeholder="Anywhere in Cebu" />
              </SelectTrigger>
              <SelectContent>
                {DESTINATIONS.map((d) => (
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
              Search tours
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
