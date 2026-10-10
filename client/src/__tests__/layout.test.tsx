import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicLayout from '@/components/layout/PublicLayout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <PublicLayout />
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  it('renders a banner, a contentinfo footer, and a main region', () => {
    renderLayout();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('shows DOT, DTI, and BIR permit lines in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(/DOT/);
    expect(footer).toHaveTextContent(/DTI/);
    expect(footer).toHaveTextContent(/BIR/);
  });

  it('lists accepted payment methods in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    for (const method of ['GCash', 'Maya', 'GrabPay', 'QR Ph']) {
      expect(footer).toHaveTextContent(method);
    }
  });

  it('renders a WhatsApp link with an accessible name (the desktop floating bubble and/or the mobile bottom bar — both are mounted at once; CSS, not conditional rendering, picks one per breakpoint)', () => {
    renderLayout();
    const links = screen.getAllByRole('link', { name: /whatsapp/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', expect.stringContaining('wa.me'));
    }
  });

  it('exposes a skip link to the main content', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /skip to (main )?content/i })).toBeInTheDocument();
  });

  /**
   * Fix round 1, F2 / BUG-078: the mobile sticky bar in FloatingWhatsApp is
   * `position: fixed` and reserves no layout space of its own, so without
   * this padding nothing guarantees the last element of whatever page is
   * rendered inside <main> can ever be scrolled clear of it. jsdom has no
   * real layout engine, so this only proves the class is present — it is
   * not, and cannot be, a measurement of actual on-screen clearance (see
   * BUG-074's standing screenshot gap). Geometric non-overlap is reasoned
   * about in the task report, not measured here.
   */
  it("reserves mobile-only bottom padding on <main> for the sticky bar's height, with nothing added on desktop", () => {
    renderLayout();
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/\bpb-32\b/);
    expect(main.className).toMatch(/\bmd:pb-0\b/);
  });

  it('pins the mandated PlaceholderBadge copy and forbids the superseded "not real" wording', () => {
    renderLayout();
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent(/client-supplied/i);
    expect(badge).toHaveTextContent(/pending verification/i);
    expect(badge).not.toHaveTextContent(
      /ratings, guest counts, prices, permits and photos are not real/i,
    );
  });
});

/**
 * The floating WhatsApp bubble (desktop) and the mobile bottom bar's own
 * WhatsApp control both hide while the hero's search form is on screen,
 * because a fixed bottom control otherwise covers the right edge of that
 * primary CTA (measured at 360px and 390px).
 *
 * jsdom implements no IntersectionObserver, so it is stubbed here. That covers
 * the wiring — selector, state, early return, cleanup — but NOT the browser's
 * own intersection computation, which is platform behaviour.
 *
 * jsdom also never computes real layout, so the `hidden md:block` /
 * `md:hidden` breakpoint classes that pick ONE of the bubble/bar per
 * viewport width have no effect here — both are present in the DOM
 * whenever `coversHeroSearch` is false. Assertions below use
 * queryAllByRole/getAllByRole rather than a single getByRole for that
 * reason.
 */
describe('FloatingWhatsApp hides behind the hero search form', () => {
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

  function addHeroSearchForm() {
    const form = document.createElement('form');
    form.setAttribute('aria-label', 'Search tours');
    document.body.appendChild(form);
    return form;
  }

  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('form[aria-label="Search tours"]').forEach((f) => f.remove());
  });

  /**
   * Both the desktop bubble and the mobile bottom bar's icon are present at
   * once in jsdom (no real CSS layout — see the describe block's own
   * comment), so this returns however many WhatsApp-named links currently
   * exist rather than assuming exactly one.
   */
  const whatsapp = () => screen.queryAllByRole('link', { name: /whatsapp/i });

  /**
   * FloatingWhatsApp now also watches the footer (for the bottom bar's own
   * "hide near the footer" behaviour), so a second observer always exists
   * once SiteFooter is in the tree — independent of whether a hero form is
   * present. Found by what it observes rather than by array position, so
   * this doesn't depend on which effect happens to run first.
   */
  const heroObserver = (form: Element) =>
    MockIntersectionObserver.instances.find((o) => o.observed.includes(form));

  it('observes the hero search form when one is present', () => {
    const form = addHeroSearchForm();
    renderLayout();

    const observer = heroObserver(form);
    expect(observer).toBeDefined();
  });

  it('hides both WhatsApp controls while the search form is intersecting, and restores them after', () => {
    const form = addHeroSearchForm();
    renderLayout();
    const observer = heroObserver(form)!;

    // Visible to begin with — the observer has not reported yet.
    expect(whatsapp().length).toBeGreaterThan(0);

    act(() => observer.emit(true));
    expect(whatsapp()).toHaveLength(0);

    act(() => observer.emit(false));
    expect(whatsapp().length).toBeGreaterThan(0);
  });

  it('stays visible on pages with no hero search form, observing only the footer', () => {
    renderLayout();
    expect(whatsapp().length).toBeGreaterThan(0);
    // One observer — the bottom bar's footer-proximity watcher. None for the
    // hero form, since there isn't one on this page.
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    expect(MockIntersectionObserver.instances[0]!.observed[0]?.tagName).toBe('FOOTER');
  });

  it('disconnects every observer (hero form and footer alike) on unmount', () => {
    addHeroSearchForm();
    const { unmount } = renderLayout();
    const observers = [...MockIntersectionObserver.instances];

    expect(observers.length).toBeGreaterThan(0);
    for (const observer of observers) expect(observer.disconnected).toBe(false);
    unmount();
    for (const observer of observers) expect(observer.disconnected).toBe(true);
  });
});

/**
 * TravelSugbo is the public trading brand; R&G Travel & Tours is the licensed
 * operator that holds the DOT/DTI/BIR registrations. These must not collapse
 * into one name — the copyright notice and the accreditation block are legal
 * attribution and belong to the operator.
 */
describe('brand vs legal operator', () => {
  it('shows the TravelSugbo brand in the footer and as the home link name', () => {
    renderLayout();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/TravelSugbo/);
    expect(screen.getByRole('link', { name: /TravelSugbo — home/i })).toBeInTheDocument();
  });

  it('credits the licensed operator beside the permits', () => {
    renderLayout();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/Operated by R&G Travel & Tours/);
  });

  it('attributes copyright to the operator, not the trading brand', () => {
    renderLayout();
    const copyright = screen.getByRole('contentinfo').textContent?.match(/©\s*\d{4}[^.]*\./)?.[0];
    expect(copyright).toMatch(/R&G Travel & Tours/);
    expect(copyright).not.toMatch(/TravelSugbo/);
  });

  it('keeps the permit labels under the operator and still unfabricated', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    for (const label of [/DOT/, /DTI/, /BIR/]) expect(footer).toHaveTextContent(label);
    expect(footer).toHaveTextContent(/— pending —/);
  });

  it('carries no stale randgtraveltours.com reference', () => {
    const { container } = renderLayout();
    expect(container.innerHTML).not.toMatch(/randgtraveltours/i);
  });
});
