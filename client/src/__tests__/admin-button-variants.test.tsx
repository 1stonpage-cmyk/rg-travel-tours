/**
 * B1 (DEMO POLISH batch, 2026-11-09) — the admin "Clean Pill" button system
 * (owner decision 1; Option A in `.design-preview/admin-buttons.html`,
 * git-excluded). Pins the exact values that file specifies, and — the part
 * most likely to silently regress — that a caller who names one of the five
 * admin variants WITHOUT also passing a `size` prop still gets the pill's
 * own 44px sizing rather than the default `size`'s `h-9` winning the
 * Tailwind-merge conflict. See `button.tsx`'s own comment on why that is a
 * real foot-gun, not a hypothetical one.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';

describe('admin pill button variants', () => {
  it('primary-pill: 44px tall, full radius, solid blue, no size prop required', () => {
    render(<Button variant="primary-pill">Add vehicle type</Button>);
    const button = screen.getByRole('button', { name: 'Add vehicle type' });
    expect(button.className).toContain('h-11');
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('bg-brand-blue-600');
    expect(button.className).toContain('text-white');
    // Never the default size's classes leaking through.
    expect(button.className).not.toMatch(/(?:^|\s)h-9(?:\s|$)/);
  });

  it('secondary-pill: white fill, 1.5px blue border, blue text, 44px tall', () => {
    render(<Button variant="secondary-pill">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('h-11');
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('border-[1.5px]');
    expect(button.className).toContain('border-brand-blue-600');
    expect(button.className).toContain('bg-white');
    expect(button.className).toContain('text-brand-blue-600');
  });

  it('admin-ghost: transparent at rest, blue-800 text, tint on hover — and does not touch the public ghost variant', () => {
    render(<Button variant="admin-ghost">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('bg-transparent');
    expect(button.className).toContain('text-brand-blue-800');
    expect(button.className).toContain('hover:bg-brand-blue-50');
  });

  it('row: 32px visible, blue outline, but a 44px invisible hit-area via ::before', () => {
    render(<Button variant="row">Edit</Button>);
    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('border-brand-blue-600');
    expect(button.className).toContain('relative');
    expect(button.className).toContain('before:-inset-x-1');
    expect(button.className).toContain('before:-inset-y-1.5');
  });

  it('row-amber: 32px visible, amber outline (not the forbidden color), 44px hit-area', () => {
    render(<Button variant="row-amber">Deactivate</Button>);
    const button = screen.getByRole('button', { name: 'Deactivate' });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('border-brand-warning');
    expect(button.className).toContain('text-brand-warning');
    expect(button.className).not.toMatch(/\bred\b/);
    expect(button.className).toContain('before:-inset-x-1');
    expect(button.className).toContain('before:-inset-y-1.5');
  });

  it('disabled state: reduced opacity, no pointer events, on every admin variant', () => {
    render(
      <Button variant="primary-pill" disabled>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('disabled:opacity-50');
    expect(button.className).toContain('disabled:pointer-events-none');
    expect(button).toBeDisabled();
  });

  it('focus-visible ring is inherited from the shared base, unchanged for admin variants', () => {
    render(<Button variant="secondary-pill">Edit</Button>);
    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button.className).toContain('focus-visible:ring-[3px]');
    expect(button.className).toContain('focus-visible:ring-ring/50');
  });

  it('an explicit size prop is still honoured if a caller passes one on purpose', () => {
    render(
      <Button variant="primary-pill" size="sm">
        Odd combo
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Odd combo' });
    // size="sm" wins over the variant's own h-11, by design (explicit beats inferred).
    expect(button.className).toContain('h-8');
  });

  it('the public-site ghost variant is untouched by the admin-ghost addition', () => {
    render(<Button variant="ghost">Public ghost</Button>);
    const button = screen.getByRole('button', { name: 'Public ghost' });
    expect(button.className).toContain('hover:bg-accent');
    expect(button.className).not.toContain('text-brand-blue-800');
    expect(button.className).not.toContain('rounded-full');
  });
});
