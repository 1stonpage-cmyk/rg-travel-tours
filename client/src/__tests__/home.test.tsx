import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrpcProviders } from '@/lib/trpc';
import HomePage from '@/pages/public/HomePage';
import {
  DESTINATIONS_FIXTURE,
  PACKAGES_FIXTURE,
  REVIEWS_FIXTURE,
  SETTINGS_FIXTURE,
  TOURS_FIXTURE,
} from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

async function checkConsent(user: ReturnType<typeof userEvent.setup>, form: HTMLElement) {
  await user.click(within(form).getByLabelText(/i agree/i));
}

function renderHome() {
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('home page', () => {
  // HeroSection, TrustBar, CatalogPreview, PackagesSection and
  // ReviewsSection all fetch from the API now. Every test here renders the
  // full HomePage, so all five queries need a mock whether or not a given
  // test looks at that section.
  beforeEach(() => {
    mockTrpc({
      'settings.get': SETTINGS_FIXTURE,
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  it('renders exactly one h1, in the hero', async () => {
    // The hero's h1 is the only part of HeroSection gated on settings.get
    // (Task 2.6) — everything else in the hero renders unconditionally.
    renderHome();
    expect(await screen.findAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders a search form with destination, date, and guests', () => {
    renderHome();
    const form = screen.getByRole('form', { name: /search tours/i });
    expect(within(form).getByLabelText(/destination/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(within(form).getByLabelText(/guests/i)).toBeInTheDocument();
  });

  it('exposes every section anchor used by the nav', async () => {
    // Task T16: `#tours` (CatalogPreview) and `#places` (MostVisited) are
    // now gated on `settings.get` resolving `showTours: true` — wait for one
    // of them before checking the rest, rather than asserting synchronously.
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector('#tours')).toBeTruthy());
    for (const id of ['tours', 'how', 'why', 'places', 'packages', 'reviews', 'faq', 'contact']) {
      expect(container.querySelector(`#${id}`), `missing #${id}`).toBeTruthy();
    }
  });

  it('shows three packages, each with a struck-through old price', async () => {
    const { container } = renderHome();
    // Task T16 + Decision 2: PackagesSection is now gated on `settings.get`
    // resolving `showTours: true`, so wait for it before checking its children.
    const packages = (await waitFor(() => {
      const el = container.querySelector('#packages') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el;
    }))!;
    await within(packages).findByRole('heading', {
      level: 3,
      name: PACKAGES_FIXTURE[0]!.title,
    });
    expect(packages.querySelectorAll('s').length).toBe(PACKAGES_FIXTURE.length);
  });

  it('hides the weekly booking count when it is zero', () => {
    renderHome();
    expect(screen.queryByText(/booked 0/i)).not.toBeInTheDocument();
  });

  it('renders seven FAQ questions', async () => {
    // FAQs now come from settings.get (task 3.3), which resolves
    // asynchronously, so the accordion buttons aren't present on the first
    // synchronous render — wait for the first one before counting all seven.
    const { container } = renderHome();
    const faq = container.querySelector('#faq') as HTMLElement;
    await within(faq).findAllByRole('button');
    expect(within(faq).getAllByRole('button')).toHaveLength(7);
  });

  it('reveals the promo code only after newsletter signup', async () => {
    const user = userEvent.setup();
    // Task 3.5 wires this form to the real newsletter.subscribe mutation —
    // the reveal now depends on that mutation actually resolving, so it
    // needs its own mock on top of the beforeEach's five read queries.
    mockTrpc({ 'newsletter.subscribe': { ok: true, alreadySubscribed: false } });
    renderHome();

    expect(screen.queryByText(SETTINGS_FIXTURE.promo!.code)).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const status = await screen.findByRole('status');
    expect(within(status).getByText(SETTINGS_FIXTURE.promo!.code)).toBeInTheDocument();
  });

  it('renders exactly six review cards', async () => {
    // REVIEWS_FIXTURE.items.length is asserted against a literal, not
    // against itself, so dropping a review from the fixture actually fails
    // this test.
    expect(REVIEWS_FIXTURE.items.length).toBe(6);
    const { container } = renderHome();
    const reviews = container.querySelector('#reviews') as HTMLElement;
    expect(reviews).toBeTruthy();
    await within(reviews).findByText(REVIEWS_FIXTURE.items[0]!.name);
    expect(within(reviews).getAllByRole('listitem').length).toBe(6);
  });

  it('offers phone, email, and WhatsApp in the contact section', () => {
    const { container } = renderHome();
    const contact = container.querySelector('#contact') as HTMLElement;
    expect(within(contact).getByRole('link', { name: /whatsapp/i })).toBeInTheDocument();
    expect(contact.querySelector('a[href^="tel:"]')).toBeTruthy();
    expect(contact.querySelector('a[href^="mailto:"]')).toBeTruthy();
  });

  // Task 3.5 wires this form to the real inquiries.create mutation. The
  // beforeEach above mocks the five read queries but not this mutation, so
  // submitting it here hits mock-trpc's "No mock for inquiries.create"
  // path — a genuine failure, not a stand-in for "nothing is wired yet".
  // The guarantee this preserves: a resolved-success claim (role="status")
  // appears only once the mutation has actually resolved; a failed
  // mutation surfaces as role="alert" instead, and never role="status".
  it('never claims an inquiry was sent when the request fails', async () => {
    const user = userEvent.setup();
    renderHome();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.type(within(form).getByLabelText(/^message$/i), 'Hello');
    await checkConsent(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  it('never claims a package inquiry was sent when the request fails', async () => {
    const user = userEvent.setup();
    renderHome();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await checkConsent(user, form);
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  // --- Mandated correction 2(a): the conditional trust line must not fabricate a review count. ---
  it('never prints a fabricated review-count clause while ratingCount is null', () => {
    expect(SETTINGS_FIXTURE.trust.ratingCount).toBeNull();
    const { container } = renderHome();
    const bodyText = container.textContent ?? '';

    // No "from <n> guest reviews" clause anywhere on the page while ratingCount is null.
    expect(bodyText).not.toMatch(/from\s+guest reviews/i);
    expect(bodyText).not.toMatch(/from\s+null\s+(guest\s+)?reviews/i);
    // No literal "null"/"undefined" artifact leaking into rendered text.
    expect(bodyText).not.toMatch(/\bnull\b/i);
    expect(bodyText).not.toMatch(/\bundefined\b/i);
  });

  // --- Mandated correction 2(b): zero-count hide rule, both halves. ---
  it('hides the weekly booking badge only for the zero-booking tour, and shows it for a nonzero one', async () => {
    const { container } = renderHome();
    // Task T16: #tours (CatalogPreview) is gated on `settings.get` resolving
    // `showTours: true` — wait for it to mount before querying inside it.
    await waitFor(() => expect(container.querySelector('#tours')).toBeTruthy());
    const toursSection = container.querySelector('#tours') as HTMLElement;

    // Moalboal (TOURS_FIXTURE[2]) has bookedThisWeek: 0 — no badge for it.
    const moalboalHeading = await within(toursSection).findByRole('heading', {
      level: 3,
      name: /Moalboal Sardine Run/i,
    });
    const moalboalCard = moalboalHeading.closest('li');
    expect(moalboalCard).toBeTruthy();
    expect(within(moalboalCard as HTMLElement).queryByText(/this week/i)).not.toBeInTheDocument();

    // Oslob (TOURS_FIXTURE[0]) has bookedThisWeek: 7 — badge must render.
    const oslobHeading = within(toursSection).getByRole('heading', {
      level: 3,
      name: /Oslob Whale Sharks/i,
    });
    const oslobCard = oslobHeading.closest('li');
    expect(oslobCard).toBeTruthy();
    expect(within(oslobCard as HTMLElement).getByText(/booked 7/i)).toBeInTheDocument();
  });

  // --- Mandated correction 2(c): the destination filter chips actually filter. ---
  it('filters tours by destination so every chip yields a non-empty, matching grid', async () => {
    const user = userEvent.setup();
    renderHome();

    // Task T16: #tours (CatalogPreview, including this filter group) is
    // gated on `settings.get` resolving `showTours: true`.
    const group = await screen.findByRole('group', { name: /filter tours by destination/i });

    for (const destination of DESTINATIONS_FIXTURE) {
      const chip = await within(group).findByRole('button', { name: destination.name });
      await user.click(chip);
      expect(chip).toHaveAttribute('aria-pressed', 'true');

      const toursSection = document.querySelector('#tours') as HTMLElement;
      const cards = await within(toursSection).findAllByRole('heading', { level: 3 });
      expect(cards.length).toBeGreaterThan(0);

      for (const card of cards) {
        const li = card.closest('li') as HTMLElement;
        expect(li.textContent).toContain(destination.name);
      }
    }
  });
});

/**
 * Task 4 (1D): a client-side navigation INTO `/` used to leave the previous
 * page's title showing — `settings.site_seo.title` is already a complete,
 * database-driven string (no brand suffix to append), and nothing here
 * called any title hook at all before this task.
 */
describe('home page — document title (Task 4, 1D)', () => {
  beforeEach(() => {
    mockTrpc({
      'settings.get': SETTINGS_FIXTURE,
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  it('sets document.title to settings.siteSeo.title once settings.get resolves', async () => {
    document.title = 'Some other page | TravelSugbo';
    renderHome();

    await waitFor(() => expect(document.title).toBe(SETTINGS_FIXTURE.siteSeo.title));
  });

  it('leaves the previous title alone while settings.get is still pending', () => {
    document.title = 'Some other page | TravelSugbo';
    mockTrpc({ 'settings.get': () => new Promise(() => {}) });
    renderHome();

    expect(document.title).toBe('Some other page | TravelSugbo');
  });
});

/**
 * `show_tours` gate (transfers-launch plan, Task T16). `CatalogPreview` and
 * `MostVisited` are not mounted at all while tours are hidden (rather than
 * mounted and rendering an empty/dead-end section — see `HomePage.tsx`'s own
 * comment), and the hero's SECONDARY tour-search form (`aria-label="Search
 * tours"`) is hidden too. The PRIMARY transfer mini-flow form is unaffected
 * either way — proving that is what actually catches a gate that hid too
 * much rather than exactly the three tour-only surfaces.
 */
describe('home page — tours hidden (show_tours gate, Task T16)', () => {
  // Self-contained rather than relying on the outer `describe('home page')`
  // block's own `beforeEach` (a sibling describe, not a parent, so its hooks
  // do not apply here) — the same five mocks that block uses, with
  // `showTours` flipped off.
  beforeEach(() => {
    mockTrpc({
      'settings.get': { ...SETTINGS_FIXTURE, showTours: false },
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  it('does not render CatalogPreview, MostVisited, or the hero tour-search form', async () => {
    renderHome();

    /*
     * Wait for `settings.get` to actually resolve before asserting absence
     * — the hero's transfer form (`find a transfer`) renders unconditionally
     * regardless of that query's state (by design: `HeroSection.tsx`'s own
     * "renders unconditionally... no dependency on settingsQuery having
     * resolved" contract), so waiting on IT proves nothing about whether
     * settings has resolved. The tour-search form, by contrast, is `!==
     * false` rather than `?? false` precisely so it keeps rendering during
     * that same pending window — so this must wait for the real resolution
     * (the hero headline, gated on settings via QueryBoundary) or this
     * assertion runs too early and catches the form mid-flight.
     */
    await screen.findByRole('heading', { level: 1 });

    expect(screen.queryByRole('form', { name: /search tours/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /popular cebu day tours/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /most visited places/i })).not.toBeInTheDocument();
    expect(document.querySelector('#tours')).toBeNull();
    expect(document.querySelector('#places')).toBeNull();
    expect(screen.queryByRole('heading', { name: /^packages$/i })).not.toBeInTheDocument();
    expect(document.querySelector('#packages')).toBeNull();
  });

  it('still renders the primary transfer mini-flow form, unaffected', async () => {
    renderHome();
    expect(await screen.findByRole('form', { name: /find a transfer/i })).toBeInTheDocument();
  });
});

/**
 * The same three surfaces, proven present with the baseline (`showTours:
 * true`) fixture — the regression half of the pair above. If an existing
 * test elsewhere already covers one of these (the search form is in the
 * very first describe block above), this does not duplicate it; it only
 * adds what that coverage is missing.
 */
describe('home page — tours shown (regression, Task T16)', () => {
  beforeEach(() => {
    mockTrpc({
      'settings.get': SETTINGS_FIXTURE,
      'destinations.list': DESTINATIONS_FIXTURE,
      'tours.list': TOURS_FIXTURE,
      'packages.list': PACKAGES_FIXTURE,
      'reviews.published': REVIEWS_FIXTURE,
    });
  });

  it('renders CatalogPreview and MostVisited', async () => {
    renderHome();
    expect(
      await screen.findByRole('heading', { name: /popular cebu day tours/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /most visited places/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^packages$/i })).toBeInTheDocument();
  });
});
