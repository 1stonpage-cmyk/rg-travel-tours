import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Slot } from '@radix-ui/react-slot';

/**
 * Admin button system, "Option A — Clean Pill" (owner decision 1,
 * DEMO POLISH batch, 2026-11-09 — see
 * `.design-preview/admin-buttons.html`, git-excluded, read for the exact
 * values transcribed below). Six self-contained variants — each bakes in
 * its OWN height/padding/radius/font alongside its color treatment, rather
 * than composing with the `size` prop the way the pre-existing variants do.
 * This is deliberate, not an oversight: CVA concatenates `variant` classes
 * BEFORE `size` classes, so `twMerge` lets `size` win any conflict — a
 * caller of `variant="primary-pill"` who forgot to also pass a non-default
 * `size` would silently get the DEFAULT size's `h-9` fighting the pill's
 * intended `h-11`. Folding sizing into the variant itself removes that
 * foot-gun: `<Button variant="primary-pill">` is correct on its own, no
 * paired `size` required.
 *
 * `admin-ghost`, not `ghost`: the existing `ghost` variant is used on the
 * PUBLIC site (`StopList.tsx`, `AnnouncementBar.tsx`) and owner decision 2
 * says public-site buttons are not touched in this run — reusing that key
 * would have silently restyled them.
 *
 * `amber-pill` is the full 44px amber-outline confirm button — e.g. a
 * "Yes, deactivate {name}" inline confirm — never a second `primary-pill`
 * for a destructive action, per owner decision 1 ("Deactivate = amber
 * outline pill. Never red"). `row-amber` is its compact table-row sibling.
 *
 * `row`/`row-amber` stay visually compact (32px) for dense admin tables but
 * keep a real 44px tap target via an invisible `::before` pseudo-element
 * (`-inset-x-1 -inset-y-1.5` around an 8-unit/32px box = 44px on every
 * side) — the same WCAG 2.2 SC 2.5.8 "equivalent target" technique the
 * design file itself uses, not a new idea invented here.
 */
const ADMIN_PILL_VARIANTS = [
  'primary-pill',
  'secondary-pill',
  'admin-ghost',
  'amber-pill',
  'row',
  'row-amber',
] as const;

const buttonVariants = cva(
  "press inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        /* ---- Admin "Clean Pill" system (owner decision 1) ---- */
        'primary-pill':
          'h-11 rounded-full border-[1.5px] border-brand-blue-600 bg-brand-blue-600 px-6 text-sm font-semibold text-white hover:border-brand-blue-700 hover:bg-brand-blue-700 active:border-brand-blue-800 active:bg-brand-blue-800',
        'secondary-pill':
          'h-11 rounded-full border-[1.5px] border-brand-blue-600 bg-white px-6 text-sm font-semibold text-brand-blue-600 hover:bg-brand-blue-50 active:bg-brand-blue-100',
        'admin-ghost':
          'h-11 rounded-full border-[1.5px] border-transparent bg-transparent px-6 text-sm font-semibold text-brand-blue-800 hover:bg-brand-blue-50 active:bg-brand-blue-100',
        'amber-pill':
          'h-11 rounded-full border-[1.5px] border-brand-warning bg-white px-6 text-sm font-semibold text-brand-warning hover:bg-brand-gold-50 active:bg-brand-gold-100',
        row: "relative h-8 rounded-full border-[1.5px] border-brand-blue-600 bg-white px-4 text-[13px] font-semibold text-brand-blue-600 before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-[''] hover:bg-brand-blue-50 active:bg-brand-blue-100",
        'row-amber':
          "relative h-8 rounded-full border-[1.5px] border-brand-warning bg-white px-4 text-[13px] font-semibold text-brand-warning before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-[''] hover:bg-brand-gold-50 active:bg-brand-gold-100",
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
        /**
         * Contributes NOTHING — the admin pill variants above are fully
         * self-contained. This exists only so `size` can be explicitly set
         * to a value whose classes never fight the variant's own, for a
         * caller who prefers to be explicit; `Button` also infers this
         * automatically for the five admin variants when `size` is omitted
         * (see below), so passing it is never required.
         */
        unstyled: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';
  const isAdminPillVariant = (ADMIN_PILL_VARIANTS as readonly (string | undefined)[]).includes(
    variant ?? undefined,
  );
  // See the ADMIN_PILL_VARIANTS comment above: a caller who names one of
  // the five admin variants gets 'unstyled' automatically unless they
  // explicitly asked for something else, so the variant's own baked-in
  // sizing is never silently out-muscled by the default size's classes.
  const resolvedSize = size ?? (isAdminPillVariant ? 'unstyled' : 'default');

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={resolvedSize}
      className={cn(buttonVariants({ variant, size: resolvedSize, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
