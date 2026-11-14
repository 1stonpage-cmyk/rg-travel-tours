/**
 * The staff sign-in screen (Week 4 plan, Task 5).
 *
 * Mobile-first and deliberately plain: this is the one page in the product
 * that nobody browses. A dispatcher opens it on a phone at 6am to check a
 * booking, so it is a single column at 360px, 44px targets, and no
 * decoration competing with the two fields.
 *
 * ## ONE error, and that is a security decision rather than a UI shortcut
 *
 * `ui-ux-pro-max`'s forms guidance says each invalid field needs its own
 * inline error. That is right for a booking form and **wrong here**: the
 * server refuses a wrong email and a wrong password with a byte-identical
 * message on purpose (§7's rule, applied to staff), because telling them
 * apart tells an attacker which staff emails exist. A per-field error would
 * reintroduce exactly that oracle in the browser.
 *
 * So there is one `role="alert"` for the credential pair, and both inputs
 * point at it with `aria-describedby` — which keeps the accessible wiring
 * the guidance asks for (the error is programmatically associated with the
 * fields, announced on failure) without leaking which half was wrong.
 *
 * ## WCAG 2.2 "Accessible Authentication", which is a Critical rule
 *
 * `autocomplete="username"` / `"current-password"` so a password manager
 * fills it, and **nothing blocks paste**. A 20-character generated password
 * is unusable without both, and the owner's own launch checklist asks for a
 * strong unique one — a form that fought password managers would be arguing
 * against its own security requirement. The visibility toggle is the other
 * half: a long password typed blind on a phone is retyped three times.
 *
 * ## No red, per the brand rule
 *
 * The failure notice is amber on `brand-blue-50`, which is what the site
 * uses everywhere else for "something needs your attention". Transitions
 * are Tailwind's own utilities only.
 */
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import TurnstileWidget from '@/components/common/TurnstileWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sanitizeAdminRedirect } from '@/lib/admin-redirect';
import { firstValidationMessage } from '@/lib/field-errors';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const ERROR_ID = 'staff-login-error';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  /*
   * Set by `AdminResetPasswordPage` on a successful reset (task 1C), as
   * router STATE rather than a query parameter: "your password is set" is a
   * one-shot fact about something that just happened in this tab, not a
   * property of a URL anybody might share or reload into.
   */
  const passwordReset =
    (location.state as { passwordReset?: boolean } | null)?.passwordReset === true;
  /*
   * Task 2 (owner item 1B). `AdminLayout` redirects here with `?redirect=`
   * set to the path the operator was on when their session turned out to be
   * expired/missing — sanitized the same way on arrival as it was encoded
   * on departure, so a tampered or stale link can never send a successful
   * sign-in anywhere but `/admin` or somewhere inside `/admin`.
   */
  const [searchParams] = useSearchParams();
  const safeRedirect = sanitizeAdminRedirect(searchParams.get('redirect'));
  /*
   * Router STATE, not a query parameter — set by `AdminLayout`'s own
   * `<Navigate state={{ sessionExpired: hadAdminSessionBefore() }} />`, for the same reason
   * `passwordReset` above is state: a one-shot fact about what just
   * happened in this tab, not a property of a URL anybody might share or
   * reload into.
   */
  const sessionExpired =
    (location.state as { sessionExpired?: boolean } | null)?.sessionExpired === true;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  // A Turnstile token is single-use — bump this to remount the widget (and
  // get a fresh one) after any failed attempt, not only a Turnstile refusal.
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const login = trpc.staffAuth.login.useMutation({
    onSuccess: (result) => {
      // Whatever the last person on this tab left cached is not this person's.
      queryClient.clear();
      navigate(result.mustChangePassword ? '/admin/change-password' : (safeRedirect ?? '/admin'), {
        replace: true,
      });
    },
    onError: () => {
      setTurnstileToken(undefined);
      setTurnstileResetKey((key) => key + 1);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.reset();
    login.mutate({ email: email.trim(), password, turnstileToken });
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
          <h1 className="text-brand-ink mt-2 text-2xl font-bold">Staff sign-in</h1>
          <p className="text-brand-error mt-1 text-sm">
            For {SITE.name} staff only. Guests can track a booking from the link in their
            confirmation.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          aria-labelledby="staff-login-heading"
          className="border-brand-blue-100 space-y-5 rounded-[14px] border bg-white p-5 sm:p-6"
          noValidate
        >
          <h2 id="staff-login-heading" className="sr-only">
            Sign in to the admin
          </h2>

          {/*
           * Task 2 (owner item 1B). Shown once, when `AdminLayout` redirected
           * here because the previous session was expired or missing.
           * `role="status"`, not `role="alert"`: this is informational, not
           * a failure of anything the person just did here. Suppressed the
           * moment a login attempt fails, same as `passwordReset` below, so
           * the screen never shows this alongside "that email and password
           * do not match". Identical blue/status style — no red.
           */}
          {sessionExpired && !login.isError ? (
            <p
              role="status"
              className="bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200 rounded-xl border p-3 text-sm font-medium"
            >
              Your session expired — please sign in again.
            </p>
          ) : null}

          {/*
           * Task 1C. Shown once, after a self-service reset lands here.
           * `role="status"` not `role="alert"`: it is the expected outcome
           * of what the person just did. It is suppressed the moment a
           * login attempt fails, so the screen never says "your password is
           * set" and "that email and password do not match" at once.
           */}
          {passwordReset && !login.isError ? (
            <p
              role="status"
              className="bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200 rounded-xl border p-3 text-sm font-medium"
            >
              Your new password is set. Sign in with it below.
            </p>
          ) : null}

          {/*
           * ONE notice for the credential pair — see the file note. `role="alert"`
           * so it is announced when it appears, and both inputs reference it.
           * Amber, never red.
           */}
          {login.isError ? (
            <p
              id={ERROR_ID}
              role="alert"
              className="border-l-4 border-amber-600 bg-amber-50 p-3 text-sm font-medium text-amber-900"
            >
              {/*
               * Task A4. A validation failure's `error.message` is tRPC's raw
               * JSON issue list, so the schema's own sentence is used for
               * those. It still goes in the ONE notice rather than beside a
               * field: the credential-pair rule above is about not telling an
               * attacker which half was wrong, and a form that splits its
               * messages per field for some refusals and not others says more
               * than it means to.
               */}
              {firstValidationMessage(login.error) ?? login.error.message}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="staff-email">Email</Label>
            <Input
              id="staff-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={login.isError ? ERROR_ID : undefined}
              className="tap-target border-brand-blue-200 rounded-[10px] bg-white"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staff-password">Password</Label>
            <div className="relative">
              <Input
                id="staff-password"
                name="password"
                type={revealed ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={login.isError ? ERROR_ID : undefined}
                className="tap-target border-brand-blue-200 rounded-[10px] bg-white pr-12"
              />
              {/*
               * Icon-only, so it carries an `aria-label` that changes with the
               * state rather than a static one — a screen reader should hear
               * what the button will DO, not what it is called.
               */}
              <button
                type="button"
                onClick={() => setRevealed((shown) => !shown)}
                aria-label={revealed ? 'Hide password' : 'Show password'}
                aria-pressed={revealed}
                className="text-brand-error hover:text-brand-blue-700 focus-visible:ring-brand-blue-600 absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-md transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                {revealed ? (
                  <EyeOff className="size-5" aria-hidden="true" />
                ) : (
                  <Eye className="size-5" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/*
           * Renders nothing when Turnstile is not configured (local dev, or
           * switched off) — `onVerify` simply never fires, `turnstileToken`
           * stays `undefined`, and the server treats that exactly like the
           * feature being off (`verifyTurnstile`). Remounted via `key` after
           * any failed attempt, since a token is single-use.
           */}
          <TurnstileWidget
            key={turnstileResetKey}
            onVerify={setTurnstileToken}
            onError={() => setTurnstileToken(undefined)}
          />

          <Button
            type="submit"
            variant="primary-pill"
            className="w-full sm:w-auto"
            disabled={login.isPending}
          >
            {login.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              <>
                <Lock className="mr-2 size-4" aria-hidden="true" />
                Sign in
              </>
            )}
          </Button>
        </form>

        {/*
         * §12's third door (task 1C). BELOW the form rather than beside the
         * password label: a staff member who knows their password should
         * reach the submit button next, not a link away from it.
         */}
        <p className="mt-4 text-center text-sm">
          <Link
            to="/admin/forgot-password"
            className="text-brand-blue-700 hover:text-brand-blue-800 focus-visible:ring-brand-blue-600 tap-target inline-flex items-center justify-center rounded-[10px] px-3 font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2"
          >
            Forgot password?
          </Link>
        </p>

        <p className="text-brand-error mt-2 text-center text-xs">
          Repeated failed attempts are temporarily blocked.
        </p>
      </div>
    </main>
  );
}
