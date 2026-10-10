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
import { GENERIC_MUTATION_ERROR_MESSAGE, RATE_LIMIT_MESSAGE } from '@/lib/mutation-errors';
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

  /**
   * The generic half of the 429-vs-everything-else pair. Asserting only
   * "not the raw error" left both messages interchangeable: returning the
   * rate-limit text unconditionally passed every form test, and BUG-084 was
   * exactly a 429-handling defect. This pins the generic message and
   * excludes the rate-limit one; the 429 test below does the mirror image,
   * so swapping the two fails here AND there.
   */
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
    expect(alert).toHaveTextContent(GENERIC_MUTATION_ERROR_MESSAGE);
    expect(alert.textContent).not.toMatch(/too many messages/i);
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

  /** The 429 half of the pair — see the generic-failure test above. */
  it('reports the rate-limit response as a distinct, calm message', async () => {
    const user = userEvent.setup();
    mockTrpcRateLimited('inquiries.create');
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/too many messages.*try again shortly/i);
    expect(alert).toHaveTextContent(RATE_LIMIT_MESSAGE);
    expect(alert.textContent).not.toMatch(/something went wrong sending this/i);
  });

  /**
   * A success status and a validation alert must never sit side by side.
   * Submit once successfully, then submit again with consent cleared: the
   * stale "Message sent" line used to stay on screen next to the new
   * consent alert, telling the visitor their message was sent while the
   * form was refusing to send it.
   */
  it('clears the previous success status when a new submit fails the consent check', async () => {
    const user = userEvent.setup();
    mockTrpc({ 'inquiries.create': { ok: true } });
    renderContact();

    const form = screen.getByRole('form', { name: /contact inquiry/i });
    await fillContactForm(user, form);
    await user.click(within(form).getByRole('button', { name: /send message/i }));
    expect(await within(form).findByRole('status')).toHaveTextContent(/sent/i);

    // Consent is unchecked again after the success reset. Clear the text
    // fields before refilling: `user.type` appends, and an email field left
    // holding two concatenated addresses is invalid, which makes jsdom
    // swallow the submit event entirely instead of exercising the handler.
    await user.clear(within(form).getByLabelText(/your name/i));
    await user.clear(within(form).getByLabelText(/^email$/i));
    await user.clear(within(form).getByLabelText(/^message$/i));
    await fillContactForm(user, form, { consent: false });
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/agree/i);
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
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

  /**
   * Nothing previously pinned the selected-package -> packageId mapping:
   * every test submitted the default (first) package, so a hardcoded
   * `packages[0]!` would have passed while filing each inquiry against the
   * wrong package. This selects the THIRD fixture package and asserts both
   * the id and the synthesized message name it.
   */
  it('files the inquiry against the package the visitor actually selected', async () => {
    const user = userEvent.setup();
    const chosen = PACKAGES_FIXTURE[2]!;
    let capturedInput: Record<string, unknown> | undefined;
    mockTrpc({
      'inquiries.create': (input: unknown) => {
        capturedInput = input as Record<string, unknown>;
        return { ok: true };
      },
    });
    renderPackages();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.selectOptions(within(form).getByLabelText(/^package$/i), chosen.slug);
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    await within(form).findByRole('status');
    expect(capturedInput).toMatchObject({ type: 'package', packageId: chosen.id });
    expect(chosen.id).not.toBe(PACKAGES_FIXTURE[0]!.id);
    expect(String(capturedInput?.message)).toContain(chosen.title);
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

  /** Same stale-status defect as ContactSection — see that test's comment. */
  it('clears the previous success status when a new submit fails the consent check', async () => {
    const user = userEvent.setup();
    mockTrpc({ 'inquiries.create': { ok: true } });
    renderPackages();

    const form = await screen.findByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));
    expect(await within(form).findByRole('status')).toHaveTextContent(/sent/i);

    // Clear before refilling — see the note in the ContactSection version.
    await user.clear(within(form).getByLabelText(/your name/i));
    await user.clear(within(form).getByLabelText(/^email$/i));
    await user.type(within(form).getByLabelText(/your name/i), 'Test Guest');
    await user.type(within(form).getByLabelText(/^email$/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(/agree/i);
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
    // The same discrimination as the contact form: a non-429 failure must
    // show the generic sentence, never the rate-limit one.
    expect(alert).toHaveTextContent(GENERIC_MUTATION_ERROR_MESSAGE);
    expect(alert.textContent).not.toMatch(/too many messages/i);
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
    expect(alert).toHaveTextContent(RATE_LIMIT_MESSAGE);
    expect(alert.textContent).not.toMatch(/something went wrong sending this/i);
  });
});
