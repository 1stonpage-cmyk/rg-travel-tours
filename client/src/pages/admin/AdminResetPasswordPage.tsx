/**
 * "Choose a new password" — step two of §12's third door (task 1C).
 *
 * The page a reset link lands on. The token is in the query string, which is
 * the only way an unauthenticated page can carry a credential a mail client
 * handed it; it is never put in component state beyond the submit, never
 * stored, and never rendered.
 *
 * ## A sibling of the sign-in and change-password screens
 *
 * The shell is `AdminForgotPasswordPage`'s, so the two halves of the flow
 * look like one flow; the fields are `AdminChangePasswordPage`'s, because
 * "new password + confirm" is a form this product already has and
 * `PasswordField` already carries the show/hide toggle, the `tap-target`
 * sizing, the `aria-describedby` wiring and the `role="alert"` error.
 * Nothing new was written for either.
 *
 * ## Three states, and the missing-token one is not an error
 *
 * A link truncated by a mail client arrives with no `token` at all. That is
 * a dead end rather than a failure, so the page says so plainly and offers
 * the one thing that helps — ask for a new link — instead of showing a form
 * that cannot possibly succeed.
 *
 * ## The checks done here, and the ones that are the server's
 *
 * Length and "the two match" are checked before sending, so a typo costs no
 * round trip and no rate-limit budget. Everything that matters — the token
 * being real, unspent, unexpired and attached to an active account — is the
 * server's, and it answers all four with one sentence on purpose. This page
 * renders that sentence rather than guessing which of the four it was.
 *
 * ## On success the person is sent to sign in
 *
 * `replace: true`, so the back button cannot return to a form whose token is
 * now spent, and with router state rather than a query parameter: "your
 * password is set" is a one-shot message about something that just happened,
 * not a fact about a URL somebody might share or reload.
 *
 * ## No red
 *
 * Field errors are `brand-error` (`#334155`) via `PasswordField`; the
 * card-level notice is amber, as on its two sibling screens.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, KeyRound, Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { STAFF_PASSWORD_MIN_LENGTH, staffPasswordSchema } from '@rg/shared';
import PasswordField from '@/components/admin/PasswordField';
import { Button } from '@/components/ui/button';
import { splitFieldErrors } from '@/lib/field-errors';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

/**
 * The one `resetPassword` input key this form has a box for. `token` is
 * deliberately absent: it comes from the URL, there is nothing a person
 * could retype, and a message placed "beside" it would have nowhere to go.
 * A validation failure on the token therefore lands in the banner, which is
 * correct — the fix is a new link, not an edit.
 */
const RESET_FIELD_NAMES: ReadonlySet<string> = new Set(['newPassword']);

const NOTICE_CLASS =
  'border-l-4 border-amber-600 bg-amber-50 p-3 text-sm font-medium text-amber-900';

function describeResetError(error: unknown): string {
  if (error instanceof TRPCClientError) {
    const status = error.data?.httpStatus;
    if (status === 429) return 'Too many attempts from here. Wait a few minutes and try again.';
    // 401 is the server's single refusal for an unknown, expired, spent or
    // deactivated-account token, and its own sentence already says the only
    // useful thing ("ask for a new one"). Passed through rather than
    // reworded, so the two can never disagree.
    if (typeof status === 'number' && status < 500) return error.message;
  }
  return 'Could not set the password. Nothing was changed.';
}

export default function AdminResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const reset = trpc.staffAuth.resetPassword.useMutation({
    onSuccess: () => {
      setNewPassword('');
      setConfirmPassword('');
      navigate('/admin/login', { replace: true, state: { passwordReset: true } });
    },
    onError: (error) => {
      const validation = splitFieldErrors(error, RESET_FIELD_NAMES);
      if (validation) {
        setErrors(validation.fields);
        setBanner(validation.banner);
        return;
      }
      setErrors({});
      setBanner(describeResetError(error));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBanner(null);

    const next: Record<string, string> = {};
    const length = staffPasswordSchema.safeParse(newPassword);
    if (!length.success) next.newPassword = length.error.issues[0]?.message ?? 'Invalid password.';
    if (confirmPassword !== newPassword) next.confirmPassword = 'The two passwords do not match.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;
    reset.mutate({ token, newPassword });
  }

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
          <h1 className="text-brand-ink mt-2 text-2xl font-bold">Choose a new password</h1>
          <p className="text-brand-error mt-1 text-sm">
            {token === ''
              ? 'This link is missing its reset code.'
              : `Set the password for your ${SITE.name} staff account. Every device you are signed in on will be signed out.`}
          </p>
        </div>

        {token === '' ? (
          <div
            role="alert"
            className="border-brand-blue-100 flex flex-col gap-3 rounded-[14px] border bg-white p-5 sm:p-6"
          >
            <p className={NOTICE_CLASS}>
              Some mail apps shorten long links. Ask for a new reset link and open it directly from
              the email.
            </p>
            <Button asChild variant="primary-pill" className="w-full sm:w-auto">
              <Link to="/admin/forgot-password">Send me a new link</Link>
            </Button>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            aria-labelledby="reset-heading"
            className="border-brand-blue-100 space-y-5 rounded-[14px] border bg-white p-5 sm:p-6"
            noValidate
          >
            <h2 id="reset-heading" className="sr-only">
              Set a new staff password
            </h2>

            {banner ? (
              <p role="alert" className={NOTICE_CLASS}>
                {banner}
              </p>
            ) : null}

            <PasswordField
              label="New password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              hint={`At least ${STAFF_PASSWORD_MIN_LENGTH} characters.`}
              error={errors.newPassword}
              disabled={reset.isPending}
            />
            <PasswordField
              label="Confirm new password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              error={errors.confirmPassword}
              disabled={reset.isPending}
            />

            <Button
              type="submit"
              variant="primary-pill"
              className="w-full sm:w-auto"
              disabled={reset.isPending}
            >
              {reset.isPending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <KeyRound className="mr-2 size-4" aria-hidden="true" />
                  Set password and sign in
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
