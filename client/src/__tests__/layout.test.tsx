import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicLayout from '@/components/layout/PublicLayout';
import { SITE, viberLink, whatsappLink } from '@/lib/site';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

// PublicLayout now mounts AnnouncementBar (task 3.1), which calls
// trpc.settings.get.useQuery() — every render here needs the provider and a
// mock. SETTINGS_FIXTURE.announcement is null, so the bar renders nothing
// and every assertion below is unaffected; announcement.test.tsx covers the
// bar's own behaviour with a non-null announcement.
beforeEach(() => {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
});

function renderLayout() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <PublicLayout />
      </MemoryRouter>
    </TrpcProviders>,
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
   *
   * BUG-079 (spec task 2.10B): the flat `pb-32` reservation above was
   * replaced by `.pb-mobile-bar-safe` (index.css), which adds
   * `env(safe-area-inset-bottom)` on top of the same 8rem so a notched
   * phone's home-indicator inset doesn't eat into the reserved space.
   * jsdom cannot compute `env()`, so — same caveat as above — this proves
   * the class is wired up and reads the real rule text out of index.css;
   * it is not a measurement of actual on-screen clearance on a real
   * device.
   */
  it("reserves mobile-only bottom padding on <main> for the sticky bar's height, with nothing added on desktop", () => {
    renderLayout();
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/\bpb-mobile-bar-safe\b/);
    expect(main.className).not.toMatch(/\bpb-32\b/);
  });

  it('BUG-079: .pb-mobile-bar-safe adds the safe-area inset on top of the flat 8rem, and cancels both at md', () => {
    const rule = css.match(/\.pb-mobile-bar-safe\s*\{([^}]*)\}/);
    expect(rule, 'expected a .pb-mobile-bar-safe rule in index.css').toBeTruthy();
    expect(rule![1]).toMatch(
      /padding-bottom:\s*calc\(\s*8rem\s*\+\s*env\(safe-area-inset-bottom\)\s*\)/,
    );

    const mdBlock = css.match(
      /@media \(min-width: 768px\)\s*\{\s*\.pb-mobile-bar-safe\s*\{([^}]*)\}/,
    );
    expect(
      mdBlock,
      'expected .pb-mobile-bar-safe to be cancelled at the md breakpoint',
    ).toBeTruthy();
    expect(mdBlock![1]).toMatch(/padding-bottom:\s*0/);
  });

  /**
   * BUG-079 also requires `viewport-fit=cover` on the viewport meta tag —
   * without it, `env(safe-area-inset-*)` resolves to 0px and the rule above
   * is inert. jsdom doesn't load index.html, so this reads the file
   * directly rather than asserting on a rendered <head>.
   */
  it('BUG-079: client/index.html sets viewport-fit=cover so env(safe-area-inset-*) resolves', () => {
    const indexHtmlPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'index.html',
    );
    const html = readFileSync(indexHtmlPath, 'utf8');
    const viewportMeta = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)?.[1];
    expect(viewportMeta, 'expected a viewport meta tag').toBeTruthy();
    expect(viewportMeta).toMatch(/viewport-fit=cover/);
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
   *
   * Matched on FloatingWhatsApp's own accessible name ("Chat with us on
   * WhatsApp") rather than a bare /whatsapp/i, which would also match
   * SiteFooter's unrelated "Chat on WhatsApp" button (spec task 2.10A) —
   * that one is static chrome and never hides with the hero form, so a
   * loose match here would make this assertion fail for the wrong reason.
   */
  const whatsapp = () => screen.queryAllByRole('link', { name: /chat with us on whatsapp/i });

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

/**
 * Spec task 2.10A: the footer had the phone number but no WhatsApp/Viber
 * link next to it. Same assertion shape as ContactSection's own branding
 * coverage (motion.test.tsx, fix round 1 F1 / BUG-077): the coloured pill
 * carries no text node, the visible label is a sibling outside it (not
 * inside it), and the real phone number is still rendered alongside.
 */
describe('SiteFooter — WhatsApp/Viber icon buttons beside the phone number (spec task 2.10A)', () => {
  function pillFor(tone: 'whatsapp' | 'viber') {
    const pill = screen.getByRole('link', { name: new RegExp(`chat on ${tone}`, 'i') });
    return pill;
  }

  it('the WhatsApp pill carries no text node — the glyph is the only content inside it', () => {
    renderLayout();
    const pill = pillFor('whatsapp');
    expect(pill).toHaveClass('bg-whatsapp');
    expect(pill.textContent).toBe('');
  });

  it('the Viber pill carries no text node either', () => {
    renderLayout();
    const pill = pillFor('viber');
    expect(pill).toHaveClass('bg-viber');
    expect(pill.textContent).toBe('');
  });

  it('both pills expose an aria-label naming the app', () => {
    renderLayout();
    expect(pillFor('whatsapp')).toHaveAttribute('aria-label', 'Chat on WhatsApp');
    expect(pillFor('viber')).toHaveAttribute('aria-label', 'Chat on Viber');
  });

  it('the visible "WhatsApp" caption is a sibling outside the coloured pill, not inside it', () => {
    renderLayout();
    const pill = pillFor('whatsapp');
    const label = pill.nextElementSibling;
    expect(label, 'expected a sibling element after the pill').not.toBeNull();
    expect(label).toHaveTextContent('WhatsApp');
    expect(pill.contains(label)).toBe(false);
  });

  it('the visible "Viber" caption is a sibling outside the coloured pill, not inside it', () => {
    renderLayout();
    const pill = pillFor('viber');
    const label = pill.nextElementSibling;
    expect(label, 'expected a sibling element after the pill').not.toBeNull();
    expect(label).toHaveTextContent('Viber');
    expect(pill.contains(label)).toBe(false);
  });

  it('both pills use .press-brand, not the plain .press other rows here carry', () => {
    renderLayout();
    for (const pill of [pillFor('whatsapp'), pillFor('viber')]) {
      expect(pill).toHaveClass('press-brand');
      expect(pill).not.toHaveClass('press');
    }
  });

  it('reuses the shared whatsappLink()/viberLink() helpers — no new link target', () => {
    renderLayout();
    expect(pillFor('whatsapp')).toHaveAttribute('href', whatsappLink());
    expect(pillFor('viber')).toHaveAttribute('href', viberLink());
  });

  it('keeps the visible phone number rendered — it is not replaced by the new buttons', () => {
    renderLayout();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(SITE.contact.phone.display);
  });
});
