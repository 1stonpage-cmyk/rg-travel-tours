import { Gift } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import FieldError from '@/components/common/FieldError';
import TurnstileWidget from '@/components/common/TurnstileWidget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFieldErrors, getFormErrors } from '@/lib/field-errors';
import { describeMutationError } from '@/lib/mutation-errors';
import { trpc } from '@/lib/trpc';

const EMAIL_ERROR_ID = 'newsletter-email-error';

/**
 * Promo band + newsletter signup, settings-driven (spec task 6C / 3.2;
 * rewritten for sign-up coupons, Task 1D).
 *
 * Same server-resolved pattern as AnnouncementBar (3.1): `settings.promo`
 * is already `{ headline, body } | null` from the server (`resolvePromo`,
 * server/src/content/settings.ts) — the `startsAt`/`endsAt`/`isActive`
 * schedule fields never reach the browser. This component must not add any
 * date logic of its own: a client-side window check would show a
 * Manila-scheduled promo at the wrong instant for a guest whose device clock
 * is elsewhere. If `promo` is non-null, it renders as-is. This block is
 * unrelated to the sign-up code below — it's marketing copy, not a code
 * carrier.
 *
 * The newsletter signup is NOT conditional on there being an active promo —
 * a visitor must always be able to join the list, so only the promo copy
 * (eyebrow/headline/body) is gated on `promo`; the form always renders.
 *
 * **No coupon code ever reaches this component.** `newsletter.subscribe`
 * (server/src/routers/public/newsletter.ts) deliberately never returns a
 * code — email only, decision 1 of the sign-up-coupons plan — and the
 * server also never discloses whether a signup was a first-time mint or a
 * resend (`alreadySubscribed`). So the one success sentence below is
 * identical in both branches: "Check your inbox for your code."
 *
 * The CTA button's percentage is read live from `settings.get`'s
 * `signupCoupon.discountPercent` (a required field on `SettingsPayload`),
 * so an owner changing the admin setting changes this button's copy with no
 * deploy. Before that query resolves, the button falls back to a
 * percent-free sentence rather than guessing or showing "0%".
 */
export default function PromoNewsletter() {
  const { data } = trpc.settings.get.useQuery();
  const promo = data?.promo ?? null;
  const discountPercent = data?.signupCoupon.discountPercent;

  // Cloudflare Turnstile (sign-up coupons plan, Task 1B-ii / 1D), wired
  // exactly like ContactSection.tsx: a token is single-use, so a fresh `key`
  // is needed after any failed attempt (not only a Turnstile refusal) and
  // after a successful submit (a second signup in the same session must not
  // replay the first one's spent token). The widget's own `onError` prop
  // only clears the stale token — never bumps `turnstileResetKey` itself,
  // see `TurnstileWidget`'s own doc comment on why.
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const subscribe = trpc.newsletter.subscribe.useMutation({
    onError: () => {
      setTurnstileToken(undefined);
      setTurnstileResetKey((key) => key + 1);
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get('email') ?? '');
    // `alreadySubscribed: true` is a resolved mutation, not a thrown error
    // (server/src/routers/public/newsletter.ts) — the server deliberately
    // returns it rather than an error, because a repeat signup is still a
    // success from the visitor's point of view. `isSuccess` below covers
    // both cases without needing to branch on it here.
    subscribe.mutate(
      { email, turnstileToken },
      {
        onSuccess: () => {
          form.reset();
          setTurnstileToken(undefined);
          setTurnstileResetKey((key) => key + 1);
        },
      },
    );
  }

  /*
   * `newsletterInput` has one visitor-entered field, so a validation
   * refusal almost always has a box to sit under (task A4) — "Enter a
   * valid email address." beside the email input, not a JSON issue list
   * under the button. The Turnstile refusal and a 429/5xx carry no
   * `zodError` at all, so they fall through to `describeMutationError`
   * unchanged — the same generic handling every other form here already
   * gives a non-validation refusal.
   */
  const emailError = subscribe.isError ? getFieldErrors(subscribe.error)?.email : undefined;
  const formErrors = subscribe.isError ? getFormErrors(subscribe.error) : [];
  const bannerMessage = !subscribe.isError
    ? null
    : emailError
      ? null
      : (formErrors[0] ?? describeMutationError(subscribe.error));

  return (
    <section
      aria-label={promo ? undefined : 'Newsletter signup'}
      aria-labelledby={promo ? 'promo-heading' : undefined}
      className="from-brand-blue-900 to-brand-blue-700 bg-gradient-to-r"
    >
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:items-center lg:px-8">
        <div>
          {promo && (
            <>
              <p className="text-brand-gold-300 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
                <Gift className="size-4" aria-hidden="true" />
                Direct-booking perk
              </p>
              <h2 id="promo-heading" className="mt-3 text-2xl font-bold text-white sm:text-3xl">
                {promo.headline}
              </h2>
              <p className="text-brand-blue-100 mt-3 text-base">{promo.body}</p>
            </>
          )}
        </div>

        <form
          aria-label="Newsletter signup"
          onSubmit={handleSubmit}
          className="bg-background/95 rounded-2xl p-5 backdrop-blur"
        >
          <div className="space-y-1.5">
            <Label htmlFor="newsletter-email">Email address</Label>
            <Input
              id="newsletter-email"
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              aria-describedby={emailError ? EMAIL_ERROR_ID : undefined}
              aria-invalid={emailError ? true : undefined}
              className="tap-target"
            />
            <FieldError id={EMAIL_ERROR_ID} message={emailError} />
          </div>

          {/*
           * Cloudflare Turnstile — renders nothing when not configured
           * (local dev, or switched off), matching every other gated form.
           * Remounted via `key` after a failed submit, since a token is
           * single-use.
           */}
          <TurnstileWidget
            key={turnstileResetKey}
            onVerify={setTurnstileToken}
            onError={() => setTurnstileToken(undefined)}
          />

          <Button
            type="submit"
            size="lg"
            className="tap-target mt-4 w-full"
            disabled={subscribe.isPending}
          >
            {subscribe.isPending
              ? 'Signing up…'
              : discountPercent !== undefined
                ? `Sign up for ${discountPercent}% off`
                : 'Sign up for your discount code'}
          </Button>

          {subscribe.isSuccess && (
            <p role="status" className="text-brand-blue-700 mt-4 text-sm font-medium">
              Check your inbox for your code.
            </p>
          )}
          {bannerMessage !== null && (
            <p role="alert" className="text-brand-error mt-4 text-sm font-medium">
              {bannerMessage}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
