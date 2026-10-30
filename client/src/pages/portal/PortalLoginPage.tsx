/**
 * The guest portal's door (§7, Week 4 — brought forward with Task 8).
 *
 * A guest signs in with their **booking reference and the email on the
 * booking**, not a password, and gets a session scoped to that one booking.
 * It exists at Task 8 rather than Task 9 because the manual-QR screen needs
 * a session: the owner's decision is that a booking reference alone reveals
 * nothing, so the amount due and the account details sit behind this form.
 *
 * ## ONE error for a REFUSED credential, and it is a security decision
 *
 * The server refuses a wrong reference and a wrong email with a
 * byte-identical message (§7), because telling them apart tells an attacker
 * which references exist. So there is one `role="alert"` for the pair and
 * both inputs point at it with `aria-describedby` — the accessible wiring
 * the forms guidance asks for, without the oracle a per-field error would
 * reintroduce. The same departure `AdminLoginPage` documents.
 *
 * ## A MALFORMED field is a different question, and gets its own message
 *
 * Task A4. `bookingLookupInput` validates the ref's shape
 * (`bookingRefSchema`) and the email's format before any lookup runs, and a
 * failure there says nothing whatever about which bookings exist — it is a
 * fact about the characters in the box, decided with no database read. Those
 * messages now render beneath their own input ("Enter a valid booking
 * reference, like RG-7KQ4M9."), which is what they are for.
 *
 * The oracle rule is untouched: the moment the server actually looks a
 * booking up, the refusal carries no `zodError` at all, so it lands in the
 * single shared notice exactly as before. **Validation and credential
 * failures are told apart by the presence of `data.zodError`, never by
 * reading the message** — that is the distinction the server already draws,
 * and the page reads it rather than re-deciding it.
 *
 * ## Mobile first, and the keyboard matters
 *
 * A guest opens this on a phone, probably from the link in their
 * confirmation email. 360px single column, 44px targets, the reference
 * field in `characters` autocapitalise with no autocorrect (`RG-7KQ4M9` is
 * not a word), and the email field with `inputMode="email"` so the phone
 * offers the @ key.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { APP_SURFACE_TITLES } from '@rg/shared';
import FieldError from '@/components/common/FieldError';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const ERROR_ID = 'portal-login-error';
const REF_ERROR_ID = 'portal-login-ref-error';
const EMAIL_ERROR_ID = 'portal-login-email-error';

/**
 * Where to go after signing in. Taken from `?next=`, but **only when it is
 * a portal path** — an open redirect would let a phishing link bounce a
 * guest off our own domain the moment they signed in.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/portal/')) return '/portal/booking';
  return raw;
}

export default function PortalLoginPage() {
  /*
   * The portal has no shared layout component (`App.tsx` mounts its three
   * pages directly), so each one re-asserts the surface's title itself. The
   * words are the server's own (`APP_SURFACE_TITLES['/portal']`,
   * `@rg/shared`), so a guest who walks here from `/booking/:ref` by a
   * client-side navigation stops reading the booking page's tab title.
   */
  useDocumentTitle(APP_SURFACE_TITLES['/portal']);

  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Prefilled from the checkout link, so a guest coming straight from a hold
  // types their email and nothing else.
  const [ref, setRef] = useState(params.get('ref') ?? '');
  const [email, setEmail] = useState('');

  const login = trpc.portal.login.useMutation({
    onSuccess: () => navigate(safeNext(params.get('next')), { replace: true }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.reset();
    login.mutate({ ref: ref.trim(), email: email.trim() });
  }

  /*
   * `bookingLookupInput`'s own field names, keyed as the server sends them
   * (`ref`, `email`) — a flat `.strict()` object, so there is no nested key
   * to unpick here the way checkout's `lead` needs.
   */
  const fieldErrors = login.isError ? getFieldErrors(login.error) : null;
  const formErrors = login.isError ? getFormErrors(login.error) : [];
  const refError = fieldErrors?.ref;
  const emailError = fieldErrors?.email;
  /*
   * A validation failure is NOT shown in the shared notice as well — the
   * field messages are the whole of it, and repeating them above the form
   * would be the second copy of the same sentence. A form-level issue has no
   * field to sit beside, so that one does go in the notice.
   */
  const noticeMessage =
    !login.isError || fieldErrors !== null ? null : (formErrors[0] ?? login.error.message);

  return (
    <main className="bg-brand-blue-50 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img
            src="/brand/icon-192.png"
            alt=""
            aria-hidden="true"
            width={192}
            height={192}
            className="mx-auto mb-3 size-12 rounded-full"
          />
          <span className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.18em]">
            {SITE.name}
          </span>
          <h1 className="text-brand-blue-900 mt-2 text-2xl font-bold">Your booking</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Enter your booking reference and the email you booked with.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          aria-labelledby="portal-login-heading"
          className="border-border bg-background space-y-5 rounded-xl border p-5 shadow-sm sm:p-6"
          noValidate
        >
          <h2 id="portal-login-heading" className="sr-only">
            Sign in to your booking
          </h2>

          {/* ONE notice for a refused credential pair — see the file note. Amber, never red. */}
          {noticeMessage !== null ? (
            <p
              id={ERROR_ID}
              role="alert"
              className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
            >
              {noticeMessage}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="portal-ref">Booking reference</Label>
            <Input
              id="portal-ref"
              name="ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder="RG-7KQ4M9"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-describedby={
                refError ? REF_ERROR_ID : noticeMessage !== null ? ERROR_ID : undefined
              }
              aria-invalid={refError ? true : undefined}
              className="tap-target font-mono uppercase tracking-wide"
            />
            <FieldError id={REF_ERROR_ID} message={refError} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="portal-email">Email</Label>
            <Input
              id="portal-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={
                emailError ? EMAIL_ERROR_ID : noticeMessage !== null ? ERROR_ID : undefined
              }
              aria-invalid={emailError ? true : undefined}
              className="tap-target"
            />
            <FieldError id={EMAIL_ERROR_ID} message={emailError} />
          </div>

          <Button type="submit" disabled={login.isPending} className="tap-target w-full">
            {login.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Checking…
              </>
            ) : (
              <>
                <Lock className="mr-2 size-4" aria-hidden="true" />
                View my booking
              </>
            )}
          </Button>
        </form>

        <p className="text-muted-foreground mt-4 text-center text-xs">
          Your reference is in your confirmation email. Repeated attempts are temporarily blocked.
        </p>
      </div>
    </main>
  );
}
