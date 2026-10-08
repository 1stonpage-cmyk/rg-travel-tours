import { Gift } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLACEHOLDER_SETTINGS } from '@/lib/placeholder-data';

export default function PromoNewsletter() {
  const [signedUp, setSignedUp] = useState(false);

  return (
    <section
      aria-labelledby="promo-heading"
      className="from-brand-blue-900 to-brand-blue-700 bg-gradient-to-r"
    >
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:items-center lg:px-8">
        <div>
          <p className="text-brand-gold-300 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
            <Gift className="size-4" aria-hidden="true" />
            Direct-booking perk
          </p>
          <h2 id="promo-heading" className="mt-3 text-2xl font-bold text-white sm:text-3xl">
            Get 10% off your first tour
          </h2>
          <p className="text-brand-blue-100 mt-3 text-base">
            Join the list for Cebu trip tips and seasonal offers. We send a few emails a year and
            never share your address.
          </p>
        </div>

        <form
          aria-label="Newsletter signup"
          onSubmit={(e) => {
            e.preventDefault();
            setSignedUp(true);
          }}
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
          <Button type="submit" size="lg" className="tap-target mt-4 w-full">
            Sign up for 10% off
          </Button>

          {signedUp && (
            <div
              role="status"
              className="border-brand-gold-300 bg-brand-gold-50 mt-4 rounded-lg border p-4 text-center"
            >
              <p className="text-brand-blue-900 text-sm font-medium">Your promo code</p>
              <p className="text-brand-blue-900 mt-1 font-mono text-2xl font-bold tracking-wider">
                {PLACEHOLDER_SETTINGS.promoCode}
              </p>
              <p className="text-brand-warning mt-2 text-xs">
                Code shown locally only. Newsletter storage and coupon validation land in tasks 7C
                and 7B — your address has not been saved.
              </p>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}
