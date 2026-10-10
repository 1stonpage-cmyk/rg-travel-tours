/**
 * Task 3.5: the three public forms (ContactSection, PackagesSection's
 * package-inquiry form, PromoNewsletter) wired to the already-reviewed
 * `inquiries.create` / `newsletter.subscribe` mutations (Task 1.7).
 *
 * Each component is mounted directly (not the full HomePage) so these
 * tests exercise exactly the form under test, with a minimal mock for
 * whatever read query that component also fires.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ContactSection from '@/components/home/ContactSection';
import PackagesSection from '@/components/home/PackagesSection';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import { TrpcProviders } from '@/lib/trpc';
import { PACKAGES_FIXTURE, SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, mockTrpcError, mockTrpcRateLimited } from './helpers/mock-trpc';

function renderContact() {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  return render(
    <TrpcProviders>
      <ContactSection />
    </TrpcProviders>,
  );
}

function renderPackages() {
  mockTrpc({ 'packages.list': PACKAGES_FIXTURE });
  return render(
    <TrpcProviders>
      <PackagesSection />
    </TrpcProviders>,
  );
}

function renderPromo() {
  mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
  return render(
    <TrpcProviders>
      <PromoNewsletter />
    </TrpcProviders>,
  );
}

async function fillContactForm(
  user: ReturnType<typeof userEvent.setup>,
  form: HTMLElement,
  { consent = true }: { consent?: boolean } = {},
) {
  await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
  await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
  await user.type(within(form).getByLabelText(/^message$/i), 'Hello there');
  if (consent) {
    await user.click(within(form).getByLabelText(/i agree/i));
  }
}

describe('ContactSection — wired to inquiries.create', () => {
  it('submits a contact inquiry and confirms success', async () => {
    const user = userEvent.setup();
    mockTrpc({ 'inquiries.create': { ok: true } });
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const status = await within(form).findByRole('status');
    expect(status).toHaveTextContent(/sent/i);
  });

  it('blocks submission without the data-privacy consent checkbox, and says why', async () => {
    const user = userEvent.setup();
    let wasCalled = false;
    mockTrpc({
      'inquiries.create': () => {
        wasCalled = true;
        return { ok: true };
      },
    });
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form, { consent: false });
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/agree/i);
    expect(wasCalled).toBe(false);
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a friendly failure message, in brand error style, when the mutation fails', async () => {
    const user = userEvent.setup();
    mockTrpcError('inquiries.create');
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert.className).toContain('text-brand-error');
    expect(alert.textContent).not.toMatch(/mock failure/i);
  });

  it('never claims an inquiry was sent when the mutation failed', async () => {
    const user = userEvent.setup();
    mockTrpcError('inquiries.create');
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    await within(form).findByRole('alert');
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables the submit button while in flight and re-enables after', async () => {
    const user = userEvent.setup();
    let resolveMutation!: (value: { ok: true }) => void;
    mockTrpc({
      'inquiries.create': () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveMutation = resolve;
        }),
    });
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    const button = within(form).getByRole('button', { name: /send message/i });
    await user.click(button);

    expect(button).toBeDisabled();

    resolveMutation({ ok: true });
    await within(form).findByRole('status');
    expect(button).not.toBeDisabled();
  });

  it('reports the rate-limit response as a distinct, calm message', async () => {
    const user = userEvent.setup();
    mockTrpcRateLimited('inquiries.create');
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/too many messages.*try again shortly/i);
  });
});

describe('PackagesSection — package inquiry wired to inquiries.create', () => {
  it('submits a package inquiry carrying the package id', async () => {
    const user = userEvent.setup();
    let capturedInput: Record<string, unknown> | undefined;
    mockTrpc({
      'inquiries.create': (input: unknown) => {
        capturedInput = input as Record<string, unknown>;
        return { ok: true };
      },
    });
    renderPackages();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    await within(form).findByRole('status');
    expect(capturedInput).toMatchObject({
      type: 'package',
      packageId: PACKAGES_FIXTURE[0]!.id,
      consent: true,
    });
  });

  it('blocks submission without the data-privacy consent checkbox, and says why', async () => {
    const user = userEvent.setup();
    let wasCalled = false;
    mockTrpc({
      'inquiries.create': () => {
        wasCalled = true;
        return { ok: true };
      },
    });
    renderPackages();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/agree/i);
    expect(wasCalled).toBe(false);
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('PromoNewsletter — wired to newsletter.subscribe', () => {
  it('treats an already-subscribed address as success', async () => {
    const user = userEvent.setup();
    mockTrpc({ 'newsletter.subscribe': { ok: true, alreadySubscribed: true } });
    renderPromo();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const status = await within(form).findByRole('status');
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
    expect(status).toBeInTheDocument();
  });

  it('shows a friendly failure message, never the raw error, when signup fails', async () => {
    const user = userEvent.setup();
    mockTrpcError('newsletter.subscribe');
    renderPromo();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).not.toMatch(/mock failure/i);
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports the rate-limit response as a distinct, calm message', async () => {
    const user = userEvent.setup();
    mockTrpcRateLimited('newsletter.subscribe');
    renderPromo();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/too many messages.*try again shortly/i);
  });
});
