import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { formatPeso } from '@rg/shared';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accordion, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import CatalogPreview from '@/components/home/CatalogPreview';
import HeroSection from '@/components/home/HeroSection';
import PackagesSection from '@/components/home/PackagesSection';
import TrustBar from '@/components/home/TrustBar';
import HomePage from '@/pages/public/HomePage';
import SiteHeader from '@/components/layout/SiteHeader';
import TourCard from '@/components/common/TourCard';
import { useCardStagger } from '@/lib/use-scroll-reveal';
import { useCountUp } from '@/lib/use-count-up';
import { TrpcProviders } from '@/lib/trpc';
import {
  DESTINATIONS_FIXTURE,
  PACKAGES_FIXTURE,
  REVIEWS_FIXTURE,
  SETTINGS_FIXTURE,
  TOURS_FIXTURE,
} from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Same shape as the MockIntersectionObserver in layout.test.tsx — jsdom has
 * no real IntersectionObserver, so this stubs the wiring (constructor,
 * observe, disconnect, the callback) without attempting real intersection
 * geometry, which is platform behaviour.
 */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  emit(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting, target: this.observed[0] } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('useCardStagger', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function Grid({ itemsKey, items }: { itemsKey: number; items: string[] }) {
    const ref = useRef<HTMLUListElement>(null);
    useCardStagger(ref, 'li', itemsKey, 50);
    return (
      <ul ref={ref} data-testid="grid">
        {items.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    );
  }

  it('leaves cards plainly visible, with no [data-reveal], when IntersectionObserver does not exist (jsdom default)', () => {
    // No stub installed — this is the real jsdom environment every other
    // test in this project already runs under.
    const { getAllByRole } = render(<Grid itemsKey={1} items={['a', 'b', 'c']} />);
    for (const li of getAllByRole('listitem')) {
      expect(li).not.toHaveAttribute('data-reveal');
    }
  });

  it('leaves cards plainly visible under prefers-reduced-motion, even though IntersectionObserver exists', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    stubMatchMedia(true);

    const { getAllByRole } = render(<Grid itemsKey={1} items={['a', 'b', 'c']} />);
    for (const li of getAllByRole('listitem')) {
      expect(li).not.toHaveAttribute('data-reveal');
    }
    // Reduced motion must short-circuit before ever creating an observer.
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });

  it('hides cards with an increasing transition-delay, then reveals all of them together on intersection', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    stubMatchMedia(false);

    const { getAllByRole } = render(<Grid itemsKey={1} items={['a', 'b', 'c']} />);
    const items = getAllByRole('listitem');

    items.forEach((li, i) => {
      expect(li).toHaveAttribute('data-reveal', '');
      expect(li.style.transitionDelay).toBe(`${i * 50}ms`);
    });

    const observer = MockIntersectionObserver.instances.at(-1)!;
    act(() => observer.emit(true));

    for (const li of items) {
      expect(li).toHaveAttribute('data-reveal', 'shown');
    }
    expect(observer.disconnected).toBe(true);
  });

  it('never replays the stagger once revealed: cards rendered after a later itemsKey change are plain, visible markup with no [data-reveal] at all', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    stubMatchMedia(false);

    const { getAllByRole, rerender } = render(<Grid itemsKey={1} items={['a', 'b', 'c']} />);
    const firstObserver = MockIntersectionObserver.instances.at(-1)!;
    act(() => firstObserver.emit(true));
    for (const li of getAllByRole('listitem')) {
      expect(li).toHaveAttribute('data-reveal', 'shown');
    }

    // Simulates a destination-filter click: same grid, a new itemsKey, and a
    // different set of rendered <li>s (as if tours were filtered down).
    rerender(<Grid itemsKey={2} items={['x', 'y']} />);

    for (const li of getAllByRole('listitem')) {
      expect(li).not.toHaveAttribute('data-reveal');
    }
    // No second observer was created to re-run the whole mechanism.
    expect(MockIntersectionObserver.instances).toHaveLength(1);
  });
});

describe('HomePage — card-grid sections own their own card stagger, not the whole-section reveal (spec task 2.9C)', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    stubMatchMedia(false);
    MockIntersectionObserver.instances = [];
    mockTrpc({
      'settings.get': SETTINGS_FIXTURE,
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never applies the whole-section [data-reveal] to #tours, #packages or #reviews, but does apply it to another section (#how)', async () => {
    // HomePage's REVEAL_SECTIONS selector is `#main > section...` — in the
    // real app `#main` is PublicLayout's <main>. HomePage is rendered
    // standalone here, so it needs that same ancestor id for the selector to
    // match anything at all.
    const { container } = render(
      <TrpcProviders>
        <MemoryRouter>
          <div id="main">
            <HomePage />
          </div>
        </MemoryRouter>
      </TrpcProviders>,
    );

    // #how is a plain, un-excluded section — useScrollReveal must still own it.
    expect(container.querySelector('#how')).toHaveAttribute('data-reveal', '');

    // The three card-grid sections must never get the whole-section treatment
    // — if they did, their cards would double-animate (the section fading in
    // as a block while useCardStagger fades its own cards in again inside it).
    for (const id of ['#tours', '#packages', '#reviews']) {
      expect(container.querySelector(id), `missing ${id}`).not.toHaveAttribute('data-reveal');
    }

    // Cards inside #tours do get their own, independent stagger wiring once
    // they mount from tours.list — proves this isn't simply "nothing happens
    // to #tours at all".
    const toursSection = container.querySelector('#tours') as HTMLElement;
    // findAllByRole('listitem') alone would resolve against the skeleton's own
    // <li> wrappers (the inner Card is role="status", but the outer <li> is
    // still an implicit listitem) — wait for a real tour's title instead, so
    // this genuinely waits for tours.list to resolve and real cards to mount.
    await within(toursSection).findByText(TOURS_FIXTURE[0]!.title);
    const firstCard = within(toursSection).getAllByRole('listitem');
    expect(firstCard[0]).toHaveAttribute('data-reveal');
  });
});

describe('.press — tap feedback (spec task 2.9H)', () => {
  it('adds a soft box-shadow on :active, on top of the existing scale(0.97)', () => {
    const match = css.match(/\.press:active\s*\{([^}]*)\}/);
    expect(match, 'expected a .press:active rule in index.css').toBeTruthy();
    const body = match![1]!;
    expect(body).toMatch(/transform:\s*scale\(0\.97\)/);
    expect(body).toMatch(/box-shadow:/);
  });

  it('applies to the destination filter chips, which previously had no .press at all', async () => {
    mockTrpc({ 'destinations.list': DESTINATIONS_FIXTURE, 'tours.list': TOURS_FIXTURE });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <CatalogPreview />
        </MemoryRouter>
      </TrpcProviders>,
    );
    const chip = await screen.findByRole('button', { name: 'All tours' });
    expect(chip).toHaveClass('press');
  });

  it('applies to the FAQ accordion trigger, a Radix primitive with no .press by default', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="faq-1">
          <AccordionTrigger>A question</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );
    expect(screen.getByRole('button', { name: 'A question' })).toHaveClass('press');
  });
});

/**
 * Minimal harness around the hook itself, independent of TrustBar/HeroSection's
 * tRPC fixtures — precise control over IntersectionObserver/matchMedia without
 * also needing settings.get to resolve.
 */
function CountUpHarness({ target }: { target: number }) {
  const { ref, value } = useCountUp(target);
  return <span ref={ref}>{value.toLocaleString('en-PH')}+</span>;
}

/**
 * Deterministic requestAnimationFrame + performance.now stand-in.
 *
 * useCountUp (and useHeroParallax) drive their animation off the REAL clock
 * — a genuine 400ms count-up, a genuine rAF for the parallax transform.
 * Letting a test wait on that real clock (`waitFor(..., { timeout })`) made
 * it wall-clock dependent: `pnpm test` at the repo root runs the shared,
 * client and server suites concurrently, and under that CPU contention
 * jsdom's real rAF got starved enough that 400ms of animation did not
 * complete inside even a generous 2000ms `waitFor` window — a real failure
 * on a real run, not flakiness, and worse on a busier machine. Raising the
 * timeout further would only trade a failing test for a slower one that
 * still fails eventually.
 *
 * This stub removes the real clock from the test entirely: callbacks queue
 * up via the stubbed `requestAnimationFrame` and only run when the test
 * calls `tick(ms)`, with the exact `performance.now()` value the test
 * chooses. That lets a test step through an animation frame by frame and
 * assert the real intermediate progression — not just "it eventually got
 * there" — deterministically, on any machine, under any load.
 */
function installFakeRaf() {
  let now = 0;
  let queue: { id: number; cb: (t: number) => void }[] = [];
  let nextId = 1;

  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((q) => q.id !== id);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);

  return {
    /**
     * Advances the clock by `ms` and runs exactly the callbacks that were
     * queued *before* this call, with the new, advanced `now` — mirroring
     * a real animation frame: a callback that schedules another rAF while
     * running lands in next tick's queue, not this one's.
     */
    tick(ms: number) {
      now += ms;
      const due = queue;
      queue = [];
      for (const { cb } of due) cb(now);
    },
  };
}

describe('useCountUp — trust-stat count-up (spec task 2.9E)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // installFakeRaf uses vi.spyOn (not vi.stubGlobal) for performance.now
    // — unstubAllGlobals doesn't touch spies, so this is needed too, or the
    // frozen fake clock leaks into whichever test runs next in this file.
    vi.restoreAllMocks();
  });

  it('renders the exact target immediately, with no observer, when IntersectionObserver does not exist (jsdom default)', () => {
    // No stub installed — the real jsdom environment every other test here
    // already runs under, and the environment this hook's test-time
    // fallback exists for.
    render(<CountUpHarness target={15_000} />);
    expect(screen.getByText('15,000+')).toBeInTheDocument();
  });

  it('renders the exact target immediately and creates no observer under prefers-reduced-motion', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    MockIntersectionObserver.instances = [];
    stubMatchMedia(true);

    render(<CountUpHarness target={15_000} />);

    expect(screen.getByText('15,000+')).toBeInTheDocument();
    // Reduced motion must short-circuit before ever creating an observer —
    // the same guarantee useCardStagger makes above.
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });

  it('starts at 0, is still 0 immediately after intersecting, progresses through intermediate values, and lands on exactly the target with no overshoot', () => {
    const clock = installFakeRaf();
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    stubMatchMedia(false);

    render(<CountUpHarness target={15_000} />);
    expect(screen.getByText('0+')).toBeInTheDocument();

    const observer = MockIntersectionObserver.instances.at(-1)!;
    act(() => observer.emit(true));

    // Must not jump straight to the target the instant it intersects — the
    // first tick is scheduled via requestAnimationFrame, not run inline, so
    // immediately after the intersection callback the value is still 0.
    // This is what actually proves there is a count-UP, not just a
    // start-at-0/end-at-target pair with nothing animated in between.
    expect(screen.getByText('0+')).toBeInTheDocument();
    expect(observer.disconnected).toBe(true);

    // Halfway through the real 400ms animation (use-count-up.ts's default
    // duration) — strictly between 0 and the target, proving an actual
    // intermediate frame rendered, not just the two endpoints.
    act(() => clock.tick(200));
    const midText = screen.getByText(/\+$/).textContent!;
    const midValue = Number(midText.replace(/[+,]/g, ''));
    expect(midValue).toBeGreaterThan(0);
    expect(midValue).toBeLessThan(15_000);

    // Past the end of the animation: lands on exactly the target, never a
    // fraction over or under it — e.g. no leftover tick still nudging it
    // past 15,000.
    act(() => clock.tick(300));
    expect(screen.getByText('15,000+')).toBeInTheDocument();
    expect(screen.queryByText(/^15,00[1-9]/)).not.toBeInTheDocument();
  });

  it('never resurrects a null guestsServed as 0 — the whole item is omitted (TrustBar)', async () => {
    const settings = {
      ...SETTINGS_FIXTURE,
      trust: { ...SETTINGS_FIXTURE.trust, guestsServed: null },
    };
    mockTrpc({ 'settings.get': settings });
    render(
      <TrpcProviders>
        <TrustBar />
      </TrpcProviders>,
    );
    expect(await screen.findByText(/dot accredited/i)).toBeInTheDocument();
    expect(screen.queryByText(/guests served/i)).not.toBeInTheDocument();
    expect(screen.queryByText('0+')).not.toBeInTheDocument();
  });
});

describe('Prices never animate (spec task 2.9E hard rule)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('TourCard renders the "from" price at its exact final value on first render — no count-up, ever', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    MockIntersectionObserver.instances = [];

    const tour = TOURS_FIXTURE[0]!;
    render(
      <MemoryRouter>
        <TourCard tour={tour} />
      </MemoryRouter>,
    );

    expect(screen.getByText(formatPeso(tour.fromPriceCentavos!))).toBeInTheDocument();
    // Nothing on this card is watching for scroll-into-view — proves the
    // price isn't quietly wired to the same mechanism as a trust stat.
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });

  it('PackagesSection renders both the new and old package prices at their exact final values, immediately once data resolves', async () => {
    mockTrpc({ 'packages.list': PACKAGES_FIXTURE });
    render(
      <TrpcProviders>
        <PackagesSection />
      </TrpcProviders>,
    );

    const pkg = PACKAGES_FIXTURE[0]!;
    expect(await screen.findByText(formatPeso(pkg.newPriceCentavos))).toBeInTheDocument();
    if (pkg.oldPriceCentavos != null) {
      expect(screen.getByText(formatPeso(pkg.oldPriceCentavos))).toBeInTheDocument();
    }
  });
});

/**
 * Sets scrollY and dispatches a scroll event, the same two-step every
 * SiteHeader test below needs.
 */
function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  fireEvent.scroll(window);
}

describe('SiteHeader — shrink/solidify on scroll (spec task 2.9F)', () => {
  afterEach(() => {
    scrollTo(0);
  });

  function renderHeader() {
    render(
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>,
    );
    const header = screen.getByRole('banner');
    return { header, bar: header.firstElementChild as HTMLElement };
  }

  it('is unscaled at the top of the page', () => {
    const { bar } = renderHeader();
    expect(bar.className).not.toMatch(/scale-/);
  });

  it('scales down the inner bar and solidifies the header background once scrolled past the threshold', () => {
    const { header, bar } = renderHeader();

    scrollTo(100);

    expect(bar.className).toMatch(/scale-\[0\.95\]/);
    expect(header.className).toMatch(/shadow-md/);
  });

  it('restores the resting (unscaled, translucent) state when scrolled back to the top', () => {
    const { header, bar } = renderHeader();

    scrollTo(100);
    expect(bar.className).toMatch(/scale-/);

    scrollTo(0);
    expect(bar.className).not.toMatch(/scale-/);
    expect(header.className).not.toMatch(/shadow-md/);
  });

  // The knock-on the brief calls out by name: index.css's
  // `section[id] { scroll-margin-top: 5rem }` is tuned to this header's
  // h-16 (64px) resting height. If that height ever changed — even only
  // while scrolled — hash links to #tours/#packages/#reviews/#faq/#contact
  // could land under the sticky header. This proves it never does: the
  // "shrink" is a `transform: scale()` on the inner content only, which
  // never changes the row's own box size.
  it("never changes the header row's own height class, scrolled or not", () => {
    const { bar } = renderHeader();
    expect(bar).toHaveClass('h-16');

    scrollTo(500);
    expect(bar).toHaveClass('h-16');
  });
});

/** Like stubMatchMedia above, but lets each query string answer independently. */
function stubMatchMediaPerQuery(answers: Record<string, boolean>) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: answers[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const DESKTOP_POINTER_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 1024px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

describe('useHeroParallax — desktop-only hero parallax (spec task 2.9G)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // See the matching note in the useCountUp describe above: installFakeRaf
    // uses vi.spyOn for performance.now, which unstubAllGlobals does not undo.
    vi.restoreAllMocks();
    scrollTo(0);
  });

  function renderHero() {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE, 'destinations.list': DESTINATIONS_FIXTURE });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <HeroSection />
        </MemoryRouter>
      </TrpcProviders>,
    );
    return screen.getByAltText(/fort san pedro/i) as HTMLImageElement;
  }

  it('transforms the hero image from scroll position on a desktop, hover-capable pointer', () => {
    // Deterministic clock — see installFakeRaf's own comment. Without it,
    // this assertion only has something real to check once the scroll
    // listener's requestAnimationFrame-deferred update has actually run,
    // which a real rAF does not guarantee has happened by the very next
    // synchronous line.
    const clock = installFakeRaf();
    stubMatchMediaPerQuery({ [REDUCED_MOTION_QUERY]: false, [DESKTOP_POINTER_QUERY]: true });
    const img = renderHero();

    // Mount runs `update()` synchronously (not via rAF), at scrollY 0.
    expect(img.style.transform).toBe('scale(1.08) translateY(0px)');

    scrollTo(100);
    // The scroll listener's update is deferred to the next animation
    // frame — not yet applied synchronously after the scroll event.
    expect(img.style.transform).toBe('scale(1.08) translateY(0px)');

    act(() => clock.tick(16));
    // shift = min(scrollY * 0.15, 24) = min(100 * 0.15, 24) = 15
    expect(img.style.transform).toBe('scale(1.08) translateY(15px)');
  });

  it('never transforms the image on a touch/coarse pointer, even though matchMedia exists', () => {
    stubMatchMediaPerQuery({ [REDUCED_MOTION_QUERY]: false, [DESKTOP_POINTER_QUERY]: false });
    const img = renderHero();

    scrollTo(100);

    expect(img.style.transform).toBe('');
  });

  it('never transforms the image under prefers-reduced-motion, even on a desktop pointer', () => {
    stubMatchMediaPerQuery({ [REDUCED_MOTION_QUERY]: true, [DESKTOP_POINTER_QUERY]: true });
    const img = renderHero();

    scrollTo(100);

    expect(img.style.transform).toBe('');
  });

  it('does not touch the protected <picture>/srcSet markup or the two gradient overlay divs', () => {
    stubMatchMediaPerQuery({ [REDUCED_MOTION_QUERY]: false, [DESKTOP_POINTER_QUERY]: true });
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE, 'destinations.list': DESTINATIONS_FIXTURE });
    const { container } = render(
      <TrpcProviders>
        <MemoryRouter>
          <HeroSection />
        </MemoryRouter>
      </TrpcProviders>,
    );
    scrollTo(100);

    const img = screen.getByAltText(/fort san pedro/i);
    expect(img).toHaveAttribute(
      'srcSet',
      '/hero/hero-cebu-800.jpg 800w, /hero/hero-cebu-1920.jpg 1920w',
    );
    expect(container.querySelectorAll('.bg-gradient-to-b, .bg-gradient-to-br')).toHaveLength(2);
  });

  it('renders correctly — no crash — when window.matchMedia does not exist at all (no stub installed)', () => {
    // No stub installed. This is the condition every OTHER test in this
    // project's suite runs under (jsdom implements no matchMedia at all —
    // calling it unstubbed throws), including every other HeroSection test
    // in hero-trust.test.tsx. If this hook ever called matchMedia before
    // checking it exists, every one of those tests would start throwing.
    expect(() => renderHero()).not.toThrow();
  });
});
