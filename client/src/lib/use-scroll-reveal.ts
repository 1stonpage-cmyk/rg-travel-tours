import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Shared by both reveal hooks below — one definition of "motion is off". */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
    if (prefersReducedMotion()) return;

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

/**
 * Staggers the entrance of cards inside one grid, 40-60ms apart, the first
 * time that grid scrolls into view (spec task 2.9C).
 *
 * This is deliberately a second, smaller hook rather than a mode bolted onto
 * useScrollReveal above: that hook's target list is a fixed, page-wide
 * `document.querySelectorAll(selector)` captured once on mount, which is
 * exactly wrong here — tour/package/review cards render from React Query, so
 * at HomePage's first render they do not exist yet (the grid is still a
 * skeleton). This hook instead takes a ref to the grid's own container, is
 * called from the component that owns the fetch, and re-queries its children
 * on every `itemsKey` change — so the effect naturally re-runs the moment
 * skeleton gives way to real `<li>`s, which is the one signal this needs.
 * HomePage.tsx excludes these three sections from the whole-section reveal
 * above for the same reason this hook exists: both animating would double up
 * (the section fading in as a block while its cards fade in again inside it).
 *
 * Only reveals once per mount: once the grid has played its stagger, a later
 * `itemsKey` change (e.g. the destination filter swapping which tour cards
 * are rendered) is left alone. Freshly rendered `<li>`s from that change never
 * had `data-reveal` applied to them, so they are already plain, visible
 * markup — nothing to show, and no replaying the animation on every filter
 * click.
 */
export function useCardStagger(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  itemsKey: unknown,
  stepMs = 50,
) {
  const revealedOnce = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (revealedOnce.current) return;
    if (typeof IntersectionObserver === 'undefined') return;
    if (prefersReducedMotion()) return;

    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    if (items.length === 0) return;

    for (const [i, element] of items.entries()) {
      element.dataset.reveal = '';
      element.style.transitionDelay = `${i * stepMs}ms`;
    }

    // Arrow consts, not function declarations: a hoisted declaration could in
    // principle run before the null check above, so TypeScript will not
    // carry the narrowing of `container` into one (see the identical note on
    // CatalogPreview's chip-row effect).
    const show = () => {
      revealedOnce.current = true;
      for (const element of items) element.dataset.reveal = 'shown';
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };

    // Same rAF-throttled catch-up sweep as useScrollReveal, for the same
    // reason: a hash jump or fast scroll can carry the grid past the
    // intersection threshold between two frames.
    const revealIfPassed = () => {
      if (container.getBoundingClientRect().top < 0) show();
    };

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        revealIfPassed();
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) show();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    observer.observe(container);
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (!revealedOnce.current) {
        for (const element of items) {
          delete element.dataset.reveal;
          element.style.transitionDelay = '';
        }
      }
    };
  }, [itemsKey]);
}
