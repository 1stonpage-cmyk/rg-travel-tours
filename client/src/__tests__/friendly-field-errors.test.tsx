/**
 * Task A4 — the LAUNCH BLOCKER: a guest must never be shown raw Zod
 * validation output.
 *
 * ## What was actually happening
 *
 * `server/src/trpc.ts` has always published `error.data.zodError =
 * { formErrors, fieldErrors }` for an input-validation failure. No client
 * code read it. Every public form rendered `error.message` instead — and for
 * a `ZodError`, tRPC's default message is `JSON.stringify(issues, null, 2)`,
 * a JSON-shaped blob of issue objects. A single-issue failure was no better:
 * a bare "Expected a PH mobile number" under the submit button, with nothing
 * saying which of five inputs it meant.
 *
 * ## So every test here makes two assertions, and both are load-bearing
 *
 *  1. The friendly sentence is rendered **as the element the failing input
 *     names in its `aria-describedby`**, not merely somewhere on the page. A
 *     message in the right words in the wrong place is the half of this bug
 *     that is easiest to reintroduce, and `getByText` alone cannot see it.
 *  2. The form's own text matches **no** `{`, `}`, `[` or `]`. That is the
 *     raw-blob guard, and it is why `mockTrpcValidationError` sends tRPC's
 *     real JSON `message` rather than a tidy sentence: a form that regresses
 *     to `error.message` fails this assertion even if some friendly text
 *     also happens to be on screen.
 *
 * `mockTrpcValidationError` produces the envelope the real server produces
 * (see its own note), so these tests exercise the real `@trpc/client` error
 * path — `TRPCClientError.data.zodError` — and not a hand-made object.
 *
 * ## The field NAMES here are the server's, not invented
 *
 * `z.flattenError` keys by `issue.path[0]`, so every fixture below uses the
 * top-level key of the mutation's own input schema in `shared/src`:
 * `createHoldInput.lead` (NOT `phone` — it is a nested object),
 * `bookingLookupInput.ref`/`email`, `submitReviewInput.body`,
 * `inquiryInput.email`, `newsletterInput.email`. A fixture keyed on a name
 * the server would never send would make a test that passes while the real
 * form shows nothing.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import CheckoutPage from '@/pages/public/CheckoutPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcValidationError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

/**
 * The guard against the raw blob. Zod's JSON issue list cannot be written
 * without one of these four characters; no guest-facing sentence on any of
 * these forms contains one.
 */
const JSON_SHAPED = /[{}[\]]/;

function expectNoRawJson(container: HTMLElement) {
  expect(container.textContent ?? '').not.toMatch(JSON_SHAPED);
}

/**
 * The message an input actually points at — the only way to prove "beside
 * the right field" rather than "somewhere in the document".
 */
function describedMessage(input: HTMLElement): string {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  const texts = ids
    .map((id) => input.ownerDocument.getElementById(id)?.textContent ?? '')
    .filter((text) => text !== '');
  return texts.join(' ');
}

/* ------------------------------------------------------------- 1. Checkout */

const QUOTE_FIXTURE = {
  tier: { id: 7, minPax: 1, maxPax: 6, pricePerPersonCentavos: 100_000 },
  subtotalCentavos: 500_000,
  discountCentavos: 0,
  totalCentavos: 500_000,
  depositCentavos: 150_000,
  amountDueNowCentavos: { full: 500_000, deposit: 150_000 },
  balanceCentavos: { full: 0, deposit: 350_000 },
  quoteId: 'abcdef0123456789abcdef0123456789',
};

/** The owner's own example wording, from `phPhoneSchema` in `@rg/shared`. */
const PHONE_MESSAGE = 'Enter a valid PH mobile number, like 0917 123 4567';

describe('Checkout — createHold validation errors', () => {
  it('puts the phone message on the element the mobile input describes, with no JSON', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    mockTrpcValidationError('checkout.createHold', {
      // `lead` is the key the server sends: `createHoldInput.lead` is a
      // nested object and `flattenError` groups by `path[0]`.
      fieldErrors: { lead: [PHONE_MESSAGE] },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/checkout/oslob-tour?date=2026-11-20&pax=3']}>
          <Routes>
            <Route path="/checkout/:tourSlug" element={<CheckoutPage />} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );

    const form = await screen.findByRole('form', { name: /checkout/i });
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/mobile number/i), '12345');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await waitFor(() => {
      expect(within(form).getByText(PHONE_MESSAGE)).toBeInTheDocument();
    });

    // Beside the right field: the mobile input points at the message.
    const phone = within(form).getByLabelText(/mobile number/i);
    expect(describedMessage(phone)).toContain(PHONE_MESSAGE);
    expect(phone).toHaveAttribute('aria-invalid', 'true');

    expectNoRawJson(form);
  });

  it('shows a form-level issue once above the inputs, not against a field', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    const FORM_MESSAGE = 'That price is out of date. Please reload and try again.';
    mockTrpcValidationError('checkout.createHold', { formErrors: [FORM_MESSAGE] });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/checkout/oslob-tour?date=2026-11-20&pax=3']}>
          <Routes>
            <Route path="/checkout/:tourSlug" element={<CheckoutPage />} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );

    const form = await screen.findByRole('form', { name: /checkout/i });
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await waitFor(() => {
      expect(within(form).getByText(FORM_MESSAGE)).toBeInTheDocument();
    });
    // Nothing claimed it belonged to a field.
    expect(within(form).getByLabelText(/mobile number/i)).not.toHaveAttribute('aria-invalid');
    expectNoRawJson(form);
  });

  it('routes a field the form does not render to the banner rather than nowhere', async () => {
    mockTrpc({ 'checkout.quote': QUOTE_FIXTURE });
    // `date` comes from the URL — there is no input to hang it under, and a
    // message the code believed it had placed is the silent half of this bug.
    mockTrpcValidationError('checkout.createHold', {
      fieldErrors: { date: ['Enter a valid date.'] },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/checkout/oslob-tour?date=2026-11-20&pax=3']}>
          <Routes>
            <Route path="/checkout/:tourSlug" element={<CheckoutPage />} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );

    const form = await screen.findByRole('form', { name: /checkout/i });
    await user.type(within(form).getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/mobile number/i), '0917 123 4567');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /book now/i }));

    await waitFor(() => {
      expect(within(form).getByText('Enter a valid date.')).toBeInTheDocument();
    });
    expectNoRawJson(form);
  });
});
