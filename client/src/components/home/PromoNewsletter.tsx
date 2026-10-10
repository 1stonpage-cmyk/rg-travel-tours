import { Gift } from 'lucide-react';
import { type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeMutationError } from '@/lib/mutation-errors';
import { trpc } from '@/lib/trpc';

/**
 * Promo band + newsletter signup, settings-driven (spec task 6C / 3.2).
 *
 * Same server-resolved pattern as AnnouncementBar (3.1): `settings.promo`
 * is already `{ code, discountLabel, headline, body } | null` from the
 * server (`resolvePromo`, server/src/content/settings.ts) — the
 * `startsAt`/`endsAt`/`isActive` schedule fields never reach the browser.
 * This component must not add any date logic of its own: a client-side
 * window check would show a Manila-scheduled promo at the wrong instant for
 * a guest whose device clock is elsewhere. If `promo` is non-null, it
 * renders as-is.
 *
 * The newsletter signup is NOT conditional on there being an active promo —
 * a visitor must always be able to join the list, so only the promo copy
 * (eyebrow/headline/body) is gated on `promo`; the form always renders.
 *
 * `promo.code` now arrives with the page payload, so "reveal after signup"
 * below is a UI affordance, not a secret — fine for a public marketing
 * code. The form is wired to `newsletter.subscribe` (task 3.5): the code
 * reveals only once that mutation actually resolves, including the
 * `alreadySubscribed: true` case, which the server deliberately returns as
 * a success rather than an error.
 */
export default function PromoNewsletter() {
  const { data } = trpc.settings.get.useQuery();
  const promo = data?.promo ?? null;
  const subscribe = trpc.newsletter.subscribe.useMutation();

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get('email') ?? '');
    // `alreadySubscribed: true` is a resolved mutation, not a thrown error
    // (server/src/routers/public/newsletter.ts) — the server deliberately
    // returns it rather than an error, because a repeat signup is still a
    // success from the visitor's point of view. `isSuccess` below covers
    // both cases without needing to branch on it here.
    subscribe.mutate({ email }, { onSuccess: () => form.reset() });
  }

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
              className="tap-target"
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="tap-target mt-4 w-full"
            disabled={subscribe.isPending}
          >
            {subscribe.isPending ? 'Signing up…' : 'Sign up for 10% off'}
          </Button>

          {subscribe.isSuccess && promo && (
            <div
              role="status"
              className="border-brand-gold-300 bg-brand-gold-50 mt-4 rounded-lg border p-4 text-center"
            >
              <p className="text-brand-blue-900 text-sm font-medium">Your promo code</p>
              <p className="text-brand-blue-900 mt-1 font-mono text-2xl font-bold tracking-wider">
                {promo.code}
              </p>
            </div>
          )}
          {subscribe.isSuccess && !promo && (
            <p role="status" className="text-brand-blue-700 mt-4 text-sm font-medium">
              Thanks for signing up!
            </p>
          )}
          {subscribe.isError && (
            <p role="alert" className="text-brand-error mt-4 text-sm font-medium">
              {describeMutationError(subscribe.error)}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
