import { useEffect, type RefObject } from 'react';

const MAX_SHIFT_PX = 24;
const PARALLAX_RATE = 0.15;
/**
 * The hero `<img>` is `absolute inset-0 size-full object-cover`, so this
 * transform never affects layout — only paint. Oversizing it by 8% (clipped
 * by the hero `<section>`'s `overflow-hidden`) keeps it covering its box
 * edge-to-edge through the whole `MAX_SHIFT_PX` of vertical travel below,
 * so the translate never exposes a gap at either edge.
 */
const SCALE = 1.08;

/**
 * Subtle hero parallax (spec task 2.9G) — desktop only.
 *
 * Deliberately has no CSS `transition`: this writes `transform` straight
 * from `scrollY` on every rAF tick instead, so the image tracks the
 * scroll with zero added latency. A timed transition on a continuously
 * updating, scroll-linked value is the classic parallax mistake — it would
 * lag behind the real scroll position and feel like rubber-banding, the
 * opposite of "subtle". There is no fixed duration to assign here.
 *
 * Gated on, in order:
 *  1. `window.matchMedia` existing as a function at all. jsdom (this
 *     project's test environment) does not implement it and throws if
 *     called unstubbed — this check is also what keeps HeroSection's tests,
 *     which render unconditionally and never stub `matchMedia`, from
 *     crashing on mount.
 *  2. `prefers-reduced-motion: reduce` — off entirely; the image stays at
 *     its normal, static position and transform.
 *  3. `(hover: hover) and (pointer: fine) and (min-width: 1024px)` — a
 *     desktop viewport with a precise, hover-capable pointer. Touch
 *     devices get no parallax at all: it costs scroll performance there
 *     for no benefit.
 *
 * Only ever touches the `<img>` element's own `transform` style — never the
 * `<picture>`/`srcSet` markup or the gradient overlay divs, which Task 2.6
 * protects (and which this task leaves off-limits too).
 */
export function useHeroParallax(ref: RefObject<HTMLImageElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1024px)').matches) {
      return;
    }

    let frame = 0;
    const update = () => {
      const shift = Math.min(window.scrollY * PARALLAX_RATE, MAX_SHIFT_PX);
      element.style.transform = `scale(${SCALE}) translateY(${shift}px)`;
    };
    update();

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      element.style.transform = '';
    };
  }, [ref]);
}
