import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ContactSection from '@/components/home/ContactSection';
import FaqSection from '@/components/home/FaqSection';
import FloatingWhatsApp from '@/components/layout/FloatingWhatsApp';
import SiteFooter from '@/components/layout/SiteFooter';
import { SITE } from '@/lib/site';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const PAYMENT_METHODS_QUESTION = 'Which payment methods do you accept?';

const here = dirname(fileURLToPath(import.meta.url));
const readComponentSource = (relativePath: string) =>
  readFileSync(resolve(here, '..', relativePath), 'utf8');

function settingsWith(overrides: Partial<typeof SETTINGS_FIXTURE>) {
  return { ...SETTINGS_FIXTURE, ...overrides };
}

function renderWithTrpc(node: ReactNode) {
  return render(
    <TrpcProviders>
      <MemoryRouter>{node}</MemoryRouter>
    </TrpcProviders>,
  );
}

const OPEN_MESSAGE = 'Open now — we reply within minutes';
const CLOSED_MESSAGE = "Closed — we'll reply by 7:00 AM";

/**
 * `settings.openState.message` is computed server-side (Task 1.5) in
 * Asia/Manila and must be rendered verbatim — a client clock would show a
 * Manila-correct message only to guests already in that timezone. Both
 * assertions below pin the exact strings so a future edit that "simplifies"
 * this back into a local `new Date()` check actually fails.
 */
describe('open/closed state', () => {
  it('shows the open-now message from the server, not a client clock', async () => {
    mockTrpc({
      'settings.get': settingsWith({ openState: { isOpen: true, message: OPEN_MESSAGE } }),
    });
    renderWithTrpc(<ContactSection />);

    expect(await screen.findByText(OPEN_MESSAGE)).toBeInTheDocument();
  });

  it('shows the closed message when the server says closed', async () => {
    mockTrpc({
      'settings.get': settingsWith({ openState: { isOpen: false, message: CLOSED_MESSAGE } }),
    });
    renderWithTrpc(<ContactSection />);

    expect(await screen.findByText(CLOSED_MESSAGE)).toBeInTheDocument();
  });

  it('renders the same open state on the WhatsApp button and the contact section', async () => {
    mockTrpc({
      'settings.get': settingsWith({ openState: { isOpen: true, message: OPEN_MESSAGE } }),
    });
    renderWithTrpc(
      <>
        <ContactSection />
        <FloatingWhatsApp />
      </>,
    );

    // The message appears at least once in ContactSection and at least once
    // (desktop bubble and/or mobile bar — both mount at once in jsdom; CSS,
    // not conditional rendering, picks one per breakpoint) alongside the
    // WhatsApp control. Both read from the same cached settings.get result,
    // not independent clocks, so they can never disagree.
    const occurrences = await screen.findAllByText(OPEN_MESSAGE);
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * A runtime spy on `Date` would only catch a call made during THIS test's
   * render, with THIS test's fixture — it would prove nothing about the
   * component's own source. Reading the source text directly instead.
   */
  it('ContactSection and FloatingWhatsApp contain no Date()/Date.now() call of their own', () => {
    const contactSource = readComponentSource('components/home/ContactSection.tsx');
    const whatsappSource = readComponentSource('components/layout/FloatingWhatsApp.tsx');
    for (const source of [contactSource, whatsappSource]) {
      expect(source).not.toMatch(/new Date\(|Date\.now\(/);
    }
  });
});

describe('payment methods — footer and FAQ composed from the same settings.paymentMethods, not two static lists', () => {
  it('lists only enabled payment methods in the footer', async () => {
    const methods = SETTINGS_FIXTURE.paymentMethods.filter((m) => m.key !== 'grabpay');
    mockTrpc({ 'settings.get': settingsWith({ paymentMethods: methods }) });
    renderWithTrpc(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText('GCash')).toBeInTheDocument();
    expect(within(footer).queryByText('GrabPay')).not.toBeInTheDocument();
  });

  it('omits a disabled method from the payment FAQ answer too', async () => {
    const methods = SETTINGS_FIXTURE.paymentMethods.filter((m) => m.key !== 'grabpay');
    mockTrpc({ 'settings.get': settingsWith({ paymentMethods: methods }) });
    renderWithTrpc(<FaqSection />);

    const user = userEvent.setup();
    const question = await screen.findByRole('button', { name: PAYMENT_METHODS_QUESTION });
    await user.click(question);

    const answer = await screen.findByText(/through PayMongo/);
    expect(answer.textContent).not.toMatch(/GrabPay/);
    expect(answer.textContent).toMatch(/GCash/);
  });

  it('a disabled method disappears from BOTH the footer and the FAQ at once — the drift task 3.3 left open', async () => {
    const methods = SETTINGS_FIXTURE.paymentMethods.filter((m) => m.key !== 'grabpay');
    mockTrpc({ 'settings.get': settingsWith({ paymentMethods: methods }) });
    renderWithTrpc(
      <>
        <SiteFooter />
        <FaqSection />
      </>,
    );

    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText('GCash')).toBeInTheDocument();
    expect(within(footer).queryByText('GrabPay')).not.toBeInTheDocument();

    const user = userEvent.setup();
    const question = await screen.findByRole('button', { name: PAYMENT_METHODS_QUESTION });
    await user.click(question);

    const answer = await screen.findByText(/through PayMongo/);
    expect(answer.textContent).not.toMatch(/GrabPay/);
  });

  it('still lists every enabled method when nothing is disabled', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    for (const method of SETTINGS_FIXTURE.paymentMethods) {
      expect(await within(footer).findByText(method.label)).toBeInTheDocument();
    }
  });
});

describe('permits', () => {
  it('renders "— pending —" for every empty permit', async () => {
    mockTrpc({
      'settings.get': settingsWith({ permits: { dot: null, dti: null, bir: null } }),
    });
    renderWithTrpc(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    const pendingMarks = await within(footer).findAllByText('— pending —');
    expect(pendingMarks).toHaveLength(3);
  });

  it('renders a real permit number once settings supply one', async () => {
    mockTrpc({
      'settings.get': settingsWith({
        permits: { dot: 'DOT-2026-001234', dti: null, bir: null },
      }),
    });
    renderWithTrpc(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText('DOT-2026-001234')).toBeInTheDocument();
    const pendingMarks = within(footer).getAllByText('— pending —');
    expect(pendingMarks).toHaveLength(2);
  });

  it('credits R&G Travel & Tours, not TravelSugbo, beside the permits', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText(/Operated by R&G Travel & Tours/)).toBeInTheDocument();
    expect(footer.textContent).not.toMatch(/Operated by TravelSugbo/);
  });
});

describe('contact details still come from the pinned site.ts-mirrored values', () => {
  it('keeps the real phone number in ContactSection', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    renderWithTrpc(<ContactSection />);

    const occurrences = await screen.findAllByText(SITE.contact.phone.display);
    expect(occurrences.length).toBeGreaterThan(0);
  });
});
