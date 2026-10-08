import { Clock, MapPin, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import StarRating from '@/components/common/StarRating';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatPeso, type TOURS } from '@/lib/placeholder-data';

type Props = { tour: (typeof TOURS)[number] };

export default function TourCard({ tour }: Props) {
  return (
    <Card className="press group overflow-hidden p-0 hover:-translate-y-1 hover:shadow-lg">
      <div className="bg-brand-blue-100 relative aspect-[4/3] overflow-hidden">
        <img
          src={tour.image}
          alt={tour.alt}
          loading="lazy"
          className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
        />
        {tour.freeCancellation && (
          <Badge className="bg-brand-gold-500 text-brand-blue-950 absolute left-3 top-3 border-0">
            Free cancellation
          </Badge>
        )}
      </div>

      <CardContent className="space-y-3 p-4">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <MapPin className="size-3.5" aria-hidden="true" />
          {tour.destination}
          <span aria-hidden="true">·</span>
          <Clock className="size-3.5" aria-hidden="true" />
          {tour.durationHours}h
        </p>

        <h3 className="text-brand-blue-900 text-base font-semibold leading-snug">
          <Link to={`/tours/${tour.slug}`} className="flex min-h-11 items-center hover:underline">
            {tour.title}
          </Link>
        </h3>

        <StarRating value={tour.ratingAverage} count={tour.ratingCount} />

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {tour.bookedTotal} trips run
          </span>
          {/* Spec: hide the weekly count entirely when it is 0. */}
          {tour.bookedThisWeek > 0 && (
            <span className="text-brand-gold-700 font-semibold">
              Booked {tour.bookedThisWeek}× this week
            </span>
          )}
        </div>

        <div className="flex items-end justify-between pt-1">
          <p className="text-sm">
            <span className="text-muted-foreground">from </span>
            <span className="text-brand-blue-900 text-lg font-bold">
              {formatPeso(tour.fromPriceCentavos)}
            </span>
            <span className="text-muted-foreground"> / person</span>
          </p>
          <Link
            to={`/tours/${tour.slug}`}
            className="text-brand-blue-700 hover:bg-brand-blue-50 inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold"
          >
            View tour
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
