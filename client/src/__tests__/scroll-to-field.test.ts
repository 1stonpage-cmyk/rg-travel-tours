import { describe, expect, it, beforeEach, vi } from 'vitest';
import { scrollToAndFocus } from '@/lib/scroll-to-field';

describe('scrollToAndFocus', () => {
  beforeEach(() => {
    // Reset DOM before each test
    document.body.innerHTML = '';
  });

  it('scrolls an element into view and focuses it', () => {
    const input = document.createElement('input');
    input.id = 'test-field';
    document.body.appendChild(input);

    const scrollIntoViewMock = vi.fn();
    input.scrollIntoView = scrollIntoViewMock;

    scrollToAndFocus('test-field');

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: expect.stringMatching(/^(smooth|auto)$/),
      block: 'center',
    });
    expect(document.activeElement).toBe(input);
  });

  it('handles a missing element gracefully with no throw', () => {
    expect(() => {
      scrollToAndFocus('nonexistent-id');
    }).not.toThrow();
  });

  it('respects prefers-reduced-motion by using auto behavior', () => {
    const input = document.createElement('input');
    input.id = 'test-field';
    document.body.appendChild(input);

    const scrollIntoViewMock = vi.fn();
    input.scrollIntoView = scrollIntoViewMock;

    // Mock window.matchMedia to return prefers-reduced-motion
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => {
      if (query === '(prefers-reduced-motion: reduce)') {
        return { matches: true } as MediaQueryList;
      }
      return originalMatchMedia(query);
    });

    scrollToAndFocus('test-field');

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
    });

    window.matchMedia = originalMatchMedia;
  });
});
