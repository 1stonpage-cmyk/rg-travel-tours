import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConsentCheckbox from '@/components/checkout/ConsentCheckbox';

/**
 * Week 7 batch 5 pre-task (2026-10-28). Task 2E (`02dc0ab`) added three
 * `<a>` links inside the consent `<Label>`, which collided with the shadcn
 * `Label` primitive's own `flex items-center gap-2` base classes
 * (`components/ui/label.tsx`): each link became a flex ITEM instead of
 * inline text, so a multi-word link name wrapped inside its own narrow item
 * ("Terms / of / Service") rather than flowing with the sentence.
 *
 * jsdom has no layout engine, so the wrapping itself can't be measured here
 * — what's pinned instead is the class-level cause and its fix: the Label
 * must not be a flex container, and each link must carry no box/flex
 * classes of its own (`inline-flex`, `block`, `min-h-*`, padding) that
 * would reintroduce the same shape a different way.
 */
describe('ConsentCheckbox', () => {
  it('the label is a block element, not a flex container that turns each link into its own item', () => {
    render(<ConsentCheckbox error={null} onChange={vi.fn()} />);
    const label = document.querySelector('label[for="checkout-consent"]');
    expect(label).not.toBeNull();
    const classes = label!.className.split(/\s+/);
    expect(classes).toContain('block');
    expect(classes).not.toContain('flex');
  });

  it('renders Terms, Privacy and Refund Policy as plain inline links with no box styling', () => {
    render(<ConsentCheckbox error={null} onChange={vi.fn()} />);
    const names = ['Terms of Service', 'Privacy Policy', 'Refund Policy'];
    const hrefs = ['/terms', '/privacy', '/refund-policy'];
    names.forEach((name, i) => {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', hrefs[i]);
      expect(link).toHaveAttribute('target', '_blank');
      const classes = link.className.split(/\s+/);
      // No display/box classes that would make the link its own block or
      // flex item, or give it a tap-target-sized box — it is inline text.
      for (const forbidden of ['block', 'inline-flex', 'inline-block', 'flex']) {
        expect(classes).not.toContain(forbidden);
      }
      expect(link.className).not.toMatch(/\bmin-h-|px-\d|py-\d/);
    });
  });

  it('shows the error message, unchanged, when the caller passes one', () => {
    render(<ConsentCheckbox error="Please agree first." onChange={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please agree first.');
  });
});
