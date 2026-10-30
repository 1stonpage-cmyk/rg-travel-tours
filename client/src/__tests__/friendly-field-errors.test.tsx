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
 *
 * ## Why the typed values look VALID
 *
 * Several of these forms use `<input type="email" required>` with no
 * `noValidate`, and jsdom runs constraint validation before the submit event
 * exactly as a browser does — so typing "nope" into one means the form never
 * submits and the server is never asked. The mock is keyed by procedure name
 * and not input-aware (see `mock-trpc.ts`), so a well-formed value still
 * produces the refusal under test. What is being tested is where the
 * SERVER's message lands, not whether the browser's own check fires.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import CheckoutPage from '@/pages/public/CheckoutPage';
import PortalLoginPage from '@/pages/portal/PortalLoginPage';
import ReceiptUpload from '@/components/portal/ReceiptUpload';
import ReviewForm from '@/components/portal/ReviewForm';
import ContactSection from '@/components/home/ContactSection';
import PackageInquiryForm from '@/components/package/PackageInquiryForm';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import { RATE_LIMIT_MESSAGE } from '@/lib/mutation-errors';
import { TrpcProviders } from '@/lib/trpc';
import {
  mockTrpc,
  mockTrpcError,
  mockTrpcRateLimited,
  mockTrpcValidationError,
  resetTrpcMock,
} from './helpers/mock-trpc';
import { SETTINGS_FIXTURE } from './helpers/fixtures';

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

/* ------------------------------------------------------- 2. My Booking lookup */

/** From `bookingRefSchema` in `@rg/shared`. */
const REF_MESSAGE = 'Enter a valid booking reference, like RG-7KQ4M9.';

function renderPortalLogin() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/portal/login']}>
        <Routes>
          <Route path="/portal/login" element={<PortalLoginPage />} />
          <Route path="/portal/booking" element={<p>booking screen</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('My Booking lookup — portal.login validation errors', () => {
  it('puts the ref message under the reference box and the email message under the email box', async () => {
    mockTrpcValidationError('portal.login', {
      fieldErrors: {
        ref: [REF_MESSAGE],
        email: ['Enter a valid email address.'],
      },
    });
    const user = userEvent.setup();
    renderPortalLogin();

    await user.type(screen.getByLabelText(/booking reference/i), 'nope');
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /view my booking/i }));

    const refInput = screen.getByLabelText(/booking reference/i);
    const emailInput = screen.getByLabelText(/email/i);
    await waitFor(() => {
      expect(describedMessage(refInput)).toContain(REF_MESSAGE);
    });
    expect(describedMessage(emailInput)).toContain('Enter a valid email address.');
    // Each one got its own, not the other's.
    expect(describedMessage(refInput)).not.toContain('email address');

    expectNoRawJson(document.body);
  });

  /**
   * The §7 oracle rule, unchanged by this task. A REFUSED credential pair
   * still produces exactly one notice and names neither half — because that
   * refusal carries no `zodError`, so `getFieldErrors` returns null and the
   * page falls through to the shared notice it always had.
   */
  it('still shows ONE notice, naming neither field, for a refused credential pair', async () => {
    mockTrpcError(
      'portal.login',
      'UNAUTHORIZED',
      'That booking reference and email do not match a booking.',
    );
    const user = userEvent.setup();
    renderPortalLogin();

    await user.type(screen.getByLabelText(/booking reference/i), 'RG-NOPE00');
    await user.type(screen.getByLabelText(/email/i), 'wrong@example.test');
    await user.click(screen.getByRole('button', { name: /view my booking/i }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/do not match a booking/i);
    expect(screen.getByLabelText(/booking reference/i)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText(/email/i)).not.toHaveAttribute('aria-invalid');
  });
});

/* ---------------------------------------------------------- 3. Receipt upload */

/**
 * The one of the six that is NOT a tRPC mutation (it posts file bytes to
 * `/api/receipts/upload`), so its per-field messages come from the SHARED
 * `transferReferenceSchema` checked before the request — see the component's
 * own note. The assertion is the same one every other form here makes: the
 * right sentence, on the element the right input describes.
 *
 * **Both tests submit with `fireEvent.submit` rather than a button click**,
 * and that is a jsdom limitation worth naming: jsdom reports `required` on a
 * FILE input as unsatisfied even when `input.files` holds one (measured —
 * `checkValidity()` stays false after `user.upload`), so the form never
 * validates and a clicked submit never reaches React's handler. Firing the
 * submit event is how the handler under test gets to run at all; it changes
 * nothing about what the handler then does.
 */
describe('Receipt upload — per-field messages from the shared schema', () => {
  it('puts the reference message under the reference box and never posts', async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    try {
      const user = userEvent.setup();
      const { container } = render(<ReceiptUpload uploadsRemaining={5} />);

      // A real file, so the reference is the only thing wrong: three
      // characters, under `transferReferenceSchema`'s min of 4.
      await user.upload(
        screen.getByLabelText(/photo or pdf of the receipt/i),
        new File(['x'], 'receipt.png', { type: 'image/png' }),
      );
      await user.type(screen.getByLabelText(/reference number from your transfer/i), '123');
      fireEvent.submit(container.querySelector('form')!);

      const refInput = screen.getByLabelText(/reference number from your transfer/i);
      await waitFor(() => {
        expect(describedMessage(refInput)).toContain(
          'Please enter the reference number from your transfer.',
        );
      });
      expect(refInput).toHaveAttribute('aria-invalid', 'true');
      // Nothing was sent: the guest fixes the box, not a failed upload.
      expect(calls).toHaveLength(0);
      // And the file, which was fine, was not blamed for it.
      expect(screen.getByLabelText(/photo or pdf of the receipt/i)).not.toHaveAttribute(
        'aria-invalid',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('wires the missing-file message to the file input, not to the notice', async () => {
    const user = userEvent.setup();
    const { container } = render(<ReceiptUpload uploadsRemaining={5} />);

    await user.type(screen.getByLabelText(/reference number from your transfer/i), 'GC1234567890');
    fireEvent.submit(container.querySelector('form')!);

    const fileInput = screen.getByLabelText(/photo or pdf of the receipt/i);
    await waitFor(() => {
      expect(describedMessage(fileInput)).toContain(
        'Please choose the photo or PDF of your transfer receipt.',
      );
    });
    expect(screen.getByLabelText(/reference number from your transfer/i)).not.toHaveAttribute(
      'aria-invalid',
    );
  });
});

/* --------------------------------------------------------------- 4. Reviews */

describe('Review form — portal.submitReview validation errors', () => {
  it('puts the body message under the review textarea, with no JSON anywhere', async () => {
    const BODY_MESSAGE = 'Please say a little more — a sentence or two is plenty.';
    mockTrpcValidationError('portal.submitReview', {
      fieldErrors: { body: [BODY_MESSAGE] },
    });
    const user = userEvent.setup();
    const { container } = render(
      <TrpcProviders>
        <ReviewForm />
      </TrpcProviders>,
    );

    /*
     * A rating first: the form's own local guard blocks before the mutation
     * without one, and this test is about the SERVER's message. Scoped to
     * the "Overall rating" group — all five star groups offer a "4 stars"
     * radio, so an unscoped query matches five elements.
     */
    await user.click(
      within(screen.getByRole('group', { name: /overall rating/i })).getByRole('radio', {
        name: /^4 stars$/i,
      }),
    );
    await user.type(screen.getByLabelText(/your review/i), 'Good');
    await user.click(screen.getByRole('button', { name: /send review/i }));

    const body = screen.getByLabelText(/your review/i);
    await waitFor(() => {
      expect(describedMessage(body)).toContain(BODY_MESSAGE);
    });
    expect(body).toHaveAttribute('aria-invalid', 'true');
    expectNoRawJson(container);
  });
});

/* ------------------------------------------------------------ 5. Inquiries */

describe('Contact form — inquiries.create validation errors', () => {
  it('puts each message under its own box and shows no raw JSON', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    mockTrpcValidationError('inquiries.create', {
      fieldErrors: {
        email: ['Enter a valid email address.'],
        message: ['Tell us a little about what you need.'],
      },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <ContactSection />
      </TrpcProviders>,
    );

    const form = await screen.findByRole('form', { name: /contact inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Juan');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/^message$/i), 'x');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    const email = within(form).getByLabelText(/^email$/i);
    const message = within(form).getByLabelText(/^message$/i);
    await waitFor(() => {
      expect(describedMessage(email)).toContain('Enter a valid email address.');
    });
    expect(describedMessage(message)).toContain('Tell us a little about what you need.');
    // Neither took the other's sentence.
    expect(describedMessage(email)).not.toContain('Tell us a little');
    // The name was fine and was not blamed.
    expect(within(form).getByLabelText(/your name/i)).not.toHaveAttribute('aria-invalid');
    expectNoRawJson(form);
  });

  it('still shows the generic sentence for a NON-validation failure', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    mockTrpcRateLimited('inquiries.create');
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <ContactSection />
      </TrpcProviders>,
    );

    const form = await screen.findByRole('form', { name: /contact inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Juan');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.type(within(form).getByLabelText(/^message$/i), 'Hello there');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send message/i }));

    expect(await within(form).findByText(RATE_LIMIT_MESSAGE)).toBeInTheDocument();
    expect(within(form).getByLabelText(/^email$/i)).not.toHaveAttribute('aria-invalid');
  });
});

describe('Package enquiry form — inquiries.create validation errors', () => {
  it('puts the email message under the email box', async () => {
    mockTrpcValidationError('inquiries.create', {
      fieldErrors: { email: ['Enter a valid email address.'] },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <PackageInquiryForm packageId={3} packageTitle="Cebu & Bohol 4D3N" />
      </TrpcProviders>,
    );

    const form = screen.getByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Juan');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    const email = within(form).getByLabelText(/^email$/i);
    await waitFor(() => {
      expect(describedMessage(email)).toContain('Enter a valid email address.');
    });
    expectNoRawJson(form);
  });

  /**
   * `message` is composed by the form from the package title and the dates
   * box, so there is no input to hang its refusal on — it goes in the line
   * under the button rather than vanishing, which is the silent half of this
   * bug.
   */
  it('sends a message-field refusal to the banner, since the form composes that field', async () => {
    mockTrpcValidationError('inquiries.create', {
      fieldErrors: { message: ['That enquiry is too long for us to store.'] },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <PackageInquiryForm packageId={3} packageTitle="Cebu & Bohol 4D3N" />
      </TrpcProviders>,
    );

    const form = screen.getByRole('form', { name: /package inquiry/i });
    await user.type(within(form).getByLabelText(/your name/i), 'Juan');
    await user.type(within(form).getByLabelText(/^email$/i), 'juan@example.com');
    await user.click(within(form).getByLabelText(/i agree/i));
    await user.click(within(form).getByRole('button', { name: /send inquiry/i }));

    expect(
      await within(form).findByText('That enquiry is too long for us to store.'),
    ).toBeInTheDocument();
    expectNoRawJson(form);
  });
});

/* ----------------------------------------------------------- 6. Newsletter */

describe('Newsletter signup — newsletter.subscribe validation errors', () => {
  it('puts the email message under the email box, not under the button', async () => {
    mockTrpc({ 'settings.get': SETTINGS_FIXTURE });
    mockTrpcValidationError('newsletter.subscribe', {
      fieldErrors: { email: ['Enter a valid email address.'] },
    });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <PromoNewsletter />
      </TrpcProviders>,
    );

    const form = screen.getByRole('form', { name: /newsletter signup/i });
    await user.type(within(form).getByLabelText(/email address/i), 'juan@example.com');
    await user.click(within(form).getByRole('button', { name: /sign up/i }));

    const email = within(form).getByLabelText(/email address/i);
    await waitFor(() => {
      expect(describedMessage(email)).toContain('Enter a valid email address.');
    });
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expectNoRawJson(form);
  });
});
