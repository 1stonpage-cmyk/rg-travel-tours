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

  it('renders a floating WhatsApp link with an accessible name', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: /whatsapp/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('wa.me'));
  });

  it('exposes a skip link to the main content', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /skip to (main )?content/i })).toBeInTheDocument();
  });

  it('pins the mandated PlaceholderBadge copy and forbids the superseded "not real" wording', () => {
    renderLayout();
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent(/client-supplied/i);
    expect(badge).toHaveTextContent(/pending verification/i);
    expect(badge).not.toHaveTextContent(/ratings, guest counts, prices, permits and photos are not real/i);
  });
});

/**
 * The floating WhatsApp button hides while the hero's search form is on screen,
 * because a fixed bottom-right button otherwise covers the right edge of that
 * primary CTA (measured at 360px and 390px).
 *
 * jsdom implements no IntersectionObserver, so it is stubbed here. That covers
 * the wiring — selector, state, early return, cleanup — but NOT the browser's
 * own intersection computation, which is platform behaviour.
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

  const whatsapp = () => screen.queryByRole('link', { name: /whatsapp/i });

  it('observes the hero search form when one is present', () => {
    const form = addHeroSearchForm();
    renderLayout();

    const observer = MockIntersectionObserver.instances.at(-1);
    expect(observer).toBeDefined();
    expect(observer!.observed).toContain(form);
  });

  it('hides the button while the search form is intersecting, and restores it after', () => {
    addHeroSearchForm();
    renderLayout();
    const observer = MockIntersectionObserver.instances.at(-1)!;

    // Visible to begin with — the observer has not reported yet.
    expect(whatsapp()).toBeInTheDocument();

    act(() => observer.emit(true));
    expect(whatsapp()).not.toBeInTheDocument();

    act(() => observer.emit(false));
    expect(whatsapp()).toBeInTheDocument();
  });

  it('stays visible on pages with no hero search form', () => {
    renderLayout();
    expect(whatsapp()).toBeInTheDocument();
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });

  it('disconnects the observer on unmount', () => {
    addHeroSearchForm();
    const { unmount } = renderLayout();
    const observer = MockIntersectionObserver.instances.at(-1)!;

    expect(observer.disconnected).toBe(false);
    unmount();
    expect(observer.disconnected).toBe(true);
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
    const copyright = screen
      .getByRole('contentinfo')
      .textContent?.match(/©\s*\d{4}[^.]*\./)?.[0];
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
