import { act, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accordion, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import CatalogPreview from '@/components/home/CatalogPreview';
import HomePage from '@/pages/public/HomePage';
import { useCardStagger } from '@/lib/use-scroll-reveal';
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
