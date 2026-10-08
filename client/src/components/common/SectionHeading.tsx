import { cn } from '@/lib/utils';

type Props = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align?: 'left' | 'center';
  className?: string;
};

export default function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  className,
}: Props) {
  return (
    <div
      className={cn(
        'mx-auto max-w-2xl',
        align === 'center' ? 'text-center' : 'mx-0 text-left',
        className,
      )}
    >
      {eyebrow && (
        <p className="text-brand-gold-600 mb-2 text-sm font-semibold uppercase tracking-widest">
          {eyebrow}
        </p>
      )}
      <h2 className="text-brand-blue-900 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      {subtitle && <p className="text-muted-foreground mt-3 text-base">{subtitle}</p>}
    </div>
  );
}
