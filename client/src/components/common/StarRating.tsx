import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  value: number;
  count?: number;
  size?: 'sm' | 'md';
  className?: string;
};

export default function StarRating({ value, count, size = 'sm', className }: Props) {
  const rounded = Math.round(value);
  const starSize = size === 'sm' ? 'size-4' : 'size-5';

  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <span className="flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className={cn(
              starSize,
              i <= rounded
                ? 'fill-brand-gold-400 text-brand-gold-400'
                : 'fill-brand-blue-100 text-brand-blue-200',
            )}
          />
        ))}
      </span>
      <span className="text-brand-ink text-sm font-semibold">{value.toFixed(1)}</span>
      {typeof count === 'number' && (
        <span className="text-muted-foreground text-sm">({count})</span>
      )}
      <span className="sr-only">
        {value.toFixed(1)} out of 5{typeof count === 'number' ? ` from ${count} reviews` : ''}.
      </span>
    </span>
  );
}
