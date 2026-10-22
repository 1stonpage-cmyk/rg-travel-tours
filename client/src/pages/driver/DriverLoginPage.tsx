/**
 * The driver portal's sign-in (Week 6 plan, Task 9 — BUILD_SPEC §8).
 *
 * A code and a six-digit PIN, entered **one-handed beside a van, through a
 * windscreen, at midday, in a vehicle that may be moving.** That viewing
 * condition is the design constraint, and it is why this screen is plainer
 * and heavier than anything on the guest site: the identity field and the
 * branding sit at the top, and the pad — the part a thumb has to reach —
 * is pushed to the bottom of the viewport by `mt-auto`, i.e. into the
 * lower two-thirds. Decisions come from
 * `.superpowers/sdd/.../driver-screen-design.md`; this file implements them.
 *
 * ## The copy is the feature
 *
 * `REFUSAL_COPY` below is a `Record<DriverLoginRefusal, Refusal>`, so the
 * COMPILER refuses a build where a refusal has no words — the same
 * discipline Week 5's `AssignRefusal` / `REFUSAL_COPY` pair established in
 * `components/admin/AssignPanel.tsx`. Add a fifth refusal server-side and
 * this object stops compiling until someone decides what a driver reads.
 *
 * Three rules hold it together, and each one is a test in
 * `__tests__/driver-login.test.tsx`:
 *
 *  1. **`wrong_credentials` names neither half of the pair.** The server
 *     refuses an unknown code and a wrong PIN byte-identically on purpose
 *     (driver codes are short and printed on a van, so the PIN is the only
 *     half that is hard to get). A sentence saying which half was wrong
 *     would hand back in the browser the oracle the server withholds.
 *  2. **`locked` and `needs_admin_unlock` stay two sentences.** One clears
 *     by itself in fifteen minutes; the other never does. A driver shown
 *     the timer when only a dispatcher can help them waits a quarter of an
 *     hour, is refused again, and the van leaves without a manifest.
 *     Amber for the one that clears, dark blue/grey for the one that does
 *     not — and the words say it too, because colour alone is a WCAG 1.4.1
 *     failure.
 *  3. **The attempt count is never rendered.** "2 tries left" tells a
 *     shoulder-surfer how much room they have and tells the driver nothing
 *     they can act on. §8's policy (5 failures → 15 minutes; 3 lockouts in
 *     24h → a dispatcher) is enforced server-side and narrated nowhere.
 *
 * No red anywhere, per CLAUDE.md: the two tones are amber and
 * `brand-error` (#334155).
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, LogIn } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import type { DriverLoginRefusal } from '@rg/shared';
import PinPad from '@/components/driver/PinPad';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SITE } from '@/lib/site';
import { trpc } from '@/lib/trpc';

const ERROR_ID = 'driver-login-error';

/**
 * `driverLoginSchema` is `/^[0-9]{6}$/`. Named here, where the submit gate
 * lives, and passed down to the pad so there is one definition of how long
 * a PIN is on this screen.
 */
const PIN_LENGTH = 6;

/**
 * A refusal's words and which of the two tones it takes.
 *
 * `wait` is amber — the driver's own patience fixes it. `stop` is
 * `brand-error` dark blue/grey — nothing the driver can do with time will
 * fix it, so the sentence has to send them somewhere.
 */
interface Refusal {
  tone: 'wait' | 'stop';
  text: string;
}

const REFUSAL_COPY: Record<DriverLoginRefusal, Refusal> = {
  // Names neither half. See rule 1 in the file note.
  wrong_credentials: {
    tone: 'stop',
    text: 'We could not sign you in. Check what you typed and try again.',
  },
  // Clears by itself, so the sentence is a clock.
  locked: {
    tone: 'wait',
    text: 'Locked for 15 minutes. Try again after that, or ring the office if you are due out now.',
  },
  // Does NOT clear by itself, so the sentence is an instruction. It must
  // never mention fifteen minutes.
  needs_admin_unlock: {
    tone: 'stop',
    text: 'Ask the office to reset your PIN. Only they can open this account again.',
  },
};

/** The per-IP limiter in `app.ts` answers a plain 429, not a refusal. */
const TOO_MANY: Refusal = {
  tone: 'wait',
  text: 'Too many sign-in tries from this phone. Give it a few minutes.',
};

/** Anything unrecognised — and never the raw error (CLAUDE.md, BUG-021). */
const UNKNOWN: Refusal = {
  tone: 'stop',
  text: 'Sign-in is not answering just now. Try again, or ring the office.',
};

function isRefusal(value: string): value is DriverLoginRefusal {
  return Object.prototype.hasOwnProperty.call(REFUSAL_COPY, value);
}

/**
 * The server sets a refused login's `message` to the reason string verbatim
 * (`asTrpcError` in `routers/public/driver-auth.ts`), which is the
 * convention Week 5 established — so this matches the reason and picks its
 * copy, rather than parsing prose or echoing it.
 */
function describeRefusal(error: unknown): Refusal {
  if (error instanceof TRPCClientError) {
    if (error.data?.httpStatus === 429) return TOO_MANY;
    const reason = typeof error.message === 'string' ? error.message.trim() : '';
    if (isRefusal(reason)) return REFUSAL_COPY[reason];
  }
  return UNKNOWN;
}

export default function DriverLoginPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const login = trpc.driver.login.useMutation({
    onSuccess: () => navigate('/driver', { replace: true }),
    onError: (error) => setRefusal(describeRefusal(error)),
  });

  const ready = code.trim().length > 0 && pin.length === PIN_LENGTH;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setRefusal(null);
    login.mutate({ code: code.trim(), pin });
  }

  return (
    <main className="bg-brand-blue-50 flex min-h-dvh flex-col px-4 py-5">
      <form
        onSubmit={onSubmit}
        aria-labelledby="driver-login-heading"
        className="mx-auto flex w-full max-w-sm flex-1 flex-col"
        noValidate
      >
        <div className="text-center">
          <span className="text-brand-gold-800 text-xs font-semibold uppercase tracking-[0.18em]">
            {SITE.legalOperator}
          </span>
          <h1 id="driver-login-heading" className="text-brand-blue-900 mt-1 text-2xl font-bold">
            Driver sign-in
          </h1>
        </div>

        <div className="mt-4 space-y-1.5">
          <Label htmlFor="driver-code" className="text-brand-blue-900 text-base">
            Driver code
          </Label>
          <Input
            id="driver-code"
            name="code"
            type="text"
            /*
             * A code is `D07`, not a word: autocapitalise it, and turn off
             * the corrections that would "fix" it. `username` so a phone's
             * own password manager can fill the pair.
             */
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            value={code}
            disabled={login.isPending}
            onChange={(event) => setCode(event.target.value)}
            aria-describedby={refusal ? ERROR_ID : undefined}
            className="tap-target h-14 text-center text-xl font-semibold uppercase tracking-widest"
          />
        </div>

        {/*
         * ONE notice for the whole form, `role="alert"` so it is announced
         * the moment it appears, and both fields point at it. Placed above
         * the pad so it is not under the thumb that just submitted.
         */}
        {refusal ? (
          <p
            id={ERROR_ID}
            role="alert"
            className={
              refusal.tone === 'wait'
                ? 'mt-4 rounded-lg border-l-4 border-amber-600 bg-amber-50 p-3 text-base font-medium text-amber-900'
                : 'text-brand-error border-brand-error bg-background mt-4 rounded-lg border-l-4 p-3 text-base font-medium'
            }
          >
            {refusal.text}
          </p>
        ) : null}

        {/*
         * `mt-auto` is the whole layout decision: the pad and the submit
         * button are pushed to the bottom of the viewport — the lower
         * two-thirds — where a thumb on a one-handed phone reaches. jsdom
         * cannot see this; Task 14's walkthrough checks it at 360px.
         */}
        <div className="mt-auto space-y-3 pt-6">
          <PinPad
            value={pin}
            onChange={setPin}
            length={PIN_LENGTH}
            disabled={login.isPending}
            describedBy={refusal ? ERROR_ID : undefined}
          />

          <Button
            type="submit"
            disabled={!ready || login.isPending}
            className="tap-target h-14 w-full text-base font-semibold"
          >
            {login.isPending ? (
              <>
                <Loader2 className="mr-2 size-5 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              <>
                <LogIn className="mr-2 size-5" aria-hidden="true" />
                Sign in
              </>
            )}
          </Button>

          {/*
           * Where to go when the screen cannot help — and deliberately NOT
           * a statement of the lockout policy. The refusal notice above
           * says what applies when it applies; a standing "five tries and
           * you are locked out" line here would be the attempt budget
           * announced in advance, which is the same leak by another route.
           */}
          <p className="text-brand-blue-900 text-center text-sm">
            Ring the office if you cannot get in and you are due to drive.
          </p>
        </div>
      </form>
    </main>
  );
}
