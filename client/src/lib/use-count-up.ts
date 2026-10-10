import { useLayoutEffect, useRef, useState } from 'react';

/** Mirrors the "is motion off" check in use-scroll-reveal.ts. */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Standard ease-out cubic, matching the project's ease-out motion language. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts a trust stat up from 0 to `target` once it scrolls into view (spec
 * task 2.9E) — e.g. "15,000+ guests served".
 *
 * NEVER wire this to a price. A price is a factual commitment, not a
 * flourish, and it renders through `formatPeso` (centavos -> "₱1,890"), so
 * animating it would mean re-formatting every frame and displaying a
 * sequence of wrong prices on the way to the right one — materially worse
 * than merely gratuitous on a booking site. Prices render instantly, always.
 *
 * The returned `value` always lands on exactly `target` — the final tick
 * sets it directly rather than trusting rounding to arrive there on its
 * own — and under `prefers-reduced-motion`, or when `IntersectionObserver`
 * does not exist, `value` is `target` from the very first effect flush:
 * no animation at all, just the correct number, never a resurrected `0`.
 *
 * Checks `IntersectionObserver`'s existence *before* calling
 * `prefersReducedMotion()`, the same order `useScrollReveal` /
 * `useCardStagger` use in use-scroll-reveal.ts: jsdom (this project's test
 * environment) has no `IntersectionObserver` either, so every caller's test
 * exits here before ever reaching `window.matchMedia`, which jsdom does not
 * implement at all (throws if called unstubbed).
 *
 * `target` is captured once, on mount, matching `useCardStagger`'s own
 * "reveal is a one-shot mechanism keyed to this element" contract rather
 * than the full exhaustive-deps list — callers only ever mount this with an
 * already-resolved, stable number (see CountUpStat.tsx).
 */
export function useCountUp(target: number, durationMs = 400) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);
  const startedRef = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setValue(target);
      return;
    }
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let scrollFrame = 0;
    let tickFrame = 0;

    const run = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);

      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / durationMs, 1);
        if (t >= 1) {
          setValue(target);
          return;
        }
        setValue(Math.round(target * easeOutCubic(t)));
        tickFrame = requestAnimationFrame(tick);
      };
      tickFrame = requestAnimationFrame(tick);
    };

    // Same rAF-throttled catch-up sweep as useScrollReveal/useCardStagger,
    // for the same reason: a hash jump or fast scroll can carry the element
    // past the intersection threshold between two frames.
    const revealIfPassed = () => {
      if (element.getBoundingClientRect().top < 0) run();
    };

    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        revealIfPassed();
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) run();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    observer.observe(element);
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (tickFrame) cancelAnimationFrame(tickFrame);
    };
  }, []);

  return { ref, value };
}
