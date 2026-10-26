/**
 * The guest portal's door (§7, Week 4 — brought forward with Task 8).
 *
 * A guest signs in with their **booking reference and the email on the
 * booking**, not a password, and gets a session scoped to that one booking.
 * It exists at Task 8 rather than Task 9 because the manual-QR screen needs
 * a session: the owner's decision is that a booking reference alone reveals
 * nothing, so the amount due and the account details sit behind this form.
 *
 * ## ONE error, and it is a security decision
 *
 * The server refuses a wrong reference and a wrong email with a
 * byte-identical message (§7), because telling them apart tells an attacker
 * which references exist. So there is one `role="alert"` for the pair and
 * both inputs point at it with `aria-describedby` — the accessible wiring
 * the forms guidance asks for, without the oracle a per-field error would
 * reintroduce. The same departure `AdminLoginPage` documents.
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
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const ERROR_ID = 'portal-login-error';

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

          {/* ONE notice for the pair — see the file note. Amber, never red. */}
          {login.isError ? (
            <p
              id={ERROR_ID}
              role="alert"
              className="border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium"
            >
              {login.error.message}
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
              aria-describedby={login.isError ? ERROR_ID : undefined}
              className="tap-target font-mono uppercase tracking-wide"
            />
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
              aria-describedby={login.isError ? ERROR_ID : undefined}
              className="tap-target"
            />
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
