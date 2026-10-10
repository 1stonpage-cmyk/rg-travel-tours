import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import { TrpcProviders } from '@/lib/trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';
import { mockTrpc } from './helpers/mock-trpc';

const PROMO = SETTINGS_FIXTURE.promo!;

function settingsWith(promo: typeof PROMO | null) {
  return { ...SETTINGS_FIXTURE, promo };
}

function renderPromo(promo: typeof PROMO | null = PROMO) {
  mockTrpc({ 'settings.get': settingsWith(promo) });
  return render(
    <TrpcProviders>
      <PromoNewsletter />
    </TrpcProviders>,
  );
}

describe('PromoNewsletter', () => {
  it('renders the headline, body and discount label from settings', async () => {
    renderPromo(PROMO);

    const heading = await screen.findByRole('heading', { level: 2, name: PROMO.headline });
    // discountLabel ("10% off") is editorial content embedded in the seeded
    // headline, not a separately-rendered element — asserted here as a
    // substring so a future headline that drops the figure actually fails
    // this check rather than passing on an unrelated node.
    expect(heading.textContent).toContain(PROMO.discountLabel);
    expect(screen.getByText(PROMO.body)).toBeInTheDocument();
  });

  it('hides the whole promo band when settings.promo is null', async () => {
    renderPromo(null);

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

  it('reveals the code only after a successful signup', async () => {
    const user = userEvent.setup();
    renderPromo(PROMO);

    expect(screen.queryByText(PROMO.code)).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: /newsletter/i });
    await user.type(within(form).getByLabelText(/email address/i), 'guest@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const status = await screen.findByRole('status');
    expect(within(status).getByText(PROMO.code)).toBeInTheDocument();
  });

  it('never renders the code before signup, even though it is in the payload', async () => {
    renderPromo(PROMO);

    // settings.get already carries promo.code on the wire (it's a public
    // marketing code, not a secret) — but the reveal is still a deliberate
    // UI affordance, not an always-visible value.
    await screen.findByText(PROMO.headline);
    expect(screen.queryByText(PROMO.code)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
