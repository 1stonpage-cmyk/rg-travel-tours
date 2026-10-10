import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';
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

  it('exposes every section anchor used by the nav', () => {
    const { container } = renderHome();
    for (const id of ['tours', 'how', 'why', 'places', 'packages', 'reviews', 'faq', 'contact']) {
      expect(container.querySelector(`#${id}`), `missing #${id}`).toBeTruthy();
    }
  });

  it('shows three packages, each with a struck-through old price', async () => {
    const { container } = renderHome();
    const packages = container.querySelector('#packages') as HTMLElement;
    expect(packages).toBeTruthy();
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

  it('renders seven FAQ questions', () => {
    const { container } = renderHome();
    const faq = container.querySelector('#faq');
    expect(within(faq as HTMLElement).getAllByRole('button')).toHaveLength(7);
  });

  it('reveals the promo code only after newsletter signup', async () => {
    const user = userEvent.setup();
    renderHome();

    expect(screen.queryByText(SETTINGS_FIXTURE.promo!.code)).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const status = await screen.findByRole('status');
    expect(within(status).getByText(SETTINGS_FIXTURE.promo!.code)).toBeInTheDocument();
    expect(status).toHaveTextContent(/address has not been saved/i);
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

  it('never claims an inquiry was sent', async () => {
    const user = userEvent.setup();
    renderHome();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.type(within(form).getByLabelText(/message/i), 'Hello');
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const status = await within(form).findByRole('status');
    expect(status).toHaveTextContent(/nothing has been sent/i);
  });

  it('never claims a package inquiry was sent', async () => {
    const user = userEvent.setup();
    renderHome();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    const status = await within(form).findByRole('status');
    expect(status).toHaveTextContent(/nothing has been sent/i);
  });

  // --- Mandated correction 2(a): the conditional trust line must not fabricate a review count. ---
  it('never prints a fabricated review-count clause while ratingCount is null', () => {
    expect(PLACEHOLDER_SETTINGS.ratingCount).toBeNull();
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

    const group = screen.getByRole('group', { name: /filter tours by destination/i });

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
