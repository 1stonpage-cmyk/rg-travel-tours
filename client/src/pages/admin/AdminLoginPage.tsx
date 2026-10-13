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
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const ERROR_ID = 'staff-login-error';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);

  const login = trpc.staffAuth.login.useMutation({
    onSuccess: () => navigate('/admin', { replace: true }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.reset();
    login.mutate({ email: email.trim(), password });
  }

  return (
    <main className="bg-brand-blue-50 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.18em]">
            {SITE.legalOperator}
          </span>
          <h1 className="text-brand-blue-900 mt-2 text-2xl font-bold">Staff sign-in</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            For {SITE.name} staff only. Guests can track a booking from the link in their
            confirmation.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          aria-labelledby="staff-login-heading"
          className="border-border bg-background space-y-5 rounded-xl border p-5 shadow-sm sm:p-6"
          noValidate
        >
          <h2 id="staff-login-heading" className="sr-only">
            Sign in to the admin
          </h2>

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
              {login.error.message}
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
              className="tap-target"
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
                className="tap-target pr-12"
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
                className="text-muted-foreground hover:text-brand-blue-700 focus-visible:ring-brand-blue-600 absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-md transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                {revealed ? (
                  <EyeOff className="size-5" aria-hidden="true" />
                ) : (
                  <Eye className="size-5" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <Button type="submit" disabled={login.isPending} className="tap-target w-full">
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

        <p className="text-muted-foreground mt-4 text-center text-xs">
          Repeated failed attempts are temporarily blocked.
        </p>
      </div>
    </main>
  );
}
