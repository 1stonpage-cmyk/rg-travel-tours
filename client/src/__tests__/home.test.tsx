import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DESTINATIONS, PLACEHOLDER_SETTINGS, REVIEWS } from '@/lib/placeholder-data';
import HomePage from '@/pages/public/HomePage';

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('home page', () => {
  it('renders exactly one h1, in the hero', () => {
    renderHome();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
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

  it('shows three packages, each with a struck-through old price', () => {
    const { container } = renderHome();
    const packages = container.querySelector('#packages');
    expect(packages).toBeTruthy();
    expect(packages!.querySelectorAll('s').length).toBe(3);
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

    expect(screen.queryByText(PLACEHOLDER_SETTINGS.promoCode)).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const status = await screen.findByRole('status');
    expect(within(status).getByText(PLACEHOLDER_SETTINGS.promoCode)).toBeInTheDocument();
    expect(status).toHaveTextContent(/address has not been saved/i);
  });

  it('renders exactly six review cards', () => {
    // REVIEWS.length is asserted against a literal, not against itself, so
    // dropping a review from placeholder-data.ts actually fails this test.
    expect(REVIEWS.length).toBe(6);
    const { container } = renderHome();
    const reviews = container.querySelector('#reviews');
    expect(reviews).toBeTruthy();
    expect(within(reviews as HTMLElement).getAllByRole('listitem').length).toBe(6);
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

    const form = screen.getByRole('form', { name: /package inquiry/i });
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
  it('hides the weekly booking badge only for the zero-booking tour, and shows it for a nonzero one', () => {
    const { container } = renderHome();
    const toursSection = container.querySelector('#tours') as HTMLElement;

    // Moalboal (TOURS[2]) has bookedThisWeek: 0 — no badge for it.
    const moalboalHeading = within(toursSection).getByRole('heading', {
      level: 3,
      name: /Moalboal Sardine Run/i,
    });
    const moalboalCard = moalboalHeading.closest('li');
    expect(moalboalCard).toBeTruthy();
    expect(within(moalboalCard as HTMLElement).queryByText(/this week/i)).not.toBeInTheDocument();

    // Oslob (TOURS[0]) has bookedThisWeek: 7 — badge must render.
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

    for (const destination of DESTINATIONS) {
      const chip = within(group).getByRole('button', { name: destination.name });
      await user.click(chip);
      expect(chip).toHaveAttribute('aria-pressed', 'true');

      const toursSection = document.querySelector('#tours') as HTMLElement;
      const cards = within(toursSection).getAllByRole('heading', { level: 3 });
      expect(cards.length).toBeGreaterThan(0);

      for (const card of cards) {
        const li = card.closest('li') as HTMLElement;
        expect(li.textContent).toContain(destination.name);
      }
    }
  });
});
