import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloatingWhatsApp from '@/components/layout/FloatingWhatsApp';
import { ConsentProvider } from '@/lib/consent/ConsentContext';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/types';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

/**
 * FloatingWhatsApp watches the hero search form(s) and hides while either
 * is on screen, to avoid covering the primary CTA at mobile viewports.
 *
 * Since the transfers-only launch (`show_tours = false`) only renders the
 * "Find a transfer" form, the observer must watch BOTH form selectors and
 * hide while EITHER is intersecting.
 */
describe('FloatingWhatsApp observes both hero forms', () => {
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
    emit(target: Element, isIntersecting: boolean) {
      this.callback(
        [{ isIntersecting, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }

  function addTransferForm() {
    const form = document.createElement('form');
    form.setAttribute('aria-label', 'Find a transfer');
    document.body.appendChild(form);
    return form;
  }

  function addTourForm() {
    const form = document.createElement('form');
    form.setAttribute('aria-label', 'Search tours');
    document.body.appendChild(form);
    return form;
  }

  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    // Seed consent so the bar is not hidden by the banner
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 1, analytics: false, marketing: false, at: new Date().toISOString() }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document
      .querySelectorAll('form[aria-label="Find a transfer"], form[aria-label="Search tours"]')
      .forEach((f) => f.remove());
    localStorage.clear();
  });

  function renderComponent() {
    return render(
      <TrpcProviders>
        <ConsentProvider>
          <MemoryRouter>
            <FloatingWhatsApp />
          </MemoryRouter>
        </ConsentProvider>
      </TrpcProviders>,
    );
  }

  const whatsappLinks = () => screen.queryAllByRole('link', { name: /chat with us on whatsapp/i });

  /**
   * Bug reproduction: on transfers-only launch, only the transfer form
   * exists, but the observer was only watching the tour form.
   * Result: the bar stays visible (not `inert`/`aria-hidden`) even though
   * the transfer form is intersecting.
   */
  it('hides the bottom bar while the transfer teaser form is on screen (transfers-only launch case)', () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    const transferForm = addTransferForm();
    renderComponent();

    // Find the observer that is watching the transfer form
    const observer = MockIntersectionObserver.instances.find((o) =>
      o.observed.includes(transferForm),
    );
    expect(observer).toBeDefined();

    // Visible to begin with
    expect(whatsappLinks().length).toBeGreaterThan(0);

    // Emit intersection for the transfer form
    act(() => observer!.emit(transferForm, true));

    // Should now be hidden
    expect(whatsappLinks()).toHaveLength(0);

    // And after clearing intersection, should be visible again
    act(() => observer!.emit(transferForm, false));
    expect(whatsappLinks().length).toBeGreaterThan(0);
  });

  /**
   * Additive: when both forms exist (show_tours = true), the bar hides
   * when EITHER one is intersecting.
   */
  it('hides the bar when either form is intersecting (both forms present)', () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE }); // showTours is true
    const transferForm = addTransferForm();
    const tourForm = addTourForm();
    renderComponent();

    // Both forms should be observed
    expect(MockIntersectionObserver.instances.some((o) => o.observed.includes(transferForm))).toBe(
      true,
    );
    expect(MockIntersectionObserver.instances.some((o) => o.observed.includes(tourForm))).toBe(
      true,
    );

    // Find the observer that handles both
    const observer = MockIntersectionObserver.instances.find(
      (o) => o.observed.includes(transferForm) && o.observed.includes(tourForm),
    );
    expect(observer).toBeDefined();

    // Visible to begin with
    expect(whatsappLinks().length).toBeGreaterThan(0);

    // Hide when transfer form intersects
    act(() => observer!.emit(transferForm, true));
    expect(whatsappLinks()).toHaveLength(0);

    // Still hidden when tour form intersects too
    act(() => observer!.emit(tourForm, true));
    expect(whatsappLinks()).toHaveLength(0);

    // Clear transfer form intersection
    act(() => observer!.emit(transferForm, false));
    // Still hidden because tour form is still intersecting
    expect(whatsappLinks()).toHaveLength(0);

    // Clear tour form intersection
    act(() => observer!.emit(tourForm, false));
    // Now visible again
    expect(whatsappLinks().length).toBeGreaterThan(0);
  });

  /**
   * Existing behavior: stays visible on pages with no hero search form.
   */
  it('stays visible on pages with no hero search forms', () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderComponent();
    expect(whatsappLinks().length).toBeGreaterThan(0);
  });
});

/**
 * Owner decision 2026-11-27 ("hide call numbers") — the owner works at sea
 * and cannot take calls/SMS. `FloatingWhatsApp` (desktop bubble and mobile
 * bottom bar) already carries no call/phone surface in either state; this
 * pins that so a future change can't reintroduce one.
 */
describe('FloatingWhatsApp — never shows a call number, in either showCallNumbers state (owner decision 2026-11-27)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it.each([true, false])(
    'renders no tel: link when showCallNumbers is %s',
    async (showCallNumbers) => {
      mockTrpc({
        'settings.get': {
          ...SETTINGS_FIXTURE,
          contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers },
        },
      });
      // Seed an already-decided consent choice — otherwise the undecided
      // cookie banner hides this component entirely (see
      // FloatingWhatsApp.tsx's `consentOpen` gate), and the control this test
      // is checking would never render at all.
      localStorage.setItem(
        CONSENT_STORAGE_KEY,
        JSON.stringify({ v: 1, analytics: false, marketing: false, at: new Date().toISOString() }),
      );
      render(
        <TrpcProviders>
          <ConsentProvider>
            <MemoryRouter>
              <FloatingWhatsApp />
            </MemoryRouter>
          </ConsentProvider>
        </TrpcProviders>,
      );
      // Both the desktop bubble and the mobile bottom bar mount in jsdom (CSS,
      // not conditional rendering, picks one per breakpoint) — see
      // layout.test.tsx's identical note — so this finds at least one, not
      // exactly one.
      await screen.findAllByRole('link', { name: 'Chat with us on WhatsApp' });
      expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
    },
  );
});
