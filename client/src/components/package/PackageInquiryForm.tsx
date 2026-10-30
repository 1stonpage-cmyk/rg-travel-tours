import { useState, type FormEvent } from 'react';
import FieldError from '@/components/common/FieldError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { describeMutationError } from '@/lib/mutation-errors';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

/**
 * The package enquiry form for `/packages/:slug` (Week 7 plan, Task 3,
 * correction 2). Extracted from `components/home/PackagesSection.tsx`'s
 * inline form — same fields, same mutation-call shape, same consent
 * wording — MINUS the `<select>` there for switching which package the
 * enquiry is about: here the package is already fixed by the page it is
 * on, so there is nothing to switch between.
 *
 * `PackagesSection.tsx` itself is untouched: that inline form and its own
 * tests stay exactly as they are, and this component is not a refactor of
 * it, only a second, smaller surface sharing the same mutation shape.
 */

/**
 * The `inquiryInput` keys this form has a box for. `message` is absent on
 * purpose — see the note beside `bannerMessages` below.
 */
const PLACED_FIELDS: ReadonlySet<string> = new Set(['name', 'email', 'consent']);

export default function PackageInquiryForm({
  packageId,
  packageTitle,
}: {
  packageId: number;
  packageTitle: string;
}) {
  const [consentError, setConsentError] = useState<string | null>(null);
  const sendInquiry = trpc.inquiries.create.useMutation();

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    if (data.get('consent') !== 'on') {
      // Clear any earlier result first — see the matching note in
      // ContactSection.tsx / PackagesSection.tsx: a stale "Inquiry sent"
      // status must not sit beside the new consent alert.
      sendInquiry.reset();
      setConsentError(
        'Please agree to be contacted before sending — we need this to reply to you (RA 10173).',
      );
      return;
    }
    setConsentError(null);
    const dates = String(data.get('dates') ?? '').trim();
    sendInquiry.mutate(
      {
        type: 'package',
        packageId,
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        message: `Package enquiry: ${packageTitle}. ${
          dates ? `Preferred dates: ${dates}.` : 'Dates flexible.'
        }`,
        consent: true,
      },
      { onSuccess: () => form.reset() },
    );
  }

  /*
   * Task A4. `name`, `email` and `consent` are the three `inquiryInput` keys
   * this form actually has a box for, so those messages go beside them.
   *
   * `message` is NOT one of them, deliberately: this form composes it from
   * the package title and the "Preferred dates" box, so a `message` refusal
   * is about a string the visitor never saw and has no box to sit under —
   * it joins the form-level issues in the banner. The banner falls back to
   * `describeMutationError` ONLY when this was not a validation failure at
   * all, so `error.message`'s raw JSON issue list can never reach it.
   */
  const fieldErrors = sendInquiry.isError ? getFieldErrors(sendInquiry.error) : null;
  const formErrors = sendInquiry.isError ? getFormErrors(sendInquiry.error) : [];
  const unplacedMessages = Object.entries(fieldErrors ?? {})
    .filter(([field]) => !PLACED_FIELDS.has(field))
    .map(([, message]) => message);
  const bannerMessages = !sendInquiry.isError
    ? []
    : fieldErrors !== null || formErrors.length > 0
      ? [...formErrors, ...unplacedMessages]
      : [describeMutationError(sendInquiry.error)];

  return (
    <form
      aria-label="Package inquiry"
      onSubmit={handleSubmit}
      className="bg-brand-blue-50 grid gap-4 rounded-2xl p-6 sm:grid-cols-2"
    >
      <h2 className="text-brand-blue-900 text-lg font-semibold sm:col-span-2">
        Ask about this package
      </h2>

      <div className="space-y-1.5">
        <Label htmlFor="package-detail-inquiry-name">Your name</Label>
        <Input
          id="package-detail-inquiry-name"
          name="name"
          required
          aria-describedby={fieldErrors?.name ? 'package-detail-inquiry-name-error' : undefined}
          aria-invalid={fieldErrors?.name ? true : undefined}
          className="tap-target"
        />
        <FieldError id="package-detail-inquiry-name-error" message={fieldErrors?.name} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="package-detail-inquiry-email">Email</Label>
        <Input
          id="package-detail-inquiry-email"
          name="email"
          type="email"
          required
          aria-describedby={fieldErrors?.email ? 'package-detail-inquiry-email-error' : undefined}
          aria-invalid={fieldErrors?.email ? true : undefined}
          className="tap-target"
        />
        <FieldError id="package-detail-inquiry-email-error" message={fieldErrors?.email} />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="package-detail-inquiry-dates">Preferred dates</Label>
        <Input id="package-detail-inquiry-dates" name="dates" type="date" className="tap-target" />
      </div>

      {/* RA 10173 (Data Privacy Act) consent checkbox — same wording as PackagesSection.tsx. */}
      <div className="flex items-start gap-2.5 sm:col-span-2">
        <input
          id="package-detail-inquiry-consent"
          name="consent"
          type="checkbox"
          onChange={() => setConsentError(null)}
          aria-describedby={
            fieldErrors?.consent ? 'package-detail-inquiry-consent-error' : undefined
          }
          aria-invalid={fieldErrors?.consent ? true : undefined}
          className="accent-brand-blue-600 border-input mt-0.5 size-5 shrink-0 rounded"
        />
        <Label
          htmlFor="package-detail-inquiry-consent"
          className="text-muted-foreground text-sm font-normal"
        >
          I agree to be contacted about this enquiry and consent to {SITE.legalOperator} storing my
          details, per the Data Privacy Act (RA 10173).
        </Label>
      </div>
      {/* The visitor's own un-ticked box first — it is shown before anything is sent. */}
      {consentError ? (
        <p role="alert" className="text-brand-error -mt-2 text-sm font-medium sm:col-span-2">
          {consentError}
        </p>
      ) : fieldErrors?.consent ? (
        <div className="-mt-2 sm:col-span-2">
          <FieldError id="package-detail-inquiry-consent-error" message={fieldErrors.consent} />
        </div>
      ) : null}

      <div className="sm:col-span-2">
        <Button
          type="submit"
          size="lg"
          className="tap-target w-full sm:w-auto"
          disabled={sendInquiry.isPending}
        >
          {sendInquiry.isPending ? 'Sending…' : 'Send inquiry'}
        </Button>
        {sendInquiry.isSuccess && (
          <p role="status" className="text-brand-blue-700 mt-3 text-sm font-medium">
            Inquiry sent — we'll get back to you soon.
          </p>
        )}
        {bannerMessages.map((message) => (
          <p key={message} role="alert" className="text-brand-error mt-3 text-sm font-medium">
            {message}
          </p>
        ))}
      </div>
    </form>
  );
}
