/**
 * "Forgot password" — step one of §12's third door (owner decision
 * 2026-11-06, task 1C).
 *
 * ## A sibling of the sign-in screen, not a new look
 *
 * Same shell, deliberately: the blue ground, the centred `max-w-sm` column,
 * the operator eyebrow in `brand-gold-700`, one white card with a hairline
 * border, 44px targets. A staff member arrives here mid-sign-in and should
 * not feel they have left the building. Nothing on this page is decorative —
 * one field, one button, one way back.
 *
 * ## The confirmation REPLACES the form, and that is the design decision
 *
 * The server's answer is identical whether or not the account exists, so the
 * only thing this page can honestly report is "we have taken your request".
 * That sentence is the entire payload of a successful submit, so it gets the
 * card to itself rather than a toast that fades or a line of green under a
 * form that still invites another go. Leaving the form on screen would make
 * a staff member who got no email press it again, which spends their
 * three-per-fifteen-minutes budget for no gain.
 *
 * The message itself is `PASSWORD_RESET_REQUESTED_MESSAGE`, rendered from
 * the server's own response rather than retyped here — two copies of a
 * sentence whose whole job is to be identical would be two sentences waiting
 * to diverge.
 *
 * ## WCAG 2.2 "Accessible Authentication", as on the sign-in screen
 *
 * `autocomplete="username"` so a password manager fills the address, and
 * nothing blocks paste.
 *
 * ## No red
 *
 * The only failures reachable here are a malformed address and the rate
 * limit. Both are amber on `amber-50`, matching the sign-in screen's notice;
 * secondary copy is `brand-error` (`#334155`).
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, MailCheck, Send } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import TurnstileWidget from '@/components/common/TurnstileWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const EMAIL_ERROR_ID = 'forgot-email-error';

/**
 * What to say for a refusal that is NOT a per-field validation message.
 *
 * Only two are reachable: the per-IP limiter's 429, and an unexpected 5xx.
 * The server never refuses an unknown address, so there is deliberately no
 * branch here for one — a sentence like "no such account" could not be
 * written on this page even by accident.
 */
function describeRequestError(error: unknown): string {
  if (error instanceof TRPCClientError) {
    const status = error.data?.httpStatus;
    if (status === 429) {
      return 'Too many reset requests from here. Wait a few minutes and try again.';
    }
    if (typeof status === 'number' && status < 500) return error.message;
  }
  return 'Could not send the reset link. Try again in a moment.';
}

export default function AdminForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  // A Turnstile token is single-use — bump this to remount the widget (and
  // get a fresh one) after a failed attempt.
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const request = trpc.staffAuth.requestPasswordReset.useMutation({
    onSuccess: () => {
      setFieldError(null);
      setBanner(null);
    },
    onError: (error) => {
      setTurnstileResetKey((key) => key + 1);
      /*
       * The shared reader (`lib/field-errors.ts`), never `error.message` for
       * a validation failure: that message is tRPC's raw JSON issue list,
       * and CLAUDE.md's rule is that no form may show it. The input has one
       * field, so a message keyed `email` goes beside the box and anything
       * form-level (a `.strict()` violation) goes in the banner.
       */
      const fields = getFieldErrors(error);
      const formErrors = getFormErrors(error);
      if (fields?.email) {
        setFieldError(fields.email);
        setBanner(formErrors[0] ?? null);
        return;
      }
      setFieldError(null);
      setBanner(formErrors[0] ?? describeRequestError(error));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setBanner(null);
    request.reset();
    request.mutate({ email: email.trim(), turnstileToken });
  }

  const sent = request.isSuccess;

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
            {SITE.legalOperator}
          </span>
          <h1 className="text-brand-ink mt-2 text-2xl font-bold">Reset your password</h1>
          {!sent ? (
            <p className="text-brand-error mt-1 text-sm">
              Enter the email address on your {SITE.name} staff account and we will send you a link
              to set a new password.
            </p>
          ) : null}
        </div>

        {sent ? (
          /*
           * `role="status"` rather than `role="alert"`: this is the expected
           * outcome of an action the person just took, announced politely,
           * not an interruption.
           */
          <div
            role="status"
            className="border-brand-blue-100 flex flex-col gap-3 rounded-[14px] border bg-white p-5 text-center sm:p-6"
          >
            <MailCheck className="text-brand-blue-700 mx-auto size-8" aria-hidden="true" />
            <p className="text-brand-ink text-sm font-medium">{request.data.message}</p>
            <p className="text-brand-error text-sm">
              Check your spam folder if it does not arrive. The link opens a page where you choose
              your own password.
            </p>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            aria-labelledby="forgot-heading"
            className="border-brand-blue-100 space-y-5 rounded-[14px] border bg-white p-5 sm:p-6"
            noValidate
          >
            <h2 id="forgot-heading" className="sr-only">
              Ask for a password reset link
            </h2>

            {banner ? (
              <p
                role="alert"
                className="border-l-4 border-amber-600 bg-amber-50 p-3 text-sm font-medium text-amber-900"
              >
                {banner}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? EMAIL_ERROR_ID : undefined}
                className="tap-target border-brand-blue-200 rounded-[10px] bg-white"
              />
              {fieldError ? (
                <p
                  id={EMAIL_ERROR_ID}
                  role="alert"
                  className="text-brand-error text-sm font-medium"
                >
                  {fieldError}
                </p>
              ) : null}
            </div>

            {/*
             * Renders nothing when Turnstile is not configured (local dev,
             * or switched off) — see AdminLoginPage's own note on this
             * component for why that is safe.
             */}
            <TurnstileWidget key={turnstileResetKey} onVerify={setTurnstileToken} />

            <Button
              type="submit"
              variant="primary-pill"
              className="w-full sm:w-auto"
              disabled={request.isPending}
            >
              {request.isPending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="mr-2 size-4" aria-hidden="true" />
                  Send reset link
                </>
              )}
            </Button>
          </form>
        )}

        <p className="mt-4 text-center text-sm">
          <Link
            to="/admin/login"
            className="text-brand-blue-700 hover:text-brand-blue-800 focus-visible:ring-brand-blue-600 tap-target inline-flex items-center justify-center rounded-[10px] px-3 font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2"
          >
            <ArrowLeft className="mr-1.5 size-4" aria-hidden="true" />
            Back to sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}
