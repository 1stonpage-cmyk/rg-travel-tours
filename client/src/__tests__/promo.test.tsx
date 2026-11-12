import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc, mockTrpcValidationError } from './helpers/mock-trpc';

/**
 * `TurnstileWidget` renders nothing in this test environment (no
 * `VITE_TURNSTILE_SITE_KEY`), which is correct for "feature off" but means
 * `onVerify` is never called through a real render — there is no way to
 * exercise "a verified token reaches the mutation payload" without
 * replacing it. This stub auto-verifies on mount (in an effect, never
 * during render, so it never triggers React's "update during render"
 * warning) and is used ONLY by the one test that asserts on
 * `turnstileToken` — every other test in this file renders the real
 * (null-rendering) widget.
 */
vi.mock('@/components/common/TurnstileWidget', () => ({
  default: ({ onVerify }: { onVerify: (token: string) => void }) => {
    useEffect(() => {
      onVerify('test-turnstile-token');
    }, [onVerify]);
    return null;
  },
}));

const PROMO = SETTINGS_FIXTURE.promo!;
const CODE_SHAPED_PATTERN = /\bWELCOME-[A-Z0-9]{8}\b/;

function settingsWith(overrides: Partial<typeof SETTINGS_FIXTURE> = {}) {
  return { ...SETTINGS_FIXTURE, ...overrides };
}

function renderPromo(overrides: Partial<typeof SETTINGS_FIXTURE> = {}) {
  mockTrpc({ 'settings.get': settingsWith(overrides) });
  return render(
    <TrpcProviders>
      <PromoNewsletter />
    </TrpcProviders>,
  );
}

describe('PromoNewsletter', () => {
  it('renders the marketing headline and body from settings.promo', async () => {
    renderPromo();

    const heading = await screen.findByRole('heading', { level: 2, name: PROMO.headline });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(PROMO.body)).toBeInTheDocument();
  });

  it('hides the whole promo band when settings.promo is null', async () => {
    renderPromo({ promo: null });

    // The promo copy is gone...
    await screen.findByLabelText(/email address/i);
    expect(screen.queryByText(PROMO.headline)).not.toBeInTheDocument();
    expect(screen.queryByText(PROMO.body)).not.toBeInTheDocument();
    expect(screen.queryByText(/direct-booking perk/i)).not.toBeInTheDocument();

    // ...but the newsletter form must still render and be usable.
    const form = screen.getByRole('form', { name: /newsletter/i });
    expect(within(form).getByLabelText(/email address/i)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /sign up/i })).toBeInTheDocument();
  });

  it('shows the live discount percent in the CTA label', async () => {
    renderPromo({ signupCoupon: { discountPercent: 7 } });

    const form = await screen.findByRole('form', { name: /newsletter/i });
    expect(
      await within(form).findByRole('button', { name: /sign up for 7% off/i }),
    ).toBeInTheDocument();
  });

  it('falls back to a percent-free CTA label while settings.get is still loading', async () => {
    let resolveSettings!: (value: typeof SETTINGS_FIXTURE) => void;
    const pending = new Promise<typeof SETTINGS_FIXTURE>((resolve) => {
      resolveSettings = resolve;
    });
    mockTrpc({ 'settings.get': () => pending });
    render(
      <TrpcProviders>
        <PromoNewsletter />
      </TrpcProviders>,
    );

    const form = screen.getByRole('form', { name: /newsletter/i });
    expect(
      within(form).getByRole('button', { name: /sign up for your discount code/i }),
    ).toBeInTheDocument();
    expect(within(form).queryByText(/% off/)).not.toBeInTheDocument();

    resolveSettings(SETTINGS_FIXTURE);
    await within(form).findByRole('button', {
      name: new RegExp(`sign up for ${SETTINGS_FIXTURE.signupCoupon.discountPercent}% off`, 'i'),
    });
  });

  it.each([true, false])(
    'shows the identical "check your inbox" sentence whether alreadySubscribed is %s',
    async (alreadySubscribed) => {
      const user = userEvent.setup();
      renderPromo();
      mockTrpc({ 'newsletter.subscribe': { ok: true, alreadySubscribed } });

      const form = screen.getByRole('form', { name: /newsletter/i });
      await user.type(within(form).getByLabelText(/email address/i), 'guest@example.com');
      await user.click(within(form).getByRole('button', { name: /sign up/i }));

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Check your inbox for your code.');
      // The sentence must not vary with, or hint at, which branch fired.
      expect(status.textContent).not.toMatch(/already|subscribed|resend|first/i);
    },
  );

  it('never renders a coupon code, even though one is in the settings payload and even after a successful signup', async () => {
    const user = userEvent.setup();
    renderPromo();
    mockTrpc({ 'newsletter.subscribe': { ok: true, alreadySubscribed: false } });

    await screen.findByText(PROMO.headline);
    expect(screen.queryByText(PROMO.code)).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(CODE_SHAPED_PATTERN);

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email address/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));
    await screen.findByRole('status');

    expect(screen.queryByText(PROMO.code)).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(CODE_SHAPED_PATTERN);
    expect(document.body.textContent ?? '').not.toContain(PROMO.code);
  });

  it('includes the verified Turnstile token in the subscribe.mutate payload', async () => {
    const user = userEvent.setup();
    let capturedInput: unknown;
    renderPromo();
    mockTrpc({
      'newsletter.subscribe': (input: unknown) => {
        capturedInput = input;
        return { ok: true, alreadySubscribed: false };
      },
    });

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email address/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    await screen.findByRole('status');
    expect(capturedInput).toMatchObject({
      email: 'guest@example.com',
      turnstileToken: 'test-turnstile-token',
    });
  });

  it('shows a field-level error beside the email input for a validation refusal', async () => {
    const user = userEvent.setup();
    renderPromo();
    mockTrpcValidationError('newsletter.subscribe', {
      fieldErrors: { email: ['Enter a valid email address.'] },
    });

    // A syntactically valid address — the point of this test is the
    // client's rendering of a SERVER-reported field error (mocked below,
    // unconditionally), not HTML5's own native email-format validation,
    // which would otherwise block the submit event from firing at all.
    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email address/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });
});
