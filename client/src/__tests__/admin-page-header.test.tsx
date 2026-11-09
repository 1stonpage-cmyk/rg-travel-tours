/**
 * B1 (DEMO POLISH batch, 2026-11-09) — `AdminPageHeader`, the shared
 * eyebrow/title/description/action shape every admin screen hand-rolled
 * before this, now paired with owner decision 1's placement rule: the
 * primary action sits top-right next to the title (desktop) and wraps full
 * width below it at 360px — never the old full-width bar rendered on its
 * own row regardless of viewport.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdminPageHeader from '@/components/admin/AdminPageHeader';
import { Button } from '@/components/ui/button';

describe('AdminPageHeader', () => {
  it('renders the eyebrow, title and description', () => {
    render(
      <AdminPageHeader
        eyebrow="Operations"
        title="Vehicle types"
        description="The kinds of vehicle a van can be."
      />,
    );
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Vehicle types' })).toBeInTheDocument();
    expect(screen.getByText('The kinds of vehicle a van can be.')).toBeInTheDocument();
  });

  it('omits the description paragraph entirely when none is given', () => {
    render(<AdminPageHeader eyebrow="Operations" title="Vehicle types" />);
    expect(screen.queryByText(/kinds of vehicle/)).not.toBeInTheDocument();
  });

  it('renders the action slot, full width only via the mobile-only wrapper classes — never a forced w-full on desktop', () => {
    render(
      <AdminPageHeader
        eyebrow="Operations"
        title="Vehicle types"
        action={<Button variant="primary-pill">+ Add vehicle type</Button>}
      />,
    );
    const button = screen.getByRole('button', { name: '+ Add vehicle type' });
    const wrapper = button.parentElement!;
    // Full width is scoped to the mobile breakpoint only (`w-full` +
    // `sm:w-auto`), never an unconditional `w-full` that would also hold at
    // desktop widths — that is exactly the "full-bleed bar" the owner
    // disliked.
    expect(wrapper.className).toMatch(/\bw-full\b/);
    expect(wrapper.className).toMatch(/\bsm:w-auto\b/);
  });

  it('renders no action wrapper at all when none is given', () => {
    const { container } = render(<AdminPageHeader eyebrow="Operations" title="Vehicle types" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
