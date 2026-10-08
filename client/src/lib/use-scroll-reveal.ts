import { useLayoutEffect } from 'react';

/**
 * Fades sections in as they scroll into view, once each (spec task 3B).
 *
 * The hidden state is applied here rather than in the markup so that content
 * is never invisible when this never runs — no IntersectionObserver, no JS,
 * reduced motion, or jsdom in tests all leave the sections plainly visible.
 *
 * useLayoutEffect, not useEffect: the attribute has to land before the browser
 * paints, otherwise the section flashes in at full opacity and then jumps back
 * to hidden to animate.
 *
 * Each target is unobserved the moment it reveals, so a section cannot fade
 * again when the user scrolls back up.
 */
export function useScrollReveal(selector: string) {
  useLayoutEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (targets.length === 0) return;

    for (const element of targets) element.dataset.reveal = '';

    const pending = new Set(targets);

    function show(element: HTMLElement) {
      element.dataset.reveal = 'shown';
      observer.unobserve(element);
      pending.delete(element);
      if (pending.size === 0) window.removeEventListener('scroll', onScroll);
    }

    /**
     * Reveal anything the viewport has already moved past. An observer only
     * notifies on a threshold crossing, so a section that goes from below the
     * viewport to above it between two frames — a scrollbar drag, End, or a
     * hash jump to #contact — is never reported and would stay invisible for
     * good once the user scrolls back up. This sweep is the safety net.
     */
    function revealPassed() {
      for (const element of [...pending]) {
        if (element.getBoundingClientRect().top < 0) show(element);
      }
    }

    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        revealPassed();
      });
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) show(entry.target as HTMLElement);
        }
        revealPassed();
      },
      // Start the fade a little before the section's top edge is reached, so
      // it finishes about when the section is properly in view.
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );

    for (const element of targets) observer.observe(element);
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      // Leave nothing hidden behind if this unmounts mid-reveal.
      for (const element of targets) delete element.dataset.reveal;
    };
  }, [selector]);
}
