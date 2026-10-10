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
import ContactSection from '@/components/home/ContactSection';
import HeroSection from '@/components/home/HeroSection';
import PackagesSection from '@/components/home/PackagesSection';
import TrustBar from '@/components/home/TrustBar';
import HomePage from '@/pages/public/HomePage';
import FloatingWhatsApp from '@/components/layout/FloatingWhatsApp';
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

describe('.press-brand — scale(0.95) + spring-back for the WhatsApp/Viber pills (spec task 2.9I)', () => {
  it('presses deeper than the house .press (0.95, not 0.97) and gives the release its own, different easing than the press', () => {
    const activeMatch = css.match(/\.press-brand:active\s*\{([^}]*)\}/);
    expect(activeMatch, 'expected a .press-brand:active rule in index.css').toBeTruthy();
    const activeBody = activeMatch![1]!;
    expect(activeBody).toMatch(/transform:\s*scale\(0\.95\)/);

    const baseMatch = css.match(/\.press-brand\s*\{([^}]*)\}/);
    expect(baseMatch, 'expected a base .press-brand rule in index.css').toBeTruthy();
    const baseBody = baseMatch![1]!;

    // The press (in .press-brand:active) and the release (in the base
    // .press-brand rule, which governs the transition back once :active
    // stops matching) must use genuinely different timing functions — that
    // difference IS the "spring-back": a quick linear-ish press, then an
    // overshooting "back" ease on the way out. If a future edit made them
    // identical, this would catch it.
    const pressEasing = activeBody.match(/cubic-bezier\(([^)]+)\)/)?.[1];
    const releaseEasing = baseBody.match(/cubic-bezier\(([^)]+)\)/)?.[1];
    expect(pressEasing).toBeTruthy();
    expect(releaseEasing).toBeTruthy();
    expect(pressEasing).not.toBe(releaseEasing);
  });

  it('is turned off under prefers-reduced-motion, same as .press', () => {
    const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/);
    expect(reducedBlock, 'expected a trailing prefers-reduced-motion block').toBeTruthy();
    expect(reducedBlock![1]).toMatch(
      /\.press:active,\s*\.press-brand:active\s*\{\s*transform:\s*none;/,
    );
  });
});

/**
 * Fix round 1, F1 / BUG-077: ContactSection is one of the five named 2.9I
 * surfaces and received a real markup change (lucide icons → official
 * glyphs, a new ChatIcon wrapper, .press-brand) with no test coverage at
 * all in the original diff.
 *
 * ContactSection now reads `settings.openState` (task 3.4), so it needs the
 * tRPC provider and a mocked `settings.get` — it still renders no <Link>,
 * so MemoryRouter stays unnecessary here.
 */
describe('ContactSection — WhatsApp/Viber branding (spec task 2.9I, fix round 1 F1 / BUG-077)', () => {
  beforeEach(() => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  });

  function renderContact() {
    return render(
      <TrpcProviders>
        <ContactSection />
      </TrpcProviders>,
    );
  }

  function pillFor(tone: 'whatsapp' | 'viber') {
    const link = screen.getByRole('link', { name: new RegExp(tone, 'i') });
    const pill = link.querySelector(`.bg-${tone}`);
    return { link, pill };
  }

  it('the WhatsApp pill carries no text node — the glyph is the only content inside it', () => {
    renderContact();
    const { pill } = pillFor('whatsapp');
    expect(pill, 'expected a .bg-whatsapp chip inside the WhatsApp link').toBeTruthy();
    expect(pill!.textContent).toBe('');
  });

  it('the Viber pill carries no text node either', () => {
    renderContact();
    const { pill } = pillFor('viber');
    expect(pill, 'expected a .bg-viber chip inside the Viber link').toBeTruthy();
    expect(pill!.textContent).toBe('');
  });

  it('the visible "WhatsApp" label is a sibling outside the coloured pill, not inside it', () => {
    renderContact();
    const { pill } = pillFor('whatsapp');
    const label = screen.getByText('WhatsApp');
    expect(pill!.contains(label)).toBe(false);
    expect(label.closest('.bg-whatsapp')).toBeNull();
  });

  it('the visible "Viber" label is a sibling outside the coloured pill, not inside it', () => {
    renderContact();
    const { pill } = pillFor('viber');
    const label = screen.getByText('Viber');
    expect(pill!.contains(label)).toBe(false);
    expect(label.closest('.bg-viber')).toBeNull();
  });

  it('both pills use .press-brand (scale 0.95 + spring-back), not the plain .press other rows here carry', () => {
    renderContact();
    const { pill: whatsappPill } = pillFor('whatsapp');
    const { pill: viberPill } = pillFor('viber');

    for (const pill of [whatsappPill!, viberPill!]) {
      expect(pill).toHaveClass('press-brand');
      expect(pill).not.toHaveClass('press');
    }
  });
});

describe('FloatingWhatsApp — attention pulse and "Chat with us" peek fire once per session, not once per mount (spec task 2.9I)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // FloatingWhatsApp now reads `settings.openState` (task 3.4).
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  function renderBubble() {
    return render(
      <TrpcProviders>
        <MemoryRouter>
          <FloatingWhatsApp />
        </MemoryRouter>
      </TrpcProviders>,
    );
  }

  // jsdom has no IntersectionObserver by default, so both the desktop bubble
  // and the mobile bar render in their default-visible state — exactly the
  // condition under which the pulse is eligible to play at all.
  const whatsappLinks = () => screen.getAllByRole('link', { name: /chat with us on whatsapp/i });

  it('applies .attention-pulse to the WhatsApp control on a fresh session', () => {
    renderBubble();
    for (const link of whatsappLinks()) expect(link).toHaveClass('attention-pulse');
  });

  it('does not replay the pulse on a later mount within the same session, once it has played once', () => {
    const first = renderBubble();
    for (const link of whatsappLinks()) fireEvent.animationEnd(link);
    first.unmount();

    // A second mount within the same session (e.g. a client-side navigation
    // that happened to remount this component, or — the case this guards —
    // a full page reload in the same tab, which sessionStorage survives but
    // a plain React ref/state would not).
    renderBubble();
    for (const link of whatsappLinks()) expect(link).not.toHaveClass('attention-pulse');
  });

  it('still pulses on a fresh mount when nothing has been recorded yet (sessionStorage genuinely empty, not just unread)', () => {
    expect(sessionStorage.getItem('ts-whatsapp-pulse-shown')).toBeNull();
    renderBubble();
    for (const link of whatsappLinks()) expect(link).toHaveClass('attention-pulse');
  });

  it('peeks the outside "Chat with us" label once, on the same eligibility as the pulse, and tucks it back on its own animationend', () => {
    renderBubble();
    const labels = screen.getAllByText('Chat with us', { selector: 'span' });
    const peekingLabels = labels.filter((l) => l.classList.contains('label-peek'));
    expect(peekingLabels.length).toBeGreaterThan(0);

    for (const label of peekingLabels) fireEvent.animationEnd(label);
    expect(screen.queryAllByText('Chat with us', { selector: '.label-peek' })).toHaveLength(0);
  });

  it("times the label peek's start to exactly when the attention pulse finishes (delay + duration), so the two can't silently drift apart", () => {
    const pulseRule = css.match(
      /\.attention-pulse\s*\{\s*animation:\s*attention-pulse\s+([\d.]+)ms[^;]*?(\d+(?:\.\d+)?)s\s+1;/,
    );
    expect(pulseRule, "expected to parse .attention-pulse's duration and delay").toBeTruthy();
    const pulseDurationMs = Number(pulseRule![1]);
    const pulseDelayMs = Number(pulseRule![2]) * 1000;

    const peekRule = css.match(
      /\.label-peek\s*\{\s*animation:\s*label-peek\s+[\d.]+ms[^;]*?(\d+(?:\.\d+)?)ms\s+both;/,
    );
    expect(peekRule, "expected to parse .label-peek's delay").toBeTruthy();
    const peekDelayMs = Number(peekRule![1]);

    expect(peekDelayMs).toBe(pulseDelayMs + pulseDurationMs);
  });
});

describe('Mobile bottom bar — "Book a tour" + WhatsApp (spec task 2.9B)', () => {
  function addFooter() {
    const footer = document.createElement('footer');
    document.body.appendChild(footer);
    return footer;
  }

  beforeEach(() => {
    // FloatingWhatsApp now reads `settings.openState` (task 3.4).
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  });

  afterEach(() => {
    document.querySelectorAll('footer').forEach((f) => f.remove());
    vi.unstubAllGlobals();
  });

  it('renders a "Book a tour" link to /tours and an icon-only, aria-labelled WhatsApp link', () => {
    render(
      <TrpcProviders>
        <MemoryRouter>
          <FloatingWhatsApp />
        </MemoryRouter>
      </TrpcProviders>,
    );
    const bookLink = screen.getByRole('link', { name: /book a tour/i });
    expect(bookLink).toHaveAttribute('href', '/tours');

    const chatLinks = screen.getAllByRole('link', { name: /chat with us on whatsapp/i });
    expect(chatLinks.length).toBeGreaterThan(0);
    for (const link of chatLinks) {
      // Icon-only: the accessible name comes entirely from aria-label, not
      // from any visible text inside the link itself.
      expect(link).toHaveAttribute('href', expect.stringContaining('wa.me'));
      expect(link.textContent).toBe('');
    }
  });

  it('hides (and goes inert) once the footer starts to arrive, without ever unmounting', () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    MockIntersectionObserver.instances = [];
    const footer = addFooter();

    const { container } = render(
      <TrpcProviders>
        <MemoryRouter>
          <FloatingWhatsApp />
        </MemoryRouter>
      </TrpcProviders>,
    );
    const bar = container.querySelector('.md\\:hidden') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar).not.toHaveAttribute('inert');
    expect(bar.className).toMatch(/translate-y-0/);

    const observer = MockIntersectionObserver.instances.find((o) => o.observed.includes(footer))!;
    expect(observer).toBeDefined();
    act(() => observer.emit(true));

    // Still mounted — this is a transform/opacity transition, not a
    // mount/unmount flash (reduced-motion correctness depends on that: see
    // the component's own comment).
    expect(container.querySelector('.md\\:hidden')).toBe(bar);
    expect(bar.className).toMatch(/translate-y-full/);
    expect(bar.className).toMatch(/opacity-0/);
    expect(bar).toHaveAttribute('inert');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
  });
});
